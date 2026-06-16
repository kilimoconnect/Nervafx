'use strict';

/**
 * GET /api/pair-analysis?instrument=EUR_USD
 *
 * Returns 48h H1 candles + latest M15 candles for a signal pair detail view.
 * Premium plan required.
 *
 * Trade levels (Entry/SL/TP/Lot) are personalized per user from their profile
 * settings (min_rr, account_size, risk%). Levels only appear if a signal email
 * was already sent for this pair today — the modal is a reference tool, not the
 * primary alert.
 */

const { cors, getClient } = require('./_db');
const { requirePlan }     = require('./_plan');

function getPipSize(inst)  { return inst.includes('JPY') ? 0.01 : 0.0001; }
function pipValueUSD(inst, entry) {
  const quote = inst.split('_')[1];
  const ps    = getPipSize(inst);
  if (quote === 'USD') return ps * 100000;
  if (quote === 'JPY') return (ps / entry) * 100000;
  return ps * 100000;
}
function calcLotSize(inst, riskAmt, stopDist, entry) {
  const ps = getPipSize(inst);
  const stopPips = stopDist / ps;
  if (stopPips <= 0) return null;
  const pv = pipValueUSD(inst, entry);
  return Math.max(0.01, Math.round((riskAmt / (stopPips * pv)) * 100) / 100);
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const instrument = req.query.instrument;
    if (!instrument) return res.status(400).json({ error: 'instrument required' });

    const userId   = gate.user?.id;
    const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const since6h  = new Date(Date.now() - 6  * 60 * 60 * 1000).toISOString();
    const todayKey = new Date().toISOString().slice(0, 10);
    const signalKey = `signal_${instrument}_${todayKey}`;

    // Fetch all data in parallel
    const [h1Res, m15Res, pairRes, profileRes, alertLogRes] = await Promise.all([
      sb.from('backtest_candles')
        .select('time, open, high, low, close, volume')
        .eq('instrument', instrument).eq('timeframe', 'H1').eq('complete', true)
        .gte('time', since48h).order('time', { ascending: true }).limit(48),

      sb.from('backtest_candles')
        .select('time, open, high, low, close, volume')
        .eq('instrument', instrument).eq('timeframe', 'M15').eq('complete', true)
        .gte('time', since6h).order('time', { ascending: true }).limit(24),

      sb.from('energy_signal_pairs')
        .select('*').eq('instrument', instrument).eq('active', true).limit(1),

      userId ? sb.from('profiles')
        .select('account_size, max_daily_risk_pct, max_trades, min_rr')
        .eq('id', userId).limit(1) : Promise.resolve({ data: [] }),

      // Check if signal email was sent for this pair today
      sb.from('email_alert_log')
        .select('id').eq('alert_type', signalKey).limit(1),
    ]);

    if (h1Res.error) throw h1Res.error;
    if (m15Res.error) throw m15Res.error;

    const h1Candles  = (h1Res.data  || []).map(c => ({ ...c, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
    const m15Candles = (m15Res.data || []).map(c => ({ ...c, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
    const pair       = pairRes.data?.[0] || null;
    const profile    = profileRes.data?.[0] || {};
    const signalSent = alertLogRes.data?.length > 0;

    // ── Personalized trade levels (only if signal email was sent today) ──
    let tradeLevels = null;
    if (signalSent && pair && h1Candles.length >= 2 && (pair.phase === 'ENTRY' || pair.phase === 'MOVING')) {
      const userRR      = parseFloat(profile.min_rr) || 2.0;
      let   accountSize = parseFloat(profile.account_size) || 10000;
      const maxDailyPct = parseFloat(profile.max_daily_risk_pct) || 2;

      // Prefer broker balance when EA connected
      if (userId) {
        const { data: eaAcct } = await sb
          .from('ea_accounts')
          .select('balance, last_heartbeat')
          .eq('user_id', userId)
          .single();
        if (eaAcct?.balance > 0 && (Date.now() - new Date(eaAcct.last_heartbeat).getTime()) < 60000) {
          accountSize = eaAcct.balance;
        }
      }
      const maxTrades   = parseInt(profile.max_trades) || 3;
      const riskPercent = (maxDailyPct / 100) / maxTrades;
      const riskAmount  = accountSize * riskPercent;

      // Entry = close of most recent completed candle
      // SL = swing low/high of last 2 candles
      const recent2 = h1Candles.slice(-2);
      const entry   = recent2[recent2.length - 1].close;
      const dir     = pair.dir === 'BUY' ? 1 : -1;

      let stopLoss;
      if (pair.dir === 'BUY') {
        stopLoss = Math.min(...recent2.map(c => c.low));
      } else {
        stopLoss = Math.max(...recent2.map(c => c.high));
      }

      const stopDist = Math.abs(entry - stopLoss);
      const tp       = stopDist > 0 ? entry + (dir * stopDist * userRR) : 0;
      const lotSize  = stopDist > 0 ? calcLotSize(instrument, riskAmount, stopDist, entry) : null;

      tradeLevels = {
        entry_price:  entry,
        stop_loss:    stopLoss,
        take_profit:  tp,
        risk_reward:  userRR,
        lot_size:     lotSize,
        risk_amount:  Math.round(riskAmount * 100) / 100,
        account_size: accountSize,
      };
    }

    // ── Price stats from H1 candles ──
    let priceStats = null;
    if (h1Candles.length >= 2) {
      const first = h1Candles[0];
      const last  = h1Candles[h1Candles.length - 1];
      const high48 = Math.max(...h1Candles.map(c => c.high));
      const low48  = Math.min(...h1Candles.map(c => c.low));
      const range48 = high48 - low48;
      const change  = last.close - first.open;
      const pipMul  = instrument.includes('JPY') ? 100 : 10000;
      const avgVol  = h1Candles.reduce((s, c) => s + (c.volume || 0), 0) / h1Candles.length;

      priceStats = {
        open48: first.open, close: last.close, high48, low48, range48,
        rangePips: Math.round(range48 * pipMul * 10) / 10,
        changePips: Math.round(change * pipMul * 10) / 10,
        changeDir: change >= 0 ? 'UP' : 'DOWN',
        avgVolume: Math.round(avgVol),
        candleCount: h1Candles.length,
      };
    }

    res.json({
      instrument,
      h1Candles,
      m15Candles,
      pair,
      tradeLevels,
      signalSent,
      priceStats,
    });
  } catch (e) {
    console.error('[PAIR-ANALYSIS]', e.message);
    res.status(500).json({ error: e.message });
  }
};
