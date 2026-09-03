'use strict';

/**
 * SCS — Section 3: ATR, swings and Break of Structure (pure, no-repaint).
 *
 * Reusable by live evaluation, history and backtesting. All functions take
 * completed candles ({openMs, open, high, low, close}) and never look ahead.
 */

const { CONFIG, REJECTION } = require('./_scs-config');

const round = (v, d = 6) => { const p = 10 ** d; return Math.round(v * p) / p; };

// ── ATR(14), Wilder's smoothing ──────────────────────────────────────────────
function trueRanges(candles) {
  const tr = new Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) { tr[i] = c.high - c.low; continue; }
    const pc = candles[i - 1].close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  }
  return tr;
}
/** Per-index Wilder ATR; atr[i] uses candles[0..i]; null until `period` candles exist. */
function atrSeries(candles, period = CONFIG.atrPeriod) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < period) return out;
  const tr = trueRanges(candles);
  let sum = 0; for (let i = 0; i < period; i++) sum += tr[i];
  out[period - 1] = sum / period;
  for (let i = period; i < n; i++) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}
function atrAt(candles, i, period = CONFIG.atrPeriod) { return atrSeries(candles.slice(0, i + 1), period)[i]; }

// ── swings (strict, confirmed only after `right` candles close) ───────────────
function swingId(kind, openMs) { return `${kind}-${openMs}`; }

/**
 * Confirmed swing highs: strictly-higher high than `left` before and `right`
 * after. Only indices with `right` completed candles after them are returned, so
 * results never repaint. Equal highs do not qualify (strict).
 */
function swingHighs(candles, left = CONFIG.swingLeft, right = CONFIG.swingRight) {
  const out = [];
  for (let i = left; i <= candles.length - 1 - right; i++) {
    const h = candles[i].high;
    let ok = true;
    for (let k = 1; k <= left && ok; k++) if (!(h > candles[i - k].high)) ok = false;
    for (let k = 1; k <= right && ok; k++) if (!(h > candles[i + k].high)) ok = false;
    if (ok) out.push({ id: swingId('SH', candles[i].openMs), index: i, openMs: candles[i].openMs, time: new Date(candles[i].openMs).toISOString(), price: h, kind: 'HIGH' });
  }
  return out;
}
function swingLows(candles, left = CONFIG.swingLeft, right = CONFIG.swingRight) {
  const out = [];
  for (let i = left; i <= candles.length - 1 - right; i++) {
    const l = candles[i].low;
    let ok = true;
    for (let k = 1; k <= left && ok; k++) if (!(l < candles[i - k].low)) ok = false;
    for (let k = 1; k <= right && ok; k++) if (!(l < candles[i + k].low)) ok = false;
    if (ok) out.push({ id: swingId('SL', candles[i].openMs), index: i, openMs: candles[i].openMs, time: new Date(candles[i].openMs).toISOString(), price: l, kind: 'LOW' });
  }
  return out;
}

// ── wick-vs-close (BOS validity) ─────────────────────────────────────────────────────────────
/**
 * Evaluate one candle breaking one confirmed swing in `dir` (+1 bullish above a
 * swing high, -1 bearish below a swing low). Returns full evidence.
 *
 * `structureOnly` (used for the D1 directional bias and the H4 impulse) requires
 * only a confirmed close beyond the swing by the minimum penetration — it does
 * NOT apply the body / close-location / max-range entry-quality gates, so strong
 * momentum breaks (whose range legitimately exceeds 2 ATR) still count as a
 * structural break. The H1 ENTRY keeps the full gate.
 */
function detectBOS(candle, swing, atr, dir, cfg = CONFIG, structureOnly = false) {
  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const closeLoc = range > 0 ? (dir > 0 ? (candle.close - candle.low) / range : (candle.high - candle.close) / range) : 0;
  const beyondClose = dir > 0 ? candle.close - swing.price : swing.price - candle.close;      // >0 ⇒ closed beyond
  const beyondWick = dir > 0 ? candle.high - swing.price : swing.price - candle.low;          // >0 ⇒ pierced
  const ev = {
    swingId: swing.id, swingTime: swing.time, swingPrice: swing.price, direction: dir > 0 ? 'BULLISH' : 'BEARISH',
    candleOpenMs: candle.openMs, candleTime: new Date(candle.openMs).toISOString(),
    atr: round(atr), penetration: round(Math.max(0, beyondClose)),
    penetrationAtr: atr > 0 ? round(Math.max(0, beyondClose) / atr) : 0,
    body: round(body), bodyAtr: atr > 0 ? round(body / atr) : 0,
    range: round(range), rangeAtr: atr > 0 ? round(range / atr) : 0,
    closeLocation: round(closeLoc), wickOnly: false, bos: false, rejection: REJECTION.NONE,
  };
  if (!(atr > 0)) { ev.rejection = REJECTION.NO_SWING; return ev; }

  const closedBeyond = beyondClose > 0;              // strict — a close (not a wick) is required
  if (!closedBeyond) {
    ev.wickOnly = beyondWick > 0;                     // wicked beyond but did not close beyond → not a BOS
    ev.rejection = ev.wickOnly ? REJECTION.WICK_ONLY_NO_CLOSE : REJECTION.NO_CLOSE_BEYOND_SWING;
    return ev;
  }
  if (ev.penetrationAtr < cfg.bosPenetrationAtr) { ev.rejection = REJECTION.PENETRATION_TOO_SMALL; return ev; }
  if (!structureOnly) {
    if (ev.bodyAtr < cfg.bosMinBodyAtr) { ev.rejection = REJECTION.BODY_TOO_SMALL; return ev; }
    if (ev.closeLocation < (1 - cfg.bosCloseLocation)) { ev.rejection = REJECTION.CLOSE_LOCATION_WEAK; return ev; }
    if (ev.rangeAtr > cfg.bosMaxRangeAtr) { ev.rejection = REJECTION.RANGE_TOO_LARGE; return ev; }
  }
  ev.bos = true;
  return ev;
}

/** Most recent confirmed swing (high for dir>0, low for dir<0) strictly before candle index `i`. */
function latestSwingBefore(swings, i) {
  let best = null;
  for (const s of swings) { if (s.index < i && (!best || s.index > best.index)) best = s; }
  return best;
}

module.exports = {
  round, trueRanges, atrSeries, atrAt,
  swingId, swingHighs, swingLows,
  detectBOS, latestSwingBefore,
};
