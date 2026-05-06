const { getClient, getLatestTime, cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const t = await getLatestTime('trade_signals');
    if (!t) return res.json({ signals: [] });
    const { data, error } = await getClient()
      .from('trade_signals')
      .select('*')
      .eq('time', t)
      .order('confidence', { ascending: false });
    if (error) throw error;
    res.json({ time: t, signals: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
