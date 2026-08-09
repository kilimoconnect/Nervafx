'use strict';

// Shared trigger source for the continuation engines.
//
// The one trigger comes from the Sharp Reversal engine. Because a reversal can
// fire early in a window and fade before the window ends, evaluating the engine
// at a single instant misses it. So we REPLAY the engine at stepped times across
// the window (2h steps, run in parallel), for both modes (Standard = standard,
// Scalp = swing), and keep each pair's EARLIEST reversal cross ("whichever
// first"). Each pair's own triggerTime (confirm-TF M15 cross) is the anchor.
// This works for any date — the engine itself supports historical `at=` eval.
//
//   { EUR_USD: { direction: 'BUY', triggerTime: ISO, mode: 'standard' }, ... }

const srHandler = require('./sharp-reversal-engine.js');

const STEP_MS = 2 * 3600000;      // evaluate every 2 hours across the window
const MAX_STEPS = 7;              // cap total eval points (×2 modes = calls)
const MAX_SPAN_MS = 12 * 3600000; // don't scan more than the last 12h of a window

function invokeSR(mode, atISO) {
  return new Promise((resolve) => {
    const query = { mode };
    if (atISO) query.at = atISO;
    const req = { method: 'GET', query, headers: {}, _internal: true };
    let statusCode = 200, payload = null;
    const res = {
      setHeader() {},
      status(c) { statusCode = c; return this; },
      json(d) { payload = d; resolve({ status: statusCode, data: d }); return this; },
      end() { resolve({ status: statusCode, data: payload }); },
    };
    Promise.resolve(srHandler(req, res)).catch((e) => resolve({ status: 500, data: { error: e.message } }));
  });
}

// windowStartISO..evalISO define the engine's window; the trigger's cross must
// fall inside it to count. sb is accepted for call-site compatibility (unused).
async function loadSharpReversalTriggers(sb, windowStartISO, evalISO) {
  const startMs = new Date(windowStartISO).getTime();
  const endMs = new Date(evalISO).getTime();
  const scanStartMs = Math.max(startMs, endMs - MAX_SPAN_MS);

  // Eval points, most recent first, 2h apart, capped.
  const times = [];
  for (let t = endMs; t >= scanStartMs && times.length < MAX_STEPS; t -= STEP_MS) {
    times.push(new Date(t).toISOString());
  }
  if (!times.length) times.push(new Date(endMs).toISOString());

  const calls = [];
  for (const t of times) { calls.push(invokeSR('standard', t)); calls.push(invokeSR('swing', t)); }
  const results = await Promise.all(calls);

  const map = {};
  for (const r of results) {
    const mode = r.data?.mode || null;
    for (const p of (r.data?.pairs || [])) {
      if (!p.instrument || !p.direction || !p.triggerTime) continue;
      const tt = new Date(p.triggerTime).getTime();
      if (isNaN(tt) || tt < startMs || tt > endMs) continue;   // cross must fall inside the window
      const prev = map[p.instrument];
      if (!prev || tt < new Date(prev.triggerTime).getTime()) {
        map[p.instrument] = { direction: p.direction, triggerTime: p.triggerTime, mode };
      }
    }
  }
  return map;
}

module.exports = { loadSharpReversalTriggers };
