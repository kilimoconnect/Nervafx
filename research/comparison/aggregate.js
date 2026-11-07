'use strict';

/**
 * Timeframe aggregation for charting. Higher timeframes are not stored — they are
 * aggregated from the base candles we DO have (M15 for intraday, H1 for H4 and up).
 * Buckets are UTC-aligned; weekly starts Monday 00:00 UTC, monthly the 1st 00:00 UTC.
 *
 * - aggregatePairs: real OHLC roll-up (open=first, high=max, low=min, close=last).
 * - aggregateIndexPath: the relative-index path (a line, sampled at the base interval)
 *   bucketed into OHLC. open carries from the value at the bucket boundary so bars are
 *   contiguous; highs/lows are sampled at the base resolution (disclosed, not intrabar).
 */

const { M15_MS, DAY_MS } = require('./config');
const { idxAtOrBefore } = require('./index-build');

const MIN = 60 * 1000, HOUR = 60 * MIN;
// Fixed-width timeframes (UTC-epoch-aligned by flooring). W1/MN are handled specially.
const TF_MS = { M15: 15 * MIN, M30: 30 * MIN, H1: HOUR, H4: 4 * HOUR, D1: DAY_MS };
const TIMEFRAMES = ['M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN'];

/** Base stored resolution to aggregate a target timeframe from. */
function baseForTf(tf) { return (tf === 'M15' || tf === 'M30') ? 'M15' : 'H1'; }

/** How many days of base history to load for a target timeframe (bounded for cost). */
function lookbackDaysForTf(tf) {
  return { M15: 30, M30: 45, H1: 120, H4: 300, D1: 550, W1: 900, MN: 1200 }[tf] || 120;
}

function weekStartUtc(ms) {
  const d = Math.floor(ms / DAY_MS) * DAY_MS;
  const back = (new Date(d).getUTCDay() + 6) % 7;   // days since Monday
  return d - back * DAY_MS;
}
function monthStartUtc(ms) { const dt = new Date(ms); return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1); }

/** UTC-aligned bucket start for a bar whose open time is openMs, in timeframe tf. */
function bucketStart(openMs, tf) {
  if (tf === 'W1') return weekStartUtc(openMs);
  if (tf === 'MN') return monthStartUtc(openMs);
  const w = TF_MS[tf]; return Math.floor(openMs / w) * w;
}

/** Aggregate real OHLC pair candles ({openMs,open,high,low,close,volume?}) into timeframe tf.
 *  Volume (if present on the base candles) is summed within each bucket. */
function aggregatePairs(base, tf) {
  const buckets = new Map();   // bucketStart -> candle
  const order = [];
  for (const c of base) {
    const b = bucketStart(c.openMs, tf);
    const vol = (c.volume == null ? null : +c.volume);
    let m = buckets.get(b);
    if (!m) { m = { time: b, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: vol }; buckets.set(b, m); order.push(b); }
    else { if (+c.high > m.high) m.high = +c.high; if (+c.low < m.low) m.low = +c.low; m.close = +c.close; if (vol != null) m.volume = (m.volume == null ? 0 : m.volume) + vol; }
  }
  order.sort((a, b) => a - b);
  return order.map((b) => buckets.get(b));
}

/** Aggregate a currency's relative-index path (from buildIndices) into timeframe tf. */
function aggregateIndexPath(built, ccy, tf) {
  const tl = built.timeline, arr = built.index[ccy], baseMs = built.baseMs || M15_MS;
  const buckets = new Map(); const order = [];
  for (let i = 0; i < tl.length; i++) {
    const barOpen = tl[i] - baseMs;           // the base bar this index close belongs to
    const b = bucketStart(barOpen, tf);
    const v = arr[i];
    let m = buckets.get(b);
    if (!m) {
      const carry = idxAtOrBefore(built, ccy, b);     // open = value carried into the bucket
      const o = carry ? carry.value : v;
      m = { time: b, open: o, high: Math.max(o, v), low: Math.min(o, v), close: v }; buckets.set(b, m); order.push(b);
    } else { if (v > m.high) m.high = v; if (v < m.low) m.low = v; m.close = v; }
  }
  order.sort((a, b) => a - b);
  return order.map((b) => buckets.get(b));
}

module.exports = { TIMEFRAMES, TF_MS, baseForTf, lookbackDaysForTf, bucketStart, weekStartUtc, monthStartUtc, aggregatePairs, aggregateIndexPath };
