const { getClient, getLatestTime, cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const t = await getLatestTime('currency_strength');
    if (!t) return res.json({ currencies: [], time: null });
    const { data, error } = await getClient()
      .from('currency_strength')
      .select('currency, normalized_12h, normalized_6h, normalized_3h')
      .eq('time', t);
    if (error) throw error;
    const currencies = (data || [])
      .map(c => ({
        currency: c.currency,
        value: Math.round(parseFloat(c.normalized_12h || 0) * 100) / 100,
        direction: parseFloat(c.normalized_12h) > 0.1 ? 'up' : parseFloat(c.normalized_12h) < -0.1 ? 'down' : 'flat',
      }))
      .sort((a, b) => b.value - a.value);
    res.json({ currencies, time: t });
  } catch(e) { res.status(500).json({ error: e.message }); }
};
