'use strict';

/**
 * POST /api/email-notify
 *
 * Internal endpoint called after pipeline runs to send signal alerts.
 * Also handles daily digest (type=digest) and upgrade prompts (type=upgrade).
 * Protected: requires CRON_SECRET or admin JWT.
 */

const { createClient } = require('@supabase/supabase-js');
const {
  sendEmail, sendBulk,
  signalAlertEmail, dailyDigestEmail, upgradePromptEmail,
} = require('../src/emailService');
const { sendQualityAlerts } = require('../src/qualityAlerts');

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

async function getSubscribedUsers(sb, type) {
  const { data: users } = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (!users?.users) return [];

  const { data: prefs } = await sb
    .from('email_preferences')
    .select('user_id, signal_alerts, daily_digest, upgrade_prompts, unsubscribed, notification_email');

  const prefMap = {};
  for (const p of prefs || []) prefMap[p.user_id] = p;

  return users.users.filter(u => {
    const p = prefMap[u.id];
    if (p?.unsubscribed) return false;
    if (type === 'signals' && p?.signal_alerts === false) return false;
    if (type === 'digest'  && p?.daily_digest === false) return false;
    if (type === 'upgrade' && p?.upgrade_prompts === false) return false;
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
    // ── Signal alerts ──────────────────────────────────────────────────────
    if (type === 'signals') {
      const { data: signals } = await sb
        .from('trade_signals')
        .select('instrument, direction, confidence, reason')
        .gte('time', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
        .in('signal', ['BUY', 'SELL'])
        .gte('confidence', 65)
        .order('confidence', { ascending: false })
        .limit(10);

      if (!signals?.length) return res.json({ ok: true, sent: 0, reason: 'no qualifying signals' });

      const { data: sessions } = await sb
        .from('session_activity')
        .select('session_name, energy_cycle, market_energy')
        .order('time', { ascending: false })
        .limit(3);

      const sessionSummary = sessions?.map(s =>
        `${s.session_name}: ${s.energy_cycle} (E:${Math.round(s.market_energy || 0)})`
      ).join(' · ') || '';

      const users = await getSubscribedUsers(sb, 'signals');
      if (!users.length) return res.json({ ok: true, sent: 0, reason: 'no subscribed users' });

      const template = signalAlertEmail(signals, sessionSummary);
      const recipients = users.map(u => ({ email: u.email, name: u.firstName }));
      await sendBulk(recipients, template);

      return res.json({ ok: true, sent: users.length, signals: signals.length });
    }

    // ── Daily digest ───────────────────────────────────────────────────────
    if (type === 'digest') {
      const today = new Date().toISOString().split('T')[0];

      const { data: sessions } = await sb
        .from('session_activity')
        .select('*')
        .gte('time', today + 'T00:00:00Z')
        .order('time', { ascending: false });

      const latestBySession = {};
      for (const s of sessions || []) {
        if (!latestBySession[s.session_name]) latestBySession[s.session_name] = s;
      }

      const { data: topSetups } = await sb
        .from('trade_signals')
        .select('instrument, direction, confidence')
        .gte('time', today + 'T00:00:00Z')
        .in('signal', ['BUY', 'SELL'])
        .gte('confidence', 65)
        .order('confidence', { ascending: false })
        .limit(5);

      const users = await getSubscribedUsers(sb, 'digest');
      if (!users.length) return res.json({ ok: true, sent: 0, reason: 'no subscribed users' });

      const template = dailyDigestEmail({
        date: today,
        sessions: Object.values(latestBySession),
        topSetups: topSetups || [],
        marketCycle: null,
        momentumSignal: null,
      });

      const recipients = users.map(u => ({ email: u.email, name: u.firstName }));
      await sendBulk(recipients, template);

      return res.json({ ok: true, sent: users.length });
    }

    // ── Upgrade prompts ────────────────────────────────────────────────────
    if (type === 'upgrade') {
      const users = await getSubscribedUsers(sb, 'upgrade');
      const sent = [];

      for (const u of users) {
        const template = upgradePromptEmail(u.firstName);
        await sendEmail(u.email, template);
        sent.push(u.email);
      }

      return res.json({ ok: true, sent: sent.length });
    }

    // ── Quality alerts ──────────────────────────────────────────────────
    if (type === 'quality') {
      const result = await sendQualityAlerts(sb);
      return res.json({ ok: true, ...result });
    }

    return res.status(400).json({ error: 'type must be "signals", "digest", "upgrade", or "quality"' });

  } catch (e) {
    console.error('[email-notify]', e);
    return res.status(500).json({ error: e.message });
  }
};
