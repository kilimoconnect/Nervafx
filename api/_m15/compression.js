'use strict';

/**
 * M15 Intelligence — compression engine (§18).
 *
 * Compression is detected from ADAPTIVE behaviour — volatility contracting
 * versus its own baseline, directional velocity declining, structural excursions
 * shrinking, price repeatedly returning to equilibrium, efficiency falling, and
 * EMA20/EMA50 converging — NEVER "N candles inside a box" (§6, §18). It measures
 * a contraction ratio (fast vol ÷ slow vol) and blends the other evidence, then
 * classifies NONE / FORMING / ACTIVE / TIGHT / RELEASING / FAILED.
 *
 * Pure & no-lookahead. Takes optional pre-computed structure/eq/energy/ema/
 * movement so the coordinator does not recompute them.
 */

const { CONFIG } = require('./config');
const { volatilitySeries, clamp, ramp } = require('./math');
const { pipSize } = require('./pairs');
const { detectStructure, EV } = require('./structure');

function evaluateCompression(candles, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const pair = opts.pair || 'EUR_USD';
  const c = cfg.compression;
  const n = candles.length;
  if (n < 10) return { pair, state: 'NONE', score: 0, insufficient: true };

  const volFastArr = volatilitySeries(candles, cfg.volatility.fastHalfLifeCandles);
  const volSlowArr = volatilitySeries(candles, cfg.volatility.sessionHalfLifeCandles);
  const volFast = volFastArr[n - 1], volSlow = volSlowArr[n - 1] || pipSize(pair);
  const ratio = volSlow > 0 ? volFast / volSlow : 1;      // <1 ⇒ contracting

  const structure = opts.structure || detectStructure(candles, { pair, cfg, spread: opts.spread || 0 });
  const emaCompressed = opts.ema ? opts.ema.compressed : false;
  const efficiencyLow = opts.movement ? opts.movement.efficiency < 0.5 : false;
  const nearEq = opts.eq ? Math.abs(opts.eq.distanceVol) < 1.0 : false;

  // Shrinking structural excursions: compare the most recent leg to the prior one.
  let shrinking = false;
  const legs = structure.legs;
  if (legs.length >= 2) shrinking = legs[legs.length - 1].displacement < legs[legs.length - 2].displacement;

  // Contraction score 0..1 (1 = very tight). ramp is 0 at releaseRatio, 1 at tightRatio.
  const contraction = clamp(ramp(ratio, c.releaseVolExpandRatio, c.tightRatio), 0, 1);
  const evidence = [contraction, emaCompressed ? 1 : 0, efficiencyLow ? 1 : 0, nearEq ? 1 : 0, shrinking ? 1 : 0];
  const score = +(evidence.reduce((s, v) => s + v, 0) / evidence.length).toFixed(3);

  const lastEv = structure.events[structure.events.length - 1];
  const failed = lastEv && (lastEv.type === EV.UP_FAIL || lastEv.type === EV.DN_FAIL) && ratio < 1;

  const expanding = ratio > c.releaseVolExpandRatio;
  const wasCompressed = opts.prevState === 'ACTIVE' || opts.prevState === 'TIGHT' || opts.prevState === 'FORMING';

  let state;
  if (expanding && wasCompressed) {
    // Vol expanding directly out of a prior compression ⇒ releasing. RELEASING is
    // a transition owned by the coordinator via prevState, not a candle window.
    state = 'RELEASING';
  } else if (failed) {
    state = 'FAILED';
  } else if (ratio <= c.tightRatio) {
    state = 'TIGHT';
  } else if (ratio <= c.volContractRatio) {
    state = 'ACTIVE';
  } else if (ratio < 0.92 || score >= 0.5) {
    state = 'FORMING';
  } else {
    state = 'NONE';
  }

  return {
    pair, state, score, contractionRatio: +ratio.toFixed(3), expanding,
    evidence: { contraction: +contraction.toFixed(3), emaCompressed, efficiencyLow, nearEquilibrium: nearEq, shrinkingExcursions: shrinking },
    volFast, volSlow,
  };
}

module.exports = { evaluateCompression };
