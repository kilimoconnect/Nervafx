const { getClient, getLatestTime, cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const t = await getLatestTime('pair_strength_spreads');
    if (!t) return res.json({ spreads: [] });
    const { data, error } = await getClient()
      .from('pair_strength_spreads')
      .select('instrument, base_currency, quote_currency, spread_3h, spread_6h, spread_12h')
      .eq('time', t)
      .order('spread_6h', { ascending: false });
    if (error) throw error;
    res.json({ time: t, spreads: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
