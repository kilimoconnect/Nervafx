'use strict';

const { sendBulk, h1BreaksEmail } = require('./emailService');

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

const LOOKBACK = 10;
const NY_CLOSE_UTC = 21;

function forexDayKey(iso) {
  const d = new Date(iso);
  if (d.getUTCHours() >= NY_CLOSE_UTC) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function scoreBreak(c, prior, direction) {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range === 0) return 0;

  const bodyRatio = body / range;
  let wickAgainst;
  if (direction === 'BUY') {
    wickAgainst = (c.high - c.close) / range;
  } else {
    wickAgainst = (c.close - c.low) / range;
  }

  const level = direction === 'BUY'
    ? Math.max(...prior.map(x => x.high))
    : Math.min(...prior.map(x => x.low));
  const breakDist = direction === 'BUY'
    ? (c.close - level) / level
    : (level - c.close) / level;
  const distScore = Math.min(1, breakDist * 1000);

  const bullish = c.close > c.open;
  const impulse = (direction === 'BUY' && bullish) || (direction === 'SELL' && !bullish) ? 1 : 0.3;

  return Math.round(bodyRatio * 40 + (1 - wickAgainst) * 30 + distScore * 20 + impulse * 10);
}

async function checkH1BreaksAlerts(sb) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) { console.log('[H1-BREAKS] No BREVO_API_KEY — skipping'); return { sent: 0 }; }

  const fetchSince = new Date(Date.now() - (LOOKBACK + 2) * 3600000).toISOString();

  const candlesByInst = {};
  for (let b = 0; b < INSTRUMENTS.length; b += 7) {
    const batch = INSTRUMENTS.slice(b, b + 7);
    const results = await Promise.all(batch.map(async (inst) => {
      const { data, error } = await sb
        .from('backtest_candles')
        .select('time, open, high, low, close')
        .eq('instrument', inst)
        .eq('timeframe', 'H1')
        .eq('complete', true)
        .gte('time', fetchSince)
        .order('time', { ascending: true })
        .limit(50);
      if (error) throw error;
      return { inst, data: data || [] };
    }));
    for (const { inst, data } of results) {
      candlesByInst[inst] = data.map(c => ({
        time: c.time,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
      }));
    }
  }

  // Find the latest shared timestamp
  const timeSets = INSTRUMENTS.map(inst => new Set((candlesByInst[inst] || []).map(c => c.time)));
  const allTimes = [...timeSets[0]].filter(t => timeSets.every(s => s.has(t))).sort();
  if (!allTimes.length) return { sent: 0, reason: 'no data' };

  const latestTime = allTimes[allTimes.length - 1];

  // Check dedup
  const { data: lastSent } = await sb
    .from('h1_breaks_email_log')
    .select('signal_time')
    .order('created_at', { ascending: false })
    .limit(1);

  if (lastSent?.[0]?.signal_time === latestTime) {
    console.log('[H1-BREAKS] Already sent for', latestTime);
    return { sent: 0, reason: 'already sent' };
  }

  // Build index
  const indexByInst = {};
  for (const inst of INSTRUMENTS) {
    const candles = candlesByInst[inst] || [];
    const timeToIdx = {};
    for (let i = 0; i < candles.length; i++) timeToIdx[candles[i].time] = i;
    indexByInst[inst] = { candles, timeToIdx };
  }

  // Track first breaks for the forex day
  const fxDay = forexDayKey(latestTime);
  const seenBreak = {};
  for (const time of allTimes) {
    if (forexDayKey(time) !== fxDay) continue;
    for (const inst of INSTRUMENTS) {
      const { candles, timeToIdx } = indexByInst[inst];
      const idx = timeToIdx[time];
      if (idx === undefined || idx < LOOKBACK) continue;

      const current = candles[idx];
      const prior = candles.slice(idx - LOOKBACK, idx);
      if (prior.length < LOOKBACK) continue;

      const highestHigh = Math.max(...prior.map(c => c.high));
      const lowestLow = Math.min(...prior.map(c => c.low));

      let direction = null;
      if (current.close > highestHigh) direction = 'BUY';
      else if (current.close < lowestLow) direction = 'SELL';
      if (!direction) continue;

      const key = inst + '|' + direction;
      if (!seenBreak[key]) seenBreak[key] = time;
    }
  }

  // Detect breaks at the latest timestamp
  const breaks = [];
  for (const inst of INSTRUMENTS) {
    const { candles, timeToIdx } = indexByInst[inst];
    const idx = timeToIdx[latestTime];
    if (idx === undefined || idx < LOOKBACK) continue;

    const current = candles[idx];
    const prior = candles.slice(idx - LOOKBACK, idx);
    if (prior.length < LOOKBACK) continue;

    const highestHigh = Math.max(...prior.map(c => c.high));
    const lowestLow = Math.min(...prior.map(c => c.low));

    let direction = null;
    if (current.close > highestHigh) direction = 'BUY';
    else if (current.close < lowestLow) direction = 'SELL';
    if (!direction) continue;

    // Momentum: 2+ candles in lookback closing past previous candle
    let momentum = 0;
    for (let p = 1; p < prior.length; p++) {
      if (direction === 'BUY' && prior[p].close > prior[p - 1].high) momentum++;
      if (direction === 'SELL' && prior[p].close < prior[p - 1].low) momentum++;
    }
    if (momentum < 2) continue;

    // Wick filter
    const upperWick = current.high - Math.max(current.open, current.close);
    const lowerWick = Math.min(current.open, current.close) - current.low;
    if (direction === 'BUY' && upperWick > lowerWick) continue;
    if (direction === 'SELL' && lowerWick > upperWick) continue;

    const score = scoreBreak(current, prior, direction);
    const level = direction === 'BUY' ? highestHigh : lowestLow;
    const body = Math.abs(current.close - current.open);
    const range = current.high - current.low;
    const wickPct = range > 0 ? Math.round((1 - body / range) * 100) : 100;

    const key = inst + '|' + direction;
    const isFirst = seenBreak[key] === latestTime;

    breaks.push({
      pair: inst.replace('_', '/'),
      direction,
      score,
      level,
      close: current.close,
      wickPct,
      _first: isFirst,
    });
  }

  if (!breaks.length) {
    console.log('[H1-BREAKS] No breaks at', latestTime);
    return { sent: 0, reason: 'no breaks' };
  }

  // Filter score 70+
  const qualified = breaks.filter(b => b.score >= 70);
  if (!qualified.length) {
    console.log('[H1-BREAKS] No breaks scoring 70+ at', latestTime);
    return { sent: 0, reason: 'no qualifying breaks' };
  }

  qualified.sort((a, b) => b.score - a.score);
  const top5 = qualified.slice(0, 5);

  // Get subscribers
  const { data: authUsers } = await sb.auth.admin.listUsers({ perPage: 1000 });
  const { data: prefs } = await sb
    .from('email_preferences')
    .select('user_id, signal_alerts, unsubscribed, notification_email');
  const prefMap = {};
  for (const p of prefs || []) prefMap[p.user_id] = p;

  const users = (authUsers?.users || []).filter(u => {
    const p = prefMap[u.id];
    if (p?.unsubscribed) return false;
    if (p?.signal_alerts === false) return false;
    return true;
  }).map(u => ({
    email: prefMap[u.id]?.notification_email || u.email,
    name: u.user_metadata?.first_name || '',
  }));

  if (!users.length) return { sent: 0, reason: 'no subscribers' };

  const template = h1BreaksEmail({ time: latestTime, breaks: top5, totalBreaks: breaks.length });
  await sendBulk(users, template);

  await sb.from('h1_breaks_email_log').insert({
    signal_time: latestTime,
    breaks_count: top5.length,
    emails_sent: users.length,
  }).catch(() => {});

  console.log(`[H1-BREAKS] Sent ${users.length} emails for ${top5.length} breaks at ${latestTime}`);
  return { sent: users.length, time: latestTime, breaks: top5.length };
}

module.exports = { checkH1BreaksAlerts };
