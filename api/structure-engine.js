'use strict';

/**
 * GET /api/structure-engine
 *
 * Hourly Structure Engine — per-pair market structure analysis.
 * Layers implemented (live, from candle data):
 *   2  H1 Market Structure (swings, HH/HL/LH/LL trend, BOS, CHoCH, trend validation)
 *   3  Key Level Intelligence (scored levels, nearest S/R, invalidation)
 *   4  Market State (compression / expansion / trend / exhaustion / choppy …)
 *   5  H1 Structure Score
 *   6  Currency Structure (aggregated per currency)
 *   7  M15 Market Quality (entry timing)
 *   8  Trade Approval
 *
 * Layers 9-11 (historical storage, reviews, forecast) require dedicated
 * tables + accumulated history and are a follow-up phase.
 */

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');
const { computeQuality: m15PageQuality } = require('./m15-quality');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const INSTRUMENTS = [
  'EUR_USD', 'GBP_USD', 'AUD_USD', 'NZD_USD',
  'USD_JPY', 'USD_CHF', 'USD_CAD',
  'EUR_GBP', 'EUR_JPY', 'EUR_CHF', 'EUR_CAD', 'EUR_AUD', 'EUR_NZD',
  'GBP_JPY', 'GBP_CHF', 'GBP_CAD', 'GBP_AUD', 'GBP_NZD',
  'AUD_JPY', 'AUD_CHF', 'AUD_CAD', 'AUD_NZD',
  'NZD_JPY', 'NZD_CHF', 'NZD_CAD',
  'CAD_JPY', 'CAD_CHF',
  'CHF_JPY',
];

// ─── Helpers ────────────────────────────────────────────────────────────────

const body = c => Math.abs(c.close - c.open);
const sign = c => c.close > c.open ? 1 : c.close < c.open ? -1 : 0;

// Fractal swing detection: pivot high/low with `k` candles on each side
function detectSwings(candles, k = 2) {
  const highs = [], lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= k; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low  >= candles[i - j].low  || candles[i].low  >= candles[i + j].low)  isLow = false;
    }
    if (isHigh) highs.push({ idx: i, price: candles[i].high, time: candles[i].time });
    if (isLow)  lows.push({ idx: i, price: candles[i].low,  time: candles[i].time });
  }
  return { highs, lows };
}

// Layer 2B — structural trend from last swings
function classifyTrend(highs, lows) {
  const hh = highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price;
  const lh = highs.length >= 2 && highs[highs.length - 1].price < highs[highs.length - 2].price;
  const hl = lows.length  >= 2 && lows[lows.length - 1].price  > lows[lows.length - 2].price;
  const ll = lows.length  >= 2 && lows[lows.length - 1].price  < lows[lows.length - 2].price;

  let trend;
  if (hh && hl) trend = 'BULLISH';
  else if (lh && ll) trend = 'BEARISH';
  else if ((hh && ll) || (lh && hl)) trend = 'TRANSITION';
  else trend = 'RANGE';
  return { trend, hh, hl, lh, ll };
}

// Layer 2C/2D — BOS + CHoCH from latest close vs most recent swings
function detectBOS(candles, highs, lows, trend) {
  const last = candles[candles.length - 1];
  const lastHigh = highs.length ? highs[highs.length - 1] : null;
  const lastLow  = lows.length  ? lows[lows.length - 1]  : null;

  let bos = null; // { direction, level, time }
  if (lastHigh && last.close > lastHigh.price) {
    bos = { direction: 'BULLISH', level: lastHigh.price };
  } else if (lastLow && last.close < lastLow.price) {
    bos = { direction: 'BEARISH', level: lastLow.price };
  }

  // CHoCH: BOS opposing the prevailing trend = change of character
  let choch = null;
  if (bos) {
    if (trend === 'BEARISH' && bos.direction === 'BULLISH') choch = 'BULLISH';
    else if (trend === 'BULLISH' && bos.direction === 'BEARISH') choch = 'BEARISH';
  }
  return { bos, choch };
}

// Layer 2E — trend validation: is the protected swing still intact?
function validateTrend(candles, highs, lows, trend) {
  const last = candles[candles.length - 1];
  if (trend === 'BULLISH') {
    const hl = lows.length ? lows[lows.length - 1] : null;
    if (!hl) return 'WEAKENING';
    if (last.close < hl.price) return 'BROKEN';
    // weakening if price is hovering within the lower third toward the HL
    return 'VALID';
  }
  if (trend === 'BEARISH') {
    const lh = highs.length ? highs[highs.length - 1] : null;
    if (!lh) return 'WEAKENING';
    if (last.close > lh.price) return 'BROKEN';
    return 'VALID';
  }
  return 'WEAKENING';
}

// Layer 3 — cluster swing points into scored levels
function buildLevels(candles, highs, lows) {
  const last = candles[candles.length - 1];
  const atr = avgRange(candles.slice(-50));
  const tol = atr * 0.6; // cluster tolerance

  const raw = [
    ...highs.map(h => ({ price: h.price, idx: h.idx, kind: 'R' })),
    ...lows.map(l  => ({ price: l.price, idx: l.idx, kind: 'S' })),
  ];

  const clusters = [];
  for (const pt of raw) {
    let c = clusters.find(cl => Math.abs(cl.price - pt.price) <= tol);
    if (!c) { c = { price: pt.price, touches: [], lastIdx: 0 }; clusters.push(c); }
    c.touches.push(pt);
    c.price = c.touches.reduce((s, t) => s + t.price, 0) / c.touches.length;
    c.lastIdx = Math.max(c.lastIdx, pt.idx);
  }

  const n = candles.length;
  for (const c of clusters) {
    const reactions = c.touches.length;
    // reaction size: avg move away from level after each touch
    let sizeSum = 0;
    for (const t of c.touches) {
      const after = candles.slice(t.idx, Math.min(n, t.idx + 6));
      const mv = after.length ? Math.max(...after.map(x => Math.abs(x.close - c.price))) : 0;
      sizeSum += mv;
    }
    const reactionSize = atr > 0 ? Math.min(100, (sizeSum / c.touches.length / atr) * 50) : 0;
    const recency = Math.max(0, 100 - ((n - 1 - c.lastIdx) / n) * 100);
    const cleanness = Math.min(100, reactions > 1 ? 70 + reactions * 5 : 50);
    c.score = Math.round(
      0.40 * Math.min(100, reactions * 25) +
      0.25 * reactionSize +
      0.20 * recency +
      0.15 * cleanness
    );
    c.reactions = reactions;
  }

  clusters.sort((a, b) => b.score - a.score);

  const resistances = clusters.filter(c => c.price > last.close).sort((a, b) => a.price - b.price);
  const supports    = clusters.filter(c => c.price < last.close).sort((a, b) => b.price - a.price);

  return {
    levels: clusters,
    resistances, supports,
    nearestResistance: resistances[0] || null,
    nearestSupport: supports[0] || null,
  };
}

function levelStrength(score) {
  return score >= 75 ? 'HIGH' : score >= 55 ? 'MEDIUM' : 'LOW';
}

function avgRange(candles) {
  if (!candles.length) return 0;
  return candles.reduce((s, c) => s + (c.high - c.low), 0) / candles.length;
}

// Directional efficiency / persistence / expansion over a window
function flowMetrics(candles) {
  const c = candles;
  const n = c.length;
  if (n < 2) return { efficiency: 0, persistence: 0, expansion: 50, netMove: 0 };
  const net = Math.abs(c[n - 1].close - c[0].open);
  const totalBody = c.reduce((s, x) => s + body(x), 0);
  const efficiency = totalBody > 0 ? Math.min(100, (net / totalBody) * 100) : 0;

  let switches = 0, lastSign = 0;
  for (const x of c) {
    const s = sign(x);
    if (s === 0) continue;
    if (lastSign !== 0 && s !== lastSign) switches++;
    lastSign = s;
  }
  const persistence = Math.max(0, (1 - switches / (n - 1)) * 100);

  const half = Math.floor(n / 2);
  const recentR = avgRange(c.slice(half));
  const prevR = avgRange(c.slice(0, half));
  const expansion = prevR > 0 ? Math.max(0, Math.min(100, 50 * (recentR / prevR))) : 50;

  return { efficiency, persistence, expansion, netMove: net };
}

// Layer 4 — market state
function marketState(metrics, trendInfo, bos) {
  const { efficiency, persistence, expansion } = metrics;
  if (expansion < 35 && persistence < 50) return 'COMPRESSION';
  if (expansion < 45 && persistence >= 50) return 'ACCUMULATION';
  if (bos && expansion >= 60) return 'EXPANSION';
  if (efficiency >= 60 && persistence >= 60) return expansion < 45 ? 'LATE_TREND' : 'TREND';
  if (efficiency >= 50 && expansion < 40) return 'EXHAUSTION';
  if (trendInfo.trend === 'TRANSITION') return 'REVERSAL_RISK';
  if (efficiency < 35) return 'CHOPPY';
  return 'TREND';
}

// Layer 7 — M15 quality. Score + direction use the exact same model as the
// /m15-quality page (via its computeQuality); state is derived for entry timing.
function m15Quality(candles) {
  if (candles.length < 10) return null;
  const c = candles.slice(-10);
  const pq = m15PageQuality(c);
  if (!pq) return null;

  // Persistence / efficiency / expansion for the Layer-7 state
  let switches = 0, lastSign = 0;
  for (const x of c) { const s = sign(x); if (s === 0) continue; if (lastSign !== 0 && s !== lastSign) switches++; lastSign = s; }
  const persistence = Math.max(0, (1 - switches / 9) * 100);

  const net = Math.abs(c[9].close - c[0].open);
  const totalBody = c.reduce((s, x) => s + body(x), 0);
  const efficiency = totalBody > 0 ? Math.min(100, (net / totalBody) * 100) : 0;

  const recentR = avgRange(c.slice(5));
  const prevR = avgRange(c.slice(0, 5));
  const expansion = prevR > 0 ? Math.max(0, Math.min(100, 50 * (recentR / prevR))) : 50;

  const score = pq.quality;
  let state;
  if (score < 30) state = 'DEAD';
  else if (expansion < 40 && persistence < 50) state = 'COMPRESSION';
  else if (pq.entryValid || (efficiency >= 55 && persistence >= 55)) state = 'TREND';
  else if (expansion >= 60) state = 'EXPANSION';
  else state = 'EXHAUSTION';

  return { score, state, direction: pq.direction };
}

// Layer 5 — H1 structure score
function structureScore(parts) {
  const { keyLevelRespect, swingStructure, bosQuality, efficiency, pullback, expansion } = parts;
  const score = Math.round(
    0.25 * keyLevelRespect +
    0.20 * swingStructure +
    0.20 * bosQuality +
    0.15 * efficiency +
    0.10 * pullback +
    0.10 * expansion
  );
  let label;
  if (score >= 85) label = 'INSTITUTIONAL';
  else if (score >= 70) label = 'STRONG';
  else if (score >= 55) label = 'TRADEABLE';
  else if (score >= 40) label = 'WEAK';
  else label = 'CHOPPY';
  return { score, label };
}

function analysePair(h1, m15) {
  if (h1.length < 60) return null;
  const last = h1[h1.length - 1];

  const { highs, lows } = detectSwings(h1, 2);
  const trendInfo = classifyTrend(highs, lows);
  const { bos, choch } = detectBOS(h1, highs, lows, trendInfo.trend);
  const trendValid = validateTrend(h1, highs, lows, trendInfo.trend);
  const { nearestSupport, nearestResistance, supports, resistances } = buildLevels(h1, highs, lows);

  const trend50 = flowMetrics(h1.slice(-50));   // active momentum
  const trend200 = flowMetrics(h1.slice(-200)); // current trend
  const state = marketState(trend50, trendInfo, bos);

  // Pullback quality over last 50
  const c50 = h1.slice(-50);
  const trendSign = c50[c50.length - 1].close >= c50[0].open ? 1 : -1;
  let tB = 0, cB = 0;
  for (const x of c50) { const s = sign(x); if (s === trendSign) tB += body(x); else if (s === -trendSign) cB += body(x); }
  const pullbackQ = (tB + cB) > 0 ? (1 - cB / (tB + cB)) * 100 : 50;

  // Structure score parts
  const swingStructure = trendInfo.trend === 'BULLISH' || trendInfo.trend === 'BEARISH' ? 85
    : trendInfo.trend === 'TRANSITION' ? 50 : 35;
  const bosQuality = bos ? (choch ? 90 : 75) : 45;
  const keyLevelRespect = trendValid === 'VALID' ? 85 : trendValid === 'WEAKENING' ? 55 : 30;
  const { score: structScore, label: structLabel } = structureScore({
    keyLevelRespect, swingStructure, bosQuality,
    efficiency: trend50.efficiency, pullback: pullbackQ, expansion: trend50.expansion,
  });

  const mq = m15Quality(m15);

  // Invalidation level: the protected swing
  let invalidation = null;
  if (trendInfo.trend === 'BULLISH' && lows.length) invalidation = lows[lows.length - 1].price;
  else if (trendInfo.trend === 'BEARISH' && highs.length) invalidation = highs[highs.length - 1].price;

  // Trend Health — composite of persistence, directional efficiency, pullback quality
  const trendHealth = Math.round(0.40 * trend50.persistence + 0.35 * trend50.efficiency + 0.25 * pullbackQ);

  // Major swings (most recent confirmed)
  const swingHigh = highs.length ? highs[highs.length - 1].price : null;
  const swingLow  = lows.length  ? lows[lows.length - 1].price  : null;

  // BOS age: how many H1 candles since the close first broke the level
  let bosAge = null;
  if (bos) {
    let a = 0;
    for (let i = h1.length - 1; i >= 0; i--) {
      const broke = bos.direction === 'BULLISH' ? h1[i].close > bos.level : h1[i].close < bos.level;
      if (broke) a++; else break;
    }
    bosAge = a;
  }

  // Next target — second level in the trend direction (or projected)
  const atr = avgRange(h1.slice(-50));
  let nextTarget = null;
  if (trendInfo.trend === 'BEARISH') nextTarget = supports[1]?.price ?? (nearestSupport ? nearestSupport.price - atr * 2 : null);
  else if (trendInfo.trend === 'BULLISH') nextTarget = resistances[1]?.price ?? (nearestResistance ? nearestResistance.price + atr * 2 : null);

  const mkLevel = l => l ? { price: l.price, score: l.score, touches: l.reactions, strength: levelStrength(l.score) } : null;

  return {
    trend: trendInfo.trend,
    hh: trendInfo.hh, hl: trendInfo.hl, lh: trendInfo.lh, ll: trendInfo.ll,
    bos: bos ? { ...bos, ageHours: bosAge } : null,
    choch, trendValid,
    state,
    structureScore: structScore,
    structureLabel: structLabel,
    efficiency: Math.round(trend50.efficiency),
    persistence: Math.round(trend50.persistence),
    expansion: Math.round(trend50.expansion),
    pullbackQuality: Math.round(pullbackQ),
    trendHealth,
    swingHigh, swingLow,
    nextTarget,
    price: last.close,
    nearestSupport: mkLevel(nearestSupport),
    nearestResistance: mkLevel(nearestResistance),
    invalidation,
    m15: mq,
  };
}

// Layer 6 — currency structure aggregation
function aggregateCurrencies(pairResults) {
  const agg = {};
  for (const ccy of CURRENCIES) agg[ccy] = { scores: [], bull: 0, bear: 0 };
  for (const [inst, r] of Object.entries(pairResults)) {
    if (!r) continue;
    const [base, quote] = inst.split('_');
    const bullish = r.trend === 'BULLISH';
    const bearish = r.trend === 'BEARISH';
    // base benefits from a bullish pair, quote from a bearish pair
    agg[base].scores.push(r.structureScore);
    agg[quote].scores.push(r.structureScore);
    if (bullish) { agg[base].bull++; agg[quote].bear++; }
    else if (bearish) { agg[base].bear++; agg[quote].bull++; }
  }
  const out = {};
  for (const ccy of CURRENCIES) {
    const a = agg[ccy];
    const avg = a.scores.length ? Math.round(a.scores.reduce((s, x) => s + x, 0) / a.scores.length) : 0;
    const net = a.bull - a.bear;
    let label;
    if (net >= 3 && avg >= 60) label = 'STRONG';
    else if (net <= -3 && avg >= 60) label = 'WEAK';
    else if (net >= 2) label = 'IMPROVING';
    else if (net <= -2) label = 'DETERIORATING';
    else label = 'NEUTRAL';
    out[ccy] = { avgStructure: avg, net, bull: a.bull, bear: a.bear, label };
  }
  return out;
}

// Layer 8 — trade approval
function tradeApproval(r, ccy, inst) {
  if (!r || !r.m15) return { approved: false, reasons: ['no data'] };
  const [base, quote] = inst.split('_');
  const reasons = [];

  if (r.structureScore <= 70) reasons.push('structure ≤ 70');
  if (r.trendValid !== 'VALID') reasons.push('trend not valid');
  if (!(r.m15.state === 'EXPANSION' || r.m15.state === 'TREND')) reasons.push('M15 not expansion/trend');

  // not trading directly into a strong opposing major level
  if (r.trend === 'BULLISH' && r.nearestResistance && r.nearestResistance.score >= 70) reasons.push('into resistance');
  if (r.trend === 'BEARISH' && r.nearestSupport && r.nearestSupport.score >= 70) reasons.push('into support');

  // currency alignment: base strong vs quote weak (bullish) or vice versa
  const bL = ccy[base]?.label, qL = ccy[quote]?.label;
  const bullAlign = (bL === 'STRONG' || bL === 'IMPROVING') && (qL === 'WEAK' || qL === 'DETERIORATING');
  const bearAlign = (qL === 'STRONG' || qL === 'IMPROVING') && (bL === 'WEAK' || bL === 'DETERIORATING');
  if (r.trend === 'BULLISH' && !bullAlign) reasons.push('currency not aligned');
  if (r.trend === 'BEARISH' && !bearAlign) reasons.push('currency not aligned');

  return { approved: reasons.length === 0, reasons };
}

// Layer 1 — data engine + full per-pair analysis. Reused by the API handler,
// the hourly storage job, and the history endpoint.
async function computeStructure(sb) {
  const h1ByInst = {}, m15ByInst = {};
  for (let b = 0; b < INSTRUMENTS.length; b += 7) {
    const batch = INSTRUMENTS.slice(b, b + 7);
    const results = await Promise.all(batch.map(async (inst) => {
      const [h1, m15] = await Promise.all([
        sb.from('backtest_candles').select('time, open, high, low, close')
          .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true)
          .order('time', { ascending: false }).limit(500),
        sb.from('backtest_candles').select('time, open, high, low, close')
          .eq('instrument', inst).eq('timeframe', 'M15').eq('complete', true)
          .order('time', { ascending: false }).limit(40),
      ]);
      return { inst, h1: h1.data || [], m15: m15.data || [] };
    }));
    for (const { inst, h1, m15 } of results) {
      const map = c => ({ time: c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close });
      h1ByInst[inst] = h1.map(map).reverse();   // ascending
      m15ByInst[inst] = m15.map(map).reverse();
    }
  }

  const pairs = {};
  for (const inst of INSTRUMENTS) {
    pairs[inst] = analysePair(h1ByInst[inst] || [], m15ByInst[inst] || []);
  }

  const currencies = aggregateCurrencies(pairs);

  const out = [];
  for (const inst of INSTRUMENTS) {
    const r = pairs[inst];
    if (!r) continue;
    const approval = tradeApproval(r, currencies, inst);
    out.push({ instrument: inst, ...r, approval });
  }
  out.sort((a, b) => b.structureScore - a.structureScore);

  return {
    generatedAt: new Date().toISOString(),
    pairs: out,
    currencies,
    approvedCount: out.filter(p => p.approval.approved).length,
  };
}

async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const data = await computeStructure(sb);
    res.json(data);
  } catch (e) {
    console.error('[STRUCTURE-ENGINE]', e.message);
    res.status(500).json({ error: e.message });
  }
}

module.exports = handler;
module.exports.computeStructure = computeStructure;
module.exports.analysePair = analysePair;
module.exports.m15Quality = m15Quality;
module.exports.aggregateCurrencies = aggregateCurrencies;
module.exports.tradeApproval = tradeApproval;
module.exports.INSTRUMENTS = INSTRUMENTS;
module.exports.CURRENCIES = CURRENCIES;
module.exports.maxDuration = 90;
