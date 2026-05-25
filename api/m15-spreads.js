// api/m15-spreads.js — Latest M15 pair spreads + Impulse Detection + DE
//
// Weighted ranking mirrors api/spreads.js but uses M15 lookback columns:
//   40% smooth_180m  (trend / longest lookback)
//   35% smooth_90m   (medium-term pressure)
//   15% smooth_45m   (short-term momentum)
//   10% acceleration (|smooth_45m| - |smooth_90m| when positive → spread widening)
//
// Impulse Detection (from real M15 candle price action):
//   velocity:    ATR-normalised net move over last 4 candles (1 hour)
//   body_ratio:  avg(body / range) — high = directional candles, low = wicks/indecision
//   consec_dir:  consecutive candles closing in same direction (1-4)
//   impulse_score: 0-100 composite (45% velocity + 30% body + 25% consecutive)
//
// Directional Efficiency (DE):
//   net_move / total_travel × 100 — measures movement quality over 20 candles

const { getClient, getLatestTime, cors } = require('./_db');
const { requirePlan } = require('./_plan');

function weightedScore(s) {
  const s180 = parseFloat(s.smooth_180m) || 0;
  const s90  = parseFloat(s.smooth_90m)  || 0;
  const s45  = parseFloat(s.smooth_45m)  || 0;
  const accel = Math.abs(s45) - Math.abs(s90);
  return Math.abs(s180) * 0.40
       + Math.abs(s90)  * 0.35
       + Math.abs(s45)  * 0.15
       + Math.max(accel, 0) * 0.10;
}

/**
 * Compute Directional Efficiency from raw candles.
 * DE = (|final_close - initial_open| / sum(high - low)) × 100
 */
function computeDE(candles) {
  if (!candles || candles.length < 2) return 0;
  const netMove = Math.abs(candles[candles.length - 1].close - candles[0].open);
  let totalTravel = 0;
  for (const c of candles) totalTravel += c.high - c.low;
  if (totalTravel === 0) return 0;
  return Math.min(100, (netMove / totalTravel) * 100);
}

/**
 * Compute impulse metrics from real M15 candle price action.
 * Uses last 4 candles (1 hour) for impulse, full array for ATR normalisation.
 * @param {Array} candles - sorted ascending by time, each { open, high, low, close }
 * @returns {{ velocity, body_ratio, consec_dir, impulse_dir, impulse_score }}
 */
function computeImpulse(candles) {
  const empty = { velocity: 0, body_ratio: 0, consec_dir: 0, impulse_dir: 0, impulse_score: 0 };
  if (!candles || candles.length < 4) return empty;

  const recent = candles.slice(-4);  // last 4 M15 = 1 hour

  // ATR from all candles for normalisation
  let atrSum = 0;
  for (const c of candles) atrSum += c.high - c.low;
  const avgRange = atrSum / candles.length;
  if (avgRange === 0) return empty;

  // 1. Velocity: net move over 4 candles / average candle range
  //    ~1 = normal, ~2 = strong, ~3+ = very impulsive
  const netMove = Math.abs(recent[recent.length - 1].close - recent[0].open);
  const velocity = netMove / avgRange;

  // 2. Body ratio: total body / total range (high = directional candles)
  let bodySum = 0, rangeSum = 0;
  for (const c of recent) {
    bodySum  += Math.abs(c.close - c.open);
    rangeSum += c.high - c.low;
  }
  const bodyRatio = rangeSum > 0 ? bodySum / rangeSum : 0;

  // 3. Consecutive directional closes (from most recent backward)
  let consecDir = 1;
  const lastDir = recent[recent.length - 1].close >= recent[recent.length - 1].open ? 1 : -1;
  for (let i = recent.length - 2; i >= 0; i--) {
    const dir = recent[i].close >= recent[i].open ? 1 : -1;
    if (dir === lastDir) consecDir++;
    else break;
  }

  // 4. Net impulse direction: +1 bullish, -1 bearish
  const impulseDir = recent[recent.length - 1].close >= recent[0].open ? 1 : -1;

  // 5. Composite score: velocity 45%, body dominance 30%, consecutive 25%
  //    Scaled so: velocity ~3 ATR = 100, bodyRatio 0.80 = 100, 4 consec = 100
  const velScore    = Math.min(100, velocity * 33);
  const bodyScore   = Math.min(100, bodyRatio * 125);
  const consecScore = (consecDir / 4) * 100;
  const impulseScore = Math.min(100, Math.round(
    velScore * 0.45 + bodyScore * 0.30 + consecScore * 0.25
  ));

  return {
    velocity:      Math.round(velocity * 100) / 100,
    body_ratio:    Math.round(bodyRatio * 100) / 100,
    consec_dir:    consecDir,
    impulse_dir:   impulseDir,
    impulse_score: impulseScore,
  };
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

    // Fetch last 20 M15 candles for all instruments (for DE)
    const instruments = (data || []).map(s => s.instrument);
    const m15Result = await sb.from('backtest_candles')
      .select('instrument, time, open, high, low, close')
      .in('instrument', instruments)
      .eq('timeframe', 'M15')
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(instruments.length * 20);

    // Group candles by instrument (ascending time for DE calc)
    const m15ByPair = {};
    for (const c of (m15Result.data || [])) {
      if (!m15ByPair[c.instrument]) m15ByPair[c.instrument] = [];
      m15ByPair[c.instrument].push({
        open: parseFloat(c.open), high: parseFloat(c.high),
        low: parseFloat(c.low), close: parseFloat(c.close), time: c.time,
      });
    }
    // Reverse to ascending (fetched desc for limit) then take last 20
    for (const k of Object.keys(m15ByPair)) m15ByPair[k] = m15ByPair[k].reverse().slice(-20);

    // Compute DE + impulse per pair from M15 candles
    const metricsMap = {};
    for (const inst of instruments) {
      const candles = m15ByPair[inst] || [];
      const de      = computeDE(candles);
      const impulse = computeImpulse(candles);
      metricsMap[inst] = {
        de_combined:   Math.round(de * 10) / 10,
        ...impulse,
      };
    }

    const spreads = (data || [])
      .map(s => ({
        ...s,
        bias:           (parseFloat(s.smooth_180m) || 0) >= 0 ? 'BUY' : 'SELL',
        weighted_score: weightedScore(s),
        ...(metricsMap[s.instrument] || { de_combined: 0, velocity: 0, body_ratio: 0, consec_dir: 0, impulse_dir: 0, impulse_score: 0 }),
      }))
      .sort((a, b) => b.weighted_score - a.weighted_score);

    res.json({ time: t, spreads });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
