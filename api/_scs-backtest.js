'use strict';

/**
 * SCS — backtest (pure, deterministic). Drives the EXACT production coordinator
 * over a date range, so candles + structural calculations are identical to live
 * and history (parity). Detects each candidate once (deduped per H4 impulse +
 * BOS candle) and records its realized outcome. Applies bid/ask spread and
 * slippage as a per-trade cost in R, plus swap where provided; weekend opening
 * gaps are already carried by the candle data the coordinator sees. Supports
 * sequential in-sample / out-of-sample periods with no future/past mixing.
 *
 * It never claims profitability — it only reports what the stored outcomes say.
 */

const time = require('./_scs-time');
const { snapToCompletedH1 } = require('./_scs-history');
const { runCoordinator } = require('./_scs-coordinator');
const { computePerformance } = require('./_scs-performance');
const { CONFIG } = require('./_scs-config');

const H1 = time.H1_MS;
const TERMINAL = new Set(['TARGET_HIT', 'STOP_HIT', 'EXPIRED', 'CANCELLED', 'REJECTED']);

/** Backtest one pair over [from,to]; returns the recorded signals (no stats). */
function backtestPair(h1raw, opts) {
  const cfg = opts.config || CONFIG;
  const pair = opts.pair;
  const start = snapToCompletedH1(opts.from);
  const end = snapToCompletedH1(opts.to);
  const closes = new Set(time.normalizeH1(h1raw, end + H1).map((c) => c.openMs + H1)); // actual completed H1 closes
  const spreadP = opts.spread || 0, slipP = opts.slippage || 0, swapR = opts.swapR || 0;

  const seen = new Set();
  const signals = [];
  for (let evalMs = start; evalMs <= end; evalMs += H1) {
    if (!closes.has(evalMs)) continue;                 // only evaluate at real candle closes (weekend-free)
    const co = runCoordinator({ h1raw, evalMs, pair, spread: spreadP, normalSpread: opts.normalSpread, riskPct: opts.riskPct, config: cfg });
    const h1 = co.h1;
    if (!h1 || !h1.candidate) continue;
    if (!TERMINAL.has(h1.status)) continue;
    const key = (h1.candidate.impulseId || '') + '|' + h1.candidate.bosCandleTime;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = h1.candidate.r || 0;
    const costR = r > 0 ? (2 * spreadP + slipP) / r + Math.abs(swapR) : 0;
    signals.push({
      pair, version: cfg.version, time: h1.candidate.bosCandleTime, timeIso: new Date(h1.candidate.bosCandleTime).toISOString(),
      direction: h1.candidate.direction, d1Direction: co.d1.direction,
      impulseOrigin: co.h4.impulse ? co.h4.impulse.origin : null,
      status: h1.status, rejection: h1.rejection, entryFilled: !!(h1.evidence && h1.evidence.fillTime),
      entry: h1.candidate.entry, stop: h1.candidate.stop, target: h1.candidate.target, r,
      costR: +costR.toFixed(4),
    });
  }
  return signals;
}

/** Run a single period across many pairs. `pairs` = { pair: h1raw }. */
function backtestPeriod(pairs, period, opts = {}) {
  const signals = [];
  for (const pair of Object.keys(pairs)) {
    for (const s of backtestPair(pairs[pair], { ...opts, pair, from: period.from, to: period.to })) signals.push(s);
  }
  signals.sort((a, b) => a.time - b.time);
  return { period, signals, performance: computePerformance(signals, opts) };
}

/**
 * Sequential in-sample / out-of-sample backtest (no random mixing of periods).
 * @param {object} input { pairs, inSample:{from,to}, outSample?:{from,to}, spread?, slippage?, swapR?, config? }
 */
function runBacktest(input) {
  const opts = { spread: input.spread, slippage: input.slippage, swapR: input.swapR, normalSpread: input.normalSpread, riskPct: input.riskPct, config: input.config };
  const out = { config: (input.config || CONFIG).version, inSample: backtestPeriod(input.pairs, input.inSample, opts) };
  if (input.outSample) {
    // Out-of-sample strictly AFTER in-sample: guard against overlap.
    if (new Date(input.outSample.from).getTime() < new Date(input.inSample.to).getTime()) throw new Error('out-of-sample must start at/after in-sample end (no future/past mixing)');
    out.outSample = backtestPeriod(input.pairs, input.outSample, opts);
  }
  return out;
}

module.exports = { backtestPair, backtestPeriod, runBacktest, TERMINAL };
