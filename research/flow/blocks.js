'use strict';

/**
 * NervaFX Inverted Flow — deterministic block engine (pure).
 *
 * Consumes an ordered stream of observations [{ value, ms, ... }] and produces confirmed blocks.
 * The SAME engine drives historical replay and live updates — feeding a prefix of the stream
 * reproduces exactly the blocks confirmed at that point (no look-ahead).
 *
 * Height = fixed step S. Width = eligible observations ("activity"). A thin trace records the
 * observed path inside each block. Let C be the last confirmed block close, S the step:
 *   first block : |value − anchor| ≥ S                → body anchor → anchor ± S
 *   dir UP   : value ≥ C+S  → up continuation  body C → C+S
 *              value ≤ C−2S → DOWN reversal   red body C−S → C−2S
 *   dir DOWN : value ≤ C−S  → down continuation body C → C−S
 *              value ≥ C+2S → UP reversal     green body C+S → C+2S
 * Equality counts as a crossing. Levels are tracked as INTEGER units of S from the anchor so a
 * threshold is handled with exact, instrument-safe precision.
 *
 * Activity ownership: count observations after the preceding confirmation, up to AND INCLUDING the
 * confirming observation (counted once). The confirming observation starts the next trace without
 * adding another activity unit. If one observation crosses several thresholds, all crossed levels
 * are computed in order and stored as ONE event group with the group's activity counted once.
 */

// Round value→units to a micro-step so an exact threshold (e.g. +1.0000000001 of float noise)
// is treated as a crossing. 6 dp of a step is far finer than any real feed yet kills drift.
function unitsOf(value, anchor, step) { return Math.round(((value - anchor) / step) * 1e6) / 1e6; }

/**
 * Compute the ordered list of block bodies confirmed by a single observation value, starting from
 * (Cu, dir) in integer step-units. Returns { bodies, Cu, dir } with the advanced state. `dir` is
 * one of 'up' | 'down' | null (null = no block confirmed yet / first block pending).
 */
function levelsFor(vu, Cu, dir) {
  const bodies = [];
  // guard against a pathological stream; real streams resolve in a handful of steps.
  for (let guard = 0; guard < 100000; guard++) {
    if (dir === 'up') {
      if (vu >= Cu + 1) { bodies.push({ dir: 'up', kind: 'continuation', openUnit: Cu, closeUnit: Cu + 1 }); Cu += 1; continue; }
      if (vu <= Cu - 2) { bodies.push({ dir: 'down', kind: 'reversal', openUnit: Cu - 1, closeUnit: Cu - 2 }); Cu -= 2; dir = 'down'; continue; }
      break;
    } else if (dir === 'down') {
      if (vu <= Cu - 1) { bodies.push({ dir: 'down', kind: 'continuation', openUnit: Cu, closeUnit: Cu - 1 }); Cu -= 1; continue; }
      if (vu >= Cu + 2) { bodies.push({ dir: 'up', kind: 'reversal', openUnit: Cu + 1, closeUnit: Cu + 2 }); Cu += 2; dir = 'up'; continue; }
      break;
    } else {
      // first block ("opening"): a full step either way from the anchor (Cu starts at 0).
      if (vu >= Cu + 1) { bodies.push({ dir: 'up', kind: 'opening', openUnit: Cu, closeUnit: Cu + 1 }); Cu += 1; dir = 'up'; continue; }
      if (vu <= Cu - 1) { bodies.push({ dir: 'down', kind: 'opening', openUnit: Cu, closeUnit: Cu - 1 }); Cu -= 1; dir = 'down'; continue; }
      break;
    }
  }
  return { bodies, Cu, dir };
}

/**
 * Run the block engine over an ordered observation stream.
 *
 * opts:
 *   anchor     price of the anchor (first confirmed reference). If omitted, observations[0].value
 *              is the anchor and that first observation is the seed (not counted as activity).
 *   step       fixed step S (price, or pp for indices).
 *   dir0       'up' | 'down' | null — initial confirmed direction (default null = first block pending).
 *   precision  decimals for body-price rounding (display-safe). Default 6.
 *   intervalMs if given, a gap between consecutive observation ms greater than this flags a gap on
 *              the next event (used by close-only mode to flag scheduled/missing closures).
 *
 * Returns { ok, anchor, step, events[], blocks[], forming, finalUnit, finalDir, firstMs, lastMs }.
 * Each EVENT is one confirmation instant (width = its activity), carrying one or more level bodies
 * (a multi-level jump is one event). `forming` is the trailing unconfirmed interval, if any.
 */
function runBlocks(observations, opts) {
  const o = opts || {};
  const step = o.step;
  const precision = o.precision == null ? 6 : o.precision;
  const obs = (observations || []).filter((p) => p && isFinite(p.value) && isFinite(p.ms));
  if (!obs.length) return { ok: false, reason: 'no observations' };

  // obs[0] is ALWAYS the anchor seed (the first valid observation at the documented start point);
  // it establishes the reference and is never counted as activity. `anchor` may override the
  // reference price (defaults to the seed's value) but does not change which observation is the seed.
  const anchor = o.anchor != null ? o.anchor : obs[0].value;
  const priceOf = (u) => { const f = Math.pow(10, precision); return Math.round((anchor + u * step) * f) / f; };

  let Cu = 0;                 // last confirmed close, in integer step-units from the anchor
  let dir = o.dir0 || null;
  const events = [];
  const blocks = [];
  let eventSeq = 0;

  // trace + activity accumulated since the last confirmation. startValue is the visual start of the
  // next trace = the previous confirmation's observed value (or the anchor for the first event).
  let pending = [];           // observations since last confirmation (candidates for activity)
  let startValue = anchor;
  let startMs = obs[0].ms;

  const startIdx = 1;         // obs[0] is the seed; counting begins at the next observation
  let prevMs = obs[0].ms;

  for (let i = startIdx; i < obs.length; i++) {
    const p = obs[i];
    pending.push(p);
    const gap = (o.intervalMs && prevMs != null && (p.ms - prevMs) > o.intervalMs * 1.5) || false;
    prevMs = p.ms;

    const vu = unitsOf(p.value, anchor, step);
    const res = levelsFor(vu, Cu, dir);
    if (res.bodies.length) {
      // one confirming event (possibly multi-level). Activity = observations since last confirmation,
      // including this one, counted once.
      const activity = pending.length;
      const trace = pending.map((q) => ({ value: q.value, ms: q.ms }));
      let obsHigh = -Infinity, obsLow = Infinity;
      for (const q of pending) { if (q.value > obsHigh) obsHigh = q.value; if (q.value < obsLow) obsLow = q.value; }
      const levels = res.bodies.map((b) => ({
        dir: b.dir, kind: b.kind, openUnit: b.openUnit, closeUnit: b.closeUnit,
        open: priceOf(b.openUnit), close: priceOf(b.closeUnit),
      }));
      const ev = {
        seq: eventSeq++, ms: p.ms, eventId: 'e' + (eventSeq) + '@' + p.ms,
        activity, startValue, startMs, trace,
        levels, observedTrigger: p.value, bid: p.bid != null ? p.bid : null, ask: p.ask != null ? p.ask : null,
        obsHigh, obsLow,
        flags: { multiJump: levels.length > 1, gap, stale: !!p.stale },
      };
      events.push(ev);
      for (let k = 0; k < levels.length; k++) {
        blocks.push({
          dir: levels[k].dir, kind: levels[k].kind,
          theoreticalOpen: levels[k].open, theoreticalClose: levels[k].close,
          openUnit: levels[k].openUnit, closeUnit: levels[k].closeUnit,
          observedTrigger: p.value, activity: k === 0 ? activity : 0, eventId: ev.eventId,
          groupSize: levels.length, groupIndex: k,
          startMs, confirmMs: p.ms, obsHigh, obsLow,
          flags: ev.flags,
        });
      }
      // advance state; the confirming observation becomes the next trace's visual start.
      Cu = res.Cu; dir = res.dir;
      startValue = p.value; startMs = p.ms;
      pending = [];
    }
  }

  // trailing unconfirmed interval
  let forming = null;
  if (pending.length) {
    let obsHigh = -Infinity, obsLow = Infinity;
    for (const q of pending) { if (q.value > obsHigh) obsHigh = q.value; if (q.value < obsLow) obsLow = q.value; }
    const last = pending[pending.length - 1];
    forming = {
      activity: pending.length, startValue, startMs,
      trace: pending.map((q) => ({ value: q.value, ms: q.ms })),
      obsHigh, obsLow, latest: { value: last.value, ms: last.ms, bid: last.bid != null ? last.bid : null, ask: last.ask != null ? last.ask : null },
      unit: Cu, dir,
      // what each direction needs next (diagnostic):
      nextUp: priceOf(dir === 'down' ? Cu + 2 : Cu + 1),
      nextDown: priceOf(dir === 'up' ? Cu - 2 : Cu - 1),
    };
  }

  return {
    ok: true, anchor, step, precision,
    events, blocks, forming,
    // the clean, ordered observation stream (seed first) so a client can replay deterministically
    // with the SAME engine — historical and live processing of one input give one result.
    observations: obs.map((p) => ({ value: p.value, ms: p.ms, bid: p.bid != null ? p.bid : null, ask: p.ask != null ? p.ask : null })),
    finalUnit: Cu, finalDir: dir,
    firstMs: obs[0].ms, lastMs: obs[obs.length - 1].ms,
    nObs: obs.length - 1,   // seed excluded
  };
}

module.exports = { runBlocks, levelsFor, unitsOf };
