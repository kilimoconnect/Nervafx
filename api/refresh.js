const { getClient } = require('./_db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { refresh_token } = req.body || {};
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

  try {
    const { data, error } = await getClient().auth.refreshSession({ refresh_token });
    if (error) return res.status(401).json({ error: error.message });

    return res.json({
      token:         data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
