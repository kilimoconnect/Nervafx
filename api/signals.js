const { getClient, getLatestTime, cors } = require('./_db');
const { requirePlan } = require('./_plan');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const gate = await requirePlan(getClient(), req, 'pro');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
    const t = await getLatestTime('trade_signals');
    if (!t) return res.json({ signals: [], lastSignalTime: null, lastSignalInstrument: null });

    const [currentRes, lastRes] = await Promise.all([
      getClient()
        .from('trade_signals')
        .select('*')
        .eq('time', t)
        .order('confidence', { ascending: false }),
      getClient()
        .from('trade_signals')
        .select('time, instrument, signal')
        .in('signal', ['BUY', 'SELL'])
        .order('time', { ascending: false })
        .limit(1),
    ]);

    if (currentRes.error) throw currentRes.error;

    const lastSig = lastRes.data?.[0] || null;

    res.json({
      time: t,
      signals: currentRes.data || [],
      lastSignalTime: lastSig?.time || null,
      lastSignalInstrument: lastSig?.instrument || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
