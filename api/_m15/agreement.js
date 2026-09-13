'use strict';

/**
 * M15 Intelligence — agreement engine (§21).
 *
 * Agreement between INDEPENDENT M15 evidence (never between timeframes). Each
 * component is evaluated and stored separately — the overall decision is not a
 * single unexplained score. MANDATORY GATES are checked first; if any fails the
 * result is NO_AGREEMENT / LATE / CONFLICTED with a plain-language reason, and no
 * directional grade is claimed. Only when every gate passes is a directional
 * agreement graded WEAK/BUILDING/STRONG. Pure & deterministic.
 *
 * States: NO_AGREEMENT, WEAK_BULLISH, BULLISH_BUILDING, STRONG_BULLISH,
 * WEAK_BEARISH, BEARISH_BUILDING, STRONG_BEARISH, CONFLICTED, LATE.
 */

const { CONFIG } = require('./config');
const { clamp, mean } = require('./math');

const dirOf = (s) => (s === 'BULLISH' ? 1 : s === 'BEARISH' ? -1 : 0);

function emaVote(state) {
  switch (state) {
    case 'BULLISH_ESTABLISHED': return 1;
    case 'BULLISH_DEVELOPING': return 0.7;
    case 'EARLY_BULLISH_TURN': return 0.5;
    case 'BULLISH_OVEREXTENDED': return 0.3;
    case 'BEARISH_ESTABLISHED': return -1;
    case 'BEARISH_DEVELOPING': return -0.7;
    case 'EARLY_BEARISH_TURN': return -0.5;
    case 'BEARISH_OVEREXTENDED': return -0.3;
    default: return 0; // FLAT/COMPRESSED/CONFLICTED
  }
}

/**
 * @param {object} ctx {
 *   pair, movement, ema, pressure, expansion, energy, eq, freshness,
 *   strengthDiff, baseStrengthAccel, quoteStrengthAccel,
 *   basePower, quotePower, baseStructure, quoteStructure,
 *   gates: { dataComplete, synchronized, spreadPips, spreadCapPips, noCriticalNews }
 * }
 */
function evaluateAgreement(ctx, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const g = ctx.gates || {};
  const reasons = [];
  const failed = [];

  // ── MANDATORY GATES (§21) ────────────────────────────────────────────────
  if (g.dataComplete === false || g.synchronized === false) failed.push('data incomplete or unsynchronized');
  if (g.spreadPips != null && g.spreadCapPips != null && g.spreadPips > g.spreadCapPips) failed.push(`spread too wide (${g.spreadPips.toFixed(1)} > ${g.spreadCapPips}p)`);
  if (ctx.energy && (ctx.energy.energyLevel === 'DEAD' || ctx.energy.energyDirection === 'CHAOTIC')) failed.push(ctx.energy.energyLevel === 'DEAD' ? 'market dead — no capacity to move' : 'energy chaotic — no clean direction');
  if (g.noCriticalNews === false) failed.push('critical economic-event restriction active');

  const overextended = ctx.expansion && (ctx.expansion.state === 'OVEREXTENDED' || ctx.expansion.state === 'DEVELOPED');
  const late = ctx.freshness && (ctx.freshness.state === 'LATE' || ctx.freshness.state === 'EXHAUSTED');
  const spaceOk = !ctx.expansion || ctx.expansion.spaceSufficient !== false;
  const earlyOrPullback = ctx.expansion && (ctx.expansion.focus === true || ctx.pullbackDeveloping === true);

  // ── COMPONENT VOTES (stored separately, §21) ─────────────────────────────
  const components = [];
  const add = (name, dir, reason) => { components.push({ name, dir: clamp(dir, -1, 1), reason }); };
  add('pairStructure', dirOf(ctx.movement ? ctx.movement.direction : 'NEUTRAL'), `pair movement ${ctx.movement ? ctx.movement.direction : 'NEUTRAL'}`);
  add('currencyStrengthDiff', clamp((ctx.strengthDiff || 0) / 100, -1, 1), `strength differential ${Math.round(ctx.strengthDiff || 0)}`);
  add('currencyAcceleration', Math.sign((ctx.baseStrengthAccel || 0) - (ctx.quoteStrengthAccel || 0)) * 0.6, 'currency strength acceleration');
  add('currencyPower', powerVote(ctx), 'base vs quote power');
  add('currencyStructure', structureVote(ctx), 'broad currency structure');
  add('marketEnergyDirection', dirOf(ctx.energy ? ctx.energy.energyDirection : 'BALANCED') * 0.7, `energy ${ctx.energy ? ctx.energy.energyDirection : 'BALANCED'}`);
  add('ema', emaVote(ctx.ema ? ctx.ema.state : 'FLAT'), `EMA ${ctx.ema ? ctx.ema.state : 'FLAT'}`);
  add('expansion', ctx.expansion && ctx.expansion.focus ? dirOf(ctx.expansion.direction) : 0, `expansion ${ctx.expansion ? ctx.expansion.state : 'NONE'}`);
  add('directionalPressure', pressureVote(ctx.pressure), `pressure ${ctx.pressure ? ctx.pressure.pressureState : 'BALANCED'}`);

  const votes = components.map((c) => c.dir);
  const score = mean(votes);
  const bullMass = mean(votes.map((v) => Math.max(0, v)));
  const bearMass = mean(votes.map((v) => Math.max(0, -v)));
  const conflicted = bullMass > 0.25 && bearMass > 0.25 && Math.abs(score) < 0.15;

  // ── DECISION ─────────────────────────────────────────────────────────────
  let state;
  if (failed.length) { state = 'NO_AGREEMENT'; reasons.push(...failed); }
  else if (late) { state = 'LATE'; reasons.push('first tradeable opportunity has passed'); }
  else if (conflicted) { state = 'CONFLICTED'; reasons.push('independent evidence is materially split'); }
  else if (overextended) { state = 'NO_AGREEMENT'; reasons.push('price overextended from equilibrium'); }
  else if (!spaceOk) { state = 'NO_AGREEMENT'; reasons.push('insufficient room to the next obstacle'); }
  else if (!earlyOrPullback) { state = 'NO_AGREEMENT'; reasons.push('no early expansion or first controlled pullback'); }
  else {
    const dir = score > 0 ? 'BULLISH' : 'BEARISH';
    const a = Math.abs(score);
    const agreeShare = votes.filter((v) => Math.sign(v) === Math.sign(score) && v !== 0).length / votes.length;
    if (a >= 0.5 && agreeShare >= 0.6) state = `STRONG_${dir}`;
    else if (a >= 0.3) state = `${dir}_BUILDING`;
    else if (a >= 0.12) state = `WEAK_${dir}`;
    else state = 'NO_AGREEMENT';
    reasons.push(...components.filter((c) => Math.sign(c.dir) === Math.sign(score) && c.dir !== 0).map((c) => c.reason));
  }

  return {
    pair: ctx.pair, state, score: +score.toFixed(3),
    bullMass: +bullMass.toFixed(3), bearMass: +bearMass.toFixed(3),
    gatesPassed: failed.length === 0, gateFailures: failed,
    components, reasons,
  };
}

function powerVote(ctx) {
  const bp = ctx.basePower, qp = ctx.quotePower;
  if (!bp || !qp) return 0;
  const b = bp.powerDirection === 'BULLISH' ? bp.powerScore : bp.powerDirection === 'BEARISH' ? -bp.powerScore : 0;
  const q = qp.powerDirection === 'BULLISH' ? qp.powerScore : qp.powerDirection === 'BEARISH' ? -qp.powerScore : 0;
  return clamp((b - q) / 100, -1, 1);          // base strong + quote weak ⇒ pair up
}

function structureVote(ctx) {
  const s = (rec, invert) => {
    if (!rec) return 0;
    const d = rec.direction === 'BULLISH' ? 1 : rec.direction === 'BEARISH' ? -1 : 0;
    return (invert ? -d : d) * (rec.breadth || 0);
  };
  return clamp(s(ctx.baseStructure, false) * 0.5 + s(ctx.quoteStructure, true) * 0.5, -1, 1);
}

function pressureVote(pressure) {
  if (!pressure) return 0;
  const map = { BALANCED: 0, CONFLICTED: 0, BULLISH_FORMING: 0.4, BULLISH_BUILDING: 0.7, BULLISH_DOMINANT: 1, BEARISH_FORMING: -0.4, BEARISH_BUILDING: -0.7, BEARISH_DOMINANT: -1 };
  return map[pressure.pressureState] ?? 0;
}

module.exports = { evaluateAgreement };
