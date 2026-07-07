'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

const VALID_PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];

function isJpy(inst) { return inst.includes('JPY'); }
function pipDiv(inst) { return isJpy(inst) ? 0.01 : 0.0001; }

const H1_MS = 3600000;
const M15_MS = 15 * 60000;

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const now = new Date();

    // Historical replay: ?date=YYYY-MM-DD&hour=HH selects a specific H1 to score.
    // Live mode: use the latest complete H1 available.
    const qDate = req.query?.date;
    const qHour = req.query?.hour;
    let anchor = null;
    if (qDate && qHour !== undefined && qHour !== '') {
      const hh = String(parseInt(qHour, 10)).padStart(2, '0');
      const parsed = new Date(qDate + 'T' + hh + ':00:00Z');
      if (!isNaN(parsed.getTime())) anchor = parsed;
    }

    // Fetch enough H1 history to get the target H1 + its previous
    const fetchUntil = anchor
      ? new Date(anchor.getTime() + H1_MS).toISOString()
      : now.toISOString();
    const fetchSince = new Date(
      (anchor ? anchor.getTime() : now.getTime()) - 4 * 24 * 3600000
    ).toISOString();

    const PAGE = 1000;
    const h1Cache = {};
    const m15Cache = {};

    // H1 candles per pair — last few complete ones
    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const { data, error } = await sb
          .from('backtest_candles')
          .select('time, open, high, low, close')
          .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true)
          .gte('time', fetchSince).lte('time', fetchUntil)
          .order('time', { ascending: true })
          .limit(PAGE);
        return { inst, data: error ? [] : data || [] };
      }));
      for (const { inst, data } of results) {
        h1Cache[inst] = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
      }
    }

    // M15 candles per pair — narrow window around the target H1
    const m15Since = new Date(
      (anchor ? anchor.getTime() : now.getTime()) - 2 * 3600000
    ).toISOString();
    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const { data, error } = await sb
          .from('backtest_candles')
          .select('time, open, high, low, close')
          .eq('instrument', inst).eq('timeframe', 'M15')
          .gte('time', m15Since).lte('time', fetchUntil)
          .order('time', { ascending: true })
          .limit(PAGE);
        return { inst, data: error ? [] : data || [] };
      }));
      for (const { inst, data } of results) {
        m15Cache[inst] = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
      }
    }

    const signals = [];
    let targetH1Time = null;

    for (const inst of VALID_PAIRS) {
      const h1s = h1Cache[inst] || [];
      if (h1s.length < 2) continue;

      // Pick the target H1: anchor bucket if provided, else latest complete
      let targetIdx = -1;
      if (anchor) {
        const anchorISO = anchor.toISOString();
        for (let i = h1s.length - 1; i >= 0; i--) {
          if (h1s[i].time === anchorISO) { targetIdx = i; break; }
        }
        if (targetIdx < 1) continue;
      } else {
        targetIdx = h1s.length - 1;
      }
      const target = h1s[targetIdx];
      const prev = h1s[targetIdx - 1];
      if (!prev) continue;

      // Break-of-structure check
      let direction = null;
      let breakLevel = null;
      if (target.close > prev.high) { direction = 'BUY'; breakLevel = prev.high; }
      else if (target.close < prev.low) { direction = 'SELL'; breakLevel = prev.low; }
      else continue;

      // Collect the 4 M15 candles inside the target H1
      const targetMs = new Date(target.time).getTime();
      const m15s = (m15Cache[inst] || []).filter(c => {
        const t = new Date(c.time).getTime();
        return t >= targetMs && t < targetMs + H1_MS;
      });
      if (m15s.length !== 4) continue;

      // All 4 M15 candles must be aligned with the direction
      const aligned = m15s.every(c =>
        direction === 'BUY' ? c.close > c.open : c.close < c.open
      );
      if (!aligned) continue;

      const pd = pipDiv(inst);
      const range = target.high - target.low;
      const body = Math.abs(target.close - target.open);

      signals.push({
        pair: inst.replace('_', '/'),
        instrument: inst,
        direction,
        h1Time: target.time,
        breakLevel: Math.round(breakLevel / pd) * pd,
        prev: {
          time: prev.time,
          open: prev.open, high: prev.high, low: prev.low, close: prev.close,
        },
        h1: {
          open: target.open, high: target.high, low: target.low, close: target.close,
          rangePips: Math.round((range / pd) * 10) / 10,
          bodyPips: Math.round((body / pd) * 10) / 10,
          bodyPct: range > 0 ? Math.round((body / range) * 100) : 0,
        },
        m15: m15s.map(c => ({
          time: c.time,
          open: c.open, high: c.high, low: c.low, close: c.close,
          bull: c.close > c.open,
          bodyPips: Math.round((Math.abs(c.close - c.open) / pd) * 10) / 10,
        })),
      });

      if (!targetH1Time) targetH1Time = target.time;
    }

    // Sort BUY first, then SELL, then by body size descending
    signals.sort((a, b) => {
      if (a.direction !== b.direction) return a.direction === 'BUY' ? -1 : 1;
      return b.h1.bodyPips - a.h1.bodyPips;
    });

    res.json({
      h1Time: targetH1Time,
      buyCount: signals.filter(s => s.direction === 'BUY').length,
      sellCount: signals.filter(s => s.direction === 'SELL').length,
      signals,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
