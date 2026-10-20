'use strict';

/**
 * Walk COMPLETED H4 candles against a FROZEN weekly band [lower, upper] and classify
 * each boundary interaction into causal episodes. Shared primitive for the range
 * rejection / accepted breakout / failed breakout approaches. No indicators — only
 * close vs boundary and wick (high/low) vs boundary, close-based (never intrabar order).
 *
 * Episode kinds (per boundary, chronological):
 *   • REJECTION — a wick beyond the boundary with the close back inside and NO close
 *     ever beyond (a boundary test that never became an attempted departure).
 *   • ACCEPTED  — an attempted departure (≥1 close beyond) that earned acceptance
 *     (acceptN consecutive closes beyond, or a retest that held) and is still beyond.
 *   • FAILED    — an attempted departure (≥1 close beyond; may or may not have been
 *     accepted) that was then RECLAIMED (a completed close back inside the band).
 *
 * `acceptN` consecutive closes beyond = acceptance (reuses the M15 accepted-break idea).
 * The extreme of each episode is the furthest wick beyond the boundary during it.
 */

function balanceWalk(h4, band, opts) {
  const upper = band.upper, lower = band.lower;
  const acceptN = (opts && opts.acceptN) || 2;
  const fromMs = (opts && opts.fromMs != null) ? opts.fromMs : -Infinity;
  const episodes = [];
  let dep = null;   // active attempted-departure beyond a boundary

  const closeDep = (reclaimMs, reclaimIdx) => {
    episodes.push({
      boundary: dep.boundary, dir: dep.dir,                 // dir: +1 = beyond upper (up), -1 = beyond lower (down)
      kind: 'FAILED', accepted: dep.accepted,
      startMs: dep.startMs, startIdx: dep.startIdx,
      acceptedMs: dep.acceptedMs || null,
      extreme: dep.extreme, extremeMs: dep.extremeMs,
      reclaimMs, reclaimIdx, closesBeyond: dep.n,
    });
    dep = null;
  };

  for (let i = 0; i < h4.length; i++) {
    const c = h4[i];
    if (c.closeMs <= fromMs) continue;
    const beyondUpper = c.close > upper, beyondLower = c.close < lower;
    const inside = !beyondUpper && !beyondLower;

    if (dep) {
      // update extreme (furthest wick beyond in the departure direction)
      if (dep.dir > 0 && c.high > dep.extreme) { dep.extreme = c.high; dep.extremeMs = c.openMs; }
      if (dep.dir < 0 && c.low < dep.extreme) { dep.extreme = c.low; dep.extremeMs = c.openMs; }
      const stillBeyond = dep.dir > 0 ? beyondUpper : beyondLower;
      if (stillBeyond) {
        dep.n++;
        if (!dep.accepted && dep.n >= acceptN) { dep.accepted = true; dep.acceptedMs = c.closeMs; dep.acceptedIdx = i; }
      } else if (inside) {
        closeDep(c.closeMs, i);                              // reclaimed → FAILED episode
      }
      continue;
    }

    // no active departure
    if (beyondUpper || beyondLower) {
      const dir = beyondUpper ? 1 : -1;
      dep = { boundary: dir > 0 ? 'upper' : 'lower', dir, startMs: c.closeMs, startIdx: i, n: 1, accepted: false, extreme: dir > 0 ? c.high : c.low, extremeMs: c.openMs };
    } else {
      const wickUp = c.high > upper && c.close <= upper;
      const wickDn = c.low < lower && c.close >= lower;
      if (wickUp) episodes.push({ boundary: 'upper', dir: 1, kind: 'REJECTION', startMs: c.closeMs, startIdx: i, extreme: c.high, extremeMs: c.openMs, reclaimMs: c.closeMs, reclaimIdx: i });
      if (wickDn) episodes.push({ boundary: 'lower', dir: -1, kind: 'REJECTION', startMs: c.closeMs, startIdx: i, extreme: c.low, extremeMs: c.openMs, reclaimMs: c.closeMs, reclaimIdx: i });
    }
  }

  // An episode still beyond at the end that earned acceptance = ACCEPTED (ongoing).
  let ongoing = null;
  if (dep) ongoing = { boundary: dep.boundary, dir: dep.dir, kind: dep.accepted ? 'ACCEPTED' : 'PROVISIONAL', accepted: dep.accepted, startMs: dep.startMs, startIdx: dep.startIdx, acceptedMs: dep.acceptedMs || null, extreme: dep.extreme, extremeMs: dep.extremeMs, closesBeyond: dep.n };

  return { episodes, ongoing };
}

/** Latest episode (including the ongoing one) at a given boundary matching a predicate. */
function latestEpisode(walk, pred) {
  const all = walk.episodes.concat(walk.ongoing ? [walk.ongoing] : []);
  for (let i = all.length - 1; i >= 0; i--) if (pred(all[i])) return all[i];
  return null;
}

module.exports = { balanceWalk, latestEpisode };
