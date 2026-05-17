const { getClient } = require('./_db');
const { sendEmail, welcomeEmail } = require('../src/emailService');

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { action, email, password } = req.body || {};

    if (!action || !email || !password) {
      return res.status(400).json({ error: 'action, email and password are required' });
    }

    const sb = getClient();

    // ── Sign Up ───────────────────────────────────────────────────────────────
    if (action === 'signup') {
      const { firstName = '', lastName = '' } = req.body;

      // Use admin API so email confirmation is skipped (email_confirm: true)
      const { data: created, error: createErr } = await sb.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          first_name: firstName,
          last_name:  lastName,
          full_name:  `${firstName} ${lastName}`.trim(),
        },
      });

      if (createErr) return res.status(400).json({ error: createErr.message });

      // Auto sign-in right after signup
      const { data: session, error: signErr } = await sb.auth.signInWithPassword({ email, password });
      if (signErr) return res.status(400).json({ error: signErr.message });

      // Send welcome email (non-blocking)
      sendEmail(email, welcomeEmail(firstName)).catch(e =>
        console.error('[welcome-email]', e.message)
      );

      return res.json({
        token:         session.session.access_token,
        refresh_token: session.session.refresh_token,
        user:  {
          id:         session.user.id,
          email:      session.user.email,
          first_name: firstName,
          last_name:  lastName,
          full_name:  `${firstName} ${lastName}`.trim(),
        },
      });
    }

    // ── Sign In ───────────────────────────────────────────────────────────────
    if (action === 'login') {
      const { data: session, error: signErr } = await sb.auth.signInWithPassword({ email, password });
      if (signErr) return res.status(401).json({ error: signErr.message });

      const meta = session.user.user_metadata || {};
      return res.json({
        token:         session.session.access_token,
        refresh_token: session.session.refresh_token,
        user:  {
          id:         session.user.id,
          email:      session.user.email,
          first_name: meta.first_name || '',
          last_name:  meta.last_name  || '',
          full_name:  meta.full_name  || '',
        },
      });
    }

    return res.status(400).json({ error: 'action must be "signup" or "login"' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
