'use strict';

/**
 * GET /api/energy-hour?time=2026-06-10T08    (UTC hour key)
 *
 * Hour drill-down for energy bars. Returns everything that was driving the
 * market during that specific hour:
 *   - hour:       hourly_session_activity row (energy, cycle, momentum, etc.)
 *   - movers:     per-pair stats for that hour — net/range pips, efficiency,
 *                 DE (20-bar M15), volume, 3H/6H/12H spreads — ranked by activity
 *   - currencies: currency_strength snapshot at that hour (smooth 3H/6H/12H)
 *
 * GET /api/energy-hour?time=...&chart=EUR_USD
 *   Returns 48h of M15 candles ending at that hour (for the pair price chart).
 */

const { cors, getClient } = require('./_db');
const { requirePlan }     = require('./_plan');

const INSTRUMENTS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];

const pipSize = inst => inst.includes('JPY') ? 0.01 : 0.0001;

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'pro');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const timeParam = (req.query?.time || '').slice(0, 13); // YYYY-MM-DDTHH
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(timeParam)) {
      return res.status(400).json({ error: 'time required (YYYY-MM-DDTHH, UTC)' });
    }
    const hourStart = new Date(timeParam + ':00:00Z');
    const hourEnd   = new Date(hourStart.getTime() + 3600000);

    // ── Chart mode: 48h of M15 candles for one instrument ────────────────────
    const chartInst = req.query?.chart;
    if (chartInst) {
      if (!INSTRUMENTS.includes(chartInst)) return res.status(400).json({ error: 'invalid instrument' });
      // 36h before the hour + up to 12h after — so the post-hour follow-through is visible
      const from = new Date(hourEnd.getTime() - 36 * 3600000).toISOString();
      const to   = new Date(hourEnd.getTime() + 12 * 3600000).toISOString();
      const { data: candles, error } = await sb
        .from('backtest_candles')
        .select('time, open, high, low, close, volume')
        .eq('instrument', chartInst)
        .eq('timeframe', 'M15')
        .eq('complete', true)
        .gte('time', from)
        .lt('time', to)
        .order('time', { ascending: true })
        .limit(250);
      if (error) throw error;
      return res.json({
        instrument: chartInst,
        hourStart: hourStart.toISOString(),
        hourEnd: hourEnd.toISOString(),
        candles: candles || [],
      });
    }

    // ── 1. Hour activity row ──────────────────────────────────────────────────
    const { data: hourRows } = await sb
      .from('hourly_session_activity')
      .select('*')
      .gte('time_utc', hourStart.toISOString())
      .lt('time_utc', hourEnd.toISOString())
      .limit(1);
    const hour = hourRows?.[0] || null;

    // ── 2. Per-pair movers — M15 candles (20 bars ending at hour close) ──────
    const movers = [];
    const BATCH = 7;
    for (let i = 0; i < INSTRUMENTS.length; i += BATCH) {
      const batch = INSTRUMENTS.slice(i, i + BATCH);
      await Promise.all(batch.map(async (inst) => {
        const { data: candles } = await sb
          .from('backtest_candles')
          .select('time, open, high, low, close, volume')
          .eq('instrument', inst)
          .eq('timeframe', 'M15')
          .eq('complete', true)
          .lt('time', hourEnd.toISOString())
          .order('time', { ascending: false })
          .limit(20);
        if (!candles || candles.length < 4) return;

        const asc = candles.reverse().map(c => ({
          time: c.time,
          open: +c.open, high: +c.high, low: +c.low, close: +c.close,
          volume: +c.volume || 0,
        }));

        // Candles inside the selected hour
        const hourCandles = asc.filter(c =>
          new Date(c.time) >= hourStart && new Date(c.time) < hourEnd);
        if (!hourCandles.length) return;

        const ps = pipSize(inst);
        const hOpen  = hourCandles[0].open;
        const hClose = hourCandles[hourCandles.length - 1].close;
        const hHigh  = Math.max(...hourCandles.map(c => c.high));
        const hLow   = Math.min(...hourCandles.map(c => c.low));
        const hVol   = hourCandles.reduce((s, c) => s + c.volume, 0);

        const netPips   = (hClose - hOpen) / ps;
        const rangePips = (hHigh - hLow) / ps;
        const efficiency = rangePips > 0 ? Math.abs(netPips) / rangePips : 0;

        // DE over the 20-bar M15 window (same formula as de-history)
        const netMove = Math.abs(asc[asc.length - 1].close - asc[0].open);
        let travel = 0;
        for (const c of asc) travel += c.high - c.low;
        const de20 = travel > 0 ? Math.min(100, (netMove / travel) * 100) : 0;

        movers.push({
          instrument: inst,
          dir: netPips >= 0 ? 'UP' : 'DOWN',
          net_pips:   Math.round(netPips * 10) / 10,
          range_pips: Math.round(rangePips * 10) / 10,
          efficiency: Math.round(efficiency * 100),
          de20:       Math.round(de20),
          volume:     hVol,
          open: hOpen, close: hClose, high: hHigh, low: hLow,
        });
      }));
    }

    // Activity score = range weighted by how directional the move was
    for (const m of movers) {
      m.score = Math.round(m.range_pips * (0.5 + 0.5 * (m.efficiency / 100)) * 10) / 10;
    }
    movers.sort((a, b) => b.score - a.score);

    // ── 3. Pair spreads (3H/6H/12H) at that hour ──────────────────────────────
    let spreads = {};
    try {
      const { data: spreadTime } = await sb
        .from('pair_strength_spreads')
        .select('time')
        .lte('time', hourEnd.toISOString())
        .order('time', { ascending: false })
        .limit(1);
      if (spreadTime?.length) {
        const { data: spreadRows } = await sb
          .from('pair_strength_spreads')
          .select('instrument, spread_3h, spread_6h, spread_12h')
          .eq('time', spreadTime[0].time);
        for (const r of (spreadRows || [])) {
          spreads[r.instrument] = {
            spread_3h:  parseFloat(r.spread_3h)  || 0,
            spread_6h:  parseFloat(r.spread_6h)  || 0,
            spread_12h: parseFloat(r.spread_12h) || 0,
          };
        }
      }
    } catch (_) {}

    for (const m of movers) {
      const s = spreads[m.instrument] || {};
      m.spread_3h  = s.spread_3h  ?? null;
      m.spread_6h  = s.spread_6h  ?? null;
      m.spread_12h = s.spread_12h ?? null;
    }

    // ── 4. Currency strength snapshot at that hour ────────────────────────────
    let currencies = [];
    try {
      const { data: csTime } = await sb
        .from('currency_strength')
        .select('time')
        .lte('time', hourEnd.toISOString())
        .order('time', { ascending: false })
        .limit(1);
      if (csTime?.length) {
        const { data: csRows } = await sb
          .from('currency_strength')
          .select('currency, smooth_3h, smooth_6h, smooth_12h')
          .eq('time', csTime[0].time);
        currencies = (csRows || []).map(r => ({
          currency:   r.currency,
          smooth_3h:  parseFloat(r.smooth_3h)  || 0,
          smooth_6h:  parseFloat(r.smooth_6h)  || 0,
          smooth_12h: parseFloat(r.smooth_12h) || 0,
        }));
        currencies.sort((a, b) => b.smooth_3h - a.smooth_3h);
      }
    } catch (_) {}

    // ── 5. Active energy signal pairs (if any overlap this hour) ─────────────
    let signalPairs = [];
    try {
      const { data: spRows } = await sb
        .from('energy_signal_pairs')
        .select('instrument, dir, strong_ccy, weak_ccy, phase, de_combined')
        .eq('active', true);
      signalPairs = spRows || [];
    } catch (_) {}

    res.json({
      time: hourStart.toISOString(),
      hour,
      movers,
      currencies,
      signalPairs,
    });
  } catch (e) {
    console.error('[ENERGY-HOUR]', e.message);
    res.status(500).json({ error: e.message });
  }
};
