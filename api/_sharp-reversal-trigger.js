'use strict';

// Shared reader for persisted Sharp Reversal triggers.
//
// The Sharp Reversal engine is a live snapshot — it does not record when a pair
// first qualified. The 5-min cron (cron-sharp-reversal-alerts) logs the first
// time each pair qualifies per mode into email_alert_log with
// alert_type = 'sharp_reversal_trigger' and details { mode, instrument, pair,
// direction, firstSeen }.
//
// This reader returns, per instrument, the EARLIEST first-seen trigger across
// Standard (standard) and Scalp (swing) — "whichever came first" — within the
// [sinceISO, untilISO] window. Continuation engines use it as their one trigger.
//
//   { EUR_USD: { direction: 'BUY', triggerTime: ISO, mode: 'standard' }, ... }
async function loadSharpReversalTriggers(sb, sinceISO, untilISO, maxAgeMs = 6 * 3600000) {
  // A trigger must be RECENT to start fresh monitoring — a reversal from many
  // hours ago has already played out. Cap the lookback to maxAgeMs (default 6h)
  // even when the engine's monitoring window (e.g. the full forex day) is longer,
  // so we don't surface every pair that reversed at some point today.
  const untilMs = untilISO ? new Date(untilISO).getTime() : Date.now();
  const effectiveSinceMs = Math.max(new Date(sinceISO).getTime(), untilMs - maxAgeMs);
  // sent_at is stamped ~5 min after firstSeen (the M5 close), so widen the
  // sent_at floor by 15 min to avoid dropping a trigger whose firstSeen sits
  // right at the window start. Callers filter by triggerTime themselves.
  const sentFloor = new Date(effectiveSinceMs - 15 * 60000).toISOString();
  // Read both the dedicated trigger log and the sharp-reversal email log — the
  // latter already records qualifying pairs (with generatedAt) from before the
  // trigger log existed, so today's reversals surface without waiting for a
  // fresh cron cycle.
  let q = sb.from('email_alert_log')
    .select('details, sent_at')
    .in('alert_type', ['sharp_reversal_trigger', 'sharp_reversal'])
    .gte('sent_at', sentFloor);
  if (untilISO) q = q.lte('sent_at', untilISO);
  const { data, error } = await q;
  if (error) { console.error('[sharp-reversal-trigger] read failed:', error.message); return {}; }

  const map = {};
  for (const r of data || []) {
    const d = r.details || {};
    if (!d.instrument || !d.direction) continue;
    const t = d.firstSeen || d.generatedAt || r.sent_at;   // firstSeen (trigger log) or generatedAt (email log)
    const prev = map[d.instrument];
    if (!prev || new Date(t).getTime() < new Date(prev.triggerTime).getTime()) {
      map[d.instrument] = { direction: d.direction, triggerTime: t, mode: d.mode || null };
    }
  }
  return map;
}

module.exports = { loadSharpReversalTriggers };
