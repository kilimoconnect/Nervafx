'use strict';

/**
 * Trade Signals — Energy-driven
 *
 * Reads from energy_signal_pairs (written by energyDirection.js) instead
 * of the old market_states table. Only pairs that the energy engine is
 * actively monitoring can produce signals.
 *
 * Signal logic:
 *   ENTRY phase + gates passed → BUY / SELL  (with entry, SL, TP)
 *   READY phase                → WAIT        (approaching entry)
 *   COMPRESSION phase          → WAIT        (coiling, watch for breakout)
 *   PULLBACK phase             → WAIT        (retracing, not ready)
 *   MONITORING phase           → NO_TRADE    (just watching)
 *   No energy pair             → NO_TRADE
 *
 * Entry gates (all must pass for BUY/SELL):
 *   1. Phase = ENTRY
 *   2. 3H spread aligned with flow direction
 *   3. 3H re-expanding: |3H| > |6H| × 0.8
 *   4. Impulse aligned with flow
 *   5. SL within ATR × 3 (not too wide)
 *   6. Valid entry/SL prices
 */

const { config } = require('./config');
const { supabase } = require('./supabase');

const RISK_REWARD = 2.0;
const MAX_STOP_ATR_MULTIPLE = 3;
const SL_CANDLE_LOOKBACK = 6;

// ─── Candle helpers ───────────────────────────────────────────────────────────

async function buildCandleLookup() {
  const lookup = {};
  for (const instrument of config.instruments) {
    const { data, error } = await supabase
      .from('backtest_candles')
      .select('time, high, low, close')
      .eq('instrument', instrument)
      .eq('timeframe', config.granularity)
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(SL_CANDLE_LOOKBACK + 2);

    if (error) throw new Error(`Candle fetch (${instrument}): ${error.message}`);
    lookup[instrument] = (data || []).reverse().map(c => ({
      time: new Date(c.time).toISOString(),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
    }));
  }
  return lookup;
}

function getRecentCandles(lookup, instrument, count = SL_CANDLE_LOOKBACK) {
  const candles = lookup[instrument] || [];
  return candles.slice(-count);
}

function avgRange(candles) {
  if (candles.length === 0) return 0;
  return candles.reduce((sum, c) => sum + (c.high - c.low), 0) / candles.length;
}

// ─── Signal builders ──────────────────────────────────────────────────────────

function noTrade(time, instrument, reason) {
  return {
    time, instrument, signal: 'NO_TRADE', direction: null, confidence: 0,
    entry_type: null, entry_price: null, stop_loss: null, take_profit: null,
    risk_reward: null, market_state: null, reason,
  };
}

function waitSignal(time, instrument, phase, dir, de, reason) {
  return {
    time, instrument, signal: 'WAIT',
    direction: dir === 'BUY' ? 'LONG' : 'SHORT',
    confidence: Math.round(de || 0),
    entry_type: null, entry_price: null, stop_loss: null, take_profit: null,
    risk_reward: null, market_state: phase, reason,
  };
}

// ─── Core signal logic ────────────────────────────────────────────────────────

function buildSignalFromEnergy(pair, candles, now) {
  const { instrument, dir, phase, strong_ccy, weak_ccy,
          v45, spread_3h, spread_6h, de_combined,
          impulse_score, impulse_aligned } = pair;

  const time = now.toISOString();
  const pairLabel = instrument.replace('_', '/');
  const flowSign = dir === 'BUY' ? 1 : -1;
  const sp3 = parseFloat(spread_3h) || 0;
  const sp6 = parseFloat(spread_6h) || 0;
  const de  = parseFloat(de_combined) || 0;
  const imp = impulse_score || 0;

  // ── Phase-based routing ─────────────────────────────────────────────────

  if (phase === 'MONITORING') {
    return noTrade(time, instrument,
      `${pairLabel} monitoring (${strong_ccy}↑ ${weak_ccy}↓). No pullback cycle started yet.`);
  }

  if (phase === 'PULLBACK') {
    return waitSignal(time, instrument, phase, dir, de,
      `${pairLabel} ${dir} pullback active — M15 retracing against flow. Wait for compression or re-expansion.`);
  }

  if (phase === 'COMPRESSION') {
    return waitSignal(time, instrument, phase, dir, de,
      `${pairLabel} ${dir} compressing after pullback — range tightening. Watch for breakout.`);
  }

  if (phase === 'READY') {
    return waitSignal(time, instrument, phase, dir, de,
      `${pairLabel} ${dir} momentum returning (DE:${Math.round(de)}, imp:${imp}). Approaching entry — need multi-TF confirmation.`);
  }

  // ── ENTRY phase — run entry gates ───────────────────────────────────────

  if (phase !== 'ENTRY') {
    return noTrade(time, instrument, `${pairLabel} phase ${phase} — no signal.`);
  }

  // Gate 1: 3H must be aligned with flow direction
  const h3Aligned = sp3 * flowSign > 0;
  if (!h3Aligned) {
    return waitSignal(time, instrument, phase, dir, de,
      `${pairLabel} ENTRY phase but 3H not aligned (${(sp3*10000).toFixed(1)}). Waiting for 3H confirmation.`);
  }

  // Gate 2: 3H re-expanding — |3H| > |6H| × 0.8
  const a3 = Math.abs(sp3);
  const a6 = Math.abs(sp6);
  if (a6 > 0 && a3 <= a6 * 0.8) {
    return waitSignal(time, instrument, phase, dir, de,
      `${pairLabel} ENTRY phase but 3H stalling (${(a3*10000).toFixed(1)} vs 6H ${(a6*10000).toFixed(1)}). Wait for re-expansion.`);
  }

  // Gate 3: Impulse must be aligned
  if (!impulse_aligned) {
    return waitSignal(time, instrument, phase, dir, de,
      `${pairLabel} ENTRY phase but impulse not aligned (score:${imp}). Wait for M15 impulse confirmation.`);
  }

  // ── Calculate entry, SL, TP ─────────────────────────────────────────────

  if (!candles || candles.length < 2) {
    return waitSignal(time, instrument, phase, dir, de,
      `${pairLabel} ENTRY phase — insufficient candle data for SL calculation.`);
  }

  const entry = candles[candles.length - 1].close;
  const atr = avgRange(candles);

  if (dir === 'BUY') {
    const stopLoss = Math.min(...candles.map(c => c.low));
    const risk = entry - stopLoss;

    if (risk <= 0) return waitSignal(time, instrument, phase, dir, de, `${pairLabel} ENTRY — SL above entry.`);
    if (risk > atr * MAX_STOP_ATR_MULTIPLE) {
      return waitSignal(time, instrument, phase, dir, de,
        `${pairLabel} ENTRY — stop too wide (${risk.toFixed(5)} > ATR×${MAX_STOP_ATR_MULTIPLE}).`);
    }

    const takeProfit = entry + (risk * RISK_REWARD);
    return {
      time, instrument,
      signal: 'BUY', direction: 'LONG',
      confidence: Math.round(de),
      entry_type: 'ENERGY_ENTRY',
      entry_price: entry, stop_loss: stopLoss, take_profit: takeProfit,
      risk_reward: RISK_REWARD, market_state: 'ENTRY',
      reason: `BUY ${pairLabel}: ${strong_ccy}↑ ${weak_ccy}↓ ENTRY confirmed. DE:${Math.round(de)} imp:${imp}✓ 3H+M15 aligned. Entry: ${entry.toFixed(5)}, SL: ${stopLoss.toFixed(5)}, TP: ${takeProfit.toFixed(5)}.`,
    };
  }

  if (dir === 'SELL') {
    const stopLoss = Math.max(...candles.map(c => c.high));
    const risk = stopLoss - entry;

    if (risk <= 0) return waitSignal(time, instrument, phase, dir, de, `${pairLabel} ENTRY — SL below entry.`);
    if (risk > atr * MAX_STOP_ATR_MULTIPLE) {
      return waitSignal(time, instrument, phase, dir, de,
        `${pairLabel} ENTRY — stop too wide (${risk.toFixed(5)} > ATR×${MAX_STOP_ATR_MULTIPLE}).`);
    }

    const takeProfit = entry - (risk * RISK_REWARD);
    return {
      time, instrument,
      signal: 'SELL', direction: 'SHORT',
      confidence: Math.round(de),
      entry_type: 'ENERGY_ENTRY',
      entry_price: entry, stop_loss: stopLoss, take_profit: takeProfit,
      risk_reward: RISK_REWARD, market_state: 'ENTRY',
      reason: `SELL ${pairLabel}: ${strong_ccy}↑ ${weak_ccy}↓ ENTRY confirmed. DE:${Math.round(de)} imp:${imp}✓ 3H+M15 aligned. Entry: ${entry.toFixed(5)}, SL: ${stopLoss.toFixed(5)}, TP: ${takeProfit.toFixed(5)}.`,
    };
  }

  return noTrade(time, instrument, `${pairLabel} — no directional bias.`);
}

// ─── Data layer ───────────────────────────────────────────────────────────────

async function upsertSignals(rows) {
  if (rows.length === 0) return;
  const { error } = await supabase
    .from('trade_signals')
    .upsert(rows, { onConflict: 'time,instrument', ignoreDuplicates: false });
  if (error) throw new Error(`Signal upsert error: ${error.message}`);
}

// ─── Incremental (runs every pipeline cycle) ──────────────────────────────────

async function calculateLatestSignals() {
  const now = new Date();
  const hourTs = new Date(now);
  hourTs.setMinutes(0, 0, 0);

  // Fetch active energy signal pairs
  const { data: energyPairs, error: epErr } = await supabase
    .from('energy_signal_pairs')
    .select('instrument, dir, strong_ccy, weak_ccy, phase, v45, v90, spread_3h, spread_6h, de_combined, impulse_score, impulse_aligned, m15_state, energy_level')
    .eq('active', true);

  if (epErr) throw new Error(`Energy pairs fetch: ${epErr.message}`);

  if (!energyPairs?.length) {
    console.log('[SIGNAL] No active energy pairs — no signals to generate.');
    return [];
  }

  // Fetch candles for SL calculation
  const candleLookup = await buildCandleLookup();
  const rows = [];

  for (const pair of energyPairs) {
    const candles = getRecentCandles(candleLookup, pair.instrument);
    const signal = buildSignalFromEnergy(pair, candles, hourTs);
    rows.push(signal);
  }

  await upsertSignals(rows);

  const buys  = rows.filter(r => r.signal === 'BUY').length;
  const sells = rows.filter(r => r.signal === 'SELL').length;
  const waits = rows.filter(r => r.signal === 'WAIT').length;
  console.log(`[SIGNAL] ${rows.length} signals: ${buys} BUY, ${sells} SELL, ${waits} WAIT, ${rows.length - buys - sells - waits} NO_TRADE`);

  return rows;
}

// Legacy stubs for CLI compatibility (index.js backfill/print commands)
async function backfillSignals() {
  console.log('[SIGNAL] Backfill not available — signals are now energy-driven (real-time only).');
  return { total: 0, buyCount: 0, sellCount: 0 };
}

async function printLatestSignals() {
  const { data, error } = await supabase
    .from('trade_signals')
    .select('*')
    .order('time', { ascending: false })
    .limit(28);

  if (error) throw new Error(error.message);

  const order = { BUY: 0, SELL: 1, WAIT: 2, NO_TRADE: 3 };
  const sorted = (data || []).sort((a, b) => (order[a.signal] ?? 9) - (order[b.signal] ?? 9));

  console.log('\n=== ACTIVE SIGNALS ===');
  const active = sorted.filter(r => r.signal === 'BUY' || r.signal === 'SELL');
  if (!active.length) console.log('  None');
  for (const r of active) {
    console.log(`  ${r.instrument.padEnd(8)} ${r.signal.padEnd(5)}  entry:${Number(r.entry_price).toFixed(5)}  SL:${Number(r.stop_loss).toFixed(5)}  TP:${Number(r.take_profit).toFixed(5)}`);
    console.log(`  → ${r.reason}`);
  }

  console.log('\n=== WAITING ===');
  const waiting = sorted.filter(r => r.signal === 'WAIT');
  if (!waiting.length) console.log('  None');
  for (const r of waiting) {
    console.log(`  ${r.instrument.padEnd(8)} ${r.signal.padEnd(5)} ${(r.direction || '').padEnd(6)}  ${r.reason}`);
  }

  console.log(`\n=== NO TRADE: ${sorted.filter(r => r.signal === 'NO_TRADE').length} pairs ===`);
}

module.exports = { calculateLatestSignals, backfillSignals, printLatestSignals, buildSignalFromEnergy, buildCandleLookup, getRecentCandles, avgRange };
