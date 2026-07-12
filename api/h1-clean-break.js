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

      // Group M15 candles by H1 bucket start (ms) for fast lookup
      const m15ByHour = new Map();
      for (const c of m15s) {
        const t = new Date(c.time).getTime();
        const bucketMs = Math.floor(t / H1_MS) * H1_MS;
        let arr = m15ByHour.get(bucketMs);
        if (!arr) { arr = []; m15ByHour.set(bucketMs, arr); }
        arr.push(c);
      }

      const pd = pipDiv(inst);
      const LOOKAHEAD_H1S = 4;

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

        const inner = m15ByHour.get(targetMs);
        if (!inner || inner.length !== 4) continue;

        // Data-driven relaxation from strict "all 4 aligned" to "at least 3 of 4".
        // On the USD/JPY +92p Asian rally 5 Jul 22:00 → 6 Jul 07:00 UTC, the
        // 4-of-4 rule caught zero H1s — every big candle had a single tiny
        // opposite-direction M15. 3-of-4 catches 4 H1s during the same move
        // including the +27.8p body at 01:00 UTC.
        const alignedCount = inner.reduce((n, c) => {
          const aligned = direction === 'BUY' ? c.close > c.open : c.close < c.open;
          return n + (aligned ? 1 : 0);
        }, 0);
        if (alignedCount < 3) continue;
        const alignmentStrength = alignedCount; // 3 or 4

        const range = target.high - target.low;
        const body = Math.abs(target.close - target.open);

        // Follow-through outcome — next 4 H1s' final close vs signal close
        const future = h1s.slice(i + 1, i + 1 + LOOKAHEAD_H1S);
        let outcome = null;
        if (future.length === LOOKAHEAD_H1S) {
          const finalClose = future[future.length - 1].close;
          const rawMove = direction === 'BUY'
            ? finalClose - target.close
            : target.close - finalClose;
          const pipMove = rawMove / pd;
          outcome = {
            pips: Math.round(pipMove * 10) / 10,
            win: pipMove > 0,
          };
        }

        const signal = {
          pair: inst.replace('_', '/'),
          instrument: inst,
          direction,
          breakLevel: Math.round(breakLevel / pd) * pd,
          alignedM15: alignmentStrength, // 3 or 4 M15s aligned inside the break H1
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
          outcome,
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

    // Per-pair performance ranking across the range
    const statsByPair = new Map();
    for (const row of rows) {
      for (const s of row.signals) {
        let st = statsByPair.get(s.pair);
        if (!st) {
          st = { pair: s.pair, total: 0, settled: 0, wins: 0, pips: 0, pending: 0, buy: 0, sell: 0 };
          statsByPair.set(s.pair, st);
        }
        st.total++;
        if (s.direction === 'BUY') st.buy++; else st.sell++;
        if (s.outcome) {
          st.settled++;
          st.pips += s.outcome.pips;
          if (s.outcome.win) st.wins++;
        } else {
          st.pending++;
        }
      }
    }
    const pairRanking = Array.from(statsByPair.values()).map(st => ({
      pair: st.pair,
      total: st.total,
      settled: st.settled,
      pending: st.pending,
      buy: st.buy,
      sell: st.sell,
      wins: st.wins,
      losses: st.settled - st.wins,
      hitRate: st.settled > 0 ? Math.round((st.wins / st.settled) * 100) : null,
      avgPips: st.settled > 0 ? Math.round((st.pips / st.settled) * 10) / 10 : 0,
      totalPips: Math.round(st.pips * 10) / 10,
    })).sort((a, b) => {
      // Settled pairs first (highest hit rate, then avg pips), pending-only pairs last
      if (a.hitRate == null && b.hitRate == null) return b.total - a.total;
      if (a.hitRate == null) return 1;
      if (b.hitRate == null) return -1;
      return b.hitRate - a.hitRate || b.avgPips - a.avgPips;
    });

    res.json({ rows, pairRanking });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
