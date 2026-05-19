'use strict';

/**
 * NervaFX Backtesting Engine
 *
 * Replays historical candles through the full signal pipeline:
 *   Candles → Strength → Smooth → Spreads → States → Signals → Outcome
 *
 * All computation is in-memory — no DB writes during replay.
 * Only the final backtest results are stored.
 */

const { config }       = require('./config');
const { supabase }     = require('./supabase');
const { calculateAtTime } = require('./strength');
const { computeSpreads }   = require('./spread');
const { classifyRow }      = require('./stateDetect');
const { buildSignal, getCandlesAtTime, avgRange } = require('./signals');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const SL_CANDLE_LOOKBACK = 6;

// ─── 1. Load candles from backtest_candles ───────────────────────────────────

async function loadCandles(from, to, timeframe = 'H1') {
  const lookup = {};
  const candleArrays = {}; // for signal SL/TP calculation

  for (const instrument of config.instruments) {
    const { data, error } = await supabase
      .from('backtest_candles')
      .select('time, open, high, low, close, volume')
      .eq('instrument', instrument)
      .eq('timeframe', timeframe)
      .gte('time', from)
      .lte('time', to)
      .order('time', { ascending: true });

    if (error) throw new Error(`Candle load (${instrument}): ${error.message}`);

    lookup[instrument] = {};
    candleArrays[instrument] = [];

    for (const c of data || []) {
      const t = new Date(c.time).toISOString();
      lookup[instrument][t] = parseFloat(c.close);
      candleArrays[instrument].push({
        time: t,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
      });
    }
  }

  return { lookup, candleArrays };
}

// ─── 2. EMA smooth (in-memory) ───────────────────────────────────────────────

function ema(prev, current) {
  if (prev === null || prev === undefined) return current;
  return (prev + current) / 2;
}

// ─── 3. Evaluate signal outcome ──────────────────────────────────────────────
// After a BUY/SELL signal at time T, walk forward through candles to see
// if price hit TP or SL first within maxBars.

function evaluateOutcome(signal, candleArray, maxBars = 48) {
  if (!signal || (signal.signal !== 'BUY' && signal.signal !== 'SELL')) return null;

  const entryIdx = candleArray.findIndex(c => c.time === signal.time);
  if (entryIdx < 0) return null;

  const { entry_price, stop_loss, take_profit, signal: dir } = signal;
  if (!entry_price || !stop_loss || !take_profit) return null;

  let maxFavourable = 0;
  let maxAdverse = 0;

  for (let i = entryIdx + 1; i < Math.min(candleArray.length, entryIdx + maxBars + 1); i++) {
    const candle = candleArray[i];

    if (dir === 'BUY') {
      // Check SL hit (low touches stop)
      if (candle.low <= stop_loss) {
        return {
          outcome: 'LOSS',
          exit_price: stop_loss,
          exit_time: candle.time,
          bars_held: i - entryIdx,
          pips: Math.round((stop_loss - entry_price) * 10000),
          max_favourable_pips: Math.round(maxFavourable * 10000),
          max_adverse_pips: Math.round(maxAdverse * 10000),
        };
      }
      // Check TP hit (high touches target)
      if (candle.high >= take_profit) {
        return {
          outcome: 'WIN',
          exit_price: take_profit,
          exit_time: candle.time,
          bars_held: i - entryIdx,
          pips: Math.round((take_profit - entry_price) * 10000),
          max_favourable_pips: Math.round(maxFavourable * 10000),
          max_adverse_pips: Math.round(maxAdverse * 10000),
        };
      }
      maxFavourable = Math.max(maxFavourable, candle.high - entry_price);
      maxAdverse = Math.max(maxAdverse, entry_price - candle.low);
    } else {
      // SELL
      if (candle.high >= stop_loss) {
        return {
          outcome: 'LOSS',
          exit_price: stop_loss,
          exit_time: candle.time,
          bars_held: i - entryIdx,
          pips: Math.round((entry_price - stop_loss) * 10000),
          max_favourable_pips: Math.round(maxFavourable * 10000),
          max_adverse_pips: Math.round(maxAdverse * 10000),
        };
      }
      if (candle.low <= take_profit) {
        return {
          outcome: 'WIN',
          exit_price: take_profit,
          exit_time: candle.time,
          bars_held: i - entryIdx,
          pips: Math.round((entry_price - take_profit) * 10000),
          max_favourable_pips: Math.round(maxFavourable * 10000),
          max_adverse_pips: Math.round(maxAdverse * 10000),
        };
      }
      maxFavourable = Math.max(maxFavourable, entry_price - candle.low);
      maxAdverse = Math.max(maxAdverse, candle.high - entry_price);
    }
  }

  // Timeout — didn't hit TP or SL
  const lastBar = candleArray[Math.min(candleArray.length - 1, entryIdx + maxBars)];
  const exitPrice = lastBar ? lastBar.close : entry_price;
  const pips = dir === 'BUY'
    ? Math.round((exitPrice - entry_price) * 10000)
    : Math.round((entry_price - exitPrice) * 10000);

  return {
    outcome: pips > 0 ? 'WIN' : pips < 0 ? 'LOSS' : 'BREAKEVEN',
    exit_price: exitPrice,
    exit_time: lastBar ? lastBar.time : null,
    bars_held: maxBars,
    pips,
    max_favourable_pips: Math.round(maxFavourable * 10000),
    max_adverse_pips: Math.round(maxAdverse * 10000),
    timeout: true,
  };
}

// ─── 4. Main backtest replay ─────────────────────────────────────────────────

async function runBacktest({ from, to, instruments, maxBars = 48 }) {
  const instList = instruments || config.instruments;
  const startTime = Date.now();

  console.log(`[BACKTEST] Loading candles ${from} → ${to} for ${instList.length} instruments...`);
  const { lookup, candleArrays } = await loadCandles(from, to);

  // Collect all timestamps across all instruments
  const allTimes = new Set();
  for (const inst of instList) {
    for (const t of Object.keys(lookup[inst] || {})) allTimes.add(t);
  }
  const timestamps = [...allTimes].sort();
  console.log(`[BACKTEST] ${timestamps.length} H1 bars to replay`);

  // ── Phase 1: Strength ──────────────────────────────────────────────────────
  console.log('[BACKTEST] Phase 1: Calculating strength...');
  const strengthByTime = {}; // { time: { currency: { n3h, n6h, n12h } } }
  let strengthCount = 0;

  for (const time of timestamps) {
    const rows = calculateAtTime(lookup, time);
    if (!rows) continue;

    strengthByTime[time] = {};
    for (const r of rows) {
      strengthByTime[time][r.currency] = {
        n3h: r.normalized_3h,
        n6h: r.normalized_6h,
        n12h: r.normalized_12h,
      };
    }
    strengthCount++;
  }
  console.log(`[BACKTEST] Strength: ${strengthCount} timestamps calculated`);

  // ── Phase 2: Smooth (EMA) ─────────────────────────────────────────────────
  console.log('[BACKTEST] Phase 2: Applying EMA smoothing...');
  const smoothByTime = {}; // { time: { currency: { s3h, s6h, s12h } } }
  const prevSmooth = {};

  const strengthTimes = Object.keys(strengthByTime).sort();
  for (const time of strengthTimes) {
    smoothByTime[time] = {};
    for (const currency of CURRENCIES) {
      const raw = strengthByTime[time][currency];
      if (!raw) continue;

      const prev = prevSmooth[currency] || {};
      const s3h  = ema(prev.s3h, raw.n3h);
      const s6h  = ema(prev.s6h, raw.n6h);
      const s12h = ema(prev.s12h, raw.n12h);

      smoothByTime[time][currency] = { s3h, s6h, s12h };
      prevSmooth[currency] = { s3h, s6h, s12h };
    }
  }

  // ── Phase 3: Spreads ──────────────────────────────────────────────────────
  console.log('[BACKTEST] Phase 3: Computing spreads...');
  const spreadsByInst = {}; // { instrument: [{ time, spread_3h, spread_6h, spread_12h }] }
  let spreadCount = 0;

  for (const time of strengthTimes) {
    const snapshot = smoothByTime[time];
    if (Object.keys(snapshot).length < 8) continue;

    const rows = computeSpreads(time, snapshot);
    if (!rows) continue;

    for (const r of rows) {
      if (!spreadsByInst[r.instrument]) spreadsByInst[r.instrument] = [];
      spreadsByInst[r.instrument].push(r);
    }
    spreadCount++;
  }
  console.log(`[BACKTEST] Spreads: ${spreadCount} timestamps × 28 instruments`);

  // ── Phase 4: States ───────────────────────────────────────────────────────
  console.log('[BACKTEST] Phase 4: Detecting market states...');
  const statesByInst = {}; // { instrument: [{ time, state, bias, confidence, ... }] }

  for (const instrument of instList) {
    const spreads = spreadsByInst[instrument] || [];
    statesByInst[instrument] = [];
    let prevSpread = null;
    let prevState  = null;

    for (const spread of spreads) {
      const result = classifyRow(spread, prevSpread, prevState);
      statesByInst[instrument].push(result);
      prevSpread = spread;
      prevState  = result.state;
    }
  }

  // ── Phase 5: Signals + Outcome Evaluation ──────────────────────────────────
  console.log('[BACKTEST] Phase 5: Generating signals & evaluating outcomes...');
  const trades = [];
  const signalCounts = { BUY: 0, SELL: 0, WAIT: 0, NO_TRADE: 0 };

  for (const instrument of instList) {
    const states = statesByInst[instrument] || [];
    const cArr   = candleArrays[instrument] || [];

    for (const state of states) {
      // Get candles at signal time for SL calculation
      const idx = cArr.findIndex(c => c.time === state.time);
      const candles = idx >= 0
        ? cArr.slice(Math.max(0, idx - SL_CANDLE_LOOKBACK + 1), idx + 1)
        : [];

      const signal = buildSignal(state, candles);
      signalCounts[signal.signal] = (signalCounts[signal.signal] || 0) + 1;

      if (signal.signal === 'BUY' || signal.signal === 'SELL') {
        const outcome = evaluateOutcome(signal, cArr, maxBars);
        trades.push({
          ...signal,
          ...outcome,
        });
      }
    }
  }

  // ── Phase 6: Compile statistics ────────────────────────────────────────────
  console.log('[BACKTEST] Phase 6: Compiling statistics...');

  const wins   = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');
  const breakevens = trades.filter(t => t.outcome === 'BREAKEVEN');
  const timeouts   = trades.filter(t => t.timeout);

  const totalPips = trades.reduce((s, t) => s + (t.pips || 0), 0);
  const winRate   = trades.length > 0 ? (wins.length / trades.length * 100) : 0;

  // Group by instrument
  const byInstrument = {};
  for (const t of trades) {
    if (!byInstrument[t.instrument]) byInstrument[t.instrument] = { trades: 0, wins: 0, losses: 0, pips: 0 };
    byInstrument[t.instrument].trades++;
    if (t.outcome === 'WIN') byInstrument[t.instrument].wins++;
    if (t.outcome === 'LOSS') byInstrument[t.instrument].losses++;
    byInstrument[t.instrument].pips += t.pips || 0;
  }

  // Group by month
  const byMonth = {};
  for (const t of trades) {
    const month = (t.time || '').slice(0, 7); // YYYY-MM
    if (!byMonth[month]) byMonth[month] = { trades: 0, wins: 0, losses: 0, pips: 0 };
    byMonth[month].trades++;
    if (t.outcome === 'WIN') byMonth[month].wins++;
    if (t.outcome === 'LOSS') byMonth[month].losses++;
    byMonth[month].pips += t.pips || 0;
  }

  // Equity curve (cumulative pips over time)
  const equityCurve = [];
  let cumPips = 0;
  const sortedTrades = [...trades].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  for (const t of sortedTrades) {
    cumPips += t.pips || 0;
    equityCurve.push({ time: t.time, pips: cumPips, instrument: t.instrument, outcome: t.outcome });
  }

  // Max drawdown
  let peak = 0;
  let maxDrawdown = 0;
  for (const pt of equityCurve) {
    peak = Math.max(peak, pt.pips);
    maxDrawdown = Math.max(maxDrawdown, peak - pt.pips);
  }

  // Average win/loss size
  const avgWin  = wins.length > 0 ? Math.round(wins.reduce((s, t) => s + t.pips, 0) / wins.length) : 0;
  const avgLoss = losses.length > 0 ? Math.round(losses.reduce((s, t) => s + t.pips, 0) / losses.length) : 0;

  // Profit factor
  const grossProfit = wins.reduce((s, t) => s + t.pips, 0);
  const grossLoss   = Math.abs(losses.reduce((s, t) => s + t.pips, 0));
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : grossProfit > 0 ? Infinity : 0;

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const result = {
    config: { from, to, instruments: instList.length, maxBars },
    duration_sec: parseFloat(elapsed),
    bars_replayed: timestamps.length,
    signal_counts: signalCounts,
    summary: {
      total_trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      breakevens: breakevens.length,
      timeouts: timeouts.length,
      win_rate: Math.round(winRate * 10) / 10,
      total_pips: totalPips,
      avg_win_pips: avgWin,
      avg_loss_pips: avgLoss,
      profit_factor: Math.round(profitFactor * 100) / 100,
      max_drawdown_pips: maxDrawdown,
    },
    by_instrument: byInstrument,
    by_month: byMonth,
    equity_curve: equityCurve,
    trades: sortedTrades.map(t => ({
      time: t.time,
      instrument: t.instrument,
      signal: t.signal,
      direction: t.direction,
      confidence: t.confidence,
      market_state: t.market_state,
      entry_price: t.entry_price,
      stop_loss: t.stop_loss,
      take_profit: t.take_profit,
      exit_price: t.exit_price,
      exit_time: t.exit_time,
      outcome: t.outcome,
      pips: t.pips,
      bars_held: t.bars_held,
      timeout: t.timeout || false,
    })),
  };

  console.log(`[BACKTEST] Done in ${elapsed}s — ${trades.length} trades, ${winRate.toFixed(1)}% win rate, ${totalPips} pips`);
  return result;
}

// ─── Store backtest result ───────────────────────────────────────────────────

async function saveBacktestResult(result) {
  const row = {
    run_date: new Date().toISOString(),
    date_from: result.config.from,
    date_to: result.config.to,
    instruments: result.config.instruments,
    bars_replayed: result.bars_replayed,
    total_trades: result.summary.total_trades,
    wins: result.summary.wins,
    losses: result.summary.losses,
    win_rate: result.summary.win_rate,
    total_pips: result.summary.total_pips,
    profit_factor: result.summary.profit_factor,
    max_drawdown: result.summary.max_drawdown_pips,
    avg_win: result.summary.avg_win_pips,
    avg_loss: result.summary.avg_loss_pips,
    duration_sec: result.duration_sec,
    details: {
      signal_counts: result.signal_counts,
      by_month: result.by_month,
      by_instrument: result.by_instrument,
    },
  };

  const { data, error } = await supabase
    .from('backtest_results')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    console.warn('[BACKTEST] Could not save result:', error.message);
    return null;
  }

  console.log(`[BACKTEST] Result saved with ID: ${data.id}`);
  return data.id;
}

module.exports = { runBacktest, saveBacktestResult, loadCandles, evaluateOutcome };
