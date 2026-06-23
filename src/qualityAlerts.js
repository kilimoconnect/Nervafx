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

function getLatestH1Pairs(h1ByInst, m15ByInst) {
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

  // Compute M15 quality at each H1 timestamp for cross-filtering
  const m15QualityAt = {};
  for (const inst of INSTRUMENTS) {
    const candles = m15ByInst[inst] || [];
    if (candles.length < 10) continue;
    for (const time of Object.keys(snapshots)) {
      const t = new Date(time).getTime();
      const before = candles.filter(c => new Date(c.time).getTime() <= t);
      if (before.length < 10) continue;
      const q = computeM15Quality(before.slice(-10));
      if (q) {
        if (!m15QualityAt[time]) m15QualityAt[time] = {};
        m15QualityAt[time][inst] = q.quality;
      }
    }
  }

  const times = Object.keys(snapshots).sort((a, b) => b.localeCompare(a));
  if (!times.length) return { pairs: [], time: null };

  const latest = times[0];
  const prev = times[1] || null;
  const m15q = m15QualityAt[latest] || {};
  const pairs = Object.entries(snapshots[latest])
    .map(([pair, q]) => ({ pair, ...q, m15Quality: m15q[pair] || 0 }))
    .filter(p => p.quality >= 30 && p.direction !== 'NEUTRAL' && p.m15Quality >= 40)
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

function qualityAlertEmail(h1Pairs, m15Pairs, h1Time, m15Time, timezone) {
  const tz = timezone || 'UTC';
  const fmtTime = (iso) => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const opts = { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz, hour12: false };
      const formatted = d.toLocaleString('en-US', opts);
      const tzShort = d.toLocaleString('en-US', { timeZone: tz, timeZoneName: 'short' }).split(' ').pop();
      return `${formatted} ${tzShort}`;
    } catch (_) {
      const d = new Date(iso);
      const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      return `${days[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
    }
  };

  const clsColor = (cls) => cls === 'VERY_CLEAN' ? '#4ade80' : cls === 'TRADEABLE' ? '#60a5fa' : cls === 'WEAK' ? '#fbbf24' : '#f87171';
  const dirColor = (dir) => dir === 'BULLISH' ? '#4ade80' : '#f87171';
  const dirLabel = (dir) => dir === 'BULLISH' ? 'BUY' : 'SELL';

  const pairRow = (p, idx, type) => {
    const trendHtml = p.trending
      ? `<td style="padding:0 0 0 6px"><span style="display:inline-block;background:rgba(251,191,36,0.15);color:#fbbf24;font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px">▲ ${type === 'h1' ? '2x' : '3x'}</span></td>`
      : '';
    const dSign = p.directionScore > 0 ? '+' : '';
    return `<tr>
      <td style="padding:10px 14px;border-bottom:1px solid #1e293b">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="width:24px;vertical-align:top;padding-top:2px">
            <span style="display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;border-radius:50%;background:#1e293b;color:#94a3b8;font-size:10px;font-weight:700">${idx + 1}</span>
          </td>
          <td style="padding:0 0 0 8px">
            <table cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="padding:0"><span style="color:#f1f5f9;font-weight:800;font-size:15px;letter-spacing:-0.2px">${p.pair.replace('_', '/')}</span></td>
              <td style="padding:0 0 0 8px"><span style="display:inline-block;background:${dirColor(p.direction)}20;color:${dirColor(p.direction)};font-size:10px;font-weight:700;padding:2px 7px;border-radius:3px">${dirLabel(p.direction)}</span></td>
              <td style="padding:0 0 0 8px"><span style="color:${clsColor(p.classification)};font-weight:800;font-size:15px">${p.quality}%</span></td>
              <td style="padding:0 0 0 6px"><span style="display:inline-block;background:${clsColor(p.classification)}15;color:${clsColor(p.classification)};font-size:10px;font-weight:600;padding:2px 7px;border-radius:3px">${p.classification.replace('_', ' ')}</span></td>
              ${trendHtml}
            </tr></table>
            <table cellpadding="0" cellspacing="0" border="0" style="margin-top:6px"><tr>
              <td style="padding:0"><span style="display:inline-block;background:#0f172a;border:1px solid #1e293b;border-radius:4px;padding:3px 8px;font-size:11px;color:#94a3b8">D:<span style="color:#f1f5f9;font-weight:700">${dSign}${p.directionScore}</span></span></td>
              <td style="padding:0 0 0 4px"><span style="display:inline-block;background:#0f172a;border:1px solid #1e293b;border-radius:4px;padding:3px 8px;font-size:11px;color:#94a3b8">I:<span style="color:#f1f5f9;font-weight:700">${p.impulseStrength}</span></span></td>
              <td style="padding:0 0 0 4px"><span style="display:inline-block;background:#0f172a;border:1px solid #1e293b;border-radius:4px;padding:3px 8px;font-size:11px;color:#94a3b8">W:<span style="color:#f1f5f9;font-weight:700">${p.wickCleanliness}</span></span></td>
            </tr></table>
          </td>
        </tr></table>
      </td>
    </tr>`;
  };

  const sectionHtml = (title, time, pairs, type, link) => {
    if (!pairs.length) return '';
    return `
    <div class="card" style="margin:20px 0">
      <div class="card-hd" style="display:flex;padding:12px 14px;border-bottom:1px solid #1e293b">
        <span style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1.2px">${title}</span>
        <span style="margin-left:auto;font-size:11px;color:#94a3b8">${fmtTime(time)}</span>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        ${pairs.map((p, i) => pairRow(p, i, type)).join('')}
      </table>
      <div style="padding:10px 14px;text-align:right;border-top:1px solid #1e293b">
        <a href="${link}" style="font-size:11px;color:#f59e0b;text-decoration:none;font-weight:600">View All →</a>
      </div>
    </div>`;
  };

  const h1Html = sectionHtml('H1 Quality', h1Time, h1Pairs, 'h1', 'https://nervafx.com/structure-break');
  const m15Html = sectionHtml('M15 Quality', m15Time, m15Pairs, 'm15', 'https://nervafx.com/m15-quality');

  const count = h1Pairs.length + m15Pairs.length;
  const trending = [...h1Pairs, ...m15Pairs].filter(p => p.trending);
  const trendLine = trending.length
    ? `<p style="color:#fbbf24;font-size:13px;text-align:center;margin:0 0 16px">▲ ${trending.map(p => p.pair.replace('_','/')).join(', ')} trending</p>`
    : '';

  return {
    subject: `${count} Quality Pair${count !== 1 ? 's' : ''}${trending.length ? ' — ' + trending.map(p => p.pair.replace('_','/')).join(', ') + ' trending' : ''} — NervaFX`,
    html: baseLayout(`
      <h2 style="margin:0 0 4px">Candle Quality Alert</h2>
      <p class="sub" style="margin:0 0 8px">Top pairs ranked by direction, impulse &amp; wick cleanliness</p>
      ${trendLine}
      ${h1Html}
      ${m15Html}
      <div style="text-align:center;margin:24px 0">
        <a class="cta" href="https://nervafx.com/app" style="display:inline-block;padding:12px 32px;background:#f59e0b;color:#0f172a;font-weight:700;text-decoration:none;border-radius:6px;font-size:14px">Open Dashboard →</a>
      </div>
      <p style="color:#475569;font-size:11px;text-align:center;margin:16px 0 0">Quality scores measure candle structure, not trade signals. Always confirm with structure breakouts.</p>
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

  const { pairs: h1Pairs, time: h1Time } = getLatestH1Pairs(h1ByInst, m15ByInst);
  const { pairs: m15Pairs, time: m15Time } = getLatestM15Pairs(m15ByInst);

  if (!h1Pairs.length && !m15Pairs.length) {
    console.log('[QUALITY-ALERTS] No quality pairs to alert');
    return { sent: 0 };
  }

  // Get subscribed users (reuse signal_alerts preference)
  const { data: users } = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (!users?.users?.length) return { sent: 0 };

  const [{ data: prefs }, { data: profiles }] = await Promise.all([
    sb.from('email_preferences').select('user_id, signal_alerts, unsubscribed, notification_email'),
    sb.from('user_profiles').select('id, timezone'),
  ]);
  const prefMap = {};
  for (const p of prefs || []) prefMap[p.user_id] = p;
  const tzMap = {};
  for (const p of profiles || []) tzMap[p.id] = p.timezone;

  const recipients = users.users.filter(u => {
    const p = prefMap[u.id];
    if (p?.unsubscribed) return false;
    if (p?.signal_alerts === false) return false;
    return true;
  }).map(u => ({
    email: prefMap[u.id]?.notification_email || u.email,
    timezone: tzMap[u.id] || 'UTC',
  }));

  if (!recipients.length) return { sent: 0 };

  // Group recipients by timezone to batch emails
  const byTz = {};
  for (const r of recipients) {
    if (!byTz[r.timezone]) byTz[r.timezone] = [];
    byTz[r.timezone].push(r);
  }

  for (const [tz, group] of Object.entries(byTz)) {
    const template = qualityAlertEmail(h1Pairs, m15Pairs, h1Time, m15Time, tz);
    await sendBulk(group, template);
  }
  console.log(`[QUALITY-ALERTS] Sent to ${recipients.length} users — H1:${h1Pairs.length} M15:${m15Pairs.length}`);
  return { sent: recipients.length, h1: h1Pairs.length, m15: m15Pairs.length };
}

module.exports = { sendQualityAlerts };
