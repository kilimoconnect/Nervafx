'use strict';

/**
 * NervaFX H1 Continuation Engine — 28-pair scanner.
 *
 * One evaluation timestamp for the whole scan; each pair evaluated independently
 * (one failure never stops the others); direct completed H1 only (no synthesis,
 * no lower-timeframe fetch). Batched to respect provider rate limits.
 */

const { PAIRS, STATES } = require('./_h1c-constants');
const { fetchClosedH1 } = require('./_h1c-data');
const { evaluateSetup } = require('./_h1c-state');

const BATCH = 7;   // same batching convention as the existing engines.

const STATE_PRIORITY = {
  CONTINUATION_CONFIRMED: 6, SECOND_PUSH_STARTED: 5, CONTINUATION_READY: 4,
  PULLBACK_VALID: 3, PULLBACK_FORMING: 2, IMPULSE_LOCKED: 1, SEARCHING: 0,
  INVALIDATED: -1, EXPIRED: -2,
};

const dirLabel = (d) => (d > 0 ? 'BUY' : 'SELL');

/** Stable setup id = pair + direction + reference-impulse end timestamp. */
function stableSetupId(inst, direction, refEndTime) {
  return `${inst}:${dirLabel(direction)}:${refEndTime}`;
}

function buildSetup(inst, res, evalISO) {
  const pair = inst.replace('_', '/');
  const ref = res.reference;
  if (!ref) return { setupId: null, pair, instrument: inst, direction: null, state: res.state, reasons: [res.state] };

  const dir = ref.direction;
  const atr = ref.atr || 0;
  const fb = res.failure || null;
  const secondPushLevel = fb ? (dir > 0 ? fb.failureBoxHigh + 0.05 * atr : fb.failureBoxLow - 0.05 * atr) : null;
  const confirmationLevel = dir > 0 ? ref.high + 0.05 * atr : ref.low - 0.05 * atr;

  return {
    setupId: stableSetupId(inst, dir, ref.endTime),
    pair, instrument: inst,
    direction: dirLabel(dir),
    state: res.state,
    grade: res.grade || null,
    setupScore: res.setupScore != null ? res.setupScore : null,
    impulse: {
      startTime: ref.startTime, endTime: ref.endTime,
      candleCount: ref.candleCount,
      sizeAtr: +(ref.netMoveATR || 0).toFixed(3),
      quality: ref.quality,
      high: ref.high, low: ref.low,
      structureLevel: ref.structureLevel,
    },
    previousAlignedImpulseCount: ref.previousAlignedImpulseCount || 0,
    pullback: res.pullback || null,
    failure: fb,
    failureBoxHigh: fb ? fb.failureBoxHigh : null,
    failureBoxLow: fb ? fb.failureBoxLow : null,
    referenceHigh: ref.high, referenceLow: ref.low,
    secondPushLevel: secondPushLevel != null ? +secondPushLevel.toFixed(5) : null,
    confirmationLevel: +confirmationLevel.toFixed(5),
    invalidation: res.invalidation || null,
    outcome: res.outcome || null,
    reasons: res.reasons || [res.state, res.invalidation, res.outcome].filter(Boolean),
    readyTime: res.readyTime || null,
    timestamps: { impulseStart: ref.startTime, impulseEnd: ref.endTime, ready: res.readyTime || null, evaluatedAt: evalISO },
  };
}

function buildTrace(data, res) {
  return {
    candlesUsed: data.meta.count,
    lastClosedCandle: data.meta.lastTime,
    gaps: data.meta.gaps,
    referenceSelected: res.reference ? {
      direction: dirLabel(res.reference.direction),
      endTime: res.reference.endTime,
      candleCount: res.reference.candleCount,
      quality: res.reference.quality,
      netMoveATR: res.reference.netMoveATR,
      previousAligned: res.reference.previousAlignedImpulseCount,
    } : null,
    pullback: res.pullback || null,
    failure: res.failure || null,
    stateReason: [res.state, res.invalidation, res.outcome].filter(Boolean),
  };
}

async function scanPair(sb, inst, evalMs, debug) {
  const pair = inst.replace('_', '/');
  try {
    const data = await fetchClosedH1(sb, inst, { evalMs });
    if (!data.ok) {
      return { instrument: inst, pair, state: null, setup: null, dataQuality: { ok: false, reason: data.reason, meta: data.meta } };
    }
    const res = evaluateSetup(data.candles, {});
    const setup = buildSetup(inst, res, new Date(evalMs).toISOString());
    const out = {
      instrument: inst, pair, state: res.state, setup,
      dataQuality: { ok: true, reason: null, meta: { count: data.meta.count, gaps: data.meta.gaps, lastTime: data.meta.lastTime } },
    };
    if (debug) out.trace = buildTrace(data, res);
    return out;
  } catch (e) {
    return { instrument: inst, pair, state: null, setup: null, dataQuality: { ok: false, reason: 'ERROR', error: e.message } };
  }
}

async function scanAll(sb, opts = {}) {
  const evalMs = opts.evalMs != null ? opts.evalMs : Date.now();
  const debug = !!opts.debug;
  const evalISO = new Date(evalMs).toISOString();

  const pairsOut = [];
  for (let b = 0; b < PAIRS.length; b += BATCH) {
    const batch = PAIRS.slice(b, b + BATCH);
    const rows = await Promise.all(batch.map((inst) => scanPair(sb, inst, evalMs, debug)));
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
    .filter((p) => p.setup && p.setup.direction && p.setup.state !== STATES.SEARCHING)
    .map((p) => p.setup)
    .sort((a, b) =>
      (STATE_PRIORITY[b.state] || 0) - (STATE_PRIORITY[a.state] || 0) ||
      (b.setupScore || 0) - (a.setupScore || 0) ||
      String(b.timestamps.impulseEnd).localeCompare(String(a.timestamps.impulseEnd))
    );

  return {
    generatedAt: evalISO,
    timeframe: 'H1',
    pairsRequested: PAIRS.length,
    evaluated,
    dataErrors,
    summary,
    setups,
    pairs: pairsOut,
  };
}

module.exports = { scanAll, scanPair, buildSetup, stableSetupId, STATE_PRIORITY };
