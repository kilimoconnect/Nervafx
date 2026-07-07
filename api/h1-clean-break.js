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
const DAY_MS = 24 * H1_MS;

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const days = Math.min(30, parseInt(req.query?.days || '1', 10) || 1);
    const qFrom = req.query?.from;
    const qTo = req.query?.to;
    const until = qTo ? new Date(qTo + 'T23:59:59Z').toISOString() : new Date().toISOString();
    const since = qFrom ? new Date(qFrom + 'T00:00:00Z').toISOString()
      : new Date(Date.now() - days * DAY_MS).toISOString();

    // Fetch a small extra buffer for the "previous H1" comparison at the range start
    const h1FetchSince = new Date(new Date(since).getTime() - 2 * H1_MS).toISOString();
    const m15FetchSince = new Date(new Date(since).getTime() - H1_MS).toISOString();

    const PAGE = 1000;
    const h1Cache = {};
    const m15Cache = {};

    // H1 candles per pair
    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const allData = [];
        let off = 0;
        while (true) {
          const { data, error } = await sb
            .from('backtest_candles')
            .select('time, open, high, low, close')
            .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true)
            .gte('time', h1FetchSince).lte('time', until)
            .order('time', { ascending: true })
            .range(off, off + PAGE - 1);
          if (error) throw error;
          if (!data || !data.length) break;
          allData.push(...data);
          if (data.length < PAGE) break;
          off += PAGE;
        }
        return { inst, data: allData };
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

    // M15 candles per pair
    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const allData = [];
        let off = 0;
        while (true) {
          const { data, error } = await sb
            .from('backtest_candles')
            .select('time, open, high, low, close')
            .eq('instrument', inst).eq('timeframe', 'M15')
            .gte('time', m15FetchSince).lte('time', until)
            .order('time', { ascending: true })
            .range(off, off + PAGE - 1);
          if (error) throw error;
          if (!data || !data.length) break;
          allData.push(...data);
          if (data.length < PAGE) break;
          off += PAGE;
        }
        return { inst, data: allData };
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

    const sinceMs = new Date(since).getTime();
    const untilMs = new Date(until).getTime();

    // Bucket signals per H1 timestamp
    const byTime = new Map();

    for (const inst of VALID_PAIRS) {
      const h1s = h1Cache[inst] || [];
      if (h1s.length < 2) continue;
      const m15s = m15Cache[inst] || [];

      // Group M15 candles by H1 bucket ISO for fast lookup
      const m15ByHour = new Map();
      for (const c of m15s) {
        const t = new Date(c.time).getTime();
        const bucketMs = Math.floor(t / H1_MS) * H1_MS;
        const key = new Date(bucketMs).toISOString();
        let arr = m15ByHour.get(key);
        if (!arr) { arr = []; m15ByHour.set(key, arr); }
        arr.push(c);
      }

      const pd = pipDiv(inst);

      for (let i = 1; i < h1s.length; i++) {
        const target = h1s[i];
        const targetMs = new Date(target.time).getTime();
        if (targetMs < sinceMs || targetMs > untilMs) continue;

        const prev = h1s[i - 1];
        let direction = null;
        let breakLevel = null;
        if (target.close > prev.high) { direction = 'BUY'; breakLevel = prev.high; }
        else if (target.close < prev.low) { direction = 'SELL'; breakLevel = prev.low; }
        else continue;

        const inner = m15ByHour.get(target.time);
        if (!inner || inner.length !== 4) continue;

        const aligned = inner.every(c =>
          direction === 'BUY' ? c.close > c.open : c.close < c.open
        );
        if (!aligned) continue;

        const range = target.high - target.low;
        const body = Math.abs(target.close - target.open);

        const signal = {
          pair: inst.replace('_', '/'),
          instrument: inst,
          direction,
          breakLevel: Math.round(breakLevel / pd) * pd,
          h1: {
            open: target.open, high: target.high, low: target.low, close: target.close,
            rangePips: Math.round((range / pd) * 10) / 10,
            bodyPips: Math.round((body / pd) * 10) / 10,
            bodyPct: range > 0 ? Math.round((body / range) * 100) : 0,
          },
          m15: inner.map(c => ({
            time: c.time,
            open: c.open, high: c.high, low: c.low, close: c.close,
            bull: c.close > c.open,
            bodyPips: Math.round((Math.abs(c.close - c.open) / pd) * 10) / 10,
          })),
        };

        let bucket = byTime.get(target.time);
        if (!bucket) { bucket = []; byTime.set(target.time, bucket); }
        bucket.push(signal);
      }
    }

    // Order signals within each bucket: BUY first, then SELL, then by body size desc
    const rows = [];
    for (const [time, signals] of byTime.entries()) {
      signals.sort((a, b) => {
        if (a.direction !== b.direction) return a.direction === 'BUY' ? -1 : 1;
        return b.h1.bodyPips - a.h1.bodyPips;
      });
      const buyCount = signals.filter(s => s.direction === 'BUY').length;
      const sellCount = signals.length - buyCount;
      rows.push({ time, buyCount, sellCount, signals });
    }

    // Newest first
    rows.sort((a, b) => (a.time < b.time ? 1 : -1));

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
