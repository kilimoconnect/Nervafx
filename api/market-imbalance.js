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
const TIMEFRAMES = ['15M', '3H', '4H', '6H'];
const RATIO_THRESHOLD = 0.70;
const EXTREME_RATIO_THRESHOLD = 0.28;
const MAGNITUDE_THRESHOLD = 15;

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

// Market imbalance qualifies when ANY of these holds:
//   1. Top-2 vs Bottom-2 ratio: A = sum of top-2 strengths, B = |sum of bottom-2|;
//      min(A,B)/max(A,B) < 0.70 (one side dwarfs the other by more than ~43%)
//   2. Leader dominance: strength[2nd] / strength[1st] < 0.28
//   3. Loser dominance:  strength[7th] / strength[8th] < 0.28
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

  // Magnitude info — used only by the 6H gate in the caller
  const magnitudeValid = strength[sorted[0]] > MAGNITUDE_THRESHOLD
    || strength[sorted[7]] < -MAGNITUDE_THRESHOLD;

  return {
    valid: ratioValid || leaderValid || loserValid,
    magnitudeValid,
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
  // Score reflects how imbalanced the two sides are — 0 when balanced, 100 when one side dwarfs the other
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

    const days = Math.min(30, parseInt(req.query?.days || '2', 10) || 2);
    const qFrom = req.query?.from;
    const qTo = req.query?.to;
    const until = qTo ? new Date(qTo + 'T23:59:59Z').toISOString() : new Date().toISOString();
    const since = qFrom ? new Date(qFrom + 'T00:00:00Z').toISOString()
      : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const PAGE = 1000;

    // Fetch M15 currency strength (one row per 15m with values.CCY)
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

    // Fetch hourly currency strength — extend since by 1h so we can carry-forward the
    // last hourly reading for any M15 timestamp that predates the first hourly row in range
    const hourlySince = new Date(new Date(since).getTime() - 60 * 60 * 1000).toISOString();
    const hourlyRows = [];
    {
      let offset = 0;
      while (true) {
        const { data, error } = await sb
          .from('currency_strength')
          .select('time, currency, smooth_3h, smooth_4h, smooth_6h')
          .gte('time', hourlySince)
          .lte('time', until)
          .order('time', { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        if (!data || !data.length) break;
        hourlyRows.push(...data);
        if (data.length < PAGE) break;
        offset += PAGE;
      }
    }

    // Index hourly rows by time
    const hourlyByTime = {};
    for (const r of hourlyRows) {
      if (!hourlyByTime[r.time]) hourlyByTime[r.time] = {};
      hourlyByTime[r.time][r.currency] = {
        '3H': (parseFloat(r.smooth_3h) || 0) * 10000,
        '4H': (parseFloat(r.smooth_4h) || 0) * 10000,
        '6H': (parseFloat(r.smooth_6h) || 0) * 10000,
      };
    }
    const hourlyTimes = Object.keys(hourlyByTime).sort();

    function lastHourlyAtOrBefore(t) {
      let lo = 0, hi = hourlyTimes.length - 1, best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (hourlyTimes[mid] <= t) { best = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      return best >= 0 ? hourlyByTime[hourlyTimes[best]] : null;
    }

    const rows = [];

    for (const m15Row of m15Rows) {
      const t = m15Row.time;
      // Present hourly only — skip anything that isn't on a top-of-hour boundary
      if (new Date(t).getUTCMinutes() !== 0) continue;
      const m15Values = m15Row.values || {};
      const hourlyValues = lastHourlyAtOrBefore(t);

      // Build strengths per timeframe
      const strengths = {};
      strengths['15M'] = {};
      for (const c of CURRENCIES) strengths['15M'][c] = (parseFloat(m15Values[c]) || 0) * 10000;

      if (hourlyValues && Object.keys(hourlyValues).length === CURRENCIES.length) {
        for (const tf of ['3H', '4H', '6H']) {
          strengths[tf] = {};
          for (const c of CURRENCIES) strengths[tf][c] = hourlyValues[c]?.[tf] || 0;
        }
      }

      const tfResults = {};
      for (const tf of TIMEFRAMES) {
        if (!strengths[tf]) continue;
        const result = analyseTimeframe(strengths[tf]);
        if (!result.ratio.valid) continue;
        // Magnitude gate applies to 6H only
        if (tf === '6H' && !result.ratio.magnitudeValid) continue;
        tfResults[tf] = result;
      }

      const qualifiedTfs = Object.keys(tfResults);
      if (!qualifiedTfs.length) continue;

      const bestTf = qualifiedTfs.reduce((best, tf) =>
        tfResults[tf].score > tfResults[best].score ? tf : best, qualifiedTfs[0]);

      rows.push({
        time: t,
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
