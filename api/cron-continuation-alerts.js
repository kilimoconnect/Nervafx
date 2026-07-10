'use strict';

const { createClient } = require('@supabase/supabase-js');
const { sendBulk, continuationPairAlertEmail } = require('../src/emailService');

const dailyHandler   = require('./daily-continuation.js');
const h4Handler      = require('./h1-continuation.js');
const sessionHandler = require('./session-continuation.js');

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Fetch subscribed users plus their profile timezone.
async function getSubscribedUsers(sb) {
  const { data: users } = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (!users?.users) return [];

  const [prefRes, profRes] = await Promise.all([
    sb.from('email_preferences').select('user_id, signal_alerts, unsubscribed, notification_email'),
    sb.from('profiles').select('id, timezone, first_name'),
  ]);

  const prefMap = {};
  for (const p of prefRes.data || []) prefMap[p.user_id] = p;

  const profMap = {};
  for (const p of profRes.data || []) profMap[p.id] = p;

  return users.users.filter(u => {
    const p = prefMap[u.id];
    if (p?.unsubscribed) return false;
    if (p?.signal_alerts === false) return false;
    return true;
  }).map(u => {
    const prof = profMap[u.id] || {};
    const pref = prefMap[u.id] || {};
    return {
      id: u.id,
      email: pref.notification_email || u.email,
      firstName: prof.first_name || u.user_metadata?.first_name || '',
      timezone: prof.timezone || 'UTC',
    };
  });
}

// Invoke a continuation handler internally and capture its JSON.
async function invokeHandler(handler) {
  return await new Promise((resolve) => {
    const req = { method: 'GET', query: {}, headers: {}, _internal: true };
    let payload = null;
    let statusCode = 200;
    const res = {
      setHeader() {},
      status(code) { statusCode = code; return this; },
      json(data) { payload = data; resolve({ status: statusCode, data }); return this; },
      end() { resolve({ status: statusCode, data: payload }); },
    };
    handler(req, res).catch((e) => resolve({ status: 500, data: { error: e.message } }));
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  const isCron = process.env.CRON_SECRET && auth === process.env.CRON_SECRET;
  if (!isCron && req.query?.force !== '1') {
    return res.status(403).json({ error: 'Cron only' });
  }

  // Blackout window: no alerts between 21:00 and 22:00 UTC (00:00-01:00 EAT)
  const nowHour = new Date().getUTCHours();
  if (nowHour === 21 && req.query?.force !== '1') {
    return res.json({ ok: true, sent: 0, reason: 'blackout window (21-22 UTC / 00-01 EAT)' });
  }

  try {
    const [dailyRes, h4Res, sessionRes] = await Promise.all([
      invokeHandler(dailyHandler),
      invokeHandler(h4Handler),
      invokeHandler(sessionHandler),
    ]);

    const signals = [
      ...((dailyRes.data?.pairs   || []).slice(0, 3)).map(p => ({ ...p, engine: 'Daily',   href: 'https://www.nervafx.com/daily-continuation' })),
      ...((h4Res.data?.pairs      || []).slice(0, 3)).map(p => ({ ...p, engine: 'H4',      href: 'https://www.nervafx.com/h1-continuation' })),
      ...((sessionRes.data?.pairs || []).slice(0, 3)).map(p => ({ ...p, engine: 'Session', href: 'https://www.nervafx.com/session-continuation' })),
    ];

    if (!signals.length) {
      return res.json({ ok: true, sent: 0, reason: 'no triggers' });
    }

    const sb = getDB();
    const users = await getSubscribedUsers(sb);
    if (!users.length) return res.json({ ok: true, sent: 0, reason: 'no subscribed users' });

    // Deduplicate: send at most one alert per (user, signal) key across this run.
    // Uses the email_alert_log table keyed by trigger identity (pair + engine + triggerTime).
    // We track successfully-emailed keys locally within this run to avoid double sending
    // when signals overlap between engines.
    const seen = new Set();

    // Group users by timezone so we can bulk-send within a tz per signal.
    const byTz = new Map();
    for (const u of users) {
      const tz = u.timezone || 'UTC';
      if (!byTz.has(tz)) byTz.set(tz, []);
      byTz.get(tz).push(u);
    }

    let sent = 0;
    let sends = 0;
    for (const signal of signals) {
      const key = `${signal.engine}|${signal.instrument || signal.pair}|${signal.triggerTime}`;
      if (seen.has(key)) continue;
      seen.add(key);

      for (const [tz, tzUsers] of byTz.entries()) {
        const template = continuationPairAlertEmail(signal, tz);
        if (!template) continue;
        const recipients = tzUsers.map(u => ({ email: u.email, name: u.firstName }));
        try {
          await sendBulk(recipients, template);
          sent += tzUsers.length;
          sends++;
        } catch (e) {
          console.error('[cron-continuation-alerts] send failed', signal.pair, tz, e.message);
        }
      }
    }

    return res.json({
      ok: true,
      users: users.length,
      signals: signals.length,
      sends,
      totalRecipients: sent,
    });
  } catch (e) {
    console.error('[cron-continuation-alerts]', e);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 45;
