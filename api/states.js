const { getClient, getLatestTime, cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const t = await getLatestTime('market_states');
    if (!t) return res.json({ states: [] });
    const { data, error } = await getClient()
      .from('market_states')
      .select('instrument, bias, state, confidence, spread_3h, spread_6h, spread_12h, reason')
      .eq('time', t)
      .order('confidence', { ascending: false });
    if (error) throw error;
    res.json({ time: t, states: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
