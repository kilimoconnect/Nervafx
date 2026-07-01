'use strict';

const { createClient } = require('@supabase/supabase-js');
const { sendBulk, pairImbalanceEmail } = require('../src/emailService');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const VALID_PAIRS = new Set([
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
]);

const NY_CLOSE_UTC = 21;

function forexDayKey(iso) {
  const d = new Date(iso);
  if (d.getUTCHours() >= NY_CLOSE_UTC) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function prevTradingDay(dayKey) {
  const d = new Date(dayKey + 'T12:00:00Z');
  const dow = d.getUTCDay();
  if (dow === 1) d.setUTCDate(d.getUTCDate() - 3);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  else d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
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
    // Get latest hour of currency_strength data
    const { data: latest } = await sb
      .from('currency_strength')
      .select('time')
      .order('time', { ascending: false })
      .limit(1);

    if (!latest?.length) return res.json({ ok: true, sent: 0, reason: 'no data' });

    const latestTime = latest[0].time;

    const { data: rows, error } = await sb
      .from('currency_strength')
      .select('currency, smooth_3h, smooth_4h, smooth_6h')
      .eq('time', latestTime);

    if (error) throw error;
    if (!rows || rows.length < 8) return res.json({ ok: true, sent: 0, reason: 'incomplete data' });

    const ccyData = {};
    for (const r of rows) {
      ccyData[r.currency] = {
        s3: (parseFloat(r.smooth_3h) || 0) * 10000,
        s4: (parseFloat(r.smooth_4h) || 0) * 10000,
        s6: (parseFloat(r.smooth_6h) || 0) * 10000,
      };
    }

    // Find strongest and weakest per TF, require alignment on all 3
    const tfs = ['s3', 's4', 's6'];
    const tfResults = tfs.map(tf => {
      let best = null, worst = null;
      for (const ccy of CURRENCIES) {
        const v = ccyData[ccy]?.[tf] || 0;
        if (!best || v > best.v) best = { cur: ccy, v };
        if (!worst || v < worst.v) worst = { cur: ccy, v };
      }
      return { best, worst };
    });

    const strongest = tfResults[0].best.cur;
    const weakest = tfResults[0].worst.cur;
    if (strongest === weakest) return res.json({ ok: true, sent: 0, reason: 'no imbalance' });

    const aligned = tfResults.every(r => r.best.cur === strongest && r.worst.cur === weakest);
    if (!aligned) return res.json({ ok: true, sent: 0, reason: 'not aligned across 3H+4H+6H' });

    // Build pair
    const fwd = strongest + '_' + weakest;
    const rev = weakest + '_' + strongest;
    let pair, direction, instrument;
    if (VALID_PAIRS.has(fwd)) {
      pair = strongest + '/' + weakest;
      direction = 'BUY';
      instrument = fwd;
    } else if (VALID_PAIRS.has(rev)) {
      pair = weakest + '/' + strongest;
      direction = 'SELL';
      instrument = rev;
    } else {
      return res.json({ ok: true, sent: 0, reason: 'no valid pair' });
    }

    // Check previous day break
    const fxDay = forexDayKey(latestTime);
    const prevDay = prevTradingDay(fxDay);
    let h1Break = false;

    const { data: candles } = await sb
      .from('backtest_candles')
      .select('time, open, high, low, close')
      .eq('instrument', instrument)
      .eq('timeframe', 'H1')
      .eq('complete', true)
      .gte('time', new Date(new Date(latestTime).getTime() - 5 * 86400000).toISOString())
      .lte('time', latestTime)
      .order('time', { ascending: true })
      .limit(500);

    if (candles?.length) {
      const byDay = {};
      let currentPrice = null;
      for (const c of candles) {
        const o = parseFloat(c.open), h = parseFloat(c.high), l = parseFloat(c.low), cl = parseFloat(c.close);
        const day = forexDayKey(c.time);
        if (!byDay[day]) byDay[day] = { open: o, high: h, low: l, close: cl };
        else {
          if (h > byDay[day].high) byDay[day].high = h;
          if (l < byDay[day].low) byDay[day].low = l;
          byDay[day].close = cl;
        }
        if (c.time === latestTime) currentPrice = cl;
      }
      const prevOHLC = byDay[prevDay];
      if (prevOHLC && currentPrice) {
        if (direction === 'BUY' && currentPrice > prevOHLC.high) h1Break = true;
        else if (direction === 'SELL' && currentPrice < prevOHLC.low) h1Break = true;
      }
    }

    const signal = {
      pair,
      direction,
      strongest,
      weakest,
      strongVal: ccyData[strongest],
      weakVal: ccyData[weakest],
      spread: {
        s3: Math.round((ccyData[strongest].s3 - ccyData[weakest].s3) * 100) / 100,
        s4: Math.round((ccyData[strongest].s4 - ccyData[weakest].s4) * 100) / 100,
        s6: Math.round((ccyData[strongest].s6 - ccyData[weakest].s6) * 100) / 100,
      },
      h1Break,
    };

    const template = pairImbalanceEmail([signal]);
    if (!template) return res.json({ ok: true, sent: 0, reason: 'template empty' });

    const users = await getSubscribedUsers(sb);
    if (!users.length) return res.json({ ok: true, sent: 0, reason: 'no subscribed users' });

    const recipients = users.map(u => ({ email: u.email, name: u.firstName }));
    await sendBulk(recipients, template);

    return res.json({ ok: true, sent: users.length, pair, direction });

  } catch (e) {
    console.error('[cron-pair-imbalance-alerts]', e);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 30;
