const { getClient, getLatestTime, cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
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
