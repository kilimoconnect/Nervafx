'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const VALID_PAIRS = new Set([
  'EUR_USD', 'GBP_USD', 'AUD_USD', 'NZD_USD', 'USD_JPY', 'USD_CHF', 'USD_CAD',
  'EUR_GBP', 'EUR_JPY', 'EUR_CHF', 'EUR_CAD', 'EUR_AUD', 'EUR_NZD',
  'GBP_JPY', 'GBP_CHF', 'GBP_CAD', 'GBP_AUD', 'GBP_NZD',
  'AUD_JPY', 'AUD_CHF', 'AUD_CAD', 'AUD_NZD',
  'NZD_JPY', 'NZD_CHF', 'NZD_CAD', 'CAD_JPY', 'CAD_CHF', 'CHF_JPY',
]);

const RATIO_THRESHOLD = 0.70;
const EXTREME_RATIO_THRESHOLD = 0.28;
const MAGNITUDE_THRESHOLD = 6;
const ALLOWED_STRUCTURES = new Set(['1v7', '7v1', '2v6', '6v2']);
const EXTREMES_RATIO_THRESHOLD = 0.60;

function classify(strength) {
  const strong = [], weak = [];
  for (const ccy of CURRENCIES) {
    const v = strength[ccy] || 0;
    if (v > 0) strong.push(ccy);
    else if (v < 0) weak.push(ccy);
  }
  return { strong, weak };
}

function groupStructure(strong, weak) {
  const s = strong.length, w = weak.length;
  if (s + w === 0) return { label: 'FLAT' };
  return { label: s + 'v' + w };
}

function groupSeparation(strong, weak, strength) {
  if (!strong.length || !weak.length) return { avgStrong: 0, avgWeak: 0, separation: 0, label: 'none' };
  const avgStrong = strong.reduce((s, c) => s + strength[c], 0) / strong.length;
  const avgWeak = weak.reduce((s, c) => s + strength[c], 0) / weak.length;
  const sep = avgStrong - avgWeak;
  let label;
  if (sep >= 15) label = 'EXTREME';
  else if (sep >= 10) label = 'STRONG';
  else if (sep >= 6)  label = 'GOOD';
  else if (sep >= 3)  label = 'MILD';
  else label = 'WEAK';
  return { avgStrong: Math.round(avgStrong * 100) / 100, avgWeak: Math.round(avgWeak * 100) / 100, separation: Math.round(sep * 100) / 100, label };
}

function leaderLoser(strength) {
  const sorted = CURRENCIES.slice().sort((a, b) => strength[b] - strength[a]);
  const leaderGap = strength[sorted[0]] - strength[sorted[1]];
  const loserGap = Math.abs(strength[sorted[7]] - strength[sorted[6]]);
  return {
    leader: sorted[0],
    leaderVal: Math.round(strength[sorted[0]] * 100) / 100,
    leaderGap: Math.round(leaderGap * 100) / 100,
    loser: sorted[7],
    loserVal: Math.round(strength[sorted[7]] * 100) / 100,
    loserGap: Math.round(loserGap * 100) / 100,
    ranking: sorted,
  };
}

function ratioCheck(strength) {
  const sorted = CURRENCIES.slice().sort((a, b) => strength[b] - strength[a]);
  const A = strength[sorted[0]] + strength[sorted[1]];
  const B = -(strength[sorted[6]] + strength[sorted[7]]);

  const sidesValid = A > 0 && B > 0;
  const ratio = sidesValid ? Math.min(A, B) / Math.max(A, B) : 1;
  const ratioValid = sidesValid && ratio < RATIO_THRESHOLD;

  const leaderRatio = strength[sorted[0]] !== 0
    ? strength[sorted[1]] / strength[sorted[0]] : 1;
  const leaderValid = strength[sorted[0]] > 0 && leaderRatio < EXTREME_RATIO_THRESHOLD;

  const loserRatio = strength[sorted[7]] !== 0
    ? strength[sorted[6]] / strength[sorted[7]] : 1;
  const loserValid = strength[sorted[7]] < 0 && loserRatio < EXTREME_RATIO_THRESHOLD;

  const top1Val = strength[sorted[0]];
  const bot8Val = strength[sorted[7]];

  const absTop = Math.abs(top1Val), absBot = Math.abs(bot8Val);
  const extremesRatio = (absTop > 0 && absBot > 0)
    ? Math.min(absTop, absBot) / Math.max(absTop, absBot)
    : 1;
  const extremesValid = extremesRatio < EXTREMES_RATIO_THRESHOLD;

  return {
    valid: ratioValid || leaderValid || loserValid || extremesValid,
    top1Val: Math.round(top1Val * 100) / 100,
    bot8Val: Math.round(bot8Val * 100) / 100,
    extremesRatio: Math.round(extremesRatio * 1000) / 1000,
    extremesValid,
    ratio: Math.round(ratio * 1000) / 1000,
    ratioValid,
    leaderRatio: Math.round(leaderRatio * 1000) / 1000,
    leaderValid,
    loserRatio: Math.round(loserRatio * 1000) / 1000,
    loserValid,
    top2Sum: Math.round(A * 100) / 100,
    bot2Sum: Math.round(B * 100) / 100,
    top2: [sorted[0], sorted[1]],
    bot2: [sorted[6], sorted[7]],
  };
}

function buildPairs(strong, weak, strength) {
  const pairs = [];
  for (const s of strong) {
    for (const w of weak) {
      const fwd = s + '_' + w;
      const rev = w + '_' + s;
      if (VALID_PAIRS.has(fwd)) {
        pairs.push({
          pair: s + '/' + w,
          direction: 'BUY',
          spread: Math.round((strength[s] - strength[w]) * 100) / 100,
          base: s, baseVal: Math.round(strength[s] * 100) / 100,
          quote: w, quoteVal: Math.round(strength[w] * 100) / 100,
        });
      } else if (VALID_PAIRS.has(rev)) {
        pairs.push({
          pair: w + '/' + s,
          direction: 'SELL',
          spread: Math.round((strength[s] - strength[w]) * 100) / 100,
          base: w, baseVal: Math.round(strength[w] * 100) / 100,
          quote: s, quoteVal: Math.round(strength[s] * 100) / 100,
        });
      }
    }
  }
  pairs.sort((a, b) => b.spread - a.spread);
  return pairs;
}

function analyseTimeframe(strength) {
  const groups = classify(strength);
  const struct = groupStructure(groups.strong, groups.weak);
  const sep = groupSeparation(groups.strong, groups.weak, strength);
  const ll = leaderLoser(strength);
  const ratio = ratioCheck(strength);
  const score = ratio.valid
    ? Math.min(100, Math.round((1 - ratio.ratio) * 100))
    : Math.max(0, Math.round((1 - ratio.ratio) * 100));
  const pairs = ratio.valid ? buildPairs(groups.strong, groups.weak, strength) : [];

  return {
    strength,
    groups,
    structure: { label: struct.label, imbalance: ratio.valid },
    ratio,
    separation: sep,
    leaderLoser: ll,
    score,
    pairs,
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const days = Math.min(30, parseInt(req.query?.days || '1', 10) || 1);
    const qFrom = req.query?.from;
    const qTo = req.query?.to;
    const until = qTo ? new Date(qTo + 'T23:59:59Z').toISOString() : new Date().toISOString();
    const since = qFrom ? new Date(qFrom + 'T00:00:00Z').toISOString()
      : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const PAGE = 1000;

    // Fetch M15 currency strength — one row per 15m timestamp with a values JSONB
    const m15Rows = [];
    {
      let offset = 0;
      while (true) {
        const { data, error } = await sb
          .from('m15_currency_strength')
          .select('time, values')
          .gte('time', since)
          .lte('time', until)
          .order('time', { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        if (!data || !data.length) break;
        m15Rows.push(...data);
        if (data.length < PAGE) break;
        offset += PAGE;
      }
    }

    const rows = [];

    for (const r of m15Rows) {
      const raw = r.values || {};
      const strength = {};
      for (const c of CURRENCIES) strength[c] = (parseFloat(raw[c]) || 0) * 10000;

      const result = analyseTimeframe(strength);
      if (!result.ratio.valid) continue;

      // Structure gate — only 1v7/7v1/2v6/6v2 splits qualify
      if (!ALLOWED_STRUCTURES.has(result.structure.label)) continue;

      // Magnitude gate: #1 > threshold OR #8 < -threshold
      const passes = result.ratio.top1Val > MAGNITUDE_THRESHOLD
        || result.ratio.bot8Val < -MAGNITUDE_THRESHOLD;
      if (!passes) continue;

      rows.push({
        time: r.time,
        result,
      });
    }

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
