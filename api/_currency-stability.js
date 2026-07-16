'use strict';

/**
 * Shared Currency Stability Engine (CSE) maths.
 *
 * Consumers pass an ORDERED array of the last 5 per-currency strength
 * snapshots (oldest → newest), each shaped:
 *
 *   { time, currencies: { USD: -0.71, EUR: +0.14, ..., NZD: +0.86 } }
 *
 * Every strength value is expected to sit in [-1, +1] — same scale the
 * H1/M15/M5 EMA strength endpoints emit.
 */

const CCYS = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'];
const PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function std(arr) {
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / arr.length;
  return Math.sqrt(v);
}

// Per-currency stats over the last N (usually 5) readings.
function currencyStats(readings) {
  const n = readings.length;
  const AS = mean(readings);
  const sig = AS > 0 ? +1 : (AS < 0 ? -1 : 0);
  // MaxRange for the [-1, +1] scale is 2; Stability = 1 - σ / 2 → in [0, 1].
  const stability = Math.max(0, 1 - std(readings) / 2);
  let dc = 0;
  if (sig > 0)      dc = readings.filter(v => v >  0.5).length / n;
  else if (sig < 0) dc = readings.filter(v => v < -0.5).length / n;
  // Composite CSS in [-1, +1]. Stability + DC magnitudes carry the sign of AS
  // so a strong currency scores positive, a weak one scores negative.
  const css = 0.5 * AS + sig * (0.3 * stability + 0.2 * dc);
  return { AS, sig, stability, dc, css };
}

// Leader rule: for at least 4 of the last N snapshots, the currency was
// among the top-2 strengths (for STRONG) or the bottom-2 (for WEAK).
function computeLeaders(snapshots) {
  const n = snapshots.length;
  const topCounts = {}; CCYS.forEach(k => topCounts[k] = 0);
  const botCounts = {}; CCYS.forEach(k => botCounts[k] = 0);
  for (const s of snapshots) {
    const ranked = CCYS.slice().sort((a, b) => s.currencies[b] - s.currencies[a]);
    // ranked[0], ranked[1] = top 2 strongest; ranked[-1], ranked[-2] = weakest.
    topCounts[ranked[0]]++;
    topCounts[ranked[1]]++;
    botCounts[ranked[ranked.length - 1]]++;
    botCounts[ranked[ranked.length - 2]]++;
  }
  const threshold = Math.ceil(n * 0.8); // 4/5
  const strongLeaders = CCYS.filter(k => topCounts[k] >= threshold);
  const weakLeaders   = CCYS.filter(k => botCounts[k] >= threshold);
  return { strongLeaders, weakLeaders, topCounts, botCounts };
}

// Compute CSE at a single anchor from the last 5 snapshots (oldest → newest).
// Returns { currencies:{...css, sig, stats}, pairs:[{pair, score, direction}],
//           leaders:{strong, weak}, latestSnapshot }.
function computeCSE(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 5) return null;
  const window = snapshots.slice(-5);

  const perCcy = {};
  for (const ccy of CCYS) {
    const readings = window.map(s => s.currencies[ccy] ?? 0);
    perCcy[ccy] = currencyStats(readings);
  }
  const { strongLeaders, weakLeaders, topCounts, botCounts } = computeLeaders(window);

  // Pair candidates: base must be in strong leaders, quote in weak leaders
  // (for BUY) or vice versa (for SELL).
  const pairs = [];
  for (const inst of PAIRS) {
    const [base, quote] = inst.split('_');
    const bCSS = perCcy[base].css;
    const qCSS = perCcy[quote].css;
    const rawScore = bCSS - qCSS;

    let direction = null;
    if (strongLeaders.includes(base) && weakLeaders.includes(quote))       direction = 'BUY';
    else if (weakLeaders.includes(base) && strongLeaders.includes(quote))  direction = 'SELL';

    pairs.push({
      pair: inst.replace('_', '/'),
      instrument: inst,
      score:  rawScore,             // signed, roughly [-2, +2]
      score100: Math.round(rawScore * 50), // scaled to ~[-100, +100]
      direction,                     // null if no leader alignment
      base:  { code: base,  css: bCSS, sig: perCcy[base].sig,
               isStrongLeader: strongLeaders.includes(base),
               isWeakLeader:   weakLeaders.includes(base) },
      quote: { code: quote, css: qCSS, sig: perCcy[quote].sig,
               isStrongLeader: strongLeaders.includes(quote),
               isWeakLeader:   weakLeaders.includes(quote) },
    });
  }

  // Sort by qualified-first (direction!=null), then by |score| desc.
  pairs.sort((a, b) => {
    if (!!a.direction !== !!b.direction) return a.direction ? -1 : 1;
    return Math.abs(b.score) - Math.abs(a.score);
  });

  return {
    windowSize: window.length,
    windowStart: window[0].time,
    windowEnd:   window[window.length - 1].time,
    currencies: perCcy,
    leaders: { strong: strongLeaders, weak: weakLeaders, topCounts, botCounts },
    pairs,
  };
}

module.exports = { CCYS, PAIRS, currencyStats, computeLeaders, computeCSE };
