'use strict';

/**
 * Backfill hourly_session_activity + market_energy_sessions from backtest_candles.
 *
 * Reads ALL H1 candles from backtest_candles, groups them into the same
 * byTime structure that sessionActivity.processHours() expects, then
 * computes every metric (movement, momentum, agreement, volatility, energy,
 * liquidity, energy_cycle, etc.) and upserts into the two archive tables.
 *
 * Usage:
 *   node src/backfillArchive.js                 # full 12-month backfill
 *   node src/backfillArchive.js --from 2025-09  # from September 2025
 *   node src/backfillArchive.js --days 30       # last 30 days only
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { config }            = require('./config');
const { getCurrentSession } = require('./sessionEngine');

// ── DB ──────────────────────────────────────────────────────────────────────

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Helpers (mirrored from sessionActivity.js) ──────────────────────────────

function round1(v)  { return Math.round(v * 10) / 10; }
function ri(v)      { return Math.round(parseFloat(v) || 0); }
function arrAvg(a)  { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }

function pctVsRef(current, ref) {
  if (!ref) return null;
  const pct = Math.round((current / ref - 1) * 100);
  return Math.abs(pct) > 200 ? null : pct;
}

const CURRENCIES = ['GBP', 'EUR', 'USD', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

function computeCurrencyStrengths(candles, sessionOpenPrices) {
  const sums = {}, counts = {};
  for (const ccy of CURRENCIES) { sums[ccy] = 0; counts[ccy] = 0; }
  for (const inst of config.instruments) {
    const [base, quote] = inst.split('_');
    const c    = candles[inst];
    const open = sessionOpenPrices[inst];
    if (!c || !open || open === 0) continue;
    const move = (c.close - open) / open;
    sums[base]  += move;  counts[base]++;
    sums[quote] -= move;  counts[quote]++;
  }
  const strength = {};
  for (const ccy of CURRENCIES) {
    strength[ccy] = counts[ccy] > 0 ? sums[ccy] / counts[ccy] : 0;
  }
  return strength;
}

// ── Session classification ──────────────────────────────────────────────────

function classifyHour(isoTime) {
  return getCurrentSession(new Date(isoTime)).session;
}

// ── Energy cycle (from sessionActivity.js) ──────────────────────────────────

const SESSION_QUALITY_SCORE = { LOW_LIQUIDITY: 0, ASIA: 45, LONDON: 80, NEW_YORK: 80 };

const SESS_PROFILE = {
  ASIA: {
    deadMov: 10, deadBrd:  8, deadVol: 12,
    exMov:   52, exBrd:   42, exAgr:   48,
    expMov:  28, expBrd:  18, expAgr:  24,
    exhMov:  28,
    trBrd:   14, trAgr:   20, trMov:   18,
    cmpBrd:  14,
  },
  LONDON: {
    deadMov: 15, deadBrd: 12, deadVol: 18,
    exMov:   68, exBrd:   62, exAgr:   62,
    expMov:  42, expBrd:  35, expAgr:  36,
    exhMov:  42,
    trBrd:   22, trAgr:   30, trMov:   28,
    cmpBrd:  22,
  },
  NEW_YORK: {
    deadMov: 15, deadBrd: 12, deadVol: 18,
    exMov:   72, exBrd:   65, exAgr:   65,
    expMov:  48, expBrd:  38, expAgr:  38,
    exhMov:  48,
    trBrd:   24, trAgr:   30, trMov:   32,
    cmpBrd:  24,
  },
  DEFAULT: {
    deadMov: 20, deadBrd: 20, deadVol: 25,
    exMov:   75, exBrd:   70, exAgr:   70,
    expMov:  50, expBrd:  45, expAgr:  45,
    exhMov:  50,
    trBrd:   35, trAgr:   45, trMov:   30,
    cmpBrd:  35,
  },
};

function classifyEnergyCycle(mov, brd, agr, vol, streak, accel, prev, session) {
  const p = SESS_PROFILE[session] || SESS_PROFILE.DEFAULT;
  const movRising  = prev ? mov > prev.movement : false;
  const brdRising  = prev ? brd > prev.breadth  : false;
  const brdFalling = prev ? brd < prev.breadth  : false;

  if (mov < p.deadMov && brd < p.deadBrd && vol < p.deadVol)                      return 'DEAD';
  if (mov >= p.exMov  && brd >= p.exBrd  && agr >= p.exAgr)                       return 'EXPLOSIVE';
  if (mov >= p.exhMov && accel < 0 && brdFalling)                                 return 'EXHAUSTION';
  if (mov >= p.expMov && brd >= p.expBrd && agr >= p.expAgr)                      return 'EXPANSION';
  if (movRising && brdRising && accel > 0 && brd > p.trBrd && agr > p.trAgr && mov >= p.trMov)
    return 'TRANSITION';
  if (brd < p.cmpBrd && streak >= 1)                                               return 'COMPRESSION';
  return 'LOW_PARTICIPATION';
}

// ── Core processHours (from sessionActivity.js) ─────────────────────────────

function processHours(hourKeys, byTime) {
  const TOTAL = config.instruments.length;
  const HIST  = 20;

  const moveHistory  = {};
  const rangeHistory = {};
  const pairEma      = {};

  let currentSession    = null;
  let sessionOpenPrices = {};
  let sessionHigh       = {};
  let sessionLow        = {};
  let sessionFinalMove  = {};

  const prevSameSessionEnergy = {};
  const prevSameSessionScores = {};
  let compressionStreak = 0;

  let sessionEBList  = [];
  let sessionMovList = [];
  let sessionBrdList = [];
  let sessionAgrList = [];
  let sessionVolList = [];

  const rows = [];

  for (const hk of hourKeys) {
    const candles = byTime[hk];
    const session = classifyHour(hk);

    if (session !== currentSession) {
      if (currentSession && currentSession !== 'LOW_LIQUIDITY') {
        for (const inst of config.instruments) {
          const finalMove = sessionFinalMove[inst];
          if (finalMove != null) {
            if (!moveHistory[inst])                moveHistory[inst]                = {};
            if (!moveHistory[inst][currentSession]) moveHistory[inst][currentSession] = [];
            moveHistory[inst][currentSession].push(finalMove);
            if (moveHistory[inst][currentSession].length > HIST) moveHistory[inst][currentSession].shift();
          }
          const high = sessionHigh[inst], low = sessionLow[inst], open = sessionOpenPrices[inst];
          if (high != null && low != null && open > 0) {
            const range = (high - low) / open;
            if (!rangeHistory[inst])                rangeHistory[inst]                = {};
            if (!rangeHistory[inst][currentSession]) rangeHistory[inst][currentSession] = [];
            rangeHistory[inst][currentSession].push(range);
            if (rangeHistory[inst][currentSession].length > HIST) rangeHistory[inst][currentSession].shift();
          }
        }
        const avgMov = arrAvg(sessionMovList);
        const avgBrd = arrAvg(sessionBrdList);
        const avgVol = arrAvg(sessionVolList);

        if (avgMov < 35 && avgBrd < 35 && avgVol < 40) compressionStreak++;
        else compressionStreak = 0;

        if (sessionEBList.length) prevSameSessionEnergy[currentSession] = arrAvg(sessionEBList);
        prevSameSessionScores[currentSession] = { movement: avgMov, breadth: avgBrd, agreement: arrAvg(sessionAgrList), volatility: avgVol };
      }

      sessionOpenPrices = {};
      sessionHigh       = {};
      sessionLow        = {};
      sessionFinalMove  = {};
      sessionEBList     = [];
      sessionMovList    = [];
      sessionBrdList    = [];
      sessionAgrList    = [];
      sessionVolList    = [];

      for (const [inst, c] of Object.entries(candles)) {
        sessionOpenPrices[inst] = c.open;  // use candle OPEN, not close — close=open makes rawDir=0
        sessionHigh[inst]       = c.high;
        sessionLow[inst]        = c.low;
      }
      currentSession = session;
    }

    if (session === 'LOW_LIQUIDITY') continue;

    for (const [inst, c] of Object.entries(candles)) {
      if (c.high != null && (sessionHigh[inst] == null || c.high > sessionHigh[inst])) sessionHigh[inst] = c.high;
      if (c.low  != null && (sessionLow[inst]  == null || c.low  < sessionLow[inst]))  sessionLow[inst]  = c.low;
    }

    const ccyStrength = computeCurrencyStrengths(candles, sessionOpenPrices);

    let strongestCcy = null, weakestCcy = null;
    {
      const sorted = Object.entries(ccyStrength).sort((a, b) => b[1] - a[1]);
      if (sorted.length >= 2) {
        strongestCcy = sorted.slice(0, 2).map(e => e[0]).join(',');
        weakestCcy   = sorted.slice(-2).reverse().map(e => e[0]).join(',');
      }
    }

    const smoothMoveVals   = [];
    const normalizedRanges = [];
    let alignedActive = 0, totalActive = 0;
    let bullishMagnitude = 0, bearishMagnitude = 0;

    for (const inst of config.instruments) {
      const c    = candles[inst];
      const open = sessionOpenPrices[inst];
      if (!c || open == null || open === 0) continue;

      const rawDir  = (c.close - open) / open;
      const rawMove = Math.abs(rawDir);
      sessionFinalMove[inst] = rawMove;

      const mhist  = moveHistory[inst]?.[session] || [];
      const mhAvg  = mhist.length > 0 ? arrAvg(mhist) : rawMove;
      const normMov = mhAvg > 0 ? rawMove / mhAvg : 1.0;

      if (!pairEma[inst]) pairEma[inst] = {};
      const prevEma    = pairEma[inst][session] ?? normMov;
      const smoothMove = (prevEma + normMov) / 2;
      pairEma[inst][session] = smoothMove;
      smoothMoveVals.push(smoothMove);

      if (rawDir > 0) bullishMagnitude += smoothMove;
      else if (rawDir < 0) bearishMagnitude += smoothMove;

      if (smoothMove >= 1.0) {
        totalActive++;
        const [base, quote] = inst.split('_');
        const expectedDir   = (ccyStrength[base] || 0) - (ccyStrength[quote] || 0);
        if ((expectedDir > 0 && rawDir > 0) || (expectedDir < 0 && rawDir < 0)) alignedActive++;
      }

      const high = sessionHigh[inst], low = sessionLow[inst];
      if (high != null && low != null) {
        const range = (high - low) / open;
        const rhist = rangeHistory[inst]?.[session] || [];
        const rhAvg = rhist.length > 0 ? arrAvg(rhist) : range;
        normalizedRanges.push(rhAvg > 0 ? range / rhAvg : 1.0);
      }
    }

    if (!smoothMoveVals.length) continue;

    const moveMagnitude  = arrAvg(smoothMoveVals);
    const movementScore  = round1(Math.min(100, moveMagnitude * 50));
    const activePairs    = smoothMoveVals.filter(m => m >= 1.0).length;
    const breadthScore   = round1((activePairs / TOTAL) * 100);

    const rawAgreementRatio = totalActive > 0 ? alignedActive / totalActive : 0;
    const agreementScore    = round1(rawAgreementRatio * Math.sqrt(breadthScore / 100) * 100);

    const totalMagnitude     = bullishMagnitude + bearishMagnitude;
    const bullishPressurePct = totalMagnitude > 0 ? round1(bullishMagnitude / totalMagnitude * 100) : 50;
    const bearishPressurePct = totalMagnitude > 0 ? round1(bearishMagnitude / totalMagnitude * 100) : 50;
    const dominanceScore     = totalMagnitude > 0 ? round1(Math.abs(bullishMagnitude - bearishMagnitude) / totalMagnitude * 100) : 0;

    const volatilityScore = normalizedRanges.length > 0
      ? round1(Math.min(100, arrAvg(normalizedRanges) * 50)) : 0;

    const energyBase   = round1(0.45 * movementScore + 0.35 * breadthScore + 0.20 * volatilityScore);
    const prevSessEB   = prevSameSessionEnergy[session] ?? null;
    const acceleration = prevSessEB != null ? round1(energyBase - prevSessEB) : 0;

    const rawEnergy    = 0.40 * movementScore + 0.30 * breadthScore + 0.20 * agreementScore + 0.10 * volatilityScore;
    const qualityMult  = 0.5 + agreementScore / 200;
    const marketEnergy = round1(Math.min(100, rawEnergy * qualityMult));

    const compressionScore = round1(((100 - movementScore) * (100 - breadthScore)) / 100);

    const streakScore      = Math.min(100, compressionStreak * 25);
    const energyPressure   = Math.max(0, 100 - marketEnergy);
    const sessQualScore    = SESSION_QUALITY_SCORE[session] || 50;
    const accelScore       = Math.min(100, Math.max(0, 50 + acceleration * 2));
    const expansionReadiness = round1(Math.min(100,
      0.35 * streakScore + 0.25 * energyPressure + 0.20 * accelScore + 0.10 * sessQualScore + 0.10 * agreementScore
    ));

    const energyCycle = classifyEnergyCycle(
      movementScore, breadthScore, agreementScore, volatilityScore,
      compressionStreak, acceleration, prevSameSessionScores[session] || null, session
    );

    sessionEBList.push(energyBase);
    sessionMovList.push(movementScore);
    sessionBrdList.push(breadthScore);
    sessionAgrList.push(agreementScore);
    sessionVolList.push(volatilityScore);

    rows.push({
      time_utc:             hk,
      session_name:         session,
      movement_score:       movementScore,
      breadth_score:        breadthScore,
      agreement_score:      agreementScore,
      volatility_score:     volatilityScore,
      energy_base:          energyBase,
      acceleration,
      compression_score:    compressionScore,
      expansion_score:      round1((movementScore * breadthScore) / 100),
      market_energy:        marketEnergy,
      expansion_readiness:  expansionReadiness,
      energy_cycle:         energyCycle,
      compression_streak:   compressionStreak,
      pairs_moving:         activePairs,
      pairs_quiet:          TOTAL - activePairs,
      movement_magnitude:   round1(moveMagnitude * 100),
      directional_agreement: agreementScore,
      // In-memory only (for session-level aggregation)
      bullish_breadth:      bullishPressurePct,
      bearish_breadth:      bearishPressurePct,
      dominance_score:      dominanceScore,
      strongest_ccy:        strongestCcy,
      weakest_ccy:          weakestCcy,
    });
  }

  return rows;
}

// ── Hourly column filter ────────────────────────────────────────────────────

const HOURLY_COLS = new Set([
  'time_utc', 'session_name',
  'movement_score', 'breadth_score', 'agreement_score', 'volatility_score',
  'energy_base', 'acceleration', 'compression_score', 'expansion_score',
  'market_energy', 'expansion_readiness', 'energy_cycle',
  'compression_streak', 'pairs_moving', 'pairs_quiet',
  'movement_magnitude', 'directional_agreement',
]);

function toHourlyRow(r) {
  return Object.fromEntries(Object.entries(r).filter(([k]) => HOURLY_COLS.has(k)));
}

// ── Build session rows (from sessionActivity.js) ────────────────────────────

const SESS_LABEL = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York' };
const SESS_NEXT  = { ASIA: 'LONDON', LONDON: 'NEW_YORK', NEW_YORK: 'ASIA' };
const COMPRESSED_CYCLE = new Set(['DEAD', 'COMPRESSION', 'LOW_PARTICIPATION']);

function buildSessionRows(hourRows) {
  const groups = {};
  for (const r of hourRows) {
    const date = r.time_utc.slice(0, 10);
    const key  = `${date}:${r.session_name}`;
    if (!groups[key]) groups[key] = { date, session: r.session_name, rows: [] };
    groups[key].rows.push(r);
  }

  const sortedKeys  = Object.keys(groups).sort();
  const sessHistory = {};
  let prevFlowBullPct = 50;

  return sortedKeys.map(key => {
    const g   = groups[key];
    const n   = field => g.rows.map(r => parseFloat(r[field]) || 0);
    const avg = arr   => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    function _modal(arr) {
      if (!arr.length) return null;
      const counts = {};
      for (const v of arr) counts[v] = (counts[v] || 0) + 1;
      return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    }

    const firstRow = g.rows[0];
    const lastRow  = g.rows[g.rows.length - 1];

    const sessionStart = new Date(firstRow.time_utc);
    const sessionEnd   = new Date(lastRow.time_utc);
    sessionEnd.setUTCHours(sessionEnd.getUTCHours() + 1);

    const mov    = round1(avg(n('movement_score')));
    const brd    = round1(avg(n('breadth_score')));
    const agr    = round1(avg(n('agreement_score')));
    const vol    = round1(avg(n('volatility_score')));
    const eng    = round1(avg(n('market_energy')));
    const streak = lastRow.compression_streak || 0;

    const hist     = sessHistory[g.session] || [];
    const prevHist = hist[hist.length - 1];

    const accel = prevHist ? round1(eng - prevHist.energy) : 0;

    const sessionCycle = classifyEnergyCycle(
      mov, brd, agr, vol, streak, accel,
      prevHist ? { movement: prevHist.movement, breadth: prevHist.breadth } : null,
      g.session
    );

    // Liquidity score
    const bullPct  = round1(avg(n('bullish_breadth')));
    const bearPct  = round1(avg(n('bearish_breadth')));

    const breadthCoherence = mov > 0 ? Math.min(1, brd / mov) : 0;
    const eMagnitude       = Math.min(100, eng);
    const directionalBias  = Math.abs(bullPct - 50) / 50;
    const currDominant     = bullPct >= bearPct ? 'bull' : 'bear';
    const prevFlowDominant = prevFlowBullPct >= 50 ? 'bull' : 'bear';
    const flowPersistence  = currDominant === prevFlowDominant ? 1.0 : 0.6;

    const liquidityScore = round1(Math.min(100,
      eMagnitude * (0.35 + 0.30 * breadthCoherence + 0.20 * directionalBias + 0.15 * flowPersistence)
    ));
    const liquidityGrade = liquidityScore >= 40 ? 'HIGH'
                         : liquidityScore >= 25 ? 'MODERATE'
                         : liquidityScore >= 12 ? 'LOW'
                         :                        'DEAD';

    prevFlowBullPct = bullPct;

    const row = {
      session_date:        g.date,
      session_name:        g.session,
      session_zone:        null,
      session_start:       sessionStart.toISOString(),
      session_end:         sessionEnd.toISOString(),
      movement_score:      mov,
      breadth_score:       brd,
      agreement_score:     agr,
      volatility_score:    vol,
      acceleration_score:  accel,
      compression_score:   round1(avg(n('compression_score'))),
      compression_streak:  streak,
      expansion_readiness: round1(avg(n('expansion_readiness'))),
      market_energy:       eng,
      energy_cycle:        sessionCycle,
      liquidity_score:     liquidityScore,
      liquidity_grade:     liquidityGrade,
      active_pairs:        Math.round(avg(n('pairs_moving'))),
      aligned_pairs:       null,
      bullish_breadth:     bullPct,
      bearish_breadth:     bearPct,
      dominance_score:     round1(avg(n('dominance_score'))),
      strongest_ccy:       _modal(g.rows.map(r => r.strongest_ccy).filter(Boolean)),
      weakest_ccy:         _modal(g.rows.map(r => r.weakest_ccy).filter(Boolean)),
      details: {
        hours: g.rows.length,
        hourly: g.rows.map(r => ({
          time:                r.time_utc,
          energy_cycle:        r.energy_cycle,
          market_energy:       r.market_energy,
          expansion_readiness: r.expansion_readiness,
        })),
      },
    };

    if (!sessHistory[g.session]) sessHistory[g.session] = [];
    sessHistory[g.session].push({ movement: mov, breadth: brd, agreement: agr, volatility: vol, energy: eng, bullPct });

    return row;
  });
}

// ── Fetch all H1 candles from backtest_candles ──────────────────────────────

async function fetchBacktestCandles(fromDate) {
  console.log(`[ARCHIVE] Fetching H1 candles from backtest_candles since ${fromDate || 'all'}…`);

  const byTime = {};
  let totalFetched = 0;

  for (const instrument of config.instruments) {
    // Paginate — Supabase caps at 1000 rows per request
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      let query = supabase
        .from('backtest_candles')
        .select('time, open, high, low, close')
        .eq('instrument', instrument)
        .eq('timeframe', 'H1')
        .eq('complete', true)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);

      if (fromDate) {
        query = query.gte('time', fromDate);
      }

      const { data, error } = await query;
      if (error) { console.error(`  ${instrument}: ${error.message}`); break; }
      if (!data || !data.length) break;

      for (const c of data) {
        const t = new Date(c.time).toISOString();
        if (!byTime[t]) byTime[t] = {};
        byTime[t][instrument] = {
          open:  parseFloat(c.open),
          close: parseFloat(c.close),
          high:  parseFloat(c.high),
          low:   parseFloat(c.low),
        };
      }
      totalFetched += data.length;
      if (data.length < PAGE) break;
      offset += PAGE;
    }
  }

  console.log(`[ARCHIVE] Loaded ${totalFetched.toLocaleString()} candles across ${Object.keys(byTime).length} hours`);
  return byTime;
}

// ── Upsert in batches ───────────────────────────────────────────────────────

const BATCH = 500;

async function upsertHourlyBatched(rows) {
  let stored = 0;
  const hourlyRows = rows.map(toHourlyRow);
  for (let i = 0; i < hourlyRows.length; i += BATCH) {
    const batch = hourlyRows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('hourly_session_activity')
      .upsert(batch, { onConflict: 'time_utc', ignoreDuplicates: false });
    if (error) throw new Error(`hourly_session_activity upsert: ${error.message}`);
    stored += batch.length;
  }
  return stored;
}

async function upsertSessionBatched(sessionRows) {
  let stored = 0;
  // Strip in-memory fields, merge into details JSON
  const SESSION_INMEM = new Set([
    'norm_movement', 'norm_breadth', 'norm_agreement', 'norm_volatility', 'norm_energy',
    'baseline_n', 'prev_movement', 'prev_breadth', 'prev_agreement', 'prev_energy', 'energy_momentum',
  ]);

  const cleaned = sessionRows.map(r => {
    const computed = {};
    const row = {};
    for (const [k, v] of Object.entries(r)) {
      if (SESSION_INMEM.has(k)) computed[k] = v;
      else row[k] = v;
    }
    if (!row.details) row.details = {};
    row.details = { ...row.details, ...computed };
    return row;
  });

  for (let i = 0; i < cleaned.length; i += BATCH) {
    const batch = cleaned.slice(i, i + BATCH);
    const { error } = await supabase
      .from('market_energy_sessions')
      .upsert(batch, { onConflict: 'session_date,session_name', ignoreDuplicates: false });
    if (error) throw new Error(`market_energy_sessions upsert: ${error.message}`);
    stored += batch.length;
  }
  return stored;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let fromDate = null;

  const fromIdx = args.indexOf('--from');
  if (fromIdx !== -1 && args[fromIdx + 1]) {
    fromDate = args[fromIdx + 1];
    if (!fromDate.includes('T')) fromDate += 'T00:00:00Z';
  }

  const daysIdx = args.indexOf('--days');
  if (daysIdx !== -1 && args[daysIdx + 1]) {
    const days = parseInt(args[daysIdx + 1], 10);
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    fromDate = d.toISOString();
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  NervaFX Archive Backfill');
  console.log(`  Source: backtest_candles (H1)`);
  console.log(`  From: ${fromDate || 'all available data'}`);
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(60)}\n`);

  const t0 = Date.now();

  // 1. Fetch candles from backtest_candles
  const byTime   = await fetchBacktestCandles(fromDate);
  const hourKeys = Object.keys(byTime).sort();

  if (!hourKeys.length) {
    console.log('[ARCHIVE] No candle data found. Exiting.');
    return;
  }

  console.log(`[ARCHIVE] Processing ${hourKeys.length} hours through session engine…`);

  // 2. Compute all hourly metrics
  const rows = processHours(hourKeys, byTime);
  console.log(`[ARCHIVE] Computed ${rows.length} hourly metric rows`);

  // 3. Build session-level rows
  const sessionRows = buildSessionRows(rows);
  console.log(`[ARCHIVE] Built ${sessionRows.length} session rows`);

  // 4. Upsert hourly rows
  console.log('[ARCHIVE] Upserting hourly_session_activity…');
  const hourlyStored = await upsertHourlyBatched(rows);
  console.log(`[ARCHIVE] ✓ ${hourlyStored} hourly rows stored`);

  // 5. Upsert session rows
  console.log('[ARCHIVE] Upserting market_energy_sessions…');
  const sessionStored = await upsertSessionBatched(sessionRows);
  console.log(`[ARCHIVE] ✓ ${sessionStored} session rows stored`);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ARCHIVE BACKFILL COMPLETE — ${elapsed}s`);
  console.log(`  Hourly rows:  ${hourlyStored.toLocaleString()}`);
  console.log(`  Session rows: ${sessionStored.toLocaleString()}`);
  console.log(`${'═'.repeat(60)}\n`);
}

// Also export for use as API endpoint
module.exports = { fetchBacktestCandles, processHours, buildSessionRows, toHourlyRow, upsertHourlyBatched, upsertSessionBatched };

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
