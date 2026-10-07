'use strict';

/**
 * Stage 1 — read-only M15 data audit. Measures the ACTUAL database (never reuses
 * the old row count or assumes uniform coverage to a claimed end date). Loads all
 * completed M15 candles per pair and reports coverage, gaps, duplicates, invalid
 * OHLC, volume, source, and a deterministic data snapshot hash. No writes.
 *
 * Run: NODE_PATH=<@supabase dir> node scripts/research/audit-m15.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PAIRS = ['AUD_CAD','AUD_CHF','AUD_JPY','AUD_NZD','AUD_USD','CAD_CHF','CAD_JPY','CHF_JPY','EUR_AUD','EUR_CAD','EUR_CHF','EUR_GBP','EUR_JPY','EUR_NZD','EUR_USD','GBP_AUD','GBP_CAD','GBP_CHF','GBP_JPY','GBP_NZD','GBP_USD','NZD_CAD','NZD_CHF','NZD_JPY','NZD_USD','USD_CAD','USD_CHF','USD_JPY'];
const M15 = 15 * 60 * 1000;
const TARGET_END = '2026-09-25';
const OUT = path.join(__dirname, '..', '..', 'docs', 'research');

function env() { const t = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8'); const e = {}; for (const l of t.split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)\s*=\s*(.*)$/); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); } return e; }

async function loadPair(sb, pair) {
  const all = []; let off = 0;
  for (;;) {
    const { data, error } = await sb.from('backtest_candles')
      .select('time,open,high,low,close,volume,complete,source')
      .eq('instrument', pair).eq('timeframe', 'M15')
      .order('time', { ascending: true }).range(off, off + 999);
    if (error) throw new Error(`${pair}: ${error.message}`);
    all.push(...data);
    if (data.length < 1000) break;
    off += 1000;
  }
  return all;
}

function auditPair(pair, rows) {
  let dup = 0, incomplete = 0, badOHLC = 0, volNull = 0, volZero = 0, nonOanda = 0;
  const ranges = [];
  const seen = new Set();
  let intradayMissing = 0, weekendGaps = 0, largestIntradayGapMin = 0;
  let prevMs = null;
  for (const r of rows) {
    const ms = new Date(r.time).getTime();
    if (seen.has(ms)) dup++; else seen.add(ms);
    if (r.complete === false) incomplete++;
    const o = +r.open, h = +r.high, l = +r.low, c = +r.close;
    if (!(h >= l && h >= o - 1e-9 && h >= c - 1e-9 && l <= o + 1e-9 && l <= c + 1e-9)) badOHLC++;
    if (r.volume == null) volNull++; else if (+r.volume <= 0) volZero++;
    if (r.source && r.source !== 'OANDA') nonOanda++;
    ranges.push(h - l);
    if (prevMs != null) {
      const dt = ms - prevMs;
      if (dt > M15) {
        const gapMin = dt / 60000;
        if (dt >= 40 * 3600e3 && dt <= 56 * 3600e3) weekendGaps++;         // weekend close
        else { intradayMissing += Math.round(dt / M15) - 1; largestIntradayGapMin = Math.max(largestIntradayGapMin, gapMin); }
      }
    }
    prevMs = ms;
  }
  ranges.sort((a, b) => a - b);
  const med = ranges.length ? ranges[Math.floor(ranges.length / 2)] : 0;
  const outliers = ranges.filter((r) => med > 0 && r > 10 * med).length;
  const first = rows.length ? rows[0].time : null;
  const last = rows.length ? rows[rows.length - 1].time : null;
  return {
    pair, rows: rows.length, first, last,
    endsBeforeTarget: last ? last.slice(0, 10) < TARGET_END : true,
    duplicates: dup, incomplete, badOHLC, volNull, volZero, nonOanda,
    intradayMissingCandles: intradayMissing, weekendGaps, largestIntradayGapMin,
    rangeOutliers: outliers,
    volumePresent: volNull === 0,
  };
}

async function main() {
  const e = env(); const sb = createClient(e.SUPABASE_URL, e.SUPABASE_SERVICE_KEY);
  fs.mkdirSync(OUT, { recursive: true });
  const perPair = [];
  let total = 0, gMin = null, gMax = null;
  for (const p of PAIRS) {
    const rows = await loadPair(sb, p);
    const a = auditPair(p, rows);
    perPair.push(a); total += a.rows;
    if (a.first && (!gMin || a.first < gMin)) gMin = a.first;
    if (a.last && (!gMax || a.last > gMax)) gMax = a.last;
    process.stderr.write(`${p} ${a.rows} ${a.first?.slice(0,10)}..${a.last?.slice(0,16)} bad=${a.badOHLC} dup=${a.duplicates} miss=${a.intradayMissingCandles}\n`);
  }
  // deterministic data snapshot hash (coverage fingerprint)
  const fingerprint = perPair.map((a) => `${a.pair}:${a.rows}:${a.first}:${a.last}`).sort().join('|');
  const dataHash = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);

  const pairsAtTarget = perPair.filter((a) => !a.endsBeforeTarget).length;
  const laggards = perPair.filter((a) => a.endsBeforeTarget).map((a) => ({ pair: a.pair, last: a.last }));
  const totals = ['duplicates','incomplete','badOHLC','volNull','volZero','nonOanda','intradayMissingCandles','rangeOutliers']
    .reduce((o, k) => (o[k] = perPair.reduce((s, a) => s + a[k], 0), o), {});

  const report = {
    generatedAt: new Date().toISOString(),
    targetEndReported: TARGET_END,
    verified: {
      instruments: perPair.length, pairsCovered: perPair.filter((a) => a.rows > 0).length,
      totalM15Rows: total, earliest: gMin, latest: gMax,
      pairsReachingTarget: pairsAtTarget, laggardsBeforeTarget: laggards,
      priceType: 'MID (OANDA price=M) — no bid/ask, so no candle-store spread',
      source: 'OANDA', volumeType: 'OANDA tick/price-count (NOT trading volume)',
      timestamp: 'time = candle START (UTC, timestamptz); close = time + 15m; complete-only ingested',
      uniqueKey: 'UNIQUE(instrument,timeframe,time) — structural dedup',
    },
    integrityTotals: totals,
    dataHash,
    perPair,
  };
  fs.writeFileSync(path.join(OUT, 'data_audit.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, perPair: `[${perPair.length} pairs — see data_audit.json]` }, null, 2));
}
main().catch((e) => { console.error('AUDIT ERR', e.message); process.exit(1); });
