'use strict';

/**
 * M15 Intelligence — adaptive directional-change / structural-event engine (§10).
 *
 * Identifies structural legs using a VOLATILITY-ADJUSTED reversal threshold, not
 * a fixed candle count (§6). A leg flips when price retraces from its extreme by
 *
 *   threshold = max( volMult · adaptiveVol,
 *                    spreadNoiseMult · spread,
 *                    instrumentMinThreshold )
 *
 * Everything is computed left→right using only candles up to each index, so a
 * historical replay can never confirm an event with information that did not yet
 * exist (§10, §28). Deterministic: same candles ⇒ same events.
 */

const { CONFIG } = require('./config');
const { volatilitySeries } = require('./math');
const { instrumentMinThreshold, pipSize } = require('./pairs');

const EV = {
  UP_START: 'UP_LEG_STARTED', UP_EXT: 'UP_LEG_EXTENDED', UP_FAIL: 'UP_LEG_FAILED',
  DN_START: 'DOWN_LEG_STARTED', DN_EXT: 'DOWN_LEG_EXTENDED', DN_FAIL: 'DOWN_LEG_FAILED',
};

/**
 * @param {object[]} candles ascending {openMs,open,high,low,close}
 * @param {object} opts { pair, spread?, cfg? } spread in price units (optional)
 * @returns {{events, legs, current, thresholdLast, volLast}}
 */
function detectStructure(candles, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const pair = opts.pair || 'EUR_USD';
  const spread = opts.spread || 0;
  const dc = cfg.directionalChange;
  const minTh = instrumentMinThreshold(pair);
  const vol = volatilitySeries(candles, cfg.volatility.trHalfLifeCandles);

  const thresholdAt = (i) => Math.max(
    dc.volMultiplier * (vol[i] || 0),
    dc.spreadNoiseMultiplier * spread,
    minTh,
  );

  const events = [];
  const legs = [];
  const emit = (type, i, price, extra = {}) =>
    events.push({ type, index: i, openMs: candles[i].openMs, time: candles[i].time, price, ...extra });

  if (candles.length === 0) {
    return { events, legs, current: null, thresholdLast: minTh, volLast: 0 };
  }

  let mode = 0;                        // 0 unknown, +1 up-leg, −1 down-leg
  let ext = candles[0].close, extMs = candles[0].openMs, extIdx = 0;
  let pivot = candles[0].close, pivotMs = candles[0].openMs, pivotIdx = 0;
  let hwm = candles[0].close, hwmMs = candles[0].openMs;
  let lwm = candles[0].close, lwmMs = candles[0].openMs;
  let prevUpExt = null, prevDnExt = null;
  let extendSteps = 0;

  const closeLeg = (dir, endIdx) => {
    legs.push({
      direction: dir === 1 ? 'UP' : 'DOWN',
      startMs: pivotMs, startPrice: pivot, endMs: extMs, endPrice: ext,
      displacement: Math.abs(ext - pivot), extensions: extendSteps,
    });
  };

  for (let i = 1; i < candles.length; i++) {
    const th = thresholdAt(i);
    const c = candles[i];
    if (c.high > hwm) { hwm = c.high; hwmMs = c.openMs; }
    if (c.low < lwm) { lwm = c.low; lwmMs = c.openMs; }

    if (mode === 0) {
      if (hwm - lwm >= th) {
        if (hwmMs >= lwmMs) {          // high made more recently ⇒ up-leg from the low
          mode = 1; pivot = lwm; pivotMs = lwmMs; ext = hwm; extMs = hwmMs; extIdx = i;
          emit(EV.UP_START, i, ext, { pivot, threshold: th });
        } else {
          mode = -1; pivot = hwm; pivotMs = hwmMs; ext = lwm; extMs = lwmMs; extIdx = i;
          emit(EV.DN_START, i, ext, { pivot, threshold: th });
        }
        extendSteps = 0;
      }
      continue;
    }

    if (mode === 1) {
      if (c.high > ext) {              // extreme extends upward
        ext = c.high; extMs = c.openMs; extIdx = i;
        const steps = Math.floor((ext - pivot) / (dc.extendMultiplier * th));
        if (steps > extendSteps) { extendSteps = steps; emit(EV.UP_EXT, i, ext, { extensions: extendSteps }); }
      }
      if (ext - c.low >= th) {         // retrace from up-extreme ⇒ DOWN directional change
        closeLeg(1, i);
        if (prevUpExt != null && ext <= prevUpExt) emit(EV.UP_FAIL, i, ext, { prevExtreme: prevUpExt }); // lower high
        prevUpExt = ext;
        mode = -1; pivot = ext; pivotMs = extMs; pivotIdx = extIdx; ext = c.low; extMs = c.openMs; extIdx = i;
        extendSteps = 0; hwm = c.high; hwmMs = c.openMs; lwm = c.low; lwmMs = c.openMs;
        emit(EV.DN_START, i, ext, { pivot, threshold: th });
      }
    } else { // mode === -1
      if (c.low < ext) {
        ext = c.low; extMs = c.openMs; extIdx = i;
        const steps = Math.floor((pivot - ext) / (dc.extendMultiplier * th));
        if (steps > extendSteps) { extendSteps = steps; emit(EV.DN_EXT, i, ext, { extensions: extendSteps }); }
      }
      if (c.high - ext >= th) {
        closeLeg(-1, i);
        if (prevDnExt != null && ext >= prevDnExt) emit(EV.DN_FAIL, i, ext, { prevExtreme: prevDnExt }); // higher low
        prevDnExt = ext;
        mode = 1; pivot = ext; pivotMs = extMs; pivotIdx = extIdx; ext = c.high; extMs = c.openMs; extIdx = i;
        extendSteps = 0; hwm = c.high; hwmMs = c.openMs; lwm = c.low; lwmMs = c.openMs;
        emit(EV.UP_START, i, ext, { pivot, threshold: th });
      }
    }
  }

  const last = candles[candles.length - 1];
  const current = mode === 0 ? { direction: 'NONE', displacement: 0 } : {
    direction: mode === 1 ? 'UP' : 'DOWN',
    pivot, pivotMs, extreme: ext, extremeMs: extMs,
    displacement: Math.abs(ext - pivot),
    displacementPips: Math.abs(ext - pivot) / pipSize(pair),
    extensions: extendSteps,
    ageEvents: events.length,          // structural events so far (NOT a candle count)
  };

  return {
    events, legs, current,
    thresholdLast: thresholdAt(candles.length - 1),
    volLast: vol[candles.length - 1] || 0,
    lastMs: last.openMs,
  };
}

module.exports = { detectStructure, EV };
