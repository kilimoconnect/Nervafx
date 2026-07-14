'use strict';

/**
 * Shared helper for the continuation engines. Returns whether the H1 EMA
 * stack aligns with a requested direction at a given anchor time:
 *
 *   BUY  → close > EMA20 > EMA50 on the most recent complete H1 at anchor
 *   SELL → close < EMA20 < EMA50
 *
 * Callers pass:
 *   - sb:        Supabase client
 *   - inst:      instrument like 'EUR_USD'
 *   - anchorMs:  UTC ms of the trigger time (an H1 or M15 close)
 *   - direction: 'BUY' | 'SELL'
 *
 * Fetches 200 H1 candles ending at or before anchor (plenty for EMA50), so
 * this stays a single small query per pair per call. Cache upstream if
 * calling many times per pair.
 */

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

async function fetchH1Closes(sb, inst, anchorMs) {
  const untilIso = new Date(anchorMs).toISOString();
  const { data, error } = await sb
    .from('backtest_candles')
    .select('time, close')
    .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true)
    .lte('time', untilIso)
    .order('time', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data || []).reverse().map(c => parseFloat(c.close));
}

// Given an already-fetched H1 series, evaluate alignment at anchorMs.
function alignFromCandles(h1Candles, anchorMs, direction) {
  if (!Array.isArray(h1Candles) || !h1Candles.length) {
    return { aligned: false, reason: 'no-h1' };
  }
  const closes = [];
  for (const c of h1Candles) {
    const t = c._ms != null ? c._ms : new Date(c.time).getTime();
    if (t <= anchorMs) closes.push(parseFloat(c.close));
  }
  if (closes.length < 51) return { aligned: false, reason: 'insufficient', closes: closes.length };
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const close = closes[closes.length - 1];
  if (e20 == null || e50 == null) return { aligned: false, reason: 'ema-null' };
  let aligned = false;
  if (direction === 'BUY')  aligned = close > e20 && e20 > e50;
  if (direction === 'SELL') aligned = close < e20 && e20 < e50;
  return { aligned, close, ema20: e20, ema50: e50 };
}

async function alignByFetch(sb, inst, anchorMs, direction) {
  const closes = await fetchH1Closes(sb, inst, anchorMs);
  if (closes.length < 51) return { aligned: false, reason: 'insufficient', closes: closes.length };
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const close = closes[closes.length - 1];
  if (e20 == null || e50 == null) return { aligned: false, reason: 'ema-null' };
  let aligned = false;
  if (direction === 'BUY')  aligned = close > e20 && e20 > e50;
  if (direction === 'SELL') aligned = close < e20 && e20 < e50;
  return { aligned, close, ema20: e20, ema50: e50 };
}

module.exports = { ema, fetchH1Closes, alignFromCandles, alignByFetch };
