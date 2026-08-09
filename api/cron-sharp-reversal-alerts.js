'use strict';

// Event-driven Sharp Reversal alerts.
//
// Replaces the old hourly continuation-alert email. Instead of firing once an
// hour, this runs on the M5 cadence (*/5) and emails a pair the moment it shows
// up on https://www.nervafx.com/sharp-reversal-engine as a qualifying reversal
// (prior-5 break, Energy >= 90, and 15m HA + M15 + M5 all aligned with dir).
//
// A qualifying reversal usually keeps qualifying for many candles, so we dedup
// per (mode, instrument, direction) with a per-mode cooldown — one email per
// reversal event, not one every 5 minutes.

const { createClient } = require('@supabase/supabase-js');
const { sendBulk, sharpReversalAlertEmail } = require('../src/emailService');

const srHandler = require('./sharp-reversal-engine.js');

// Mode → display label + timeframe label. Drives which engine views we scan.
const MODES = [
  { key: 'standard', label: 'Standard', tf: 'H1 / M15 / M5' },
  { key: 'swing',    label: 'Scalp',    tf: 'M30 / M15 / M5' },
];

// Per-mode dedup window. A faster dominant timeframe reverses more often, so it
// gets a shorter cooldown before the same pair+direction can alert again.
const MODE_COOLDOWN_MS = {
  standard: 6 * 3600000,   // H1 dominant → 6h
  swing:    3 * 3600000,   // M30 dominant → 3h
};

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Invoke the sharp-reversal engine internally for one mode and capture its JSON.
function invokeEngine(mode) {
  return new Promise((resolve) => {
    const req = { method: 'GET', query: { mode }, headers: {}, _internal: true };
    let payload = null;
    let statusCode = 200;
    const res = {
      setHeader() {},
      status(code) { statusCode = code; return this; },
      json(data) { payload = data; resolve({ status: statusCode, data }); return this; },
      end() { resolve({ status: statusCode, data: payload }); },
    };
    Promise.resolve(srHandler(req, res)).catch((e) => resolve({ status: 500, data: { error: e.message } }));
  });
}

// Subscribed users + profile timezone (mirrors cron-continuation-alerts).
async function getSubscribedUsers(sb) {
  const { data: users } = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (!users?.users) return [];

  const [prefRes, profRes] = await Promise.all([
    sb.from('email_preferences').select('user_id, signal_alerts, unsubscribed, notification_email').limit(2000),
    sb.from('profiles').select('id, timezone, first_name').limit(2000),
  ]);
  if (prefRes.error) console.error('[cron-sharp-reversal-alerts] email_preferences fetch:', prefRes.error.message);
  if (profRes.error) console.error('[cron-sharp-reversal-alerts] profiles fetch:', profRes.error.message);

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
    const tz = (typeof prof.timezone === 'string' && prof.timezone.trim()) ? prof.timezone.trim() : 'UTC';
    return {
      id: u.id,
      email: pref.notification_email || u.email,
      firstName: prof.first_name || u.user_metadata?.first_name || '',
      timezone: tz,
    };
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  const isCron = process.env.CRON_SECRET && auth === process.env.CRON_SECRET;
  const isDebug = req.query?.debug === '1';
  if (!isCron && req.query?.force !== '1' && !isDebug) {
    return res.status(403).json({ error: 'Cron only' });
  }

  try {
    // Scan all three modes in parallel. Each returns its already-filtered
    // `pairs` array (broke + Energy>=90 + 15mHA/M15/M5 aligned).
    const results = await Promise.all(MODES.map(m => invokeEngine(m.key)));

    const signals = [];
    MODES.forEach((m, i) => {
      const r = results[i];
      const pairs = r.data?.pairs || [];
      const generatedAt = r.data?.generatedAt || new Date().toISOString();
      for (const p of pairs) {
        // Only alert on genuine reversal / fresh-trend states, not TREND/EXHAUSTION drift.
        if (p.state !== 'SHARP_REVERSAL' && p.state !== 'NEW_TREND') continue;
        signals.push({
          mode: m.key,
          modeLabel: m.label,
          tfLabel: m.tf,
          pair: p.pair,
          instrument: p.instrument,
          direction: p.direction,
          state: p.state,
          score: p.score,
          energy: p.energy,
          energyLabel: p.energyLabel,
          generatedAt,
          href: 'https://www.nervafx.com/sharp-reversal-engine',
        });
      }
    });

    if (isDebug) {
      return res.json({
        debug: true,
        env: { cronSecretSet: !!process.env.CRON_SECRET, brevoKeySet: !!process.env.BREVO_API_KEY },
        modes: MODES.map((m, i) => ({
          mode: m.key,
          error: results[i].data?.error || null,
          total: (results[i].data?.pairs || []).length,
          reversals: (results[i].data?.pairs || []).filter(p => p.state === 'SHARP_REVERSAL' || p.state === 'NEW_TREND').length,
          sample: (results[i].data?.pairs || []).slice(0, 3).map(p => ({ pair: p.pair, dir: p.direction, state: p.state, energy: p.energy, score: p.score })),
        })),
        candidateSignals: signals.map(s => ({ key: `${s.mode}|${s.instrument}|${s.direction}`, state: s.state, energy: s.energy })),
      });
    }

    if (!signals.length) return res.json({ ok: true, sent: 0, reason: 'no qualifying reversals' });

    const sb = getDB();

    // Persist first-seen triggers (independent of email delivery). This is the
    // one trigger the Daily / H1 / Session continuation engines monitor from.
    // Dedup per (mode|instrument|direction) within 24h so a reversal that keeps
    // qualifying records ONE first-seen timestamp, not one every 5 minutes.
    try {
      const trigLookback = new Date(Date.now() - 24 * 3600000).toISOString();
      const { data: trigRows } = await sb
        .from('email_alert_log')
        .select('details')
        .eq('alert_type', 'sharp_reversal_trigger')
        .gte('sent_at', trigLookback);
      const activeTrig = new Set();
      for (const r of trigRows || []) {
        const d = r.details || {};
        if (d.mode && d.instrument && d.direction) activeTrig.add(`${d.mode}|${d.instrument}|${d.direction}`);
      }
      const toInsert = [];
      const seenTrig = new Set();
      for (const s of signals) {
        const key = `${s.mode}|${s.instrument}|${s.direction}`;
        if (activeTrig.has(key) || seenTrig.has(key)) continue;
        seenTrig.add(key);
        toInsert.push({
          alert_type: 'sharp_reversal_trigger',
          details: { mode: s.mode, instrument: s.instrument, pair: s.pair, direction: s.direction, firstSeen: s.generatedAt },
        });
      }
      if (toInsert.length) {
        const { error: trigErr } = await sb.from('email_alert_log').insert(toInsert);
        if (trigErr) console.error('[cron-sharp-reversal-alerts] trigger log insert failed', trigErr.message);
      }
    } catch (e) {
      console.error('[cron-sharp-reversal-alerts] trigger persistence error', e.message);
    }

    const users = await getSubscribedUsers(sb);
    if (!users.length) return res.json({ ok: true, sent: 0, reason: 'no subscribed users' });

    // Pull recent sends (24h) so we can enforce the per-mode cooldown.
    const nowMs = Date.now();
    const lookbackCutoff = new Date(nowMs - 24 * 3600000).toISOString();
    const { data: sentRows } = await sb
      .from('email_alert_log')
      .select('details, sent_at')
      .eq('alert_type', 'sharp_reversal')
      .gte('sent_at', lookbackCutoff);

    // Most recent send time per (mode|instrument|direction).
    const lastSentAt = new Map();
    for (const row of sentRows || []) {
      const d = row.details || {};
      if (!d.mode || !d.instrument || !d.direction) continue;
      const key = `${d.mode}|${d.instrument}|${d.direction}`;
      const t = new Date(row.sent_at).getTime();
      if (t > (lastSentAt.get(key) || 0)) lastSentAt.set(key, t);
    }

    // Group recipients by timezone for per-signal bulk sends.
    const byTz = new Map();
    for (const u of users) {
      const tz = u.timezone || 'UTC';
      if (!byTz.has(tz)) byTz.set(tz, []);
      byTz.get(tz).push(u);
    }

    const seenThisRun = new Set();
    const out = [];

    for (const signal of signals) {
      const key = `${signal.mode}|${signal.instrument}|${signal.direction}`;
      if (seenThisRun.has(key)) { out.push({ key, skipped: true, reason: 'duplicate in run' }); continue; }

      const cooldown = MODE_COOLDOWN_MS[signal.mode] ?? 3 * 3600000;
      const last = lastSentAt.get(key) || 0;
      if (last && (nowMs - last) < cooldown) { out.push({ key, skipped: true, reason: 'within cooldown' }); continue; }
      seenThisRun.add(key);

      let recipientCount = 0;
      let sendError = null;
      for (const [tz, tzUsers] of byTz.entries()) {
        const template = sharpReversalAlertEmail(signal, tz);
        if (!template) continue;
        const recipients = tzUsers.map(u => ({ email: u.email, name: u.firstName }));
        try {
          await sendBulk(recipients, template, { force: true });   // exempt from the global email block
          recipientCount += tzUsers.length;
        } catch (e) {
          sendError = e.message;
          console.error('[cron-sharp-reversal-alerts] send failed', signal.pair, tz, e.message);
        }
      }

      if (recipientCount > 0) {
        const { error: logErr } = await sb.from('email_alert_log').insert({
          alert_type: 'sharp_reversal',
          details: {
            mode: signal.mode,
            instrument: signal.instrument,
            pair: signal.pair,
            direction: signal.direction,
            state: signal.state,
            energy: signal.energy,
            score: signal.score,
            generatedAt: signal.generatedAt,
            recipients: recipientCount,
          },
        });
        if (logErr) console.error('[cron-sharp-reversal-alerts] log insert failed', logErr.message);
      }

      out.push({ key, recipientCount, error: sendError });
    }

    const dispatched = out.filter(r => r.recipientCount > 0).length;
    const skipped = out.filter(r => r.skipped).length;
    const totalRecipients = out.reduce((n, r) => n + (r.recipientCount || 0), 0);

    return res.json({ ok: true, users: users.length, signals: signals.length, dispatched, skipped, totalRecipients });
  } catch (e) {
    console.error('[cron-sharp-reversal-alerts]', e);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
