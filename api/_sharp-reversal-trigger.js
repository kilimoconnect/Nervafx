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

// Invoke the Sharp Reversal engine's fine-grained scan (one candle fetch, every
// M15 step) for a mode across [fromISO, atISO]. Returns { INST: {direction,
// triggerTime, state} } — each pair's earliest qualifying cross in the window.
function invokeScan(mode, fromISO, atISO) {
  return new Promise((resolve) => {
    const query = { mode, scan: '1', from: fromISO };
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
  const [std, swing] = await Promise.all([
    invokeScan('standard', windowStartISO, evalISO),
    invokeScan('swing', windowStartISO, evalISO),
  ]);

  // The scan only searched within [windowStart, evalISO], so any pair it returns
  // qualified inside the window. Its triggerTime (confirm-TF cross) may sit just
  // before the window when the reversal was already underway — that's fine, the
  // engine clamps monitoring to the window start. Keep the earliest cross.
  const map = {};
  for (const r of [std, swing]) {
    const triggers = r.data?.triggers || {};
    for (const inst of Object.keys(triggers)) {
      const t = triggers[inst];
      if (!t || !t.direction || !t.triggerTime) continue;
      const tt = new Date(t.triggerTime).getTime();
      if (isNaN(tt)) continue;
      const prev = map[inst];
      if (!prev || tt < new Date(prev.triggerTime).getTime()) {
        map[inst] = { direction: t.direction, triggerTime: t.triggerTime, mode: r.data?.mode || null };
      }
    }
  }
  return map;
}

module.exports = { loadSharpReversalTriggers };
