'use strict';

/**
 * GET /api/inverted-flow — NervaFX Inverted Flow Chart data (research, UNVALIDATED).
 *
 * Height = fixed step; width = eligible observations (feed activity); a thin trace shows the observed
 * path inside each block. Same deterministic engine for history, live and replay.
 *
 * NervaFX stores completed midpoint OHLC candles only (M5/M15/H1) — no bid/ask, no tick feed. So the
 * 36 real instruments run in CLOSE-ONLY mode (width = received completed closes), and true quote-mode
 * behaviour is shown only via the labelled Simulated example (?mode=sim). No intrabar path, tick
 * count, spread or reversal time is fabricated from OHLCV.
 *
 *   ?instrument=EUR_USD | IDX:EUR    pair or currency index (default EUR_USD)
 *   ?mode=close|sim                  close-only (default) or the simulated A–D reference
 *   ?view=single|compare             single chart (default) or the 8-index comparison
 *   ?resolution=M5|M15|H1            pair close resolution (default M5)
 *   ?step=<price|pp>                 step override (pair price, or index percentage points)
 *   ?since=<ms|ISO>                  documented anchor start for pairs (default = asOf − window)
 *   ?date=<ms|ISO>                   index day (default = today's EAT day) — baseline at 00:00 EAT
 *   ?asOf=<ms|ISO>                   causal cutoff / replay (no look-ahead; defaults to live)
 *
 * Relative-movement research only — NO execution, buy/sell signal, probability, or profitability.
 */

const { getClient, cors } = require('./_db');
const { loadTf, loadM15Parallel } = require('../research/comparison/dbload');
const { buildIndices } = require('../research/comparison/index-build');
const { dayStart, EAT_OFFSET_MS } = require('../research/comparison/periods');
const { M15_MS, DAY_MS, PAIRS, CURRENCIES } = require('../research/comparison/config');
const { instrumentFor, RES_MS, PAIR_RESOLUTIONS, DEFAULT_PAIR_RESOLUTION, DEFAULT_INDEX_STEP_PP, FLOW_VERSION } = require('../research/flow/config');
const { runBlocks } = require('../research/flow/blocks');
const { closeObs, indexObs, simulatedEURUSD } = require('../research/flow/observations');
const { coverageForCandles, coverageForIndex } = require('../research/flow/coverage');

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const parseMs = (v, dflt) => { if (v == null || v === '') return dflt; const t = /^\d+$/.test('' + v) ? parseInt(v, 10) : Date.parse(v); return isNaN(t) ? dflt : t; };

// Default close window per resolution (bounded for the serverless budget; ≈1k observations each).
const WINDOW_DAYS = { M5: { def: 3, cap: 10 }, M15: { def: 10, cap: 30 }, H1: { def: 45, cap: 120 } };
// Index history window (M15 basket snapshots) — a rolling multi-day window like the pair charts.
const INDEX_WINDOW = { def: 12, cap: 45 };

async function instrumentRange(sb, instrument, tf) {
  const lo = await sb.from('backtest_candles').select('time').eq('instrument', instrument).eq('timeframe', tf).eq('complete', true).order('time', { ascending: true }).limit(1);
  const hi = await sb.from('backtest_candles').select('time').eq('instrument', instrument).eq('timeframe', tf).eq('complete', true).order('time', { ascending: false }).limit(1);
  return {
    earliestMs: lo.data && lo.data[0] ? Date.parse(lo.data[0].time) : null,
    latestMs: hi.data && hi.data[0] ? Date.parse(hi.data[0].time) : null,
  };
}

function runPairFlow(candles, resolution, step, precision, cutoffMs) {
  const resMs = RES_MS[resolution];
  let obs = closeObs(candles, resMs, resolution);
  if (cutoffMs != null) obs = obs.filter((o) => o.ms <= cutoffMs);
  if (obs.length < 2) return { ok: false, reason: 'insufficient closes in window', nObs: obs.length };
  const anchor = obs[0].value;   // first close at/after the documented `since` → stable under zoom
  const r = runBlocks(obs, { anchor, step, precision, intervalMs: resMs });
  return r;
}

// Load the index over a ROLLING MULTI-DAY window (like the pair charts), build the zero-sum index and
// rebase to the value at the window start — so the chart shows days of history, not just today. A
// user-supplied ?date still pins a single documented day (baseline 00:00 EAT). ?days / ?since override
// the window. Returns { built, baselineMs, cutoffMs, sinceMs, daily }.
async function loadIndexWindow(sb, q, asOfMs) {
  const dateGiven = q.date != null && q.date !== '';
  if (dateGiven) {
    const target = dayStart(parseMs(q.date, asOfMs));
    const cutoffReq = Math.min(asOfMs, target + DAY_MS);
    const by = await loadM15Parallel(sb, PAIRS, { fromIso: iso(target - 4 * DAY_MS), toIso: iso(cutoffReq) }, 8);
    const built = buildIndices(by, { baseMs: M15_MS });
    if (!built.ok) return { built };
    return { built, baselineMs: target, cutoffMs: Math.min(cutoffReq, built.lastMs), sinceMs: target, daily: true };
  }
  const days = Math.min(INDEX_WINDOW.cap, Math.max(1, parseFloat(q.days) || INDEX_WINDOW.def));
  const sinceMs = parseMs(q.since, asOfMs - days * DAY_MS);
  const by = await loadM15Parallel(sb, PAIRS, { fromIso: iso(sinceMs - 2 * M15_MS), toIso: iso(asOfMs) }, 8);
  const built = buildIndices(by, { baseMs: M15_MS });
  if (!built.ok) return { built };
  const cutoffMs = Math.min(asOfMs, built.lastMs);
  const baselineMs = Math.max(sinceMs, built.firstMs);
  return { built, baselineMs, cutoffMs, sinceMs, daily: false };
}

function runIndexFlow(built, ccy, baselineMs, cutoffMs, step) {
  const io = indexObs(built, ccy, baselineMs, cutoffMs);
  if (!io.ok) return { ok: false, reason: io.reason };
  if (io.observations.length < 2) return { ok: false, reason: 'insufficient basket snapshots for the day', nObs: io.observations.length, baselineValue: io.baselineValue };
  const r = runBlocks(io.observations, { anchor: 0, step, precision: 3 });
  r.baselineValue = io.baselineValue;
  r.lastIndexValue = io.observations[io.observations.length - 1].raw;
  r.lastPp = io.observations[io.observations.length - 1].value;
  return r;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    const q = req.query || {};
    const asOfMs = Math.min(parseMs(q.asOf, Date.now()), Date.now());
    const mode = (q.mode === 'sim') ? 'sim' : 'close';
    const view = (q.view === 'compare') ? 'compare' : 'single';

    // ---- Simulated reference (the A–D example) ------------------------------------------------
    if (mode === 'sim') {
      const sim = simulatedEURUSD();
      const r = runBlocks(sim.observations, { anchor: sim.anchor, step: sim.step, precision: sim.precision });
      return res.json({
        ok: true, version: FLOW_VERSION, mode: 'sim', labelled: 'Simulated example', instrument: 'EUR/USD',
        meta: { kind: 'pair', pip: sim.pip, step: sim.step, stepPips: sim.stepPips, precision: sim.precision, unit: 'received quote updates', valueLabel: 'midpoint price', resolution: 'simulated quotes', anchor: sim.anchor },
        flow: r, segments: sim.segments,
        disclaimer: 'Simulated illustrative quote sequence — NOT broker history. No orders. Width = quote updates (feed activity), not traded volume.',
      });
    }

    const sb = getClient();

    // ---- 8-index comparison -------------------------------------------------------------------
    if (view === 'compare') {
      const day = await loadIndexWindow(sb, q, asOfMs);
      if (!day.built.ok) return res.json({ ok: true, available: false, reason: day.built.reason, mode, view });
      const built = day.built, baselineMs = day.baselineMs, cutoffMs = day.cutoffMs;
      const step = Math.min(5, Math.max(0.001, parseFloat(q.step) || DEFAULT_INDEX_STEP_PP));
      const panels = CURRENCIES.map((ccy) => {
        const r = runIndexFlow(built, ccy, baselineMs, cutoffMs, step);
        return {
          currency: ccy, available: !!r.ok, reason: r.ok ? null : r.reason,
          lastPp: r.ok ? r.lastPp : null, lastIndexValue: r.ok ? r.lastIndexValue : null,
          finalDir: r.ok ? r.finalDir : null, lastConfirmMs: r.ok && r.events.length ? r.events[r.events.length - 1].ms : null,
          flow: r.ok ? r : null,
        };
      });
      // rank by actual underlying index value at the common timestamp (partial moves count).
      const ranked = panels.filter((p) => p.available).sort((a, b) => b.lastPp - a.lastPp).map((p, i) => ({ currency: p.currency, rank: i + 1, lastPp: p.lastPp }));
      return res.json({
        ok: true, version: FLOW_VERSION, mode, view: 'compare',
        asOfUtc: iso(cutoffMs), baselineMs, baselineUtc: iso(baselineMs), sinceMs: day.sinceMs, sinceUtc: iso(day.sinceMs), daily: day.daily,
        meta: { kind: 'index', step, unit: 'constituent basket snapshots', valueLabel: '% from baseline (pp)', resolution: 'M15' },
        coverage: coverageForIndex(built), ranking: ranked, panels,
        disclaimer: 'Zero-sum 1/8 currency indices on M15 basket snapshots over the loaded window (reconciles with Evolution), UNVALIDATED. Each panel keeps its own activity axis; the same x-position across panels is NOT the same clock time. No orders.',
      });
    }

    // ---- Single instrument --------------------------------------------------------------------
    const inst = instrumentFor(q.instrument) || instrumentFor('EUR_USD');

    if (inst.kind === 'pair') {
      const resolution = PAIR_RESOLUTIONS.indexOf(q.resolution) >= 0 ? q.resolution : DEFAULT_PAIR_RESOLUTION;
      const w = WINDOW_DAYS[resolution];
      const days = Math.min(w.cap, Math.max(1, parseFloat(q.days) || w.def));
      const sinceMs = parseMs(q.since, asOfMs - days * DAY_MS);
      const step = Math.max(inst.pip, parseFloat(q.step) || inst.step);   // step ≥ one pip
      const candles = await loadTf(sb, inst.id, resolution, { fromIso: iso(sinceMs), toIso: iso(asOfMs) });
      const r = runPairFlow(candles, resolution, step, inst.precision, asOfMs);
      const range = await instrumentRange(sb, inst.id, resolution);
      const cov = coverageForCandles(candles, RES_MS[resolution], resolution);
      return res.json({
        ok: true, version: FLOW_VERSION, mode: 'close', view: 'single', instrument: inst.id, available: !!r.ok, reason: r.ok ? null : r.reason,
        asOfUtc: iso(asOfMs), sinceMs, sinceUtc: iso(sinceMs),
        meta: {
          kind: 'pair', label: inst.label, pip: inst.pip, step, stepPips: Math.round(step / inst.pip * 10) / 10,
          precision: inst.precision, unit: 'received closes', valueLabel: 'midpoint price', resolution,
          anchor: r.ok ? r.anchor : null,
        },
        coverage: { window: cov, instrument: { earliestMs: range.earliestMs, latestMs: range.latestMs, resolution } },
        flow: r.ok ? r : null,
        disclaimer: 'Close-only: width = received completed ' + resolution + ' closes (feed activity), NOT ticks, traded volume, or quote count. No intrabar path/reversal time is claimed. Midpoint OHLC from OANDA. No orders.',
      });
    }

    // index (single) — rolling multi-day window, like the pair charts
    const day = await loadIndexWindow(sb, q, asOfMs);
    if (!day.built.ok) return res.json({ ok: true, available: false, reason: day.built.reason, mode, view, instrument: inst.id });
    const built = day.built, baselineMs = day.baselineMs, cutoffMs = day.cutoffMs;
    const step = Math.min(5, Math.max(0.001, parseFloat(q.step) || DEFAULT_INDEX_STEP_PP));
    const r = runIndexFlow(built, inst.currency, baselineMs, cutoffMs, step);
    return res.json({
      ok: true, version: FLOW_VERSION, mode: 'close', view: 'single', instrument: inst.id, available: !!r.ok, reason: r.ok ? null : r.reason,
      asOfUtc: iso(cutoffMs), baselineMs, baselineUtc: iso(baselineMs), sinceMs: day.sinceMs, sinceUtc: iso(day.sinceMs), daily: day.daily,
      meta: {
        kind: 'index', label: inst.label, currency: inst.currency, step, precision: 3,
        unit: 'constituent basket snapshots', valueLabel: '% from baseline (pp)', resolution: 'M15',
        baselineValue: r.ok ? r.baselineValue : null, anchor: 0,
      },
      coverage: coverageForIndex(built),
      flow: r.ok ? r : null,
      disclaimer: 'Zero-sum 1/8 ' + inst.currency + ' index on M15 basket snapshots over the loaded window (reconciles with Evolution), UNVALIDATED. Width = basket snapshots. No orders.',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 120;
