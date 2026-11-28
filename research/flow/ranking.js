'use strict';

/**
 * Shared pair-ranking + alert-trigger logic for the Inverted Flow compare view.
 *
 * Single source of truth for which pairs have an active "opposing-currency" setup and its signed gap,
 * and for the ⚡ alert set (aligned + 15M BoS in the lean direction). Both the frontend renderer and
 * the email-alert cron consume the rows produced here, so the logic lives in one place.
 *
 * DIRECTION comes from each currency's CURRENT confirmed Renko brick (continuous — no daily reset):
 * green/up = buy, red/down = sell. A pair has an active SETUP only while its two currencies' confirmed
 * bricks point OPPOSITE ways; the lean favours the green currency over the red. A setup begins at the
 * first synchronized observation where that lean became active and holds (across midnight/weekends)
 * until the currencies stop opposing or the lean flips directly. Pairs are ranked by the SIGNED GAP
 * since the setup began:
 *
 *     Gap = (green_now − green_at_setup_start) − (red_now − red_at_setup_start)   [percentage points]
 *
 * A positive gap = the lean has gained ground since it formed; negative = it has lost ground. Gap sign
 * and size affect ranking only. No orders, no signal — relative-movement research only.
 */

const { PAIRS } = require('../comparison/config');

// A pair is only listed / alertable once its setup has gained real ground: signed gap strictly above
// this many pp since the setup began. Keeps the table and the alert focused on movers.
const GAP_MIN_PP = 0.2;

// Build a per-observation CONFIRMED-direction array aligned to `observations` from the Renko `events`.
// dir[i] = direction of the last brick confirmed at or before observations[i].ms ('up'|'down'|null).
// A confirming observation carries its own new direction from that index onward (no look-ahead).
function dirSeries(observations, events) {
  const n = (observations || []).length;
  const dir = new Array(n).fill(null);
  const ev = events || [];
  let ei = 0, cur = null;
  for (let i = 0; i < n; i++) {
    const t = observations[i].ms;
    while (ei < ev.length && ev[ei].ms <= t) {
      const lv = ev[ei].levels || [];
      if (lv.length) cur = lv[lv.length - 1].dir;   // net direction after this (possibly multi-level) event
      ei++;
    }
    dir[i] = cur;
  }
  return dir;
}

// Rank pairs by the signed gap since each active setup began.
//   series: { CCY: { ms:[...], pp:[...], dir:[...] } }  — all index-aligned to the SAME synchronized
//           timeline (same ms sequence), pp in percentage points, dir the confirmed brick direction.
//   structures: { PAIR: 'up'|'down'|'mixed' }  M5 EMA20/EMA50 candle structure.
//   bos: { PAIR: {up:bool, down:bool} | 'up' | 'down' }  break of structure present per direction
//        (15M ≥2-of-3-prior-8 OR H1 prior-2 — either source counts; legacy scalar also accepted).
// Returns rows [{ pair, strong, weak, leanUp, dir, gap, setupStartMs, struct, bos }] for pairs with an
// ACTIVE setup at the cutoff (last index), sorted by gap desc then pair name (deterministic).
function rankedSetups(series, structures, bos) {
  structures = structures || {};
  bos = bos || {};
  series = series || {};
  const rows = [];
  PAIRS.forEach((pair) => {
    const pq = pair.split('_'), b = pq[0], q = pq[1];
    const sb = series[b], sq = series[q];
    if (!sb || !sq || !sb.dir || !sq.dir) return;
    const N = Math.min(sb.dir.length, sq.dir.length);
    if (N < 2) return;
    // Walk the shared timeline, tracking the CURRENT setup. A setup starts when the lean (which green,
    // which red) first becomes active, and is kept while that same lean holds; it ends when the two
    // currencies stop opposing, and a direct flip starts a new setup at that observation.
    let lean = null, startIdx = -1;
    for (let i = 0; i < N; i++) {
      const db = sb.dir[i], dq = sq.dir[i];
      const opposite = !!db && !!dq && db !== dq;
      if (!opposite) { lean = null; startIdx = -1; continue; }
      const curLean = (db === 'up') ? 'up' : 'down';   // base brick green → buy the pair (up)
      if (lean !== curLean) { lean = curLean; startIdx = i; }
    }
    if (lean == null || startIdx < 0) return;           // no active setup at the cutoff
    const last = N - 1;
    const baseUp = (lean === 'up');
    const green = baseUp ? b : q, red = baseUp ? q : b;
    const gs = series[green], rs = series[red];
    const gap = (gs.pp[last] - gs.pp[startIdx]) - (rs.pp[last] - rs.pp[startIdx]);
    rows.push({
      pair, strong: green, weak: red, leanUp: baseUp, dir: lean,
      gap, setupStartMs: sb.ms[startIdx],
      struct: structures[pair] || null, bos: bos[pair] || null,
    });
  });
  rows.sort((a, b) => (b.gap - a.gap) || (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0));
  return rows;
}

// Market-participation series: at every point on the shared synchronized timeline, the SUM of the
// signed gap over all pairs whose opposing-currency setup is active AND whose gap is above `gapMin`
// (the same pairs the compare list shows). A high sum = many pairs trending apart at once = broad
// participation; a low sum = few, shallow setups. Returns [{ ms, sum, count }] for the whole timeline.
//   series: { CCY: { ms:[...], pp:[...], dir:[...] } }  index-aligned (same ms grid for every currency).
function participationSeries(series, gapMin) {
  series = series || {};
  gapMin = (gapMin == null) ? GAP_MIN_PP : gapMin;
  // Canonical timeline = the longest available currency's ms (all share the synchronized grid).
  let ms = null;
  Object.keys(series).forEach((c) => { const s = series[c]; if (s && s.ms && (!ms || s.ms.length > ms.length)) ms = s.ms; });
  if (!ms || ms.length < 2) return [];
  const N = ms.length;
  const sum = new Array(N).fill(0), count = new Array(N).fill(0);
  PAIRS.forEach((pair) => {
    const pq = pair.split('_'), b = pq[0], q = pq[1];
    const sb = series[b], sq = series[q];
    if (!sb || !sq || !sb.dir || !sq.dir) return;
    const n = Math.min(sb.dir.length, sq.dir.length, N);
    let lean = null, startIdx = -1;
    for (let i = 0; i < n; i++) {
      const db = sb.dir[i], dq = sq.dir[i];
      const opposite = !!db && !!dq && db !== dq;
      if (!opposite) { lean = null; startIdx = -1; continue; }
      const curLean = (db === 'up') ? 'up' : 'down';
      if (lean !== curLean) { lean = curLean; startIdx = i; }
      const baseUp = (lean === 'up');
      const gs = baseUp ? sb : sq, rs = baseUp ? sq : sb;
      const gap = (gs.pp[i] - gs.pp[startIdx]) - (rs.pp[i] - rs.pp[startIdx]);
      if (gap > gapMin) { sum[i] += gap; count[i] += 1; }
    }
  });
  return ms.map((m, i) => ({ ms: m, sum: sum[i], count: count[i] }));
}

// Candle structure agrees with the brick lean.
function isAligned(r) {
  return (r.struct === 'up' || r.struct === 'down') && ((r.struct === 'up') === r.leanUp);
}

// A break of structure fired in the lean direction — from EITHER the 15M (≥2 of the last 3 M15 breaks
// of prior-8) OR the H1 (latest close breaks its prior-2 range). `r.bos` may be the combined
// {up,down} presence object, or a legacy scalar direction string.
function hasBos(r) {
  const want = r.leanUp ? 'up' : 'down';
  const b = r.bos;
  if (!b) return false;
  return (typeof b === 'string') ? (b === want) : !!b[want];
}

// The alert trigger set: active-setup pairs with a gap above GAP_MIN_PP that are also aligned AND have
// a trend-direction BoS. Returns [{ pair, direction, strong, weak, gap }] in gap-desc ranking order.
function alertable(rows) {
  return (rows || [])
    .filter((r) => r.gap > GAP_MIN_PP && isAligned(r) && hasBos(r))
    .map((r) => ({ pair: r.pair, direction: r.dir, strong: r.strong, weak: r.weak, gap: r.gap }));
}

module.exports = { dirSeries, rankedSetups, participationSeries, isAligned, hasBos, alertable, GAP_MIN_PP };
