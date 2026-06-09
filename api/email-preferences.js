'use strict';

/**
 * GET / PATCH /api/email-preferences
 *
 * Users can toggle their email notification preferences.
 * Requires auth (Bearer token).
 */

const { createClient } = require('@supabase/supabase-js');

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function getUser(sb, req) {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!auth) return null;
  const { data: { user } } = await sb.auth.getUser(auth);
  return user;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = getDB();
  const user = await getUser(sb, req);
  if (!user) return res.status(401).json({ error: 'Auth required' });

  try {
    // ── GET — fetch current preferences ────────────────────────────────────
    if (req.method === 'GET') {
      const { data } = await sb
        .from('email_preferences')
        .select('*')
        .eq('user_id', user.id)
        .single();

      return res.json(data || {
        user_id:            user.id,
        signal_alerts:      true,
        direction_alerts:   true,
        cycle_alerts:       true,
        flow_spread_alerts: true,
        breakout_alerts:    true,
        daily_digest:       true,
        upgrade_prompts:    true,
        unsubscribed:       false,
      });
    }

    // ── PATCH — update preferences ─────────────────────────────────────────
    if (req.method === 'PATCH') {
      const allowed = ['signal_alerts', 'direction_alerts', 'cycle_alerts', 'flow_spread_alerts', 'breakout_alerts', 'daily_digest', 'upgrade_prompts', 'unsubscribed'];
      const updates = { user_id: user.id };
      for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = !!req.body[key];
      }
      // Sync legacy: direction_alerts maps to signal_alerts for backward compat
      if (updates.direction_alerts !== undefined) updates.signal_alerts = updates.direction_alerts;
      // Notification email — optional override for where alerts are sent
      if (req.body.notification_email !== undefined) {
        const raw = (req.body.notification_email || '').trim();
        // Allow empty string (clear override → use registered email)
        updates.notification_email = raw || null;
      }

      const { data, error } = await sb
        .from('email_preferences')
        .upsert(updates, { onConflict: 'user_id' })
        .select()
        .single();

      if (error) return res.status(400).json({ error: error.message });
      return res.json(data);
    }

    return res.status(405).json({ error: 'GET or PATCH only' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
