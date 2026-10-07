'use strict';

/**
 * Stage D — offline replay DATASET generator (research-only, no production touch).
 *
 * Produces an immutable, pre-frozen sequence of per-close classifier emissions for a
 * few fixtures, which the standalone viewer (research/ui/replay.html) renders. Every
 * frame is computed by `classify` as-of that candle's close, so by construction a frame
 * can contain NO later candle, NO later swing confirmation, and NO future-adjusted
 * threshold (calibration is a fixed, versioned constant). This script writes two files
 * and touches nothing under api/, sql/, or vercel.json. It is NOT a scheduled job.
 *
 *   node scripts/research/build-replay.js
 *     → research/ui/replay-data.js   (window.REPLAY_DATASETS = {...}; loaded by the view)
 *     → docs/research/replay/replay-data.json  (same payload, for tests/inspection)
 */

const fs = require('fs');
const path = require('path');
const { classify, STATES } = require('../../research/m15/classifier');
const { describeNetwork } = require('../../research/m15/strengthnet');
const { describePriceAction } = require('../../research/m15/priceaction');
const { PAIRS, CURRENCIES } = require('../../research/m15/strengthnet');

const M15 = 15 * 60 * 1000;
const toEat = (ms) => new Date(ms + 3 * 3600 * 1000).toISOString().replace('Z', '+03:00');

// ── fixture builders ──────────────────────────────────────────────────────────
function mkPair(tEnd, n, rTotal) {
  const d = n > 1 ? rTotal / (n - 1) : 0, s = tEnd - n * M15, out = [];
  for (let i = 0; i < n; i++) { const c = Math.exp(i * d), o = Math.exp((i === 0 ? 0 : i - 1) * d); out.push({ openMs: s + i * M15, open: o, high: Math.max(o, c) * 1.0002, low: Math.min(o, c) * 0.9998, close: c, volume: 100, complete: true, source: 'OANDA' }); }
  return out;
}
function seriesEndingAt(tEnd, closes, pad = 0.0004) {
  const n = closes.length, s = tEnd - n * M15, out = []; let pv = closes[0];
  for (let i = 0; i < n; i++) { const c = closes[i], o = i === 0 ? c : pv; out.push({ openMs: s + i * M15, open: o, high: +(Math.max(o, c) + pad).toFixed(6), low: +(Math.min(o, c) - pad).toFixed(6), close: +c.toFixed(6), volume: 100, complete: true, source: 'OANDA' }); pv = c; }
  return out;
}
const zs = (x) => { const m = CURRENCIES.reduce((s, c) => s + (x[c] || 0), 0) / 8, o = {}; for (const c of CURRENCIES) o[c] = (x[c] || 0) - m; return o; };
function network(tEnd, n, xTrue, overridePair, overrideCandles, dropPairs = []) {
  const X = zs(xTrue), H = {};
  for (const p of PAIRS) { if (dropPairs.includes(p)) continue; const [b, q] = p.split('_'); H[p] = mkPair(tEnd, n, X[b] - X[q]); }
  if (overridePair) H[overridePair] = overrideCandles;
  return H;
}

// ── per-close frame (enriched, as-of t) ────────────────────────────────────────
function buildFrame(pair, H, t, prevState, idx) {
  const net = describeNetwork(H, { asOfCloseMs: t });
  const pa = describePriceAction(H[pair] || [], { pair, asOfCloseMs: t });
  const r = classify(pair, H, { asOfCloseMs: t, prevState, network: net });

  // data-quality rule → UNAVAILABLE reasons (incomplete / unsynchronized / stale)
  const h24 = net.windows ? net.windows.h24 : null;
  const cov = h24 && h24.coverage ? h24.coverage : { pairsUsed: 0, pairsExpected: 28 };
  const lastOpen = t - M15;
  const staleBefore = (pa.integrity && pa.integrity.gaps || []).some((g) => g.toMs === lastOpen);
  const insufficient = !pa.state || pa.state.label === 'NO_DATA' || pa.state.label === 'INSUFFICIENT_DATA';
  let rule = 'OK', reason = null;
  if (insufficient) { rule = 'UNAVAILABLE'; reason = pa.state && pa.state.label === 'NO_DATA' ? 'NO_DATA' : 'INSUFFICIENT_DATA'; }
  else if (!h24 || !h24.available) { rule = 'UNAVAILABLE'; reason = `UNSYNCHRONIZED (${h24 ? h24.reason : 'NO_NETWORK'})`; }
  else if (cov.pairsUsed < cov.pairsExpected) { rule = 'UNAVAILABLE'; reason = `INCOMPLETE_COVERAGE (${cov.pairsUsed}/${cov.pairsExpected})`; }
  else if (staleBefore) { rule = 'UNAVAILABLE'; reason = 'STALE_DATA'; }

  const story = (w) => (w && w.descriptors ? { coveragePct: w.coveragePct, actual: w.actualCandles, efficiency: w.descriptors.directionalEfficiency, direction: w.descriptors.direction, range: w.descriptors.range, positionInRange: w.descriptors.positionInRange } : null);
  const sb = (h24 && h24.available) ? CURRENCIES.map((c) => ({ currency: c, x: h24.effects.byCurrency[c], rank: h24.effects.ranked.indexOf(c) + 1, breadth: h24.breadth[c] ? h24.breadth[c].fraction : 0 })).sort((a, b) => b.x - a.x) : null;
  const conf = (net.leaveOnePairOut && net.leaveOnePairOut.confirmations && net.leaveOnePairOut.confirmations[pair]) || null;

  return {
    i: idx, asOfCloseUtc: r.asOfCloseUtc, asOfCloseEat: r.asOfCloseEat, asOfCloseMs: t,
    displayState: rule === 'OK' ? r.primaryState : STATES.UNAVAILABLE, displayReason: reason,
    primaryState: r.primaryState, previousState: r.previousState,
    transition: r.transition,
    quality: { latestCloseUtc: r.asOfCloseUtc, latestCloseEat: r.asOfCloseEat, fresh: !staleBefore, staleBefore, pairsUsed: cov.pairsUsed, expected: cov.pairsExpected, synchronized: !!(h24 && h24.available && cov.pairsUsed === cov.pairsExpected), rule, reason },
    priceStories: { h12: story(pa.windows && pa.windows.h12), h24: story(pa.windows && pa.windows.h24), h36: story(pa.windows && pa.windows.h36), h48: story(pa.windows && pa.windows.h48) },
    compare12: pa.comparison ? { latestEff: pa.comparison.latest12.directionalEfficiency, previousEff: pa.comparison.previous12.directionalEfficiency, deltaEff: pa.comparison.deltaEfficiency, latestDir: pa.comparison.latest12.direction, previousDir: pa.comparison.previous12.direction } : null,
    strengthBoard: sb,
    confirmation: conf ? { full: conf.full ? conf.full.baseMinusQuote : null, leaveOut: conf.leaveOut ? conf.leaveOut.baseMinusQuote : null, independentlyConfirmed: conf.independentlyConfirmed, connected: conf.leaveOut ? conf.leaveOut.connected : null } : null,
    events: (pa.events || []).map((e) => ({ utc: new Date(e.ms).toISOString(), type: e.type, evidence: e.evidence })),
    structure: { acceptedHold: r.structure.acceptedHold, acceptedHoldDir: r.structure.acceptedHoldDir, confirmedPivots: r.structure.confirmedPivots, rejection: r.structure.rejection, provisionalLeg: r.structure.provisionalLeg },
    evidenceFor: r.evidenceFor, evidenceAgainst: r.evidenceAgainst,
    explanation: r.explanation,
    calibrationVersion: r.calibration.version,
  };
}

/** Step `classify` forward one completed candle at a time over the pair's closes. */
function buildDataset(pair, H, step = 1, startIndex = 0) {
  const cands = H[pair]; const frames = []; let prev = null;
  for (let i = startIndex; i < cands.length; i += step) {
    const t = cands[i].openMs + M15;
    const f = buildFrame(pair, H, t, prev, frames.length);
    frames.push(f); prev = f.primaryState;
  }
  return frames;
}

// ── fixtures ──────────────────────────────────────────────────────────────────
function eurgbpDescent(tEnd) { const cl = []; let p = 0.8600; for (let i = 0; i < 192; i++) { p -= 0.0006; if (i % 6 === 5) p += 0.0003; cl.push(p); } return seriesEndingAt(tEnd, cl); }
function gbpaudShock(tEnd) { const cl = []; let p = 1.9000; for (let i = 0; i < 64; i++) { p -= 0.0010; cl.push(p); } for (let i = 0; i < 64; i++) { p += 0.0010; cl.push(p); } for (let i = 0; i < 64; i++) { p -= 0.0010; cl.push(p); } return seriesEndingAt(tEnd, cl); }

function build() {
  const T = Date.UTC(2026, 8, 11, 0, 0, 0);
  const descentCandles = eurgbpDescent(T);
  const shockCandles = gbpaudShock(T);
  const descentH = network(T, 192, { GBP: 0.03, EUR: -0.03 }, 'EUR_GBP', descentCandles);
  const shockH = network(T, 192, {}, 'GBP_AUD', shockCandles);

  // Data-quality demonstration frames (one each: insufficient, incomplete, stale).
  const qT = Date.UTC(2026, 8, 12, 0, 0, 0);
  const qInsuf = buildFrame('EUR_USD', { EUR_USD: seriesEndingAt(qT, [1.10, 1.1003, 1.1006]) }, qT, null, 0);
  const incH = network(qT, 192, { EUR: 0.02, USD: -0.02 }, 'EUR_USD', mkPair(qT, 192, 0.02), ['AUD_NZD']);  // one pair dropped ⇒ 27/28
  const qIncomplete = buildFrame('EUR_USD', incH, qT, null, 1);
  // stale: viewed pair is otherwise well-covered but has a weekend-sized gap in the
  // candles IMMEDIATELY before its final close (drop 3 bars before the last).
  const staleFull = mkPair(qT, 192, 0.01);
  const staleCandles = staleFull.slice(0, 188).concat(staleFull.slice(191));
  const staleH = network(qT, 192, { EUR: 0.02, USD: -0.02 }, 'EUR_USD', staleCandles);
  const qStale = buildFrame('EUR_USD', staleH, qT, null, 2);

  const datasets = {
    descent: { label: 'Persistent descent (EUR/GBP-like)', pair: 'EUR_GBP', note: 'EUR weakness / GBP strength network — becomes accepted bearish after holding lower prices.', frames: buildDataset('EUR_GBP', descentH, 3) },
    shock: { label: 'Shock then recovery (GBP/AUD-like)', pair: 'GBP_AUD', note: 'Flat GBP/AUD network — sharp fall rejected (reversal up), late fall only emerging, never accepted.', frames: buildDataset('GBP_AUD', shockH, 2) },
    quality: { label: 'Data-quality demonstrations', pair: 'EUR_USD', note: 'Each frame shows an UNAVAILABLE reason: insufficient, incomplete coverage, stale data.', frames: [qInsuf, qIncomplete, qStale] },
  };

  const meta = { version: 'm15-replay-1.0.0', generatedFixtureCloseUtc: new Date(T).toISOString(), classifier: require('../../research/m15/classifier').CLASSIFIER_VERSION, calibration: require('../../research/m15/classifier').CALIBRATION.version, disclaimer: 'research classification — not a trade signal' };
  return { meta, datasets };
}

function writeOut(payload) {
  const uiDir = path.join(__dirname, '..', '..', 'research', 'ui');
  const docDir = path.join(__dirname, '..', '..', 'docs', 'research', 'replay');
  fs.mkdirSync(docDir, { recursive: true });
  const json = JSON.stringify(payload);
  fs.writeFileSync(path.join(uiDir, 'replay-data.js'), `/* generated by scripts/research/build-replay.js — do not edit */\nwindow.REPLAY_DATASETS = ${json};\n`);
  fs.writeFileSync(path.join(docDir, 'replay-data.json'), JSON.stringify(payload, null, 0));
}

if (require.main === module) {
  const payload = build();
  writeOut(payload);
  const d = payload.datasets;
  console.log(`replay built: descent ${d.descent.frames.length} frames, shock ${d.shock.frames.length} frames, quality ${d.quality.frames.length} frames`);
}

module.exports = { build, buildFrame, buildDataset, eurgbpDescent, gbpaudShock, network, mkPair, seriesEndingAt };
