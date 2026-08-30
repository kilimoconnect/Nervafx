'use strict';

/**
 * GET /api/cme-signal-scan?engine=30m|15m|5m
 *
 * Replays the last 24 hours of TRADING (weekday) data for a Currency Movement
 * Engine and returns every timestamp at which a fully-qualified
 * STRUCTURE_CONFIRMED_MOVEMENT signal existed (|move| ≥ 90, |confirmed| ≥ 90,
 * close Q ≥ 70% — the same gate as the page/email).
 *
 * Efficient: each pair's candles are fetched ONCE (24h + BOS lookback), then the
 * primary-window BOS/edge check is replayed at each completed candle in-memory
 * (no re-fetch, no session windows). Weekends resolve to Friday automatically —
 * the sweep ends at the most recent ACTUAL completed candle, which on Sat/Sun is
 * Friday's close.
 */

const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');
const { fetchClosed } = require('./_cme-data');
const { synthM30 } = require('./_cme30-data');
const { PAIRS } = require('./_cme-constants');
const { localStr } = require('./_h1c-time');

const M5_MS = 300000, M15_MS = 900000, M30_MS = 1800000, DAY_MS = 24 * 3600000;
const DEFAULT_TZ = 'Africa/Dar_es_Salaam';
const MIN_MOVE_EDGE = 90, MIN_CONFIRMED = 90, MIN_CLOSE_Q = 0.70;

const ENGINES = {
  '30m': { base: M30_MS, primary: 'M30', scan: require('./_cme30-scan'), enhanceMicro: true },
  '15m': { base: M15_MS, primary: 'M15', scan: require('./_cme15-scan'), enhanceMicro: true },
  '5m': { base: M5_MS, primary: 'M5', scan: require('./_cme05-scan'), enhanceMicro: false },
};

/** Fetch each pair's raw candles once (≤ anchorMs), in parallel batches of 7. */
async function fetchRaw(sb, engine, anchorMs) {
  const raw = {};
  for (let i = 0; i < PAIRS.length; i += 7) {
    const batch = PAIRS.slice(i, i + 7);
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(batch.map(async (pair) => {
      try {
        if (engine === '30m') {
          const m15 = (await fetchClosed(sb, pair, 'M15', anchorMs, M15_MS, 320)).candles;
          raw[pair] = { m15, m30: synthM30(m15, anchorMs) };
        } else if (engine === '15m') {
          const [m15, m5] = await Promise.all([
            fetchClosed(sb, pair, 'M15', anchorMs, M15_MS, 260),
            fetchClosed(sb, pair, 'M5', anchorMs, M5_MS, 460),
          ]);
          raw[pair] = { m15: m15.candles, m5: m5.candles };
        } else {
          raw[pair] = { m5: (await fetchClosed(sb, pair, 'M5', anchorMs, M5_MS, 700)).candles };
        }
      } catch (e) { raw[pair] = { error: e.message }; }
    }));
  }
  return raw;
}

/** Latest completed primary-candle open present in the data (weekend-safe). */
function latestPrimaryOpen(raw, engine) {
  const key = engine === '30m' ? 'm30' : engine === '15m' ? 'm15' : 'm5';
  let mx = -Infinity;
  for (const pair of PAIRS) {
    const arr = raw[pair] && raw[pair][key];
    if (arr && arr.length) mx = Math.max(mx, arr[arr.length - 1].openMs);
  }
  return mx > 0 ? mx : null;
}

/** Build the pairData the engine expects, sliced to candles with openMs ≤ t. */
function sliceAt(raw, engine, t) {
  const keys = engine === '30m' ? ['m30', 'm15'] : engine === '15m' ? ['m15', 'm5'] : ['m5'];
  const out = {};
  for (const pair of PAIRS) {
    const r = raw[pair]; if (!r || r.error) continue;
    const pd = {};
    for (const k of keys) pd[k] = (r[k] || []).filter((c) => c.openMs <= t);
    out[pair] = pd;
  }
  return out;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const sb = getClient();
  try {
    if (!req._internal) {
      const gate = await requirePlan(sb, req, 'premium');
      if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
    }

    const q = req.query || {};
    const engine = String(q.engine || '').toLowerCase();
    const cfg = ENGINES[engine];
    if (!cfg) return res.status(400).json({ error: 'engine must be 30m | 15m | 5m' });
    const tz = q.timezone || DEFAULT_TZ;
    const anchorMs = q.at ? new Date(q.at).getTime() : Date.now();
    if (isNaN(anchorMs)) return res.status(400).json({ error: 'invalid ?at timestamp' });

    const raw = await fetchRaw(sb, engine, anchorMs);
    const endOpen = latestPrimaryOpen(raw, engine);
    if (endOpen == null) return res.json({ engine, signals: [], reason: 'no candle data' });

    const base = cfg.base;
    const N = Math.round(DAY_MS / base);
    const firstOpen = endOpen - (N - 1) * base;

    const signals = [];
    let evaluated = 0;
    for (let t = firstOpen; t <= endOpen; t += base) {
      const pd = sliceAt(raw, engine, t);
      // Skip steps where the primary candle at t doesn't actually exist (gaps/weekend).
      const key = engine === '30m' ? 'm30' : engine === '15m' ? 'm15' : 'm5';
      const ref = (pd.EUR_USD && pd.EUR_USD[key]) || [];
      if (!ref.length || ref[ref.length - 1].openMs !== t) continue;
      evaluated += 1;
      const ev = cfg.scan.evaluateWindows(pd, t + base, { primaryOnly: true, enhanceMicro: cfg.enhanceMicro });
      const hits = (ev.pairEdges || []).filter((e) => e.opportunity === 'STRUCTURE_CONFIRMED_MOVEMENT'
        && Math.abs(e.pairMovementEdge || 0) >= MIN_MOVE_EDGE
        && Math.abs(e.pairConfirmedEdge || 0) >= MIN_CONFIRMED
        && (e.closeQuality || 0) >= MIN_CLOSE_Q
        && e.bosDirection && e.bosDirection !== 'NONE');
      if (hits.length) {
        const closeMs = t + base;
        signals.push({
          atUtc: new Date(closeMs).toISOString(),
          atLocal: localStr(closeMs, tz),
          pairs: hits.map((e) => ({
            pair: e.pair.replace('_', '/'), dir: e.bosDirection, grade: e.bosGrade,
            move: e.pairMovementEdge, confirmed: e.pairConfirmedEdge, closeQ: e.closeQuality,
          })),
        });
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      engine, timezone: tz, stepMinutes: base / 60000,
      windowStartUtc: new Date(firstOpen + base).toISOString(),
      windowEndUtc: new Date(endOpen + base).toISOString(),
      windowStartLocal: localStr(firstOpen + base, tz),
      windowEndLocal: localStr(endOpen + base, tz),
      stepsEvaluated: evaluated,
      signalCount: signals.length,
      signals: signals.reverse(), // most recent first
    });
  } catch (e) {
    console.error('[cme-signal-scan]', e.message);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 120;
