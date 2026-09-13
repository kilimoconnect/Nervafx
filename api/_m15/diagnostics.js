'use strict';

/**
 * M15 Intelligence — gate-waterfall diagnostics (Phase 1, read-only).
 *
 * Given a coordinator pair record produced with `diagnostics:true`, this reports
 * — WITHOUT altering any decision — every relevant gate's measurement, threshold
 * and pass/fail/na status, plus which gate is the DISPLAYED primary rejection and
 * why. It reads only the engine outputs the decision already used; it never
 * recomputes or changes them. `predictPrimary` re-derives the displayed decision
 * from the same priority order used by strategy.decide(), so a test can prove the
 * instrumentation agrees with the untouched decision.
 *
 * Denominators (the caller aggregates with these labels):
 *   evaluation      — every pair-at-close (28 × closes)
 *   candidate       — a strategy routed for the pair (routeStrategy != null)
 *   eligibleSetup   — a setup object was built (entry/stop exist)
 *   episode         — a deduplicated armed/opportunity run across candles
 */

const { CONFIG } = require('./config');

/** The exact priority order strategy.decide() uses to pick the shown rejection. */
const PRIORITY = ['DEAD', 'CHAOTIC', 'CONFLICTED', 'LATE', 'OVEREXTENDED', 'INSUFFICIENT_SPACE', 'SPREAD'];

function gateWaterfall(rec, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const d = rec.diag;
  if (!d) throw new Error('gateWaterfall requires a record built with diagnostics:true');
  const ms = d.marketState.state;
  const ag = d.agreement, fr = d.freshness, ex = d.expansion, en = d.energy;

  const routed = !!rec.strategy;
  const setupExists = !!rec.setup;

  const gates = [];
  const g = (name, fail, measurement, threshold, extra = {}) =>
    gates.push({ name, status: fail ? 'FAIL' : 'PASS', measurement, threshold, ...extra });

  // 1 DEAD — market has no capacity to move.
  g('DEAD', ms === 'DEAD',
    { energyScore: en.energyScore, energyLevel: en.energyLevel }, `energyScore < ${cfg.energy.deadBelow}`);

  // 2 CHAOTIC — high volatility level with poor directional efficiency.
  g('CHAOTIC', ms === 'CHAOTIC',
    { volatilityLevel: en.components.volatilityLevel, efficiency: en.components.efficiency, energyDirection: en.energyDirection },
    `volatilityLevel > ${cfg.energy.chaosLevelThreshold} AND efficiency < 0.35`);

  // 3 CONFLICTED — independent evidence materially split.
  g('CONFLICTED', ag.state === 'CONFLICTED',
    { bullMass: ag.bullMass, bearMass: ag.bearMass, score: ag.score },
    'bullMass > 0.25 AND bearMass > 0.25 AND |score| < 0.15');

  // 4 LATE — first opportunity has passed (distance / developed / decelerating).
  g('LATE', fr.state === 'LATE' || fr.state === 'EXHAUSTED',
    { freshness: fr.state, distanceVol: fr.distanceVol, decelerating: fr.decelerating, completedCycles: fr.completedCycles },
    `distanceVol >= ${cfg.freshness.lateDistVolMult} (EXHAUSTED >= ${cfg.freshness.exhaustedDistVolMult})`);

  // 5 OVEREXTENDED — price exhaustively far from equilibrium.
  g('OVEREXTENDED', ex.state === 'OVEREXTENDED',
    { expansion: ex.state, distanceVol: ex.distanceVol },
    `|distanceVol| >= ${cfg.expansion.overextendedDistVolMult}`);

  // 6 INSUFFICIENT_SPACE — price-to-nearest-prior-leg-extreme in vol units.
  //   NOTE (§Phase-1 trace): this is measured from CURRENT PRICE to the nearest
  //   prior structural leg extreme in the travel direction — NOT from a candidate
  //   entry/stop, and it is evaluated for every pair whether or not a setup exists.
  //   When no candidate/setup exists we flag it not-applicable-to-a-trade.
  g('INSUFFICIENT_SPACE', ex.spaceSufficient === false,
    { availableSpaceVol: ex.availableSpaceVol, basis: 'price→nearest prior leg extreme' },
    `spaceVol >= ${cfg.space.minSpaceVolMult}`,
    { tradeApplicable: setupExists, naForTrade: !setupExists });

  // 7 SPREAD — replay has no live quotes, so spread=0 and this never fires here.
  const spreadFail = (ag.gateFailures || []).some((x) => /spread/.test(x));
  g('SPREAD', spreadFail, { gateFailures: ag.gateFailures }, 'spreadPips <= cap',
    { naInReplay: true });

  // Separate agreement outcome (not a hard gate in the priority list, but the
  // most common terminal state — reported for overlap analysis).
  const noAgreement = ag.state === 'NO_AGREEMENT';
  g('NO_AGREEMENT', noAgreement, { agreement: ag.state, reasons: ag.reasons },
    'all mandatory gates pass AND a directional grade is reached', { terminalNotPriority: true });

  const failing = gates.filter((x) => x.status === 'FAIL');
  const primaryPredicted = predictPrimary(d, routed, agreeDir(ag), gradeAgree(ag));

  return {
    pair: rec.pair,
    decision: rec.decision,            // authoritative displayed primary
    marketState: ms,
    agreement: ag.state,
    routed, setupExists,
    primaryPredicted,                  // re-derived; should map to rec.decision
    failingGates: failing.map((x) => x.name),
    gates,
  };
}

function agreeDir(ag) {
  return /BULLISH/.test(ag.state) ? 'BULLISH' : /BEARISH/.test(ag.state) ? 'BEARISH' : null;
}
function gradeAgree(ag) { return /^STRONG_/.test(ag.state) || /_BUILDING$/.test(ag.state); }

/**
 * Re-derive the displayed decision from the same order strategy.decide() uses.
 * Returns the decision string; a Phase-1 test asserts it equals rec.decision.
 */
function predictPrimary(d, routed, dir, strongOrBuilding) {
  const ms = d.marketState.state, ag = d.agreement, fr = d.freshness, ex = d.expansion;
  if (ms === 'DEAD') return 'NO_TRADE_DEAD';
  if (ms === 'CHAOTIC') return 'NO_TRADE_CHAOTIC';
  if (ag.state === 'CONFLICTED') return 'NO_TRADE_CONFLICTED';
  if (fr.state === 'LATE' || fr.state === 'EXHAUSTED') return 'NO_TRADE_LATE';
  if (ex.state === 'OVEREXTENDED') return 'NO_TRADE_OVEREXTENDED';
  if (ex.spaceSufficient === false) return 'NO_TRADE_INSUFFICIENT_SPACE';
  if ((ag.gateFailures || []).some((x) => /spread/.test(x))) return 'NO_TRADE_SPREAD';
  if (!routed || !dir) {
    if (ms === 'COMPRESSION') return 'WATCH_COMPRESSION';
    if (/_PRESSURE$/.test(ms)) return 'WATCH_PRESSURE';
    return 'NO_TRADE_CONFLICTED';
  }
  if (strongOrBuilding) return dir === 'BULLISH' ? 'ARMED_BULLISH' : 'ARMED_BEARISH';
  return 'WATCH_PRESSURE';
}

/**
 * Deduplicate armed frames into setup EPISODES (§3). A setup that stays armed for
 * several consecutive closes is ONE episode, not many. Input is a per-close
 * timeline (ascending) mapping pair → {decision, direction, strategy}. Returns one
 * record per episode with its lifecycle: first detected, age in candles, last
 * state, and an end reason (invalidated / cooled-to-watch / expired / ended /
 * still-open). Triggered/filled outcomes are NOT inferred here — replay has no
 * live quotes, so those are reported separately and labelled ambiguous.
 */
function isArmed(dec) { return /^ARMED_/.test(dec) || /^MANUAL_(BUY|SELL)_OPPORTUNITY$/.test(dec); }

function reduceEpisodes(timeline, opts = {}) {
  const expiry = opts.expiryCandles || (CONFIG.trigger.expiryCandles);
  const open = {}, episodes = [];
  const finish = (e, reason) => ({
    pair: e.pair, direction: e.direction, strategy: e.strategy,
    firstMs: e.firstMs, firstIso: new Date(e.firstMs).toISOString(),
    lastMs: e.lastMs, lastIso: new Date(e.lastMs).toISOString(),
    ageCandles: e.ageCandles, lastDecision: e.lastDecision,
    endReason: e.ageCandles > expiry ? 'expired_unfilled' : reason,
  });
  for (const frame of timeline) {
    for (const pair of Object.keys(frame.pairs)) {
      const s = frame.pairs[pair];
      const cur = open[pair];
      if (isArmed(s.decision)) {
        if (cur && cur.direction === s.direction && cur.strategy === s.strategy) {
          cur.lastMs = frame.ms; cur.ageCandles++; cur.lastDecision = s.decision;
        } else {
          if (cur) episodes.push(finish(cur, 'superseded'));
          open[pair] = { pair, direction: s.direction, strategy: s.strategy, firstMs: frame.ms, lastMs: frame.ms, ageCandles: 1, lastDecision: s.decision };
        }
      } else if (cur) {
        const reason = /^NO_TRADE_/.test(s.decision) ? `invalidated:${s.decision}` : /^WATCH_/.test(s.decision) ? 'cooled_to_watch' : 'ended';
        episodes.push(finish(cur, reason)); delete open[pair];
      }
    }
  }
  for (const p of Object.keys(open)) episodes.push(finish(open[p], 'still_open_at_window_end'));
  return episodes;
}

module.exports = { gateWaterfall, predictPrimary, reduceEpisodes, isArmed, PRIORITY };
