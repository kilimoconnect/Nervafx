'use strict';

/**
 * NervaFX H1 Continuation Engine — H1 data access with CENTRAL closed-candle
 * enforcement.
 *
 * The forming (incomplete) H1 candle is excluded here, once, so no detector has
 * to re-derive "is this candle closed?". A candle opened at time t closes at
 * t + HOUR; it is usable only when its CLOSE time is <= the evaluation time.
 * Original timestamps are preserved exactly.
 */

const { getClient } = require('./_db');
const {
  HOUR_MS, FETCH_LIMIT, MIN_CLOSED_CANDLES, DATA_REJECTIONS,
} = require('./_h1c-constants');

/**
 * Pure sanitizer: given raw H1 rows (any order) and an evaluation time, return
 * only CLOSED candles ascending, de-duplicated, with gap/quality metadata. No
 * I/O — this is the unit-testable core of the closed-candle guarantee.
 *
 * @param {Array<{time:string,open:number,high:number,low:number,close:number}>} rows
 * @param {number} evalMs  evaluation time in epoch ms (exclusive of the forming candle).
 * @param {{minCandles?:number}} [opts]
 * @returns {{ok:boolean, reason:(string|null), candles:Array, meta:Object}}
 */
function sanitizeH1(rows, evalMs, opts = {}) {
  const minCandles = opts.minCandles != null ? opts.minCandles : MIN_CLOSED_CANDLES;

  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, reason: DATA_REJECTIONS.NO_DATA, candles: [], meta: { count: 0 } };
  }

  // Closed-candle filter + de-dup. A candle open at ms closes at ms+HOUR; keep
  // it only when ms + HOUR <= evalMs. This is the single, central place the
  // current incomplete candle is dropped.
  const seen = new Set();
  let duplicates = 0;
  const closed = [];
  for (const r of rows) {
    const ms = new Date(r.time).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms + HOUR_MS > evalMs) continue;         // not yet closed at evalMs
    if (seen.has(ms)) { duplicates++; continue; }
    seen.add(ms);
    closed.push({
      time: r.time,                              // preserve the original timestamp
      ms,
      open: +r.open, high: +r.high, low: +r.low, close: +r.close,
    });
  }
  closed.sort((a, b) => a.ms - b.ms);

  // Duplicated candles are a hard data-quality failure.
  if (duplicates > 0) {
    return {
      ok: false, reason: DATA_REJECTIONS.DUPLICATE_CANDLE, candles: closed,
      meta: { count: closed.length, duplicates },
    };
  }

  // Gaps (adjacent candles more than one H1 apart) are metadata, not a reject —
  // weekend/holiday breaks are normal. Detectors decide how to treat them.
  let gaps = 0;
  for (let i = 1; i < closed.length; i++) {
    if (closed[i].ms - closed[i - 1].ms > HOUR_MS) gaps++;
  }

  if (closed.length < minCandles) {
    return {
      ok: false, reason: DATA_REJECTIONS.INSUFFICIENT_HISTORY, candles: closed,
      meta: { count: closed.length, gaps, duplicates },
    };
  }

  return {
    ok: true, reason: null, candles: closed,
    meta: {
      count: closed.length, gaps, duplicates,
      firstTime: closed[0].time, lastTime: closed[closed.length - 1].time,
    },
  };
}

/**
 * Fetch closed H1 candles for one instrument as of `evalMs` (default now), then
 * run them through sanitizeH1 for the authoritative closed-candle guarantee.
 * The query bounds open time to evalMs - HOUR (so close <= evalMs) AND requires
 * complete=true — belt and suspenders against the live forming candle.
 *
 * @returns {Promise<{ok:boolean, reason:(string|null), candles:Array, meta:Object}>}
 */
async function fetchClosedH1(sb, inst, opts = {}) {
  const client = sb || getClient();
  const evalMs = opts.evalMs != null ? opts.evalMs : Date.now();
  const limit = opts.limit != null ? opts.limit : FETCH_LIMIT;
  const untilISO = new Date(evalMs - HOUR_MS).toISOString();   // open <= evalMs - H1

  const { data, error } = await client
    .from('backtest_candles')
    .select('time, open, high, low, close')
    .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true)
    .lte('time', untilISO)
    .order('time', { ascending: false })
    .limit(limit);
  if (error) throw error;

  return sanitizeH1(data || [], evalMs, opts);
}

module.exports = { sanitizeH1, fetchClosedH1 };
