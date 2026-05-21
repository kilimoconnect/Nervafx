'use strict';

/**
 * V2 Threshold Optimizer
 *
 * Uses actual V2 hourly_session_activity data (all 12 engines) correlated
 * with real price outcomes from backtest_candles to discover optimal
 * thresholds for every V2 metric.
 *
 * Run: node scripts/v2-threshold-backtest.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const INSTRUMENTS = [
  'EUR_USD','GBP_USD','USD_JPY','USD_CHF','AUD_USD','NZD_USD','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_AUD','EUR_NZD','EUR_CAD',
  'GBP_JPY','GBP_CHF','GBP_AUD','GBP_NZD','GBP_CAD',
  'AUD_JPY','AUD_NZD','AUD_CHF','AUD_CAD',
  'NZD_JPY','NZD_CHF','NZD_CAD',
  'CHF_JPY','CAD_JPY','CAD_CHF',
];

const HORIZONS = [1, 4, 8]; // hours ahead

// ─── Data Loading ──────────────────────────────────────────────────────────────

async function paginate(table, select, filter, order) {
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  while (true) {
    let q = sb.from(table).select(select);
    if (filter) q = filter(q);
    if (order) q = q.order(order, { ascending: true });
    q = q.range(offset, offset + PAGE - 1);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

async function loadV2Hourly() {
  console.log('Loading V2 hourly_session_activity...');
  const rows = await paginate(
    'hourly_session_activity',
    'time_utc, session_name, movement_score, breadth_score, agreement_score, volatility_score, market_energy, tradability_score, directional_control, volatility_quality, volatility_type, momentum_score, momentum_type, chaos_score, currency_leadership_gap, false_breakout_risk, energy_cycle, expansion_readiness, pairs_moving, pairs_quiet',
    q => q.gte('time_utc', '2025-05-01T00:00:00Z'),
    'time_utc'
  );
  console.log(`  → ${rows.length} hourly rows loaded`);
  return rows;
}

async function loadCandles() {
  console.log('Loading H1 candles...');
  const candles = {};
  for (const inst of INSTRUMENTS) {
    const rows = await paginate(
      'backtest_candles',
      'time, open, high, low, close',
      q => q.eq('instrument', inst).eq('timeframe', 'H1').gte('time', '2025-05-01T00:00:00Z'),
      'time'
    );
    candles[inst] = [];
    const idx = {};
    for (const r of rows) {
      const t = new Date(r.time).toISOString();
      const entry = { time: t, open: +r.open, high: +r.high, low: +r.low, close: +r.close };
      idx[t] = candles[inst].length;
      candles[inst].push(entry);
    }
    candles[inst]._idx = idx;
  }
  console.log(`  → ${INSTRUMENTS.length} instruments loaded`);
  return candles;
}

// ─── Outcome Measurement ───────────────────────────────────────────────────────

function measureOutcome(candles, inst, time, horizonH) {
  const arr = candles[inst];
  const idx = arr._idx[time];
  if (idx == null || idx + horizonH >= arr.length) return null;

  const entry = arr[idx].close;
  let maxUp = 0, maxDown = 0;
  for (let i = 1; i <= horizonH; i++) {
    const c = arr[idx + i];
    maxUp = Math.max(maxUp, c.high - entry);
    maxDown = Math.max(maxDown, entry - c.low);
  }
  const exit = arr[idx + horizonH].close;
  const net = exit - entry;
  return {
    net_pips: Math.round(net * (inst.includes('JPY') ? 100 : 10000)),
    max_up: Math.round(maxUp * (inst.includes('JPY') ? 100 : 10000)),
    max_down: Math.round(maxDown * (inst.includes('JPY') ? 100 : 10000)),
    max_move: Math.round(Math.max(maxUp, maxDown) * (inst.includes('JPY') ? 100 : 10000)),
  };
}

// ─── Statistical Helpers ───────────────────────────────────────────────────────

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function bucketStats(outcomes) {
  if (outcomes.length < 10) return { samples: outcomes.length, insufficient: true };
  const moves = outcomes.map(o => o.max_move);
  const nets = outcomes.map(o => Math.abs(o.net_pips));
  const directional = outcomes.filter(o => Math.abs(o.net_pips) >= 8);
  return {
    samples: outcomes.length,
    avg_max_move: Math.round(avg(moves)),
    median_max_move: Math.round(median(moves)),
    avg_net: Math.round(avg(nets)),
    directional_rate: Math.round(directional.length / outcomes.length * 100),
    profitable_pct: Math.round(outcomes.filter(o => o.max_move >= 15).length / outcomes.length * 100),
  };
}

// ─── Core Analysis ─────────────────────────────────────────────────────────────

function analyzeThresholds(hourly, candles) {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  V2 THRESHOLD OPTIMIZATION — BACKTEST RESULTS');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Skip LOW_LIQUIDITY sessions
  const SKIP = new Set(['LOW_LIQUIDITY', 'DEAD_HOURS']);
  const rows = hourly.filter(r => !SKIP.has(r.session_name));
  console.log(`Analyzing ${rows.length} trading-session hours\n`);

  // Collect outcomes for each hourly row
  const snapshots = [];
  for (const r of rows) {
    const t = new Date(r.time_utc).toISOString();
    // Average outcomes across all instruments at this hour
    const hourOutcomes = {};
    for (const h of HORIZONS) {
      const outs = [];
      for (const inst of INSTRUMENTS) {
        const o = measureOutcome(candles, inst, t, h);
        if (o) outs.push(o);
      }
      if (outs.length >= 10) {
        hourOutcomes[`h${h}`] = {
          avg_max_move: Math.round(avg(outs.map(o => o.max_move))),
          avg_net: Math.round(avg(outs.map(o => Math.abs(o.net_pips)))),
          max_move: Math.max(...outs.map(o => o.max_move)),
          directional_rate: Math.round(outs.filter(o => Math.abs(o.net_pips) >= 8).length / outs.length * 100),
          _raw: outs,
        };
      }
    }
    if (!hourOutcomes.h4) continue; // need at least 4H outcomes

    snapshots.push({ ...r, outcomes: hourOutcomes });
  }
  console.log(`${snapshots.length} hours with valid 4H outcomes\n`);

  // ─── METRIC-BY-METRIC THRESHOLD ANALYSIS ───────────────────────────────────

  const METRICS = [
    { key: 'market_energy',       label: 'Market Energy',       ranges: [[0,15],[15,25],[25,35],[35,50],[50,65],[65,100]] },
    { key: 'tradability_score',   label: 'Tradability',         ranges: [[0,15],[15,25],[25,40],[40,55],[55,70],[70,100]] },
    { key: 'movement_score',      label: 'Movement',            ranges: [[0,10],[10,20],[20,35],[35,50],[50,70],[70,100]] },
    { key: 'breadth_score',       label: 'Breadth',             ranges: [[0,20],[20,35],[35,50],[50,65],[65,80],[80,100]] },
    { key: 'agreement_score',     label: 'Agreement',           ranges: [[0,15],[15,30],[30,45],[45,60],[60,75],[75,100]] },
    { key: 'directional_control', label: 'Dir Control',         ranges: [[0,10],[10,20],[20,30],[30,45],[45,60],[60,100]] },
    { key: 'volatility_quality',  label: 'Vol Quality',         ranges: [[0,10],[10,20],[20,30],[30,45],[45,60],[60,100]] },
    { key: 'volatility_score',    label: 'Volatility',          ranges: [[0,15],[15,25],[25,40],[40,55],[55,70],[70,100]] },
    { key: 'momentum_score',      label: 'Momentum',            ranges: [[-100,-30],[-30,-10],[-10,10],[10,30],[30,60],[60,100]], signed: true },
    { key: 'chaos_score',         label: 'Chaos',               ranges: [[0,10],[10,20],[20,35],[35,50],[50,70],[70,100]] },
    { key: 'currency_leadership_gap', label: 'Ccy Leadership Gap', ranges: [[0,5],[5,15],[15,25],[25,40],[40,60],[60,100]] },
    { key: 'false_breakout_risk', label: 'False Breakout Risk', ranges: [[0,15],[15,30],[30,45],[45,60],[60,75],[75,100]] },
    { key: 'expansion_readiness', label: 'Expansion Readiness', ranges: [[0,15],[15,30],[30,45],[45,60],[60,75],[75,100]] },
  ];

  const metricResults = [];

  for (const m of METRICS) {
    console.log(`── ${m.label} ──────────────────────────────────`);
    const buckets = {};

    for (const snap of snapshots) {
      const val = parseFloat(snap[m.key]) || 0;
      for (const [lo, hi] of m.ranges) {
        if (val >= lo && val < hi) {
          const label = `${lo}–${hi}`;
          if (!buckets[label]) buckets[label] = { lo, hi, outcomes_4h: [], outcomes_8h: [] };
          buckets[label].outcomes_4h.push(...(snap.outcomes.h4?._raw || []));
          if (snap.outcomes.h8) buckets[label].outcomes_8h.push(...(snap.outcomes.h8._raw || []));
          break;
        }
      }
    }

    let bestRange = null, bestMove = 0, worstRange = null, worstMove = Infinity;
    const rangeData = [];

    for (const [label, b] of Object.entries(buckets).sort((a, b) => a[1].lo - b[1].lo)) {
      const s4 = bucketStats(b.outcomes_4h);
      const s8 = bucketStats(b.outcomes_8h);

      const row = {
        range: label,
        h4: s4,
        h8: s8.insufficient ? null : s8,
      };

      if (!s4.insufficient) {
        if (s4.avg_max_move > bestMove) { bestMove = s4.avg_max_move; bestRange = label; }
        if (s4.avg_max_move < worstMove) { worstMove = s4.avg_max_move; worstRange = label; }

        const dir = s4.directional_rate;
        const moveLbl = `avg_move=${s4.avg_max_move}pip`;
        const dirLbl = `dir_rate=${dir}%`;
        const profLbl = `≥15pip=${s4.profitable_pct}%`;
        console.log(`  ${label.padEnd(10)} │ n=${String(s4.samples).padStart(5)} │ ${moveLbl.padEnd(18)} │ ${dirLbl.padEnd(12)} │ ${profLbl}`);
      } else {
        console.log(`  ${label.padEnd(10)} │ n=${String(s4.samples).padStart(5)} │ insufficient data`);
      }

      rangeData.push(row);
    }

    // Find the minimum threshold where avg_max_move crosses 15 pips and directional_rate > 50%
    let minGoodThreshold = null;
    for (const rd of rangeData) {
      if (rd.h4 && !rd.h4.insufficient && rd.h4.avg_max_move >= 15 && rd.h4.directional_rate >= 50) {
        const lo = parseInt(rd.range.split('–')[0]);
        if (minGoodThreshold === null || lo < minGoodThreshold) minGoodThreshold = lo;
      }
    }

    console.log(`  → Best range: ${bestRange} (${bestMove} pips avg)`);
    console.log(`  → Worst range: ${worstRange} (${worstMove} pips avg)`);
    if (minGoodThreshold !== null) {
      console.log(`  → Min threshold for edge: ≥${minGoodThreshold}`);
    }
    console.log('');

    metricResults.push({ metric: m.label, key: m.key, bestRange, bestMove, worstRange, worstMove, minGoodThreshold, ranges: rangeData });
  }

  // ─── ENERGY CYCLE ANALYSIS ─────────────────────────────────────────────────

  console.log('── Energy Cycle ──────────────────────────────────');
  const cycleBuckets = {};
  for (const snap of snapshots) {
    const cycle = snap.energy_cycle || 'UNKNOWN';
    if (!cycleBuckets[cycle]) cycleBuckets[cycle] = [];
    cycleBuckets[cycle].push(...(snap.outcomes.h4?._raw || []));
  }
  const cycleResults = {};
  for (const [cycle, outs] of Object.entries(cycleBuckets)) {
    const s = bucketStats(outs);
    cycleResults[cycle] = s;
    if (!s.insufficient) {
      console.log(`  ${cycle.padEnd(20)} │ n=${String(s.samples).padStart(5)} │ avg_move=${s.avg_max_move}pip │ dir=${s.directional_rate}% │ ≥15pip=${s.profitable_pct}%`);
    } else {
      console.log(`  ${cycle.padEnd(20)} │ n=${String(s.samples).padStart(5)} │ insufficient`);
    }
  }

  // ─── VOLATILITY TYPE ANALYSIS ──────────────────────────────────────────────

  console.log('\n── Volatility Type ───────────────────────────────');
  const volTypeBuckets = {};
  for (const snap of snapshots) {
    const vt = snap.volatility_type || 'UNKNOWN';
    if (!volTypeBuckets[vt]) volTypeBuckets[vt] = [];
    volTypeBuckets[vt].push(...(snap.outcomes.h4?._raw || []));
  }
  const volTypeResults = {};
  for (const [vt, outs] of Object.entries(volTypeBuckets)) {
    const s = bucketStats(outs);
    volTypeResults[vt] = s;
    if (!s.insufficient) {
      console.log(`  ${vt.padEnd(20)} │ n=${String(s.samples).padStart(5)} │ avg_move=${s.avg_max_move}pip │ dir=${s.directional_rate}% │ ≥15pip=${s.profitable_pct}%`);
    }
  }

  // ─── MOMENTUM TYPE ANALYSIS ────────────────────────────────────────────────

  console.log('\n── Momentum Type ─────────────────────────────────');
  const momTypeBuckets = {};
  for (const snap of snapshots) {
    const mt = snap.momentum_type || 'UNKNOWN';
    if (!momTypeBuckets[mt]) momTypeBuckets[mt] = [];
    momTypeBuckets[mt].push(...(snap.outcomes.h4?._raw || []));
  }
  const momTypeResults = {};
  for (const [mt, outs] of Object.entries(momTypeBuckets)) {
    const s = bucketStats(outs);
    momTypeResults[mt] = s;
    if (!s.insufficient) {
      console.log(`  ${mt.padEnd(20)} │ n=${String(s.samples).padStart(5)} │ avg_move=${s.avg_max_move}pip │ dir=${s.directional_rate}% │ ≥15pip=${s.profitable_pct}%`);
    }
  }

  // ─── SESSION-LEVEL ANALYSIS ────────────────────────────────────────────────

  console.log('\n── Session Performance ───────────────────────────');
  const sessBuckets = {};
  for (const snap of snapshots) {
    const s = snap.session_name;
    if (!sessBuckets[s]) sessBuckets[s] = [];
    sessBuckets[s].push(...(snap.outcomes.h4?._raw || []));
  }
  for (const [sess, outs] of Object.entries(sessBuckets)) {
    const s = bucketStats(outs);
    if (!s.insufficient) {
      console.log(`  ${sess.padEnd(20)} │ n=${String(s.samples).padStart(5)} │ avg_move=${s.avg_max_move}pip │ dir=${s.directional_rate}% │ ≥15pip=${s.profitable_pct}%`);
    }
  }

  // ─── MULTI-CONDITION COMBOS ────────────────────────────────────────────────

  console.log('\n══ BEST CONDITION COMBINATIONS ═══════════════════\n');

  const combos = [
    {
      name: 'Strong Trend (Trad≥55 + Agr≥50 + Brd≥50)',
      filter: s => +s.tradability_score >= 55 && +s.agreement_score >= 50 && +s.breadth_score >= 50,
    },
    {
      name: 'Tradable (Trad≥40 + Energy≥35 + DirCtrl≥20)',
      filter: s => +s.tradability_score >= 40 && +s.market_energy >= 35 && +s.directional_control >= 20,
    },
    {
      name: 'Selective (Trad≥25 + Energy≥25 + Agr≥30)',
      filter: s => +s.tradability_score >= 25 && +s.market_energy >= 25 && +s.agreement_score >= 30,
    },
    {
      name: 'High Energy + Low FB Risk (E≥45 + FB<30)',
      filter: s => +s.market_energy >= 45 && +s.false_breakout_risk < 30,
    },
    {
      name: 'Expansion Ready (ExpReady≥50 + Brd≥40)',
      filter: s => +s.expansion_readiness >= 50 && +s.breadth_score >= 40,
    },
    {
      name: 'AVOID: Low Everything (E<20 + Trad<20 + Agr<20)',
      filter: s => +s.market_energy < 20 && +s.tradability_score < 20 && +s.agreement_score < 20,
    },
    {
      name: 'AVOID: High Chaos + Low DirCtrl (Chaos≥50 + Dir<15)',
      filter: s => +s.chaos_score >= 50 && +s.directional_control < 15,
    },
    {
      name: 'AVOID: High FB Risk (FB≥60 + E<30)',
      filter: s => +s.false_breakout_risk >= 60 && +s.market_energy < 30,
    },
    {
      name: 'London Strong (London + E≥40 + Trad≥40)',
      filter: s => s.session_name === 'LONDON' && +s.market_energy >= 40 && +s.tradability_score >= 40,
    },
    {
      name: 'NY Strong (NY + E≥40 + Trad≥40)',
      filter: s => s.session_name === 'NEW_YORK' && +s.market_energy >= 40 && +s.tradability_score >= 40,
    },
    {
      name: 'Asia Filtered (Asia + E≥30 + Agr≥40)',
      filter: s => s.session_name === 'ASIA' && +s.market_energy >= 30 && +s.agreement_score >= 40,
    },
    {
      name: 'Vol Quality Sweet Spot (VolQ 30-60 + Mov≥25)',
      filter: s => +s.volatility_quality >= 30 && +s.volatility_quality < 60 && +s.movement_score >= 25,
    },
    {
      name: 'EXPLOSIVE cycle',
      filter: s => s.energy_cycle === 'EXPLOSIVE',
    },
    {
      name: 'EXPANSION cycle',
      filter: s => s.energy_cycle === 'EXPANSION',
    },
    {
      name: 'COMPRESSION cycle',
      filter: s => s.energy_cycle === 'COMPRESSION',
    },
    {
      name: 'DEAD cycle',
      filter: s => s.energy_cycle === 'DEAD',
    },
  ];

  const comboResults = [];
  for (const combo of combos) {
    const matching = snapshots.filter(combo.filter);
    const outs4 = matching.flatMap(s => s.outcomes.h4?._raw || []);
    const outs8 = matching.flatMap(s => (s.outcomes.h8?._raw || []));
    const s4 = bucketStats(outs4);
    const s8 = bucketStats(outs8);

    comboResults.push({ name: combo.name, hours: matching.length, h4: s4, h8: s8 });

    if (!s4.insufficient) {
      const h8str = s8.insufficient ? '' : ` │ 8H: move=${s8.avg_max_move}pip dir=${s8.directional_rate}%`;
      console.log(`  ${combo.name}`);
      console.log(`    Hours: ${matching.length} │ 4H: move=${s4.avg_max_move}pip dir=${s4.directional_rate}% ≥15pip=${s4.profitable_pct}%${h8str}`);
    } else {
      console.log(`  ${combo.name}`);
      console.log(`    Hours: ${matching.length} │ insufficient outcomes`);
    }
    console.log('');
  }

  // ─── OPTIMAL THRESHOLD SUMMARY ─────────────────────────────────────────────

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  RECOMMENDED V2 THRESHOLDS');
  console.log('══════════════════════════════════════════════════════════\n');

  for (const mr of metricResults) {
    const thresh = mr.minGoodThreshold !== null ? `≥${mr.minGoodThreshold}` : 'N/A';
    console.log(`  ${mr.metric.padEnd(22)} │ Optimal: ${mr.bestRange.padEnd(10)} (${mr.bestMove}pip) │ Min edge: ${thresh} │ Avoid: ${mr.worstRange}`);
  }

  console.log('\n  Energy Cycle ranking:');
  const sortedCycles = Object.entries(cycleResults)
    .filter(([, s]) => !s.insufficient)
    .sort((a, b) => b[1].avg_max_move - a[1].avg_max_move);
  for (const [cycle, s] of sortedCycles) {
    console.log(`    ${cycle.padEnd(20)} → ${s.avg_max_move}pip avg, ${s.directional_rate}% directional, ${s.profitable_pct}% ≥15pip`);
  }

  console.log('\n  Volatility Type ranking:');
  const sortedVT = Object.entries(volTypeResults)
    .filter(([, s]) => !s.insufficient)
    .sort((a, b) => b[1].avg_max_move - a[1].avg_max_move);
  for (const [vt, s] of sortedVT) {
    console.log(`    ${vt.padEnd(20)} → ${s.avg_max_move}pip avg, ${s.directional_rate}% directional`);
  }

  console.log('\n  Tradability grade mapping (current → data-backed):');
  // Find optimal tradability cutoffs
  const tradRanges = metricResults.find(m => m.key === 'tradability_score')?.ranges || [];
  for (const tr of tradRanges) {
    if (tr.h4 && !tr.h4.insufficient) {
      const grade = tr.h4.avg_max_move >= 25 ? 'STRONG_TREND'
        : tr.h4.avg_max_move >= 18 ? 'TRADABLE'
        : tr.h4.avg_max_move >= 12 ? 'SELECTIVE'
        : tr.h4.avg_max_move >= 8  ? 'DANGEROUS'
        : 'AVOID';
      console.log(`    Trad ${tr.range.padEnd(8)} → ${grade.padEnd(14)} (${tr.h4.avg_max_move}pip avg, ${tr.h4.directional_rate}% dir)`);
    }
  }

  console.log('\n══════════════════════════════════════════════════════════\n');

  return { metricResults, cycleResults, volTypeResults, momTypeResults, comboResults };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  try {
    const [hourly, candles] = await Promise.all([loadV2Hourly(), loadCandles()]);
    const results = analyzeThresholds(hourly, candles);

    // Save JSON output
    const fs = require('fs');
    const outPath = 'scripts/v2-threshold-results.json';
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`Full results saved to ${outPath}`);
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exit(1);
  }
}

main();
