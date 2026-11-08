'use strict';

/**
 * Trade-signal engine runner (spec §9) — the SAME evaluator + execution lifecycle for
 * historical backfill and live forward processing.
 *
 *   - Historical: advance chronologically over the entry-TF close grid, reconstructing the
 *     period comparison + top-3 available at each decision point (strictly causal), then
 *     model entry, monitor to exit, and record the immutable signal + lifecycle events.
 *   - Live: identical, advancing the persisted cursor to the latest completed entry close
 *     and monitoring still-open trades. Dedup prevents duplicate signals; one pending/open
 *     signal per pair per strategy.
 *
 * Monitoring uses the finest reliable execution data for each trade's window: M5 where
 * present (≈2026-04 onward), else M15 (disclosed per trade). Mid-only → estimated execution.
 */

const path = require('path');
const { loadParallel, loadTf } = require('../research/comparison/dbload');
const { PAIRS } = require('../research/comparison/config');
const { strategyDef, STRATEGY_KEYS, TF_MS, HOUR } = require('../research/signals/config');
const { buildContext, evaluateAt } = require('../research/signals/evaluate');
const { decideEntry } = require('../research/signals/execution');
const { resolveOutcome } = require('../research/signals/monitor');
const { buildTrade, dedupKey } = require('../research/signals/lifecycle');

// ── small helpers ────────────────────────────────────────────────────────────
function toBars(rows) { return rows.map((r) => ({ openMs: r.openMs, open: r.open, high: r.high, low: r.low, close: r.close })); }
/** candle in `cands` (sorted by .time) whose open time === t, or null. */
function candleAtOpen(cands, t) {
  let lo = 0, hi = cands.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cands[m].time === t) return cands[m]; if (cands[m].time < t) lo = m + 1; else hi = m - 1; }
  return null;
}
/** bars (sorted by openMs) with openMs in [fromMs, toMs). */
function sliceBars(bars, fromMs, toMs) {
  const out = [];
  // linear from a binary-searched start
  let lo = 0, hi = bars.length - 1, start = bars.length;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].openMs >= fromMs) { start = m; hi = m - 1; } else lo = m + 1; }
  for (let i = start; i < bars.length && bars[i].openMs < toMs; i++) out.push(bars[i]);
  return out;
}

/**
 * Run one strategy over a loaded dataset. Pure w.r.t. the DB (all candles passed in).
 *   baseByPair: base candles at def.entryBaseTf (engine)      { pair: [{openMs,...}] }
 *   monByPair:  { pair: { m5:[bars], m15:[bars] } }           (monitoring, finest-first)
 *   lastDataMs: latest candle close in the dataset (open-at-end detection)
 *   store:      { has(key), put(trade) }                      (persistence or accumulator)
 *   origin:     'historical' | 'forward'
 */
function runStrategy(def, baseByPair, monByPair, lastDataMs, store, origin, opts = {}) {
  const ctx = buildContext(def, baseByPair);
  if (!ctx.built.ok) return { ok: false, reason: ctx.built.reason, trades: [] };

  const entryMs = def.entryMs;
  const grid = ctx.built.timeline.filter((t) => t % entryMs === 0 && t <= lastDataMs && t >= (opts.fromMs || 0));
  const busyUntil = {};   // (pair) -> ms the strategy is pending/open until
  const trades = [];

  for (const asOf of grid) {
    const ev = evaluateAt(def, asOf, ctx);
    if (!ev.ok || !ev.signals.length) continue;
    for (const sig of ev.signals) {
      const key = dedupKey(sig);
      if (store.has && store.has(key)) continue;                 // already recorded (restart-safe)
      if (busyUntil[sig.pair] != null && sig.publishedAtMs < busyUntil[sig.pair]) continue; // one open/pending per pair
      sig.origin = origin;

      // Entry: next entry candle opening at entryCloseMs.
      const ec = ctx.entryByPair[sig.pair];
      const next = candleAtOpen(ec, sig.entryCloseMs);
      const entry = decideEntry(sig, next ? next.open : undefined, next ? next.time : undefined, def);

      let outcome = null, openAtEnd = false;
      if (entry.status === 'OPEN') {
        const holdEndMs = entry.fillMs + def.params.maxHoldCandles * entryMs;
        // monitoring bars: prefer M5, else M15.
        const mon = monByPair[sig.pair] || { m5: [], m15: [] };
        let fine = sliceBars(mon.m5, entry.fillMs, holdEndMs), fineTf = 'M5';
        if (!fine.length) { fine = sliceBars(mon.m15, entry.fillMs, holdEndMs); fineTf = 'M15'; }
        // hold-limit quote = the 16th entry candle close.
        const holdCandle = candleAtOpen(ec, holdEndMs - entryMs);
        let holdExit = holdCandle ? { mid: holdCandle.close, ms: holdEndMs } : null;
        if (!holdExit && holdEndMs > lastDataMs) openAtEnd = true;
        outcome = resolveOutcome(entry, fine, holdEndMs, holdExit, fineTf);
        busyUntil[sig.pair] = (outcome && outcome.exitMs) ? outcome.exitMs : holdEndMs;
      } else {
        busyUntil[sig.pair] = sig.entryExpiryMs;                 // pending until expiry
      }

      const trade = buildTrade(sig, entry, outcome, def, { openAtEnd });
      trade.signal = sig;
      trades.push(trade);
      if (store.put) store.put(key, sig, trade);
    }
  }
  return { ok: true, trades, grid: grid.length };
}

// ── dataset loading ────────────────────────────────────────────────────────────
async function loadDataset(sb, baseTf, opts) {
  const by = await loadParallel(sb, PAIRS, baseTf, Object.assign({ withVolume: true }, opts), 8);
  return by;
}
async function loadMonitoring(sb, opts) {
  const m5 = await loadParallel(sb, PAIRS, 'M5', opts, 8);
  const m15 = await loadParallel(sb, PAIRS, 'M15', opts, 8);
  const out = {};
  for (const p of PAIRS) out[p] = { m5: toBars(m5[p] || []), m15: toBars(m15[p] || []) };
  return out;
}
function lastClose(by, baseMs) {
  let last = 0;
  for (const p of PAIRS) { const cs = by[p] || []; if (cs.length) last = Math.max(last, cs[cs.length - 1].openMs + baseMs); }
  return last;
}

// ── in-memory accumulator store (dry-run) ────────────────────────────────────
function memStore() {
  const seen = new Set();
  return { has: (k) => seen.has(k), put: (k) => { seen.add(k); } };
}

/**
 * Backfill one or more strategies over a window (dry-run by default: no DB writes).
 * Returns { [strategyKey]: { trades, grid } }.
 */
async function backfill(sb, { strategies = STRATEGY_KEYS, fromIso, toIso, store } = {}) {
  const opts = {}; if (fromIso) opts.fromIso = fromIso; if (toIso) opts.toIso = toIso;
  const mon = await loadMonitoring(sb, opts);
  const results = {};
  const baseCache = {};
  for (const key of strategies) {
    const def = strategyDef(key);
    const baseTf = def.entryBaseTf;
    if (!baseCache[baseTf]) baseCache[baseTf] = await loadDataset(sb, baseTf, opts);
    const baseByPair = baseCache[baseTf];
    const lastDataMs = lastClose(baseByPair, TF_MS[baseTf]);
    const s = store || memStore();
    const r = runStrategy(def, baseByPair, mon, lastDataMs, s, 'historical', { fromMs: opts.fromMs });
    results[key] = r;
  }
  return results;
}

/** Summary stats over a strategy's trades (research; modelled, estimated execution). */
function summarize(trades) {
  const s = { published: trades.length, entered: 0, open: 0, closed: 0, expired: 0, cancelled: 0, unresolved: 0,
    wins: 0, losses: 0, breakeven: 0, ambiguous: 0, grossMonitorM5: 0, grossMonitorM15: 0,
    netRsum: 0, winRsum: 0, lossRsum: 0 };
  for (const t of trades) {
    if (t.status === 'EXPIRED') s.expired++;
    else if (t.status === 'CANCELLED') s.cancelled++;
    else if (t.status === 'UNRESOLVED') { s.entered++; s.unresolved++; }
    else if (t.status === 'OPEN') { s.entered++; s.open++; }
    else if (t.status === 'CLOSED') {
      s.entered++; s.closed++;
      if (t.ambiguityFlag) s.ambiguous++;
      if (t.dataQuality && t.dataQuality.monitorTf === 'M5') s.grossMonitorM5++; else s.grossMonitorM15++;
      s.netRsum += t.netR;
      if (t.result === 'win') { s.wins++; s.winRsum += t.netR; }
      else if (t.result === 'loss') { s.losses++; s.lossRsum += t.netR; }
      else s.breakeven++;
    }
  }
  const resolved = s.wins + s.losses + s.breakeven;
  s.winRate = resolved ? +(100 * s.wins / resolved).toFixed(1) : null;
  s.avgNetR = s.closed ? +(s.netRsum / s.closed).toFixed(3) : null;
  s.totalNetR = +s.netRsum.toFixed(3);
  s.profitFactor = s.lossRsum < 0 ? +(s.winRsum / Math.abs(s.lossRsum)).toFixed(2) : (s.winRsum > 0 ? Infinity : null);
  return s;
}

module.exports = { runStrategy, backfill, summarize, loadDataset, loadMonitoring, lastClose, memStore, candleAtOpen, sliceBars, toBars };
