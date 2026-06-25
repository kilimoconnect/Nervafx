'use strict';

const { sendBulk, audnzdSignalEmail, audnzdDirectionChangeEmail } = require('./emailService');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
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
const PAIR_MAP = {
  AUD: { USD: 'AUD_USD', EUR: 'EUR_AUD', GBP: 'GBP_AUD', JPY: 'AUD_JPY', CHF: 'AUD_CHF', CAD: 'AUD_CAD', NZD: 'AUD_NZD' },
  NZD: { USD: 'NZD_USD', EUR: 'EUR_NZD', GBP: 'GBP_NZD', JPY: 'NZD_JPY', CHF: 'NZD_CHF', CAD: 'NZD_CAD', AUD: 'AUD_NZD' },
};
const BASE_OF = {
  AUD_USD: 'AUD', EUR_AUD: 'EUR', GBP_AUD: 'GBP', AUD_JPY: 'AUD', AUD_CHF: 'AUD', AUD_CAD: 'AUD', AUD_NZD: 'AUD',
  NZD_USD: 'NZD', EUR_NZD: 'EUR', GBP_NZD: 'GBP', NZD_JPY: 'NZD', NZD_CHF: 'NZD', NZD_CAD: 'NZD',
};

const LOOKBACK = 10;
const THRESHOLD = 0.015;

function computeQuality(candles) {
  if (candles.length < 10) return null;
  const c = candles.slice(-10);
  const bullCandles = c.filter(x => x.close > x.open).length;
  const bearCandles = c.filter(x => x.close < x.open).length;
  const directionScore = ((bullCandles - bearCandles) / 10) * 100;
  const netMove = Math.abs(c[9].close - c[0].open);
  const totalRange = c.reduce((s, x) => s + (x.high - x.low), 0);
  const impulseStrength = totalRange > 0 ? (netMove / totalRange) * 100 : 0;
  const totalWick = c.reduce((s, x) => {
    const body = Math.abs(x.close - x.open);
    return s + (x.high - x.low - body);
  }, 0);
  const wickCleanliness = totalRange > 0 ? 100 - (totalWick / totalRange) * 100 : 0;
  return Math.round(0.15 * Math.abs(directionScore) + 0.80 * impulseStrength + 0.05 * wickCleanliness);
}

function bestTrades(ccy, signal, ranked, ohlcByInst, time) {
  const others = ranked.filter(r => r.currency !== ccy && r.currency !== (ccy === 'AUD' ? 'NZD' : 'AUD'));
  const targets = signal === 'STRONGEST' ? others.slice(-3).reverse() : others.slice(0, 3);
  return targets.map(t => {
    const pair = PAIR_MAP[ccy][t.currency];
    const isBase = BASE_OF[pair] === ccy;
    const direction = signal === 'STRONGEST' ? (isBase ? 'BUY' : 'SELL') : (isBase ? 'SELL' : 'BUY');
    let score = null;
    const instData = ohlcByInst[pair];
    if (instData) {
      const idx = instData.timeToIdx[time];
      if (idx !== undefined && idx >= 9) {
        score = computeQuality(instData.candles.slice(idx - 9, idx + 1));
      }
    }
    return { pair: pair.replace('_', '/'), direction, vs: t.currency, vsRank: ranked.indexOf(t) + 1, score };
  });
}

async function checkAudNzdAlerts(sb) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) { console.log('[AUDNZD-ALERTS] No BREVO_API_KEY — skipping'); return { sent: 0 }; }

  // Fetch last 15 M15 candles for all instruments (need 10 for lookback + a few extra)
  const fetchSince = new Date(Date.now() - 20 * 15 * 60 * 1000).toISOString();
  const ohlcByInst = {};

  for (let b = 0; b < INSTRUMENTS.length; b += 7) {
    const batch = INSTRUMENTS.slice(b, b + 7);
    const results = await Promise.all(batch.map(async (inst) => {
      const { data, error } = await sb
        .from('backtest_candles')
        .select('time, open, high, low, close')
        .eq('instrument', inst)
        .eq('timeframe', 'M15')
        .eq('complete', true)
        .gte('time', fetchSince)
        .order('time', { ascending: true })
        .limit(20);
      if (error) throw error;
      return { inst, data: data || [] };
    }));
    for (const { inst, data } of results) {
      const candles = data.map(c => ({
        time: c.time,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
      }));
      const timeToIdx = {};
      for (let i = 0; i < candles.length; i++) timeToIdx[candles[i].time] = i;
      ohlcByInst[inst] = { candles, timeToIdx };
    }
  }

  // Find the latest M15 timestamp all instruments share
  const allTimes = new Set();
  for (const inst of INSTRUMENTS) {
    const candles = ohlcByInst[inst]?.candles || [];
    for (const c of candles) allTimes.add(c.time);
  }
  const sorted = [...allTimes].sort();
  if (!sorted.length) { console.log('[AUDNZD-ALERTS] No M15 data'); return { sent: 0 }; }

  // Compute strength for the last 2 timestamps (current + previous for direction change)
  const recentTimes = sorted.slice(-2);
  const snapshots = [];

  for (const time of recentTimes) {
    const strength = {};
    for (const ccy of CURRENCIES) strength[ccy] = 0;
    let valid = true;

    for (const inst of INSTRUMENTS) {
      const { candles, timeToIdx } = ohlcByInst[inst];
      const idx = timeToIdx[time];
      if (idx === undefined || idx < LOOKBACK) { valid = false; break; }
      const [base, quote] = inst.split('_');
      const movement = (candles[idx].close - candles[idx - LOOKBACK].close) / candles[idx - LOOKBACK].close;
      strength[base] += movement;
      strength[quote] -= movement;
    }
    if (!valid) continue;

    const ranked = CURRENCIES
      .map(c => ({ currency: c, value: strength[c] }))
      .sort((a, b) => b.value - a.value);

    const audRank = ranked.findIndex(r => r.currency === 'AUD') + 1;
    const nzdRank = ranked.findIndex(r => r.currency === 'NZD') + 1;

    let audSignal = null, nzdSignal = null;
    if (audRank === 1 && strength.AUD > THRESHOLD) audSignal = 'STRONGEST';
    else if (audRank === 8 && strength.AUD < -THRESHOLD) audSignal = 'WEAKEST';
    if (nzdRank === 1 && strength.NZD > THRESHOLD) nzdSignal = 'STRONGEST';
    else if (nzdRank === 8 && strength.NZD < -THRESHOLD) nzdSignal = 'WEAKEST';

    // Same-direction filter
    let hide = false;
    if (audSignal === 'WEAKEST' && nzdRank <= 4) hide = true;
    if (audSignal === 'STRONGEST' && nzdRank >= 5) hide = true;
    if (nzdSignal === 'WEAKEST' && audRank <= 4) hide = true;
    if (nzdSignal === 'STRONGEST' && audRank >= 5) hide = true;
    if (audSignal && nzdSignal && audSignal !== nzdSignal) hide = true;

    snapshots.push({
      time, ranked, hide,
      aud: { rank: audRank, value: strength.AUD, signal: audSignal,
        trades: audSignal && !hide ? bestTrades('AUD', audSignal, ranked, ohlcByInst, time) : [] },
      nzd: { rank: nzdRank, value: strength.NZD, signal: nzdSignal,
        trades: nzdSignal && !hide ? bestTrades('NZD', nzdSignal, ranked, ohlcByInst, time) : [] },
    });
  }

  if (!snapshots.length) return { sent: 0 };

  const current = snapshots[snapshots.length - 1];
  const previous = snapshots.length > 1 ? snapshots[0] : null;

  // Check if we already sent for this timestamp
  const { data: lastSent } = await sb
    .from('audnzd_email_log')
    .select('signal_time')
    .order('created_at', { ascending: false })
    .limit(1);

  const lastSentTime = lastSent?.[0]?.signal_time;
  if (lastSentTime === current.time) {
    console.log('[AUDNZD-ALERTS] Already sent for', current.time);
    return { sent: 0, reason: 'already sent' };
  }

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

  let sent = 0;

  // 1. Direction change email
  if (previous && !current.hide) {
    const changes = [];
    for (const ccy of ['AUD', 'NZD']) {
      const key = ccy.toLowerCase();
      const prevSig = previous[key].signal;
      const currSig = current[key].signal;
      if (currSig && currSig !== prevSig) {
        changes.push({
          currency: ccy,
          from: prevSig || 'NEUTRAL',
          to: currSig,
          signal: current[key],
          time: current.time,
        });
      }
    }
    for (const change of changes) {
      const template = audnzdDirectionChangeEmail(change);
      await sendBulk(users, template);
      sent += users.length;
      console.log(`[AUDNZD-ALERTS] Direction change: ${change.currency} ${change.from} → ${change.to}`);
    }
  }

  // 2. Signal event email (when there's a valid signal and no direction change was sent)
  const hasSignal = !current.hide && (current.aud.signal || current.nzd.signal);
  if (hasSignal && sent === 0) {
    const template = audnzdSignalEmail({ ...current, ranking: current.ranked });
    await sendBulk(users, template);
    sent += users.length;
    console.log(`[AUDNZD-ALERTS] Signal: AUD=${current.aud.signal || 'none'} NZD=${current.nzd.signal || 'none'}`);
  }

  // Log to prevent duplicate sends
  if (sent > 0) {
    await sb.from('audnzd_email_log').insert({
      signal_time: current.time,
      aud_signal: current.aud.signal,
      nzd_signal: current.nzd.signal,
      emails_sent: sent,
    }).catch(() => {});
  }

  return { sent, time: current.time };
}

module.exports = { checkAudNzdAlerts };
