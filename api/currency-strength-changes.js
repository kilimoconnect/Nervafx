'use strict';

/**
 * GET /api/currency-strength-changes?from=YYYY-MM-DD&to=YYYY-MM-DD[&severity=all|minor|major|massive]
 *
 * Walks the H1 EMA per-currency strength hour by hour and emits every hour
 * where at least one currency's regime flipped between STRONG / WEAK /
 * NEUTRAL. Same maths as /api/currency-strength-h1-ema-history for the
 * per-hour strengths; on top of that we snapshot each currency's regime
 * band and compare to the previous hour.
 *
 * Regime bands:
 *   STRONG  → strength ≥ +0.50
 *   WEAK    → strength ≤ -0.50
 *   NEUTRAL → -0.50 < strength < +0.50
 *
 * Severity of the hour:
 *   NONE     → 0 flips
 *   MINOR    → 1-2 currencies flipped
 *   MAJOR    → 3-6 currencies flipped
 *   MASSIVE  → 7-8 currencies flipped (full-market regime shift)
 *
 * Response:
 *   {
 *     from, to, hours, events, duration_sec,
 *     rows: [{
 *       time,
 *       severity: 'MINOR' | 'MAJOR' | 'MASSIVE',
 *       count,
 *       changes: [{ currency, from, to, prevValue, value }],
 *       currencies: { USD: -0.71, EUR: +0.14, ... }   // full hour snapshot
 *     }]
 *   }
 */

const { cors, getClient } = require('./_db');

const PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];
const CCYS = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'];

const STRONG = 0.50;
const WEAK   = -0.50;

function regime(v) {
  if (v >=  STRONG) return 'STRONG';
  if (v <=  WEAK)   return 'WEAK';
  return 'NEUTRAL';
}

function severityLabel(n) {
  if (n === 0)      return 'NONE';
  if (n <= 2)       return 'MINOR';
  if (n <= 6)       return 'MAJOR';
  return 'MASSIVE';
}

function makeEma(period) {
  const k = 2 / (period + 1);
  let seedBuf = [];
  let e = null;
  return function push(v) {
    if (e === null) {
      seedBuf.push(v);
      if (seedBuf.length === period) e = seedBuf.reduce((a, b) => a + b, 0) / period;
      return e;
    }
    e = v * k + e * (1 - k);
    return e;
  };
}

function alignmentScore(close, e20, e50) {
  if (close > e20 && e20 > e50)  return +1.0;
  if (close < e20 && e20 < e50)  return -1.0;
  if (close > e20 && e20 <= e50) return +0.5;
  if (close < e20 && e20 >= e50) return -0.5;
  return 0;
}

async function fetchAllH1(sb, inst, since, until) {
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('backtest_candles')
      .select('time, close')
      .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true)
      .gte('time', since).lte('time', until)
      .order('time', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all.push(...data.map(c => ({ ms: new Date(c.time).getTime(), close: parseFloat(c.close) })));
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const from = req.query?.from;
  const to   = req.query?.to;
  const sevFilter = (req.query?.severity || 'all').toLowerCase();
  if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' });

  const start = new Date(from + 'T00:00:00Z');
  let end     = new Date(to   + 'T23:00:00Z');
  if (isNaN(start) || isNaN(end)) return res.status(400).json({ error: 'invalid dates' });
  // Don't walk hours past 'now'.
  const nowH = Math.floor(Date.now() / 3600000) * 3600000 - 3600000;
  if (end.getTime() > nowH) end = new Date(nowH);

  const t0 = Date.now();
  const sb = getClient();

  const fetchSince = new Date(start.getTime() - 5 * 24 * 3600000).toISOString();
  const fetchUntil = new Date(end.getTime()   + 60 * 60000).toISOString();

  const candles = {};
  const errors  = [];
  for (let b = 0; b < PAIRS.length; b += 7) {
    const batch = PAIRS.slice(b, b + 7);
    await Promise.all(batch.map(async inst => {
      try { candles[inst] = await fetchAllH1(sb, inst, fetchSince, fetchUntil); }
      catch (e) { errors.push(`${inst}: ${e.message}`); candles[inst] = []; }
    }));
  }

  // Target hour boundaries in the requested window.
  const targetHours = [];
  // Include one hour BEFORE the requested start so we can seed prevRegime.
  const seedStart = start.getTime() - 3600000;
  for (let t = seedStart; t <= end.getTime(); t += 3600000) targetHours.push(t);
  const targetSet = new Set(targetHours);

  // Per-pair alignment score at each target hour, streamed through rolling EMAs.
  const pairScores = {};
  for (const inst of PAIRS) {
    const seq = candles[inst] || [];
    if (!seq.length) { pairScores[inst] = new Map(); continue; }
    const pushE20 = makeEma(20);
    const pushE50 = makeEma(50);
    const map = new Map();
    for (const c of seq) {
      const e20 = pushE20(c.close);
      const e50 = pushE50(c.close);
      if (e20 == null || e50 == null) continue;
      if (targetSet.has(c.ms)) map.set(c.ms, alignmentScore(c.close, e20, e50));
    }
    pairScores[inst] = map;
  }

  // Aggregate strengths per hour and detect regime flips.
  const rows = [];
  let prev = null; // { time, regimes: {USD: 'STRONG', ...}, values: {...} }
  for (const h of targetHours) {
    const d = new Date(h);
    const dow = d.getUTCDay();
    const hr  = d.getUTCHours();
    // Skip weekends the same way the history endpoint does.
    if (dow === 6) continue;
    if (dow === 0 && hr < 21) continue;

    const agg = {}; CCYS.forEach(k => agg[k] = 0);
    let contributing = 0;
    for (const inst of PAIRS) {
      const s = pairScores[inst].get(h);
      if (s === undefined) continue;
      contributing++;
      const [base, quote] = inst.split('_');
      agg[base]  += s;
      agg[quote] -= s;
    }
    if (contributing < PAIRS.length * 0.7) continue;

    const values = {};
    const regimes = {};
    for (const k of CCYS) {
      values[k]  = agg[k] / 7;
      regimes[k] = regime(values[k]);
    }

    if (prev) {
      const changes = [];
      for (const k of CCYS) {
        if (regimes[k] !== prev.regimes[k]) {
          changes.push({
            currency:  k,
            from:      prev.regimes[k],
            to:        regimes[k],
            prevValue: prev.values[k],
            value:     values[k],
          });
        }
      }
      const count = changes.length;
      const sev   = severityLabel(count);
      // Only emit hours inside the user's requested window (we included one
      // seed hour before start to prime prevRegime — skip that seed).
      if (h >= start.getTime() && count > 0) {
        const passFilter =
          sevFilter === 'all'     ||
          sevFilter === sev.toLowerCase() ||
          (sevFilter === 'major' && (sev === 'MAJOR' || sev === 'MASSIVE'));
        if (passFilter) {
          rows.push({
            time: d.toISOString(),
            severity: sev,
            count,
            changes,
            currencies: values,
          });
        }
      }
    }
    prev = { time: h, regimes, values };
  }

  res.json({
    from, to,
    thresholds: { STRONG, WEAK },
    severity: sevFilter,
    events: rows.length,
    duration_sec: Math.round((Date.now() - t0) / 100) / 10,
    errors: errors.slice(0, 5),
    rows,
  });
};

module.exports.maxDuration = 300;
