'use strict';

/**
 * Breakout Strength & Signals — configuration (versioned research defaults).
 *
 * One deterministic methodology, three INDEPENDENT strategies:
 *
 *   latest qualifying higher-timeframe break of structure (per pair)
 *     → currency strength (±1 base/quote votes)
 *     → strong-vs-weak pair qualification
 *     → fresh lower-timeframe break of structure → signal.
 *
 *   strategy   direction/strength TF   entry-trigger TF
 *   daily      D1                      H1
 *   weekly     W1                      H4
 *   monthly    MN1                     D1
 *
 * A strategy never requires agreement with another: a currency can be strong on
 * Daily and weak on Monthly. Candle boundaries are EAT (UTC+3, no DST), aggregated
 * from stored H1 (see candles.js). Research only — NO orders, stops, targets, or
 * profitability/win-rate claims; a trigger close is a reference price, not a fill.
 */

const { CURRENCIES, PAIRS, pairFor, legsFor } = require('../comparison/config');
const { dayStart, h4Start, weekStart, monthStart, EAT_OFFSET_MS } = require('../comparison/periods');

const HOUR_MS = 60 * 60 * 1000;
const H4_MS = 4 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;

// Timeframe metadata. `boundary(ms)` returns the EAT-aligned open of the bucket
// containing ms; `nextBoundary(openMs)` returns the next bucket open (= this bucket close).
const TF = {
  H1: {
    key: 'H1', label: 'H1', ms: HOUR_MS, aggregated: false,
    boundary: (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS,          // stored hourly (UTC hour == EAT hour)
    nextBoundary: (openMs) => openMs + HOUR_MS,
  },
  H4: {
    key: 'H4', label: 'H4', ms: H4_MS, aggregated: true,
    boundary: h4Start,                                            // 00/04/08/12/16/20 EAT
    nextBoundary: (openMs) => openMs + H4_MS,
  },
  D1: {
    key: 'D1', label: 'D1', ms: DAY_MS, aggregated: true,
    boundary: dayStart,                                           // 00:00 EAT
    nextBoundary: (openMs) => openMs + DAY_MS,
  },
  W1: {
    key: 'W1', label: 'W1', ms: 7 * DAY_MS, aggregated: true,
    boundary: weekStart,                                          // Monday 00:00 EAT
    nextBoundary: (openMs) => openMs + 7 * DAY_MS,
  },
  MN1: {
    key: 'MN1', label: 'MN1', ms: 30 * DAY_MS, aggregated: true,  // nominal; months vary
    boundary: monthStart,                                         // 1st 00:00 EAT
    nextBoundary: (openMs) => monthStart(openMs + 32 * DAY_MS),   // start of the next EAT month
  },
};

// `methodology` identifies the RULES (never changes without a code release). v2 derives currency
// direction from the Evolution index (see condition.js), NOT from persistent break-of-structure
// votes. Each strategy carries a `condition` block: the EAT period baseline and the fast/slow
// rolling windows (counted in M15 intervals) over which recent direction is measured.
//   daily  : fast 1h (4×M15) / slow 4h (16×M15),  baseline = EAT day
//   weekly : fast 4h (16×M15)/ slow 24h (96×M15), baseline = EAT week (Mon)
//   monthly: fast 24h (96×M15)/slow 120h (480×M15), baseline = EAT month (1st)
// The effective `version` encodes the methodology + the configurable params (breadth, windows,
// deadbands) so any change creates a distinct settings version: past signals keep their version,
// new ones carry the new one, and the two never collide on the deterministic signal id. v1 signals
// (`bss-_-1.0.0-t_`) are preserved read-only and are never recomputed or relabelled.
const STRATEGIES = {
  daily:   { key: 'daily',   label: 'Daily',   dirTf: 'D1',  triggerTf: 'H1', methodology: 'bss-d-2.0.0',
             condition: { periodStart: dayStart,   periodLabel: 'EAT day',   fast: 4,  slow: 16,  fastLabel: '1h',  slowLabel: '4h'   } },
  weekly:  { key: 'weekly',  label: 'Weekly',  dirTf: 'W1',  triggerTf: 'H4', methodology: 'bss-w-2.0.0',
             condition: { periodStart: weekStart,  periodLabel: 'EAT week',  fast: 16, slow: 96,  fastLabel: '4h',  slowLabel: '24h'  } },
  monthly: { key: 'monthly', label: 'Monthly', dirTf: 'MN1', triggerTf: 'D1', methodology: 'bss-m-2.0.0',
             condition: { periodStart: monthStart, periodLabel: 'EAT month', fast: 96, slow: 480, fastLabel: '24h', slowLabel: '120h' } },
};

const STRATEGY_KEYS = ['daily', 'weekly', 'monthly'];

// Configurable condition assumptions (v2). All start permissive:
//   breadthMin   : how many of a currency's 7 legs must agree inside the fast window (default 5/7).
//   dirDeadband  : pp a window's net move must exceed to count as a direction (default 0).
//   effDeadband  : min |signed efficiency| in the fast window (default 0).
const DEFAULT_PARAMS = { breadthMin: 5, dirDeadband: 0, effDeadband: 0 };
const PARAM_RANGES = { breadthMin: [4, 7], dirDeadband: [0, 5], effDeadband: [0, 1] };

// ── v1 legacy threshold helpers (retained so strength.js + its tests keep working; the live
// v2 path no longer uses votes). ──────────────────────────────────────────────────────────
const MIN_THRESHOLD = 4, MAX_THRESHOLD = 7;
function validThreshold(t) {
  const n = Math.round(Number(t));
  if (!Number.isFinite(n)) return 5;
  return Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, n));
}

const clampInt = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const clampNum = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };

/** Validate/clamp the v2 condition params; bad input falls back to the defaults. */
function validParams(o = {}) {
  o = o || {};
  return {
    breadthMin: clampInt(o.breadthMin, PARAM_RANGES.breadthMin[0], PARAM_RANGES.breadthMin[1], DEFAULT_PARAMS.breadthMin),
    dirDeadband: clampNum(o.dirDeadband, PARAM_RANGES.dirDeadband[0], PARAM_RANGES.dirDeadband[1], DEFAULT_PARAMS.dirDeadband),
    effDeadband: clampNum(o.effDeadband, PARAM_RANGES.effDeadband[0], PARAM_RANGES.effDeadband[1], DEFAULT_PARAMS.effDeadband),
  };
}

const numTok = (x) => String(x).replace('.', 'p');   // 0.25 → "0p25" (filesystem/id-safe)
/** Compact, distinct settings version for a strategy + params (windows included for provenance). */
function versionFor(s, params) {
  const p = validParams(params);
  const c = s.condition || { fast: 0, slow: 0 };
  return `${s.methodology}-b${p.breadthMin}f${c.fast}s${c.slow}d${numTok(p.dirDeadband)}e${numTok(p.effDeadband)}`;
}

function strategyDef(key, paramOverrides) {
  const s = STRATEGIES[key];
  if (!s) throw new Error('unknown strategy: ' + key);
  const params = validParams(paramOverrides);
  return { ...s, params, methodologyVersion: s.methodology, version: versionFor(s, params) };
}

module.exports = {
  CURRENCIES, PAIRS, pairFor, legsFor,
  HOUR_MS, H4_MS, DAY_MS, EAT_OFFSET_MS,
  TF, STRATEGIES, STRATEGY_KEYS, DEFAULT_PARAMS, PARAM_RANGES,
  MIN_THRESHOLD, MAX_THRESHOLD, validThreshold,
  validParams, strategyDef, versionFor,
};
