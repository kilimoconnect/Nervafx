'use strict';

/**
 * SCS — UI logic helpers (pure, shared by the History page and its tests).
 * The app is static HTML + vanilla JS with no browser test harness, so the
 * History-Mode behaviours (order lockout, time snapping, playback stepping,
 * weekend navigation, filter query) live here and are unit-tested directly.
 */

const H1 = 60 * 60 * 1000;

/** Orders are disabled whenever History Mode is active. */
function ordersDisabled(mode) { return mode === 'HISTORY'; }

/** Snap any selected time to the latest completed H1 close ≤ it. */
function snapSelectedToCompletedH1(atMs) { return Math.floor(atMs / H1) * H1; }

/** Step to previous / next completed H1 close. */
function stepH1(atMs, dir) { return snapSelectedToCompletedH1(atMs) + (dir >= 0 ? 1 : -1) * H1; }

/** Autoplay interval (ms) for a playback speed multiplier. */
function playbackIntervalMs(speed, baseMs = 1000) { const s = [1, 2, 4].includes(+speed) ? +speed : 1; return Math.round(baseMs / s); }

/** Weekend navigation targets from a history view. */
function weekendTargets(view) {
  if (!view || !view.weekend || !view.weekend.closed) return null;
  return { fridayClose: view.weekend.fridayCloseUtc, mondayReopen: view.weekend.mondayReopenUtc };
}

/** Build the replay API URL. */
function replayUrl(pair, atMs, tz) {
  return `/api/structure-continuation-engine?pair=${encodeURIComponent(pair)}&at=${encodeURIComponent(new Date(atMs).toISOString())}&timezone=${encodeURIComponent(tz)}`;
}

/** Build the backtest API URL with filters. */
function backtestUrl(pair, fromMs, toMs, filters = {}) {
  const p = new URLSearchParams({ mode: 'backtest', pair, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() });
  for (const [k, v] of Object.entries(filters)) if (v != null && v !== '') p.set(k, String(v));
  return `/api/structure-continuation-engine?${p.toString()}`;
}

module.exports = { ordersDisabled, snapSelectedToCompletedH1, stepH1, playbackIntervalMs, weekendTargets, replayUrl, backtestUrl };
