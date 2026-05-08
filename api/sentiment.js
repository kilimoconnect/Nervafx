const { getClient, cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const { data, error } = await getClient()
      .from('risk_sentiment')
      .select('*')
      .order('time', { ascending: false })
      .limit(1);

    if (error) throw error;

    res.json({ sentiment: data?.[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
