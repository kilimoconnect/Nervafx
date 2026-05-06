const { getClient, cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const { data, error } = await getClient()
      .from('data_quality_checks')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    res.json(data?.[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
};
