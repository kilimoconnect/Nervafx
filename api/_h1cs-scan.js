'use strict';

/**
 * NervaFX H1 Continuation Engine — SESSION 28-pair scanner (isolated).
 *
 * Reuses the shared 28-pair universe and the shared closed-candle data layer,
 * but evaluates every pair through the Session evaluator. One shared evaluation
 * timestamp; per-pair isolation (one failure never stops the others); completed
 * H1 candles only.
 */

const { PAIRS } = require('./_h1c-constants');           // shared universe
const { fetchClosedH1 } = require('./_h1c-data');         // shared sanitizer
const { evaluateSessionSetup } = require('./_h1cs-state');
const { STATES, MODE, MIN_H1_HISTORY } = require('./_h1cs-constants');

const BATCH = 7;
const PRIORITY = {
  SESSION_CONTINUATION_CONFIRMED: 6, SECOND_PUSH_STARTED: 5, SECOND_PUSH_READY: 4,
  POST_SESSION_PULLBACK: 3, POST_SESSION_PAUSE: 2, REFERENCE_SESSION_LOCKED: 1,
  SEARCHING_REFERENCE_SESSION: 0, INVALIDATED: -1, EXPIRED: -2,
};

async function scanPairSession(sb, inst, evalMs) {
  const pair = inst.replace('_', '/');
  try {
    const data = await fetchClosedH1(sb, inst, { evalMs, minCandles: MIN_H1_HISTORY });
    if (!data.ok) {
      return { instrument: inst, pair, state: null, setup: null, dataQuality: { ok: false, reason: data.reason, meta: data.meta } };
    }
    const res = evaluateSessionSetup(data.candles, { evalMs, instrument: inst });
    res.pair = pair;
    res.instrument = inst;
    res.timestamps = { evaluatedAt: new Date(evalMs).toISOString(), referenceSessionEnd: res.referenceSessionEndUtc || null };
    return {
      instrument: inst, pair, state: res.state, setup: res,
      dataQuality: { ok: true, reason: null, meta: { count: data.meta.count, gaps: data.meta.gaps, lastTime: data.meta.lastTime } },
    };
  } catch (e) {
    return { instrument: inst, pair, state: null, setup: null, dataQuality: { ok: false, reason: 'ERROR', error: e.message } };
  }
}

async function scanAllSession(sb, opts = {}) {
  const evalMs = opts.evalMs != null ? opts.evalMs : Date.now();
  const evalISO = new Date(evalMs).toISOString();
  const pairsOut = [];
  for (let b = 0; b < PAIRS.length; b += BATCH) {
    const batch = PAIRS.slice(b, b + BATCH);
    // eslint-disable-next-line no-await-in-loop
    const rows = await Promise.all(batch.map((inst) => scanPairSession(sb, inst, evalMs)));
    for (const r of rows) pairsOut.push(r);
  }

  const evaluated = pairsOut.filter((p) => p.dataQuality.ok).length;
  const dataErrors = pairsOut.length - evaluated;
  const summary = {};
  for (const p of pairsOut) {
    const s = p.dataQuality.ok ? p.state : 'DATA_ERROR';
    summary[s] = (summary[s] || 0) + 1;
  }

  const setups = pairsOut
    .filter((p) => p.setup && p.setup.setupId && p.setup.state !== STATES.SEARCHING_REFERENCE_SESSION)
    .map((p) => p.setup)
    .sort((a, b) =>
      (PRIORITY[b.state] || 0) - (PRIORITY[a.state] || 0) ||
      (b.score || 0) - (a.score || 0) ||
      String(b.referenceSessionEndUtc).localeCompare(String(a.referenceSessionEndUtc)));

  return {
    generatedAt: evalISO,
    mode: MODE,
    timeframe: 'H1',
    pairsRequested: PAIRS.length,
    evaluated,
    dataErrors,
    summary,
    setups,
    pairs: pairsOut,
  };
}

module.exports = { scanAllSession, scanPairSession, PRIORITY };
