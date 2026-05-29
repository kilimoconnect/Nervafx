'use strict';

/**
 * GET /api/pair-analysis?instrument=EUR_USD
 *
 * Returns 48h H1 candles + latest M15 candles for a signal pair detail view.
 * Pro+ plan required.
 */

const { cors, getClient } = require('./_db');
const { requirePlan }     = require('./_plan');

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

    const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const since6h  = new Date(Date.now() - 6  * 60 * 60 * 1000).toISOString();

    // Fetch 48h H1 candles and 6h M15 candles in parallel
    const [h1Res, m15Res, pairRes, signalRes] = await Promise.all([
      sb.from('backtest_candles')
        .select('time, open, high, low, close, volume')
        .eq('instrument', instrument)
        .eq('timeframe', 'H1')
        .eq('complete', true)
        .gte('time', since48h)
        .order('time', { ascending: true })
        .limit(48),

      sb.from('backtest_candles')
        .select('time, open, high, low, close, volume')
        .eq('instrument', instrument)
        .eq('timeframe', 'M15')
        .eq('complete', true)
        .gte('time', since6h)
        .order('time', { ascending: true })
        .limit(24),

      sb.from('energy_signal_pairs')
        .select('*')
        .eq('instrument', instrument)
        .eq('active', true)
        .limit(1),

      sb.from('trade_signals')
        .select('signal, entry_price, stop_loss, take_profit, risk_reward, reason, time')
        .eq('instrument', instrument)
        .order('time', { ascending: false })
        .limit(1),
    ]);

    if (h1Res.error) throw h1Res.error;
    if (m15Res.error) throw m15Res.error;

    const h1Candles  = (h1Res.data  || []).map(c => ({ ...c, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
    const m15Candles = (m15Res.data || []).map(c => ({ ...c, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
    const pair       = pairRes.data?.[0] || null;
    const signal     = signalRes.data?.[0] || null;

    // Compute price stats from H1 candles
    let priceStats = null;
    if (h1Candles.length >= 2) {
      const first = h1Candles[0];
      const last  = h1Candles[h1Candles.length - 1];
      const high48 = Math.max(...h1Candles.map(c => c.high));
      const low48  = Math.min(...h1Candles.map(c => c.low));
      const range48 = high48 - low48;
      const change  = last.close - first.open;
      const changePips = change * (instrument.includes('JPY') ? 100 : 10000);
      const avgVolume = h1Candles.reduce((s, c) => s + (c.volume || 0), 0) / h1Candles.length;

      priceStats = {
        open48:    first.open,
        close:     last.close,
        high48,
        low48,
        range48,
        rangePips: range48 * (instrument.includes('JPY') ? 100 : 10000),
        change,
        changePips: Math.round(changePips * 10) / 10,
        changeDir: change >= 0 ? 'UP' : 'DOWN',
        avgVolume: Math.round(avgVolume),
        candleCount: h1Candles.length,
      };
    }

    res.json({
      instrument,
      h1Candles,
      m15Candles,
      pair,
      signal,
      priceStats,
    });
  } catch (e) {
    console.error('[PAIR-ANALYSIS]', e.message);
    res.status(500).json({ error: e.message });
  }
};
