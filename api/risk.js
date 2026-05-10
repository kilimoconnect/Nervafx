const { getClient, getLatestTime, cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const sb = getClient();

    // ── Resolve user profile (balance / limits) ──────────────────────────────
    let accountSize    = parseFloat(process.env.ACCOUNT_BALANCE) || 1000;
    let maxDailyRiskPct = 2;
    let maxTrades       = 3;

    const auth  = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    if (token) {
      try {
        const { data: { user } } = await sb.auth.getUser(token);
        if (user) {
          const { data: profile } = await sb
            .from('profiles')
            .select('account_size, max_daily_risk_pct, max_trades')
            .eq('id', user.id)
            .single();

          if (profile) {
            if (profile.account_size)       accountSize     = parseFloat(profile.account_size);
            if (profile.max_daily_risk_pct) maxDailyRiskPct = parseFloat(profile.max_daily_risk_pct);
            if (profile.max_trades)         maxTrades       = parseInt(profile.max_trades);
          }
        }
      } catch (_) {
        // token lookup failed — fall back to env defaults, don't crash
      }
    }

    // ── Fetch today's risk checks ────────────────────────────────────────────
    const t = await getLatestTime('risk_checks');
    if (!t) {
      return res.json({
        approved: [], rejected: [],
        summary: {
          openTrades: 0, maxTrades,
          dailyRisk: 0, dailyRiskPct: '0.00',
          maxDailyRiskPct, balance: accountSize,
        },
      });
    }

    const today    = new Date(t);
    const dayStart = new Date(Date.UTC(
      today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()
    )).toISOString();

    const { data, error } = await sb
      .from('risk_checks')
      .select('*')
      .gte('time', dayStart)
      .order('time', { ascending: false });

    if (error) throw error;

    const approved  = (data || []).filter(r => r.status === 'APPROVED');
    const rejected  = (data || []).filter(r => r.status === 'REJECTED');
    const totalRisk = approved.reduce((s, r) => s + parseFloat(r.risk_amount || 0), 0);

    // Use account_balance from the latest risk_check as a live override if available
    const liveBalance = parseFloat(approved[0]?.account_balance ?? null);
    const balance = liveBalance > 0 ? liveBalance : accountSize;

    res.json({
      approved,
      rejected,
      summary: {
        openTrades:     approved.length,
        maxTrades,
        dailyRisk:      totalRisk,
        dailyRiskPct:   ((totalRisk / balance) * 100).toFixed(2),
        maxDailyRiskPct,
        balance,
      },
    });

  } catch (e) { res.status(500).json({ error: e.message }); }
};
