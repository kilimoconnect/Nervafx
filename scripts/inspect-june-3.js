'use strict';

/**
 * One-off inspector — pulls currency_strength rows for a target date
 * and writes an audit CSV of every gate value at 3H / 4H / 6H.
 *
 * Usage:
 *   node scripts/inspect-june-3.js               # defaults to 2026-06-03
 *   node scripts/inspect-june-3.js 2026-06-04    # any YYYY-MM-DD
 *
 * Reads SUPABASE_URL and SUPABASE_SERVICE_KEY from .env (dotenv-style)
 * or from the current process env.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ── Load .env manually so we don't need dotenv installed ────────────────────
(function loadDotenv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY. Put them in .env or export them.');
  process.exit(1);
}
const sb = createClient(url, key);

// ── Same constants as api/market-imbalance.js ──────────────────────────────
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const TIMEFRAMES = [
  { label: '3H',  col: 'smooth_3h'  },
  { label: '4H',  col: 'smooth_4h'  },
  { label: '6H',  col: 'smooth_6h'  },
];
const RATIO_THRESHOLD = 0.70;
const EXTREME_RATIO_THRESHOLD = 0.28;
const EXTREMES_RATIO_THRESHOLD = 0.60;
const MAGNITUDE = { '3H': 10, '4H': 10, '6H': 15 };
const ALLOWED_STRUCTURES = new Set(['1v7', '7v1', '2v6', '6v2', '3v5', '5v3']);

function classify(strength) {
  const strong = [], weak = [];
  for (const c of CURRENCIES) {
    const v = strength[c] || 0;
    if (v > 0) strong.push(c);
    else if (v < 0) weak.push(c);
  }
  return { strong, weak };
}

function analyse(strength) {
  const groups = classify(strength);
  const sortedByStrength = CURRENCIES.slice().sort((a, b) => strength[b] - strength[a]);
  const top1 = sortedByStrength[0];
  const top2 = sortedByStrength[1];
  const bot1 = sortedByStrength[7];
  const bot2 = sortedByStrength[6];

  const top1Val = strength[top1];
  const bot8Val = strength[bot1];

  const A = strength[top1] + strength[top2];
  const B = -(strength[bot1] + strength[bot2]);
  const sidesValid = A > 0 && B > 0;
  const ratio = sidesValid ? Math.min(A, B) / Math.max(A, B) : 1;
  const ratioValid = sidesValid && ratio < RATIO_THRESHOLD;

  const leaderRatio = top1Val !== 0 ? strength[top2] / top1Val : 1;
  const leaderValid = top1Val > 0 && leaderRatio < EXTREME_RATIO_THRESHOLD;

  const loserRatio = bot8Val !== 0 ? strength[bot2] / bot8Val : 1;
  const loserValid = bot8Val < 0 && loserRatio < EXTREME_RATIO_THRESHOLD;

  const absTop = Math.abs(top1Val), absBot = Math.abs(bot8Val);
  const extremesRatio = (absTop > 0 && absBot > 0)
    ? Math.min(absTop, absBot) / Math.max(absTop, absBot)
    : 1;
  const extremesValid = extremesRatio < EXTREMES_RATIO_THRESHOLD;

  const structure = groups.strong.length + 'v' + groups.weak.length;

  return {
    top1, top2, bot1, bot2,
    top1Val, bot8Val,
    top2Sum: A, bot2Sum: B,
    ratio, ratioValid,
    leaderRatio, leaderValid,
    loserRatio, loserValid,
    extremesRatio, extremesValid,
    structure,
    strongCount: groups.strong.length,
    weakCount:   groups.weak.length,
  };
}

function fmt(n, digits = 2) {
  if (n == null || !isFinite(n)) return '';
  return Number(n).toFixed(digits);
}

async function main() {
  const dateArg = process.argv[2] || '2026-06-03';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    console.error('Bad date. Use YYYY-MM-DD.');
    process.exit(1);
  }
  const since = new Date(dateArg + 'T00:00:00Z').toISOString();
  const until = new Date(dateArg + 'T23:59:59Z').toISOString();
  console.log(`Fetching currency_strength ${since} → ${until} …`);

  const { data, error } = await sb
    .from('currency_strength')
    .select('time, currency, smooth_3h, smooth_4h, smooth_6h')
    .gte('time', since)
    .lte('time', until)
    .order('time', { ascending: true });
  if (error) throw error;

  const byTime = {};
  for (const r of data) {
    if (!byTime[r.time]) byTime[r.time] = {};
    byTime[r.time][r.currency] = {
      '3H':  (parseFloat(r.smooth_3h)  || 0) * 10000,
      '4H':  (parseFloat(r.smooth_4h)  || 0) * 10000,
      '6H':  (parseFloat(r.smooth_6h)  || 0) * 10000,
    };
  }

  const rows = [];
  const header = [
    'time', 'tf', 'structure',
    'top1', 'top1Val', 'bot8', 'bot8Val',
    'top2Sum', 'bot2Sum',
    'TB_pct',        // T/B ratio %
    'ratioValid',    // T/B < 70%
    'leader_pct',    // 2/1 %
    'leaderValid',   // < 28%
    'loser_pct',     // 7/8 %
    'loserValid',    // < 28%
    'extremes_pct',  // min/max of |#1|,|#8|
    'extremesValid', // < 60%
    'magPass',       // #1 > tf mag OR #8 < -tf mag
    'structPass',    // in allowed set
    'anyRatioPass',  // ratioValid || leaderValid || loserValid || (3H/6H && extremesValid)
    'qualifiesToday',// anyRatioPass && structPass && magPass
    // raw values for context
    'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD',
  ];
  rows.push(header.join(','));

  const times = Object.keys(byTime).sort();
  for (const t of times) {
    const ccyData = byTime[t];
    if (Object.keys(ccyData).length !== CURRENCIES.length) continue;
    for (const tfDef of TIMEFRAMES) {
      const strength = {};
      for (const c of CURRENCIES) strength[c] = ccyData[c]?.[tfDef.label] ?? 0;

      const r = analyse(strength);
      const mag = MAGNITUDE[tfDef.label];
      const magPass = r.top1Val > mag || r.bot8Val < -mag;
      const structPass = ALLOWED_STRUCTURES.has(r.structure);
      const extremesTFs = tfDef.label === '3H' || tfDef.label === '6H';
      const anyRatioPass = r.ratioValid || r.leaderValid || r.loserValid || (extremesTFs && r.extremesValid);
      const qualifies = anyRatioPass && structPass && magPass;

      const line = [
        t, tfDef.label, r.structure,
        r.top1, fmt(r.top1Val), r.bot1, fmt(r.bot8Val),
        fmt(r.top2Sum), fmt(r.bot2Sum),
        fmt(r.ratio * 100, 1),
        r.ratioValid,
        fmt(r.leaderRatio * 100, 1),
        r.leaderValid,
        fmt(r.loserRatio * 100, 1),
        r.loserValid,
        fmt(r.extremesRatio * 100, 1),
        r.extremesValid,
        magPass,
        structPass,
        anyRatioPass,
        qualifies,
        ...CURRENCIES.map(c => fmt(strength[c])),
      ];
      rows.push(line.join(','));
    }
  }

  const outDir = path.resolve(__dirname, '..', 'scratch');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `market-imbalance-${dateArg}.csv`);
  fs.writeFileSync(outPath, rows.join('\n'), 'utf8');
  console.log(`Wrote ${rows.length - 1} rows to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
