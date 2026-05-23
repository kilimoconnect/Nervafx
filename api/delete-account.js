const { getClient } = require('./_db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE')  return res.status(405).json({ error: 'Method not allowed' });

  try {
    const sb = getClient();

    const auth  = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid or expired token' });

    const uid = user.id;

    // Delete from all user-linked tables before removing the auth user.
    // Some tables may not exist yet — ignore errors from missing tables.
    const userTables = [
      { table: 'email_preferences', col: 'user_id' },
      { table: 'subscriptions',     col: 'user_id' },
      { table: 'profiles',          col: 'id' },
    ];

    for (const { table, col } of userTables) {
      const { error: delErr } = await sb.from(table).delete().eq(col, uid);
      if (delErr) console.warn(`[DELETE-ACCOUNT] ${table}: ${delErr.message}`);
    }

    // Delete the Supabase Auth user
    const { error } = await sb.auth.admin.deleteUser(uid);
    if (error) {
      console.error(`[DELETE-ACCOUNT] auth.admin.deleteUser failed: ${error.message}`);
      return res.status(500).json({ error: `Failed to delete user: ${error.message}` });
    }

    return res.json({ success: true });

  } catch (e) {
    console.error('[DELETE-ACCOUNT]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
