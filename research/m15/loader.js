'use strict';

/**
 * M15 Strategy Research — read-only offline data loader / replay skeleton (Stage 1).
 *
 * SEPARATE from api/_m15/ (the production decision engine): this layer never
 * imports, alters, or depends on that engine's decisions/thresholds, and it never
 * writes to the database. It provides one thing Stage 1 needs — a correct, proven
 * as-of-close synchronized view of 28 M15 histories with no look-ahead — plus a
 * chronological replay iterator and an integrity report.
 *
 * Replay contract (verified against ingestion; OANDA `time` = candle START, UTC):
 *   A candle is eligible at evaluation close T iff  open + 15m <= T  (i.e. it has
 *   CLOSED by T). Equivalently open <= T - 15m. Boundary: T = 2026-09-10 12:00 UTC
 *   (15:00 EAT) includes the 11:45-UTC (14:45 EAT) candle and excludes the 12:00-UTC
 *   (15:00 EAT) candle. Every feature, cross-pair calc, chart, and decision must use
 *   the SAME as-of view returned here.
 */

const M15 = 15 * 60 * 1000;

const PAIRS = ['AUD_CAD','AUD_CHF','AUD_JPY','AUD_NZD','AUD_USD','CAD_CHF','CAD_JPY','CHF_JPY','EUR_AUD','EUR_CAD','EUR_CHF','EUR_GBP','EUR_JPY','EUR_NZD','EUR_USD','GBP_AUD','GBP_CAD','GBP_CHF','GBP_JPY','GBP_NZD','GBP_USD','NZD_CAD','NZD_CHF','NZD_JPY','NZD_USD','USD_CAD','USD_CHF','USD_JPY'];

/** ms of the latest candle-open eligible at evaluation close T (open + 15m <= T). */
function frameOpenForClose(closeMs) { return Math.floor(closeMs / M15) * M15 - M15; }

/** Parse an EAT (UTC+3, no DST) wall time to a UTC instant. */
function eatToUtc(dateStr, timeStr) { return Date.parse(`${dateStr}T${timeStr || '00:00'}:00+03:00`); }

/** Normalize a raw DB row to the research candle shape. */
function toCandle(r) {
  return { openMs: new Date(r.time).getTime(), time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: r.volume == null ? null : +r.volume, complete: r.complete !== false, source: r.source || 'OANDA' };
}

/**
 * Synchronized as-of view at evaluation close T. Returns, per pair, all candles
 * eligible at T (open + 15m <= T), truncated to the COMMON latest frame so no pair
 * sees further than another. No look-ahead: nothing with open + 15m > T is returned.
 * @param historiesByPair { pair: candles[] } ascending, from memory (research only)
 */
function syncAsOf(historiesByPair, evaluationCloseUtc, pairs = PAIRS) {
  const T = evaluationCloseUtc;
  const cutoff = T - M15;                              // max eligible open
  const eligible = {}, latest = {};
  for (const p of pairs) {
    const cs = (historiesByPair[p] || []).filter((c) => c.openMs <= cutoff);
    eligible[p] = cs;
    latest[p] = cs.length ? cs[cs.length - 1].openMs : null;
  }
  const present = pairs.filter((p) => latest[p] != null);
  const missing = pairs.filter((p) => latest[p] == null);
  const commonFrame = present.length ? Math.min(...present.map((p) => latest[p])) : null;
  const laggards = present.filter((p) => latest[p] !== commonFrame);
  const bySync = {};
  for (const p of pairs) bySync[p] = (eligible[p] || []).filter((c) => commonFrame == null || c.openMs <= commonFrame);
  return {
    evaluationCloseUtc: T, frameOpenMs: commonFrame,
    aligned: missing.length === 0 && laggards.length === 0,
    missing, laggards, bySync,
  };
}

/**
 * Chronological replay over every completed M15 close in [fromClose, toClose].
 * Deterministic, no look-ahead, checkpointable via `startAtCloseMs`. Calls
 * onClose(evaluationCloseUtc, syncView) for each eligible close. Pure iteration —
 * the caller decides what to compute; this skeleton creates NO strategies.
 */
function replay(historiesByPair, opts = {}) {
  const pairs = opts.pairs || PAIRS;
  const step = M15;
  let T = Math.ceil((opts.startAtCloseMs || opts.fromCloseMs) / step) * step;
  const to = opts.toCloseMs;
  const warmup = opts.warmupCandles || 0;
  let processed = 0, skippedWarmup = 0, skippedNoData = 0;
  for (; T <= to; T += step) {
    const view = syncAsOf(historiesByPair, T, pairs);
    if (view.frameOpenMs == null) { skippedNoData++; continue; }
    if (warmup && pairs.some((p) => view.bySync[p].length < warmup)) { skippedWarmup++; continue; }
    opts.onClose && opts.onClose(T, view);
    processed++;
  }
  return { processed, skippedWarmup, skippedNoData, lastCloseMs: to };
}

/** Lightweight integrity summary over in-memory histories (source/dup/coverage). */
function integrityReport(historiesByPair, pairs = PAIRS) {
  const per = pairs.map((p) => {
    const cs = historiesByPair[p] || [];
    const sources = new Set(cs.map((c) => c.source || 'OANDA'));
    const seen = new Set(); let dup = 0;
    for (const c of cs) { if (seen.has(c.openMs)) dup++; else seen.add(c.openMs); }
    return { pair: p, rows: cs.length, first: cs[0] ? cs[0].time : null, last: cs.length ? cs[cs.length - 1].time : null, duplicates: dup, sources: [...sources] };
  });
  const allSources = new Set(per.flatMap((x) => x.sources));
  return { pairs: per.length, singleSource: allSources.size === 1, sources: [...allSources], totalRows: per.reduce((s, x) => s + x.rows, 0), perPair: per };
}

/**
 * Read-only DB loader — batched, chronological, SELECT-only. Never writes. Used by
 * offline research jobs (not inside a Vercel request). Returns {pair: candles[]}.
 */
async function loadAllPairsFromDb(sb, opts = {}) {
  const pairs = opts.pairs || PAIRS;
  const fromIso = opts.fromIso, toIso = opts.toIso;
  // Load every pair in PARALLEL (28 sequential round-trips was the main latency).
  const loadOne = async (p) => {
    const all = []; let off = 0;
    for (;;) {
      let q = sb.from('backtest_candles').select('time,open,high,low,close,volume,complete,source')
        .eq('instrument', p).eq('timeframe', 'M15').eq('complete', true).order('time', { ascending: true }).range(off, off + 999);
      if (fromIso) q = q.gte('time', fromIso);
      if (toIso) q = q.lte('time', toIso);
      const { data, error } = await q;
      if (error) throw new Error(`${p}: ${error.message}`);
      all.push(...data.map(toCandle));
      if (data.length < 1000) break;
      off += 1000;
    }
    return [p, all];
  };
  const entries = await Promise.all(pairs.map(loadOne));
  const out = {};
  for (const [p, all] of entries) out[p] = all;
  return out;
}

module.exports = { M15, PAIRS, frameOpenForClose, eatToUtc, toCandle, syncAsOf, replay, integrityReport, loadAllPairsFromDb };
