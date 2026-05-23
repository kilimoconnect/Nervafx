'use strict';

/**
 * POST /api/oauth-exchange
 *
 * Exchanges an OAuth authorization code + PKCE code_verifier for Supabase
 * session tokens. Called by the login page after Google OAuth redirects back
 * with ?code= in the query string.
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { code, code_verifier } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code is required' });

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey  = process.env.SUPABASE_SERVICE_KEY;

    // Exchange authorization code for session via Supabase Auth API (PKCE)
    const resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': 'Bearer ' + serviceKey,
      },
      body: JSON.stringify({
        auth_code: code,
        code_verifier: code_verifier || '',
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('[OAUTH-EXCHANGE]', data);
      return res.status(resp.status).json({
        error: data.error_description || data.msg || data.error || 'Code exchange failed',
      });
    }

    return res.json({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
    });
  } catch (e) {
    console.error('[OAUTH-EXCHANGE]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
