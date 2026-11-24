'use strict';

/**
 * Admin-only CRUD for Break-of-Structure email-alert recipients (bos_alert_recipients).
 *
 *   GET                      → { ok, recipients: [{ id, email, label, active, created_at }] }
 *   POST   { email, label }  → add (or re-activate) a recipient
 *   PATCH  { id, active }    → enable/disable a recipient
 *   DELETE { id } | ?id=     → remove a recipient
 *
 * Gated behind the admin account (same check as api/email-notify). No orders — notification only.
 */

const { createClient } = require('@supabase/supabase-js');

const ADMIN_ID = '140f3854-2c85-488c-8e0a-0f965d562654';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function verifyAdmin(sb, req) {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!auth) return { ok: false };
  if (process.env.CRON_SECRET && auth === process.env.CRON_SECRET) return { ok: true, userId: 'cron' };
  try {
    const { data: { user } } = await sb.auth.getUser(auth);
    if (user && user.id === ADMIN_ID) return { ok: true, userId: user.id };
  } catch (_) { /* fall through */ }
  return { ok: false };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = getDB();
  const admin = await verifyAdmin(sb, req);
  if (!admin.ok) return res.status(403).json({ ok: false, error: 'Admin only' });

  const body = req.body || {};

  try {
    if (req.method === 'GET') {
      const { data, error } = await sb
        .from('bos_alert_recipients')
        .select('id, email, label, active, created_at')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return res.json({ ok: true, recipients: data || [] });
    }

    if (req.method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase();
      const label = body.label ? String(body.label).trim().slice(0, 120) : null;
      if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'Valid email required' });

      // If it already exists (case-insensitive), re-activate + update the label instead of erroring.
      const { data: existing } = await sb
        .from('bos_alert_recipients')
        .select('id')
        .ilike('email', email)
        .limit(1);
      if (existing && existing.length) {
        const { data, error } = await sb
          .from('bos_alert_recipients')
          .update({ active: true, label })
          .eq('id', existing[0].id)
          .select('id, email, label, active, created_at')
          .single();
        if (error) throw error;
        return res.json({ ok: true, recipient: data, reactivated: true });
      }

      const { data, error } = await sb
        .from('bos_alert_recipients')
        .insert({ email, label, active: true, created_by: admin.userId })
        .select('id, email, label, active, created_at')
        .single();
      if (error) throw error;
      return res.json({ ok: true, recipient: data });
    }

    if (req.method === 'PATCH') {
      const id = body.id;
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      const { data, error } = await sb
        .from('bos_alert_recipients')
        .update({ active: !!body.active })
        .eq('id', id)
        .select('id, email, label, active, created_at')
        .single();
      if (error) throw error;
      return res.json({ ok: true, recipient: data });
    }

    if (req.method === 'DELETE') {
      const id = body.id || (req.query && req.query.id);
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      const { error } = await sb.from('bos_alert_recipients').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true, removed: id });
    }

    return res.status(405).json({ ok: false, error: 'GET/POST/PATCH/DELETE only' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 10;
