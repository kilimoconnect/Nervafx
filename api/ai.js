const { getClient, cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const { data, error } = await getClient()
      .from('ai_analysis')
      .select('*')
      .order('time', { ascending: false })
      .limit(168); // 28 pairs × 6 hours lookback

    if (error) throw error;

    // Latest per instrument
    const latest = {};
    for (const row of data || []) {
      if (!latest[row.instrument]) latest[row.instrument] = row;
    }

    res.json({ analyses: Object.values(latest) });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
