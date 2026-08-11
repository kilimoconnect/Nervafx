'use strict';

/**
 * NervaFX H1 Continuation Engine — historical DETECTOR validation runner.
 *
 * This is NOT a trading backtest. It records only detector statistics — impulses
 * found, how far setups progressed through the state machine, and distributions.
 * No entries, stops, targets, P&L or win rates are computed anywhere.
 *
 * Pure: `runValidation(candlesByPair)` replays `evaluateSetup` at each completed
 * H1 close (searchEndIdx = i) using completed candles only, so it inherits the
 * engine's no-lookahead / no-forming-candle guarantees.
 */

const { evaluateSetup } = require('./_h1c-state');
const { ATR_PERIOD } = require('./_h1c-constants');

const READY_SET = new Set(['CONTINUATION_READY', 'SECOND_PUSH_STARTED', 'CONTINUATION_CONFIRMED']);
const PUSH_SET = new Set(['SECOND_PUSH_STARTED', 'CONTINUATION_CONFIRMED']);
const VALID_SET = new Set(['PULLBACK_VALID', 'CONTINUATION_READY', 'SECOND_PUSH_STARTED', 'CONTINUATION_CONFIRMED']);

function replayPair(candles, startIdx) {
  const seen = {};   // reference identity -> record of states reached
  for (let i = startIdx; i < candles.length; i++) {
    const res = evaluateSetup(candles, { searchEndIdx: i });
    if (!res.reference) continue;
    const dir = res.reference.direction > 0 ? 'BUY' : 'SELL';
    const id = `${dir}:${res.reference.endTime}`;
    const rec = seen[id] || (seen[id] = { dir, states: new Set(), pullbackLen: 0, grade: null, readyIdx: null, confirmIdx: null });
    rec.states.add(res.state);
    if (res.pullback && res.pullback.count) rec.pullbackLen = Math.max(rec.pullbackLen, res.pullback.count);
    if (res.grade) rec.grade = res.grade;
    if (res.state === 'CONTINUATION_READY' && rec.readyIdx === null) rec.readyIdx = i;
    if (res.state === 'CONTINUATION_CONFIRMED' && rec.confirmIdx === null) rec.confirmIdx = i;
  }
  return seen;
}

function runValidation(candlesByPair, opts = {}) {
  const startIdx = opts.startIdx != null ? opts.startIdx : ATR_PERIOD + 6;   // ATR warm-up + minimum pattern.
  const out = {
    impulses: 0, pullback6to12: 0, ready: 0, secondPush: 0, confirmed: 0, invalidated: 0, expired: 0,
    byPullbackLen: {}, byDirection: { BUY: 0, SELL: 0 }, byPair: {}, byGrade: {}, avgReadyToConfirm: null,
  };
  let r2cSum = 0, r2cCount = 0;

  for (const pair of Object.keys(candlesByPair)) {
    const seen = replayPair(candlesByPair[pair] || [], startIdx);
    for (const id of Object.keys(seen)) {
      const rec = seen[id];
      const S = rec.states;
      out.impulses++;
      if ([...VALID_SET].some((s) => S.has(s))) out.pullback6to12++;
      if ([...READY_SET].some((s) => S.has(s))) {
        out.ready++;
        out.byDirection[rec.dir] = (out.byDirection[rec.dir] || 0) + 1;
        out.byPair[pair] = (out.byPair[pair] || 0) + 1;
        if (rec.grade) out.byGrade[rec.grade] = (out.byGrade[rec.grade] || 0) + 1;
        if (rec.pullbackLen) out.byPullbackLen[rec.pullbackLen] = (out.byPullbackLen[rec.pullbackLen] || 0) + 1;
      }
      if ([...PUSH_SET].some((s) => S.has(s))) out.secondPush++;
      if (S.has('CONTINUATION_CONFIRMED')) out.confirmed++;
      if (S.has('INVALIDATED')) out.invalidated++;
      if (S.has('EXPIRED')) out.expired++;
      if (rec.readyIdx != null && rec.confirmIdx != null && rec.confirmIdx >= rec.readyIdx) {
        r2cSum += rec.confirmIdx - rec.readyIdx; r2cCount++;
      }
    }
  }
  out.avgReadyToConfirm = r2cCount ? +(r2cSum / r2cCount).toFixed(2) : null;
  return out;
}

module.exports = { runValidation, replayPair };
