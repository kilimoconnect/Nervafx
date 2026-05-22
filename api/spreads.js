const { getClient, getLatestTime, cors } = require('./_db');
const { requirePlan } = require('./_plan');

// Weighted ranking: 40% 12H + 35% 6H + 15% 3H direction + 10% acceleration
// This prevents exhausted old trends from ranking above fresh active setups
function weightedScore(s) {
  const s12 = parseFloat(s.spread_12h) || 0;
  const s6  = parseFloat(s.spread_6h)  || 0;
  const s3  = parseFloat(s.spread_3h)  || 0;
  const accel = Math.abs(s3) - Math.abs(s6); // positive = spread accelerating short-term
  return Math.abs(s12) * 0.40
       + Math.abs(s6)  * 0.35
       + Math.abs(s3)  * 0.15
       + Math.max(accel, 0) * 0.10;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const gate = await requirePlan(getClient(), req, 'pro');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
    const t = await getLatestTime('pair_strength_spreads');
    if (!t) return res.json({ spreads: [] });
    const { data, error } = await getClient()
      .from('pair_strength_spreads')
      .select('instrument, base_currency, quote_currency, spread_3h, spread_6h, spread_12h')
      .eq('time', t);
    if (error) throw error;

    const spreads = (data || [])
      .map(s => ({ ...s, weighted_score: weightedScore(s) }))
      .sort((a, b) => b.weighted_score - a.weighted_score);

    res.json({ time: t, spreads });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
