const { getClient, getLatestTime, cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const t = await getLatestTime('currency_strength');
    if (!t) return res.json({ currencies: [] });
    const { data, error } = await getClient()
      .from('currency_strength')
      .select('currency, normalized_3h, normalized_6h, normalized_12h, smooth_3h, smooth_6h, smooth_12h')
      .eq('time', t);
    if (error) throw error;
    res.json({ time: t, currencies: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
