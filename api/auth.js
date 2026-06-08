const { getClient } = require('./_db');
const { sendEmail, confirmationEmail, welcomeEmail } = require('../src/emailService');

// In-memory confirmation store (survives within a single Vercel instance)
// For production scale, use a DB table — but for now this is fine
const _pendingConfirmations = new Map();
const CODE_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
}

function cleanExpired() {
  const now = Date.now();
  for (const [key, val] of _pendingConfirmations) {
    if (now - val.created > CODE_EXPIRY_MS) _pendingConfirmations.delete(key);
  }
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { action, email, password } = req.body || {};

    if (!action || !email) {
      return res.status(400).json({ error: 'action and email are required' });
    }

    const sb = getClient();

    // ── Sign Up — disabled ─────────────────────────────────────────────
    if (action === 'signup') {
      return res.status(403).json({ error: 'Sign-up is currently disabled.' });
    }
    if (action === '_signup_disabled') {
      if (!password) return res.status(400).json({ error: 'password is required' });
      const { firstName = '', lastName = '' } = req.body;

      // Check if email already exists
      const { data: existing } = await sb.auth.admin.listUsers();
      const userExists = existing?.users?.some(u => u.email === email);
      if (userExists) {
        return res.status(400).json({ error: 'An account with this email already exists. Please sign in.' });
      }

      // Generate and store confirmation code
      cleanExpired();
      const code = generateCode();
      _pendingConfirmations.set(email.toLowerCase(), {
        code,
        password,
        firstName,
        lastName,
        created: Date.now(),
      });

      // Send confirmation email
      await sendEmail(email, confirmationEmail(firstName, code));

      return res.json({
        needs_confirmation: true,
        message: 'Verification code sent to your email.',
      });
    }

    // ── Confirm — disabled (signup flow) ───────────────────────────────
    if (action === 'confirm') {
      return res.status(403).json({ error: 'Sign-up is currently disabled.' });
    }
    if (action === '_confirm_disabled') {
      const { code } = req.body || {};
      if (!code) return res.status(400).json({ error: 'Verification code is required' });

      cleanExpired();
      const key = email.toLowerCase();
      const pending = _pendingConfirmations.get(key);

      if (!pending) {
        return res.status(400).json({ error: 'No pending verification. Please sign up again.' });
      }

      if (pending.code !== String(code).trim()) {
        return res.status(400).json({ error: 'Invalid verification code. Please try again.' });
      }

      // Code matches — create the user (confirmed)
      const { data: created, error: createErr } = await sb.auth.admin.createUser({
        email,
        password: pending.password,
        email_confirm: true, // Already verified via our code
        user_metadata: {
          first_name: pending.firstName,
          last_name:  pending.lastName,
          full_name:  `${pending.firstName} ${pending.lastName}`.trim(),
        },
      });

      if (createErr) return res.status(400).json({ error: createErr.message });

      // Clean up
      _pendingConfirmations.delete(key);

      // Auto sign-in
      const { data: session, error: signErr } = await sb.auth.signInWithPassword({
        email,
        password: pending.password,
      });
      if (signErr) return res.status(400).json({ error: signErr.message });

      // Send welcome email (non-blocking)
      sendEmail(email, welcomeEmail(pending.firstName)).catch(e =>
        console.error('[welcome-email]', e.message)
      );

      return res.json({
        token:         session.session.access_token,
        refresh_token: session.session.refresh_token,
        user: {
          id:         session.user.id,
          email:      session.user.email,
          first_name: pending.firstName,
          last_name:  pending.lastName,
          full_name:  `${pending.firstName} ${pending.lastName}`.trim(),
        },
      });
    }

    // ── Resend — disabled (signup flow) ────────────────────────────────
    if (action === 'resend') {
      return res.status(403).json({ error: 'Sign-up is currently disabled.' });
    }
    if (action === '_resend_disabled') {
      cleanExpired();
      const key = email.toLowerCase();
      const pending = _pendingConfirmations.get(key);

      if (!pending) {
        return res.status(400).json({ error: 'No pending verification. Please sign up again.' });
      }

      // Generate new code
      const code = generateCode();
      pending.code = code;
      pending.created = Date.now();

      await sendEmail(email, confirmationEmail(pending.firstName, code));

      return res.json({ message: 'New verification code sent.' });
    }

    // ── Sign In ───────────────────────────────────────────────────────────
    if (action === 'login') {
      if (!password) return res.status(400).json({ error: 'password is required' });
      const { data: session, error: signErr } = await sb.auth.signInWithPassword({ email, password });
      if (signErr) return res.status(401).json({ error: signErr.message });

      const meta = session.user.user_metadata || {};
      return res.json({
        token:         session.session.access_token,
        refresh_token: session.session.refresh_token,
        user: {
          id:         session.user.id,
          email:      session.user.email,
          first_name: meta.first_name || '',
          last_name:  meta.last_name  || '',
          full_name:  meta.full_name  || '',
        },
      });
    }

    return res.status(400).json({ error: 'action must be "signup", "confirm", "resend", or "login"' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
