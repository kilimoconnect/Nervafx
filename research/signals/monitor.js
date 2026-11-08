'use strict';

/**
 * Intrabar stop/target monitoring (spec §7, §10) on the FINEST reliable execution data
 * available for the window (M5 where present, else M15 — disclosed per trade). We do not
 * wait for an entry-TF candle to close to recognise an intrabar stop.
 *
 * Resolution rules:
 *   - Gap: if a monitoring bar OPENS beyond the stop, the stop fills at that first
 *     executable (gapped) open — the requested stop is not guaranteed. A favourable gap
 *     through the target fills at the target level (no windfall).
 *   - If one bar touches BOTH stop and target, resolve stop-first (conservative default),
 *     flag ambiguity, and record the alternative (target-first) exit for sensitivity.
 *   - If no stop/target by the holding limit, exit at the first executable mid at/after
 *     the 16th entry candle closes (HOLD_LIMIT).
 *   - If the monitoring window has no reliable data, the trade is UNRESOLVED (never faked).
 *
 * All prices are MID; costs are applied by the caller (lifecycle). Geometry is mid-based.
 */

/**
 * entry:  { direction, fillMid, fillMs, initialStop, target }
 * fine:   ascending [{openMs,open,high,low,close}] finest bars covering (fillMs, holdEndMs]
 * holdEndMs: close time of the 16th entry candle. holdExit: { mid, ms } first executable
 *            quote at/after holdEndMs (undefined => dataset ended while open => UNRESOLVED).
 * fineTf: label of the monitoring resolution ('M5'|'M15').
 */
function resolveOutcome(entry, fine, holdEndMs, holdExit, fineTf) {
  const dir = entry.direction === 'BUY' ? 1 : -1;
  const stop = entry.initialStop, target = entry.target;
  const bars = (fine || []).filter((b) => b.openMs >= entry.fillMs && b.openMs < holdEndMs);

  if (!bars.length) {
    // No intrabar data: fall back to the hold-limit quote if we have it, else unresolved.
    if (holdExit && holdExit.mid != null) {
      return finalize(entry, 'HOLD_LIMIT', holdExit.mid, holdExit.ms, false, null, fineTf, { bars: 0 });
    }
    return { status: 'UNRESOLVED', exitReason: 'UNRESOLVED', reason: 'no intrabar data in holding window', monitorTf: fineTf };
  }

  for (const b of bars) {
    const gapStop = dir === 1 ? (b.open <= stop) : (b.open >= stop);
    const gapTarget = dir === 1 ? (b.open >= target) : (b.open <= target);
    if (gapStop && gapTarget) {
      // Opened beyond both — stop-first at the gapped open; alt = target.
      return finalize(entry, 'STOP', b.open, b.openMs, true, { reason: 'TARGET', exitMid: target }, fineTf, { gap: true });
    }
    if (gapStop) return finalize(entry, 'STOP', b.open, b.openMs, false, null, fineTf, { gap: true });
    if (gapTarget) return finalize(entry, 'TARGET', target, b.openMs, false, null, fineTf, { gap: true });

    const stopHit = dir === 1 ? (b.low <= stop) : (b.high >= stop);
    const targetHit = dir === 1 ? (b.high >= target) : (b.low <= target);
    if (stopHit && targetHit) {
      // Ambiguous bar — stop-first default; record target-first alternative.
      return finalize(entry, 'STOP', stop, b.openMs, true, { reason: 'TARGET', exitMid: target }, fineTf, { ambiguousBar: true });
    }
    if (stopHit) return finalize(entry, 'STOP', stop, b.openMs, false, null, fineTf, {});
    if (targetHit) return finalize(entry, 'TARGET', target, b.openMs, false, null, fineTf, {});
  }

  // Neither hit within the holding window → exit at the hold-limit quote.
  if (holdExit && holdExit.mid != null) return finalize(entry, 'HOLD_LIMIT', holdExit.mid, holdExit.ms, false, null, fineTf, {});
  return { status: 'UNRESOLVED', exitReason: 'UNRESOLVED', reason: 'open at dataset end (no hold-limit quote)', monitorTf: fineTf };
}

function finalize(entry, reason, exitMid, exitMs, ambiguity, alt, fineTf, flags) {
  return {
    status: 'CLOSED', exitReason: reason, exitMid, exitMs,
    ambiguity: !!ambiguity, alternative: alt, monitorTf: fineTf, flags: flags || {},
  };
}

module.exports = { resolveOutcome };
