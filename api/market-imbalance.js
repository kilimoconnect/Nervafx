'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

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
  if (s + w === 0) return { label: 'FLAT', imbalance: false };
  // Only 6v2 (or 2v6) counts as imbalance
  const imbalance = (s === 6 && w === 2) || (s === 2 && w === 6);
  return { label: s + 'v' + w, imbalance };
}

function minorityExtremeCheck(strong, weak, strength) {
  if (strong.length === weak.length) return { valid: true, reason: 'balanced' };
  const minority = strong.length < weak.length ? strong : weak;
  if (minority.length === 0 || minority.length > 3) return { valid: true, reason: 'no minority or too large' };

  let maxCcy = CURRENCIES[0], minCcy = CURRENCIES[0];
  for (const c of CURRENCIES) {
    if (strength[c] > strength[maxCcy]) maxCcy = c;
    if (strength[c] < strength[minCcy]) minCcy = c;
  }

  const hasStrongest = minority.includes(maxCcy);
  const hasWeakest = minority.includes(minCcy);
  return {
    valid: hasStrongest || hasWeakest,
    strongest: maxCcy,
    weakest: minCcy,
    reason: hasStrongest ? 'has strongest' : hasWeakest ? 'has weakest' : 'no extreme in minority',
  };
}

function groupSeparation(strong, weak, strength) {
  if (!strong.length || !weak.length) return { avgStrong: 0, avgWeak: 0, separation: 0, label: 'none' };
  const avgStrong = strong.reduce((s, c) => s + strength[c], 0) / strong.length;
  const avgWeak = weak.reduce((s, c) => s + strength[c], 0) / weak.length;
  const sep = avgStrong - avgWeak;
  let label;
  if (sep >= 20) label = 'EXTREME';
  else if (sep >= 15) label = 'STRONG';
  else if (sep >= 10) label = 'GOOD';
  else if (sep >= 5) label = 'MILD';
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

function imbalanceScore(struct, minority, sep, ll) {
  if (!struct.imbalance) return 0;
  let score = 0;
  const parts = struct.label.split('v').map(Number);
  const ratio = Math.max(parts[0], parts[1]) / 8;
  score += ratio * 30;
  score += minority.valid ? 25 : 0;
  if (sep.label === 'EXTREME') score += 25;
  else if (sep.label === 'STRONG') score += 20;
  else if (sep.label === 'GOOD') score += 15;
  else if (sep.label === 'MILD') score += 8;
  const dominance = Math.max(ll.leaderGap, ll.loserGap);
  score += Math.min(20, dominance * 2);
  if (!minority.valid) score = Math.round(score * 0.65);
  return Math.min(100, Math.round(score));
}

function analyseTimeframe(strength) {
  const groups = classify(strength);
  const struct = groupStructure(groups.strong, groups.weak);
  const minority = minorityExtremeCheck(groups.strong, groups.weak, strength);
  const sep = groupSeparation(groups.strong, groups.weak, strength);
  const ll = leaderLoser(strength);
  const score = imbalanceScore(struct, minority, sep, ll);

  return {
    strength,
    groups,
    structure: struct,
    minority,
    separation: sep,
    leaderLoser: ll,
    score,
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

    const days = Math.min(30, parseInt(req.query?.days || '2', 10) || 2);
    const qFrom = req.query?.from;
    const qTo = req.query?.to;
    const until = qTo ? new Date(qTo + 'T23:59:59Z').toISOString() : new Date().toISOString();
    const since = qFrom ? new Date(qFrom + 'T00:00:00Z').toISOString()
      : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const allRows = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('currency_strength')
        .select('time, currency, smooth_3h, smooth_4h, smooth_6h, smooth_12h')
        .gte('time', since)
        .lte('time', until)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      allRows.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    // Group by time
    const byTime = {};
    for (const r of allRows) {
      if (!byTime[r.time]) byTime[r.time] = {};
      byTime[r.time][r.currency] = {
        '3H': (parseFloat(r.smooth_3h) || 0) * 10000,
        '4H': (parseFloat(r.smooth_4h) || 0) * 10000,
        '6H': (parseFloat(r.smooth_6h) || 0) * 10000,
        '12H': (parseFloat(r.smooth_12h) || 0) * 10000,
      };
    }

    const timestamps = Object.keys(byTime).sort();
    const rows = [];

    for (const time of timestamps) {
      const ccyData = byTime[time];
      if (Object.keys(ccyData).length < 8) continue;

      const tfResults = {};
      for (const tf of ['3H', '4H', '6H', '12H']) {
        const strength = {};
        for (const ccy of CURRENCIES) strength[ccy] = ccyData[ccy]?.[tf] || 0;
        tfResults[tf] = analyseTimeframe(strength);
      }

      // Skip if no timeframe shows imbalance
      const hasImbalance = ['3H', '4H', '6H', '12H'].some(tf => tfResults[tf].structure.imbalance);
      if (!hasImbalance) continue;

      // Best score across timeframes
      const bestTf = ['3H', '4H', '6H', '12H'].reduce((best, tf) =>
        tfResults[tf].score > tfResults[best].score ? tf : best, '3H');

      rows.push({
        time,
        timeframes: tfResults,
        bestTf,
        bestScore: tfResults[bestTf].score,
      });
    }

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
