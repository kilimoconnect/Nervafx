const { getClient, getLatestTime, cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const t = await getLatestTime('risk_checks');
    const defaultBalance = parseFloat(process.env.ACCOUNT_BALANCE) || 1000;
    if (!t) return res.json({ approved: [], rejected: [], summary: { openTrades: 0, maxTrades: 3, dailyRisk: 0, dailyRiskPct: '0.00', maxDailyRiskPct: 2, balance: defaultBalance } });

    const today = new Date(t);
    const dayStart = new Date(Date.UTC(
      today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()
    )).toISOString();

    const { data, error } = await getClient()
      .from('risk_checks')
      .select('*')
      .gte('time', dayStart)
      .order('time', { ascending: false });

    if (error) throw error;

    const approved = (data || []).filter(r => r.status === 'APPROVED');
    const rejected = (data || []).filter(r => r.status === 'REJECTED');
    const totalRisk = approved.reduce((s, r) => s + parseFloat(r.risk_amount), 0);
    const balance = parseFloat(approved[0]?.account_balance ?? null) || parseFloat(process.env.ACCOUNT_BALANCE) || 1000;

    res.json({
      approved,
      rejected,
      summary: {
        openTrades: approved.length,
        maxTrades: 3,
        dailyRisk: totalRisk,
        dailyRiskPct: ((totalRisk / balance) * 100).toFixed(2),
        maxDailyRiskPct: 2,
        balance,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
