'use strict';

/**
 * Inverted Flow "aligned pair + 15M Break of Structure" email-alert core.
 *
 * Shared by api/cron-bos-alerts.js (standalone endpoint, for dry runs) and the scheduled pipeline
 * (src/updater.js, run by the GitHub Action every ~15 min — fires on the trigger that already runs,
 * no separate schedule or secret). Emails the aligned+BoS set (same ⚡ badge set as the page) to the
 * admin-managed recipients. A send is TRIGGERED when at least one pair+direction newly qualifies for
 * the EAT day (deduped so an unchanged list is not re-emailed every tick), and the email then lists
 * the FULL current aligned+BoS set — so a pair that is still qualifying from an earlier alert rides
 * along whenever a new pair joins it.
 *
 * Research/notification only — no orders, no buy/sell signal, no profitability claim.
 */

const { computeCompareData } = require('../api/inverted-flow');
const { alertable } = require('../research/flow/ranking');
const { sendBulk, bosAlertEmail } = require('./emailService');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

// EAT (UTC+3) calendar day for a given instant, as YYYY-MM-DD.
function eatDateStr(ms) {
  return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Heartbeat: record every invocation so the automatic trigger is observable (did it run? how often?
// what did it find? did it send?). Non-fatal and best-effort — if the table isn't present yet, or the
// write fails, it must never break the alert path. Query bos_alert_runs to see the cron's activity.
async function recordRun(sb, source, out) {
  try {
    await sb.from('bos_alert_runs').insert({
      ran_at: new Date().toISOString(),
      source: source || 'unknown',
      available: out.available !== false,
      candidates: out.candidates || 0,
      fresh: out.new || 0,
      recipients: out.recipients || 0,
      sent: out.sent === true,
      reason: out.reason || (out.sent ? 'sent' : (out.available === false ? out.reason || 'unavailable' : null)),
    });
  } catch (_) { /* best-effort heartbeat only */ }
}

// sb: a Supabase service-role client. opts: { asOfMs?, dry?, source? }.
async function runBosAlerts(sb, opts = {}) {
  const asOfMs = Math.min(opts.asOfMs || Date.now(), Date.now());
  const dry = !!opts.dry;
  const source = opts.source || 'manual';
  // Single exit: record a heartbeat on every return so the trigger is observable.
  const finish = async (out) => { if (!dry) await recordRun(sb, source, out); return out; };

  try {
  // 1) Recompute the compare view and find active-setup pairs that are aligned with a trend-direction
  //    15M BoS (ranked by the signed gap since each setup began — same rows the page shows).
  const cd = await computeCompareData(sb, { view: 'compare' }, asOfMs);
  if (!cd.available) return finish({ ok: true, available: false, reason: cd.reason });
  const asOfUtc = iso(cd.cutoffMs);
  const candidates = alertable(cd.pairRows);
  if (!candidates.length) return finish({ ok: true, asOfUtc, candidates: 0, new: 0, reason: 'no aligned+BoS pairs' });

  // 2) De-dup against what already fired today (EAT): one alert per pair+direction per EAT day.
  const eatDate = eatDateStr(cd.cutoffMs);
  const { data: logged, error: logErr } = await sb
    .from('bos_alert_log').select('pair, direction').eq('eat_date', eatDate);
  if (logErr) throw logErr;
  const seen = new Set((logged || []).map((r) => `${r.pair}:${r.direction}`));
  const fresh = candidates.filter((c) => !seen.has(`${c.pair}:${c.direction}`));
  if (!fresh.length) return finish({ ok: true, asOfUtc, eatDate, candidates: candidates.length, new: 0, reason: 'all already alerted today' });

  // 3) Active recipients (managed on /admin).
  const { data: recRows, error: recErr } = await sb
    .from('bos_alert_recipients').select('email').eq('active', true);
  if (recErr) throw recErr;
  const recipients = [...new Set((recRows || []).map((r) => String(r.email || '').trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))];

  if (dry) {
    return { ok: true, dry: true, asOfUtc, eatDate, candidates: candidates.length, new: fresh.length, newPairs: fresh, recipients: recipients.length };
  }
  // Nothing to send to — do NOT log to bos_alert_log, so these pairs still alert once a recipient is added today.
  if (!recipients.length) {
    return finish({ ok: true, asOfUtc, eatDate, candidates: candidates.length, new: fresh.length, recipients: 0, sent: false, reason: 'no active recipients' });
  }

  // 4) One batched email. A send is TRIGGERED by at least one fresh pair (a pair+direction not yet
  //    alerted today) — so we don't re-email every tick for an unchanged list. But the email BODY
  //    carries the FULL current aligned+BoS set (`candidates`), not just the fresh ones, so a pair
  //    that is still qualifying (e.g. NZD/USD alerted earlier) rides along when a new pair joins.
  //    force:true — intended alert path, exempt from the global ALERT_EMAILS_DISABLED guard.
  const template = bosAlertEmail({ asOfUtc, pairs: candidates });
  const result = await sendBulk(recipients, template, { force: true });
  const sent = Array.isArray(result) && result.length > 0;

  // 5) Only record the de-dup rows if the email actually went out (so a missing BREVO_API_KEY
  //    doesn't silently suppress the alert — it retries next tick once configured).
  if (sent) {
    const nowIso = new Date().toISOString();
    const rows = fresh.map((c) => ({
      pair: c.pair, direction: c.direction, eat_date: eatDate,
      strong: c.strong, weak: c.weak, spread: c.gap,   // `spread` column stores the signed gap-since-setup (pp)
      recipient_count: recipients.length, sent_at: nowIso,
    }));
    const { error: insErr } = await sb
      .from('bos_alert_log')
      .upsert(rows, { onConflict: 'pair,direction,eat_date', ignoreDuplicates: true });
    if (insErr) throw insErr;
  }

  return finish({ ok: true, asOfUtc, eatDate, candidates: candidates.length, new: fresh.length, newPairs: fresh.map((c) => `${c.pair} ${c.direction}`), recipients: recipients.length, sent });
  } catch (e) {
    // Record an error heartbeat so a thrown failure is visible in bos_alert_runs, not silent.
    if (!dry) await recordRun(sb, source, { available: false, candidates: 0, new: 0, recipients: 0, sent: false, reason: 'ERROR: ' + ((e && e.message) || e) });
    throw e;
  }
}

module.exports = { runBosAlerts };
