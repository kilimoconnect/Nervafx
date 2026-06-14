'use strict';

/**
 * GET /api/candle-dirs?days=7
 *
 * Returns H1 candle direction (BUY/SELL) for all pairs, keyed by instrument and hour.
 * BUY = close >= open, SELL = close < open.
 * Used by CS page to show previous-candle direction agreement.
 */

const { cors, getClient } = require('./_db');
const { requirePlan }     = require('./_plan');

const PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD',
  'CHF_JPY','CAD_JPY','CAD_CHF',
];

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'pro');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const days = Math.min(365, parseInt(req.query?.days || '7', 10) || 7);
    const from = new Date(Date.now() - days * 86400000).toISOString();

    const PAGE = 1000;
    const allRows = [];
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('backtest_candles')
        .select('instrument, time, open, close')
        .eq('timeframe', 'H1')
        .eq('complete', true)
        .gte('time', from)
        .in('instrument', PAIRS)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data || !data.length) break;
      allRows.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    const dirs = {};
    for (const r of allRows) {
      const hk = r.time.slice(0, 13);
      if (!dirs[r.instrument]) dirs[r.instrument] = {};
      dirs[r.instrument][hk] = (+r.close >= +r.open) ? 1 : -1;
    }

    res.json({ dirs });
  } catch (e) {
    console.error('[CANDLE-DIRS]', e.message);
    res.status(500).json({ error: e.message });
  }
};
