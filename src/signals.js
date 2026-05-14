const { config } = require('./config');
const { supabase } = require('./supabase');

const MIN_CONFIDENCE = 75;
const RISK_REWARD = 2.0;
const MAX_STOP_ATR_MULTIPLE = 3;
const SL_CANDLE_LOOKBACK = 6;

// ─── Candle helpers ───────────────────────────────────────────────────────────

// Pre-fetch all H1 candles per instrument into memory for backfill use.
async function buildCandleLookup() {
  const lookup = {};
  for (const instrument of config.instruments) {
    const { data, error } = await supabase
      .from('market_candles')
      .select('time, high, low, close')
      .eq('instrument', instrument)
      .eq('timeframe', config.granularity)
      .order('time', { ascending: true });

    if (error) throw new Error(`Candle fetch (${instrument}): ${error.message}`);
    lookup[instrument] = (data || []).map(c => ({
      time: new Date(c.time).toISOString(),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
    }));
  }
  return lookup;
}

// Get the N candles at or before time T for an instrument from the in-memory lookup.
function getCandlesAtTime(lookup, instrument, time, count = SL_CANDLE_LOOKBACK) {
  const candles = lookup[instrument] || [];
  const idx = candles.findIndex(c => c.time === time);
  if (idx < 0) return [];
  return candles.slice(Math.max(0, idx - count + 1), idx + 1);
}

function avgRange(candles) {
  if (candles.length === 0) return 0;
  return candles.reduce((sum, c) => sum + (c.high - c.low), 0) / candles.length;
}

// ─── Signal logic ─────────────────────────────────────────────────────────────

function buildSignal(state, candles) {
  const { time, instrument, bias, state: mktState, confidence, spread_6h, spread_12h } = state;

  // NO_TRADE conditions
  if (mktState === 'NO_TRADE' || mktState === 'REVERSAL_RISK') {
    return noTrade(time, instrument, confidence, mktState, `State is ${mktState}.`);
  }

  // WAIT — pullback in progress
  if (mktState === 'PULLBACK_STARTING') {
    return wait(time, instrument, confidence, mktState, bias,
      `${bias} pullback starting — 3H momentum compressing. Watch for 3H to re-expand.`);
  }
  if (mktState === 'PULLBACK_ACTIVE') {
    return wait(time, instrument, confidence, mktState, bias,
      `${bias} pullback active — 3H compressing. Wait for 3H re-expansion → entry trigger.`);
  }

  // WAIT if TREND (no pullback yet)
  if (mktState === 'TREND') {
    return wait(time, instrument, confidence, mktState, bias,
      `${bias} trend active. Watch for 3H momentum to weaken (compression zone = pullback entry forming).`);
  }
  if (mktState === 'BASE_FORMING') {
    return wait(time, instrument, confidence, mktState, bias,
      `${bias} deep pullback at floor — coiling. Wait for 3H re-expansion.`);
  }
  if (mktState === 'REVERSAL_CONFIRMED') {
    return wait(time, instrument, confidence, mktState, bias,
      `Reversal confirmed ${bias}. Await first pullback before entry.`);
  }
  if (mktState === 'REVERSAL_DEVELOPING' || mktState === 'REVERSAL_RISK') {
    return noTrade(time, instrument, confidence, mktState,
      `${mktState}: structural uncertainty — no entry.`);
  }

  // READY_TO_ENTER triggers BUY/SELL — state machine is the quality gate,
  // not a confidence floor. User profile (min_rr, max_trades, etc.) is the filter.
  if (mktState !== 'READY_TO_ENTER') {
    return noTrade(time, instrument, confidence, mktState,
      `State ${mktState} does not meet signal criteria.`);
  }

  if (!candles || candles.length < 2) {
    return noTrade(time, instrument, confidence, mktState, 'Insufficient candle data for SL calculation.');
  }

  const entry = candles[candles.length - 1].close;
  const atr = avgRange(candles);

  if (bias === 'BUY') {
    const stopLoss = Math.min(...candles.map(c => c.low));
    const risk = entry - stopLoss;

    if (risk <= 0) return noTrade(time, instrument, confidence, mktState, 'Stop loss above entry price.');
    if (risk > atr * MAX_STOP_ATR_MULTIPLE) {
      return noTrade(time, instrument, confidence, mktState,
        `Stop distance ${risk.toFixed(5)} exceeds ATR×${MAX_STOP_ATR_MULTIPLE} (${(atr * MAX_STOP_ATR_MULTIPLE).toFixed(5)}).`);
    }

    const takeProfit = entry + (risk * RISK_REWARD);
    return {
      time, instrument,
      signal: 'BUY',
      direction: 'LONG',
      confidence,
      entry_type: 'H1_CLOSE_CONTINUATION',
      entry_price: entry,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      risk_reward: RISK_REWARD,
      market_state: mktState,
      reason: `BUY entry: pullback completed, 3H re-expanding. Entry: ${entry.toFixed(5)}, SL: ${stopLoss.toFixed(5)}, TP: ${takeProfit.toFixed(5)}.`,
    };
  }

  if (bias === 'SELL') {
    const stopLoss = Math.max(...candles.map(c => c.high));
    const risk = stopLoss - entry;

    if (risk <= 0) return noTrade(time, instrument, confidence, mktState, 'Stop loss below entry price.');
    if (risk > atr * MAX_STOP_ATR_MULTIPLE) {
      return noTrade(time, instrument, confidence, mktState,
        `Stop distance ${risk.toFixed(5)} exceeds ATR×${MAX_STOP_ATR_MULTIPLE} (${(atr * MAX_STOP_ATR_MULTIPLE).toFixed(5)}).`);
    }

    const takeProfit = entry - (risk * RISK_REWARD);
    return {
      time, instrument,
      signal: 'SELL',
      direction: 'SHORT',
      confidence,
      entry_type: 'H1_CLOSE_CONTINUATION',
      entry_price: entry,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      risk_reward: RISK_REWARD,
      market_state: mktState,
      reason: `SELL entry: pullback completed, 3H re-expanding. Entry: ${entry.toFixed(5)}, SL: ${stopLoss.toFixed(5)}, TP: ${takeProfit.toFixed(5)}.`,
    };
  }

  return noTrade(time, instrument, confidence, mktState, 'Bias is NONE; no signal.');
}

function noTrade(time, instrument, confidence, mktState, reason) {
  return { time, instrument, signal: 'NO_TRADE', direction: null, confidence, entry_type: null, entry_price: null, stop_loss: null, take_profit: null, risk_reward: null, market_state: mktState, reason };
}

function wait(time, instrument, confidence, mktState, bias, reason) {
  return { time, instrument, signal: 'WAIT', direction: bias === 'BUY' ? 'LONG' : 'SHORT', confidence, entry_type: null, entry_price: null, stop_loss: null, take_profit: null, risk_reward: null, market_state: mktState, reason };
}

// ─── Data layer ───────────────────────────────────────────────────────────────

async function upsertSignals(rows) {
  if (rows.length === 0) return;
  const { error } = await supabase
    .from('trade_signals')
    .upsert(rows, { onConflict: 'time,instrument', ignoreDuplicates: false });
  if (error) throw new Error(`Signal upsert error: ${error.message}`);
}

// ─── Backfill ─────────────────────────────────────────────────────────────────

async function backfillSignals() {
  console.log('[SIGNAL] Fetching market states and candle data...');

  const candleLookup = await buildCandleLookup();

  // Fetch all market states per instrument in order
  let total = 0;
  let buyCount = 0;
  let sellCount = 0;
  const BATCH = 500;
  let batch = [];

  for (const instrument of config.instruments) {
    const { data: states, error } = await supabase
      .from('market_states')
      .select('time, instrument, bias, state, confidence, spread_6h, spread_12h')
      .eq('instrument', instrument)
      .order('time', { ascending: true });

    if (error) throw new Error(`State fetch (${instrument}): ${error.message}`);

    for (const state of states || []) {
      const time = new Date(state.time).toISOString();
      const candles = getCandlesAtTime(candleLookup, instrument, time);
      const row = buildSignal(state, candles);

      batch.push(row);
      if (row.signal === 'BUY') buyCount++;
      if (row.signal === 'SELL') sellCount++;

      if (batch.length >= BATCH) {
        await upsertSignals(batch);
        total += batch.length;
        batch = [];
      }
    }
  }

  if (batch.length > 0) {
    await upsertSignals(batch);
    total += batch.length;
  }

  console.log(`[SIGNAL] Backfill done. ${total} rows. BUY: ${buyCount}, SELL: ${sellCount}`);
  return { total, buyCount, sellCount };
}

// ─── Incremental ──────────────────────────────────────────────────────────────

async function calculateLatestSignals() {
  const candleLookup = await buildCandleLookup();
  const rows = [];

  for (const instrument of config.instruments) {
    const { data: states } = await supabase
      .from('market_states')
      .select('time, instrument, bias, state, confidence, spread_6h, spread_12h')
      .eq('instrument', instrument)
      .order('time', { ascending: false })
      .limit(1);

    if (!states || states.length === 0) continue;

    const state = states[0];
    const time = new Date(state.time).toISOString();
    const candles = getCandlesAtTime(candleLookup, instrument, time);
    rows.push(buildSignal(state, candles));
  }

  await upsertSignals(rows);
  console.log(`[SIGNAL] Stored ${rows.length} signals for latest candle`);
  return rows;
}

// ─── Display ──────────────────────────────────────────────────────────────────

async function printLatestSignals() {
  const { data, error } = await supabase
    .from('trade_signals')
    .select('*')
    .order('time', { ascending: false })
    .limit(28);

  if (error) throw new Error(error.message);

  const order = { BUY: 0, SELL: 1, WAIT: 2, NO_TRADE: 3 };
  const sorted = (data || []).sort((a, b) => {
    const so = (order[a.signal] ?? 9) - (order[b.signal] ?? 9);
    return so !== 0 ? so : b.confidence - a.confidence;
  });

  const active = sorted.filter(r => r.signal === 'BUY' || r.signal === 'SELL');
  const waiting = sorted.filter(r => r.signal === 'WAIT');
  const inactive = sorted.filter(r => r.signal === 'NO_TRADE');

  console.log('\n=== ACTIVE SIGNALS ===');
  if (active.length === 0) console.log('  None');
  for (const r of active) {
    console.log(`  ${r.instrument.padEnd(8)} ${r.signal.padEnd(5)} conf:${String(r.confidence).padStart(3)}  entry:${Number(r.entry_price).toFixed(5)}  SL:${Number(r.stop_loss).toFixed(5)}  TP:${Number(r.take_profit).toFixed(5)}  RR:${r.risk_reward}`);
    console.log(`  → ${r.reason}`);
  }

  console.log('\n=== WAITING ===');
  if (waiting.length === 0) console.log('  None');
  for (const r of waiting) {
    console.log(`  ${r.instrument.padEnd(8)} ${r.signal.padEnd(5)} ${(r.direction || '').padEnd(6)} conf:${String(r.confidence).padStart(3)}  ${r.reason}`);
  }

  console.log(`\n=== NO TRADE: ${inactive.length} pairs ===`);
}

module.exports = { backfillSignals, calculateLatestSignals, printLatestSignals };
