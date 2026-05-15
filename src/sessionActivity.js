'use strict';

const { supabase }          = require('./supabase');
const { getCurrentSession } = require('./sessionEngine');
const { config }            = require('./config');

// ─── Thresholds ───────────────────────────────────────────────────────────────
const STRONG_MOVEMENT_THRESHOLD = 0.0003; // 0.03% — pair counts as "moving strongly"
const MOVEMENT_CEILING          = 0.0020; // 0.20% → score 100 (normalisation cap)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeMovement(raw) {
  return Math.min(100, (raw / MOVEMENT_CEILING) * 100);
}

function classifyMarketState(movementScore, breadthScore) {
  if (movementScore >= 70 && breadthScore >= 65) return 'HIGH_EXPANSION';
  if (movementScore >= 45 && breadthScore >= 45) return 'EXPANSION';
  if (movementScore <= 15 && breadthScore <= 20) return 'QUIET';
  if (breadthScore <= 25)                        return 'COMPRESSION';
  return 'MIXED';
}

// Session Energy Score: 40% movement + 35% breadth + 15% expansion + 10% directional
// expansion component: current avg movement vs last-10 same-session avg, normalised 0-100
// (ratio 1.0 = 50pts, 2.0+ = 100pts, 0 = 0pts)
function sessionEnergyScore(avgMov, avgBrd, expansionComponent, avgDir) {
  return Math.min(100, Math.round(
    0.40 * avgMov +
    0.35 * avgBrd +
    0.15 * expansionComponent +
    0.10 * avgDir
  ));
}

function sessionEnergyState(score, avgBrd) {
  let state;
  if (score <= 15) state = 'DEAD';
  else if (score <= 35) state = 'COMPRESSION';
  else if (score <= 55) state = 'STABLE';
  else if (score <= 75) state = 'EXPANSION';
  else state = 'EXPLOSIVE';
  // Breadth protection: low participation cannot be EXPANSION or EXPLOSIVE
  if (avgBrd < 50 && (state === 'EXPANSION' || state === 'EXPLOSIVE')) state = 'STABLE';
  return state;
}

function round1(v) { return Math.round(v * 10) / 10; }

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

// ─── Per-hour calculation ─────────────────────────────────────────────────────

function computeRow(hourKey, candles, sessionOpenPrices) {
  const session = getCurrentSession(new Date(hourKey));
  if (session.session === 'DEAD_HOURS') return null;
  const total = config.instruments.length; // 28

  let bullish = 0, bearish = 0;
  const movements = [];

  for (const instrument of config.instruments) {
    const c    = candles[instrument];
    const open = sessionOpenPrices[instrument];
    if (!c || !open) continue;
    const move = (c.close - open) / open;
    movements.push(Math.abs(move));
    if (move > 0)      bullish++;
    else if (move < 0) bearish++;
  }
  if (movements.length === 0) return null;

  const avgMovement  = movements.reduce((a, b) => a + b, 0) / movements.length;
  const pairsMoving  = movements.filter(m => m >= STRONG_MOVEMENT_THRESHOLD).length;
  const pairsQuiet   = total - pairsMoving;

  const movementScore          = round1(normalizeMovement(avgMovement));
  const breadthScore           = round1((pairsMoving / total) * 100);
  const compressionScore       = round1(((100 - movementScore) * (100 - breadthScore)) / 100);
  const expansionScore         = round1((movementScore * breadthScore) / 100);
  const directionalAgreement   = round1((Math.max(bullish, bearish) / total) * 100);

  return {
    time_utc:              hourKey,
    session_name:          session.session,
    movement_score:        movementScore,
    breadth_score:         breadthScore,
    compression_score:     compressionScore,
    expansion_score:       expansionScore,
    directional_agreement: directionalAgreement,
    pairs_moving:          pairsMoving,
    pairs_quiet:           pairsQuiet,
    market_state:          classifyMarketState(movementScore, breadthScore),
  };
}

// ─── Session summaries ────────────────────────────────────────────────────────

async function computeSessionSummaries() {
  const { data: rows, error } = await supabase
    .from('hourly_session_activity')
    .select('time_utc, session_name, movement_score, breadth_score, market_state, pairs_moving, directional_agreement')
    .order('time_utc', { ascending: true });
  if (error || !rows?.length) return;

  // Build groups keyed date:session, skipping weekends
  const groups = {};
  for (const r of rows) {
    const date = r.time_utc.slice(0, 10);
    const dow  = new Date(date).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const key = `${date}:${r.session_name}`;
    if (!groups[key]) groups[key] = { date, session: r.session_name, hrs: [] };
    groups[key].hrs.push(r);
  }

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const max = arr => Math.max(...arr);

  // Process in chronological order so each session can look back at its own history
  const sortedKeys = Object.keys(groups).sort();
  const sessionHistory = {}; // session_name → [avg_movement_scores in chronological order]

  const summaries = sortedKeys.map(key => {
    const g          = groups[key];
    const movements  = g.hrs.map(h => parseFloat(h.movement_score));
    const breadths   = g.hrs.map(h => parseFloat(h.breadth_score));
    const movingNums = g.hrs.map(h => parseInt(h.pairs_moving));
    const dirAgrees  = g.hrs.map(h => parseFloat(h.directional_agreement) || 0);

    const avgMov = avg(movements);
    const avgBrd = avg(breadths);
    const avgDir = avg(dirAgrees);

    // Expansion score: compare this session's movement to last 10 of same session type
    const hist    = sessionHistory[g.session] || [];
    const last10  = hist.slice(-10);
    const histAvg = last10.length > 0 ? avg(last10) : avgMov;
    const expRatio = histAvg > 0 ? avgMov / histAvg : 1.0;
    // Normalise: ratio 1.0 → 50pts, 2.0+ → 100pts, 0 → 0pts
    const expansionComponent = round1(Math.min(100, expRatio * 50));

    // Update history AFTER computing score (so this session isn't in its own baseline)
    if (!sessionHistory[g.session]) sessionHistory[g.session] = [];
    sessionHistory[g.session].push(avgMov);

    const energyScore = sessionEnergyScore(avgMov, avgBrd, expansionComponent, avgDir);
    const energyState = sessionEnergyState(energyScore, avgBrd);

    const stateCounts = {};
    for (const h of g.hrs) stateCounts[h.market_state] = (stateCounts[h.market_state] || 0) + 1;
    const dominant = Object.entries(stateCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'MIXED';

    return {
      session_date_utc:           g.date,
      session_name:               g.session,
      avg_movement_score:         round1(avgMov),
      max_movement_score:         round1(max(movements)),
      avg_breadth_score:          round1(avgBrd),
      max_breadth_score:          round1(max(breadths)),
      avg_directional_agreement:  round1(avgDir),
      expansion_score:            expansionComponent,
      session_energy_score:       energyScore,
      session_state:              energyState,
      dominant_state:             dominant,
      pairs_moving_avg:           round1(avg(movingNums)),
      expansion_hours:            g.hrs.filter(h => h.market_state === 'EXPANSION' || h.market_state === 'HIGH_EXPANSION').length,
      compression_hours:          g.hrs.filter(h => h.market_state === 'COMPRESSION' || h.market_state === 'QUIET').length,
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
  console.log('[SESSION_ACTIVITY] Fetching candles...');
  const byTime   = await fetchHourlyCandles(210);
  const hourKeys = Object.keys(byTime).sort();
  if (!hourKeys.length) { console.log('[SESSION_ACTIVITY] No candles.'); return; }

  let currentSession    = null;
  let sessionOpenPrices = {};
  const rows = [];

  for (const hk of hourKeys) {
    const candles = byTime[hk];
    const session = getCurrentSession(new Date(hk));

    if (session.session !== currentSession) {
      sessionOpenPrices = {};
      for (const [inst, c] of Object.entries(candles)) sessionOpenPrices[inst] = c.open;
      currentSession = session.session;
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

// ─── Incremental ──────────────────────────────────────────────────────────────

async function calculateLatestSessionActivity() {
  const byTime   = await fetchHourlyCandles(30);
  const hourKeys = Object.keys(byTime).sort();
  if (hourKeys.length < 2) return;

  const latestHk      = hourKeys[hourKeys.length - 1];
  const latestSession = getCurrentSession(new Date(latestHk)).session;

  let sessionOpenPrices = {};
  for (let i = hourKeys.length - 1; i >= 0; i--) {
    const s = getCurrentSession(new Date(hourKeys[i])).session;
    if (s !== latestSession || i === 0) {
      const firstHk = (s !== latestSession) ? hourKeys[i + 1] : hourKeys[i];
      for (const [inst, c] of Object.entries(byTime[firstHk] || {})) {
        sessionOpenPrices[inst] = c.open;
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

  console.log(`[SESSION_ACTIVITY] ✓ ${latestHk} | ${row.session_name} | ${row.market_state} | mov:${row.movement_score} breadth:${row.breadth_score} dir:${row.directional_agreement}`);

  await computeSessionSummaries();
  return row;
}

module.exports = { backfillSessionActivity, calculateLatestSessionActivity, computeSessionSummaries };
