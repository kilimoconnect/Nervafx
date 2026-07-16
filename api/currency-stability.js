'use strict';

/**
 * GET /api/currency-stability[?tf=m5|m15|h1][&anchor=ISO]
 *
 * Live Currency Stability Engine. Reads the last 5 per-currency strength
 * snapshots on the requested timeframe (default M15) and computes:
 *
 *   • per-currency CSS = 0.5 × AvgStrength + 0.3 × Stability + 0.2 × DirCons
 *     (see api/_currency-stability.js)
 *   • strong / weak leaders (top-2 or bottom-2 for ≥ 4 of last 5 snapshots)
 *   • ranked pairs — BUY when base ∈ strong leaders AND quote ∈ weak leaders,
 *     SELL for the mirror. Pairs without leader alignment are still returned
 *     with a score but no direction.
 *
 * Same alignment-score maths as /api/currency-strength-{h1,m15,m5}-ema; only
 * the candle timeframe changes.
 */

const { cors, getClient } = require('./_db');
const { computeCSE, CCYS, PAIRS } = require('./_currency-stability');

const TF_STEP_MS = { M5: 5 * 60 * 1000, M15: 15 * 60 * 1000, H1: 60 * 60 * 1000 };

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function alignmentScore(close, e20, e50) {
  if (close > e20 && e20 > e50)  return +1.0;
  if (close < e20 && e20 < e50)  return -1.0;
  if (close > e20 && e20 <= e50) return +0.5;
  if (close < e20 && e20 >= e50) return -0.5;
  return 0;
}

async function fetchCloses(sb, inst, tf, limit) {
  const { data, error } = await sb
    .from('backtest_candles')
    .select('time, close')
    .eq('instrument', inst).eq('timeframe', tf).eq('complete', true)
    .order('time', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).reverse().map(c => ({ time: c.time, ms: new Date(c.time).getTime(), close: parseFloat(c.close) }));
}

// Build the last 5 snapshots ending at anchor: for each of the 5 target
// anchors, walk each pair's closes up to that anchor and score.
async function buildSnapshots(sb, tf, anchorMs) {
  const step = TF_STEP_MS[tf];
  const targetTimes = [];
  for (let i = 4; i >= 0; i--) targetTimes.push(anchorMs - i * step);

  // Fetch closes for each pair up to the anchor. Warmup = 51 candles at that
  // TF for EMA50. To also cover the earliest of the 5 targets we need ~+4
  // additional bars. Fetch 80 to be safe.
  const cache = {};
  for (let b = 0; b < PAIRS.length; b += 7) {
    const batch = PAIRS.slice(b, b + 7);
    await Promise.all(batch.map(async inst => {
      const closes = await fetchCloses(sb, inst, tf, 80);
      cache[inst] = closes.filter(c => c.ms <= anchorMs);
    }));
  }

  // For each target time, compute alignment score per pair using the sub-slice
  // ending at that time, then aggregate to per-currency strength.
  const snapshots = [];
  for (const t of targetTimes) {
    const agg = {}; CCYS.forEach(k => agg[k] = 0);
    let contributing = 0;
    for (const inst of PAIRS) {
      const slice = (cache[inst] || []).filter(c => c.ms <= t);
      if (slice.length < 51) continue;
      const closes = slice.map(c => c.close);
      const e20 = ema(closes, 20);
      const e50 = ema(closes, 50);
      const c   = closes[closes.length - 1];
      if (e20 == null || e50 == null) continue;
      const s = alignmentScore(c, e20, e50);
      contributing++;
      const [base, quote] = inst.split('_');
      agg[base]  += s;
      agg[quote] -= s;
    }
    if (contributing < PAIRS.length * 0.7) continue;
    const currencies = {};
    for (const k of CCYS) currencies[k] = agg[k] / 7;
    snapshots.push({ time: new Date(t).toISOString(), currencies });
  }
  return snapshots;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const tfIn = (req.query?.tf || 'm15').toUpperCase();
  if (!TF_STEP_MS[tfIn]) return res.status(400).json({ error: 'tf must be m5, m15, or h1' });

  const step = TF_STEP_MS[tfIn];
  let anchorMs;
  if (req.query?.anchor) {
    const t = new Date(req.query.anchor).getTime();
    if (isNaN(t)) return res.status(400).json({ error: 'invalid anchor' });
    anchorMs = Math.floor(t / step) * step;
  } else {
    // Snap to last complete boundary strictly before now.
    anchorMs = Math.floor(Date.now() / step) * step - step;
  }

  const t0 = Date.now();
  try {
    const sb = getClient();
    const snapshots = await buildSnapshots(sb, tfIn, anchorMs);
    if (snapshots.length < 5) {
      return res.status(200).json({
        anchor: new Date(anchorMs).toISOString(), tf: tfIn,
        error: 'Not enough snapshots (need 5 consecutive complete anchors)',
        snapshotsAvailable: snapshots.length,
      });
    }
    const cse = computeCSE(snapshots);
    res.json({
      anchor: new Date(anchorMs).toISOString(),
      tf: tfIn,
      duration_ms: Date.now() - t0,
      snapshots,
      cse,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 30;
