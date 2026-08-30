'use strict';

/**
 * NervaFX Currency Movement Engine — scan orchestration.
 *
 * evaluateWindows() is PURE (candles in → windows out); scanAll() adds the DB
 * fetch and 7-pair batching with per-pair isolation. One shared evaluation
 * timestamp; completed candles only; failed pairs never stop the scan.
 */

const {
  HOUR_MS, M15_MS, M15_PER_H1, CURRENCIES, PAIRS, WINDOWS, ENGINE_KEY, ENGINE_VERSION, CONFIGURATION_VERSION, BOS,
} = require('./_cme-constants');
const { pairLogReturn, pairMoveATR, solveCurrencySystem, signedContribution } = require('./_cme-math');
const { computeCurrencyComponents, assignRanks } = require('./_cme-features');
const { microFeatures } = require('./_cme-15m-features');
const { windowBounds } = require('./_cme-windows');
const {
  detectH1BreakOfStructure, detect15MBreakOfStructure, calculatePairStructureScore, currencyDirFromPair,
  aggregateCurrencyStructure, currencyStructureScore, classifyStructureAgreement, confirmedMovementScore, classifyMicroAgreement,
} = require('./_cme-structure');
const { atr } = require('./_h1c-math');

const round = (v) => Math.round(v * 100000) / 100000;
const r1 = (v) => Math.round(v * 10) / 10;

/** ATR ending at each candle index (no-lookahead) — atr[i] uses candles[0..i]. */
function rollingAtr(candles, period) {
  const out = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) out[i] = atr(candles.slice(0, i + 1), period);
  return out;
}

/**
 * Current structural snapshot as of evalMs: per-pair H1 + 15M BOS (latest
 * completed candle vs its immediate predecessor), and per-currency aggregation.
 */
function computeStructureSnapshot(h1arr, m15arr, evalMs) {
  const LB = BOS.STRUCTURE_LOOKBACK;
  const latestH1Open = Math.floor(evalMs / HOUR_MS) * HOUR_MS - HOUR_MS;
  const latestM15Open = Math.floor(evalMs / M15_MS) * M15_MS - M15_MS;
  const pairBos = {};
  for (const pair of PAIRS) {
    const h1 = h1arr[pair] || [];
    const m15 = m15arr[pair] || [];
    const h1Idx = new Map(h1.map((c, i) => [c.openMs, i]));
    const curI = h1Idx.get(latestH1Open);
    const cur = h1[curI];
    const prevWin = curI != null ? h1.slice(Math.max(0, curI - LB), curI) : [];
    const atr20 = atr(h1, 20);
    const h1BOS = detectH1BreakOfStructure(cur, prevWin, atr20);
    const pairScore = calculatePairStructureScore(h1BOS);

    // 15M micro BOS on the latest completed 15M + counts over the last 4 (this H1).
    const m15Idx = new Map(m15.map((c, i) => [c.openMs, i]));
    const atr15 = atr(m15, 20);
    const mcurI = m15Idx.get(latestM15Open);
    const mprevWin = mcurI != null ? m15.slice(Math.max(0, mcurI - LB), mcurI) : [];
    const microBOS = detect15MBreakOfStructure(m15[mcurI], mprevWin, atr15);
    let microBull = 0, microBear = 0, microDec = 0;
    for (let k = 0; k < M15_PER_H1; k++) {
      const t = latestH1Open + k * M15_MS;
      const ccI = m15Idx.get(t);
      const ppWin = ccI != null ? m15.slice(Math.max(0, ccI - LB), ccI) : [];
      const bb = detect15MBreakOfStructure(m15[ccI], ppWin, atr15);
      if (bb.direction === 'BULLISH') microBull += 1; else if (bb.direction === 'BEARISH') microBear += 1;
      if (bb.decisiveBreak) microDec += 1;
    }
    pairBos[pair] = { h1BOS, pairScore, microBOS, microBull, microBear, microDec };
  }
  return { pairBos, latestH1Open };
}

/** Per-currency H1 structure aggregation from the current per-pair BOS. */
function aggregateStructureByCurrency(pairBos) {
  const aggByCur = {};
  for (const cur of CURRENCIES) {
    const entries = [];
    for (const pair of PAIRS) {
      if (pair.split('_')[0] !== cur && pair.split('_')[1] !== cur) continue;
      const pb = pairBos[pair];
      if (!pb || pb.h1BOS.atr20 <= 0) continue;   // no data → excluded from coverage
      entries.push({ pair, bos: pb.h1BOS, score: pb.pairScore });
    }
    aggByCur[cur] = aggregateCurrencyStructure(cur, entries);
  }
  return aggByCur;
}

/** Per-currency micro structure from the current per-pair 15M BOS, oriented by H1 dir. */
function microStructureByCurrency(pairBos, currency, h1Dir) {
  let bull = 0, bear = 0, dec = 0, avail = 0;
  for (const pair of PAIRS) {
    if (pair.split('_')[0] !== currency && pair.split('_')[1] !== currency) continue;
    const pb = pairBos[pair]; if (!pb) continue; avail += 1;
    const md = pb.microBOS.direction;
    if (md === 'NONE') continue;
    const cdir = currencyDirFromPair(pair, currency, md);
    if (cdir === 'BULLISH') bull += 1; else if (cdir === 'BEARISH') bear += 1;
    if (pb.microBOS.decisiveBreak) dec += 1;
  }
  const dir = bull > bear ? 'BULLISH' : bear > bull ? 'BEARISH' : (avail ? 'NONE' : null);
  const denom = avail || 1;
  const score = r1(Math.max(bull, bear) / denom * 100);
  return {
    direction: dir, score,
    confirmationState: classifyMicroAgreement(h1Dir, dir, dec),
    bullishBreakCount: bull, bearishBreakCount: bear, decisiveBreakCount: dec,
  };
}

function toMap(cands) { return new Map((Array.isArray(cands) ? cands : []).map((c) => [c.openMs, c])); }
const inPairs = (pair, cur) => { const p = pair.split('_'); return p[0] === cur || p[1] === cur; };

/** Per-window candle-by-candle BOS stats (no-lookahead: ATR per candle). */
function windowBosStats(wb, h1map) {
  let bull = 0, bear = 0, dec = 0, first = null, last = null, largest = 0, sumDist = 0, cnt = 0, latestDir = 'NONE';
  for (const pair of PAIRS) {
    const arr = [...h1map[pair].values()].sort((a, b) => a.openMs - b.openMs);
    const idx = new Map(arr.map((c, i) => [c.openMs, i]));
    const rAtr = rollingAtr(arr, 20);
    for (let h = wb.startOpenMs + HOUR_MS; h <= wb.endOpenMs; h += HOUR_MS) {
      const i = idx.get(h); if (i == null || i < 1) continue;
      const a = rAtr[i]; if (!(a > 0)) continue;
      const b = detectH1BreakOfStructure(arr[i], arr.slice(Math.max(0, i - BOS.STRUCTURE_LOOKBACK), i), a);
      if (b.direction === 'NONE') continue;
      if (b.direction === 'BULLISH') bull += 1; else bear += 1;
      if (b.decisiveBreak) dec += 1;
      const ts = new Date(h).toISOString(); if (!first) first = ts; last = ts; latestDir = b.direction;
      if (b.breakDistanceATR > largest) largest = b.breakDistanceATR; sumDist += b.breakDistanceATR; cnt += 1;
    }
  }
  return {
    firstBreakTime: first, latestBreakTime: last, bullishBreakCount: bull, bearishBreakCount: bear,
    decisiveBreakCount: dec, largestBreakDistanceATR: round(largest), averageBreakDistanceATR: cnt ? round(sumDist / cnt) : 0,
    latestStructureDirection: latestDir, windowStructurePersistence: round(Math.max(bull, bear) / ((bull + bear) || 1)),
  };
}

/** Evaluate one H1-bounded window (raw decomposition + per-hour dynamics + 15M refine + BOS). */
function evalH1Window(wb, h1map, m15map, atrMap, enhance15m, structSnap) {
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

  // ── BOS structure layer (additive) ──────────────────────────────────────────
  if (structSnap) {
    for (const cur of CURRENCIES) {
      const comp = currencies[cur];
      const agg = structSnap.aggByCur[cur];
      const movementDir = Math.sign(comp.rawMovement);
      const ss = currencyStructureScore(agg, movementDir);
      comp.structure = Object.assign({ agreement: classifyStructureAgreement(comp.movementScore, agg) }, ss);
      comp.structureScore = ss.structureScore;
      comp.confirmedMovementScore = confirmedMovementScore(comp.movementScore, ss.structureScore);
      comp.microStructure = microStructureByCurrency(structSnap.pairBos, cur, ss.structureDirection);
    }
  }

  return {
    status: 'OK',
    startOpenUtc: new Date(wb.startOpenMs).toISOString(),
    endCloseUtc: new Date(wb.endOpenMs + HOUR_MS).toISOString(),
    hours: hours.length, pairsUsed: sol.pairsUsed, ssr: sol.ssr,
    currencies, meta: wb.meta || null,
    bosStats: windowBosStats(wb, h1map),
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

/** Pair movement/structure edges + BOS opportunity classification (from the H1 window). */
function buildPairEdges(h1w, pairBos) {
  if (!h1w || h1w.status !== 'OK') return [];
  const cur = h1w.currencies;
  const edges = [];
  for (const pair of PAIRS) {
    const [b, q] = pair.split('_');
    const bC = cur[b], qC = cur[q]; if (!bC || !qC) continue;
    const pairMovementEdge = r1(bC.movementScore - qC.movementScore);
    const pairConfirmedEdge = r1((bC.confirmedMovementScore || 0) - (qC.confirmedMovementScore || 0));
    const bos = (pairBos[pair] || {}).h1BOS || null;
    const baseStructureScore = bC.structureScore || 0, quoteStructureScore = qC.structureScore || 0;
    const structureEdge = r1(baseStructureScore - quoteStructureScore);
    const edgeDir = Math.sign(pairMovementEdge);
    const bosDir = bos ? (bos.direction === 'BULLISH' ? 1 : bos.direction === 'BEARISH' ? -1 : 0) : 0;
    const grade = bos ? bos.strengthGrade : 'NO_BREAK';
    const strongBreak = grade === 'STRONG' || grade === 'VERY_STRONG' || grade === 'EXPLOSIVE';
    let opportunity = 'NO_MEANINGFUL_EDGE';
    if (edgeDir !== 0 && bosDir === edgeDir && strongBreak && bos.breakDistanceATR >= BOS.DECISIVE_ATR && bos.closeQuality >= BOS.DECISIVE_CLOSE_QUALITY && bos.priorBreak) opportunity = 'STRUCTURE_CONFIRMED_MOVEMENT';
    else if (edgeDir !== 0 && bosDir !== 0 && bosDir !== edgeDir) opportunity = 'STRUCTURE_CONFLICT';
    else if (Math.abs(pairMovementEdge) >= BOS.STRONG_MOVEMENT) opportunity = 'MOVEMENT_WATCH';
    edges.push({
      pair, baseCurrency: b, quoteCurrency: q, pairMovementEdge, pairConfirmedEdge,
      h1BreakOfStructure: bos, bosDirection: bos ? bos.direction : 'NONE', bosGrade: grade,
      breakDistanceATR: bos ? bos.breakDistanceATR : 0, closeQuality: bos ? bos.closeQuality : 0,
      baseStructureScore, quoteStructureScore, structureEdge,
      structureAgreement: bosDir === 0 ? 'NONE' : (bosDir === edgeDir ? 'AGREE' : 'CONFLICT'),
      opportunity,
    });
  }
  edges.sort((a, b) => Math.abs(b.pairConfirmedEdge) - Math.abs(a.pairConfirmedEdge));
  return edges;
}

/**
 * @param {Object} pairData { pair: { h1:[], m15:[] } } (completed candles)
 * @param {number} evalMs
 * @param {{enhance15m?:boolean}} [opts]
 * @returns {{windows:Object, pairEdges:Array, structureSnapshotAt:string, configurationVersion:string}}
 */
function evaluateWindows(pairData, evalMs, opts) {
  opts = opts || {};
  const enhance15m = opts.enhance15m !== false;
  const h1arr = {}, m15arr = {}, h1map = {}, m15map = {}, atrMap = {};
  for (const pair of PAIRS) {
    const pd = pairData[pair] || {};
    h1arr[pair] = Array.isArray(pd.h1) ? pd.h1 : [];
    m15arr[pair] = Array.isArray(pd.m15) ? pd.m15 : [];
    h1map[pair] = toMap(h1arr[pair]);
    m15map[pair] = toMap(m15arr[pair]);
    atrMap[pair] = atr(h1arr[pair], 20);
  }
  const snap = computeStructureSnapshot(h1arr, m15arr, evalMs);
  snap.aggByCur = aggregateStructureByCurrency(snap.pairBos);

  const windowsOut = {};
  for (const name of WINDOWS) {
    if (opts.primaryOnly && name !== 'H1') continue;   // sweep: primary window + edges only
    if (name === 'M15') { windowsOut[name] = evalM15Window(m15map, evalMs); continue; }
    const wb = windowBounds(name, evalMs);
    if (!wb.ok) { windowsOut[name] = { status: wb.status }; continue; }
    windowsOut[name] = evalH1Window(wb, h1map, m15map, atrMap, enhance15m, snap);
  }
  return {
    windows: windowsOut,
    pairEdges: buildPairEdges(windowsOut.H1, snap.pairBos),
    structureSnapshotAt: new Date(snap.latestH1Open + HOUR_MS).toISOString(),
    configurationVersion: CONFIGURATION_VERSION,
  };
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
      if (r.data.meta && r.data.meta.h1 && r.data.meta.h1.rejected) w.push('h1_malformed');
      if (r.data.meta && r.data.meta.h1 && r.data.meta.h1.gaps) w.push('h1_gaps');
      if (w.length) warnings.push({ pair: r.pair, warnings: w });
    }
  }

  const ev = evaluateWindows(pairData, evalMs, { enhance15m });
  return {
    engineKey: ENGINE_KEY,
    engineVersion: ENGINE_VERSION,
    configurationVersion: ev.configurationVersion,
    generatedAt: new Date(evalMs).toISOString(),
    enhance15m,
    windows: ev.windows,
    pairEdges: ev.pairEdges,
    structureSnapshotAt: ev.structureSnapshotAt,
    pairsRequested: PAIRS.length,
    pairsEvaluated: Object.keys(pairData).length,
    pairErrors,
    dataWarnings: warnings,
  };
}

module.exports = { evaluateWindows, evalH1Window, evalM15Window, scanAll };
