const { config } = require('./config');
const { supabase } = require('./supabase');

// ─── Load all user profiles ───────────────────────────────────────────────────
// Multi-user: each profile gets its own risk check run every cycle.

async function loadAllProfiles() {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, account_size, max_daily_risk_pct, max_trades, min_rr');

    if (error || !data || data.length === 0) return [];
    return data;
  } catch (_) {
    return [];
  }
}

// Merge profile settings over config defaults
function buildRiskConfig(profile) {
  const accountBalance      = parseFloat(profile?.account_size)       || config.risk.accountBalance;
  const maxDailyLossPercent = (parseFloat(profile?.max_daily_risk_pct) / 100) || config.risk.maxDailyLossPercent;
  const maxOpenTrades       = parseInt(profile?.max_trades)            || config.risk.maxOpenTrades;
  const minRR               = parseFloat(profile?.min_rr)              || config.risk.minRR;

  return {
    userId:              profile?.id ?? null,
    accountBalance:      accountBalance      > 0 ? accountBalance      : config.risk.accountBalance,
    maxDailyLossPercent: maxDailyLossPercent > 0 ? maxDailyLossPercent : config.risk.maxDailyLossPercent,
    maxOpenTrades:       maxOpenTrades       > 0 ? maxOpenTrades       : config.risk.maxOpenTrades,
    minRR:               minRR              > 0 ? minRR               : config.risk.minRR,
    riskPercent:         config.risk.riskPercent,
    minConfidence:       config.risk.minConfidence,
  };
}

// ─── Position size ────────────────────────────────────────────────────────────

function getPipSize(instrument) {
  return instrument.includes('JPY') ? 0.01 : 0.0001;
}

function pipValueUSD(instrument, entryPrice) {
  const quote   = instrument.split('_')[1];
  const pipSize = getPipSize(instrument);
  if (quote === 'USD') return pipSize * 100000;
  if (quote === 'JPY') return (pipSize / entryPrice) * 100000;
  return pipSize * 100000;
}

function calcPositionSize(instrument, riskAmount, stopDistance, entryPrice) {
  const pipSize = getPipSize(instrument);
  const stopPips = stopDistance / pipSize;
  if (stopPips <= 0) return null;
  const pipVal = pipValueUSD(instrument, entryPrice);
  const lots   = riskAmount / (stopPips * pipVal);
  return Math.max(0.01, Math.round(lots * 100) / 100);
}

// ─── Daily state (per user) ───────────────────────────────────────────────────

function dayBounds(isoTime) {
  const d     = new Date(isoTime);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const end   = new Date(start.getTime() + 86400000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function getDailyState(time, userId) {
  const { start, end } = dayBounds(time);

  let query = supabase
    .from('risk_checks')
    .select('instrument, risk_amount, status')
    .eq('status', 'APPROVED')
    .gte('time', start)
    .lt('time', end);

  if (userId) query = query.eq('user_id', userId);

  const { data, error } = await query;
  if (error) throw new Error(`Daily state fetch error: ${error.message}`);

  const rows              = data || [];
  const dailyRiskUsed     = rows.reduce((sum, r) => sum + parseFloat(r.risk_amount), 0);
  const openTradesCount   = rows.length;
  const pairsTradedToday  = new Set(rows.map(r => r.instrument));

  return { dailyRiskUsed, openTradesCount, pairsTradedToday };
}

// ─── Core check ───────────────────────────────────────────────────────────────

function reject(signal, reason, rc) {
  return {
    user_id:         rc.userId,
    signal_id:       signal.id || null,
    time:            signal.time,
    instrument:      signal.instrument,
    account_balance: rc.accountBalance,
    risk_percent:    rc.riskPercent * 100,
    risk_amount:     rc.accountBalance * rc.riskPercent,
    entry_price:     signal.entry_price  || 0,
    stop_loss:       signal.stop_loss    || 0,
    take_profit:     signal.take_profit  || 0,
    stop_distance:   signal.entry_price && signal.stop_loss
      ? Math.abs(signal.entry_price - signal.stop_loss) : 0,
    position_size:   null,
    status:          'REJECTED',
    reject_reason:   reason,
  };
}

function approve(signal, riskAmount, stopDistance, positionSize, rc) {
  return {
    user_id:         rc.userId,
    signal_id:       signal.id || null,
    time:            signal.time,
    instrument:      signal.instrument,
    account_balance: rc.accountBalance,
    risk_percent:    rc.riskPercent * 100,
    risk_amount:     riskAmount,
    entry_price:     signal.entry_price,
    stop_loss:       signal.stop_loss,
    take_profit:     signal.take_profit,
    stop_distance:   stopDistance,
    position_size:   positionSize,
    status:          'APPROVED',
    reject_reason:   null,
  };
}

async function checkSignal(signal, dailyState, rc) {
  const { dailyRiskUsed, openTradesCount, pairsTradedToday } = dailyState;

  if (signal.signal !== 'BUY' && signal.signal !== 'SELL')
    return reject(signal, `Signal is ${signal.signal}, not BUY or SELL.`, rc);

  if (signal.confidence < rc.minConfidence)
    return reject(signal, `Confidence ${signal.confidence} below minimum ${rc.minConfidence}.`, rc);

  if (!signal.risk_reward || signal.risk_reward < rc.minRR)
    return reject(signal, `RR ${signal.risk_reward} below minimum ${rc.minRR}.`, rc);

  if (signal.market_state !== 'READY_TO_ENTER')
    return reject(signal, `Market state is ${signal.market_state}, not READY_TO_ENTER.`, rc);

  if (!signal.entry_price || !signal.stop_loss || !signal.take_profit)
    return reject(signal, 'Missing entry, stop loss, or take profit.', rc);

  const stopDistance = Math.abs(signal.entry_price - signal.stop_loss);
  if (stopDistance <= 0)
    return reject(signal, 'Stop distance is zero or negative.', rc);

  const dailyLossPct = dailyRiskUsed / rc.accountBalance;
  if (dailyLossPct >= rc.maxDailyLossPercent)
    return reject(signal, `Daily risk limit reached: ${(dailyLossPct * 100).toFixed(2)}% of ${(rc.maxDailyLossPercent * 100).toFixed(1)}%.`, rc);

  if (openTradesCount >= rc.maxOpenTrades)
    return reject(signal, `Max open trades (${rc.maxOpenTrades}) already reached today.`, rc);

  if (pairsTradedToday.has(signal.instrument))
    return reject(signal, `${signal.instrument} already has an approved trade today.`, rc);

  const riskAmount   = rc.accountBalance * rc.riskPercent;
  const positionSize = calcPositionSize(signal.instrument, riskAmount, stopDistance, signal.entry_price);

  return approve(signal, riskAmount, stopDistance, positionSize, rc);
}

// ─── Batch insert ─────────────────────────────────────────────────────────────

async function upsertRiskChecks(rows) {
  if (rows.length === 0) return;
  const { error } = await supabase.from('risk_checks').insert(rows);
  if (error) throw new Error(`Risk check insert error: ${error.message}`);
}

// ─── Incremental (runs every cron cycle) ─────────────────────────────────────

async function checkLatestSignals() {
  const profiles = await loadAllProfiles();

  if (profiles.length === 0) {
    console.log('[RISK] No user profiles found — skipping risk checks.');
    return [];
  }

  // Fetch the latest BUY/SELL signals (shared market data)
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

  const latest = signals.filter(s => s.time === latestTime);
  const allRows = [];

  // Run risk checks independently for every registered user
  for (const profile of profiles) {
    const rc         = buildRiskConfig(profile);
    const dailyState = await getDailyState(latestTime, rc.userId);
    const rows       = [];

    for (const signal of latest) {
      const result = await checkSignal(signal, dailyState, rc);
      rows.push(result);

      if (result.status === 'APPROVED') {
        dailyState.dailyRiskUsed += result.risk_amount;
        dailyState.openTradesCount++;
        dailyState.pairsTradedToday.add(signal.instrument);
      }
    }

    const approved = rows.filter(r => r.status === 'APPROVED').length;
    const rejected = rows.filter(r => r.status === 'REJECTED').length;
    console.log(`[RISK] user:${rc.userId} balance:$${rc.accountBalance} maxTrades:${rc.maxOpenTrades} → ${approved} approved, ${rejected} rejected`);

    allRows.push(...rows);
  }

  await upsertRiskChecks(allRows);
  return allRows;
}

// ─── Backfill ─────────────────────────────────────────────────────────────────

async function backfillRiskChecks() {
  const profiles = await loadAllProfiles();

  if (profiles.length === 0) {
    console.log('[RISK] No user profiles found — nothing to backfill.');
    return { total: 0, approved: 0, rejected: 0 };
  }

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

  console.log(`[RISK] Backfilling ${signals.length} signals for ${profiles.length} user(s)...`);

  let totalApproved = 0;
  let totalRejected = 0;
  const allRows = [];

  function getDailyKey(time) {
    const d = new Date(time);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  }

  for (const profile of profiles) {
    const rc             = buildRiskConfig(profile);
    const dailyStateCache = {};

    for (const signal of signals) {
      const key = getDailyKey(signal.time);
      if (!dailyStateCache[key]) {
        dailyStateCache[key] = { dailyRiskUsed: 0, openTradesCount: 0, pairsTradedToday: new Set() };
      }
      const dailyState = dailyStateCache[key];

      const result = await checkSignal(signal, dailyState, rc);
      allRows.push(result);

      if (result.status === 'APPROVED') {
        totalApproved++;
        dailyState.dailyRiskUsed     += result.risk_amount;
        dailyState.openTradesCount++;
        dailyState.pairsTradedToday.add(signal.instrument);
      } else {
        totalRejected++;
      }
    }

    console.log(`[RISK] Backfill user:${rc.userId} balance:$${rc.accountBalance} maxTrades:${rc.maxOpenTrades}`);
  }

  await upsertRiskChecks(allRows);
  console.log(`[RISK] Backfill done. Total approved: ${totalApproved}, rejected: ${totalRejected}`);
  return { total: allRows.length, approved: totalApproved, rejected: totalRejected };
}

// ─── Display ──────────────────────────────────────────────────────────────────

async function printRiskReport(userId = null) {
  let query = supabase
    .from('risk_checks')
    .select('*')
    .order('time', { ascending: false })
    .limit(56);

  if (userId) query = query.eq('user_id', userId);

  const { data, error } = await query;
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

  const totalRisk = approved.reduce((s, r) => s + parseFloat(r.risk_amount), 0);
  console.log(`\nTotal approved: ${approved.length} | Total risk committed: $${totalRisk.toFixed(2)}`);
}

module.exports = { backfillRiskChecks, checkLatestSignals, printRiskReport };
