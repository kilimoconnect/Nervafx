'use strict';

/**
 * POST /api/backtest-engine
 *
 * Runs a live engine over a historical date range using the SAME code paths
 * production uses. Iterates the engine at its natural cadence (per-day for
 * Daily Continuation, per-4h for H4 Continuation, per-session for Session
 * Continuation, single-call for range engines like H1 Clean Break / Market
 * Imbalance) and aggregates every emitted signal.
 *
 * Body:
 *   {
 *     engine: 'daily-continuation' | 'h1-continuation' | 'session-continuation'
 *           | 'h1-clean-break'     | 'market-imbalance' | 'market-imbalance-m15',
 *     from:   'YYYY-MM-DD',
 *     to:     'YYYY-MM-DD',
 *     lookAheadHours?: number   // for signal outcome scoring (default 4)
 *   }
 *
 * Response:
 *   {
 *     engine, from, to, duration_sec,
 *     signals: [ { time, pair, direction, meta } ... ],
 *     stats: {
 *       total,
 *       byPair:      { PAIR: { total, buys, sells, wins, losses, avgPips, totalPips } },
 *       byHour:      { 0..23: { total, wins, losses } },
 *       byDow:       { 0..6:  { total, wins, losses } },
 *       byDirection: { BUY: n, SELL: n },
 *       winRate, avgPips, totalPips,
 *     },
 *   }
 */

const { createClient } = require('@supabase/supabase-js');
const { cors } = require('./_db');
const { requirePlan } = require('./_plan');

const dailyHandler   = require('./daily-continuation.js');
const h4Handler      = require('./h1-continuation.js');
const sessionHandler = require('./session-continuation.js');
const cleanBreak     = require('./h1-clean-break.js');
const imbalance      = require('./market-imbalance.js');
const imbalanceM15   = require('./market-imbalance-m15.js');

const SESSIONS = ['ASIA', 'LONDON', 'NY'];
const VALID_PAIRS_INSTR = new Set([
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
]);

function getServiceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function isJpy(inst) { return inst.includes('JPY'); }
function pipDiv(inst) { return isJpy(inst) ? 0.01 : 0.0001; }

// Invoke a live-engine handler internally with the _internal bypass.
async function invokeHandler(handler, query) {
  return await new Promise((resolve) => {
    const req = {
      method: 'GET',
      query: query || {},
      headers: {},
      _internal: true,
    };
    let payload = null;
    const res = {
      setHeader() {},
      status(code) { this._statusCode = code; return this; },
      json(data) { payload = data; resolve({ status: this._statusCode || 200, data }); return this; },
      end() { resolve({ status: this._statusCode || 200, data: payload }); },
    };
    handler(req, res).catch((e) => resolve({ status: 500, data: { error: e.message } }));
  });
}

// Business-day iterator: skip Sat/Sun.
function* eachTradingDay(fromISO, toISO) {
  const start = new Date(fromISO + 'T00:00:00Z');
  const end   = new Date(toISO   + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    yield d.toISOString().slice(0, 10);
  }
}

// Look ahead N hours from a signal timestamp — compute pip move in signal direction.
async function scoreOutcome(sb, instrument, direction, triggerIso, lookAheadHours) {
  if (!instrument || !VALID_PAIRS_INSTR.has(instrument) || !triggerIso) return null;
  const start = new Date(triggerIso).toISOString();
  const end   = new Date(new Date(triggerIso).getTime() + (lookAheadHours + 1) * 3600000).toISOString();

  const { data } = await sb
    .from('backtest_candles')
    .select('time, open, close')
    .eq('instrument', instrument).eq('timeframe', 'H1').eq('complete', true)
    .gte('time', start).lte('time', end)
    .order('time', { ascending: true })
    .limit(lookAheadHours + 4);

  if (!data || data.length < 1) return null;
  const signal = data[0];
  const futureIdx = Math.min(lookAheadHours, data.length - 1);
  const future = data[futureIdx];
  if (!future) return null;

  const pd = pipDiv(instrument);
  const signalPrice = parseFloat(signal.open);
  const futurePrice = parseFloat(future.close);
  const rawMove = direction === 'BUY'
    ? futurePrice - signalPrice
    : signalPrice - futurePrice;
  const pips = Math.round((rawMove / pd) * 10) / 10;
  return { pips, win: pips > 0, candlesUsed: futureIdx + 1 };
}

// Reduce a raw handler-response into a flat signal array with the fields we need.
function extractSignalsFromContinuation(payload, engineLabel) {
  const pairs = payload?.pairs || [];
  const out = [];
  for (const p of pairs) {
    if (!p.qualified) continue;
    out.push({
      engine: engineLabel,
      pair: p.pair,
      instrument: p.instrument || (p.pair || '').replace('/', '_'),
      direction: p.direction,
      time: p.triggerTime || p.breakTime,
      score: p.currentScore,
      breakPips: p.triggerBreakPips,
      refBreakPips: p.refBreakPips,
    });
  }
  return out;
}

function extractSignalsFromCleanBreak(payload) {
  const rows = payload?.rows || [];
  const out = [];
  for (const r of rows) {
    for (const s of (r.signals || [])) {
      out.push({
        engine: 'H1 Clean Break',
        pair: s.pair,
        instrument: s.instrument,
        direction: s.direction,
        time: r.time,
        breakPips: s.h1?.bodyPips,
      });
    }
  }
  return out;
}

function extractSignalsFromImbalance(payload, engineLabel) {
  const rows = payload?.rows || [];
  const out = [];
  for (const r of rows) {
    if (engineLabel === 'Market Imbalance M15') {
      const result = r.result;
      if (!result?.pairs) continue;
      for (const p of result.pairs.slice(0, 3)) {
        out.push({
          engine: engineLabel,
          pair: p.pair,
          instrument: (p.pair || '').replace('/', '_'),
          direction: p.direction,
          time: r.time,
          spread: p.spread,
        });
      }
    } else {
      // Hourly market-imbalance shape: r.timeframes = { '3H': {...}, '4H': {...}, '6H': {...} }
      const tfs = r.qualifiedTfs || Object.keys(r.timeframes || {});
      const best = r.bestTf;
      const chosen = best && r.timeframes?.[best] ? r.timeframes[best] : (tfs[0] ? r.timeframes[tfs[0]] : null);
      if (!chosen?.pairs) continue;
      for (const p of chosen.pairs.slice(0, 3)) {
        out.push({
          engine: engineLabel,
          pair: p.pair,
          instrument: (p.pair || '').replace('/', '_'),
          direction: p.direction,
          time: r.time,
          spread: p.spread,
          tf: best,
        });
      }
    }
  }
  return out;
}

async function runEngine({ engine, from, to }) {
  const signals = [];
  const errors = [];

  async function collect(promise, extract) {
    const res = await promise;
    if (res.status !== 200) { errors.push(res.data?.error || `HTTP ${res.status}`); return; }
    signals.push(...extract(res.data));
  }

  switch (engine) {
    case 'daily-continuation': {
      for (const day of eachTradingDay(from, to)) {
        await collect(invokeHandler(dailyHandler, { date: day }), (d) => extractSignalsFromContinuation(d, 'Daily Continuation'));
      }
      break;
    }
    case 'h1-continuation': { // H4 Continuation
      for (const day of eachTradingDay(from, to)) {
        for (const hour of [0, 4, 8, 12, 16, 20]) {
          await collect(
            invokeHandler(h4Handler, { date: day, hour: String(hour) }),
            (d) => extractSignalsFromContinuation(d, 'H4 Continuation')
          );
        }
      }
      break;
    }
    case 'session-continuation': {
      for (const day of eachTradingDay(from, to)) {
        for (const s of SESSIONS) {
          await collect(
            invokeHandler(sessionHandler, { date: day, session: s }),
            (d) => extractSignalsFromContinuation(d, 'Session Continuation')
          );
        }
      }
      break;
    }
    case 'h1-clean-break': {
      await collect(invokeHandler(cleanBreak, { from, to }), extractSignalsFromCleanBreak);
      break;
    }
    case 'market-imbalance': {
      await collect(
        invokeHandler(imbalance, { from, to }),
        (d) => extractSignalsFromImbalance(d, 'Market Imbalance')
      );
      break;
    }
    case 'market-imbalance-m15': {
      await collect(
        invokeHandler(imbalanceM15, { from, to }),
        (d) => extractSignalsFromImbalance(d, 'Market Imbalance M15')
      );
      break;
    }
    default:
      throw new Error(`Unknown engine: ${engine}`);
  }
  return { signals, errors };
}

function summarise(signals) {
  const byPair = {};
  const byHour = {};
  const byDow  = {};
  const byDirection = { BUY: 0, SELL: 0 };
  let totalPips = 0;
  let settled  = 0;
  let wins     = 0;

  for (const s of signals) {
    if (!byPair[s.pair]) byPair[s.pair] = { total: 0, buys: 0, sells: 0, wins: 0, losses: 0, totalPips: 0 };
    byPair[s.pair].total++;
    byPair[s.pair][s.direction === 'BUY' ? 'buys' : 'sells']++;
    byDirection[s.direction] = (byDirection[s.direction] || 0) + 1;

    if (s.time) {
      const t = new Date(s.time);
      const h = t.getUTCHours();
      const d = t.getUTCDay();
      if (!byHour[h]) byHour[h] = { total: 0, wins: 0, losses: 0 };
      if (!byDow[d])  byDow[d]  = { total: 0, wins: 0, losses: 0 };
      byHour[h].total++;
      byDow[d].total++;
    }

    if (s.outcome) {
      settled++;
      byPair[s.pair].totalPips += s.outcome.pips;
      totalPips += s.outcome.pips;
      if (s.outcome.win) {
        wins++;
        byPair[s.pair].wins++;
        if (s.time) {
          const t = new Date(s.time);
          byHour[t.getUTCHours()].wins++;
          byDow[t.getUTCDay()].wins++;
        }
      } else {
        byPair[s.pair].losses++;
        if (s.time) {
          const t = new Date(s.time);
          byHour[t.getUTCHours()].losses++;
          byDow[t.getUTCDay()].losses++;
        }
      }
    }
  }

  for (const [pair, st] of Object.entries(byPair)) {
    st.avgPips  = st.wins + st.losses > 0 ? Math.round((st.totalPips / (st.wins + st.losses)) * 10) / 10 : 0;
    st.totalPips = Math.round(st.totalPips * 10) / 10;
    st.hitRate  = st.wins + st.losses > 0 ? Math.round((st.wins / (st.wins + st.losses)) * 100) : null;
  }

  return {
    total: signals.length,
    settled,
    winRate: settled > 0 ? Math.round((wins / settled) * 100) : null,
    avgPips: settled > 0 ? Math.round((totalPips / settled) * 10) / 10 : 0,
    totalPips: Math.round(totalPips * 10) / 10,
    byPair, byHour, byDow, byDirection,
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const gate = await requirePlan(getServiceClient(), req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
  } catch (e) { return res.status(500).json({ error: e.message }); }

  const { engine, from, to, lookAheadHours = 4 } = req.body || {};
  if (!engine || !from || !to) {
    return res.status(400).json({ error: 'engine, from, to are required' });
  }

  const t0 = Date.now();
  const sb = getServiceClient();

  try {
    const { signals, errors } = await runEngine({ engine, from, to });

    // Score each signal's outcome using H1 candles look-ahead.
    // Cap to a reasonable amount so a wide range doesn't wall-clock the fn.
    const CAP = 4000;
    const capped = signals.slice(0, CAP);
    for (const s of capped) {
      if (!s.time || !s.instrument || !s.direction) continue;
      s.outcome = await scoreOutcome(sb, s.instrument, s.direction, s.time, lookAheadHours);
    }

    const stats = summarise(capped);

    res.json({
      engine,
      from, to, lookAheadHours,
      duration_sec: Math.round((Date.now() - t0) / 100) / 10,
      truncated: signals.length > CAP,
      raw_signal_count: signals.length,
      signals: capped,
      stats,
      errors,
    });
  } catch (e) {
    console.error('[backtest-engine]', e);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 300;
