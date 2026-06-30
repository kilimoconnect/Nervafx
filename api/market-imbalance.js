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

function buildPairs(strong, weak, strength) {
  const pairs = [];
  for (const s of strong) {
    for (const w of weak) {
      const fwd = s + '_' + w;
      const rev = w + '_' + s;
      if (VALID_PAIRS.has(fwd)) {
        // Base is strong, quote is weak → BUY
        pairs.push({
          pair: s + '/' + w,
          direction: 'BUY',
          spread: Math.round((strength[s] - strength[w]) * 100) / 100,
          base: s, baseVal: Math.round(strength[s] * 100) / 100,
          quote: w, quoteVal: Math.round(strength[w] * 100) / 100,
        });
      } else if (VALID_PAIRS.has(rev)) {
        // Base is weak, quote is strong → SELL
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
  const minority = minorityExtremeCheck(groups.strong, groups.weak, strength);
  const sep = groupSeparation(groups.strong, groups.weak, strength);
  const ll = leaderLoser(strength);
  const score = imbalanceScore(struct, minority, sep, ll);
  const pairs = struct.imbalance ? buildPairs(groups.strong, groups.weak, strength) : [];

  return {
    strength,
    groups,
    structure: struct,
    minority,
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

      // Only keep timeframes where AUD+NZD or CHF+JPY are the minority 2 in a 6v2
      const tfResults = {};
      for (const tf of ['3H', '4H', '6H', '12H']) {
        const strength = {};
        for (const ccy of CURRENCIES) strength[ccy] = ccyData[ccy]?.[tf] || 0;
        const result = analyseTimeframe(strength);
        if (!result.structure.imbalance) continue;
        const s = result.groups.strong, w = result.groups.weak;
        const minority = s.length === 2 ? s : w.length === 2 ? w : null;
        if (!minority) continue;
        const set = new Set(minority);
        if ((set.has('AUD') && set.has('NZD')) || (set.has('CHF') && set.has('JPY'))) {
          result.driver = set.has('AUD') ? 'AUD+NZD' : 'CHF+JPY';
          tfResults[tf] = result;
        }
      }

      const qualifiedTfs = Object.keys(tfResults);
      if (!qualifiedTfs.length) continue;

      const bestTf = qualifiedTfs.reduce((best, tf) =>
        tfResults[tf].score > tfResults[best].score ? tf : best, qualifiedTfs[0]);

      rows.push({
        time,
        timeframes: tfResults,
        qualifiedTfs,
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
