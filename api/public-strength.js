const { getClient, getLatestTime, cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const t = await getLatestTime('currency_strength');
    if (!t) return res.json({ currencies: [], time: null });
    const { data, error } = await getClient()
      .from('currency_strength')
      .select('currency, smooth_12h, smooth_6h, smooth_3h')
      .eq('time', t);
    if (error) throw error;
    const currencies = (data || [])
      .map(c => {
        const v = parseFloat(c.smooth_12h) || 0;
        return {
          currency: c.currency,
          value: Math.round(v * 1000000) / 1000000,
          direction: v > 0 ? 'up' : v < 0 ? 'down' : 'flat',
        };
      })
      .sort((a, b) => b.value - a.value);
    res.json({ currencies, time: t });
  } catch(e) { res.status(500).json({ error: e.message }); }
};
