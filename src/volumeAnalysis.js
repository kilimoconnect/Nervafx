'use strict';

/**
 * M15 Volume Analysis Engine — Participation Intelligence
 *
 * Computes 4 institutional-grade volume metrics per instrument per M15 candle:
 *
 *  A. Relative Volume     — current_vol / avg_same_session_vol
 *     Detects abnormal participation vs session baseline.
 *
 *  B. Volume Acceleration — current_vol - previous_vol
 *     Detects participation expansion / momentum ignition.
 *
 *  C. Volume Persistence  — consecutive candles above threshold (1.2× avg)
 *     Real institutional moves sustain volume; fakes spike briefly.
 *
 *  D. Volume Efficiency   — |close - open| / (volume / session_avg_volume)
 *     High efficiency = smart money (big move, normal volume).
 *     Low efficiency  = excess effort, choppy absorption.
 *
 * Also computes:
 *  - participation_score: 0–100 composite score
 *  - participation_grade: INSTITUTIONAL / STRONG / NORMAL / WEAK / DEAD
 *
 * DB table: m15_volume_analysis
 * Called by: run-pipeline (after candle sync)
 */

const { supabase } = require('./supabase');
const { config }   = require('./config');

const INSTRUMENTS = config.instruments;

// Session determination from UTC hour (matches sessionEngine.js)
function getSession(utcHour) {
  if (utcHour >= 23 || utcHour < 7)  return 'ASIA';
  if (utcHour >= 7  && utcHour < 13) return 'LONDON';
  if (utcHour >= 13 && utcHour < 21) return 'NEW_YORK';
  return 'LOW_LIQUIDITY';
}

// ─── Core Metrics ────────────────────────────────────────────────────────────

/**
 * Compute all volume metrics for a set of M15 candles.
 *
 * @param {Array} candles - M15 candles in ascending order (oldest → newest)
 *   Each: { time, open, high, low, close, volume }
 * @param {Object} sessionAvgs - { ASIA: num, LONDON: num, NEW_YORK: num, LOW_LIQUIDITY: num }
 *   Average M15 tick volume per session (computed from historical data)
 * @returns {Array} rows ready for DB upsert
 */
function computeVolumeMetrics(candles, sessionAvgs) {
  if (!candles || candles.length < 2) return [];

  const rows = [];
  let persistence = 0; // running count of consecutive high-volume candles

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const utcHour  = new Date(c.time).getUTCHours();
    const session  = getSession(utcHour);
    const sessAvg  = sessionAvgs[session] || sessionAvgs['LONDON'] || 1;
    const vol      = c.volume || 0;

    // A. Relative Volume
    const relative_volume = sessAvg > 0 ? vol / sessAvg : 0;

    // B. Volume Acceleration
    const prevVol = i > 0 ? (candles[i - 1].volume || 0) : vol;
    const volume_acceleration = vol - prevVol;

    // C. Volume Persistence — consecutive candles above 1.2× session avg
    const HIGH_VOL_THRESHOLD = 1.2;
    if (relative_volume >= HIGH_VOL_THRESHOLD) {
      persistence++;
    } else {
      persistence = 0;
    }

    // D. Volume Efficiency — net move per unit of normalized volume
    const netMove   = Math.abs(c.close - c.open);
    const normVol   = sessAvg > 0 ? vol / sessAvg : 1;
    const volume_efficiency = normVol > 0.01 ? netMove / normVol : 0;

    // ─── Participation Score (0–100 composite) ──────────────────────────
    // Weights: relative_volume 35%, acceleration_signal 20%,
    //          persistence 25%, efficiency 20%
    const rvScore   = Math.min(100, relative_volume * 50);          // 2× = 100
    const accScore  = Math.min(100, Math.max(0, (volume_acceleration / sessAvg + 0.5) * 100)); // normalize
    const persScore = Math.min(100, persistence * 25);              // 4 consecutive = 100
    const effScore  = Math.min(100, volume_efficiency * 100000);    // scaled for forex pip moves

    const participation_score = Math.round(
      rvScore   * 0.35 +
      accScore  * 0.20 +
      persScore * 0.25 +
      effScore  * 0.20
    );

    // ─── Grade ──────────────────────────────────────────────────────────
    let participation_grade;
    if (participation_score >= 80)      participation_grade = 'INSTITUTIONAL';
    else if (participation_score >= 60) participation_grade = 'STRONG';
    else if (participation_score >= 40) participation_grade = 'NORMAL';
    else if (participation_score >= 20) participation_grade = 'WEAK';
    else                                participation_grade = 'DEAD';

    rows.push({
      time:                  c.time,
      instrument:            c.instrument,
      session,
      volume:                vol,
      relative_volume:       Math.round(relative_volume * 1000) / 1000,
      volume_acceleration,
      volume_persistence:    persistence,
      volume_efficiency:     Math.round(volume_efficiency * 100000) / 100000,
      participation_score,
      participation_grade,
    });
  }

  return rows;
}

// ─── Session Average Computation ─────────────────────────────────────────────

/**
 * Compute average M15 tick volume per session from historical candles.
 * Uses a rolling window of recent data to adapt to changing market conditions.
 *
 * @param {Array} candles - M15 candles with { time, volume }
 * @param {number} lookbackDays - How many days of history to average (default 20)
 * @returns {Object} { ASIA: avg, LONDON: avg, NEW_YORK: avg, LOW_LIQUIDITY: avg }
 */
function computeSessionAverages(candles, lookbackDays = 20) {
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const sessions = {
    ASIA:           { sum: 0, count: 0 },
    LONDON:         { sum: 0, count: 0 },
    NEW_YORK:       { sum: 0, count: 0 },
    LOW_LIQUIDITY:  { sum: 0, count: 0 },
  };

  for (const c of candles) {
    const ms = new Date(c.time).getTime();
    if (ms < cutoff) continue;
    const session = getSession(new Date(c.time).getUTCHours());
    sessions[session].sum   += c.volume || 0;
    sessions[session].count += 1;
  }

  const result = {};
  for (const [sess, { sum, count }] of Object.entries(sessions)) {
    result[sess] = count > 0 ? sum / count : 1;
  }
  return result;
}

/**
 * Compute session averages from DB for a specific instrument and reference date.
 * Uses 20 trading days of M15 candles prior to refDate.
 */
async function fetchSessionAverages(instrument, refDate, lookbackDays = 20) {
  const since = new Date(new Date(refDate).getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const allCandles = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('backtest_candles')
      .select('time, volume')
      .eq('instrument', instrument)
      .eq('timeframe', 'M15')
      .eq('complete', true)
      .gte('time', since)
      .lt('time', refDate)
      .order('time', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`Vol avg fetch ${instrument}: ${error.message}`);
    if (!data?.length) break;
    allCandles.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  return computeSessionAverages(allCandles, lookbackDays * 2); // extra buffer
}

// ─── Incremental (Pipeline) ──────────────────────────────────────────────────

/**
 * Calculate volume analysis for the latest M15 candles.
 * Called by run-pipeline on each hourly cycle.
 *
 * Processes the last 8 M15 candles (2 hours) per instrument to ensure
 * persistence tracking is accurate. Only upserts new rows.
 */
async function calculateLatestVolumeAnalysis() {
  const RECENT = 8;  // 2 hours of M15 candles
  const allRows = [];

  for (const instrument of INSTRUMENTS) {
    // Fetch recent M15 candles
    const { data: recent, error } = await supabase
      .from('backtest_candles')
      .select('time, instrument, open, high, low, close, volume')
      .eq('instrument', instrument)
      .eq('timeframe', 'M15')
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(RECENT);

    if (error) throw new Error(`Vol fetch ${instrument}: ${error.message}`);
    if (!recent?.length) continue;

    const candles = recent.reverse().map(c => ({
      time:       new Date(c.time).toISOString(),
      instrument: c.instrument,
      open:       parseFloat(c.open),
      high:       parseFloat(c.high),
      low:        parseFloat(c.low),
      close:      parseFloat(c.close),
      volume:     c.volume || 0,
    }));

    // Get session averages (20-day lookback)
    const sessAvgs = await fetchSessionAverages(instrument, candles[0].time);

    const rows = computeVolumeMetrics(candles, sessAvgs);
    allRows.push(...rows);
  }

  if (allRows.length) {
    // Upsert in batches
    for (let i = 0; i < allRows.length; i += 500) {
      const batch = allRows.slice(i, i + 500);
      const { error } = await supabase
        .from('m15_volume_analysis')
        .upsert(batch, { onConflict: 'time,instrument', ignoreDuplicates: false });
      if (error) throw new Error(`Vol upsert: ${error.message}`);
    }
  }

  console.log(`[VOLUME] Stored ${allRows.length} volume analysis rows`);
  return { rows: allRows.length };
}

// ─── Full Backfill ───────────────────────────────────────────────────────────

/**
 * Backfill volume analysis for all historical M15 candle data.
 * Processes each instrument independently, computing session averages
 * with a rolling 20-day window.
 *
 * @param {Object} opts
 * @param {string} opts.since - ISO date to start from (default: earliest candle)
 * @param {Function} opts.onProgress - callback(instrument, count)
 */
async function backfillVolumeAnalysis({ since, onProgress } = {}) {
  console.log('[VOLUME] Starting full backfill...');
  let totalRows = 0;

  for (const instrument of INSTRUMENTS) {
    // Fetch ALL M15 candles for this instrument (paginated)
    const allCandles = [];
    const PAGE = 1000;
    let offset = 0;
    const sinceFilter = since || '2000-01-01T00:00:00Z';

    while (true) {
      const { data, error } = await supabase
        .from('backtest_candles')
        .select('time, instrument, open, high, low, close, volume')
        .eq('instrument', instrument)
        .eq('timeframe', 'M15')
        .eq('complete', true)
        .gte('time', sinceFilter)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);

      if (error) throw new Error(`Backfill fetch ${instrument}: ${error.message}`);
      if (!data?.length) break;
      allCandles.push(...data.map(c => ({
        time:       new Date(c.time).toISOString(),
        instrument: c.instrument,
        open:       parseFloat(c.open),
        high:       parseFloat(c.high),
        low:        parseFloat(c.low),
        close:      parseFloat(c.close),
        volume:     c.volume || 0,
      })));
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    if (!allCandles.length) continue;

    // ── Efficient O(n) sliding-window session averages ──────────────────
    // Pre-tag each candle with its session and epoch ms
    const WINDOW_MS = 20 * 24 * 60 * 60 * 1000; // 20 days
    const tagged = allCandles.map(c => ({
      ...c,
      session: getSession(new Date(c.time).getUTCHours()),
      ms:      new Date(c.time).getTime(),
    }));

    // Build per-session ring buffers: { session → [{ms, vol}] }
    // Use a deque (array with pointer) per session for the trailing window
    const sessQueues = {
      ASIA:          [],
      LONDON:        [],
      NEW_YORK:      [],
      LOW_LIQUIDITY: [],
    };
    const sessSums = { ASIA: 0, LONDON: 0, NEW_YORK: 0, LOW_LIQUIDITY: 0 };
    const sessHeads = { ASIA: 0, LONDON: 0, NEW_YORK: 0, LOW_LIQUIDITY: 0 };

    const rows = [];
    let persistence = 0;

    for (let i = 0; i < tagged.length; i++) {
      const c       = tagged[i];
      const session = c.session;
      const cutoff  = c.ms - WINDOW_MS;

      // Add current candle to its session queue BEFORE computing average
      // (we want average of PRIOR candles, not including current)
      // So compute average first, then add.

      // Evict expired entries from this session's queue
      const q    = sessQueues[session];
      let   head = sessHeads[session];
      while (head < q.length && q[head].ms < cutoff) {
        sessSums[session] -= q[head].vol;
        head++;
      }
      sessHeads[session] = head;

      const sessCount = q.length - head;
      const sessAvg   = sessCount > 10 ? sessSums[session] / sessCount : (c.volume || 1);

      // A. Relative Volume
      const relative_volume = sessAvg > 0 ? c.volume / sessAvg : 0;

      // B. Volume Acceleration
      const prevVol = i > 0 ? tagged[i - 1].volume : c.volume;
      const volume_acceleration = c.volume - prevVol;

      // C. Volume Persistence
      if (relative_volume >= 1.2) { persistence++; } else { persistence = 0; }

      // D. Volume Efficiency
      const netMove = Math.abs(c.close - c.open);
      const normVol = sessAvg > 0 ? c.volume / sessAvg : 1;
      const volume_efficiency = normVol > 0.01 ? netMove / normVol : 0;

      // Participation Score
      const rvScore   = Math.min(100, relative_volume * 50);
      const accScore  = Math.min(100, Math.max(0, (volume_acceleration / sessAvg + 0.5) * 100));
      const persScore = Math.min(100, persistence * 25);
      const effScore  = Math.min(100, volume_efficiency * 100000);

      const participation_score = Math.round(
        rvScore * 0.35 + accScore * 0.20 + persScore * 0.25 + effScore * 0.20
      );

      let participation_grade;
      if (participation_score >= 80)      participation_grade = 'INSTITUTIONAL';
      else if (participation_score >= 60) participation_grade = 'STRONG';
      else if (participation_score >= 40) participation_grade = 'NORMAL';
      else if (participation_score >= 20) participation_grade = 'WEAK';
      else                                participation_grade = 'DEAD';

      rows.push({
        time:                  c.time,
        instrument,
        session,
        volume:                c.volume,
        relative_volume:       Math.round(relative_volume * 1000) / 1000,
        volume_acceleration,
        volume_persistence:    persistence,
        volume_efficiency:     Math.round(volume_efficiency * 100000) / 100000,
        participation_score,
        participation_grade,
      });

      // NOW add current candle to its session queue (for future averages)
      sessQueues[session].push({ ms: c.ms, vol: c.volume });
      sessSums[session] += c.volume;
    }

    // Upsert in batches
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await supabase
        .from('m15_volume_analysis')
        .upsert(batch, { onConflict: 'time,instrument', ignoreDuplicates: false });
      if (error) throw new Error(`Backfill upsert ${instrument}: ${error.message}`);
    }

    totalRows += rows.length;
    if (onProgress) onProgress(instrument, rows.length);
    console.log(`[VOLUME] ${instrument}: ${rows.length} rows`);
  }

  console.log(`[VOLUME] Backfill complete: ${totalRows} total rows`);
  return { rows: totalRows };
}

module.exports = {
  calculateLatestVolumeAnalysis,
  backfillVolumeAnalysis,
  computeVolumeMetrics,
  computeSessionAverages,
  getSession,
};
