const { getClient, getLatestTime, cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const sb = getClient();

    // ── Authenticate user ────────────────────────────────────────────────────
    const auth  = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    let userId          = null;
    let accountSize     = parseFloat(process.env.ACCOUNT_BALANCE) || 1000;
    let maxDailyRiskPct = 2;
    let maxTrades       = 3;

    if (token) {
      try {
        const { data: { user } } = await sb.auth.getUser(token);
        if (user) {
          userId = user.id;

          const { data: profile } = await sb
            .from('profiles')
            .select('account_size, max_daily_risk_pct, max_trades, min_rr')
            .eq('id', user.id)
            .single();

          if (profile) {
            if (profile.account_size)       accountSize     = parseFloat(profile.account_size);
            if (profile.max_daily_risk_pct) maxDailyRiskPct = parseFloat(profile.max_daily_risk_pct);
            if (profile.max_trades)         maxTrades       = parseInt(profile.max_trades);
          }
        }
      } catch (_) { /* fall back to defaults */ }
    }

    // ── Fetch today's risk checks for this user ──────────────────────────────
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

    // Always use the actual current UTC date so the counter resets at midnight
    // regardless of when the last risk_check record was written.
    const now      = new Date();
    const dayStart = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
    )).toISOString();

    let query = sb
      .from('risk_checks')
      .select('*')
      .gte('time', dayStart)
      .order('time', { ascending: false });

    // Filter by this user's records only
    if (userId) query = query.eq('user_id', userId);

    const { data, error } = await query;
    if (error) throw error;

    const approved  = (data || []).filter(r => r.status === 'APPROVED');
    const rejected  = (data || []).filter(r => r.status === 'REJECTED');
    const totalRisk = approved.reduce((s, r) => s + parseFloat(r.risk_amount || 0), 0);

    // Use live account_balance from the latest risk_check if available
    const liveBalance = parseFloat(approved[0]?.account_balance ?? null);
    const balance     = liveBalance > 0 ? liveBalance : accountSize;

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
