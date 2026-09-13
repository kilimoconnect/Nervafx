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

/**
 * Owner-controlled incident pause (§3): set env M15_PAUSE=1 to suppress NEW
 * notices and downgrade Actionable to a paused state, WITHOUT erasing any history
 * (snapshots and journal are untouched). Reversible — unset the variable.
 */
function isPaused() { return /^(1|true|on|yes)$/i.test(process.env.M15_PAUSE || ''); }

/** Gate: may this snapshot emit notifications at all? */
function notifiable(ctx) {
  if (ctx.paused === true) return { ok: false, reason: 'PAUSED' };        // operator pause
  if (ctx.historyMode) return { ok: false, reason: 'REPLAY' };            // replay never alerts
  if (ctx.complete !== true) return { ok: false, reason: 'INCOMPLETE' };  // partial calc ≠ snapshot
  if (ctx.stale === true) return { ok: false, reason: 'STALE' };          // stale ≠ current
  return { ok: true, reason: 'LIVE_COMPLETE_FRESH' };
}

/**
 * Apply an operator pause to a scanner payload: every ACTIONABLE row is downgraded
 * (shown BLOCKED with reason PAUSED_BY_OPERATOR) and the Actionable count zeroed.
 * Pure; history is never touched — only what the screen presents right now.
 */
function applyOperatorPause(scan, counts, paused) {
  if (!paused) return { scan, counts };
  const outCounts = { ...counts };
  const moved = scan.filter((r) => r.category === 'ACTIONABLE').length;
  const outScan = scan.map((r) => r.category === 'ACTIONABLE'
    ? { ...r, category: 'BLOCKED', primaryReason: 'PAUSED_BY_OPERATOR' } : r);
  outCounts.ACTIONABLE = 0;
  outCounts.BLOCKED = (outCounts.BLOCKED || 0) + moved;
  return { scan: outScan, counts: outCounts };
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

module.exports = { notifiable, selectNewNotifications, isPaused, applyOperatorPause };
