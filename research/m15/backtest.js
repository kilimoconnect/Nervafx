'use strict';

/**
 * M15 Strategy Research — outcome engine (Stage 4). Pure, deterministic, and
 * causal: a signal is detected at close T using only data ≤ T; the OUTCOME is
 * simulated forward from the NEXT candle. No trade benefits from a future candle or
 * an optimistic unknown fill. Data is MID-only, so every economic result is an
 * ESTIMATE (spread/slippage modelled transparently), never confirmed.
 *
 * REFERENCE simulation (predeclared, one per pair open at a time):
 *  - entry: OPEN of the candle `delayCandles` after the signal (earliest realistic
 *    manual quote) — never the signal close.
 *  - protective risk: M15 ATR14-derived stop (stopMult · ATR) → defines R.
 *  - hold: max `holdCandles` (default 4 = one hour); exit at stop or timeout.
 *  - gap: if the bar OPENS beyond the stop, exit at the (worse) open.
 *  - same-bar ambiguity: if a bar's low/high merely TOUCHES the stop, resolve
 *    conservatively AS A STOP (never in the trade's favour).
 *  - source-stale: a non-contiguous candle between signal and entry ⇒ excluded.
 *  - spread cost: one full round-trip `spreadPips` subtracted from the mid P&L.
 */

const M15 = 15 * 60 * 1000;

function pipOf(pair) { return pair.endsWith('_JPY') ? 0.01 : 0.0001; }
function trueRange(c, p) { const hl = c.high - c.low; return p ? Math.max(hl, Math.abs(c.high - p.close), Math.abs(c.low - p.close)) : hl; }

/** Mean true range over the `period` candles ending at idx (uses only ≤ idx). */
function atrAt(candles, idx, period = 14) {
  const start = Math.max(1, idx - period + 1); let sum = 0, n = 0;
  for (let i = start; i <= idx; i++) { sum += trueRange(candles[i], candles[i - 1]); n++; }
  return n ? sum / n : 0;
}

/**
 * Reference outcome. `signalIdx` = index of the signal frame candle (closed at T).
 * Returns a labelled, estimated result. Excluded/no-fill cases carry `label` and no
 * economics.
 */
function simulateReference(candles, signalIdx, direction, opts = {}) {
  const pip = opts.pip, dir = direction === 'LONG' ? 1 : -1;
  const delay = opts.delayCandles != null ? opts.delayCandles : 1;
  const hold = opts.holdCandles || 4;
  const stopMult = opts.stopMult != null ? opts.stopMult : 1.0;
  const spreadPips = opts.spreadPips || 0;
  const entryIdx = signalIdx + delay;
  if (entryIdx >= candles.length) return { label: 'NO_DATA_ENTRY' };            // end of data
  // source-stale / gap between signal and entry ⇒ excluded (never enter post-gap as if immediate)
  if (candles[entryIdx].openMs - candles[signalIdx].openMs !== delay * M15) return { label: 'STALE_GAP_EXCLUDED' };

  const atr = opts.atr != null ? opts.atr : atrAt(candles, signalIdx);
  const stopDist = stopMult * atr;
  if (!(stopDist > 0)) return { label: 'NO_RISK_UNDEFINED' };

  const entryMid = candles[entryIdx].open;
  const stop = entryMid - dir * stopDist;
  let exitMid = null, reason = null, ambiguous = false, mae = 0, mfe = 0, holdBars = 0;
  for (let k = 0; k < hold; k++) {
    const idx = entryIdx + k; if (idx >= candles.length) break;
    holdBars = k + 1; const c = candles[idx];
    mae = Math.max(mae, (dir > 0 ? entryMid - c.low : c.high - entryMid) / stopDist);
    mfe = Math.max(mfe, (dir > 0 ? c.high - entryMid : entryMid - c.low) / stopDist);
    const gapped = dir > 0 ? c.open <= stop : c.open >= stop;
    const touched = dir > 0 ? c.low <= stop : c.high >= stop;
    if (gapped) { exitMid = c.open; reason = 'gap_through_stop'; break; }
    if (touched) { exitMid = stop; reason = 'stop'; ambiguous = true; break; }   // conservative: treat touch as stop
  }
  if (exitMid == null) { const idx = Math.min(entryIdx + hold - 1, candles.length - 1); exitMid = candles[idx].close; reason = 'timeout'; }

  const grossPnl = dir * (exitMid - entryMid);
  const netPnl = grossPnl - spreadPips * pip;                                    // one full round-trip spread
  const risk = stopDist;
  return {
    label: 'FILLED', reason, ambiguous,
    entryIso: new Date(candles[entryIdx].openMs).toISOString(),
    grossPips: +(grossPnl / pip).toFixed(2), netPips: +(netPnl / pip).toFixed(2),
    grossR: +(grossPnl / risk).toFixed(3), netR: +(netPnl / risk).toFixed(3),
    maeR: +mae.toFixed(3), mfeR: +mfe.toFixed(3), holdBars,
    riskPips: +(risk / pip).toFixed(2),
  };
}

/** Directional edge (separate from economics): forward N-bar mid movement from the signal close. */
function forwardMovement(candles, signalIdx, direction, N, opts = {}) {
  const pip = opts.pip, dir = direction === 'LONG' ? 1 : -1;
  const j = signalIdx + N; if (j >= candles.length) return null;
  if (candles[j].openMs - candles[signalIdx].openMs !== N * M15) return { N, gap: true };
  const move = candles[j].close - candles[signalIdx].close;
  const atr = opts.atr != null ? opts.atr : atrAt(candles, signalIdx);
  return { N, pips: +(move / pip).toFixed(2), r: atr > 0 ? +(move / atr).toFixed(3) : null, dirCorrect: Math.sign(move) === dir };
}

module.exports = { M15, pipOf, atrAt, trueRange, simulateReference, forwardMovement };
