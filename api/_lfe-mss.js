'use strict';

/**
 * NervaFX Liquidity Failure Engine — M15 control-shift confirmation (Portion 5).
 *
 * Confirms that control flipped on M15 after an H1 liquidity failure:
 *   FAILED BUYERS → SELL when M15 breaks a prior swing low.
 *   FAILED SELLERS → BUY when M15 breaks a prior swing high.
 *
 * Timing is strict and lookahead-free: the structure break must occur AFTER the
 * M15 liquidity breach, the signal is released only once the H1 failure candle
 * has closed, and everything expires eight M15 candles after the H1 failure.
 */

const { HOUR_MS, M15_MS, CONFIG, MSS_STATUS } = require('./_lfe-constants');
const { candleFeatures, pipSizeFor } = require('./_lfe-math');

const closeMs = (c) => c.openMs + M15_MS;
const body = (c) => Math.abs(c.close - c.open);
const rangeOf = (c, pip) => Math.max(c.high - c.low, pip);

function lastNonNull(arr) {
  if (!arr) return null;
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

/** Confirmed M15 pivots (2/2). availableAtMs = close of the confirming right bar. */
function m15Pivots(candles, left, right) {
  const out = [];
  for (let i = left; i + right < candles.length; i++) {
    const c = candles[i];
    let ok = true, strict = false;
    for (let k = i - left; k <= i + right; k++) {
      if (k === i) continue;
      if (candles[k].high > c.high) { ok = false; break; }
      if (candles[k].high < c.high) strict = true;
    }
    if (ok && strict) out.push({ index: i, type: 'HIGH', price: c.high, pivotAtMs: c.openMs, availableAtMs: closeMs(candles[i + right]) });
    ok = true; strict = false;
    for (let k = i - left; k <= i + right; k++) {
      if (k === i) continue;
      if (candles[k].low < c.low) { ok = false; break; }
      if (candles[k].low > c.low) strict = true;
    }
    if (ok && strict) out.push({ index: i, type: 'LOW', price: c.low, pivotAtMs: c.openMs, availableAtMs: closeMs(candles[i + right]) });
  }
  return out;
}

/**
 * @param {object} event  H1 failure event (Portion 4)
 * @param {Array}  m15     completed M15 candles ≤ evalMs, ascending
 * @param {Array}  m15Atr  M15 ATR series aligned to m15 (nullable)
 * @param {object} opts    { evalMs, m15AtrNow, spread, cfg }
 */
function confirmM15(event, m15, m15Atr, opts) {
  opts = opts || {};
  const cfg = opts.cfg || CONFIG;
  const evalMs = opts.evalMs != null ? opts.evalMs : Infinity;
  const spread = opts.spread || 0;
  const isSell = event.direction === 'SELL';        // failed buyers
  const L = event.levelCentre;
  const failureAtMs = event.failureAtMs;
  const sweep = event.sweepExtreme;
  const pip = pipSizeFor(event.pair);
  const atrNow = opts.m15AtrNow != null ? opts.m15AtrNow : lastNonNull(m15Atr);
  const atrAt = (i) => (m15Atr && m15Atr[i] != null ? m15Atr[i] : atrNow);

  if (!m15 || !m15.length || !atrNow) return { status: MSS_STATUS.UNCONFIRMED, reason: 'NO_M15' };

  // 1. The M15 candle that breached the H1 level (first crossing near the breach).
  const searchFrom = (event.breachAtMs != null ? event.breachAtMs : failureAtMs) - HOUR_MS;
  let breachIdx = -1;
  for (let i = 0; i < m15.length; i++) {
    if (m15[i].openMs < searchFrom) continue;
    if ((isSell && m15[i].high > L) || (!isSell && m15[i].low < L)) { breachIdx = i; break; }
  }
  if (breachIdx < 0) return { status: MSS_STATUS.UNCONFIRMED, reason: 'NO_M15_BREACH' };
  const breachTime = closeMs(m15[breachIdx]);

  // 2–5. Latest confirmed pivot (low for SELL, high for BUY) within 16 candles
  // before the breach — the structure level to break.
  const wantType = isSell ? 'LOW' : 'HIGH';
  const pivots = m15Pivots(m15, cfg.pivot.m15Left, cfg.pivot.m15Right);
  let breakLevel = null;
  for (const p of pivots) {
    if (p.type !== wantType) continue;
    if (p.index >= breachIdx) continue;                    // must predate the breach
    if (p.index < breachIdx - cfg.m15Confirm.lookbackPivots) continue;
    if (p.availableAtMs > breachTime) continue;            // confirmed before the breach
    if (breakLevel == null || p.index > breakLevel.index) breakLevel = p;
  }
  if (!breakLevel) return { status: MSS_STATUS.UNCONFIRMED, reason: 'NO_M15_PIVOT', breachTime };

  const windowEnd = failureAtMs + cfg.m15Confirm.windowCandles * M15_MS;

  // Scan candles strictly after the breach for confirmation / invalidation.
  for (let i = breachIdx + 1; i < m15.length; i++) {
    const c = m15[i];
    const cClose = closeMs(c);
    if (cClose > evalMs) break;              // never look past the evaluation time
    if (cClose > windowEnd) break;           // past the confirmation window
    const a = atrAt(i);
    const buffer = Math.max(cfg.m15Confirm.bufferAtr * a, spread);
    const f = candleFeatures(c, a, pip);
    const ratio = body(c) / rangeOf(c, pip);

    let confirm;
    if (isSell) {
      confirm = c.close < breakLevel.price - buffer && c.close < c.open
        && body(c) >= cfg.m15Confirm.minBodyAtr * a && ratio >= cfg.m15Confirm.minBodyRatio
        && f.closeLocation <= cfg.m15Confirm.closeLocSell;
    } else {
      confirm = c.close > breakLevel.price + buffer && c.close > c.open
        && body(c) >= cfg.m15Confirm.minBodyAtr * a && ratio >= cfg.m15Confirm.minBodyRatio
        && f.closeLocation >= cfg.m15Confirm.closeLocBuy;
    }
    if (confirm) {
      const released = evalMs >= failureAtMs;   // H1 failure candle must have closed
      return {
        status: released ? MSS_STATUS.CONFIRMED : MSS_STATUS.PENDING,
        breakLevel: breakLevel.price,
        m15Buffer: buffer,
        breachTime,
        confirmIdx: i,
        confirmAtMs: cClose,
        confirmClose: c.close,
        confirmCandle: c,
        nextOpen: i + 1 < m15.length ? m15[i + 1].open : null,
        m15AtrAt: a,
        windowEndMs: windowEnd,
      };
    }
    // Invalidation: the sweep extreme is taken out again before any confirmation.
    if ((isSell && c.high > sweep) || (!isSell && c.low < sweep)) {
      return { status: MSS_STATUS.INVALIDATED, breakLevel: breakLevel.price, breachTime, atMs: cClose };
    }
  }

  if (evalMs >= windowEnd) return { status: MSS_STATUS.EXPIRED, breakLevel: breakLevel.price, breachTime, windowEndMs: windowEnd };
  return { status: MSS_STATUS.WAITING, breakLevel: breakLevel.price, breachTime, windowEndMs: windowEnd };
}

module.exports = { confirmM15, m15Pivots };
