const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const gate = await requirePlan(getClient(), req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
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
