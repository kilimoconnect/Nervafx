'use strict';

/**
 * CRON /api/cron-bos-alerts — email alert for Inverted Flow "aligned pair + 15M Break of Structure".
 *
 * Every 15 min (just after the candle sync) it recomputes the 8-index compare view, finds the pairs
 * that are aligned (currency-strength lean + EMA20/50 M5 structure agree) AND have a 15M BoS in that
 * direction — the exact ⚡ BoS set shown on the page — and emails any that have NOT already been
 * alerted today (EAT). One email per run, batching all newly-appeared pairs. No per-day cap beyond
 * the once-per-(pair,direction,EAT-day) de-duplication, so a persisting BoS is not re-sent each tick.
 *
 * Auth: Vercel Cron header or CRON_SECRET bearer token.
 * Query (manual/testing): ?dry=1 compute only (no send, no log); ?asOf=<ms|ISO> replay a past cutoff.
 *
 * Recipients live in bos_alert_recipients (managed on /admin). De-dup log in bos_alert_log.
 * Research/notification only — no orders, no buy/sell signal, no profitability claim.
 */

const { getClient } = require('./_db');
const { computeCompareData } = require('./inverted-flow');
const { alertablePairs } = require('../research/flow/ranking');
const { sendBulk, bosAlertEmail } = require('../src/emailService');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function authorized(req) {
  if (req.headers['x-vercel-cron'] === '1') return true;
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  return !!(process.env.CRON_SECRET && auth === process.env.CRON_SECRET);
}

// EAT (UTC+3) calendar day for a given instant, as YYYY-MM-DD.
function eatDateStr(ms) {
  return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const q = req.query || {};
  const dry = q.dry === '1' || q.dry === 'true';

  try {
    const sb = getClient();
    const asOfMs = Math.min(q.asOf ? (/^\d+$/.test('' + q.asOf) ? parseInt(q.asOf, 10) : Date.parse(q.asOf)) : Date.now(), Date.now());

    // 1) Recompute the compare view and find aligned pairs that have a trend-direction 15M BoS.
    const cd = await computeCompareData(sb, { view: 'compare' }, asOfMs);
    if (!cd.available) return res.json({ ok: true, available: false, reason: cd.reason });
    const asOfUtc = iso(cd.cutoffMs);
    const candidates = alertablePairs(cd.panels, cd.structures, cd.bos);
    if (!candidates.length) return res.json({ ok: true, asOfUtc, candidates: 0, new: 0 });

    // 2) De-dup against what already fired today (EAT): one alert per pair+direction per EAT day.
    const eatDate = eatDateStr(cd.cutoffMs);
    const { data: logged, error: logErr } = await sb
      .from('bos_alert_log')
      .select('pair, direction')
      .eq('eat_date', eatDate);
    if (logErr) throw logErr;
    const seen = new Set((logged || []).map((r) => `${r.pair}:${r.direction}`));
    const fresh = candidates.filter((c) => !seen.has(`${c.pair}:${c.direction}`));
    if (!fresh.length) {
      return res.json({ ok: true, asOfUtc, eatDate, candidates: candidates.length, new: 0 });
    }

    // 3) Active recipients (managed on /admin).
    const { data: recRows, error: recErr } = await sb
      .from('bos_alert_recipients')
      .select('email')
      .eq('active', true);
    if (recErr) throw recErr;
    const recipients = [...new Set((recRows || []).map((r) => String(r.email || '').trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))];

    if (dry) {
      return res.json({ ok: true, dry: true, asOfUtc, eatDate, candidates: candidates.length, new: fresh.length, newPairs: fresh, recipients: recipients.length });
    }
    // Nothing to send to — do NOT log, so these pairs still alert once a recipient is added today.
    if (!recipients.length) {
      return res.json({ ok: true, asOfUtc, eatDate, candidates: candidates.length, new: fresh.length, recipients: 0, sent: false, reason: 'no active recipients' });
    }

    // 4) One batched email. force:true — this is an intended alert path, exempt from the global
    //    ALERT_EMAILS_DISABLED guard (same mechanism the continuation cron uses).
    const template = bosAlertEmail({ asOfUtc, pairs: fresh });
    const result = await sendBulk(recipients, template, { force: true });
    const sent = Array.isArray(result) && result.length > 0;

    // 5) Only record the de-dup rows if the email actually went out (so a missing BREVO_API_KEY
    //    doesn't silently suppress the alert — it retries next tick once configured).
    if (sent) {
      const nowIso = new Date().toISOString();
      const rows = fresh.map((c) => ({
        pair: c.pair, direction: c.direction, eat_date: eatDate,
        strong: c.strong, weak: c.weak, spread: c.spread,
        recipient_count: recipients.length, sent_at: nowIso,
      }));
      const { error: insErr } = await sb
        .from('bos_alert_log')
        .upsert(rows, { onConflict: 'pair,direction,eat_date', ignoreDuplicates: true });
      if (insErr) throw insErr;
    }

    return res.json({ ok: true, asOfUtc, eatDate, candidates: candidates.length, new: fresh.length, newPairs: fresh.map((c) => `${c.pair} ${c.direction}`), recipients: recipients.length, sent });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 120;
