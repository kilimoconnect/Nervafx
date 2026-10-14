'use strict';

/**
 * M15 ANALYSIS LAYER — versioned, additive, descriptive (m15-analysis-1.0.0).
 *
 * Composes EXISTING causal features into a richer description of what is changing now,
 * how well price is progressing, where it sits structurally, and whether other-pair
 * currency evidence supports the move. It does NOT change the three patterns, the
 * classifier, or any frozen study — it is an explicitly versioned, parallel output.
 *
 * Completed M15 OHLC only. No smoothed candles, no indicators, no extra timeframes, no new
 * patterns, no signals, no probabilities. All thresholds are past-only and versioned.
 *
 * Reuse: priceaction.describeWindow (per-block metrics), priceaction.inBand (block slicing),
 * priceaction swings/balance/events, strengthnet.estimateWindow (per-block strength), and the
 * provided leave-one-pair-out network. Nothing here recomputes those primitives from scratch.
 */

const { describePriceAction, describeWindow, medAbsDelta, M15 } = require('./priceaction');
const { estimateWindow } = require('./strengthnet');

// candles whose CLOSE time ∈ (fromMs, toMs]  (close = openMs + M15)
const inBand = (C, fromMs, toMs) => C.filter((c) => { const cm = c.openMs + M15; return cm > fromMs && cm <= toMs; });

const ANALYSIS_VERSION = 'm15-analysis-1.0.0';
const HOUR = 60 * 60 * 1000;
const toUtc = (ms) => (ms == null ? null : new Date(ms).toISOString());

// Descriptive thresholds (NOT tuned to outcomes). efficiency ∈ [-1,1] = net displacement / total
// travel. 0.50 = at least half the travel was net progress (clearly directional); 0.25 and 0.70
// reuse the existing BALANCED cut in priceaction.classifyState (overlap ≥0.70 & |eff|<0.25).
const THRESHOLDS = Object.freeze({
  version: 'analysis-thresh-v1',
  effSustained: 0.50, effChop: 0.25, overlapCongested: 0.70,
  effMargin: 0.15,            // min |eff| change to call strengthen/weaken vs continue
  gapMin: 0.0003,             // min strength gap magnitude to call a currency direction (matches classifier)
  proximityScaleUnits: 1.0,   // "near" a reference = within 1 adaptive-scale unit
});

const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const digest = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex').slice(0, 12);

// ── 1. four CONSECUTIVE non-overlapping 12h blocks (computed directly from each block) ──
function buildBlocks(C, T) {
  const labels = ['0–12h', '12–24h', '24–36h', '36–48h'];
  const closedMarket = (ms) => { const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours(); if (day === 6) return true; if (day === 0 && h < 21) return true; if (day === 5 && h >= 21) return true; return false; };
  return labels.map((label, k) => {
    const toMs = T - k * 12 * HOUR, fromMs = toMs - 12 * HOUR;
    const w = inBand(C, fromMs, toMs);                  // candles whose close ∈ (fromMs, toMs]
    const nominal = 48;
    let openSlots = 0; for (let t = fromMs + M15; t <= toMs; t += M15) if (!closedMarket(t - M15)) openSlots++;
    const dw = w.length ? describeWindow(w) : null;
    const scale = w.length ? medAbsDelta(w.map((c) => c.close)) : 0;
    return {
      label, fromMs, toMs, fromUtc: toUtc(fromMs), toUtc: toUtc(toMs),
      nominalCandles: nominal, expectedOpenCandles: openSlots, actualCandles: w.length,
      coveragePct: +(100 * w.length / nominal).toFixed(1), openCoveragePct: openSlots ? +(100 * w.length / openSlots).toFixed(1) : null,
      boundaryPrices: { startClose: w.length ? w[0].close : null, endClose: w.length ? w[w.length - 1].close : null },
      available: !!dw, scale: +scale.toFixed(8), scaleAvailable: scale > 0,
      metrics: dw ? {
        displacement: dw.closeDisplacement, travel: dw.pathLength, efficiency: dw.directionalEfficiency,
        direction: dw.direction, range: dw.range, overlap: dw.overlapFraction, positionInRange: dw.positionInRange,
        netProgressScaleUnits: scale > 0 ? +(dw.closeDisplacement / scale).toFixed(2) : null,
      } : null,
    };
  });
}

function recentVsEarlier(blocks) {
  const b0 = blocks[0].metrics, earlier = blocks.slice(1).filter((b) => b.metrics).map((b) => b.metrics);
  if (!b0 || !earlier.length) return { verdict: 'unclear', detail: 'insufficient block coverage', evidence: { b0: !!b0, earlierBlocks: earlier.length } };
  const earlierDisp = earlier.reduce((s, m) => s + m.displacement, 0);
  const earlierAbsEff = earlier.reduce((s, m) => s + Math.abs(m.efficiency), 0) / earlier.length;
  const dNow = sgn(b0.displacement), dEarlier = sgn(earlierDisp);
  let verdict;
  if (dNow && dEarlier && dNow !== dEarlier) verdict = 'conflicts';
  else if (!dNow) verdict = 'unclear';
  else if (Math.abs(b0.efficiency) >= earlierAbsEff + THRESHOLDS.effMargin) verdict = 'strengthens';
  else if (Math.abs(b0.efficiency) <= earlierAbsEff - THRESHOLDS.effMargin) verdict = 'weakens';
  else verdict = 'continues';
  return { verdict, detail: `latest 12h ${b0.direction} eff ${b0.efficiency} vs earlier avg |eff| ${earlierAbsEff.toFixed(3)} (net earlier ${dEarlier > 0 ? 'UP' : dEarlier < 0 ? 'DOWN' : 'flat'})`, evidence: { latestEfficiency: b0.efficiency, latestDirection: b0.direction, earlierAvgAbsEfficiency: +earlierAbsEff.toFixed(3), earlierNetDisplacement: +earlierDisp.toFixed(8) } };
}

// ── 2. quality of price progress (reuse efficiency/overlap/range + balance events) ──
function progressQuality(pa, blocks) {
  const b0 = blocks[0].metrics; const evidence = [];
  if (!b0) return { label: 'unavailable', evidence: ['no latest-12h coverage'] };
  const absEff = Math.abs(b0.efficiency);
  const departures = (pa.balance && pa.balance.events || []).filter((e) => e.type === 'DEPARTURE_PROVISIONAL').length;
  const returns = (pa.balance && pa.balance.events || []).filter((e) => e.type === 'RETURN').length;
  let label = 'mixed';
  if (absEff >= THRESHOLDS.effSustained) { label = 'sustained_progress'; evidence.push(`latest-12h efficiency ${b0.efficiency} ≥ ${THRESHOLDS.effSustained}`); }
  else if (b0.overlap >= THRESHOLDS.overlapCongested && absEff < THRESHOLDS.effChop) { label = 'congestion'; evidence.push(`overlap ${b0.overlap} ≥ ${THRESHOLDS.overlapCongested} with |eff| ${absEff.toFixed(3)} < ${THRESHOLDS.effChop}`); }
  else if (absEff < THRESHOLDS.effChop) { label = 'back_and_forth'; evidence.push(`|eff| ${absEff.toFixed(3)} < ${THRESHOLDS.effChop} (travel ${b0.travel} vs displacement ${b0.displacement})`); }
  else { evidence.push(`|eff| ${absEff.toFixed(3)} between ${THRESHOLDS.effChop} and ${THRESHOLDS.effSustained}`); }
  if (departures >= 2 && returns >= 1) evidence.push(`repeated attempts: ${departures} departures / ${returns} returns in 48h (little added net progress)`);
  // pullback vs confirmed structure (reuse swings; no new pattern)
  const piv = pa.swings && pa.swings.pivots || []; const prov = pa.swings && pa.swings.provisional;
  if (prov && piv.length) { const lastPivot = piv[piv.length - 1]; const holds = lastPivot.type === 'LOW' ? prov.extremePrice >= lastPivot.price : prov.extremePrice <= lastPivot.price; evidence.push(`provisional ${prov.direction} leg ${holds ? 'preserves' : 'damages'} the last confirmed ${lastPivot.type} (${lastPivot.price})`); }
  return { label, evidence };
}

// ── 3. structural location (confirmed references vs lookback extrema) ──
function structuralLocation(pa) {
  const C = pa.integrity.candles; if (!C.length) return { references: [], scale: 0, scaleAvailable: false };
  const price = C[C.length - 1].close;
  const scale = medAbsDelta(C.map((c) => c.close));
  const refs = [];
  const add = (kind, confirmed, refPrice, knownSinceMs) => { if (refPrice == null) return; const dist = +(price - refPrice).toFixed(8); refs.push({ kind, confirmed, price: refPrice, distance: dist, distanceScaleUnits: scale > 0 ? +(dist / scale).toFixed(2) : null, knownSinceMs, knownSinceUtc: toUtc(knownSinceMs), near: scale > 0 ? Math.abs(dist) <= THRESHOLDS.proximityScaleUnits * scale : null }); };
  if (pa.balance && pa.balance.zone) { const z = pa.balance.zone; const formedMs = (pa.balance.events.find((e) => e.type === 'BALANCE_FORMED') || {}).ms || null; add('balance_high', true, z.high, formedMs); add('balance_low', true, z.low, formedMs); }
  const highs = (pa.swings && pa.swings.pivots || []).filter((p) => p.type === 'HIGH'); const lows = (pa.swings && pa.swings.pivots || []).filter((p) => p.type === 'LOW');
  if (highs.length) { const h = highs[highs.length - 1]; add('confirmed_swing_high', true, h.price, h.confirmedAtMs); }
  if (lows.length) { const l = lows[lows.length - 1]; add('confirmed_swing_low', true, l.price, l.confirmedAtMs); }
  if (pa.windows && pa.windows.h48 && pa.windows.h48.descriptors) { const d = pa.windows.h48.descriptors; add('lookback_high_48h', false, d.rangeHigh, pa.windows.h48.firstCloseMs); add('lookback_low_48h', false, d.rangeLow, pa.windows.h48.firstCloseMs); }
  return { price, scale: +scale.toFixed(8), scaleAvailable: scale > 0, references: refs, note: 'confirmed references (balance edges, swing pivots) are distinguished from simple lookback extrema; proximity is descriptive, not a guaranteed turning point' };
}

// ── 4. pace & deterioration ──
function pace(pa, blocks) {
  const perBlock = blocks.map((b) => ({ label: b.label, displacementPer12h: b.metrics ? b.metrics.displacement : null, travel: b.metrics ? b.metrics.travel : null, efficiency: b.metrics ? b.metrics.efficiency : null }));
  const C = pa.integrity.candles; const price = C.length ? C[C.length - 1].close : null; const T = pa.asOfCloseMs;
  // since the latest causal event: last confirmed swing pivot or last accepted departure
  let event = null, eventMs = null, eventPrice = null, confirmDelayCandles = null;
  const piv = pa.swings && pa.swings.pivots || [];
  if (piv.length) { const p = piv[piv.length - 1]; event = `confirmed ${p.type} pivot`; eventMs = p.confirmedAtMs; eventPrice = p.price; confirmDelayCandles = p.confirmLagCandles; }
  let since = null;
  if (eventMs != null && price != null) {
    const seg = C.filter((c) => c.openMs + M15 > eventMs);
    let travel = 0; for (let i = 1; i < seg.length; i++) travel += Math.abs(seg[i].close - seg[i - 1].close);
    const net = +(price - eventPrice).toFixed(8); const eff = travel > 0 ? +(net / travel).toFixed(4) : 0;
    since = { event, eventMs, eventUtc: toUtc(eventMs), confirmDelayCandles, elapsedHours: +((T - eventMs) / HOUR).toFixed(2), netProgress: net, travel: +travel.toFixed(8), efficiency: eff, note: 'measured from the candle AFTER the event became knowable (confirmation delay accounted for)' };
  }
  // deterioration: more travel but less net progress across equivalent 12h blocks
  const b0 = blocks[0].metrics, b1 = blocks[1].metrics;
  let deterioration = null;
  if (b0 && b1) { const moreTravel = b0.travel > b1.travel, lessProgress = Math.abs(b0.displacement) < Math.abs(b1.displacement); deterioration = { weakening: moreTravel && lessProgress, detail: moreTravel && lessProgress ? 'latest 12h travelled more but advanced less than the prior 12h — weakening progress / increasing congestion (not a guaranteed reversal)' : 'no clear travel-up/progress-down pattern between the last two 12h blocks' }; }
  return { perBlock, sinceEvent: since, deterioration };
}

// ── 5. currency-support breadth & change (reuse per-block strength + LOPO) ──
function currencySupport(pair, blockStrength, network) {
  if (!pair) return { available: false, reason: 'no pair' };
  const [bC, qC] = pair.split('_');
  const blk = (bs, c) => (bs && bs.available ? bs.effects.byCurrency[c] : null);
  const xBase = blockStrength.map((bs) => blk(bs, bC)); const xQuote = blockStrength.map((bs) => blk(bs, qC));
  const gap = blockStrength.map((bs, k) => (xBase[k] != null && xQuote[k] != null ? +(xBase[k] - xQuote[k]).toFixed(8) : null));
  if (gap[0] == null) return { available: false, reason: 'no synchronized strength for the latest block' };
  const brOf = (bs, c) => (bs && bs.breadth && bs.breadth[c] ? bs.breadth[c].fraction : null);
  const baseBreadthByBlock = blockStrength.map((bs) => brOf(bs, bC)), quoteBreadthByBlock = blockStrength.map((bs) => brOf(bs, qC));
  const baseBreadth = baseBreadthByBlock[0], quoteBreadth = quoteBreadthByBlock[0];
  // change: gap magnitude (strengthening/fading); breadth (broadening/narrowing), vs the earlier blocks
  const earlierGap = gap.slice(1).filter((g) => g != null); const earlierAvgGap = earlierGap.length ? earlierGap.reduce((s, g) => s + Math.abs(g), 0) / earlierGap.length : null;
  let change = 'unclear';
  if (earlierAvgGap != null) change = Math.abs(gap[0]) >= earlierAvgGap + THRESHOLDS.gapMin ? 'strengthening' : Math.abs(gap[0]) <= earlierAvgGap - THRESHOLDS.gapMin ? 'fading' : 'steady';
  const breadthTrend = (now, arr) => { const earlier = arr.slice(1).filter((x) => x != null); if (now == null || !earlier.length) return 'unclear'; const avg = earlier.reduce((s, x) => s + x, 0) / earlier.length; return now >= avg + 0.1 ? 'broadening' : now <= avg - 0.1 ? 'narrowing' : 'steady'; };
  // strong base AND strong quote but little net pair direction = two-way activity, not directional strength
  const bothActive = xBase[0] != null && xQuote[0] != null && Math.abs(xBase[0]) >= 2 * THRESHOLDS.gapMin && Math.abs(xQuote[0]) >= 2 * THRESHOLDS.gapMin;
  const netDirectionUnclear = Math.abs(gap[0]) < THRESHOLDS.gapMin;
  const conf = network && network.leaveOnePairOut && network.leaveOnePairOut.confirmations ? network.leaveOnePairOut.confirmations[pair] : null;
  return {
    available: true, base: bC, quote: qC,
    baseBehavior: { strengthByBlock: xBase, trend: trendOf(xBase), breadthFraction: baseBreadth, breadthTrend: breadthTrend(baseBreadth, baseBreadthByBlock) },
    quoteBehavior: { strengthByBlock: xQuote, trend: trendOf(xQuote), breadthFraction: quoteBreadth, breadthTrend: breadthTrend(quoteBreadth, quoteBreadthByBlock) },
    contribution: `pair ${bC}/${qC} direction follows strength(${bC}) − strength(${qC}); latest gap ${gap[0]} (${gap[0] > THRESHOLDS.gapMin ? bC + ' stronger ⇒ up' : gap[0] < -THRESHOLDS.gapMin ? qC + ' stronger ⇒ down' : 'level / unclear'})`,
    gapByBlock: gap, change,
    bothCurrenciesActive: bothActive, netDirectionUnclear: bothActive && netDirectionUnclear,
    otherPairConfirmation: conf ? { full: conf.full ? conf.full.baseMinusQuote : null, leaveOut: conf.leaveOut ? conf.leaveOut.baseMinusQuote : null, agrees: conf.independentlyConfirmed, note: 'leave-one-pair-out = OTHER-PAIR support, not statistical independence' } : null,
    note: 'net currency direction (gap) is separate from two-way activity; volatility is not read as directional strength, correlated pairs are not independent confirmations',
  };
}
function trendOf(xs) { const v = xs.filter((x) => x != null); if (v.length < 2) return 'unclear'; const d = v[0] - v[v.length - 1]; return Math.abs(d) < 0.0003 ? 'holding' : d > 0 ? 'strengthening' : 'fading'; }

// ── 6. deterministic template summary + strongest alternative + invalidation ──
function buildSummary(dir, blocks, rve, pq, loc, pc, cs) {
  const u = (x) => (x == null || x === '' ? 'unclear' : x);
  const structureDirection = dir ? `Broader structure: ${dir}.` : 'Broader structure: unclear.';
  const recentChange = `Recent change: latest 12h ${u(rve.verdict)} the earlier structure (${u(rve.detail)}).`;
  const progress = `Progress quality: ${u(pq.label)}${pq.evidence && pq.evidence.length ? ' (' + pq.evidence[0] + ')' : ''}.`;
  const nearest = (loc.references || []).filter((r) => r.near).map((r) => r.kind + (r.distanceScaleUnits != null ? ' ' + r.distanceScaleUnits + '×scale' : ''));
  const location = nearest.length ? `Location: near ${nearest.join(', ')}.` : 'Location: not near a known reference.';
  const support = cs.available ? `Currency support: ${u(cs.change)}; ${cs.contribution}. ${cs.otherPairConfirmation ? (cs.otherPairConfirmation.agrees ? 'Other-pair support agrees.' : 'Other-pair support disagrees.') : ''}` : 'Currency support: unavailable.';
  const determsg = pc.deterioration && pc.deterioration.weakening ? ' Note: weakening progress (more travel, less net advance).' : '';
  const alternative = rve.verdict === 'conflicts' ? 'Strongest alternative: the recent 12h is a counter-move within the earlier structure, not a change of structure.'
    : pq.label === 'congestion' || pq.label === 'back_and_forth' ? 'Strongest alternative: the move is stalling into a range rather than progressing.'
      : 'Strongest alternative: the current progress is a late-stage extension that could stall near the nearest reference.';
  const invRef = (loc.references || []).find((r) => r.confirmed && r.near) || (loc.references || []).find((r) => r.confirmed);
  const invalidationCondition = invRef ? `Assessment changes on a completed close through ${invRef.kind} (${invRef.price}) — a structural invalidation of this interpretation, NOT a trade stop.` : 'Assessment changes if a confirmed structural reference is broken on a completed close (interpretation invalidation, not a trade stop).';
  return { structureDirection, recentChange, progressQuality: progress + determsg, location, currencySupport: support, alternative, invalidationCondition };
}

/**
 * @param cands single-pair candles
 * @param opts { asOfCloseMs (req), pair, network (describeNetwork@T), histories (all-pair H) OR blockStrength (4×h12 estimates), pa }
 */
function analyze(cands, opts = {}) {
  const pair = opts.pair || null, network = opts.network || null;
  const pa = opts.pa || describePriceAction(cands, { pair, asOfCloseMs: opts.asOfCloseMs });
  const T = pa.asOfCloseMs;
  const base = { version: ANALYSIS_VERSION, thresholds: THRESHOLDS, pair, asOfCloseMs: T, asOfCloseUtc: pa.asOfCloseUtc };
  if (!pa.windows || pa.state.label === 'NO_DATA') return { ...base, available: false, reason: 'NO_DATA' };

  const C = pa.integrity.candles;
  const blocks = buildBlocks(C, T);
  const rve = recentVsEarlier(blocks);
  const pq = progressQuality(pa, blocks);
  const loc = structuralLocation(pa);
  const pc = pace(pa, blocks);

  // per-block strength: reuse the provided estimates, else compute from all-pair histories (both optional)
  let blockStrength = opts.blockStrength || null;
  if (!blockStrength && opts.histories) { blockStrength = [0, 1, 2, 3].map((k) => { try { return estimateWindow(opts.histories, { windowHours: 12, asOfCloseMs: T - k * 12 * HOUR }); } catch (e) { return null; } }); }
  if (!blockStrength) blockStrength = [network && network.windows ? network.windows.h12 : null, null, null, null];
  const cs = currencySupport(pair, blockStrength, network);

  // broader structural direction from the latest confirmed swing structure (reuse pivots)
  const highs = (pa.swings && pa.swings.pivots || []).filter((p) => p.type === 'HIGH'); const lows = (pa.swings && pa.swings.pivots || []).filter((p) => p.type === 'LOW');
  const hh = highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price;
  const ll = lows.length >= 2 && lows[lows.length - 1].price < lows[lows.length - 2].price;
  const structureDirection = hh && !ll ? 'UP' : ll && !hh ? 'DOWN' : null;

  const summary = buildSummary(structureDirection, blocks, rve, pq, loc, pc, cs);

  // reproducibility audit (what inputs/config actually produced this)
  const otherPairDigest = opts.histories ? digest(Object.keys(opts.histories).sort().map((p) => { const a = opts.histories[p]; const last = a && a[a.length - 1]; return p + ':' + (last ? last.openMs + '/' + last.close : ''); }).join('|')) : null;
  const reproduce = {
    inputDigest: digest(C.map((c) => c.openMs + ':' + c.open + ',' + c.high + ',' + c.low + ',' + c.close).join('|')),   // ALL OHLC fields of the pair
    otherPairInputsDigest: otherPairDigest, otherPairInputsCovered: !!otherPairDigest,
    configDigest: digest(JSON.stringify(THRESHOLDS)),
    versions: { analysis: ANALYSIS_VERSION, priceaction: pa.version, thresholds: THRESHOLDS.version },
    storageLimitation: otherPairDigest ? 'other-pair inputs hashed, not snapshotted' : 'other-pair inputs NOT covered by this digest (strength passed in pre-computed); a full audit needs the all-pair histories',
  };

  return { ...base, available: true, structureDirection, blocks, recentVsEarlier: rve, progressQuality: pq, structuralLocation: loc, pace: pc, currencySupport: cs, summary, reproduce, dataHealth: { eligible: pa.integrity.eligible, gaps: pa.integrity.gaps } };
}

module.exports = { ANALYSIS_VERSION, THRESHOLDS, analyze, buildBlocks, recentVsEarlier };
