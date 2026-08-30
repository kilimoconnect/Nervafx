'use strict';

/**
 * NervaFX Currency Movement Engine (5M) — scan orchestration.
 *
 * Timeframe-shifted mirror of _cme30-scan.js with the micro layer removed (M5 is
 * the finest available timeframe). The primary/structural timeframe is M5 and a
 * Break of Structure is a decisive close beyond the previous 60 completed M5
 * candles. Reuses all pure maths from the H1 engine's modules.
 */

const {
  HOUR_MS, BASE_MS, CURRENCIES, PAIRS, WINDOWS,
  ENGINE_KEY, ENGINE_VERSION, CONFIGURATION_VERSION, BOS,
} = require('./_cme05-constants');
const { pairLogReturn, pairMoveATR, solveCurrencySystem, signedContribution } = require('./_cme-math');
const { computeCurrencyComponents, assignRanks } = require('./_cme-features');
const { windowBounds } = require('./_cme-windows');
const {
  detectH1BreakOfStructure, calculatePairStructureScore,
  aggregateCurrencyStructure, currencyStructureScore, classifyStructureAgreement, confirmedMovementScore,
} = require('./_cme-structure');
const { atr } = require('./_h1c-math');

const round = (v) => Math.round(v * 100000) / 100000;
const r1 = (v) => Math.round(v * 10) / 10;

const detectBaseBOS = detectH1BreakOfStructure;   // M5 primary

function rollingAtr(candles, period) {
  const out = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) out[i] = atr(candles.slice(0, i + 1), period);
  return out;
}

function computeStructureSnapshot(baseArr, evalMs) {
  const LB = BOS.STRUCTURE_LOOKBACK;
  const latestBaseOpen = Math.floor(evalMs / BASE_MS) * BASE_MS - BASE_MS;
  const pairBos = {};
  for (const pair of PAIRS) {
    const b5 = baseArr[pair] || [];
    const bIdx = new Map(b5.map((c, i) => [c.openMs, i]));
    const curI = bIdx.get(latestBaseOpen);
    const cur = b5[curI];
    const prevWin = curI != null ? b5.slice(Math.max(0, curI - LB), curI) : [];
    const atr20 = atr(b5, 20);
    const h1BOS = detectBaseBOS(cur, prevWin, atr20);
    pairBos[pair] = { h1BOS, pairScore: calculatePairStructureScore(h1BOS) };
  }
  return { pairBos, latestBaseOpen };
}

function aggregateStructureByCurrency(pairBos) {
  const aggByCur = {};
  for (const cur of CURRENCIES) {
    const entries = [];
    for (const pair of PAIRS) {
      if (pair.split('_')[0] !== cur && pair.split('_')[1] !== cur) continue;
      const pb = pairBos[pair];
      if (!pb || pb.h1BOS.atr20 <= 0) continue;
      entries.push({ pair, bos: pb.h1BOS, score: pb.pairScore });
    }
    aggByCur[cur] = aggregateCurrencyStructure(cur, entries);
  }
  return aggByCur;
}

function toMap(cands) { return new Map((Array.isArray(cands) ? cands : []).map((c) => [c.openMs, c])); }
const inPairs = (pair, cur) => { const p = pair.split('_'); return p[0] === cur || p[1] === cur; };

function windowBosStats(firstOpenMs, lastOpenMs, basemap) {
  let bull = 0, bear = 0, dec = 0, first = null, last = null, largest = 0, sumDist = 0, cnt = 0, latestDir = 'NONE';
  for (const pair of PAIRS) {
    const arr = [...basemap[pair].values()].sort((a, b) => a.openMs - b.openMs);
    const idx = new Map(arr.map((c, i) => [c.openMs, i]));
    const rAtr = rollingAtr(arr, 20);
    for (let h = firstOpenMs + BASE_MS; h <= lastOpenMs; h += BASE_MS) {
      const i = idx.get(h); if (i == null || i < 1) continue;
      const a = rAtr[i]; if (!(a > 0)) continue;
      const b = detectBaseBOS(arr[i], arr.slice(Math.max(0, i - BOS.STRUCTURE_LOOKBACK), i), a);
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

function evalBaseWindow(firstOpenMs, lastOpenMs, meta, basemap, atrMap, structSnap) {
  const steps = [];
  for (let t = firstOpenMs; t <= lastOpenMs; t += BASE_MS) steps.push(t);

  const pairReturns = {};
  const pairInfo = [];
  for (const pair of PAIRS) {
    const startC = basemap[pair].get(firstOpenMs);
    const endC = basemap[pair].get(lastOpenMs);
    if (!startC || !endC) continue;
    const lr = pairLogReturn(startC.open, endC.close);
    if (lr == null) continue;
    pairReturns[pair] = lr;
    pairInfo.push({ pair, logReturn: lr, moveATR: pairMoveATR(startC.open, endC.close, atrMap[pair]) });
  }
  const sol = solveCurrencySystem(pairReturns);

  const stepByCur = {}; CURRENCIES.forEach((c) => { stepByCur[c] = []; });
  for (const t of steps) {
    const hr = {};
    for (const pair of PAIRS) { const c = basemap[pair].get(t); if (!c) continue; const lr = pairLogReturn(c.open, c.close); if (lr != null) hr[pair] = lr; }
    if (!Object.keys(hr).length) continue;
    const hs = solveCurrencySystem(hr);
    CURRENCIES.forEach((c) => stepByCur[c].push(hs.movement[c]));
  }

  const currencies = {};
  for (const cur of CURRENCIES) {
    const raw = sol.movement[cur] || 0;
    const contribs = pairInfo.filter((pi) => inPairs(pi.pair, cur)).map((pi) => signedContribution(pi.pair, pi.logReturn, cur));
    currencies[cur] = computeCurrencyComponents({ rawMovement: raw, hourlySeq: stepByCur[cur], contribsH1: contribs, micro: null });
  }
  assignRanks(currencies);

  if (structSnap) {
    for (const cur of CURRENCIES) {
      const comp = currencies[cur];
      const agg = structSnap.aggByCur[cur];
      const movementDir = Math.sign(comp.rawMovement);
      const ss = currencyStructureScore(agg, movementDir);
      comp.structure = Object.assign({ agreement: classifyStructureAgreement(comp.movementScore, agg) }, ss);
      comp.structureScore = ss.structureScore;
      comp.confirmedMovementScore = confirmedMovementScore(comp.movementScore, ss.structureScore);
    }
  }

  return {
    status: 'OK',
    startOpenUtc: new Date(firstOpenMs).toISOString(),
    endCloseUtc: new Date(lastOpenMs + BASE_MS).toISOString(),
    steps: steps.length, stepMinutes: BASE_MS / 60000, pairsUsed: sol.pairsUsed, ssr: sol.ssr,
    currencies, meta: meta || null,
    bosStats: windowBosStats(firstOpenMs, lastOpenMs, basemap),
  };
}

function buildPairEdges(primaryW, pairBos) {
  if (!primaryW || primaryW.status !== 'OK') return [];
  const cur = primaryW.currencies;
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
    if (edgeDir !== 0 && bosDir === edgeDir && strongBreak && bos.breakDistanceATR >= BOS.DECISIVE_ATR && bos.closeQuality >= BOS.DECISIVE_CLOSE_QUALITY) opportunity = 'STRUCTURE_CONFIRMED_MOVEMENT';
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

function evaluateWindows(pairData, evalMs, opts) {
  opts = opts || {};
  const baseArr = {}, basemap = {}, atrMap = {};
  for (const pair of PAIRS) {
    const pd = pairData[pair] || {};
    baseArr[pair] = Array.isArray(pd.m5) ? pd.m5 : [];
    basemap[pair] = toMap(baseArr[pair]);
    atrMap[pair] = atr(baseArr[pair], 20);
  }
  const snap = computeStructureSnapshot(baseArr, evalMs);
  snap.aggByCur = aggregateStructureByCurrency(snap.pairBos);

  const windowsOut = {};
  for (const name of WINDOWS) {
    if (opts.primaryOnly && name !== 'M5') continue;   // sweep: primary window + edges only
    if (name === 'M5') {
      const lastBaseOpen = Math.floor(evalMs / BASE_MS) * BASE_MS - BASE_MS;
      windowsOut[name] = lastBaseOpen < 0 ? { status: 'NOT_ACTIVE' }
        : evalBaseWindow(lastBaseOpen, lastBaseOpen, null, basemap, atrMap, snap);
      continue;
    }
    const wb = windowBounds(name, evalMs);
    if (!wb.ok) { windowsOut[name] = { status: wb.status }; continue; }
    windowsOut[name] = evalBaseWindow(wb.startOpenMs, wb.endOpenMs + HOUR_MS - BASE_MS, wb.meta, basemap, atrMap, snap);
  }
  return {
    windows: windowsOut,
    pairEdges: buildPairEdges(windowsOut.M5, snap.pairBos),
    structureSnapshotAt: new Date(snap.latestBaseOpen + BASE_MS).toISOString(),
    configurationVersion: CONFIGURATION_VERSION,
  };
}

async function scanAll(sb, opts) {
  opts = opts || {};
  const evalMs = opts.evalMs != null ? opts.evalMs : Date.now();
  const { fetchPair05 } = require('./_cme05-data');

  const pairData = {};
  const pairErrors = [];
  const warnings = [];
  for (let i = 0; i < PAIRS.length; i += 7) {
    const batch = PAIRS.slice(i, i + 7);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(batch.map(async (pair) => {
      try { return { pair, data: await fetchPair05(sb, pair, evalMs, {}) }; }
      catch (e) { return { pair, error: e.message }; }
    }));
    for (const r of results) {
      if (r.error) { pairErrors.push({ pair: r.pair, error: r.error }); continue; }
      pairData[r.pair] = r.data;
      const w = [];
      if ((r.data.m5 || []).length < 80) w.push('m5_short');
      if (r.data.meta && r.data.meta.m5 && r.data.meta.m5.gaps) w.push('m5_gaps');
      if (w.length) warnings.push({ pair: r.pair, warnings: w });
    }
  }

  const ev = evaluateWindows(pairData, evalMs);
  return {
    engineKey: ENGINE_KEY,
    engineVersion: ENGINE_VERSION,
    configurationVersion: ev.configurationVersion,
    generatedAt: new Date(evalMs).toISOString(),
    windows: ev.windows,
    pairEdges: ev.pairEdges,
    structureSnapshotAt: ev.structureSnapshotAt,
    pairsRequested: PAIRS.length,
    pairsEvaluated: Object.keys(pairData).length,
    pairErrors,
    dataWarnings: warnings,
  };
}

module.exports = { evaluateWindows, evalBaseWindow, scanAll };
