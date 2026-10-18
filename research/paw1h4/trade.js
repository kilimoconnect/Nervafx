'use strict';

/**
 * Suggested trade + simulated exits (step 8). Hypothetical, mid-candle economics
 * with explicit, configurable costs (spread, slippage, commission, financing). No
 * broker path, no averaging / martingale / trailing / auto break-even. Entry is the
 * next H4 open after confirmation; stop and target are FROZEN at entry.
 *
 *   • Stop   = beyond the confirmed higher-low / lower-high by an execution buffer.
 *   • Target = nearest OPPOSING confirmed weekly swing level beyond entry, known at
 *              signal time. Reject if none, or if estimated R:R after costs < min.
 *   • Gaps at the actual entry open can invalidate the trade.
 *   • If stop and target are both inside one H4 candle and the intrabar order is
 *     unknown, use conservative STOP-FIRST and report it.
 *   • Time exit after `exitH4Bars` completed H4 candles if neither level is reached.
 */

const { pipSize } = require('./config');

function simulateTrade(opp, h4cands, weeklyLevels, cfg) {
  const d = opp.dir === 'BUY' ? 1 : -1;
  const pip = pipSize(opp.pair || cfg.pair || 'EUR_USD');
  const ex = cfg.execution;
  const halfSpread = (ex.spreadPips / 2) * pip;
  const slip = ex.slippagePips * pip;
  const buffer = ex.bufferPips * pip;
  const commission = ex.commissionPips * pip;        // per side
  const financing = ex.financingPipsPerBar * pip;    // per held bar

  if (opp.entryBarIdx == null) return { accepted: false, rejectReason: 'no_entry_bar', dir: opp.dir };

  const entryMid = opp.entryPrice;
  const entryFill = entryMid + d * (halfSpread + slip);           // adverse fill at entry
  const stop = opp.stopRef - d * buffer;                           // beyond the structural stop
  const riskPrice = Math.abs(entryFill - stop);
  if (!(riskPrice > 0)) return { accepted: false, rejectReason: 'zero_risk', dir: opp.dir };

  // Target: nearest opposing confirmed weekly level beyond the entry (known @ signal).
  let target = null;
  if (d > 0) { const above = (weeklyLevels.highs || []).filter((p) => p > entryFill); if (above.length) target = Math.min.apply(null, above); }
  else { const below = (weeklyLevels.lows || []).filter((p) => p < entryFill); if (below.length) target = Math.max.apply(null, below); }
  if (target == null) return { accepted: false, rejectReason: 'no_target', dir: opp.dir, entryFill, stop, riskPrice };

  const rewardPrice = Math.abs(target - entryFill);
  const exitCost = halfSpread + slip + commission;                // adverse cost on the exit fill
  const rrPlanned = (rewardPrice - exitCost) / riskPrice;
  if (rrPlanned < cfg.minRewardRisk) return { accepted: false, rejectReason: 'rr_below_min', dir: opp.dir, entryFill, stop, target, rrPlanned };

  // Gap recheck at the actual entry open (the entry bar may open beyond stop/target).
  const entryBar = h4cands[opp.entryBarIdx];
  if (d > 0 ? entryBar.open <= stop : entryBar.open >= stop) return { accepted: false, rejectReason: 'gap_through_stop', dir: opp.dir, entryFill, stop, target };
  if (d > 0 ? entryBar.open >= target : entryBar.open <= target) return { accepted: false, rejectReason: 'gap_through_target', dir: opp.dir, entryFill, stop, target };

  // Walk forward (stop/target frozen). Entry fills at the entry bar's open; we begin
  // checking from the entry bar itself.
  const maxBars = cfg.exitH4Bars;
  let exit = null;
  for (let k = 0; k < maxBars; k++) {
    const bar = h4cands[opp.entryBarIdx + k];
    if (!bar) break;
    const hitStop = d > 0 ? bar.low <= stop : bar.high >= stop;
    const hitTarget = d > 0 ? bar.high >= target : bar.low <= target;
    if (hitStop && hitTarget) {                                    // ambiguous → conservative stop-first
      exit = { reason: cfg.execution.stopFirstOnAmbiguity ? 'stop_ambiguous' : 'target_ambiguous', level: cfg.execution.stopFirstOnAmbiguity ? stop : target, barIdx: opp.entryBarIdx + k, ms: bar.closeMs, ambiguous: true, barsHeld: k + 1 };
      break;
    }
    if (hitStop) { exit = { reason: 'stop', level: stop, barIdx: opp.entryBarIdx + k, ms: bar.closeMs, ambiguous: false, barsHeld: k + 1 }; break; }
    if (hitTarget) { exit = { reason: 'target', level: target, barIdx: opp.entryBarIdx + k, ms: bar.closeMs, ambiguous: false, barsHeld: k + 1 }; break; }
  }
  if (!exit) {
    const lastIdx = Math.min(opp.entryBarIdx + maxBars - 1, h4cands.length - 1);
    const bar = h4cands[lastIdx];
    if (!bar) return { accepted: true, pending: true, dir: opp.dir, entryFill, stop, target, rrPlanned };
    exit = { reason: 'time', level: bar.close, barIdx: lastIdx, ms: bar.closeMs, ambiguous: false, barsHeld: lastIdx - opp.entryBarIdx + 1 };
  }

  const exitFill = exit.level - d * (halfSpread + slip);           // adverse fill at exit
  const pnlPrice = (exitFill - entryFill) * d - commission - financing * exit.barsHeld;
  const R = pnlPrice / riskPrice;

  return {
    accepted: true, dir: opp.dir, pair: opp.pair || cfg.pair,
    signalCloseMs: opp.signalCloseMs, entryBarIdx: opp.entryBarIdx, entryOpenMs: opp.entryOpenMs,
    entryMid, entryFill, stop, target, riskPrice, rewardPrice, rrPlanned,
    exit, R: +R.toFixed(4), barsHeld: exit.barsHeld, ambiguous: exit.ambiguous,
    win: R > 0,
  };
}

module.exports = { simulateTrade };
