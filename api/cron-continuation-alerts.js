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
    sb.from('email_preferences').select('user_id, signal_alerts, unsubscribed, notification_email').limit(2000),
    sb.from('profiles').select('id, timezone, first_name').limit(2000),
  ]);

  if (prefRes.error) console.error('[cron-continuation-alerts] email_preferences fetch:', prefRes.error.message);
  if (profRes.error) console.error('[cron-continuation-alerts] profiles fetch:', profRes.error.message);

  const prefMap = {};
  for (const p of prefRes.data || []) prefMap[p.user_id] = p;

  const profMap = {};
  for (const p of profRes.data || []) profMap[p.id] = p;

  const list = users.users.filter(u => {
    const p = prefMap[u.id];
    if (p?.unsubscribed) return false;
    if (p?.signal_alerts === false) return false;
    return true;
  }).map(u => {
    const prof = profMap[u.id] || {};
    const pref = prefMap[u.id] || {};
    const tz = (typeof prof.timezone === 'string' && prof.timezone.trim())
      ? prof.timezone.trim()
      : 'UTC';
    return {
      id: u.id,
      email: pref.notification_email || u.email,
      firstName: prof.first_name || u.user_metadata?.first_name || '',
      timezone: tz,
    };
  });

  console.log('[cron-continuation-alerts] recipients:', list.map(u => ({ email: u.email, tz: u.timezone })));
  return list;
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

    // Per-engine dedup window:
    //   Daily   → 24h (one alert per pair per forex day)
    //   H4      → 4h  (one alert per pair per H4 window)
    //   Session → 10h (covers the longest session — Asia)
    const ENGINE_COOLDOWN_MS = { Daily: 24 * 3600000, H4: 4 * 3600000, Session: 10 * 3600000 };
    const nowMs = Date.now();
    const lookbackCutoff = new Date(nowMs - 24 * 3600000).toISOString();

    const { data: sentRows } = await sb
      .from('email_alert_log')
      .select('details, sent_at')
      .eq('alert_type', 'continuation_trigger')
      .gte('sent_at', lookbackCutoff);

    // Track the most recent send time per (engine, instrument) pair.
    const lastSentAt = new Map();
    for (const r of sentRows || []) {
      const d = r.details || {};
      if (!d.engine || !d.instrument) continue;
      const key = `${d.engine}|${d.instrument}`;
      const t = new Date(r.sent_at).getTime();
      const prev = lastSentAt.get(key) || 0;
      if (t > prev) lastSentAt.set(key, t);
    }

    // Group users by timezone so we can bulk-send within a tz per signal.
    const byTz = new Map();
    for (const u of users) {
      const tz = u.timezone || 'UTC';
      if (!byTz.has(tz)) byTz.set(tz, []);
      byTz.get(tz).push(u);
    }

    // Track keys handled in THIS run so overlapping engines don't double-send.
    const seenThisRun = new Set();
    const results = [];

    for (const signal of signals) {
      const instrument = signal.instrument || (signal.pair || '').replace('/', '_');
      const pairKey = `${signal.engine}|${instrument}`;

      if (seenThisRun.has(pairKey)) {
        results.push({ key: pairKey, skipped: true, reason: 'duplicate in run' });
        continue;
      }
      const cooldown = ENGINE_COOLDOWN_MS[signal.engine] ?? 0;
      const last = lastSentAt.get(pairKey) || 0;
      if (cooldown && last && (nowMs - last) < cooldown) {
        results.push({ key: pairKey, skipped: true, reason: 'within cooldown' });
        continue;
      }
      seenThisRun.add(pairKey);

      let recipientCount = 0;
      let sendError = null;

      for (const [tz, tzUsers] of byTz.entries()) {
        const template = continuationPairAlertEmail(signal, tz);
        if (!template) continue;
        const recipients = tzUsers.map(u => ({ email: u.email, name: u.firstName }));
        try {
          await sendBulk(recipients, template);
          recipientCount += tzUsers.length;
        } catch (e) {
          sendError = e.message;
          console.error('[cron-continuation-alerts] send failed', signal.pair, tz, e.message);
        }
      }

      // Log the send so future runs skip this exact trigger.
      if (recipientCount > 0) {
        const { error: logErr } = await sb.from('email_alert_log').insert({
          alert_type: 'continuation_trigger',
          details: {
            engine: signal.engine,
            instrument,
            pair: signal.pair,
            direction: signal.direction,
            triggerTime: signal.triggerTime,
            recipients: recipientCount,
          },
        });
        if (logErr) console.error('[cron-continuation-alerts] log insert failed', logErr.message);
      }

      results.push({ key, recipientCount, error: sendError });
    }

    const dispatched = results.filter(r => r.recipientCount > 0).length;
    const skipped    = results.filter(r => r.skipped).length;
    const totalRecipients = results.reduce((n, r) => n + (r.recipientCount || 0), 0);

    return res.json({
      ok: true,
      users: users.length,
      signals: signals.length,
      dispatched,
      skipped,
      totalRecipients,
    });
  } catch (e) {
    console.error('[cron-continuation-alerts]', e);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 45;
