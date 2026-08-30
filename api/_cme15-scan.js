'use strict';

/**
 * NervaFX Currency Movement Engine (15M twin) — scan orchestration.
 *
 * A faithful timeframe-shifted mirror of _cme-scan.js: the primary/structural
 * timeframe is M15 (BOS over the previous 20 completed M15 candles) and the
 * micro-confirmation layer is M5. All pure maths (decomposition, movement
 * components, BOS detection, windows) is reused from the H1 engine's modules —
 * only the candle timeframe, the BOS lookback, and the spot windows differ.
 */

const {
  HOUR_MS, M15_MS, M5_MS, MICRO_PER_BASE, CURRENCIES, PAIRS, WINDOWS,
  ENGINE_KEY, ENGINE_VERSION, CONFIGURATION_VERSION, BOS,
} = require('./_cme15-constants');
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

// Primary-timeframe BOS detector = generic detector with the M15 candle stream.
const detectBaseBOS = detectH1BreakOfStructure;   // M15 primary
const detectMicroBOS = detect15MBreakOfStructure; // M5 micro

/** ATR ending at each candle index (no-lookahead) — atr[i] uses candles[0..i]. */
function rollingAtr(candles, period) {
  const out = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) out[i] = atr(candles.slice(0, i + 1), period);
  return out;
}

/**
 * Current structural snapshot as of evalMs: per-pair M15 (primary) + M5 (micro)
 * BOS, each vs the previous BOS.STRUCTURE_LOOKBACK (20) candles, plus per-pair
 * micro counts over the M5 candles inside the latest M15.
 */
function computeStructureSnapshot(m15arr, m5arr, evalMs) {
  const LB = BOS.STRUCTURE_LOOKBACK;
  const latestBaseOpen = Math.floor(evalMs / M15_MS) * M15_MS - M15_MS;
  const latestMicroOpen = Math.floor(evalMs / M5_MS) * M5_MS - M5_MS;
  const pairBos = {};
  for (const pair of PAIRS) {
    const m15 = m15arr[pair] || [];
    const m5 = m5arr[pair] || [];
    const m15Idx = new Map(m15.map((c, i) => [c.openMs, i]));
    const curI = m15Idx.get(latestBaseOpen);
    const cur = m15[curI];
    const prevWin = curI != null ? m15.slice(Math.max(0, curI - LB), curI) : [];
    const atr20 = atr(m15, 20);
    const h1BOS = detectBaseBOS(cur, prevWin, atr20);
    const pairScore = calculatePairStructureScore(h1BOS);

    // M5 micro BOS on the latest completed M5 + counts over the last 3 (this M15).
    const m5Idx = new Map(m5.map((c, i) => [c.openMs, i]));
    const atr5 = atr(m5, 20);
    const mcurI = m5Idx.get(latestMicroOpen);
    const mprevWin = mcurI != null ? m5.slice(Math.max(0, mcurI - LB), mcurI) : [];
    const microBOS = detectMicroBOS(m5[mcurI], mprevWin, atr5);
    let microBull = 0, microBear = 0, microDec = 0;
    for (let k = 0; k < MICRO_PER_BASE; k++) {
      const t = latestBaseOpen + k * M5_MS;
      const ccI = m5Idx.get(t);
      const ppWin = ccI != null ? m5.slice(Math.max(0, ccI - LB), ccI) : [];
      const bb = detectMicroBOS(m5[ccI], ppWin, atr5);
      if (bb.direction === 'BULLISH') microBull += 1; else if (bb.direction === 'BEARISH') microBear += 1;
      if (bb.decisiveBreak) microDec += 1;
    }
    pairBos[pair] = { h1BOS, pairScore, microBOS, microBull, microBear, microDec };
  }
  return { pairBos, latestBaseOpen };
}

/** Per-currency M15 structure aggregation from the current per-pair BOS. */
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

/** Per-currency micro structure from the current per-pair M5 BOS, oriented by M15 dir. */
function microStructureByCurrency(pairBos, currency, baseDir) {
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
    confirmationState: classifyMicroAgreement(baseDir, dir, dec),
    bullishBreakCount: bull, bearishBreakCount: bear, decisiveBreakCount: dec,
  };
}

function toMap(cands) { return new Map((Array.isArray(cands) ? cands : []).map((c) => [c.openMs, c])); }
const inPairs = (pair, cur) => { const p = pair.split('_'); return p[0] === cur || p[1] === cur; };

/** Per-window candle-by-candle M15 BOS stats (no-lookahead: ATR per candle). */
function windowBosStats(firstOpenMs, lastOpenMs, m15map) {
  let bull = 0, bear = 0, dec = 0, first = null, last = null, largest = 0, sumDist = 0, cnt = 0, latestDir = 'NONE';
  for (const pair of PAIRS) {
    const arr = [...m15map[pair].values()].sort((a, b) => a.openMs - b.openMs);
    const idx = new Map(arr.map((c, i) => [c.openMs, i]));
    const rAtr = rollingAtr(arr, 20);
    for (let h = firstOpenMs + M15_MS; h <= lastOpenMs; h += M15_MS) {
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

/**
 * Evaluate one M15-stepped window [firstOpenMs, lastOpenMs] (both M15 opens):
 * raw decomposition + per-M15 dynamics + M5 micro refine + BOS layer.
 */
function evalBaseWindow(firstOpenMs, lastOpenMs, meta, m15map, m5map, atrMap, enhanceMicro, structSnap) {
  const steps = [];
  for (let t = firstOpenMs; t <= lastOpenMs; t += M15_MS) steps.push(t);
  const lastMicroOpen = lastOpenMs + M15_MS - M5_MS;

  // Window-level pair returns (first M15 open → last M15 close).
  const pairReturns = {};
  const pairInfo = [];
  for (const pair of PAIRS) {
    const startC = m15map[pair].get(firstOpenMs);
    const endC = m15map[pair].get(lastOpenMs);
    if (!startC || !endC) continue;
    const lr = pairLogReturn(startC.open, endC.close);
    if (lr == null) continue;
    pairReturns[pair] = lr;
    pairInfo.push({ pair, logReturn: lr, moveATR: pairMoveATR(startC.open, endC.close, atrMap[pair]) });
  }
  const sol = solveCurrencySystem(pairReturns);

  // Per-M15 movement sequence (for efficiency / persistence / acceleration).
  const stepByCur = {}; CURRENCIES.forEach((c) => { stepByCur[c] = []; });
  for (const t of steps) {
    const hr = {};
    for (const pair of PAIRS) { const c = m15map[pair].get(t); if (!c) continue; const lr = pairLogReturn(c.open, c.close); if (lr != null) hr[pair] = lr; }
    if (!Object.keys(hr).length) continue;
    const hs = solveCurrencySystem(hr);
    CURRENCIES.forEach((c) => stepByCur[c].push(hs.movement[c]));
  }

  // M5 micro sequence (per M5 step) + M5 window returns (for micro breadth).
  const microByCur = {}; CURRENCIES.forEach((c) => { microByCur[c] = []; });
  const microContrib = {}; CURRENCIES.forEach((c) => { microContrib[c] = []; });
  if (enhanceMicro) {
    for (let t = firstOpenMs; t <= lastMicroOpen; t += M5_MS) {
      const mr = {};
      for (const pair of PAIRS) { const c = m5map[pair].get(t); if (!c) continue; const lr = pairLogReturn(c.open, c.close); if (lr != null) mr[pair] = lr; }
      if (!Object.keys(mr).length) continue;
      const ms = solveCurrencySystem(mr);
      CURRENCIES.forEach((c) => microByCur[c].push(ms.movement[c]));
    }
    for (const pair of PAIRS) {
      const s = m5map[pair].get(firstOpenMs);
      const e = m5map[pair].get(lastMicroOpen);
      if (!s || !e) continue;
      const lr = pairLogReturn(s.open, e.close);
      if (lr == null) continue;
      for (const cur of CURRENCIES) if (inPairs(pair, cur)) microContrib[cur].push(signedContribution(pair, lr, cur));
    }
  }

  const currencies = {};
  for (const cur of CURRENCIES) {
    const raw = sol.movement[cur] || 0;
    const dir = Math.sign(raw);
    const contribs = pairInfo.filter((pi) => inPairs(pi.pair, cur)).map((pi) => signedContribution(pi.pair, pi.logReturn, cur));
    let micro = null;
    if (enhanceMicro) {
      const seq = microByCur[cur];
      const mf = microFeatures(seq, dir);
      const mc = microContrib[cur];
      const microBreadthVal = mc.length && dir !== 0 ? mc.filter((v) => Math.sign(v) === dir).length / mc.length : 0;
      micro = { microPersistence: mf.microPersistence, microAcceleration: mf.microAcceleration, microBreadth: microBreadthVal, microState: mf.microState, path15m: seq.reduce((a, v) => a + Math.abs(v), 0) };
    }
    currencies[cur] = computeCurrencyComponents({ rawMovement: raw, hourlySeq: stepByCur[cur], contribsH1: contribs, micro });
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
    startOpenUtc: new Date(firstOpenMs).toISOString(),
    endCloseUtc: new Date(lastOpenMs + M15_MS).toISOString(),
    steps: steps.length, stepMinutes: 15, pairsUsed: sol.pairsUsed, ssr: sol.ssr,
    currencies, meta: meta || null,
    bosStats: windowBosStats(firstOpenMs, lastOpenMs, m15map),
  };
}

/** The M5 window: the latest completed M5 candle only (intra-15m snapshot). */
function evalMicroSpotWindow(m5map, evalMs) {
  const lastClose = Math.floor(evalMs / M5_MS) * M5_MS;
  const open = lastClose - M5_MS;
  const returns = {};
  const pairInfo = [];
  for (const pair of PAIRS) { const c = m5map[pair].get(open); if (!c) continue; const lr = pairLogReturn(c.open, c.close); if (lr == null) continue; returns[pair] = lr; pairInfo.push({ pair, logReturn: lr }); }
  if (!pairInfo.length) return { status: 'NOT_ACTIVE' };
  const sol = solveCurrencySystem(returns);
  const currencies = {};
  for (const cur of CURRENCIES) {
    const raw = sol.movement[cur] || 0;
    const contribs = pairInfo.filter((pi) => inPairs(pi.pair, cur)).map((pi) => signedContribution(pi.pair, pi.logReturn, cur));
    currencies[cur] = computeCurrencyComponents({ rawMovement: raw, hourlySeq: [raw], contribsH1: contribs, micro: null });
  }
  assignRanks(currencies);
  return { status: 'OK', startOpenUtc: new Date(open).toISOString(), endCloseUtc: new Date(lastClose).toISOString(), steps: 1, stepMinutes: 5, pairsUsed: sol.pairsUsed, ssr: sol.ssr, currencies };
}

/** Pair movement/structure edges + BOS opportunity classification (from the primary M15 window). */
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
 * @param {Object} pairData { pair: { m15:[], m5:[] } } (completed candles)
 * @param {number} evalMs
 * @param {{enhanceMicro?:boolean}} [opts]
 */
function evaluateWindows(pairData, evalMs, opts) {
  opts = opts || {};
  const enhanceMicro = opts.enhanceMicro !== false;
  const m15arr = {}, m5arr = {}, m15map = {}, m5map = {}, atrMap = {};
  for (const pair of PAIRS) {
    const pd = pairData[pair] || {};
    m15arr[pair] = Array.isArray(pd.m15) ? pd.m15 : [];
    m5arr[pair] = Array.isArray(pd.m5) ? pd.m5 : [];
    m15map[pair] = toMap(m15arr[pair]);
    m5map[pair] = toMap(m5arr[pair]);
    atrMap[pair] = atr(m15arr[pair], 20);
  }
  const snap = computeStructureSnapshot(m15arr, m5arr, evalMs);
  snap.aggByCur = aggregateStructureByCurrency(snap.pairBos);

  const windowsOut = {};
  for (const name of WINDOWS) {
    if (opts.primaryOnly && name !== 'M15') continue;   // sweep: primary window + edges only
    if (name === 'M15') {
      const lastBaseOpen = Math.floor(evalMs / M15_MS) * M15_MS - M15_MS;
      windowsOut[name] = lastBaseOpen < 0 ? { status: 'NOT_ACTIVE' }
        : evalBaseWindow(lastBaseOpen, lastBaseOpen, null, m15map, m5map, atrMap, enhanceMicro, snap);
      continue;
    }
    if (name === 'M5') { windowsOut[name] = evalMicroSpotWindow(m5map, evalMs); continue; }
    const wb = windowBounds(name, evalMs);
    if (!wb.ok) { windowsOut[name] = { status: wb.status }; continue; }
    windowsOut[name] = evalBaseWindow(wb.startOpenMs, wb.endOpenMs + HOUR_MS - M15_MS, wb.meta, m15map, m5map, atrMap, enhanceMicro, snap);
  }
  return {
    windows: windowsOut,
    pairEdges: buildPairEdges(windowsOut.M15, snap.pairBos),
    structureSnapshotAt: new Date(snap.latestBaseOpen + M15_MS).toISOString(),
    configurationVersion: CONFIGURATION_VERSION,
  };
}

async function scanAll(sb, opts) {
  opts = opts || {};
  const evalMs = opts.evalMs != null ? opts.evalMs : Date.now();
  const enhanceMicro = opts.enhanceMicro !== false;
  const { fetchPair15 } = require('./_cme15-data');

  const pairData = {};
  const pairErrors = [];
  const warnings = [];
  for (let i = 0; i < PAIRS.length; i += 7) {
    const batch = PAIRS.slice(i, i + 7);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(batch.map(async (pair) => {
      try { return { pair, data: await fetchPair15(sb, pair, evalMs, {}) }; }
      catch (e) { return { pair, error: e.message }; }
    }));
    for (const r of results) {
      if (r.error) { pairErrors.push({ pair: r.pair, error: r.error }); continue; }
      pairData[r.pair] = r.data;
      const w = [];
      if ((r.data.m15 || []).length < 24) w.push('m15_short');
      if (r.data.meta && r.data.meta.m15 && r.data.meta.m15.rejected) w.push('m15_malformed');
      if (r.data.meta && r.data.meta.m15 && r.data.meta.m15.gaps) w.push('m15_gaps');
      if (w.length) warnings.push({ pair: r.pair, warnings: w });
    }
  }

  const ev = evaluateWindows(pairData, evalMs, { enhanceMicro });
  return {
    engineKey: ENGINE_KEY,
    engineVersion: ENGINE_VERSION,
    configurationVersion: ev.configurationVersion,
    generatedAt: new Date(evalMs).toISOString(),
    enhanceMicro,
    windows: ev.windows,
    pairEdges: ev.pairEdges,
    structureSnapshotAt: ev.structureSnapshotAt,
    pairsRequested: PAIRS.length,
    pairsEvaluated: Object.keys(pairData).length,
    pairErrors,
    dataWarnings: warnings,
  };
}

module.exports = { evaluateWindows, evalBaseWindow, evalMicroSpotWindow, scanAll };
