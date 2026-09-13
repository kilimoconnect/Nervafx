'use strict';

/**
 * M15 Intelligence — manual observation journal helpers (Phase 4, pure).
 *
 * Builds a journal row that is ALWAYS scoped to the verified user id — a client
 * can never write another user's row, and the entry is explicitly self-reported.
 * The journal never infers a fill, never alters a signal, never places an order.
 */

const ACTIONS = ['SEEN', 'SKIPPED', 'MANUALLY_TRADED'];
const SKIP_REASONS = ['already_moved', 'spread_too_large', 'insufficient_room', 'not_available'];

/**
 * @param userId  the VERIFIED auth user id (from sb.auth.getUser) — authoritative
 * @param body    client input (its user_id, if any, is ignored)
 * @returns a row ready to upsert into m15i_journal
 * @throws on an invalid action / skip reason
 */
function buildJournalEntry(userId, body = {}) {
  if (!userId) throw new Error('no authenticated user');
  const action = String(body.action || '').toUpperCase();
  if (!ACTIONS.includes(action)) throw new Error(`invalid action (want ${ACTIONS.join('|')})`);
  if (action === 'SKIPPED' && body.skipReason && !SKIP_REASONS.includes(body.skipReason)) {
    throw new Error(`invalid skipReason (want ${SKIP_REASONS.join('|')})`);
  }
  return {
    user_id: userId,                                  // server-set, never from body
    episode_id: body.episodeId || null,
    pair: body.pair || null,
    source_candle_time: body.sourceCandleTime || null,
    engine_version: body.engineVersion || null,
    action,
    skip_reason: action === 'SKIPPED' ? (body.skipReason || null) : null,
    // self-reported trade details, if the user volunteered them — labelled as such
    self_reported: action === 'MANUALLY_TRADED'
      ? { ...(body.selfReported || {}), _selfReported: true }
      : (body.selfReported ? { ...body.selfReported, _selfReported: true } : null),
    updated_at: new Date().toISOString(),
  };
}

module.exports = { ACTIONS, SKIP_REASONS, buildJournalEntry };
