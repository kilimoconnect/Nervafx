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

function round1(v) { return Math.round(v * 10) / 10; }

// ─── Candle fetch ─────────────────────────────────────────────────────────────
// Returns { timeISO: { INSTRUMENT: { open, close } } }

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
// sessionOpenPrices: { INSTRUMENT: open_price_at_session_start }

function computeRow(hourKey, candles, sessionOpenPrices) {
  const session = getCurrentSession(new Date(hourKey));
  const total   = config.instruments.length; // 28

  const movements = [];
  for (const instrument of config.instruments) {
    const c     = candles[instrument];
    const open  = sessionOpenPrices[instrument];
    if (!c || !open) continue;
    movements.push(Math.abs(c.close - open) / open);
  }
  if (movements.length === 0) return null;

  const avgMovement  = movements.reduce((a, b) => a + b, 0) / movements.length;
  const pairsMoving  = movements.filter(m => m >= STRONG_MOVEMENT_THRESHOLD).length;
  const pairsQuiet   = total - pairsMoving;

  const movementScore    = round1(normalizeMovement(avgMovement));
  const breadthScore     = round1((pairsMoving / total) * 100);
  const compressionScore = round1(((100 - movementScore) * (100 - breadthScore)) / 100);
  const expansionScore   = round1((movementScore * breadthScore) / 100);

  return {
    time_utc:          hourKey,
    session_name:      session.session,
    movement_score:    movementScore,
    breadth_score:     breadthScore,
    compression_score: compressionScore,
    expansion_score:   expansionScore,
    pairs_moving:      pairsMoving,
    pairs_quiet:       pairsQuiet,
    market_state:      classifyMarketState(movementScore, breadthScore),
  };
}

// ─── Session summaries ────────────────────────────────────────────────────────

async function computeSessionSummaries() {
  const { data: rows, error } = await supabase
    .from('hourly_session_activity')
    .select('time_utc, session_name, movement_score, breadth_score, market_state, pairs_moving')
    .order('time_utc', { ascending: true });
  if (error || !rows?.length) return;

  const groups = {};
  for (const r of rows) {
    const date = r.time_utc.slice(0, 10);
    const key  = `${date}:${r.session_name}`;
    if (!groups[key]) groups[key] = { date, session: r.session_name, hrs: [] };
    groups[key].hrs.push(r);
  }

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const max = arr => Math.max(...arr);

  const summaries = Object.values(groups).map(g => {
    const movements  = g.hrs.map(h => parseFloat(h.movement_score));
    const breadths   = g.hrs.map(h => parseFloat(h.breadth_score));
    const movingNums = g.hrs.map(h => parseInt(h.pairs_moving));

    const stateCounts = {};
    for (const h of g.hrs) stateCounts[h.market_state] = (stateCounts[h.market_state] || 0) + 1;
    const dominant = Object.entries(stateCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'MIXED';

    return {
      session_date_utc:    g.date,
      session_name:        g.session,
      avg_movement_score:  round1(avg(movements)),
      max_movement_score:  round1(max(movements)),
      avg_breadth_score:   round1(avg(breadths)),
      max_breadth_score:   round1(max(breadths)),
      dominant_state:      dominant,
      pairs_moving_avg:    round1(avg(movingNums)),
      expansion_hours:     g.hrs.filter(h => h.market_state === 'EXPANSION' || h.market_state === 'HIGH_EXPANSION').length,
      compression_hours:   g.hrs.filter(h => h.market_state === 'COMPRESSION' || h.market_state === 'QUIET').length,
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
  const byTime   = await fetchHourlyCandles(30); // enough to find session start
  const hourKeys = Object.keys(byTime).sort();
  if (hourKeys.length < 2) return;

  const latestHk      = hourKeys[hourKeys.length - 1];
  const latestSession = getCurrentSession(new Date(latestHk)).session;

  // Walk back to find first hour of current session → session open prices
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

  console.log(`[SESSION_ACTIVITY] ✓ ${latestHk} | ${row.session_name} | ${row.market_state} | mov:${row.movement_score} breadth:${row.breadth_score}`);
  return row;
}

module.exports = { backfillSessionActivity, calculateLatestSessionActivity, computeSessionSummaries };
