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

    // Delete profile row first (cascade would handle it but belt+braces)
    await sb.from('profiles').delete().eq('id', user.id);

    // Delete the Supabase Auth user
    const { error } = await sb.auth.admin.deleteUser(user.id);
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
