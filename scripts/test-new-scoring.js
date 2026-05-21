'use strict';

/**
 * Test V2 institutional scoring by running processHours on real data.
 * Run: node scripts/test-new-scoring.js
 */

const { config } = require('../src/config');
const { supabase } = require('../src/supabase');

async function fetchCandles(days = 5) {
  const byTime = {};
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - days);

  for (const instrument of config.instruments) {
    const { data, error } = await supabase
      .from('backtest_candles')
      .select('time, open, high, low, close')
      .eq('instrument', instrument)
      .eq('timeframe', 'H1')
      .eq('complete', true)
      .gte('time', from.toISOString())
      .order('time', { ascending: false })
      .limit(300);
    if (error) throw new Error(`Candle fetch ${instrument}: ${error.message}`);
    for (const c of data || []) {
      const t = new Date(c.time).toISOString();
      if (!byTime[t]) byTime[t] = {};
      byTime[t][instrument] = {
        open:  parseFloat(c.open),
        close: parseFloat(c.close),
        high:  parseFloat(c.high),
        low:   parseFloat(c.low),
      };
    }
  }
  return byTime;
}

async function main() {
  console.log('Fetching candles...');
  const byTime = await fetchCandles(7);
  const hourKeys = Object.keys(byTime).sort();
  console.log(`Got ${hourKeys.length} hours\n`);

  // Use sessionEngine for session detection
  const { getCurrentSession } = require('../src/sessionEngine');

  const SESSION_SCALE = {
    ASIA:     { movementCap: 0.0012, volatilityCap: 0.0020, breadthThreshold: 0.00015 },
    LONDON:   { movementCap: 0.0015, volatilityCap: 0.0025, breadthThreshold: 0.00020 },
    NEW_YORK: { movementCap: 0.0018, volatilityCap: 0.0030, breadthThreshold: 0.00020 },
    DEFAULT:  { movementCap: 0.0015, volatilityCap: 0.0025, breadthThreshold: 0.00020 },
  };

  const CURRENCIES = ['GBP', 'EUR', 'USD', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
  const { config: cfg } = require('../src/config');
  function round1(v) { return Math.round(v * 10) / 10; }
  function arrAvg(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
  function geoMean(vals) {
    if (!vals.length || vals.some(v => v <= 0)) return 0;
    const logSum = vals.reduce((s, v) => s + Math.log(v), 0);
    return Math.exp(logSum / vals.length);
  }

  function computeCurrencyStrengths(candles, sessionOpenPrices) {
    const sums = {}, counts = {};
    for (const ccy of CURRENCIES) { sums[ccy] = 0; counts[ccy] = 0; }
    for (const inst of cfg.instruments) {
      const [base, quote] = inst.split('_');
      const c = candles[inst], open = sessionOpenPrices[inst];
      if (!c || !open || open === 0) continue;
      const move = (c.close - open) / open;
      sums[base] += move; counts[base]++;
      sums[quote] -= move; counts[quote]++;
    }
    const s = {};
    for (const ccy of CURRENCIES) s[ccy] = counts[ccy] > 0 ? sums[ccy] / counts[ccy] : 0;
    return s;
  }

  let currentSession = null;
  let sessionOpenPrices = {};
  let prevHourScores = null;

  // Show results for the last 3 days
  const targetDates = new Set();
  for (let d = 3; d >= 0; d--) {
    const dt = new Date();
    dt.setUTCDate(dt.getUTCDate() - d);
    targetDates.add(dt.toISOString().slice(0, 10));
  }

  for (const hk of hourKeys) {
    const dt = new Date(hk);
    const dateStr = dt.toISOString().slice(0, 10);
    const session = getCurrentSession(dt).session;

    if (session !== currentSession) {
      sessionOpenPrices = {};
      prevHourScores = null;
      const candles = byTime[hk];
      for (const [inst, c] of Object.entries(candles)) {
        sessionOpenPrices[inst] = c.open;
      }
      currentSession = session;
    }

    if (!targetDates.has(dateStr)) continue;
    if (session === 'LOW_LIQUIDITY') continue;

    const candles = byTime[hk];
    const scale = SESSION_SCALE[session] || SESSION_SCALE.DEFAULT;
    const TOTAL = cfg.instruments.length;

    const ccyStrength = computeCurrencyStrengths(candles, sessionOpenPrices);

    const hourlyMoves = [];
    const hourlyRanges = [];
    let activePairs = 0;
    let bullishMag = 0, bearishMag = 0;
    let agrAligned = 0, agrTotal = 0;
    let ccyAligned = 0, ccyTotal = 0;

    for (const inst of cfg.instruments) {
      const c = candles[inst];
      const sOpen = sessionOpenPrices[inst];
      if (!c || !c.open || c.open === 0 || sOpen == null) continue;

      const hourlyDir = (c.close - c.open) / c.open;
      const hourlyMove = Math.abs(hourlyDir);
      hourlyMoves.push(hourlyMove);
      hourlyRanges.push((c.high - c.low) / c.open);

      if (hourlyMove >= scale.breadthThreshold) {
        activePairs++;
        if (hourlyDir > 0) bullishMag += hourlyMove;
        else bearishMag += hourlyMove;
      }

      // Pair alignment
      const sessionDir = (c.close - sOpen) / sOpen;
      if (Math.abs(hourlyDir) >= scale.breadthThreshold * 0.5 &&
          Math.abs(sessionDir) >= scale.breadthThreshold * 0.5) {
        agrTotal++;
        if ((hourlyDir > 0 && sessionDir > 0) || (hourlyDir < 0 && sessionDir < 0)) agrAligned++;
      }

      // Currency alignment
      const [base, quote] = inst.split('_');
      const expectedDir = (ccyStrength[base] || 0) - (ccyStrength[quote] || 0);
      if (Math.abs(hourlyDir) >= scale.breadthThreshold * 0.5 && Math.abs(expectedDir) > 0.00001) {
        ccyTotal++;
        if ((expectedDir > 0 && hourlyDir > 0) || (expectedDir < 0 && hourlyDir < 0)) ccyAligned++;
      }
    }

    if (!hourlyMoves.length) continue;

    const avgMove = arrAvg(hourlyMoves);
    const mov = round1(Math.min(100, (avgMove / scale.movementCap) * 100));
    const brd = round1((activePairs / TOTAL) * 100);

    // Agreement: currency × pair alignment
    const pairAlign = agrTotal > 0 ? agrAligned / agrTotal : 0;
    const ccyAlign  = ccyTotal > 0 ? ccyAligned / ccyTotal : 0;
    const agr = round1(pairAlign * ccyAlign * Math.sqrt(brd / 100) * 100);

    const avgRange = arrAvg(hourlyRanges);
    const vol = round1(Math.min(100, (avgRange / scale.volatilityCap) * 100));

    // Directional control
    const totalMag = bullishMag + bearishMag;
    const dirCtrl = totalMag > 0 ? round1(Math.abs(bullishMag - bearishMag) / totalMag * 100) : 0;

    // Volatility quality
    let volType = 'DEAD';
    if (prevHourScores && vol > prevHourScores.volatility * 1.8 && vol >= 50) volType = 'EVENT';
    else if (vol >= 55 && agr >= 45 && dirCtrl >= 35) volType = 'HEALTHY';
    else if (vol >= 55 && (agr < 30 || dirCtrl < 20)) volType = 'CHAOTIC';
    else if (vol >= 55) volType = 'HEALTHY';
    else if (vol >= 25) volType = 'NORMAL';

    const volQualMult = { HEALTHY: 1.0, NORMAL: 0.75, EVENT: 0.50, CHAOTIC: 0.30, DEAD: 0.20 };
    const volQual = round1(vol * (volQualMult[volType] || 0.5));

    // Momentum
    const mom = prevHourScores ? round1(mov - prevHourScores.movement) : 0;

    // Energy (PDF formula)
    const energyBase = round1(0.30 * mov + 0.25 * brd + 0.20 * agr + 0.15 * dirCtrl + 0.10 * volQual);
    const sessQMult = volType === 'CHAOTIC' ? 0.65 : volType === 'DEAD' ? 0.55 : volType === 'EVENT' ? 0.75 : volType === 'HEALTHY' ? 1.10 : 0.90;
    const eng = round1(Math.min(100, energyBase * sessQMult));

    // Tradability (geometric mean gate)
    const vqf = volType === 'HEALTHY' ? 1.1 : volType === 'NORMAL' ? 0.95 : volType === 'EVENT' ? 0.7 : volType === 'CHAOTIC' ? 0.5 : 0.4;
    const trad = round1(Math.min(100, geoMean([Math.max(1,eng), Math.max(1,agr), Math.max(1,dirCtrl), Math.max(1,brd)]) * vqf));

    // False breakout
    const fb = mov >= 35 && brd < 30 && agr < 25;

    // Currency leadership gap
    const strVals = Object.values(ccyStrength).sort((a, b) => b - a);
    const gap = strVals.length >= 2 ? round1((strVals[0] - strVals[strVals.length - 1]) * 10000) : 0;

    const utcH = dt.getUTCHours();
    const gmt3H = (utcH + 3) % 24;

    console.log(
      `${dateStr} ${String(utcH).padStart(2,'0')}:00 UTC (${String(gmt3H).padStart(2,'0')}:00 GMT+3) | ` +
      `${session.padEnd(12)} | mov:${String(mov).padStart(5)} brd:${String(brd).padStart(5)} ` +
      `agr:${String(agr).padStart(5)} vol:${String(vol).padStart(5)} | ` +
      `dirCtrl:${String(dirCtrl).padStart(4)} volQ:${String(volQual).padStart(4)}(${volType.padEnd(7)}) | ` +
      `energy:${String(eng).padStart(5)} trad:${String(trad).padStart(5)} | ` +
      `mom:${mom >= 0 ? '+' : ''}${String(mom).padStart(5)} gap:${gap} ${fb ? '⚠FB' : ''}`
    );

    prevHourScores = { movement: mov, momentum: mom, volatility: vol, breadth: brd, agreement: agr };
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
