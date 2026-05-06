const { getClient, cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const { data, error } = await getClient()
      .from('trade_actions')
      .select('*')
      .order('time', { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
};
