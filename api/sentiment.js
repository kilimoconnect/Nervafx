const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const gate = await requirePlan(getClient(), req, 'pro');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
    const { data, error } = await getClient()
      .from('risk_sentiment')
      .select('*')
      .order('time', { ascending: false })
      .limit(1);

    if (error) throw error;

    res.json({ sentiment: data?.[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
