// api/m15-spreads.js — Latest M15 pair spreads + Directional Efficiency
//
// Weighted ranking mirrors api/spreads.js but uses M15 lookback columns:
//   40% smooth_180m  (trend / longest lookback)
//   35% smooth_90m   (medium-term pressure)
//   15% smooth_45m   (short-term momentum)
//   10% acceleration (|smooth_45m| - |smooth_90m| when positive → spread widening)
//
// Directional Efficiency (DE):
//   net_move / total_travel × 100 — measures movement quality (institutional vs noisy)
//   Combined: 0.40 × M15_DE + 0.60 × H1_DE (H1 dominates — less noise, cleaner structure)

const { getClient, getLatestTime, cors } = require('./_db');
const { requirePlan } = require('./_plan');

function weightedScore(s) {
  const s180 = parseFloat(s.smooth_180m) || 0;
  const s90  = parseFloat(s.smooth_90m)  || 0;
  const s45  = parseFloat(s.smooth_45m)  || 0;
  const accel = Math.abs(s45) - Math.abs(s90); // positive = spread accelerating
  return Math.abs(s180) * 0.40
       + Math.abs(s90)  * 0.35
       + Math.abs(s45)  * 0.15
       + Math.max(accel, 0) * 0.10;
}

/**
 * Compute Directional Efficiency from raw candles.
 * DE = (|final_close - initial_open| / sum(high - low)) × 100
 * @param {Array} candles - sorted ascending by time, each { open, high, low, close }
 * @returns {number} 0-100
 */
function computeDE(candles) {
  if (!candles || candles.length < 2) return 0;
  const netMove = Math.abs(candles[candles.length - 1].close - candles[0].open);
  let totalTravel = 0;
  for (const c of candles) {
    totalTravel += c.high - c.low;
  }
  if (totalTravel === 0) return 0;
  return Math.min(100, (netMove / totalTravel) * 100);
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const gate = await requirePlan(getClient(), req, 'pro');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
    const t = await getLatestTime('m15_pair_spreads');
    if (!t) return res.json({ spreads: [] });

    const sb = getClient();

    // Fetch M15 spreads
    const { data, error } = await sb
      .from('m15_pair_spreads')
      .select('instrument, spread_45m, spread_90m, spread_180m, smooth_45m, smooth_90m, smooth_180m, state')
      .eq('time', t);

    if (error) throw error;

    // Fetch last 20 H1 candles + last 20 M15 candles for all instruments (for DE)
    const instruments = (data || []).map(s => s.instrument);
    const [h1Result, m15Result] = await Promise.all([
      sb.from('backtest_candles')
        .select('instrument, time, open, high, low, close')
        .in('instrument', instruments)
        .eq('timeframe', 'H1')
        .eq('complete', true)
        .order('time', { ascending: false })
        .limit(instruments.length * 20),
      sb.from('backtest_candles')
        .select('instrument, time, open, high, low, close')
        .in('instrument', instruments)
        .eq('timeframe', 'M15')
        .eq('complete', true)
        .order('time', { ascending: false })
        .limit(instruments.length * 20),
    ]);

    // Group candles by instrument (ascending time for DE calc)
    const h1ByPair = {}, m15ByPair = {};
    for (const c of (h1Result.data || [])) {
      if (!h1ByPair[c.instrument]) h1ByPair[c.instrument] = [];
      h1ByPair[c.instrument].push({
        open: parseFloat(c.open), high: parseFloat(c.high),
        low: parseFloat(c.low), close: parseFloat(c.close), time: c.time,
      });
    }
    for (const c of (m15Result.data || [])) {
      if (!m15ByPair[c.instrument]) m15ByPair[c.instrument] = [];
      m15ByPair[c.instrument].push({
        open: parseFloat(c.open), high: parseFloat(c.high),
        low: parseFloat(c.low), close: parseFloat(c.close), time: c.time,
      });
    }
    // Reverse to ascending (fetched desc for limit) then take last 20
    for (const k of Object.keys(h1ByPair))  h1ByPair[k]  = h1ByPair[k].reverse().slice(-20);
    for (const k of Object.keys(m15ByPair)) m15ByPair[k] = m15ByPair[k].reverse().slice(-20);

    // Compute DE per pair
    const deMap = {};
    for (const inst of instruments) {
      const h1DE  = computeDE(h1ByPair[inst]  || []);
      const m15DE = computeDE(m15ByPair[inst] || []);
      deMap[inst] = {
        de_m15: Math.round(m15DE * 10) / 10,
        de_h1:  Math.round(h1DE * 10)  / 10,
        de_combined: Math.round((0.40 * m15DE + 0.60 * h1DE) * 10) / 10,
      };
    }

    const spreads = (data || [])
      .map(s => ({
        ...s,
        bias:           (parseFloat(s.smooth_180m) || 0) >= 0 ? 'BUY' : 'SELL',
        weighted_score: weightedScore(s),
        ...(deMap[s.instrument] || { de_m15: 0, de_h1: 0, de_combined: 0 }),
      }))
      .sort((a, b) => b.weighted_score - a.weighted_score);

    res.json({ time: t, spreads });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
