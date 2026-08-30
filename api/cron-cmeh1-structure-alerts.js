'use strict';

/**
 * Currency Movement Engine (H1) — Structure-Confirmed Movement alerts.
 *
 * Emails a pair the moment the H1 engine classifies it as
 * STRUCTURE_CONFIRMED_MOVEMENT with |move edge| ≥ 90, |confirmed| ≥ 90 and BOS
 * close quality ≥ 70% (same gate as the H1 page's pair-edges table). Runs
 * hourly (just after the H1 candle closes); deduped per (pair|direction) with a
 * cooldown. Isolated.
 */

const { createClient } = require('@supabase/supabase-js');
const { sendBulk, cmeStructureAlertEmail } = require('../src/emailService');

const cmeh1Handler = require('./currency-movement-h1-engine.js');

const MIN_MOVE_EDGE = 90;               // |pairMovementEdge| ≥ this
const MIN_CONFIRMED_EDGE = 90;          // |pairConfirmedEdge| ≥ this
const MIN_CLOSE_QUALITY = 0.70;         // BOS close quality ≥ this (70%)
const COOLDOWN_MS = 6 * 3600000;        // one email per pair+direction per 6h
const HREF = 'https://www.nervafx.com/currency-movement-h1-engine';

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function invokeEngine(extraQuery) {
  return new Promise((resolve) => {
    const req = { method: 'GET', query: extraQuery || {}, headers: {}, _internal: true };
    let payload = null; let statusCode = 200;
    const res = {
      setHeader() {}, status(code) { statusCode = code; return this; },
      json(data) { payload = data; resolve({ status: statusCode, data }); return this; },
      end() { resolve({ status: statusCode, data: payload }); },
    };
    Promise.resolve(cmeh1Handler(req, res)).catch((e) => resolve({ status: 500, data: { error: e.message } }));
  });
}

async function getSubscribedUsers(sb) {
  const { data: users } = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (!users || !users.users) return [];
  const [prefRes, profRes] = await Promise.all([
    sb.from('email_preferences').select('user_id, signal_alerts, unsubscribed, notification_email').limit(2000),
    sb.from('profiles').select('id, timezone, first_name').limit(2000),
  ]);
  const prefMap = {}; for (const p of prefRes.data || []) prefMap[p.user_id] = p;
  const profMap = {}; for (const p of profRes.data || []) profMap[p.id] = p;
  return (users.users || []).filter((u) => {
    const p = prefMap[u.id];
    if (p && p.unsubscribed) return false;
    if (p && p.signal_alerts === false) return false;
    return true;
  }).map((u) => {
    const prof = profMap[u.id] || {}; const pref = prefMap[u.id] || {};
    const tz = (typeof prof.timezone === 'string' && prof.timezone.trim()) ? prof.timezone.trim() : 'UTC';
    return { id: u.id, email: pref.notification_email || u.email, firstName: prof.first_name || (u.user_metadata && u.user_metadata.first_name) || '', timezone: tz };
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  const isCron = process.env.CRON_SECRET && auth === process.env.CRON_SECRET;
  const isDebug = req.query && req.query.debug === '1';
  if (!isCron && !(req.query && req.query.force === '1') && !isDebug) {
    return res.status(403).json({ error: 'Cron only' });
  }

  try {
    const q = req.query || {};
    const engineQuery = q.at ? { at: q.at, timezone: q.timezone } : {};
    const r = await invokeEngine(engineQuery);
    const edges = (r.data && r.data.pairEdges) || [];
    const generatedAt = (r.data && r.data.generatedAt) || new Date().toISOString();

    const signals = edges
      .filter((e) => e.opportunity === 'STRUCTURE_CONFIRMED_MOVEMENT'
        && Math.abs(e.pairMovementEdge || 0) >= MIN_MOVE_EDGE
        && Math.abs(e.pairConfirmedEdge || 0) >= MIN_CONFIRMED_EDGE
        && (e.closeQuality || 0) >= MIN_CLOSE_QUALITY
        && e.bosDirection && e.bosDirection !== 'NONE')
      .map((e) => ({
        pair: e.pair.replace('_', '/'), instrument: e.pair, bosDirection: e.bosDirection, bosGrade: e.bosGrade,
        breakDistanceATR: e.breakDistanceATR, closeQuality: e.closeQuality,
        pairMovementEdge: e.pairMovementEdge, pairConfirmedEdge: e.pairConfirmedEdge,
        baseCurrency: e.baseCurrency, quoteCurrency: e.quoteCurrency, timeframe: 'H1', generatedAt, href: HREF,
      }));

    if (isDebug) {
      const topEdges = edges.slice()
        .sort((a, b) => Math.abs(b.pairMovementEdge || 0) - Math.abs(a.pairMovementEdge || 0))
        .slice(0, 10)
        .map((e) => ({ pair: e.pair.replace('_', '/'), move: e.pairMovementEdge, confirmed: e.pairConfirmedEdge, closeQ: e.closeQuality, grade: e.bosGrade, dir: e.bosDirection, opp: e.opportunity }));
      return res.json({
        debug: true,
        thresholds: { MIN_MOVE_EDGE, MIN_CONFIRMED_EDGE, MIN_CLOSE_QUALITY },
        generatedAt: (r.data && r.data.generatedAt) || null,
        engineError: (r.data && r.data.error) || null,
        totalEdges: edges.length, qualifying: signals.length, topEdges,
        candidates: signals.map((s) => ({ pair: s.pair, dir: s.bosDirection, grade: s.bosGrade, moveEdge: s.pairMovementEdge, confirmed: s.pairConfirmedEdge, closeQ: s.closeQuality })),
      });
    }

    if (!signals.length) return res.json({ ok: true, sent: 0, reason: 'no structure-confirmed movements' });

    const sb = getDB();
    const users = await getSubscribedUsers(sb);
    if (!users.length) return res.json({ ok: true, sent: 0, reason: 'no subscribed users' });

    const nowMs = Date.now();
    const cutoff = new Date(nowMs - 24 * 3600000).toISOString();
    const { data: sentRows } = await sb.from('email_alert_log')
      .select('details, sent_at').eq('alert_type', 'cmeh1_structure').gte('sent_at', cutoff);
    const lastSentAt = new Map();
    for (const row of sentRows || []) {
      const d = row.details || {};
      if (!d.instrument || !d.direction) continue;
      const key = d.instrument + '|' + d.direction;
      const t = new Date(row.sent_at).getTime();
      if (t > (lastSentAt.get(key) || 0)) lastSentAt.set(key, t);
    }

    const byTz = new Map();
    for (const u of users) { const tz = u.timezone || 'UTC'; if (!byTz.has(tz)) byTz.set(tz, []); byTz.get(tz).push(u); }

    const seen = new Set();
    const out = [];
    for (const signal of signals) {
      const key = signal.instrument + '|' + signal.bosDirection;
      if (seen.has(key)) { out.push({ key, skipped: 'dup in run' }); continue; }
      const last = lastSentAt.get(key) || 0;
      if (last && (nowMs - last) < COOLDOWN_MS) { out.push({ key, skipped: 'cooldown' }); continue; }
      seen.add(key);

      let recipientCount = 0; let sendError = null;
      for (const [tz, tzUsers] of byTz.entries()) {
        const template = cmeStructureAlertEmail(signal, tz);
        if (!template) continue;
        try {
          await sendBulk(tzUsers.map((u) => ({ email: u.email, name: u.firstName })), template, { force: true });
          recipientCount += tzUsers.length;
        } catch (e) { sendError = e.message; console.error('[cron-cmeh1-structure-alerts] send failed', signal.pair, tz, e.message); }
      }
      if (recipientCount > 0) {
        const { error: logErr } = await sb.from('email_alert_log').insert({
          alert_type: 'cmeh1_structure',
          details: { instrument: signal.instrument, pair: signal.pair, direction: signal.bosDirection, grade: signal.bosGrade, breakDistanceATR: signal.breakDistanceATR, confirmedEdge: signal.pairConfirmedEdge, generatedAt: signal.generatedAt, recipients: recipientCount },
        });
        if (logErr) console.error('[cron-cmeh1-structure-alerts] log insert failed', logErr.message);
      }
      out.push({ key, recipientCount, error: sendError });
    }

    const dispatched = out.filter((o) => o.recipientCount > 0).length;
    return res.json({ ok: true, users: users.length, signals: signals.length, dispatched, skipped: out.filter((o) => o.skipped).length });
  } catch (e) {
    console.error('[cron-cmeh1-structure-alerts]', e);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
