'use strict';

/**
 * Backfill flow_performance table from historical currency_strength + m15_pair_spreads + m15_volume_analysis.
 *
 * Replays each hour: reads strength snapshot → derives flow pairs → scores → upserts.
 *
 * Usage: node scripts/backfillFlowPerformance.js [days]
 *   days = lookback (default 30)
 */

require('dotenv').config();
const { supabase } = require('../src/supabase');
const { config }   = require('../src/config');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const PAIRS = new Set([
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
]);

function getSession(utcHour) {
  if (utcHour >= 23 || utcHour < 7)  return 'ASIA';
  if (utcHour >= 7  && utcHour < 13) return 'LONDON';
  if (utcHour >= 13 && utcHour < 21) return 'NEW_YORK';
  return 'LOW_LIQUIDITY';
}

async function fetchAll(table, select, filters, orderCol = 'time') {
  const allRows = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    let q = supabase.from(table).select(select).order(orderCol, { ascending: true }).range(offset, offset + PAGE - 1);
    for (const [k, v] of Object.entries(filters)) {
      if (k === 'gte') q = q.gte(v[0], v[1]);
      else q = q.eq(k, v);
    }
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    allRows.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return allRows;
}

async function run() {
  const days = parseInt(process.argv[2] || '30', 10);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  console.log(`[BACKFILL] Flow performance — ${days} days from ${since}`);

  // ── 1. Fetch all historical strength data ──────────────────────────────
  console.log('[BACKFILL] Fetching currency_strength...');
  const csRows = await fetchAll('currency_strength', 'time, currency, smooth_3h, smooth_6h', { gte: ['time', since] });
  console.log(`[BACKFILL] ${csRows.length} strength rows`);

  // Index by hour → { ccy → { h3, h6 } }
  const csByTime = {};
  const allTimes = new Set();
  for (const r of csRows) {
    const t = (r.time || '').slice(0, 13); // YYYY-MM-DDTHH
    if (!csByTime[t]) csByTime[t] = {};
    csByTime[t][r.currency] = {
      h3: parseFloat(r.smooth_3h) || 0,
      h6: parseFloat(r.smooth_6h) || 0,
    };
    allTimes.add(t);
  }

  // ── 2. Fetch all M15 pair spreads ──────────────────────────────────────
  console.log('[BACKFILL] Fetching m15_pair_spreads...');
  const m15Rows = await fetchAll('m15_pair_spreads', 'time, instrument, smooth_45m, smooth_90m, smooth_180m, de_combined, state', { gte: ['time', since] });
  console.log(`[BACKFILL] ${m15Rows.length} m15 rows`);

  // Index by hour → { instrument → row }
  const m15ByTime = {};
  for (const r of m15Rows) {
    const t = (r.time || '').slice(0, 13);
    if (!m15ByTime[t]) m15ByTime[t] = {};
    m15ByTime[t][r.instrument] = r; // latest per hour wins
  }

  // ── 3. Fetch all volume analysis ──────────────────────────────────────
  console.log('[BACKFILL] Fetching m15_volume_analysis...');
  const volRows = await fetchAll('m15_volume_analysis', 'time, instrument, relative_volume, volume_efficiency, participation_grade, volume_persistence', { gte: ['time', since] });
  console.log(`[BACKFILL] ${volRows.length} volume rows`);

  const volByTime = {};
  for (const r of volRows) {
    const t = (r.time || '').slice(0, 13);
    if (!volByTime[t]) volByTime[t] = {};
    volByTime[t][r.instrument] = r;
  }

  // ── 4. Process each hour ──────────────────────────────────────────────
  const sortedTimes = [...allTimes].sort();
  console.log(`[BACKFILL] Processing ${sortedTimes.length} hours...`);

  let totalRows = 0;
  const allDbRows = [];

  for (const hourKey of sortedTimes) {
    const csSnap = csByTime[hourKey];
    if (!csSnap) continue;

    const utcHour = parseInt(hourKey.slice(11, 13), 10);
    const session = getSession(utcHour);
    const time = hourKey + ':00:00Z';

    // Derive strong/weak
    const ranked = CURRENCIES
      .filter(c => csSnap[c])
      .sort((a, b) => (csSnap[b]?.h3 || 0) - (csSnap[a]?.h3 || 0));
    const strong = ranked.filter(c => (csSnap[c]?.h3 || 0) > 0).slice(0, 2);
    const weak   = ranked.filter(c => (csSnap[c]?.h3 || 0) < 0).slice(-2).reverse();
    if (!strong.length || !weak.length) continue;

    // Build flow pairs
    const flowPairs = [];
    for (const st of strong) {
      for (const wk of weak) {
        if (st === wk) continue;
        const fwd = `${st}_${wk}`, rev = `${wk}_${st}`;
        if (PAIRS.has(fwd))      flowPairs.push({ instrument: fwd, dir: 'BUY' });
        else if (PAIRS.has(rev)) flowPairs.push({ instrument: rev, dir: 'SELL' });
      }
    }
    if (!flowPairs.length) continue;

    const m15Snap = m15ByTime[hourKey] || {};
    const volSnap = volByTime[hourKey] || {};

    // Score each pair
    const scored = flowPairs.slice(0, 4).map(fp => {
      const [base, quote] = fp.instrument.split('_');
      const m15 = m15Snap[fp.instrument];
      const vol = volSnap[fp.instrument];

      const v45  = m15 ? parseFloat(m15.smooth_45m)  || 0 : 0;
      const v90  = m15 ? parseFloat(m15.smooth_90m)  || 0 : 0;
      const flowSign = fp.dir === 'BUY' ? 1 : -1;

      let state = null;
      const dir45 = v45 * flowSign;
      const dir90 = v90 * flowSign;
      if (Math.abs(v45) < 0.00005)                   state = 'FLAT';
      else if (dir45 < 0)                             state = 'REVERSING';
      else if (dir45 > dir90 * 1.1)                   state = 'EXPANDING';
      else if (dir45 < dir90 * 0.85 && dir90 > 0)    state = 'COMPRESSING';
      else                                            state = 'STEADY';

      const spread3H = (csSnap[base]?.h3 ?? 0) - (csSnap[quote]?.h3 ?? 0);
      const spread6H = (csSnap[base]?.h6 ?? 0) - (csSnap[quote]?.h6 ?? 0);

      const M15_CONFIRM_MIN = 0.00008;
      const m15Confirms = Math.sign(v45) === flowSign && Math.abs(v45) >= M15_CONFIRM_MIN;
      const h3Confirms  = Math.sign(spread3H) === flowSign;
      const h6Confirms  = Math.sign(spread6H) === flowSign;
      const accel = v45 - v90;
      const accelSign = Math.sign(accel) === flowSign;

      let perfScore = 0;
      perfScore += (v45 * flowSign) * 10000 * 3;
      perfScore += (spread3H * flowSign) * 10000 * 2;
      perfScore += (spread6H * flowSign) * 10000 * 1;
      if (m15Confirms) perfScore += 10;
      if (h3Confirms)  perfScore += 10;
      if (h6Confirms)  perfScore += 5;
      if (accelSign)   perfScore += 10;
      if (state === 'EXPANDING' && m15Confirms) perfScore += 15;
      if (state === 'REVERSING')                       perfScore -= 10;
      if (state === 'COMPRESSING' && !m15Confirms)     perfScore -= 15;

      const htfCount = [h3Confirms, h6Confirms].filter(x => x === true).length;
      let status;
      if (m15Confirms && htfCount === 2)       status = 'STRONG';
      else if (m15Confirms && htfCount === 1)  status = 'ALIGNED';
      else if (m15Confirms && htfCount === 0)  status = 'PARTIAL';
      else if (!m15Confirms && htfCount >= 1)  status = 'BUILDING';
      else if (!m15Confirms)                   status = 'AGAINST';
      else                                     status = 'WAIT';

      let momentum;
      if (accelSign && Math.abs(v45) > 0.0003)         momentum = 'Accelerating';
      else if (!accelSign && Math.abs(accel) > 0.0002)  momentum = 'Fading';
      else if (Math.abs(v45) < 0.0002)                  momentum = 'Flat';
      else                                               momentum = 'Steady';

      const deCombined = m15 ? parseFloat(m15.de_combined) || 0 : 0;
      const finalScore = (0.75 * perfScore) + (0.25 * deCombined);

      const volRV    = vol ? parseFloat(vol.relative_volume)    || 0 : 0;
      const volEff   = vol ? parseFloat(vol.volume_efficiency)  || 0 : 0;
      const volGrade = vol?.participation_grade || '';
      const volPers  = vol ? parseFloat(vol.volume_persistence) || 0 : 0;

      return { instrument: fp.instrument, dir: fp.dir, v45, v90, spread3H, spread6H, state, perfScore, finalScore, status, momentum, deCombined, volRV, volEff, volGrade, volPers };
    });

    scored.sort((a, b) => b.finalScore - a.finalScore);

    for (let i = 0; i < scored.length; i++) {
      const s = scored[i];
      allDbRows.push({
        time,
        instrument:         s.instrument,
        session,
        dir:                s.dir,
        rank:               i + 1,
        status:             s.status,
        state:              s.state || 'FLAT',
        momentum:           s.momentum,
        perf_score:         Math.round(s.perfScore * 100) / 100,
        final_score:        Math.round(s.finalScore * 100) / 100,
        de_combined:        Math.round(s.deCombined * 100) / 100,
        spread_3h:          Math.round(s.spread3H * 100000) / 100000,
        spread_6h:          Math.round(s.spread6H * 100000) / 100000,
        v45:                Math.round(s.v45 * 100000) / 100000,
        v90:                Math.round(s.v90 * 100000) / 100000,
        vol_rv:             Math.round(s.volRV * 1000) / 1000,
        vol_eff:            Math.round(s.volEff * 100000) / 100000,
        vol_grade:          s.volGrade || null,
        vol_pers:           s.volPers,
        impulse_score:      null,
        impulse_aligned:    null,
        strong_currencies:  strong.join(','),
        weak_currencies:    weak.join(','),
      });
    }

    totalRows += scored.length;
  }

  // ── 5. Upsert in batches ──────────────────────────────────────────────
  console.log(`[BACKFILL] Upserting ${allDbRows.length} rows...`);
  for (let i = 0; i < allDbRows.length; i += 500) {
    const batch = allDbRows.slice(i, i + 500);
    const { error } = await supabase
      .from('flow_performance')
      .upsert(batch, { onConflict: 'time,instrument', ignoreDuplicates: false });
    if (error) throw new Error(`Upsert batch ${i}: ${error.message}`);
    process.stdout.write(`\r[BACKFILL] ${Math.min(i + 500, allDbRows.length)}/${allDbRows.length}`);
  }

  console.log(`\n[BACKFILL] Complete: ${totalRows} rows across ${sortedTimes.length} hours`);
}

run().catch(e => { console.error('[BACKFILL] FATAL:', e.message); process.exit(1); });
