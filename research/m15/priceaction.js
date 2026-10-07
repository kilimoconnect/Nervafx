'use strict';

/**
 * M15 Research — single-pair price-action DESCRIPTOR (Stage A, pure/deterministic).
 *
 * Reads CLOSED M15 OHLC candles for ONE pair and emits a strictly-causal
 * description of how price behaved, as-of an evaluation close T. It creates NO
 * trade entries, NO signals, NO profitability claims — only observations.
 *
 * Isolation: imports nothing from api/_m15 (the production engine) and never
 * touches a database. Input is an ascending array of research-shape candles
 * ({ openMs, open, high, low, close, volume?, complete?, source? }). The caller
 * may pass more history than one window needs; this module re-filters to the
 * candles that had CLOSED by T (open + 15m <= T) so it can never look ahead.
 *
 * Causality rules obeyed throughout (each labelled where enforced):
 *   (C1) No candle with close > T is ever read.
 *   (C2) No label at bar i uses any candle after i.
 *   (C3) Intrabar order is NEVER inferred — we never assume the high or the low
 *        came first within a bar; wick-based facts use only the close vs extreme.
 *   (C4) A swing pivot enters the known state at its CONFIRMATION close, never
 *        backdated to the extreme; both times are reported.
 *   (C5) Weekend/holiday gaps are reported as missing coverage, never fabricated
 *        or treated as continuous observations.
 */

const M15 = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const PRICEACTION_VERSION = 'm15-pa-1.0.0';
// Swing/zone calibration is versioned SEPARATELY so sensitivity can be inspected
// without ever re-selecting the threshold from downstream profit (there is none).
const THRESHOLD_VERSION = 'swing-k1.5-medabs-v1';

const DEFAULTS = Object.freeze({
  k: 1.5,              // pivot confirmation multiple of the local movement scale
  calibLookback: 48,   // candles of PAST movement used to size the scale (~12h)
  sensitivityKs: [1.0, 1.5, 2.0, 3.0],
  zoneTolK: 1.0,       // balance-zone half-width = zoneTolK * window scale
  minTouches: 3,       // closes inside an area before it is called a balance zone
  acceptN: 2,          // consecutive closes beyond a zone ⇒ accepted departure
});

// ── small safe math ──────────────────────────────────────────────────────────
function safeDiv(a, b) { return b === 0 || !isFinite(b) ? 0 : a / b; }
function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function medAbsDelta(closes) {
  const d = [];
  for (let i = 1; i < closes.length; i++) d.push(Math.abs(closes[i] - closes[i - 1]));
  return median(d);
}
const closeMsOf = (c) => c.openMs + M15;

// ── eligibility, dedup, integrity (C1, C5) ────────────────────────────────────
function prepare(cands, T) {
  const elig = (cands || [])
    .filter((c) => c && c.complete !== false && c.openMs + M15 <= T)   // C1
    .slice()
    .sort((a, b) => a.openMs - b.openMs);
  // Duplicates: same openMs appearing more than once. We keep the FIRST and flag
  // the rest — we never silently merge or average conflicting bars.
  const seen = new Set();
  const kept = [];
  let duplicates = 0;
  for (const c of elig) {
    if (seen.has(c.openMs)) { duplicates++; continue; }
    seen.add(c.openMs); kept.push(c);
  }
  // Gaps: any step larger than one M15 is missing coverage (weekend/holiday/feed).
  const gaps = [];
  for (let i = 1; i < kept.length; i++) {
    const step = kept[i].openMs - kept[i - 1].openMs;
    if (step > M15) gaps.push({ fromMs: kept[i - 1].openMs, toMs: kept[i].openMs, missing: Math.round(step / M15) - 1 });
  }
  const sources = new Set(kept.map((c) => c.source || 'OANDA'));
  return {
    candles: kept, duplicates, gaps,
    eligible: kept.length,
    firstCloseMs: kept.length ? closeMsOf(kept[0]) : null,
    lastCloseMs: kept.length ? closeMsOf(kept[kept.length - 1]) : null,
    singleSource: sources.size <= 1,
    sources: [...sources],
  };
}

// ── window selection + coverage (C5) ──────────────────────────────────────────
/** Candles whose close lies in (T - hours, T]. */
function inWindow(cands, T, hours) {
  const from = T - hours * HOUR;
  return cands.filter((c) => { const cm = closeMsOf(c); return cm > from && cm <= T; });
}
/** Candles whose close lies in (T - hours - band, T - band]  (a shifted window). */
function inBand(cands, T, hours, bandHours) {
  const hi = T - bandHours * HOUR, lo = hi - hours * HOUR;
  return cands.filter((c) => { const cm = closeMsOf(c); return cm > lo && cm <= hi; });
}

// ── per-window descriptors (C2, C3) ───────────────────────────────────────────
function describeWindow(w) {
  const n = w.length;
  if (n === 0) return { actual: 0, empty: true };
  const closes = w.map((c) => c.close);
  const highs = w.map((c) => c.high);
  const lows = w.map((c) => c.low);
  const firstClose = closes[0], lastClose = closes[n - 1];

  // Displacement + path from CONSECUTIVE CLOSES only (C3: no intrabar path).
  const closeDisplacement = lastClose - firstClose;
  const openToCloseDisplacement = lastClose - w[0].open;
  let path = 0;
  for (let i = 1; i < n; i++) path += Math.abs(closes[i] - closes[i - 1]);
  const efficiency = safeDiv(closeDisplacement, path);        // ∈ [-1,1], 0 when path=0

  // Observed range + position of the latest close within it.
  const high = Math.max(...highs), low = Math.min(...lows), range = high - low;
  const positionInRange = range > 0 ? (lastClose - low) / range : 0.5;   // 0.5 = flat/ambiguous

  // Alternation (sign flips of close-to-close change) and overlap (balance texture).
  let flips = 0, deltas = 0, overlaps = 0;
  for (let i = 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    if (i > 1) { const p = closes[i - 1] - closes[i - 2]; if (Math.sign(d) !== Math.sign(p) && d !== 0 && p !== 0) flips++; }
    if (d !== 0) deltas++;
    const aLo = lows[i], aHi = highs[i], bLo = lows[i - 1], bHi = highs[i - 1];
    if (aLo <= bHi && bLo <= aHi) overlaps++;                 // bar ranges overlap
  }
  const alternation = safeDiv(flips, Math.max(1, n - 2));
  const overlapFraction = safeDiv(overlaps, Math.max(1, n - 1));

  // Depth of the deepest counter-move against the net direction, and the
  // proportion of the achieved impulse that was subsequently retraced (C2:
  // running — uses only closes up to each point).
  const dir = Math.sign(closeDisplacement);
  let peakFav = 0, maxCounter = 0, retracedProp = 0;
  if (dir !== 0) {
    for (const c of closes) {
      const fav = (c - firstClose) * dir;
      if (fav > peakFav) peakFav = fav;
      const counter = peakFav - fav;
      if (counter > maxCounter) { maxCounter = counter; retracedProp = peakFav > 0 ? counter / peakFav : 0; }
    }
  }

  return {
    actual: n,
    firstCloseMs: closeMsOf(w[0]), lastCloseMs: closeMsOf(w[n - 1]),
    closeDisplacement: +closeDisplacement.toFixed(8),
    openToCloseDisplacement: +openToCloseDisplacement.toFixed(8),
    pathLength: +path.toFixed(8),
    directionalEfficiency: +efficiency.toFixed(4),
    direction: dir > 0 ? 'UP' : dir < 0 ? 'DOWN' : 'FLAT',
    rangeHigh: high, rangeLow: low, range: +range.toFixed(8),
    positionInRange: +positionInRange.toFixed(4),
    alternation: +alternation.toFixed(4),
    overlapFraction: +overlapFraction.toFixed(4),
    counterMove: +maxCounter.toFixed(8),
    impulseRetracedProportion: +retracedProp.toFixed(4),
  };
}

function windowBlock(cands, T, hours) {
  const w = inWindow(cands, T, hours);
  const nominal = hours * 4;
  // gaps strictly inside this window
  let gapCount = 0;
  for (let i = 1; i < w.length; i++) if (w[i].openMs - w[i - 1].openMs > M15) gapCount++;
  const spanMs = w.length ? closeMsOf(w[w.length - 1]) - w[0].openMs : 0;
  return {
    hours, nominalCandles: nominal, actualCandles: w.length,
    coveragePct: +(safeDiv(w.length, nominal) * 100).toFixed(1),
    gapCount, spanMs,
    descriptors: describeWindow(w),
  };
}

// ── swings / directional-change events (C2, C4) ───────────────────────────────
function scaleAt(closes, i, lb) {
  const s = closes.slice(Math.max(0, i - lb + 1), i + 1);     // past + present only
  return medAbsDelta(s);
}

/**
 * Causal zig-zag. A provisional extreme becomes a CONFIRMED pivot only once price
 * retraces from it by >= theta (theta sized from PAST movement at that bar). The
 * pivot's location is the extreme bar; it only ENTERS the known state at the
 * confirmation bar (C4). The final, still-open leg is reported as provisional.
 */
function detectSwings(cands, { k, calibLookback }) {
  const closes = cands.map((c) => c.close);
  const n = closes.length;
  if (n < 3) return { pivots: [], provisional: null, insufficient: true, k };

  // mode: 0 = direction not yet established, +1 = in an up-leg (seeking a higher
  // high), -1 = in a down-leg (seeking a lower low). We track the running max/min
  // SINCE the last confirmed pivot; a reversal confirms once price retraces from
  // that extreme by >= theta. In mode 0 both sides are live, so the FIRST side to
  // cross theta establishes the first pivot (no two-sided fight over the extreme).
  const pivots = [];
  let mode = 0, lastConfirmIdx = 0;
  let maxP = closes[0], maxI = 0, minP = closes[0], minI = 0;
  for (let i = 1; i < n; i++) {
    const theta = k * scaleAt(closes, i, calibLookback);
    const p = closes[i];
    if (p > maxP) { maxP = p; maxI = i; }
    if (p < minP) { minP = p; minI = i; }
    if (!(theta > 0)) continue;
    if (mode >= 0 && maxP - p >= theta) {              // confirmed reversal off a HIGH
      pivots.push({ type: 'HIGH', pivotIdx: maxI, price: maxP, confirmIdx: i, theta: +theta.toFixed(8) });
      mode = -1; lastConfirmIdx = i; maxP = p; maxI = i; minP = p; minI = i; continue;
    }
    if (mode <= 0 && p - minP >= theta) {              // confirmed reversal off a LOW
      pivots.push({ type: 'LOW', pivotIdx: minI, price: minP, confirmIdx: i, theta: +theta.toFixed(8) });
      mode = 1; lastConfirmIdx = i; maxP = p; maxI = i; minP = p; minI = i;
    }
  }
  const toMs = (idx) => closeMsOf(cands[idx]);
  const mapped = pivots.map((p) => ({
    type: p.type, price: p.price,
    pivotTimeMs: toMs(p.pivotIdx),       // when the extreme occurred
    confirmedAtMs: toMs(p.confirmIdx),   // when we could KNOW it (C4)
    confirmLagCandles: p.confirmIdx - p.pivotIdx,
    theta: p.theta,
  }));
  // The still-open leg after the last confirmed pivot: direction from the net move
  // off the leg start; its extreme is the running max (up) or min (down). Unconfirmed.
  let pdir = mode;
  if (pdir === 0) pdir = Math.sign(closes[n - 1] - closes[lastConfirmIdx]);
  const extIdx = pdir > 0 ? maxI : pdir < 0 ? minI : n - 1;
  const provisional = {
    fromMs: toMs(lastConfirmIdx), extremeTimeMs: toMs(extIdx), extremePrice: closes[extIdx],
    direction: pdir > 0 ? 'UP' : pdir < 0 ? 'DOWN' : 'FLAT',
    confirmed: false,   // the current leg is NOT yet a pivot
  };
  return { pivots: mapped, provisional, insufficient: false, k };
}

/** Sensitivity of pivot COUNT to k — descriptive only, never selected by profit. */
function swingSensitivity(cands, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  return o.sensitivityKs.map((k) => ({ k, pivots: detectSwings(cands, { k, calibLookback: o.calibLookback }).pivots.length }));
}

// ── balance zone lifecycle (C2, C3) ───────────────────────────────────────────
/**
 * Identify the most-interacted price band in `w`, then walk the window forward
 * emitting a causal lifecycle. Every label uses only candles up to that bar; a
 * departure is PROVISIONAL until it is accepted by persistence (acceptN
 * consecutive closes beyond) OR a retest that holds (price pokes back toward the
 * edge, then closes beyond again). A wick beyond the zone that closes back inside
 * is a REJECTION (uses the extreme vs the close only — not intrabar order, C3).
 */
function balanceLifecycle(w, { zoneTolK, minTouches, acceptN }) {
  if (w.length < minTouches) return { zone: null, events: [] };
  const closes = w.map((c) => c.close);
  const tol = zoneTolK * medAbsDelta(closes);
  if (!(tol > 0)) return { zone: null, events: [] };          // flat/unchanged ⇒ no zone

  // Center = the close with the most neighbours within tol (ties: earliest).
  let bestIdx = 0, bestCount = -1;
  for (let i = 0; i < closes.length; i++) {
    let c = 0;
    for (let j = 0; j < closes.length; j++) if (Math.abs(closes[j] - closes[i]) <= tol) c++;
    if (c > bestCount) { bestCount = c; bestIdx = i; }
  }
  const center = closes[bestIdx];
  const zone = { low: +(center - tol).toFixed(8), high: +(center + tol).toFixed(8), center: +center.toFixed(8), tol: +tol.toFixed(8) };

  const events = [];
  let touches = 0, formed = false, depart = null, lastBeyondMs = null;
  for (const c of w) {
    const ms = closeMsOf(c), close = c.close;
    const inside = close >= zone.low && close <= zone.high;
    if (inside) touches++;
    if (!formed) {
      if (touches >= minTouches) { formed = true; events.push({ ms, type: 'BALANCE_FORMED', evidence: `${touches} closes within [${zone.low}, ${zone.high}]` }); }
      continue;                                                // nothing is labelled before the zone exists
    }
    const beyondHigh = close > zone.high, beyondLow = close < zone.low;
    const wickRejHigh = c.high > zone.high && close <= zone.high;
    const wickRejLow = c.low < zone.low && close >= zone.low;
    if (inside) {
      if (depart && !depart.accepted) {
        // Returning while a departure was only provisional: is this a shallow
        // retest (close near the breached edge) or a full return into balance?
        const edge = depart.dir > 0 ? zone.high : zone.low;
        if (Math.abs(close - edge) <= tol) { depart.retested = true; events.push({ ms, type: 'TEST', evidence: `retest of breached ${depart.dir > 0 ? 'upper' : 'lower'} edge` }); }
        else { events.push({ ms, type: 'RETURN', evidence: 'close back inside zone — provisional departure failed' }); depart = null; }
      } else if (wickRejHigh || wickRejLow) {
        events.push({ ms, type: 'REJECTION', evidence: `wick ${wickRejHigh ? 'above' : 'below'} zone, close back inside` });
      } else {
        events.push({ ms, type: 'TEST', evidence: 'close interacting inside the zone' });
      }
    } else {
      const dir = beyondHigh ? 1 : -1;
      if (!depart || depart.dir !== dir) {
        depart = { dir, n: 1, accepted: false, retested: false };
        events.push({ ms, type: 'DEPARTURE_PROVISIONAL', evidence: `first close ${dir > 0 ? 'above' : 'below'} zone` });
      } else {
        depart.n++;
        if (!depart.accepted && (depart.n >= acceptN || depart.retested)) {
          depart.accepted = true;
          events.push({ ms, type: 'DEPARTURE_ACCEPTED', evidence: depart.retested ? 'retest held, close beyond again' : `${depart.n} consecutive closes beyond zone` });
        } else if (depart.accepted) {
          // Sustained hold: count it, emit ONE summarizing CONTINUATION after the
          // run (below) rather than one event per bar — keeps the log interpretable.
          depart.heldCloses = (depart.heldCloses || 0) + 1; lastBeyondMs = ms;
        }
      }
    }
  }
  if (depart && depart.accepted && depart.heldCloses > 0) {
    events.push({ ms: lastBeyondMs, type: 'CONTINUATION', evidence: `held beyond zone for ${depart.heldCloses} further closes` });
  }
  return { zone, events };
}

// ── overall state (define NO_DATA / INSUFFICIENT / AMBIGUOUS explicitly) ───────
function classifyState(windows, integrity) {
  if (integrity.eligible === 0) return { label: 'NO_DATA', reasons: ['no eligible closed candles at T'], evidence: {} };
  const h12 = windows.h12.descriptors, h24 = windows.h24.descriptors;
  if (windows.h12.actualCandles < 4) return { label: 'INSUFFICIENT_DATA', reasons: [`only ${windows.h12.actualCandles} candles in last 12h`], evidence: {} };
  const ev = { eff24: h24.directionalEfficiency, overlap24: h24.overlapFraction, range24: h24.range };
  if (h24.range === 0) return { label: 'AMBIGUOUS', reasons: ['zero observed range (unchanged)'], evidence: ev };
  const absEff = Math.abs(h24.directionalEfficiency);
  if (absEff >= 0.5) return { label: h24.direction === 'UP' ? 'DIRECTIONAL_UP' : 'DIRECTIONAL_DOWN', reasons: [`|efficiency|=${absEff.toFixed(2)} over 24h`], evidence: ev };
  if (h24.overlapFraction >= 0.7 && absEff < 0.25) return { label: 'BALANCED', reasons: ['high bar overlap, low net efficiency'], evidence: ev };
  return { label: 'ROTATIONAL', reasons: ['mixed: neither cleanly directional nor tightly balanced'], evidence: ev };
}

// ── public API ────────────────────────────────────────────────────────────────
/**
 * @param {Array} cands ascending research-shape candles for ONE pair (may include
 *        ineligible/future rows; they are filtered out).
 * @param {Object} opts { pair, asOfCloseMs (T, required), k?, calibLookback?, ... }
 * @returns a pure description object (see docs/research/STAGE_A_PRICEACTION.md).
 */
function describePriceAction(cands, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const T = o.asOfCloseMs;
  if (T == null) throw new Error('describePriceAction: asOfCloseMs (T) is required');

  const integrity = prepare(cands, T);
  const base = {
    version: PRICEACTION_VERSION, thresholdVersion: THRESHOLD_VERSION,
    pair: o.pair || null, asOfCloseUtc: new Date(T).toISOString(), asOfCloseMs: T,
    integrity,
  };
  if (integrity.eligible === 0) {
    return { ...base, windows: null, comparison: null, swings: null, balance: null, events: [], state: { label: 'NO_DATA', reasons: ['no eligible closed candles at T'], evidence: {} } };
  }

  const C = integrity.candles;
  const windows = {
    h12: windowBlock(C, T, 12), h24: windowBlock(C, T, 24),
    h36: windowBlock(C, T, 36), h48: windowBlock(C, T, 48),
  };

  // latest 12h vs immediately preceding 12h, plus nested-window efficiency trail
  const prev12 = describeWindow(inBand(C, T, 12, 12));
  const comparison = {
    latest12: windows.h12.descriptors, previous12: prev12,
    deltaEfficiency: +((windows.h12.descriptors.directionalEfficiency || 0) - (prev12.directionalEfficiency || 0)).toFixed(4),
    nestedEfficiency: { h12: windows.h12.descriptors.directionalEfficiency, h24: windows.h24.descriptors.directionalEfficiency, h36: windows.h36.descriptors.directionalEfficiency, h48: windows.h48.descriptors.directionalEfficiency },
  };

  const swingsFull = detectSwings(C, { k: o.k, calibLookback: o.calibLookback });
  const swings = { ...swingsFull, thresholdVersion: THRESHOLD_VERSION, sensitivity: swingSensitivity(C, o) };

  // Balance + merged chronological event log are scoped to the last 48h.
  const w48 = inWindow(C, T, 48);
  const balance = balanceLifecycle(w48, o);
  const w48from = T - 48 * HOUR;
  const reversalEvents = swingsFull.pivots
    .filter((p) => p.confirmedAtMs > w48from && p.confirmedAtMs <= T)
    .map((p) => ({ ms: p.confirmedAtMs, type: 'REVERSAL', evidence: `confirmed ${p.type} pivot (extreme @ ${new Date(p.pivotTimeMs).toISOString()}, price ${p.price})` }));
  const events = [...balance.events, ...reversalEvents].sort((a, b) => a.ms - b.ms || (a.type < b.type ? -1 : 1));

  const state = classifyState(windows, integrity);
  return { ...base, windows, comparison, swings, balance, events, state };
}

module.exports = {
  PRICEACTION_VERSION, THRESHOLD_VERSION, DEFAULTS, M15,
  describePriceAction, detectSwings, swingSensitivity, balanceLifecycle,
  describeWindow, windowBlock, prepare, classifyState, safeDiv, median, medAbsDelta,
};
