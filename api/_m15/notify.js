'use strict';

/**
 * M15 Intelligence — in-app notification selection (Phase 4, pure).
 *
 * Decides which manual-review opportunities warrant a NEW in-app notification.
 * Strict rules (§2): only on a LIVE, COMPLETE, non-stale snapshot; only for
 * ACTIONABLE episodes; deduplicated by episode id (which already encodes the
 * engine version); never on a historical replay; never re-announcing a stale or
 * already-notified setup. A notification is a flag for manual review — NEVER an
 * instruction or a broker order. No external (email/push) delivery here.
 */

/** Gate: may this snapshot emit notifications at all? */
function notifiable(ctx) {
  if (ctx.historyMode) return { ok: false, reason: 'REPLAY' };            // replay never alerts
  if (ctx.complete !== true) return { ok: false, reason: 'INCOMPLETE' };  // partial calc ≠ snapshot
  if (ctx.stale === true) return { ok: false, reason: 'STALE' };          // stale ≠ current
  return { ok: true, reason: 'LIVE_COMPLETE_FRESH' };
}

/**
 * @param ctx { historyMode, complete, stale, engineVersion, closeMs }
 * @param actionableEpisodes [{ episodeId, pair, direction, firstCloseMs }]
 * @param alreadyNotified Set<episodeId>  (persisted; dedup across candles + retries)
 * @returns { emit: [...notifications], suppressed: reason|null }
 */
function selectNewNotifications(ctx, actionableEpisodes, alreadyNotified = new Set()) {
  const gate = notifiable(ctx);
  if (!gate.ok) return { emit: [], suppressed: gate.reason };
  const emit = [];
  for (const e of actionableEpisodes) {
    if (alreadyNotified.has(e.episodeId)) continue;    // dedup by episode+version
    emit.push({
      episodeId: e.episodeId, pair: e.pair, direction: e.direction,
      kind: 'MANUAL_REVIEW_OPPORTUNITY',
      engineVersion: ctx.engineVersion, closeMs: ctx.closeMs,
      note: 'Analytical, manual-review only — not an instruction or order.',
    });
  }
  return { emit, suppressed: null };
}

module.exports = { notifiable, selectNewNotifications };
