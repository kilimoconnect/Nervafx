'use strict';

/**
 * Weekly structural trend + eligibility (step 5).
 *
 * From the last two CONFIRMED weekly swing highs and last two CONFIRMED weekly swing
 * lows:
 *   • BULLISH     — highs rising AND lows rising.
 *   • BEARISH     — highs falling AND lows falling.
 *   • NEUTRAL     — conflicting structure.
 *   • UNAVAILABLE — fewer than two confirmed highs or lows.
 *
 * Invalidation: in a bullish context the latest confirmed weekly HIGHER LOW is the
 * structural invalidation level; a COMPLETED weekly close below it cancels
 * eligibility (mirror for bearish: close above the latest LOWER HIGH).
 *
 * After an invalidation we do NOT reactivate from unchanged historical pivots:
 * re-eligibility requires a newly confirmed structural sequence, i.e. the latest
 * defining swing high AND low were both confirmed AFTER the invalidation.
 *
 * Everything is causal: the timeline is built from events stamped at their knowable
 * time (pivot confirmation close, weekly close), so biasAt(t) uses only information
 * available by t and never changes when later weeks are appended.
 */

const { detectFractals, confirmedAsOf } = require('./swings');

function computeBias(highs, lows) {
  // highs/lows: most-recent-first, need ≥2 of each.
  if (highs.length < 2 || lows.length < 2) return 'UNAVAILABLE';
  const risingH = highs[0].price > highs[1].price, risingL = lows[0].price > lows[1].price;
  const fallingH = highs[0].price < highs[1].price, fallingL = lows[0].price < lows[1].price;
  if (risingH && risingL) return 'BULLISH';
  if (fallingH && fallingL) return 'BEARISH';
  return 'NEUTRAL';
}

function buildWeeklyContext(w1cands, swingCfg) {
  const cfg = swingCfg || { left: 2, right: 2 };
  const pivots = detectFractals(w1cands, cfg);

  // Merged chronological event stream. Within the same ms a weekly CLOSE is
  // processed before a pivot CONFIRMATION (the pivot is derived from that close).
  const events = [];
  for (const c of w1cands) events.push({ t: c.closeMs, kind: 'close', close: c.close });
  for (const p of pivots) if (!p.bothSide) events.push({ t: p.confirmedAtMs, kind: 'pivot', pivot: p });
  events.sort((a, b) => (a.t - b.t) || (a.kind === 'close' ? -1 : 1));

  const highs = [], lows = [];                 // confirmed pivots, chronological
  let bias = 'UNAVAILABLE';
  let eligibilityStartMs = null, invalidationLevel = null;
  let invalidatedAtMs = -Infinity;             // last invalidation time (for the newness rule)
  const episodes = [];                         // regime snapshots, stamped fromMs

  const lastTwo = (arr) => arr.slice(Math.max(0, arr.length - 2)).reverse();
  const snapshot = (t, reason) => {
    const h = lastTwo(highs), l = lastTwo(lows);
    episodes.push({
      fromMs: t, reason, bias,
      eligibilityStartMs, invalidationLevel,
      highs: h.map((p) => ({ price: p.price, extremeTimeMs: p.extremeTimeMs, confirmedAtMs: p.confirmedAtMs })),
      lows: l.map((p) => ({ price: p.price, extremeTimeMs: p.extremeTimeMs, confirmedAtMs: p.confirmedAtMs })),
    });
  };

  for (const e of events) {
    if (e.kind === 'close') {
      // Invalidation check against the CURRENT eligibility, using the completed close.
      if (bias === 'BULLISH' && invalidationLevel != null && e.close < invalidationLevel) {
        bias = 'NEUTRAL'; eligibilityStartMs = null; invalidationLevel = null; invalidatedAtMs = e.t;
        snapshot(e.t, 'invalidated_bullish');
      } else if (bias === 'BEARISH' && invalidationLevel != null && e.close > invalidationLevel) {
        bias = 'NEUTRAL'; eligibilityStartMs = null; invalidationLevel = null; invalidatedAtMs = e.t;
        snapshot(e.t, 'invalidated_bearish');
      }
      continue;
    }
    // pivot confirmation
    (e.pivot.type === 'HIGH' ? highs : lows).push(e.pivot);
    const h = lastTwo(highs), l = lastTwo(lows);
    const newBias = computeBias(h, l);
    const prevBias = bias;

    if (newBias === 'BULLISH') {
      // Newness rule after an invalidation: the latest HH and HL must be newer.
      const fresh = (h[0] && l[0] && h[0].confirmedAtMs > invalidatedAtMs && l[0].confirmedAtMs > invalidatedAtMs);
      if (prevBias === 'BULLISH' && eligibilityStartMs != null) {
        invalidationLevel = l[0].price;                     // ratchet the higher-low invalidation up
        snapshot(e.t, 'bullish_continues');
      } else if (fresh) {
        bias = 'BULLISH'; eligibilityStartMs = e.t; invalidationLevel = l[0].price;
        snapshot(e.t, 'bullish_eligible');
      } else {
        // bullish read but built on pre-invalidation pivots → not yet eligible
        bias = 'NEUTRAL'; eligibilityStartMs = null; invalidationLevel = null;
        snapshot(e.t, 'bullish_read_not_fresh');
      }
    } else if (newBias === 'BEARISH') {
      const fresh = (h[0] && l[0] && h[0].confirmedAtMs > invalidatedAtMs && l[0].confirmedAtMs > invalidatedAtMs);
      if (prevBias === 'BEARISH' && eligibilityStartMs != null) {
        invalidationLevel = h[0].price;
        snapshot(e.t, 'bearish_continues');
      } else if (fresh) {
        bias = 'BEARISH'; eligibilityStartMs = e.t; invalidationLevel = h[0].price;
        snapshot(e.t, 'bearish_eligible');
      } else {
        bias = 'NEUTRAL'; eligibilityStartMs = null; invalidationLevel = null;
        snapshot(e.t, 'bearish_read_not_fresh');
      }
    } else {
      bias = newBias;                                        // NEUTRAL or UNAVAILABLE
      eligibilityStartMs = null; invalidationLevel = null;
      snapshot(e.t, newBias === 'NEUTRAL' ? 'neutral' : 'unavailable');
    }
  }

  function biasAt(t) {
    let active = { fromMs: -Infinity, bias: 'UNAVAILABLE', eligibilityStartMs: null, invalidationLevel: null, highs: [], lows: [] };
    for (const ep of episodes) { if (ep.fromMs <= t) active = ep; else break; }
    return active;
  }

  // Confirmed weekly swing levels knowable as-of t (for target selection).
  function levelsAsOf(t) {
    const conf = confirmedAsOf(pivots, t);
    return {
      highs: conf.filter((p) => p.type === 'HIGH').map((p) => p.price),
      lows: conf.filter((p) => p.type === 'LOW').map((p) => p.price),
    };
  }

  return { pivots, episodes, biasAt, levelsAsOf };
}

module.exports = { buildWeeklyContext, computeBias };
