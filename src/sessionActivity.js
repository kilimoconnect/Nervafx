'use strict';

/**
 * Session Activity Engine — Steps 4–11
 *
 * Step 4   Normalize:   normalized_move = pair_session_move / rolling-20-session avg
 * Step 5   EMA:         smooth_move = (prev_smooth + normalized_move) / 2
 * Step 6   Movement:    movement_score = clamp(avg(smooth_move) × 50, 0–100)
 * Step 7   Breadth:     active = smooth_move >= 1.0 → breadth_score = active/28 × 100
 * Step 8   Agreement:   based on currency strength vs actual pair direction (active pairs only)
 * Step 9   Volatility:  session_range normalized by 20-session avg → volatility_score
 * Step 10  Acceleration: energy_base delta vs previous session
 * Step 11  Compression persistence: consecutive compressed sessions
 *
 * DB migration required — add to hourly_session_activity:
 *   agreement_score    NUMERIC(5,1)
 *   volatility_score   NUMERIC(5,1)
 *   energy_base        NUMERIC(5,1)
 *   acceleration       NUMERIC(6,1)
 *   compression_streak INTEGER DEFAULT 0
 *   movement_magnitude NUMERIC(6,1)
 *
 * Add to session_performance_summary:
 *   avg_agreement_score   NUMERIC(5,1)
 *   avg_volatility_score  NUMERIC(5,1)
 *   avg_energy_base       NUMERIC(5,1)
 *   avg_acceleration      NUMERIC(6,1)
 */

const { supabase }          = require('./supabase');
const { getCurrentSession } = require('./sessionEngine');
const { config }            = require('./config');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round1(v) { return Math.round(v * 10) / 10; }
function arrAvg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

// ─── Candle fetch ─────────────────────────────────────────────────────────────
// Fetch high, low, close — 300 candles ensures ~20 sessions of warmup for
// rolling averages and EMA initialisation.

async function fetchHourlyCandles(limit = 300) {
  const byTime = {};
  for (const instrument of config.instruments) {
    const { data, error } = await supabase
      .from('market_candles')
      .select('time, high, low, close')
      .eq('instrument', instrument)
      .eq('timeframe', 'H1')
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Candle fetch ${instrument}: ${error.message}`);
    for (const c of data || []) {
      const t = new Date(c.time).toISOString();
      if (!byTime[t]) byTime[t] = {};
      byTime[t][instrument] = {
        close: parseFloat(c.close),
        high:  parseFloat(c.high),
        low:   parseFloat(c.low),
      };
    }
  }
  return byTime;
}

// ─── Session classification ───────────────────────────────────────────────────

function classifyHour(isoTime) {
  return getCurrentSession(new Date(isoTime)).session;
}

// ─── Currency strength (inline, from session-open moves) ─────────────────────
// Computes a simple composite strength for each of 8 currencies using the
// same candle data already loaded — no extra DB fetch needed.

const CURRENCIES = ['GBP', 'EUR', 'USD', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

function computeCurrencyStrengths(candles, sessionOpenPrices) {
  const sums  = {};
  const counts = {};
  for (const ccy of CURRENCIES) { sums[ccy] = 0; counts[ccy] = 0; }

  for (const inst of config.instruments) {
    const [base, quote] = inst.split('_');
    const c    = candles[inst];
    const open = sessionOpenPrices[inst];
    if (!c || open == null || open === 0) continue;
    const move = (c.close - open) / open;
    sums[base]  += move;  counts[base]++;
    sums[quote] -= move;  counts[quote]++;
  }

  const strength = {};
  for (const ccy of CURRENCIES) {
    strength[ccy] = counts[ccy] > 0 ? sums[ccy] / counts[ccy] : 0;
  }
  return strength;
}

// ─── Core computation engine ──────────────────────────────────────────────────

function processHours(hourKeys, byTime, onlyLast = false) {
  const TOTAL = config.instruments.length; // 28
  const HIST  = 20;                        // rolling sessions for normalization

  // Per-pair per-session rolling histories
  const moveHistory  = {}; // inst → session → [final pair_session_move per past session]
  const rangeHistory = {}; // inst → session → [final session_range per past session]

  // EMA state per pair per session type (persists across hours and sessions)
  const pairEma = {}; // inst → session → smooth_move

  // Current session state
  let currentSession    = null;
  let sessionOpenPrices = {}; // inst → close of first H1 of this session
  let sessionHigh       = {}; // inst → running max high
  let sessionLow        = {}; // inst → running min low
  let sessionFinalMove  = {}; // inst → latest pair_session_move (abs)

  // Cross-session state
  let prevEnergyBase    = null; // avg energy_base of the previous completed session
  let compressionStreak = 0;   // consecutive completed compressed sessions
  let sessionEBList     = [];  // energy_base values within current session (for avg at close)
  // Track running session averages for compression check at close
  let sessionMovList    = [];
  let sessionBrdList    = [];
  let sessionVolList    = [];

  const rows = [];

  for (const hk of hourKeys) {
    const candles = byTime[hk];
    const session = classifyHour(hk);

    // ── Session transition ──────────────────────────────────────────────────
    if (session !== currentSession) {
      if (currentSession && currentSession !== 'LOW_LIQUIDITY') {

        // Finalise move history for previous session
        for (const inst of config.instruments) {
          const finalMove = sessionFinalMove[inst];
          if (finalMove != null) {
            if (!moveHistory[inst])                moveHistory[inst]                = {};
            if (!moveHistory[inst][currentSession]) moveHistory[inst][currentSession] = [];
            moveHistory[inst][currentSession].push(finalMove);
            if (moveHistory[inst][currentSession].length > HIST) moveHistory[inst][currentSession].shift();
          }

          // Finalise range history for previous session
          const high = sessionHigh[inst];
          const low  = sessionLow[inst];
          const open = sessionOpenPrices[inst];
          if (high != null && low != null && open > 0) {
            const range = (high - low) / open;
            if (!rangeHistory[inst])                rangeHistory[inst]                = {};
            if (!rangeHistory[inst][currentSession]) rangeHistory[inst][currentSession] = [];
            rangeHistory[inst][currentSession].push(range);
            if (rangeHistory[inst][currentSession].length > HIST) rangeHistory[inst][currentSession].shift();
          }
        }

        // Compute session averages for compression check and energy base carry-over
        const avgMov = arrAvg(sessionMovList);
        const avgBrd = arrAvg(sessionBrdList);
        const avgVol = arrAvg(sessionVolList);

        // Step 11: compressed session detection
        if (avgMov < 35 && avgBrd < 35 && avgVol < 40) {
          compressionStreak++;
        } else {
          compressionStreak = 0;
        }

        // Step 10: carry energy base forward
        if (sessionEBList.length) prevEnergyBase = arrAvg(sessionEBList);
      }

      // Reset for new session
      sessionOpenPrices = {};
      sessionHigh       = {};
      sessionLow        = {};
      sessionFinalMove  = {};
      sessionEBList     = [];
      sessionMovList    = [];
      sessionBrdList    = [];
      sessionVolList    = [];

      for (const [inst, c] of Object.entries(candles)) {
        sessionOpenPrices[inst] = c.close;
        sessionHigh[inst]       = c.high;
        sessionLow[inst]        = c.low;
      }
      currentSession = session;
    }

    if (session === 'LOW_LIQUIDITY') continue;

    // ── Running session high/low ────────────────────────────────────────────
    for (const [inst, c] of Object.entries(candles)) {
      if (c.high != null && (sessionHigh[inst] == null || c.high > sessionHigh[inst])) sessionHigh[inst] = c.high;
      if (c.low  != null && (sessionLow[inst]  == null || c.low  < sessionLow[inst]))  sessionLow[inst]  = c.low;
    }

    // ── Currency strength (Step 8) ──────────────────────────────────────────
    const ccyStrength = computeCurrencyStrengths(candles, sessionOpenPrices);

    // ── Per-pair calculations ───────────────────────────────────────────────
    const smoothMoveVals    = [];
    const normalizedRanges  = [];
    let alignedActive = 0;
    let totalActive   = 0;
    let bullish = 0, bearish = 0;

    for (const inst of config.instruments) {
      const c    = candles[inst];
      const open = sessionOpenPrices[inst];
      if (!c || open == null || open === 0) continue;

      // Step 3: raw pair session move (cumulative from session open)
      const rawDir  = (c.close - open) / open;
      const rawMove = Math.abs(rawDir);
      sessionFinalMove[inst] = rawMove;
      if (rawDir > 0) bullish++; else if (rawDir < 0) bearish++;

      // Step 4: normalize against rolling-20 avg for this pair × session
      const mhist  = moveHistory[inst]?.[session] || [];
      const mhAvg  = mhist.length > 0 ? arrAvg(mhist) : rawMove;
      const normMov = mhAvg > 0 ? rawMove / mhAvg : 1.0;

      // Step 5: EMA smooth (α = 0.5)
      if (!pairEma[inst]) pairEma[inst] = {};
      const prevEma    = pairEma[inst][session] ?? normMov;
      const smoothMove = (prevEma + normMov) / 2;
      pairEma[inst][session] = smoothMove;
      smoothMoveVals.push(smoothMove);

      // Step 8: directional agreement — only for active pairs (smooth_move >= 1.0)
      if (smoothMove >= 1.0) {
        totalActive++;
        const [base, quote] = inst.split('_');
        const expectedDir = (ccyStrength[base] || 0) - (ccyStrength[quote] || 0);
        if ((expectedDir > 0 && rawDir > 0) || (expectedDir < 0 && rawDir < 0)) alignedActive++;
      }

      // Step 9: session range normalized by rolling-20 avg
      const high = sessionHigh[inst];
      const low  = sessionLow[inst];
      if (high != null && low != null) {
        const range  = (high - low) / open;
        const rhist  = rangeHistory[inst]?.[session] || [];
        const rhAvg  = rhist.length > 0 ? arrAvg(rhist) : range;
        normalizedRanges.push(rhAvg > 0 ? range / rhAvg : 1.0);
      }
    }

    if (!smoothMoveVals.length) continue;

    // Step 6: movement score
    const moveMagnitude = arrAvg(smoothMoveVals);
    const movementScore = round1(Math.min(100, moveMagnitude * 50));

    // Step 7: breadth score
    const activePairs  = smoothMoveVals.filter(m => m >= 1.0).length;
    const breadthScore = round1((activePairs / TOTAL) * 100);

    // Step 8: agreement score
    const agreementScore = totalActive > 0 ? round1((alignedActive / totalActive) * 100) : 0;

    // Step 9: volatility score
    const volatilityScore = normalizedRanges.length > 0
      ? round1(Math.min(100, arrAvg(normalizedRanges) * 50))
      : 0;

    // Step 10: energy base and acceleration
    const energyBase   = round1(0.45 * movementScore + 0.35 * breadthScore + 0.20 * volatilityScore);
    const acceleration = prevEnergyBase != null ? round1(energyBase - prevEnergyBase) : 0;

    // Accumulate session-level tracking lists
    sessionEBList.push(energyBase);
    sessionMovList.push(movementScore);
    sessionBrdList.push(breadthScore);
    sessionVolList.push(volatilityScore);

    rows.push({
      time_utc:              hk,
      session_name:          session,
      movement_score:        movementScore,
      breadth_score:         breadthScore,
      agreement_score:       agreementScore,
      volatility_score:      volatilityScore,
      energy_base:           energyBase,
      acceleration:          acceleration,
      compression_streak:    compressionStreak,
      compression_score:     round1(((100 - movementScore) * (100 - breadthScore)) / 100),
      expansion_score:       round1((movementScore * breadthScore) / 100),
      directional_agreement: agreementScore, // backward compat alias
      pairs_moving:          activePairs,
      pairs_quiet:           TOTAL - activePairs,
      movement_magnitude:    round1(moveMagnitude * 100),
    });
  }

  return onlyLast ? rows.slice(-1) : rows;
}

// ─── Session summaries ────────────────────────────────────────────────────────

async function computeSessionSummaries() {
  const { data: rawRows, error } = await supabase
    .from('hourly_session_activity')
    .select('time_utc, session_name, movement_score, breadth_score, agreement_score, volatility_score, energy_base, acceleration, pairs_moving, directional_agreement, expansion_score, compression_streak')
    .order('time_utc', { ascending: true });
  if (error || !rawRows?.length) return;

  const groups = {};
  for (const r of rawRows) {
    const date = r.time_utc.slice(0, 10);
    if (new Date(date).getUTCDay() % 6 === 0) continue;
    const key = `${date}:${r.session_name}`;
    if (!groups[key]) groups[key] = { date, session: r.session_name, hrs: [] };
    groups[key].hrs.push(r);
  }

  const sortedKeys     = Object.keys(groups).sort();
  const sessionHistory = {};

  const summaries = sortedKeys.map(key => {
    const g         = groups[key];
    const movements = g.hrs.map(h => parseFloat(h.movement_score)   || 0);
    const breadths  = g.hrs.map(h => parseFloat(h.breadth_score)    || 0);
    const agreements= g.hrs.map(h => parseFloat(h.agreement_score   ?? h.directional_agreement) || 0);
    const vols      = g.hrs.map(h => parseFloat(h.volatility_score) || 0);
    const ebs       = g.hrs.map(h => parseFloat(h.energy_base)      || 0);
    const accels    = g.hrs.map(h => parseFloat(h.acceleration)     || 0);
    const movingN   = g.hrs.map(h => parseInt(h.pairs_moving)       || 0);

    const avgMov  = arrAvg(movements);
    const avgBrd  = arrAvg(breadths);
    const avgAgr  = arrAvg(agreements);
    const avgVol  = arrAvg(vols);
    const avgEB   = arrAvg(ebs);
    const avgAcc  = arrAvg(accels);

    // Expansion component vs last-10 same-session history
    const hist    = sessionHistory[g.session] || [];
    const histAvg = hist.slice(-10).length > 0 ? arrAvg(hist.slice(-10)) : avgMov;
    const expComp = round1(Math.min(100, (histAvg > 0 ? avgMov / histAvg : 1.0) * 50));
    if (!sessionHistory[g.session]) sessionHistory[g.session] = [];
    sessionHistory[g.session].push(avgMov);

    // Energy score: 40% movement + 35% breadth + 15% expansion + 10% agreement
    const energyScore = Math.min(100, Math.round(
      0.40 * avgMov + 0.35 * avgBrd + 0.15 * expComp + 0.10 * avgAgr
    ));

    let energyState = energyScore <= 15 ? 'DEAD'
                    : energyScore <= 35 ? 'COMPRESSION'
                    : energyScore <= 55 ? 'STABLE'
                    : energyScore <= 75 ? 'EXPANSION' : 'EXPLOSIVE';
    if (avgBrd < 50 && (energyState === 'EXPANSION' || energyState === 'EXPLOSIVE')) energyState = 'STABLE';

    // Session-level compression persistence (max streak in this session's hours)
    const maxStreak = g.hrs.reduce((m, h) => Math.max(m, parseInt(h.compression_streak) || 0), 0);

    return {
      session_date_utc:          g.date,
      session_name:              g.session,
      avg_movement_score:        round1(avgMov),
      avg_breadth_score:         round1(avgBrd),
      avg_directional_agreement: round1(avgAgr),
      avg_agreement_score:       round1(avgAgr),
      avg_volatility_score:      round1(avgVol),
      avg_energy_base:           round1(avgEB),
      avg_acceleration:          round1(avgAcc),
      expansion_score:           expComp,
      session_energy_score:      energyScore,
      session_state:             energyState,
      pairs_moving_avg:          round1(arrAvg(movingN)),
      expansion_hours:           g.hrs.filter(h => parseFloat(h.expansion_score) >= 40).length,
      compression_hours:         g.hrs.filter(h => parseFloat(h.expansion_score) <  20).length,
      compression_streak:        maxStreak,
      hour_count:                g.hrs.length,
    };
  });

  if (!summaries.length) return;
  const { error: e } = await supabase
    .from('session_performance_summary')
    .upsert(summaries, { onConflict: 'session_date_utc,session_name', ignoreDuplicates: false });
  if (e) throw new Error(`Summary upsert: ${e.message}`);
  console.log(`[SESSION_ACTIVITY] ${summaries.length} summaries stored.`);
}

// ─── Backfill ─────────────────────────────────────────────────────────────────

async function backfillSessionActivity() {
  console.log('[SESSION_ACTIVITY] Backfill: fetching candles…');
  const byTime   = await fetchHourlyCandles(300);
  const hourKeys = Object.keys(byTime).sort();
  if (!hourKeys.length) { console.log('[SESSION_ACTIVITY] No candles.'); return; }

  const rows = processHours(hourKeys, byTime);
  if (!rows.length) return;

  const { error } = await supabase
    .from('hourly_session_activity')
    .upsert(rows, { onConflict: 'time_utc', ignoreDuplicates: false });
  if (error) throw new Error(`Hourly upsert: ${error.message}`);
  console.log(`[SESSION_ACTIVITY] Backfilled ${rows.length} rows.`);

  await computeSessionSummaries();
  return { rows: rows.length };
}

// ─── Incremental ──────────────────────────────────────────────────────────────

async function calculateLatestSessionActivity() {
  const byTime   = await fetchHourlyCandles(300);
  const hourKeys = Object.keys(byTime).sort();
  if (hourKeys.length < 2) return;

  const [row] = processHours(hourKeys, byTime, true);
  if (!row) return;

  const { error } = await supabase
    .from('hourly_session_activity')
    .upsert([row], { onConflict: 'time_utc', ignoreDuplicates: false });
  if (error) throw new Error(`Hourly upsert: ${error.message}`);

  console.log(
    `[SESSION_ACTIVITY] ✓ ${row.time_utc} | ${row.session_name}` +
    ` | mov:${row.movement_score} brd:${row.breadth_score}` +
    ` | agr:${row.agreement_score} vol:${row.volatility_score}` +
    ` | eb:${row.energy_base} acc:${row.acceleration > 0 ? '+' : ''}${row.acceleration}` +
    ` | streak:${row.compression_streak}`
  );

  await computeSessionSummaries();
  return row;
}

module.exports = { backfillSessionActivity, calculateLatestSessionActivity, computeSessionSummaries };
