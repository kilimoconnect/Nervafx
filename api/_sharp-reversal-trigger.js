'use strict';

// Shared trigger source for the continuation engines.
//
// The one trigger comes from the Sharp Reversal engine, evaluated at the page's
// as-of time (live = now, historical = the selected date/time). This works for
// any date because the Sharp Reversal engine itself supports historical eval —
// no persisted log required. Both modes (Standard = standard, Scalp = swing) are
// evaluated and the EARLIEST reversal cross per pair wins ("whichever first").
//
//   { EUR_USD: { direction: 'BUY', triggerTime: ISO, mode: 'standard' }, ... }

const srHandler = require('./sharp-reversal-engine.js');

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

// sb is accepted for call-site compatibility but unused — the Sharp Reversal
// engine opens its own client. evalISO is the as-of time to evaluate at.
async function loadSharpReversalTriggers(sb, evalISO) {
  const [std, swing] = await Promise.all([invokeSR('standard', evalISO), invokeSR('swing', evalISO)]);
  const map = {};
  for (const r of [std, swing]) {
    const mode = r.data?.mode || null;
    for (const p of (r.data?.pairs || [])) {
      if (!p.instrument || !p.direction || !p.triggerTime) continue;
      const t = new Date(p.triggerTime).getTime();
      const prev = map[p.instrument];
      if (!prev || t < new Date(prev.triggerTime).getTime()) {
        map[p.instrument] = { direction: p.direction, triggerTime: p.triggerTime, mode };
      }
    }
  }
  return map;
}

module.exports = { loadSharpReversalTriggers };
