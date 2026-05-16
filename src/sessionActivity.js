'use strict';

/**
 * Session Activity Engine — rebuilt
 *
 * Sessions (fixed UTC):
 *   LOW_LIQUIDITY : 21:00–00:00 UTC
 *   ASIA          : 00:00–07:00 UTC
 *   LONDON        : 07:00–13:00 UTC
 *   NEW_YORK      : 13:00–21:00 UTC
 *
 * Core metric per pair per session:
 *   pair_session_move = abs(current_close - session_open) / session_open
 *
 * Uses only closed H1 candles.
 * Session open price = close of the first closed H1 candle of the session.
 */

const { supabase }          = require('./supabase');
const { getCurrentSession } = require('./sessionEngine');
const { config }            = require('./config');

// ─── Thresholds ───────────────────────────────────────────────────────────────

const STRONG_MOVEMENT_THRESHOLD = 0.0003; // 0.03% — pair counts as "moving"
const MOVEMENT_CEILING          = 0.0020; // 0.20% → score 100 (normalisation cap)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeMovement(raw) {
  return Math.min(100, (raw / MOVEMENT_CEILING) * 100);
}

function round1(v) { return Math.round(v * 10) / 10; }

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

// ─── Candle fetch ─────────────────────────────────────────────────────────────

async function fetchHourlyCandles(limit = 210) {
  const byTime = {};
  for (const instrument of config.instruments) {
    const { data, error } = await supabase
      .from('market_candles')
      .select('time, open, close')
      .eq('instrument', instrument)
      .eq('timeframe', 'H1')
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Candle fetch ${instrument}: ${error.message}`);
    for (const c of data || []) {
      const t = new Date(c.time).toISOString();
      if (!byTime[t]) byTime[t] = {};
      byTime[t][instrument] = { open: parseFloat(c.open), close: parseFloat(c.close) };
    }
  }
  return byTime;
}

// ─── Session classification (fixed UTC) ──────────────────────────────────────

function classifyHour(isoTime) {
  const s = getCurrentSession(new Date(isoTime));
  return s.session; // LOW_LIQUIDITY | ASIA | LONDON | NEW_YORK
}

// ─── Per-hour row calculation ─────────────────────────────────────────────────
// sessionOpenPrices: { instrument → price at session open }

function computeRow(hourKey, candles, sessionOpenPrices) {
  const session = classifyHour(hourKey);
  if (session === 'LOW_LIQUIDITY') return null;

  const total = config.instruments.length; // 28
  let bullish = 0, bearish = 0;
  const movements = [];

  for (const instrument of config.instruments) {
    const c    = candles[instrument];
    const open = sessionOpenPrices[instrument];
    if (!c || open == null) continue;

    // Core metric: movement from session open to current closed candle close
    const rawMove = (c.close - open) / open;
    const absMov  = Math.abs(rawMove);
    movements.push(absMov);
    if (rawMove > 0)      bullish++;
    else if (rawMove < 0) bearish++;
  }

  if (!movements.length) return null;

  const avgMovement = avg(movements);
  const pairsMoving = movements.filter(m => m >= STRONG_MOVEMENT_THRESHOLD).length;
  const pairsQuiet  = total - pairsMoving;

  const movementScore        = round1(normalizeMovement(avgMovement));
  const breadthScore         = round1((pairsMoving / total) * 100);
  const compressionScore     = round1(((100 - movementScore) * (100 - breadthScore)) / 100);
  const expansionScore       = round1((movementScore * breadthScore) / 100);
  const directionalAgreement = round1((Math.max(bullish, bearish) / total) * 100);

  return {
    time_utc:              hourKey,
    session_name:          session,
    movement_score:        movementScore,
    breadth_score:         breadthScore,
    compression_score:     compressionScore,
    expansion_score:       expansionScore,
    directional_agreement: directionalAgreement,
    pairs_moving:          pairsMoving,
    pairs_quiet:           pairsQuiet,
    avg_pair_move_pct:     round1(avgMovement * 100), // raw % for reference
  };
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
    const dow  = new Date(date).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const key = `${date}:${r.session_name}`;
    if (!groups[key]) groups[key] = { date, session: r.session_name, hrs: [] };
    groups[key].hrs.push(r);
  }

  const sortedKeys = Object.keys(groups).sort();
  const sessionHistory = {}; // session_name → [avg_movement_scores]

  const summaries = sortedKeys.map(key => {
    const g          = groups[key];
    const movements  = g.hrs.map(h => parseFloat(h.movement_score));
    const breadths   = g.hrs.map(h => parseFloat(h.breadth_score));
    const movingNums = g.hrs.map(h => parseInt(h.pairs_moving));
    const dirAgrees  = g.hrs.map(h => parseFloat(h.directional_agreement) || 0);
    const expScores  = g.hrs.map(h => parseFloat(h.expansion_score) || 0);

    const avgMov = avg(movements);
    const avgBrd = avg(breadths);
    const avgDir = avg(dirAgrees);
    const avgExp = avg(expScores);

    // Expansion score: current vs last-10 same-session avg
    const hist    = sessionHistory[g.session] || [];
    const last10  = hist.slice(-10);
    const histAvg = last10.length > 0 ? avg(last10) : avgMov;
    const expRatio = histAvg > 0 ? avgMov / histAvg : 1.0;
    const expansionComponent = round1(Math.min(100, expRatio * 50));

    if (!sessionHistory[g.session]) sessionHistory[g.session] = [];
    sessionHistory[g.session].push(avgMov);

    // Energy score: 40% movement + 35% breadth + 15% expansion + 10% direction
    const energyScore = Math.min(100, Math.round(
      0.40 * avgMov + 0.35 * avgBrd + 0.15 * expansionComponent + 0.10 * avgDir
    ));

    let energyState;
    if (energyScore <= 15)      energyState = 'DEAD';
    else if (energyScore <= 35) energyState = 'COMPRESSION';
    else if (energyScore <= 55) energyState = 'STABLE';
    else if (energyScore <= 75) energyState = 'EXPANSION';
    else                        energyState = 'EXPLOSIVE';
    // Breadth protection
    if (avgBrd < 50 && (energyState === 'EXPANSION' || energyState === 'EXPLOSIVE')) energyState = 'STABLE';

    const expHours  = g.hrs.filter(h => parseFloat(h.expansion_score) >= 40).length;
    const compHours = g.hrs.filter(h => parseFloat(h.expansion_score) <  20).length;

    return {
      session_date_utc:          g.date,
      session_name:              g.session,
      avg_movement_score:        round1(avgMov),
      avg_breadth_score:         round1(avgBrd),
      avg_directional_agreement: round1(avgDir),
      avg_expansion_score:       round1(avgExp),
      expansion_score:           expansionComponent,
      session_energy_score:      energyScore,
      session_state:             energyState,
      pairs_moving_avg:          round1(avg(movingNums)),
      expansion_hours:           expHours,
      compression_hours:         compHours,
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
  console.log('[SESSION_ACTIVITY] Fetching candles for backfill…');
  const byTime   = await fetchHourlyCandles(210);
  const hourKeys = Object.keys(byTime).sort();
  if (!hourKeys.length) { console.log('[SESSION_ACTIVITY] No candles.'); return; }

  let currentSession    = null;
  let sessionOpenPrices = {};
  const rows = [];

  for (const hk of hourKeys) {
    const candles = byTime[hk];
    const session = classifyHour(hk);

    // New session started — record session open prices from first candle closes
    if (session !== currentSession) {
      sessionOpenPrices = {};
      for (const [inst, c] of Object.entries(candles)) {
        sessionOpenPrices[inst] = c.close; // first closed H1 = session open reference
      }
      currentSession = session;
    }

    const row = computeRow(hk, candles, sessionOpenPrices);
    if (row) rows.push(row);
  }

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

async function calculateLatestSessionActivity() {
  const byTime   = await fetchHourlyCandles(30);
  const hourKeys = Object.keys(byTime).sort();
  if (hourKeys.length < 2) return;

  const latestHk      = hourKeys[hourKeys.length - 1];
  const latestSession = classifyHour(latestHk);

  // Walk backwards to find the start of the current session and collect open prices
  let sessionOpenPrices = {};
  for (let i = hourKeys.length - 1; i >= 0; i--) {
    const s = classifyHour(hourKeys[i]);
    if (s !== latestSession || i === 0) {
      const firstHk = (s !== latestSession) ? hourKeys[i + 1] : hourKeys[i];
      for (const [inst, c] of Object.entries(byTime[firstHk] || {})) {
        sessionOpenPrices[inst] = c.close;
      }
      break;
    }
  }

  const row = computeRow(latestHk, byTime[latestHk], sessionOpenPrices);
  if (!row) return;

  const { error } = await supabase
    .from('hourly_session_activity')
    .upsert([row], { onConflict: 'time_utc', ignoreDuplicates: false });
  if (error) throw new Error(`Hourly upsert: ${error.message}`);

  console.log(`[SESSION_ACTIVITY] ✓ ${latestHk} | ${row.session_name} | mov:${row.movement_score} breadth:${row.breadth_score} dir:${row.directional_agreement}`);

  await computeSessionSummaries();
  return row;
}

module.exports = { backfillSessionActivity, calculateLatestSessionActivity, computeSessionSummaries };
