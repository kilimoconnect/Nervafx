const { config } = require('./config');
const { supabase } = require('./supabase');

const ACTION_MODE = process.env.ACTION_MODE || 'ALERT_ONLY';
// Modes: ALERT_ONLY | PAPER_TRADE | DEMO_EXECUTE | LIVE_EXECUTE

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function formatAlertMessage(riskCheck, signal) {
  const dir = signal.signal === 'BUY' ? '🟢 BUY' : '🔴 SELL';
  const rr = riskCheck.risk_reward || 2.0;
  return [
    `<b>NervaFX Signal</b>`,
    `${dir} <b>${riskCheck.instrument}</b>`,
    ``,
    `Entry:      ${Number(riskCheck.entry_price).toFixed(5)}`,
    `Stop Loss:  ${Number(riskCheck.stop_loss).toFixed(5)}`,
    `Take Profit: ${Number(riskCheck.take_profit).toFixed(5)}`,
    `Size:       ${riskCheck.position_size} lots`,
    `Risk:       $${Number(riskCheck.risk_amount).toFixed(2)} (${riskCheck.risk_percent}%)`,
    `RR:         1:${rr}`,
    `Confidence: ${signal.confidence}`,
    ``,
    `<i>${signal.reason || ''}</i>`,
  ].join('\n');
}

// ─── OANDA execution ──────────────────────────────────────────────────────────

async function placeOandaOrder(riskCheck, signal) {
  const units = signal.signal === 'BUY'
    ? Math.round(riskCheck.position_size * 100000)
    : -Math.round(riskCheck.position_size * 100000);

  const instrument = riskCheck.instrument;
  const pipSize = instrument.includes('JPY') ? 0.01 : 0.0001;
  const decimals = instrument.includes('JPY') ? 3 : 5;

  const body = {
    order: {
      type: 'MARKET',
      instrument,
      units: String(units),
      stopLossOnFill: { price: Number(riskCheck.stop_loss).toFixed(decimals) },
      takeProfitOnFill: { price: Number(riskCheck.take_profit).toFixed(decimals) },
      timeInForce: 'FOK',
      positionFill: 'DEFAULT',
    },
  };

  const res = await fetch(
    `${config.oanda.baseUrl}/v3/accounts/${config.oanda.accountId}/orders`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.oanda.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  const data = await res.json();
  if (!res.ok) throw new Error(data.errorMessage || JSON.stringify(data));
  return data;
}

// ─── Pre-execution guard ──────────────────────────────────────────────────────

async function verifyStillValid(riskCheck, signal) {
  // Re-check risk status hasn't changed
  if (riskCheck.status !== 'APPROVED') return { valid: false, reason: 'Risk check not APPROVED.' };
  if (!signal || (signal.signal !== 'BUY' && signal.signal !== 'SELL')) {
    return { valid: false, reason: 'Signal is no longer BUY or SELL.' };
  }

  // No duplicate open action for same instrument today
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString();
  const { data } = await supabase
    .from('trade_actions')
    .select('id')
    .eq('instrument', riskCheck.instrument)
    .eq('status', 'SENT')
    .gte('time', start)
    .limit(1);

  if (data && data.length > 0) return { valid: false, reason: `Duplicate action for ${riskCheck.instrument} today.` };

  return { valid: true };
}

// ─── Core action builder ──────────────────────────────────────────────────────

async function processApprovedRiskCheck(riskCheck, signal) {
  const guard = await verifyStillValid(riskCheck, signal);

  const base = {
    risk_check_id: riskCheck.id,
    signal_id: riskCheck.signal_id,
    time: riskCheck.time,
    instrument: riskCheck.instrument,
    action_type: ACTION_MODE,
    direction: signal.direction,
    entry_price: riskCheck.entry_price,
    stop_loss: riskCheck.stop_loss,
    take_profit: riskCheck.take_profit,
    position_size: riskCheck.position_size,
  };

  if (!guard.valid) {
    return { ...base, status: 'SKIPPED', message: guard.reason, broker_order_id: null, error_message: guard.reason };
  }

  const message = formatAlertMessage(riskCheck, signal);

  if (ACTION_MODE === 'ALERT_ONLY' || ACTION_MODE === 'PAPER_TRADE') {
    const sent = await sendTelegram(message);
    console.log(`[ACTION] ${riskCheck.instrument} ${signal.signal} — ${ACTION_MODE} ${sent ? '(Telegram ✓)' : '(no Telegram)'}`);
    console.log(message.replace(/<[^>]+>/g, ''));
    return { ...base, status: 'SENT', message };
  }

  if (ACTION_MODE === 'DEMO_EXECUTE' || ACTION_MODE === 'LIVE_EXECUTE') {
    try {
      const oandaRes = await placeOandaOrder(riskCheck, signal);
      const orderId = oandaRes.orderFillTransaction?.id || oandaRes.orderCreateTransaction?.id || null;
      await sendTelegram(message);
      console.log(`[ACTION] ${riskCheck.instrument} order placed. OANDA ID: ${orderId}`);
      return { ...base, status: 'EXECUTED', message, broker_order_id: orderId };
    } catch (err) {
      console.error(`[ACTION] OANDA order failed for ${riskCheck.instrument}: ${err.message}`);
      return { ...base, status: 'FAILED', message, error_message: err.message };
    }
  }

  return { ...base, status: 'SKIPPED', message: `Unknown mode: ${ACTION_MODE}` };
}

async function upsertActions(rows) {
  if (rows.length === 0) return;
  const { error } = await supabase.from('trade_actions').insert(rows);
  if (error) throw new Error(`Action insert error: ${error.message}`);
}

// ─── Run for latest approved checks ──────────────────────────────────────────

async function processLatestActions() {
  // Get latest approved risk checks
  const { data: checks, error } = await supabase
    .from('risk_checks')
    .select('*')
    .eq('status', 'APPROVED')
    .order('time', { ascending: false })
    .limit(28);

  if (error) throw new Error(error.message);
  if (!checks || checks.length === 0) return [];

  const latestTime = checks[0].time;
  const latest = checks.filter(c => c.time === latestTime);

  const rows = [];
  for (const check of latest) {
    // Fetch the linked signal
    const { data: sigs } = await supabase
      .from('trade_signals')
      .select('*')
      .eq('id', check.signal_id)
      .single();

    const row = await processApprovedRiskCheck(check, sigs);
    rows.push(row);
  }

  await upsertActions(rows);
  return rows;
}

module.exports = { processLatestActions, sendTelegram, formatAlertMessage };
