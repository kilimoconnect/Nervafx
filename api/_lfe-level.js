'use strict';

/**
 * NervaFX Liquidity Failure Engine — H1 liquidity-level detection.
 *
 * Deterministic and lookahead-free: every function operates on the array of
 * completed H1 candles it is given. A candle at index i is confirmed as a pivot
 * only once candles i+1 and i+2 are present, so if the caller passes only the
 * candles whose close ≤ evaluation time, no future information can leak in.
 *
 * Produces levels; it does NOT detect buyer/seller failures (Portion 4).
 */

const {
  HOUR_MS, DAY_MS, CONFIG,
  LEVEL_TYPE, ORIENTATION, LEVEL_STATE, LEVEL_SCORES,
} = require('./_lfe-constants');
const { atrSeries, atrNowOf, zoneWidth, mean } = require('./_lfe-math');
const { appendTransition } = require('./_lfe-persist');

const RESISTANCE_TYPES = new Set([LEVEL_TYPE.SWING_HIGH, LEVEL_TYPE.EQUAL_HIGHS, LEVEL_TYPE.PREV_DAY_HIGH]);
const orientationOf = (t) => (RESISTANCE_TYPES.has(t) ? ORIENTATION.RESISTANCE : ORIENTATION.SUPPORT);

const closeMs = (c) => c.openMs + HOUR_MS;

/**
 * Confirmed H1 pivots. Swing high: high ≥ the two highs on each side, with at
 * least one strictly lower (rejects flat plateaus). Swing low is the inverse.
 * availableAtMs is the CLOSE of candle i+2 — the confirmation moment.
 */
function detectPivots(candles, atr, cfg) {
  cfg = cfg || CONFIG;
  const L = cfg.pivot.h1Left, R = cfg.pivot.h1Right;
  const out = [];
  for (let i = L; i + R < candles.length; i++) {
    const c = candles[i];
    const atrAt = atr[i];

    // Swing high
    let geAll = true, strictOne = false;
    for (let k = i - L; k <= i + R; k++) {
      if (k === i) continue;
      if (candles[k].high > c.high) { geAll = false; break; }
      if (candles[k].high < c.high) strictOne = true;
    }
    if (geAll && strictOne) {
      out.push(makePivot(candles, i, LEVEL_TYPE.SWING_HIGH, c.high, atrAt, cfg, R));
    }

    // Swing low
    geAll = true; strictOne = false;
    for (let k = i - L; k <= i + R; k++) {
      if (k === i) continue;
      if (candles[k].low < c.low) { geAll = false; break; }
      if (candles[k].low > c.low) strictOne = true;
    }
    if (geAll && strictOne) {
      out.push(makePivot(candles, i, LEVEL_TYPE.SWING_LOW, c.low, atrAt, cfg, R));
    }
  }
  return out;
}

function makePivot(candles, i, type, price, atrAt, cfg, R) {
  return {
    index: i,
    type,
    price,
    pivotAtMs: candles[i].openMs,
    availableAtMs: closeMs(candles[i + R]),
    atrAt,
    reacted: reactedAway(candles, i, type, price, atrAt, cfg),
  };
}

/**
 * Did price react ≥ reactionAtr × ATR away from the pivot before returning to
 * the level? Evaluated only over the candles provided (never the future).
 */
function reactedAway(candles, i, type, price, atrAt, cfg) {
  if (!atrAt) return false;
  const need = cfg.swing.reactionAtr * atrAt;
  for (let j = i + 1; j < candles.length; j++) {
    if (type === LEVEL_TYPE.SWING_HIGH) {
      if (candles[j].low <= price - need) return true;   // reacted down
      if (candles[j].high >= price) return false;         // returned to the high first
    } else {
      if (candles[j].high >= price + need) return true;   // reacted up
      if (candles[j].low <= price) return false;          // returned to the low first
    }
  }
  return false;
}

function makeLevel(type, centre, atrNow, pair, cfg, extra) {
  const half = zoneWidth(atrNow, (extra && extra.spread) || 0) / 2;
  return Object.assign({
    pair,
    levelType: type,
    orientation: orientationOf(type),
    centre,
    zoneLow: centre - half,
    zoneHigh: centre + half,
    touches: 1,
    firstTouchMs: null,
    latestTouchMs: null,
    availableAtMs: null,
    score: 0,
    state: LEVEL_STATE.ACTIVE,
    transitions: [],
  }, extra || {});
}

/** Each confirmed swing pivot → a swing level (major if it reacted, else minor). */
function swingLevels(pivots, atrNow, pair, cfg) {
  cfg = cfg || CONFIG;
  return pivots.map((p) => makeLevel(p.type, p.price, atrNow, pair, cfg, {
    touches: 1,
    firstTouchMs: p.pivotAtMs,
    latestTouchMs: p.pivotAtMs,
    availableAtMs: p.availableAtMs,
    major: !!p.reacted,
    score: p.reacted ? LEVEL_SCORES.SWING_MAJOR : LEVEL_SCORES.SWING_MINOR,
    reacted: !!p.reacted,
  }));
}

/**
 * Group same-type pivots into equal-high/low levels when prices are within
 * 0.10 × ATR and touches are ≥ minTouchSeparation candles apart.
 */
function groupEqualLevels(pivots, atrNow, pair, cfg) {
  cfg = cfg || CONFIG;
  const tol = cfg.zone.equalLevelTolAtr * atrNow;
  const sep = cfg.equal.minTouchSeparation;
  const levels = [];

  for (const kind of [LEVEL_TYPE.SWING_HIGH, LEVEL_TYPE.SWING_LOW]) {
    const eqType = kind === LEVEL_TYPE.SWING_HIGH ? LEVEL_TYPE.EQUAL_HIGHS : LEVEL_TYPE.EQUAL_LOWS;
    const pts = pivots.filter((p) => p.type === kind).slice().sort((a, b) => a.index - b.index);
    const clusters = [];

    for (const p of pts) {
      let placed = false;
      for (const cl of clusters) {
        if (Math.abs(cl.centre - p.price) <= tol) {
          const gap = p.index - cl.lastIndex;
          if (gap >= sep) { cl.touches.push(p); cl.centre = mean(cl.touches.map((t) => t.price)); cl.lastIndex = p.index; }
          placed = true; // matched a cluster (added or skipped as too-close redundant touch)
          break;
        }
      }
      if (!placed) clusters.push({ centre: p.price, lastIndex: p.index, touches: [p] });
    }

    for (const cl of clusters) {
      if (cl.touches.length < 2) continue;
      const prices = cl.touches.map((t) => t.price);
      const centre = mean(prices);
      const times = cl.touches.map((t) => t.pivotAtMs);
      const avail = cl.touches.map((t) => t.availableAtMs).sort((a, b) => a - b);
      const lvl = makeLevel(eqType, centre, atrNow, pair, cfg, {
        touches: cl.touches.length,
        firstTouchMs: Math.min.apply(null, times),
        latestTouchMs: Math.max.apply(null, times),
        // Available once the 2nd touch is confirmed.
        availableAtMs: avail[1],
        score: cl.touches.length >= 3 ? LEVEL_SCORES.EQUAL_3PLUS : LEVEL_SCORES.EQUAL_2,
      });
      // Widen the zone to span the touch prices if they are wider than the ATR zone.
      lvl.zoneLow = Math.min(lvl.zoneLow, Math.min.apply(null, prices));
      lvl.zoneHigh = Math.max(lvl.zoneHigh, Math.max.apply(null, prices));
      levels.push(lvl);
    }
  }
  return levels;
}

/**
 * Previous trading-day high/low from D1 candles (17:00 NY convention as stored).
 * Picks the most recent D1 whose close ≤ evalMs, so Monday naturally uses
 * Friday's completed candle and no weekend candle is ever invented.
 */
function previousDayLevels(d1Candles, evalMs, atrNow, pair, cfg) {
  cfg = cfg || CONFIG;
  let chosen = null;
  for (const d of d1Candles) {
    const dClose = d.openMs + DAY_MS;
    if (dClose <= evalMs && (!chosen || d.openMs > chosen.openMs)) chosen = d;
  }
  if (!chosen) return [];
  const availableAtMs = chosen.openMs + DAY_MS;
  const common = { touches: 1, availableAtMs, score: LEVEL_SCORES.PREV_DAY, firstTouchMs: chosen.openMs, latestTouchMs: chosen.openMs };
  return [
    makeLevel(LEVEL_TYPE.PREV_DAY_HIGH, chosen.high, atrNow, pair, cfg, common),
    makeLevel(LEVEL_TYPE.PREV_DAY_LOW, chosen.low, atrNow, pair, cfg, Object.assign({}, common)),
  ];
}

/**
 * Merge overlapping same-orientation levels whose centres are within
 * 0.15 × ATR, keeping the higher-scored level and unioning touch metadata.
 */
function mergeLevels(levels, atrNow, cfg) {
  cfg = cfg || CONFIG;
  const tol = cfg.merge.atrMultiplier * atrNow;
  const out = [];

  for (const orient of [ORIENTATION.RESISTANCE, ORIENTATION.SUPPORT]) {
    const group = levels.filter((l) => l.orientation === orient).slice().sort((a, b) => a.centre - b.centre);
    let cur = null;
    for (const l of group) {
      if (cur && Math.abs(l.centre - cur.centre) <= tol) {
        cur = combine(cur, l);
      } else {
        if (cur) out.push(cur);
        cur = Object.assign({}, l);
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

function combine(a, b) {
  const keep = b.score > a.score ? b : a;   // higher score wins type/score
  return Object.assign({}, keep, {
    centre: keep.centre,
    zoneLow: Math.min(a.zoneLow, b.zoneLow),
    zoneHigh: Math.max(a.zoneHigh, b.zoneHigh),
    touches: (a.touches || 0) + (b.touches || 0),
    firstTouchMs: Math.min(a.firstTouchMs != null ? a.firstTouchMs : Infinity, b.firstTouchMs != null ? b.firstTouchMs : Infinity),
    latestTouchMs: Math.max(a.latestTouchMs != null ? a.latestTouchMs : -Infinity, b.latestTouchMs != null ? b.latestTouchMs : -Infinity),
    availableAtMs: Math.min(a.availableAtMs != null ? a.availableAtMs : Infinity, b.availableAtMs != null ? b.availableAtMs : Infinity),
  });
}

/** Append a lifecycle transition without overwriting history. */
function transitionLevel(level, toState, atMs, reason) {
  const key = `${level.pair}:${level.levelType}:${level.centre}`;
  appendTransition(level.transitions, {
    signalKey: key, fromState: level.state, toState, reason,
    occurredAt: new Date(atMs).toISOString(),
  });
  level.state = toState;
  return level;
}

/**
 * Full as-of-evalMs level set for one pair. `candles` and `d1Candles` must
 * already be bounded to completed candles ≤ evalMs by the caller.
 */
function buildLevels(opts) {
  const cfg = opts.cfg || CONFIG;
  const candles = opts.candles || [];
  const atr = opts.atr || atrSeries(candles, cfg.atr.h1Period);
  const atrNow = opts.atrNow != null ? opts.atrNow : atrNowOf(atr);
  const pair = opts.pair;
  const evalMs = opts.evalMs;

  if (!atrNow) return { atrNow: null, pivots: [], levels: [] };

  const pivots = detectPivots(candles, atr, cfg)
    .filter((p) => evalMs == null || p.availableAtMs <= evalMs);

  let levels = []
    .concat(groupEqualLevels(pivots, atrNow, pair, cfg))
    .concat(swingLevels(pivots, atrNow, pair, cfg))
    .concat(previousDayLevels(opts.d1Candles || [], evalMs != null ? evalMs : Infinity, atrNow, pair, cfg));

  levels = mergeLevels(levels, atrNow, cfg);
  // Stable ordering for deterministic output.
  levels.sort((a, b) => (a.orientation === b.orientation ? a.centre - b.centre : a.orientation < b.orientation ? -1 : 1));
  return { atrNow, pivots, levels };
}

module.exports = {
  orientationOf,
  detectPivots,
  reactedAway,
  swingLevels,
  groupEqualLevels,
  previousDayLevels,
  mergeLevels,
  transitionLevel,
  buildLevels,
};
