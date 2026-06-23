'use strict';

const { createClient } = require('@supabase/supabase-js');
const { sendEmail, sendBulk, baseLayout } = require('./emailService');

const INSTRUMENTS = [
  'EUR_USD', 'GBP_USD', 'AUD_USD', 'NZD_USD',
  'USD_JPY', 'USD_CHF', 'USD_CAD',
  'EUR_GBP', 'EUR_JPY', 'EUR_CHF', 'EUR_CAD', 'EUR_AUD', 'EUR_NZD',
  'GBP_JPY', 'GBP_CHF', 'GBP_CAD', 'GBP_AUD', 'GBP_NZD',
  'AUD_JPY', 'AUD_CHF', 'AUD_CAD', 'AUD_NZD',
  'NZD_JPY', 'NZD_CHF', 'NZD_CAD',
  'CAD_JPY', 'CAD_CHF',
  'CHF_JPY',
];

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function computeH1Quality(candles) {
  if (candles.length < 6) return null;
  const c = candles.slice(-6);
  const bull = c.filter(x => x.close > x.open).length;
  const bear = c.filter(x => x.close < x.open).length;
  const dirScore = ((bull - bear) / 6) * 100;
  const dir = dirScore > 0 ? 'BULLISH' : dirScore < 0 ? 'BEARISH' : 'NEUTRAL';
  const net = Math.abs(c[5].close - c[0].open);
  const range = c.reduce((s, x) => s + (x.high - x.low), 0);
  const impulse = range > 0 ? (net / range) * 100 : 0;
  const wick = c.reduce((s, x) => s + (x.high - x.low - Math.abs(x.close - x.open)), 0);
  const wickCln = range > 0 ? 100 - (wick / range) * 100 : 0;
  const quality = Math.round(0.15 * Math.abs(dirScore) + 0.80 * impulse + 0.05 * wickCln);
  let cls;
  if (quality >= 60) cls = 'VERY_CLEAN';
  else if (quality >= 45) cls = 'TRADEABLE';
  else if (quality >= 30) cls = 'WEAK';
  else cls = 'CHOPPY';
  return { direction: dir, directionScore: Math.round(dirScore), impulseStrength: Math.round(impulse), wickCleanliness: Math.round(wickCln), quality, classification: cls };
}

function computeM15Quality(candles) {
  if (candles.length < 10) return null;
  const c = candles.slice(-10);
  const bull = c.filter(x => x.close > x.open).length;
  const bear = c.filter(x => x.close < x.open).length;
  const dirScore = ((bull - bear) / 10) * 100;
  const dir = dirScore > 0 ? 'BULLISH' : dirScore < 0 ? 'BEARISH' : 'NEUTRAL';
  const net = Math.abs(c[9].close - c[0].open);
  const range = c.reduce((s, x) => s + (x.high - x.low), 0);
  const impulse = range > 0 ? (net / range) * 100 : 0;
  const wick = c.reduce((s, x) => s + (x.high - x.low - Math.abs(x.close - x.open)), 0);
  const wickCln = range > 0 ? 100 - (wick / range) * 100 : 0;
  const quality = Math.round(0.15 * Math.abs(dirScore) + 0.80 * impulse + 0.05 * wickCln);
  let cls;
  if (quality >= 80) cls = 'VERY_CLEAN';
  else if (quality >= 65) cls = 'TRADEABLE';
  else if (quality >= 40) cls = 'WEAK';
  else cls = 'CHOPPY';
  return { direction: dir, directionScore: Math.round(dirScore), impulseStrength: Math.round(impulse), wickCleanliness: Math.round(wickCln), quality, classification: cls };
}

async function fetchCandles(sb, timeframe, since) {
  const byInst = {};
  for (let b = 0; b < INSTRUMENTS.length; b += 7) {
    const batch = INSTRUMENTS.slice(b, b + 7);
    const results = await Promise.all(batch.map(async (inst) => {
      const { data, error } = await sb
        .from('backtest_candles')
        .select('time, open, high, low, close')
        .eq('instrument', inst)
        .eq('timeframe', timeframe)
        .eq('complete', true)
        .gte('time', since)
        .order('time', { ascending: true })
        .limit(200);
      if (error) throw error;
      return { inst, data: data || [] };
    }));
    for (const { inst, data } of results) {
      byInst[inst] = data.map(c => ({
        time: c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close,
      }));
    }
  }
  return byInst;
}

function getLatestH1Pairs(h1ByInst) {
  const snapshots = {};
  for (const inst of INSTRUMENTS) {
    const candles = h1ByInst[inst] || [];
    for (let i = 5; i < candles.length; i++) {
      const q = computeH1Quality(candles.slice(i - 5, i + 1));
      if (!q) continue;
      const time = candles[i].time;
      if (!snapshots[time]) snapshots[time] = {};
      snapshots[time][inst] = q;
    }
  }
  const times = Object.keys(snapshots).sort((a, b) => b.localeCompare(a));
  if (!times.length) return { pairs: [], time: null };

  const latest = times[0];
  const prev = times[1] || null;
  const pairs = Object.entries(snapshots[latest])
    .map(([pair, q]) => ({ pair, ...q }))
    .filter(p => p.quality >= 30 && p.direction !== 'NEUTRAL')
    .sort((a, b) => b.quality - a.quality)
    .slice(0, 5);

  // Trending: check if pair was in top 5 previous hour too with quality > 40
  if (prev) {
    const prevTop5 = new Set(
      Object.entries(snapshots[prev])
        .map(([pair, q]) => ({ pair, quality: q.quality }))
        .sort((a, b) => b.quality - a.quality)
        .slice(0, 5)
        .map(p => p.pair)
    );
    for (const p of pairs) {
      p.trending = prevTop5.has(p.pair) && p.quality > 40;
    }
  }

  return { pairs, time: latest };
}

function getLatestM15Pairs(m15ByInst) {
  const snapshots = {};
  for (const inst of INSTRUMENTS) {
    const candles = m15ByInst[inst] || [];
    for (let i = 9; i < candles.length; i++) {
      const q = computeM15Quality(candles.slice(i - 9, i + 1));
      if (!q) continue;
      const time = candles[i].time;
      if (!snapshots[time]) snapshots[time] = {};
      snapshots[time][inst] = q;
    }
  }
  const times = Object.keys(snapshots).sort((a, b) => b.localeCompare(a));
  if (!times.length) return { pairs: [], time: null };

  const latest = times[0];
  // Trending: #1 rank for 3 consecutive periods, quality >= 30 all 3, latest >= 50
  const qMap = {};
  const rank1ByTime = {};
  for (const t of times) {
    qMap[t] = {};
    const sorted = Object.entries(snapshots[t])
      .map(([pair, q]) => { qMap[t][pair] = q.quality; return { pair, quality: q.quality }; })
      .sort((a, b) => b.quality - a.quality);
    if (sorted.length) rank1ByTime[t] = sorted[0].pair;
  }

  const trendingSet = new Set();
  if (times.length >= 3) {
    const t = times.slice(0, 3);
    const r1 = t.map(x => rank1ByTime[x]);
    if (r1[0] && r1[0] === r1[1] && r1[1] === r1[2] &&
        qMap[t[0]][r1[0]] >= 50 && qMap[t[1]][r1[0]] >= 30 && qMap[t[2]][r1[0]] >= 30) {
      trendingSet.add(r1[0]);
    }
  }

  const pairs = Object.entries(snapshots[latest])
    .map(([pair, q]) => ({ pair, ...q, trending: trendingSet.has(pair) }))
    .filter(p => p.direction !== 'NEUTRAL')
    .sort((a, b) => {
      if (a.trending !== b.trending) return a.trending ? -1 : 1;
      return b.quality - a.quality;
    })
    .slice(0, 5);

  return { pairs, time: latest };
}

function qualityAlertEmail(h1Pairs, m15Pairs, h1Time, m15Time) {
  const fmtTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${days[d.getUTCDay()]} ${hh}:${mm} UTC`;
  };

  const dirTag = (dir) => dir === 'BULLISH'
    ? '<span class="tag tag-green">BUY</span>'
    : dir === 'BEARISH' ? '<span class="tag tag-red">SELL</span>' : '<span class="tag tag-gray">—</span>';

  const clsColor = (cls) => cls === 'VERY_CLEAN' ? '#4ade80' : cls === 'TRADEABLE' ? '#60a5fa' : cls === 'WEAK' ? '#fbbf24' : '#f87171';

  const pairRow = (p, type) => {
    const trending = p.trending ? '<span class="tag tag-amber" style="margin-left:4px">▲ ' + (type === 'h1' ? '2x' : '3x') + '</span>' : '';
    return `<div class="row row-bordered" style="border-left-color:${clsColor(p.classification)}">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="color:#f1f5f9;font-weight:800;font-size:14px">${p.pair.replace('_', '/')}</span>
        ${dirTag(p.direction)}
        <span style="color:${clsColor(p.classification)};font-weight:800;font-size:15px">${p.quality}%</span>
        <span class="tag" style="background:rgba(255,255,255,0.05);color:${clsColor(p.classification)}">${p.classification.replace('_', ' ')}</span>
        ${trending}
      </div>
      <div style="margin-top:4px">
        <span class="metric">D:<b>${p.directionScore > 0 ? '+' : ''}${p.directionScore}</b></span>
        <span class="metric">I:<b>${p.impulseStrength}</b></span>
        <span class="metric">W:<b>${p.wickCleanliness}</b></span>
      </div>
    </div>`;
  };

  const h1Html = h1Pairs.length ? `
    <div class="section">
      <div class="section-label">H1 Quality · ${fmtTime(h1Time)}</div>
      ${h1Pairs.map(p => pairRow(p, 'h1')).join('')}
    </div>` : '';

  const m15Html = m15Pairs.length ? `
    <div class="section">
      <div class="section-label">M15 Quality · ${fmtTime(m15Time)}</div>
      ${m15Pairs.map(p => pairRow(p, 'm15')).join('')}
    </div>` : '';

  const count = h1Pairs.length + m15Pairs.length;

  return {
    subject: `${count} Quality Pair${count !== 1 ? 's' : ''} — NervaFX`,
    html: baseLayout(`
      <h2>Candle Quality Alert</h2>
      <p class="sub">Top pairs by candle quality — structure, impulse &amp; direction</p>
      ${h1Html}
      ${m15Html}
      <p style="text-align:center;margin:24px 0"><a class="cta" href="https://nervafx.com/structure-break">View H1 Quality →</a></p>
      <p style="color:#94a3b8;font-size:12px;text-align:center">Quality scores are not trade signals. Always confirm with structure breakouts.</p>
    `),
  };
}

async function sendQualityAlerts(sb) {
  if (!sb) sb = getDB();

  const since = new Date(Date.now() - 8 * 3600000).toISOString();
  const m15Since = new Date(Date.now() - 3 * 3600000).toISOString();

  const [h1ByInst, m15ByInst] = await Promise.all([
    fetchCandles(sb, 'H1', since),
    fetchCandles(sb, 'M15', m15Since),
  ]);

  const { pairs: h1Pairs, time: h1Time } = getLatestH1Pairs(h1ByInst);
  const { pairs: m15Pairs, time: m15Time } = getLatestM15Pairs(m15ByInst);

  if (!h1Pairs.length && !m15Pairs.length) {
    console.log('[QUALITY-ALERTS] No quality pairs to alert');
    return { sent: 0 };
  }

  // Get subscribed users (reuse signal_alerts preference)
  const { data: users } = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (!users?.users?.length) return { sent: 0 };

  const { data: prefs } = await sb
    .from('email_preferences')
    .select('user_id, signal_alerts, unsubscribed, notification_email');
  const prefMap = {};
  for (const p of prefs || []) prefMap[p.user_id] = p;

  const recipients = users.users.filter(u => {
    const p = prefMap[u.id];
    if (p?.unsubscribed) return false;
    if (p?.signal_alerts === false) return false;
    return true;
  }).map(u => ({ email: prefMap[u.id]?.notification_email || u.email }));

  if (!recipients.length) return { sent: 0 };

  const template = qualityAlertEmail(h1Pairs, m15Pairs, h1Time, m15Time);
  await sendBulk(recipients, template);
  console.log(`[QUALITY-ALERTS] Sent to ${recipients.length} users — H1:${h1Pairs.length} M15:${m15Pairs.length}`);
  return { sent: recipients.length, h1: h1Pairs.length, m15: m15Pairs.length };
}

module.exports = { sendQualityAlerts };
