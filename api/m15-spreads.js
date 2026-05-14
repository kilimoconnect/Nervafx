// api/m15-spreads.js — Latest M15 pair spreads, ranked by weighted score
//
// Weighted ranking mirrors api/spreads.js but uses M15 lookback columns:
//   40% smooth_180m  (trend / longest lookback)
//   35% smooth_90m   (medium-term pressure)
//   15% smooth_45m   (short-term momentum)
//   10% acceleration (|smooth_45m| - |smooth_90m| when positive → spread widening)

const { getClient, getLatestTime, cors } = require('./_db');

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

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const t = await getLatestTime('m15_pair_spreads');
    if (!t) return res.json({ spreads: [] });

    const { data, error } = await getClient()
      .from('m15_pair_spreads')
      .select('instrument, spread_45m, spread_90m, spread_180m, smooth_45m, smooth_90m, smooth_180m, state')
      .eq('time', t);

    if (error) throw error;

    const spreads = (data || [])
      .map(s => ({
        ...s,
        bias:           (parseFloat(s.smooth_180m) || 0) >= 0 ? 'BUY' : 'SELL',
        weighted_score: weightedScore(s),
      }))
      .sort((a, b) => b.weighted_score - a.weighted_score);

    res.json({ time: t, spreads });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
