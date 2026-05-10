const { getClient, cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const sb = getClient();

    // ── Authenticate user ────────────────────────────────────────────────────
    let userId = null;
    const auth  = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    if (token) {
      try {
        const { data: { user } } = await sb.auth.getUser(token);
        if (user) userId = user.id;
      } catch (_) {}
    }

    let query = sb
      .from('trade_actions')
      .select('*')
      .order('time', { ascending: false })
      .limit(20);

    if (userId) query = query.eq('user_id', userId);

    const { data, error } = await query;
    if (error) throw error;

    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
};
