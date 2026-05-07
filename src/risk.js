const { config } = require('./config');
const { supabase } = require('./supabase');

const { riskPercent, maxDailyLossPercent, maxOpenTrades, minRR, minConfidence } = config.risk;

// ─── Position size ────────────────────────────────────────────────────────────

function getPipSize(instrument) {
  return instrument.includes('JPY') ? 0.01 : 0.0001;
}

// Approximate pip value in USD per standard lot (100,000 units).
// Refined per-broker conversion can replace this later.
function pipValueUSD(instrument, entryPrice) {
  const quote = instrument.split('_')[1];
  const pipSize = getPipSize(instrument);

  if (quote === 'USD') return pipSize * 100000;              // EUR_USD etc: $10/pip/lot
  if (quote === 'JPY') return (pipSize / entryPrice) * 100000; // USD_JPY etc: ~$9xx/pip/lot
  return pipSize * 100000; // Cross pairs: approximate, needs FX conversion for precision
}

function calcPositionSize(instrument, riskAmount, stopDistance, entryPrice) {
  const pipSize = getPipSize(instrument);
  const stopPips = stopDistance / pipSize;
  if (stopPips <= 0) return null;

  const pipVal = pipValueUSD(instrument, entryPrice);
  const lots = riskAmount / (stopPips * pipVal);
  return Math.max(0.01, Math.round(lots * 100) / 100); // floor at 0.01 micro lots
}

// ─── Daily state queries ──────────────────────────────────────────────────────

function dayBounds(isoTime) {
  const d = new Date(isoTime);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const end = new Date(start.getTime() + 86400000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function getDailyState(time) {
  const { start, end } = dayBounds(time);

  const { data, error } = await supabase
    .from('risk_checks')
    .select('instrument, risk_amount, status')
    .eq('status', 'APPROVED')
    .gte('time', start)
    .lt('time', end);

  if (error) throw new Error(`Daily state fetch error: ${error.message}`);

  const rows = data || [];
  const dailyRiskUsed = rows.reduce((sum, r) => sum + parseFloat(r.risk_amount), 0);
  const openTradesCount = rows.length;
  const pairsTradedToday = new Set(rows.map(r => r.instrument));

  return { dailyRiskUsed, openTradesCount, pairsTradedToday };
}

// ─── Core check ───────────────────────────────────────────────────────────────

function reject(signal, reason) {
  return {
    signal_id: signal.id || null,
    time: signal.time,
    instrument: signal.instrument,
    account_balance: config.risk.accountBalance,
    risk_percent: riskPercent * 100,
    risk_amount: config.risk.accountBalance * riskPercent,
    entry_price: signal.entry_price || 0,
    stop_loss: signal.stop_loss || 0,
    take_profit: signal.take_profit || 0,
    stop_distance: signal.entry_price && signal.stop_loss
      ? Math.abs(signal.entry_price - signal.stop_loss) : 0,
    position_size: null,
    status: 'REJECTED',
    reject_reason: reason,
  };
}

function approve(signal, riskAmount, stopDistance, positionSize) {
  return {
    signal_id: signal.id || null,
    time: signal.time,
    instrument: signal.instrument,
    account_balance: config.risk.accountBalance,
    risk_percent: riskPercent * 100,
    risk_amount: riskAmount,
    entry_price: signal.entry_price,
    stop_loss: signal.stop_loss,
    take_profit: signal.take_profit,
    stop_distance: stopDistance,
    position_size: positionSize,
    status: 'APPROVED',
    reject_reason: null,
  };
}

async function checkSignal(signal, dailyState) {
  const accountBalance = config.risk.accountBalance;
  const { dailyRiskUsed, openTradesCount, pairsTradedToday } = dailyState;

  // Only process BUY/SELL signals
  if (signal.signal !== 'BUY' && signal.signal !== 'SELL') {
    return reject(signal, `Signal is ${signal.signal}, not BUY or SELL.`);
  }

  // Confidence gate
  if (signal.confidence < minConfidence) {
    return reject(signal, `Confidence ${signal.confidence} below minimum ${minConfidence}.`);
  }

  // Risk:reward gate
  if (!signal.risk_reward || signal.risk_reward < minRR) {
    return reject(signal, `RR ${signal.risk_reward} below minimum ${minRR}.`);
  }

  // Market state gate
  if (signal.market_state !== 'READY_TO_ENTER') {
    return reject(signal, `Market state is ${signal.market_state}, not READY_TO_ENTER.`);
  }

  // Entry / stop validity
  if (!signal.entry_price || !signal.stop_loss || !signal.take_profit) {
    return reject(signal, 'Missing entry, stop loss, or take profit.');
  }

  const stopDistance = Math.abs(signal.entry_price - signal.stop_loss);
  if (stopDistance <= 0) {
    return reject(signal, 'Stop distance is zero or negative.');
  }

  // Daily loss limit
  const dailyLossPct = dailyRiskUsed / accountBalance;
  if (dailyLossPct >= maxDailyLossPercent) {
    return reject(signal, `Daily risk limit reached: ${(dailyLossPct * 100).toFixed(2)}% of ${maxDailyLossPercent * 100}%.`);
  }

  // Max open trades
  if (openTradesCount >= maxOpenTrades) {
    return reject(signal, `Max open trades (${maxOpenTrades}) already reached today.`);
  }

  // One trade per pair per day
  if (pairsTradedToday.has(signal.instrument)) {
    return reject(signal, `${signal.instrument} already has an approved trade today.`);
  }

  // Calculate risk
  const riskAmount = accountBalance * riskPercent;
  const positionSize = calcPositionSize(signal.instrument, riskAmount, stopDistance, signal.entry_price);

  return approve(signal, riskAmount, stopDistance, positionSize);
}

// ─── Batch processing ─────────────────────────────────────────────────────────

async function upsertRiskChecks(rows) {
  if (rows.length === 0) return;
  // risk_checks has no unique constraint (multiple checks per signal possible), so insert only.
  const { error } = await supabase
    .from('risk_checks')
    .insert(rows);
  if (error) throw new Error(`Risk check insert error: ${error.message}`);
}

// ─── Backfill ─────────────────────────────────────────────────────────────────

async function backfillRiskChecks() {
  console.log('[RISK] Fetching BUY/SELL signals...');

  const { data: signals, error } = await supabase
    .from('trade_signals')
    .select('*')
    .in('signal', ['BUY', 'SELL'])
    .order('time', { ascending: true });

  if (error) throw new Error(`Signal fetch error: ${error.message}`);
  if (!signals || signals.length === 0) {
    console.log('[RISK] No BUY/SELL signals found.');
    return { total: 0, approved: 0, rejected: 0 };
  }

  console.log(`[RISK] Processing ${signals.length} BUY/SELL signals...`);

  // Group by UTC day and process in order — each day's approvals affect subsequent checks.
  // We rebuild daily state per signal in chronological order.
  const dailyStateCache = {};

  function getDailyKey(time) {
    const d = new Date(time);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  }

  function initDay() {
    return { dailyRiskUsed: 0, openTradesCount: 0, pairsTradedToday: new Set() };
  }

  const rows = [];
  let approved = 0;
  let rejected = 0;

  for (const signal of signals) {
    const key = getDailyKey(signal.time);
    if (!dailyStateCache[key]) dailyStateCache[key] = initDay();
    const dailyState = dailyStateCache[key];

    const result = await checkSignal(signal, dailyState);
    rows.push(result);

    if (result.status === 'APPROVED') {
      approved++;
      dailyState.dailyRiskUsed += result.risk_amount;
      dailyState.openTradesCount++;
      dailyState.pairsTradedToday.add(signal.instrument);
    } else {
      rejected++;
    }
  }

  await upsertRiskChecks(rows);
  console.log(`[RISK] Backfill done. Approved: ${approved}, Rejected: ${rejected}`);
  return { total: rows.length, approved, rejected };
}

// ─── Incremental ──────────────────────────────────────────────────────────────

async function checkLatestSignals() {
  const { data: signals, error } = await supabase
    .from('trade_signals')
    .select('*')
    .in('signal', ['BUY', 'SELL'])
    .order('time', { ascending: false })
    .limit(28);

  if (error) throw new Error(`Signal fetch error: ${error.message}`);

  const latestTime = signals && signals.length > 0 ? signals[0].time : null;
  if (!latestTime) {
    console.log('[RISK] No active BUY/SELL signals to check.');
    return [];
  }

  // Only process signals from the latest candle time
  const latest = signals.filter(s => s.time === latestTime);
  const dailyState = await getDailyState(latestTime);
  const rows = [];

  for (const signal of latest) {
    const result = await checkSignal(signal, dailyState);
    rows.push(result);

    if (result.status === 'APPROVED') {
      dailyState.dailyRiskUsed += result.risk_amount;
      dailyState.openTradesCount++;
      dailyState.pairsTradedToday.add(signal.instrument);
    }
  }

  await upsertRiskChecks(rows);
  console.log(`[RISK] ${rows.filter(r => r.status === 'APPROVED').length} approved, ${rows.filter(r => r.status === 'REJECTED').length} rejected`);
  return rows;
}

// ─── Display ──────────────────────────────────────────────────────────────────

async function printRiskReport() {
  const { data, error } = await supabase
    .from('risk_checks')
    .select('*')
    .order('time', { ascending: false })
    .limit(56);

  if (error) throw new Error(error.message);

  const approved = (data || []).filter(r => r.status === 'APPROVED');
  const rejected = (data || []).filter(r => r.status === 'REJECTED');

  console.log('\n=== APPROVED TRADES ===');
  if (approved.length === 0) console.log('  None');
  for (const r of approved) {
    console.log(
      `  ${r.instrument.padEnd(8)} entry:${Number(r.entry_price).toFixed(5)}  SL:${Number(r.stop_loss).toFixed(5)}  TP:${Number(r.take_profit).toFixed(5)}  size:${r.position_size} lots  risk:$${Number(r.risk_amount).toFixed(2)}`
    );
  }

  console.log('\n=== REJECTED ===');
  if (rejected.length === 0) console.log('  None');
  for (const r of rejected.slice(0, 10)) {
    console.log(`  ${r.instrument.padEnd(8)} ${r.reject_reason}`);
  }
  if (rejected.length > 10) console.log(`  ... and ${rejected.length - 10} more`);

  const totalApproved = approved.length;
  const totalRisk = approved.reduce((s, r) => s + parseFloat(r.risk_amount), 0);
  console.log(`\nTotal approved: ${totalApproved} | Total risk committed: $${totalRisk.toFixed(2)}`);
}

module.exports = { backfillRiskChecks, checkLatestSignals, printRiskReport };
