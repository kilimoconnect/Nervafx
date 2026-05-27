'use strict';

/**
 * Flow Performance Engine — Energy-driven pair analysis
 *
 * Runs each pipeline cycle (after volume_analysis + energy_direction).
 * Uses energy_signal_pairs as the pair source — only analyzes pairs
 * that the energy engine has selected. Enriches each pair with M15
 * momentum, 3H/6H alignment, DE, volume, impulse, and performance score.
 *
 * DB table: flow_performance
 *   PK: (time, instrument)
 *   Columns: time, instrument, session, dir, rank, status, state, momentum,
 *            perf_score, final_score, de_combined,
 *            spread_3h, spread_6h, v45, v90,
 *            vol_rv, vol_eff, vol_grade, vol_pers,
 *            strong_currencies, weak_currencies
 */

const { supabase } = require('./supabase');

function getSession(utcHour) {
  if (utcHour >= 23 || utcHour < 7)  return 'ASIA';
  if (utcHour >= 7  && utcHour < 13) return 'LONDON';
  if (utcHour >= 13 && utcHour < 21) return 'NEW_YORK';
  return 'LOW_LIQUIDITY';
}

/**
 * Calculate and store flow performance for the current pipeline run.
 * Pair source: energy_signal_pairs (active only).
 */
async function calculateFlowPerformance() {
  const now = new Date();
  const hourBucket = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
  const time = hourBucket.toISOString();
  const session = getSession(now.getUTCHours());

  // ── 1. Fetch active energy signal pairs ────────────────────────────────
  const { data: energyPairs, error: epErr } = await supabase
    .from('energy_signal_pairs')
    .select('instrument, dir, strong_ccy, weak_ccy, phase')
    .eq('active', true);

  if (epErr) throw new Error(`FP energy pairs fetch: ${epErr.message}`);
  if (!energyPairs?.length) {
    console.log('[FLOW_PERF] No active energy signal pairs');
    return { rows: 0 };
  }

  const fpInstruments = energyPairs.map(p => p.instrument);

  // ── 2. Fetch latest currency strength (3H + 6H) ────────────────────────
  const { data: csRows, error: csErr } = await supabase
    .from('currency_strength')
    .select('currency, smooth_3h, smooth_6h')
    .order('time', { ascending: false })
    .limit(8);

  if (csErr) throw new Error(`FP strength fetch: ${csErr.message}`);

  const ccyMap3H = {}, ccyMap6H = {};
  const seen = new Set();
  for (const r of (csRows || [])) {
    if (seen.has(r.currency)) continue;
    seen.add(r.currency);
    ccyMap3H[r.currency] = parseFloat(r.smooth_3h) || 0;
    ccyMap6H[r.currency] = parseFloat(r.smooth_6h) || 0;
  }

  // ── 3. Fetch M15 pair spreads ──────────────────────────────────────────
  const { data: m15Rows, error: m15Err } = await supabase
    .from('m15_pair_spreads')
    .select('instrument, smooth_45m, smooth_90m, smooth_180m, de_combined, state, impulse_score, impulse_dir, velocity')
    .in('instrument', fpInstruments)
    .order('time', { ascending: false })
    .limit(fpInstruments.length * 2);

  if (m15Err) throw new Error(`FP m15 fetch: ${m15Err.message}`);

  const m15Map = {};
  for (const r of (m15Rows || [])) {
    if (!m15Map[r.instrument]) m15Map[r.instrument] = r;
  }

  // ── 4. Fetch volume analysis ───────────────────────────────────────────
  const { data: volRows, error: volErr } = await supabase
    .from('m15_volume_analysis')
    .select('instrument, relative_volume, volume_efficiency, participation_grade, volume_persistence')
    .in('instrument', fpInstruments)
    .order('time', { ascending: false })
    .limit(fpInstruments.length * 2);

  if (volErr) console.warn(`[FLOW_PERF] Volume fetch warning: ${volErr.message}`);

  const volMap = {};
  for (const r of (volRows || [])) {
    if (!volMap[r.instrument]) volMap[r.instrument] = r;
  }

  // ── 5. Score each energy signal pair ───────────────────────────────────
  // Collect unique strong/weak currencies from energy pairs
  const strongSet = new Set(), weakSet = new Set();

  const scored = energyPairs.map(ep => {
    const [base, quote] = ep.instrument.split('_');
    const m15 = m15Map[ep.instrument];
    const vol = volMap[ep.instrument];

    strongSet.add(ep.strong_ccy);
    weakSet.add(ep.weak_ccy);

    const v45  = m15 ? parseFloat(m15.smooth_45m)  || 0 : 0;
    const v90  = m15 ? parseFloat(m15.smooth_90m)  || 0 : 0;
    const impulseScore = m15 ? (m15.impulse_score || 0) : 0;
    const impulseDir   = m15 ? (m15.impulse_dir   || 0) : 0;

    const flowSign = ep.dir === 'BUY' ? 1 : -1;
    const impulseAligned = impulseDir === flowSign;

    // M15 state
    let state = null;
    const dir45 = v45 * flowSign;
    const dir90 = v90 * flowSign;
    if (Math.abs(v45) < 0.00005)                   state = 'FLAT';
    else if (dir45 < 0)                             state = 'REVERSING';
    else if (dir45 > dir90 * 1.1)                   state = 'EXPANDING';
    else if (dir45 < dir90 * 0.85 && dir90 > 0)    state = 'COMPRESSING';
    else                                            state = 'STEADY';

    const spread3H = (ccyMap3H[base] ?? 0) - (ccyMap3H[quote] ?? 0);
    const spread6H = (ccyMap6H[base] ?? 0) - (ccyMap6H[quote] ?? 0);

    // Alignment checks
    const M15_CONFIRM_MIN = 0.00008;
    const m15Confirms = Math.sign(v45) === flowSign && Math.abs(v45) >= M15_CONFIRM_MIN;
    const h3Confirms  = Math.sign(spread3H) === flowSign;
    const h6Confirms  = Math.sign(spread6H) === flowSign;
    const accel = v45 - v90;
    const accelSign = Math.sign(accel) === flowSign;

    // Performance score
    let perfScore = 0;
    perfScore += (v45 * flowSign) * 10000 * 3;
    perfScore += (spread3H * flowSign) * 10000 * 2;
    perfScore += (spread6H * flowSign) * 10000 * 1;

    if (impulseAligned && impulseScore >= 40) perfScore += impulseScore * 0.5;
    else if (impulseAligned)                  perfScore += impulseScore * 0.25;
    else if (impulseScore >= 40)              perfScore -= impulseScore * 0.3;

    if (m15Confirms && impulseScore >= 40) perfScore += 20;
    else if (m15Confirms)                  perfScore += 10;
    if (h3Confirms)  perfScore += 10;
    if (h6Confirms)  perfScore += 5;
    if (accelSign)   perfScore += 10;

    if (state === 'EXPANDING' && m15Confirms) perfScore += 15;
    if (state === 'EXPANDING' && impulseAligned && impulseScore >= 50) perfScore += 10;
    if (state === 'REVERSING')                       perfScore -= 10;
    if (state === 'COMPRESSING' && !m15Confirms)     perfScore -= 15;

    // Status
    const htfCount = [h3Confirms, h6Confirms].filter(x => x === true).length;
    let status;
    if (m15Confirms && htfCount === 2)       status = 'STRONG';
    else if (m15Confirms && htfCount === 1)  status = 'ALIGNED';
    else if (m15Confirms && htfCount === 0)  status = 'PARTIAL';
    else if (!m15Confirms && htfCount >= 1)  status = 'BUILDING';
    else if (!m15Confirms)                   status = 'AGAINST';
    else                                     status = 'WAIT';

    // Momentum
    let momentum;
    if (impulseScore >= 50 && impulseAligned)              momentum = 'Impulsive';
    else if (accelSign && Math.abs(v45) > 0.0003)         momentum = 'Accelerating';
    else if (!accelSign && Math.abs(accel) > 0.0002)      momentum = 'Fading';
    else if (Math.abs(v45) < 0.0002)                      momentum = 'Flat';
    else                                                   momentum = 'Steady';

    // DE + final score
    const deCombined = m15 ? parseFloat(m15.de_combined) || 0 : 0;
    const finalScore = (0.75 * perfScore) + (0.25 * deCombined);

    // Volume
    const volRV    = vol ? parseFloat(vol.relative_volume)    || 0 : 0;
    const volEff   = vol ? parseFloat(vol.volume_efficiency)  || 0 : 0;
    const volGrade = vol?.participation_grade || '';
    const volPers  = vol ? parseFloat(vol.volume_persistence) || 0 : 0;

    return {
      instrument: ep.instrument, dir: ep.dir, v45, v90,
      spread3H, spread6H, state, perfScore, finalScore,
      status, momentum, deCombined,
      volRV, volEff, volGrade, volPers,
      impulseScore, impulseAligned,
    };
  });

  // ── 6. Rank and build DB rows ──────────────────────────────────────────
  scored.sort((a, b) => b.finalScore - a.finalScore);

  const strongCcys = [...strongSet].join(',');
  const weakCcys   = [...weakSet].join(',');

  const dbRows = scored.map((s, idx) => ({
    time:               time,
    instrument:         s.instrument,
    session:            session,
    dir:                s.dir,
    rank:               idx + 1,
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
    impulse_score:      s.impulseScore,
    impulse_aligned:    s.impulseAligned,
    strong_currencies:  strongCcys,
    weak_currencies:    weakCcys,
  }));

  // ── 7. Upsert to flow_performance ──────────────────────────────────────
  if (dbRows.length) {
    const { error } = await supabase
      .from('flow_performance')
      .upsert(dbRows, { onConflict: 'time,instrument', ignoreDuplicates: false });

    if (error) throw new Error(`FP upsert: ${error.message}`);
  }

  console.log(`[FLOW_PERF] Stored ${dbRows.length} flow pairs (strong: ${strongCcys} | weak: ${weakCcys})`);
  return { rows: dbRows.length };
}

module.exports = { calculateFlowPerformance };
