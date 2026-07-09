'use strict';

const { createClient } = require('@supabase/supabase-js');
const { sendBulk, continuationAlertsEmail } = require('../src/emailService');

const dailyHandler   = require('./daily-continuation.js');
const h4Handler      = require('./h1-continuation.js');
const sessionHandler = require('./session-continuation.js');

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
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

// Invoke a continuation handler internally with the cron secret so it skips
// the plan gate. Captures the JSON response.
async function invokeHandler(handler) {
  return await new Promise((resolve) => {
    const req = {
      method: 'GET',
      query: {},
      headers: { 'x-cron-secret': process.env.CRON_SECRET },
    };
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
    // Fire all three engines in parallel
    const [dailyRes, h4Res, sessionRes] = await Promise.all([
      invokeHandler(dailyHandler),
      invokeHandler(h4Handler),
      invokeHandler(sessionHandler),
    ]);

    const daily   = (dailyRes.data?.pairs   || []).slice(0, 3);
    const h4      = (h4Res.data?.pairs      || []).slice(0, 3);
    const session = (sessionRes.data?.pairs || []).slice(0, 3);

    if (!daily.length && !h4.length && !session.length) {
      return res.json({ ok: true, sent: 0, reason: 'no triggers' });
    }

    const template = continuationAlertsEmail({ daily, h4, session });
    if (!template) return res.json({ ok: true, sent: 0, reason: 'template empty' });

    const sb = getDB();
    const users = await getSubscribedUsers(sb);
    if (!users.length) return res.json({ ok: true, sent: 0, reason: 'no subscribed users' });

    const recipients = users.map(u => ({ email: u.email, name: u.firstName }));
    await sendBulk(recipients, template);

    return res.json({
      ok: true,
      sent: users.length,
      counts: { daily: daily.length, h4: h4.length, session: session.length },
    });
  } catch (e) {
    console.error('[cron-continuation-alerts]', e);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 45;
