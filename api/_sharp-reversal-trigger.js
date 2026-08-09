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
async function loadSharpReversalTriggers(sb, sinceISO, untilISO) {
  // sent_at is stamped ~5 min after firstSeen (the M5 close), so widen the
  // sent_at floor by 15 min to avoid dropping a trigger whose firstSeen sits
  // right at the window start. Callers filter by triggerTime themselves.
  const sentFloor = new Date(new Date(sinceISO).getTime() - 15 * 60000).toISOString();
  let q = sb.from('email_alert_log')
    .select('details, sent_at')
    .eq('alert_type', 'sharp_reversal_trigger')
    .gte('sent_at', sentFloor);
  if (untilISO) q = q.lte('sent_at', untilISO);
  const { data, error } = await q;
  if (error) { console.error('[sharp-reversal-trigger] read failed:', error.message); return {}; }

  const map = {};
  for (const r of data || []) {
    const d = r.details || {};
    if (!d.instrument || !d.direction) continue;
    const t = d.firstSeen || r.sent_at;
    const prev = map[d.instrument];
    if (!prev || new Date(t).getTime() < new Date(prev.triggerTime).getTime()) {
      map[d.instrument] = { direction: d.direction, triggerTime: t, mode: d.mode || null };
    }
  }
  return map;
}

module.exports = { loadSharpReversalTriggers };
