'use strict';

/**
 * NervaFX Currency Movement Engine — scan orchestration.
 *
 * evaluateWindows() is PURE (candles in → windows out); scanAll() adds the DB
 * fetch and 7-pair batching with per-pair isolation. One shared evaluation
 * timestamp; completed candles only; failed pairs never stop the scan.
 */

const {
  HOUR_MS, M15_MS, M15_PER_H1, CURRENCIES, PAIRS, WINDOWS, ENGINE_KEY, ENGINE_VERSION,
} = require('./_cme-constants');
const { pairLogReturn, pairMoveATR, solveCurrencySystem, signedContribution } = require('./_cme-math');
const { computeCurrencyComponents, assignRanks } = require('./_cme-features');
const { microFeatures } = require('./_cme-15m-features');
const { windowBounds } = require('./_cme-windows');
const { atr } = require('./_h1c-math');

function toMap(cands) { return new Map((cands || []).map((c) => [c.openMs, c])); }
const inPairs = (pair, cur) => { const p = pair.split('_'); return p[0] === cur || p[1] === cur; };

/** Evaluate one H1-bounded window (raw decomposition + per-hour dynamics + 15M refine). */
function evalH1Window(wb, h1map, m15map, atrMap, enhance15m) {
  const hours = [];
  for (let h = wb.startOpenMs; h <= wb.endOpenMs; h += HOUR_MS) hours.push(h);

  // Window-level pair returns (start open → end close).
  const pairReturns = {};
  const pairInfo = [];
  for (const pair of PAIRS) {
    const startC = h1map[pair].get(wb.startOpenMs);
    const endC = h1map[pair].get(wb.endOpenMs);
    if (!startC || !endC) continue;
    const lr = pairLogReturn(startC.open, endC.close);
    if (lr == null) continue;
    pairReturns[pair] = lr;
    pairInfo.push({ pair, logReturn: lr, moveATR: pairMoveATR(startC.open, endC.close, atrMap[pair]) });
  }
  const sol = solveCurrencySystem(pairReturns);

  // Per-hour movement sequence (for efficiency / persistence / acceleration).
  const hourlyByCur = {}; CURRENCIES.forEach((c) => { hourlyByCur[c] = []; });
  for (const h of hours) {
    const hr = {};
    for (const pair of PAIRS) { const c = h1map[pair].get(h); if (!c) continue; const lr = pairLogReturn(c.open, c.close); if (lr != null) hr[pair] = lr; }
    if (!Object.keys(hr).length) continue;
    const hs = solveCurrencySystem(hr);
    CURRENCIES.forEach((c) => hourlyByCur[c].push(hs.movement[c]));
  }

  // 15M micro sequence (per 15M step) + 15M window returns (for micro breadth).
  const m15ByCur = {}; CURRENCIES.forEach((c) => { m15ByCur[c] = []; });
  const micro15Contrib = {}; CURRENCIES.forEach((c) => { micro15Contrib[c] = []; });
  if (enhance15m) {
    for (let t = wb.startOpenMs; t <= wb.endOpenMs + HOUR_MS - M15_MS; t += M15_MS) {
      const mr = {};
      for (const pair of PAIRS) { const c = m15map[pair].get(t); if (!c) continue; const lr = pairLogReturn(c.open, c.close); if (lr != null) mr[pair] = lr; }
      if (!Object.keys(mr).length) continue;
      const ms = solveCurrencySystem(mr);
      CURRENCIES.forEach((c) => m15ByCur[c].push(ms.movement[c]));
    }
    // 15M window pair returns (first 15M open → last 15M close) for micro breadth.
    const lastM15Open = wb.endOpenMs + (M15_PER_H1 - 1) * M15_MS;
    for (const pair of PAIRS) {
      const s = m15map[pair].get(wb.startOpenMs);
      const e = m15map[pair].get(lastM15Open);
      if (!s || !e) continue;
      const lr = pairLogReturn(s.open, e.close);
      if (lr == null) continue;
      for (const cur of CURRENCIES) if (inPairs(pair, cur)) micro15Contrib[cur].push(signedContribution(pair, lr, cur));
    }
  }

  const currencies = {};
  for (const cur of CURRENCIES) {
    const raw = sol.movement[cur] || 0;
    const dir = Math.sign(raw);
    const contribs = pairInfo.filter((pi) => inPairs(pi.pair, cur)).map((pi) => signedContribution(pi.pair, pi.logReturn, cur));
    let micro = null;
    if (enhance15m) {
      const seq = m15ByCur[cur];
      const mf = microFeatures(seq, dir);
      const mc = micro15Contrib[cur];
      const microBreadthVal = mc.length && dir !== 0 ? mc.filter((v) => Math.sign(v) === dir).length / mc.length : 0;
      micro = { microPersistence: mf.microPersistence, microAcceleration: mf.microAcceleration, microBreadth: microBreadthVal, microState: mf.microState, path15m: seq.reduce((a, v) => a + Math.abs(v), 0) };
    }
    currencies[cur] = computeCurrencyComponents({ rawMovement: raw, hourlySeq: hourlyByCur[cur], contribsH1: contribs, micro });
  }
  assignRanks(currencies);
  return {
    status: 'OK',
    startOpenUtc: new Date(wb.startOpenMs).toISOString(),
    endCloseUtc: new Date(wb.endOpenMs + HOUR_MS).toISOString(),
    hours: hours.length, pairsUsed: sol.pairsUsed, ssr: sol.ssr,
    currencies, meta: wb.meta || null,
  };
}

/** The 15M window: the latest completed 15M candle only (intra-hour snapshot). */
function evalM15Window(m15map, evalMs) {
  const lastClose = Math.floor(evalMs / M15_MS) * M15_MS;
  const open = lastClose - M15_MS;
  const returns = {};
  const pairInfo = [];
  for (const pair of PAIRS) { const c = m15map[pair].get(open); if (!c) continue; const lr = pairLogReturn(c.open, c.close); if (lr == null) continue; returns[pair] = lr; pairInfo.push({ pair, logReturn: lr }); }
  if (!pairInfo.length) return { status: 'NOT_ACTIVE' };
  const sol = solveCurrencySystem(returns);
  const currencies = {};
  for (const cur of CURRENCIES) {
    const raw = sol.movement[cur] || 0;
    const contribs = pairInfo.filter((pi) => inPairs(pi.pair, cur)).map((pi) => signedContribution(pi.pair, pi.logReturn, cur));
    currencies[cur] = computeCurrencyComponents({ rawMovement: raw, hourlySeq: [raw], contribsH1: contribs, micro: null });
  }
  assignRanks(currencies);
  return { status: 'OK', startOpenUtc: new Date(open).toISOString(), endCloseUtc: new Date(lastClose).toISOString(), hours: 1, pairsUsed: sol.pairsUsed, ssr: sol.ssr, currencies };
}

/**
 * @param {Object} pairData { pair: { h1:[], m15:[] } } (completed candles)
 * @param {number} evalMs
 * @param {{enhance15m?:boolean}} [opts]
 */
function evaluateWindows(pairData, evalMs, opts) {
  opts = opts || {};
  const enhance15m = opts.enhance15m !== false;
  const h1map = {}, m15map = {}, atrMap = {};
  for (const pair of PAIRS) {
    const pd = pairData[pair] || {};
    h1map[pair] = toMap(pd.h1);
    m15map[pair] = toMap(pd.m15);
    atrMap[pair] = pd.h1 ? atr(pd.h1, 20) : null;
  }
  const windowsOut = {};
  for (const name of WINDOWS) {
    if (name === 'M15') { windowsOut[name] = evalM15Window(m15map, evalMs); continue; }
    const wb = windowBounds(name, evalMs);
    if (!wb.ok) { windowsOut[name] = { status: wb.status }; continue; }
    windowsOut[name] = evalH1Window(wb, h1map, m15map, atrMap, enhance15m);
  }
  return windowsOut;
}

async function scanAll(sb, opts) {
  opts = opts || {};
  const evalMs = opts.evalMs != null ? opts.evalMs : Date.now();
  const enhance15m = opts.enhance15m !== false;
  const { fetchPair } = require('./_cme-data');

  const pairData = {};
  const pairErrors = [];
  const warnings = [];
  for (let i = 0; i < PAIRS.length; i += 7) {
    const batch = PAIRS.slice(i, i + 7);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(batch.map(async (pair) => {
      try { return { pair, data: await fetchPair(sb, pair, evalMs, {}) }; }
      catch (e) { return { pair, error: e.message }; }
    }));
    for (const r of results) {
      if (r.error) { pairErrors.push({ pair: r.pair, error: r.error }); continue; }
      pairData[r.pair] = r.data;
      const w = [];
      if ((r.data.h1 || []).length < 24) w.push('h1_short');
      if (r.data.h1 && r.data.h1.rejected) w.push('h1_malformed');
      if (w.length) warnings.push({ pair: r.pair, warnings: w });
    }
  }

  const windowsOut = evaluateWindows(pairData, evalMs, { enhance15m });
  return {
    engineKey: ENGINE_KEY,
    engineVersion: ENGINE_VERSION,
    generatedAt: new Date(evalMs).toISOString(),
    enhance15m,
    windows: windowsOut,
    pairsRequested: PAIRS.length,
    pairsEvaluated: Object.keys(pairData).length,
    pairErrors,
    dataWarnings: warnings,
  };
}

module.exports = { evaluateWindows, evalH1Window, evalM15Window, scanAll };
