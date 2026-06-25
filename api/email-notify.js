'use strict';

const { createClient } = require('@supabase/supabase-js');
const {
  sendEmail, sendBulk,
  audnzdSignalEmail, audnzdDirectionChangeEmail,
} = require('../src/emailService');

const ADMIN_ID = '140f3854-2c85-488c-8e0a-0f965d562654';

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function verifyAdmin(sb, req) {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!auth) return false;
  if (process.env.CRON_SECRET && auth === process.env.CRON_SECRET) return true;
  const { data: { user } } = await sb.auth.getUser(auth);
  return user?.id === ADMIN_ID;
}

async function getSubscribedUsers(sb) {
  const { data: users } = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (!users?.users) return [];

  const { data: prefs } = await sb
    .from('email_preferences')
    .select('user_id, signal_alerts, unsubscribed, notification_email');

  const prefMap = {};
  for (const p of prefs || []) prefMap[p.user_id] = p;

  return users.users.filter(u => {
    const p = prefMap[u.id];
    if (p?.unsubscribed) return false;
    if (p?.signal_alerts === false) return false;
    return true;
  }).map(u => ({
    email: prefMap[u.id]?.notification_email || u.email,
    firstName: u.user_metadata?.first_name || '',
    id: u.id,
  }));
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'POST/GET only' });

  const sb = getDB();

  try {
    const isAdmin = await verifyAdmin(sb, req);
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
  } catch (_) {
    return res.status(403).json({ error: 'Auth error' });
  }

  const type = req.query?.type || (req.body || {}).type;

  try {
    // ── AUD/NZD M15 signal alert ────────────────────────────────────────
    if (type === 'audnzd-signal') {
      const signal = req.body?.signal;
      if (!signal) return res.status(400).json({ error: 'signal payload required' });

      const users = await getSubscribedUsers(sb);
      if (!users.length) return res.json({ ok: true, sent: 0, reason: 'no subscribed users' });

      const template = audnzdSignalEmail(signal);
      const recipients = users.map(u => ({ email: u.email, name: u.firstName }));
      await sendBulk(recipients, template);

      return res.json({ ok: true, sent: users.length });
    }

    // ── AUD/NZD direction change alert ──────────────────────────────────
    if (type === 'audnzd-direction') {
      const change = req.body?.change;
      if (!change) return res.status(400).json({ error: 'change payload required' });

      const users = await getSubscribedUsers(sb);
      if (!users.length) return res.json({ ok: true, sent: 0, reason: 'no subscribed users' });

      const template = audnzdDirectionChangeEmail(change);
      const recipients = users.map(u => ({ email: u.email, name: u.firstName }));
      await sendBulk(recipients, template);

      return res.json({ ok: true, sent: users.length });
    }

    return res.status(400).json({ error: 'type must be "audnzd-signal" or "audnzd-direction"' });

  } catch (e) {
    console.error('[email-notify]', e);
    return res.status(500).json({ error: e.message });
  }
};
