'use strict';

const { createClient } = require('@supabase/supabase-js');
const { sendBulk, m15ImpulseEmail } = require('../src/emailService');

const INSTRUMENTS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];

const MIN_CONSECUTIVE = 2;
const MIN_BODY_RATIO = 0.70;

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function pipSize(inst) {
  return inst.includes('JPY') ? 0.01 : 0.0001;
}

function fmtTime(iso) {
  return iso.slice(11, 16);
}

function findSwingHighs(candles, endIdx) {
  const highs = [];
  for (let i = 1; i < endIdx && i < candles.length - 1; i++) {
    if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i + 1].high) {
      highs.push(candles[i].high);
    }
  }
  return highs;
}

function findSwingLows(candles, endIdx) {
  const lows = [];
  for (let i = 1; i < endIdx && i < candles.length - 1; i++) {
    if (candles[i].low < candles[i - 1].low && candles[i].low < candles[i + 1].low) {
      lows.push(candles[i].low);
    }
  }
  return lows;
}

function detectImpulse(candles) {
  if (candles.length < MIN_CONSECUTIVE) return null;

  const last = candles[candles.length - 1];
  const dir = last.close > last.open ? 'BUY' : last.close < last.open ? 'SELL' : null;
  if (!dir) return null;

  let inDir = 0;
  let bodyRatioSum = 0;
  let counterRun = 0;
  let startIdx = candles.length;

  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    const range = c.high - c.low;
    if (range <= 0) continue;
    const body = Math.abs(c.close - c.open);
    const bodyRatio = body / range;
    const candleDir = c.close > c.open ? 'BUY' : c.close < c.open ? 'SELL' : null;

    if (candleDir === dir) {
      counterRun = 0;
      inDir++;
      bodyRatioSum += bodyRatio;
      startIdx = i;
    } else {
      counterRun++;
      if (counterRun >= 2) break;
    }
  }

  if (inDir < MIN_CONSECUTIVE) return null;

  const avgBodyRatio = bodyRatioSum / inDir;
  if (avgBodyRatio < MIN_BODY_RATIO) return null;

  const startCandle = candles[startIdx];
  const endCandle = candles[candles.length - 1];
  const moveRaw = dir === 'BUY'
    ? endCandle.close - startCandle.open
    : startCandle.open - endCandle.close;

  return {
    direction: dir,
    count: inDir,
    avgBodyPct: Math.round(avgBodyRatio * 100),
    moveRaw,
    closePrice: endCandle.close,
    startIdx,
    startTime: fmtTime(startCandle.time),
    endTimeFmt: fmtTime(endCandle.time),
  };
}

async function getSubscribedUsers(sb) {
  const { data: users } = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (!users?.users) return [];

  const { data: prefs } = await sb
    .from('email_preferences')
    .select('user_id, signal_alerts, unsubscribed, notification_email');

  const prefMap = {};
  for (const p of prefs || []) prefMap[p.user_id] = p;

  return users.users.filter(u => {
    const p = prefMap[u.id];
    if (p?.unsubscribed) return false;
    if (p?.signal_alerts === false) return false;
    return true;
  }).map(u => ({
    email: prefMap[u.id]?.notification_email || u.email,
    firstName: u.user_metadata?.first_name || '',
    id: u.id,
  }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  const isCron = process.env.CRON_SECRET && auth === process.env.CRON_SECRET;
  if (!isCron && req.query?.force !== '1') {
    return res.status(403).json({ error: 'Cron only' });
  }

  const sb = getDB();

  try {
    // Fetch extra lookback for swing detection
    const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const recentSince = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const signals = [];

    for (let b = 0; b < INSTRUMENTS.length; b += 7) {
      const batch = INSTRUMENTS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const { data, error } = await sb
          .from('backtest_candles')
          .select('time, open, high, low, close')
          .eq('instrument', inst).eq('timeframe', 'M15').eq('complete', true)
          .gte('time', since).order('time', { ascending: true }).limit(100);
        return { inst, data: error ? [] : data || [] };
      }));

      for (const { inst, data } of results) {
        if (!data.length) continue;

        const candles = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));

        // Only check if most recent candles form an impulse
        const recentCandles = candles.filter(c => c.time >= recentSince);
        if (recentCandles.length < MIN_CONSECUTIVE) continue;

        const impulse = detectImpulse(candles);
        if (!impulse) continue;

        // Check M15 swing break
        let breakLevel = null;
        if (impulse.direction === 'BUY') {
          const swingHighs = findSwingHighs(candles, impulse.startIdx);
          if (!swingHighs.length) continue;
          const lastHH = swingHighs[swingHighs.length - 1];
          if (impulse.closePrice > lastHH) breakLevel = lastHH;
        } else {
          const swingLows = findSwingLows(candles, impulse.startIdx);
          if (!swingLows.length) continue;
          const lastLL = swingLows[swingLows.length - 1];
          if (impulse.closePrice < lastLL) breakLevel = lastLL;
        }
        if (breakLevel === null) continue;

        const pip = pipSize(inst);
        signals.push({
          pair: inst.replace('_', '/'),
          direction: impulse.direction,
          count: impulse.count,
          avgBodyPct: impulse.avgBodyPct,
          movePips: impulse.moveRaw / pip,
          startTime: impulse.startTime,
          endTime: impulse.endTimeFmt,
          breakLevel,
        });
      }
    }

    if (!signals.length) {
      return res.json({ ok: true, sent: 0, reason: 'no impulses with swing break detected' });
    }

    signals.sort((a, b) => b.count - a.count || b.movePips - a.movePips);
    const top = signals.slice(0, 5);

    const template = m15ImpulseEmail(top);
    if (!template) return res.json({ ok: true, sent: 0, reason: 'template empty' });

    const users = await getSubscribedUsers(sb);
    if (!users.length) return res.json({ ok: true, sent: 0, reason: 'no subscribed users' });

    const recipients = users.map(u => ({ email: u.email, name: u.firstName }));
    await sendBulk(recipients, template);

    return res.json({ ok: true, sent: users.length, signals: top.map(s => `${s.pair} ${s.direction} ${s.count}×`) });

  } catch (e) {
    console.error('[cron-m15-impulse-alerts]', e);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 30;
