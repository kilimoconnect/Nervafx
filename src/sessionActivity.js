'use strict';

/**
 * Session Activity Engine — Steps 4–7
 *
 * Step 4  Normalize: normalized_move = pair_session_move / rolling_20_session_avg
 * Step 5  Smooth:    smooth_move = (prev_smooth + normalized_move) / 2   (EMA α=0.5)
 * Step 6  Score:     movement_score = clamp(avg(smooth_move) × 50, 0, 100)
 * Step 7  Breadth:   active pair = smooth_move >= 1.0 → breadth_score = active/28 × 100
 *
 * Both backfill and incremental use the same processHours() engine.
 * Incremental fetches 300 candles to properly warm up the rolling averages
 * and EMA before computing the latest hour; only that row is upserted.
 */

const { supabase }          = require('./supabase');
const { getCurrentSession } = require('./sessionEngine');
const { config }            = require('./config');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round1(v) { return Math.round(v * 10) / 10; }
function arrAvg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

// ─── Candle fetch ─────────────────────────────────────────────────────────────

async function fetchHourlyCandles(limit = 300) {
  const byTime = {};
  for (const instrument of config.instruments) {
    const { data, error } = await supabase
      .from('market_candles')
      .select('time, close')
      .eq('instrument', instrument)
      .eq('timeframe', 'H1')
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Candle fetch ${instrument}: ${error.message}`);
    for (const c of data || []) {
      const t = new Date(c.time).toISOString();
      if (!byTime[t]) byTime[t] = {};
      byTime[t][instrument] = parseFloat(c.close);
    }
  }
  return byTime;
}

// ─── Session classification (fixed UTC) ──────────────────────────────────────

function classifyHour(isoTime) {
  return getCurrentSession(new Date(isoTime)).session;
}

// ─── Core computation engine ──────────────────────────────────────────────────
/**
 * Processes hours chronologically, maintaining:
 *   pairHistory[inst][session] — rolling list of final pair_session_moves
 *                                from the last 20 completed sessions of that type
 *   pairEma[inst][session]    — current EMA smooth_move value (persists across hours)
 *
 * Returns an array of hourly rows.
 * When onlyLast=true, only the final row is returned (used by incremental).
 */
function processHours(hourKeys, byTime, onlyLast = false) {
  const TOTAL_PAIRS = config.instruments.length; // 28
  const HISTORY_LEN = 20; // rolling sessions for normalization

  // Rolling per-pair per-session history (final move of each completed session)
  const pairHistory = {}; // inst → session → [move, ...]
  // EMA state per pair per session type
  const pairEma     = {}; // inst → session → smooth_move

  // Current session tracking
  let currentSession    = null;
  let sessionOpenPrices = {}; // inst → price at session open
  // Accumulate final moves per pair during a session (last value = session final move)
  let sessionFinalMove  = {}; // inst → latest pair_session_move in this session

  const rows = [];

  for (const hk of hourKeys) {
    const candles = byTime[hk];
    const session = classifyHour(hk);

    // ── Session transition ────────────────────────────────────────────────────
    if (session !== currentSession) {
      // Finalise previous session: push each pair's final session move into history
      if (currentSession && currentSession !== 'LOW_LIQUIDITY') {
        for (const inst of config.instruments) {
          const finalMove = sessionFinalMove[inst];
          if (finalMove == null) continue;
          if (!pairHistory[inst])           pairHistory[inst]           = {};
          if (!pairHistory[inst][currentSession]) pairHistory[inst][currentSession] = [];
          pairHistory[inst][currentSession].push(finalMove);
          if (pairHistory[inst][currentSession].length > HISTORY_LEN) {
            pairHistory[inst][currentSession].shift();
          }
        }
      }

      // Set session open prices from first closed candle of new session
      sessionOpenPrices = {};
      sessionFinalMove  = {};
      for (const [inst, close] of Object.entries(candles)) {
        sessionOpenPrices[inst] = close;
      }
      currentSession = session;
    }

    if (session === 'LOW_LIQUIDITY') continue;

    // ── Per-pair calculations ────────────────────────────────────────────────
    const smoothMoves = {}; // inst → smooth_move
    let bullish = 0, bearish = 0;

    for (const inst of config.instruments) {
      const close = candles[inst];
      const open  = sessionOpenPrices[inst];
      if (close == null || open == null || open === 0) continue;

      // Step 3: raw pair session move (cumulative from session open)
      const rawDir  = (close - open) / open;
      const rawMove = Math.abs(rawDir);
      sessionFinalMove[inst] = rawMove;

      if (rawDir > 0)      bullish++;
      else if (rawDir < 0) bearish++;

      // Step 4: normalize against rolling 20-session average for this pair+session
      const hist    = pairHistory[inst]?.[session] || [];
      const histAvg = hist.length > 0 ? arrAvg(hist) : rawMove; // fallback: first session = 1.0 normalized
      const normalizedMove = histAvg > 0 ? rawMove / histAvg : 1.0;

      // Step 5: EMA smooth (α = 0.5)
      if (!pairEma[inst])          pairEma[inst]          = {};
      const prevEma = pairEma[inst][session] ?? normalizedMove; // seed with current on first run
      const smoothMove = (prevEma + normalizedMove) / 2;
      pairEma[inst][session] = smoothMove;

      smoothMoves[inst] = smoothMove;
    }

    const smoothValues = Object.values(smoothMoves);
    if (!smoothValues.length) continue;

    // Step 6: market-wide movement score
    const moveMagnitude = arrAvg(smoothValues);
    const movementScore = round1(Math.min(100, moveMagnitude * 50));

    // Step 7: breadth — pairs at or above their normal session movement
    const activePairs  = smoothValues.filter(m => m >= 1.0).length;
    const breadthScore = round1((activePairs / TOTAL_PAIRS) * 100);

    // Directional agreement
    const directionalAgreement = round1((Math.max(bullish, bearish) / TOTAL_PAIRS) * 100);

    // Derived: compression/expansion product scores
    const compressionScore = round1(((100 - movementScore) * (100 - breadthScore)) / 100);
    const expansionScore   = round1((movementScore * breadthScore) / 100);

    rows.push({
      time_utc:              hk,
      session_name:          session,
      movement_score:        movementScore,
      breadth_score:         breadthScore,
      compression_score:     compressionScore,
      expansion_score:       expansionScore,
      directional_agreement: directionalAgreement,
      pairs_moving:          activePairs,
      pairs_quiet:           TOTAL_PAIRS - activePairs,
      movement_magnitude:    round1(moveMagnitude * 100), // smooth_move × 100 for display
    });
  }

  return onlyLast ? rows.slice(-1) : rows;
}

// ─── Session summaries ────────────────────────────────────────────────────────

async function computeSessionSummaries() {
  const { data: rows, error } = await supabase
    .from('hourly_session_activity')
    .select('time_utc, session_name, movement_score, breadth_score, pairs_moving, directional_agreement, expansion_score')
    .order('time_utc', { ascending: true });
  if (error || !rows?.length) return;

  // Group by date:session, skip weekends
  const groups = {};
  for (const r of rows) {
    const date = r.time_utc.slice(0, 10);
    if (new Date(date).getUTCDay() % 6 === 0) continue; // skip Sat/Sun
    const key = `${date}:${r.session_name}`;
    if (!groups[key]) groups[key] = { date, session: r.session_name, hrs: [] };
    groups[key].hrs.push(r);
  }

  const sortedKeys      = Object.keys(groups).sort();
  const sessionHistory  = {}; // session_name → [avg_movement_scores] for expansion ratio

  const summaries = sortedKeys.map(key => {
    const g         = groups[key];
    const movements = g.hrs.map(h => parseFloat(h.movement_score));
    const breadths  = g.hrs.map(h => parseFloat(h.breadth_score));
    const movingN   = g.hrs.map(h => parseInt(h.pairs_moving));
    const dirAgrees = g.hrs.map(h => parseFloat(h.directional_agreement) || 0);

    const avgMov = arrAvg(movements);
    const avgBrd = arrAvg(breadths);
    const avgDir = arrAvg(dirAgrees);

    // Expansion component: current avg vs last-10 same-session avg (ratio × 50, capped 100)
    const hist    = sessionHistory[g.session] || [];
    const histAvg = hist.slice(-10).length > 0 ? arrAvg(hist.slice(-10)) : avgMov;
    const expRatio = histAvg > 0 ? avgMov / histAvg : 1.0;
    const expansionComponent = round1(Math.min(100, expRatio * 50));
    if (!sessionHistory[g.session]) sessionHistory[g.session] = [];
    sessionHistory[g.session].push(avgMov);

    // Energy score: 40% movement + 35% breadth + 15% expansion + 10% direction
    const energyScore = Math.min(100, Math.round(
      0.40 * avgMov + 0.35 * avgBrd + 0.15 * expansionComponent + 0.10 * avgDir
    ));

    let energyState = energyScore <= 15 ? 'DEAD'
                    : energyScore <= 35 ? 'COMPRESSION'
                    : energyScore <= 55 ? 'STABLE'
                    : energyScore <= 75 ? 'EXPANSION' : 'EXPLOSIVE';
    // Breadth protection: low participation cannot be EXPANSION or EXPLOSIVE
    if (avgBrd < 50 && (energyState === 'EXPANSION' || energyState === 'EXPLOSIVE')) energyState = 'STABLE';

    return {
      session_date_utc:          g.date,
      session_name:              g.session,
      avg_movement_score:        round1(avgMov),
      avg_breadth_score:         round1(avgBrd),
      avg_directional_agreement: round1(avgDir),
      expansion_score:           expansionComponent,
      session_energy_score:      energyScore,
      session_state:             energyState,
      pairs_moving_avg:          round1(arrAvg(movingN)),
      expansion_hours:           g.hrs.filter(h => parseFloat(h.expansion_score) >= 40).length,
      compression_hours:         g.hrs.filter(h => parseFloat(h.expansion_score) <  20).length,
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

// ─── Incremental (called each hour) ──────────────────────────────────────────
// Fetches 300 candles to warm up rolling averages and EMA, then upserts only
// the latest computed row.

async function calculateLatestSessionActivity() {
  const byTime   = await fetchHourlyCandles(300);
  const hourKeys = Object.keys(byTime).sort();
  if (hourKeys.length < 2) return;

  const [row] = processHours(hourKeys, byTime, true); // onlyLast=true
  if (!row) return;

  const { error } = await supabase
    .from('hourly_session_activity')
    .upsert([row], { onConflict: 'time_utc', ignoreDuplicates: false });
  if (error) throw new Error(`Hourly upsert: ${error.message}`);

  console.log(
    `[SESSION_ACTIVITY] ✓ ${row.time_utc} | ${row.session_name}` +
    ` | mov:${row.movement_score} brd:${row.breadth_score}` +
    ` | active:${row.pairs_moving}/28 dir:${row.directional_agreement}`
  );

  await computeSessionSummaries();
  return row;
}

module.exports = { backfillSessionActivity, calculateLatestSessionActivity, computeSessionSummaries };
