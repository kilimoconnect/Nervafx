'use strict';

/**
 * M15 Strategy Research — pre-registered candidate families (Stage 3).
 *
 * Ablation ladder from a simple baseline, ONE change at a time (A0→A1→A2→A3), plus
 * families B–F. C–F REUSE the frozen production adaptive semantics (marketState,
 * expansion, freshness, compression, pressure) read-only via `ctx.prod` — no
 * production logic is changed. EMA / wick / acceleration / time-of-day / extension
 * are deliberately NOT stacked here; each is a SEPARATE future hypothesis.
 *
 * decide(ctx) → { arm, direction:'LONG'|'SHORT'|null, trigger, invalidate, reasons }
 *   ctx = { pair, feat (Stage-2 pair features), net (currency network for N=10),
 *           prod (frozen production per-pair engines, read-only), params }
 * The generic runner owns episode dedup / expiry / invalidation.
 */

const crypto = require('crypto');
const { defineCandidate, makeRegistry } = require('./registry');

const H = (feat, N) => (feat && feat.horizons ? feat.horizons[N] : null);
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const COSTS = 'Deferred to Stage 4: candle store is MID-only (no spread). No cost applied at signal time; spread/slippage/human-delay modelled later from an external source.';

// ── A0 — baseline: simple 10-candle direction (control-grade) ────────────────
const A0 = defineCandidate({
  id: 'A0_baseline_dir10', family: 'A_baseline', direction: 'WITH',
  hypothesis: 'Direction of the last 10 M15 candles (sign of R10) predicts the next move — a naive baseline.',
  entry: 'At the close, take R10 direction.', exit: 'Fixed 2R target.', invalidation: 'Fixed stop.', timeout: '8 M15 closes.',
  eligibility: 'Complete, aligned 28-pair snapshot; pair present.',
  costAssumptions: COSTS,
  params: { deadbandZ: 0.0 }, paramBounds: { deadbandZ: [0, 1.0] },
  variants: [{ deadbandZ: 0.0 }, { deadbandZ: 0.5 }],
  readsFeatures: ['horizons[10].R', 'horizons[10].z'],
  decide(ctx) {
    const h = H(ctx.feat, 10); if (!h) return no();
    const dir = sgn(h.R); if (dir === 0) return no();
    const pass = h.z == null ? true : Math.abs(h.z) >= (ctx.params.deadbandZ || 0);
    return { arm: pass, direction: dir > 0 ? 'LONG' : 'SHORT', trigger: pass, invalidate: false, reasons: ['R10 sign', pass ? 'z ok' : 'z below deadband'] };
  },
});

// ── A1 — + movement consistency (|P10|) ──────────────────────────────────────
const A1 = defineCandidate({
  id: 'A1_dir10_plus_consistency', family: 'A_baseline', direction: 'WITH',
  hypothesis: 'Baseline direction is more reliable when the 10-candle path is directionally consistent (|P10| high).',
  entry: 'R10 direction, only if |P10| ≥ consistMin.', exit: '2R.', invalidation: 'stop.', timeout: '8 closes.',
  eligibility: 'as A0', costAssumptions: COSTS,
  params: { deadbandZ: 0.5, consistMin: 50 }, paramBounds: { consistMin: [30, 80] },
  variants: [{ consistMin: 40 }, { consistMin: 60 }],
  readsFeatures: ['horizons[10].R', 'horizons[10].P', 'horizons[10].z'],
  decide(ctx) {
    const h = H(ctx.feat, 10); if (!h) return no();
    const dir = sgn(h.R); if (dir === 0) return no();
    const pass = Math.abs(h.P) >= (ctx.params.consistMin ?? 50) && (h.z == null || Math.abs(h.z) >= (ctx.params.deadbandZ || 0));
    return sig(pass, dir, ['|P10|≥consistMin=' + (pass)]);
  },
});

// ── A2 — + currency breadth agreement ────────────────────────────────────────
const A2 = defineCandidate({
  id: 'A2_plus_breadth', family: 'A_baseline', direction: 'WITH',
  hypothesis: 'Consistent baseline direction supported by broad currency-network breadth (base vs quote) is stronger evidence.',
  entry: 'as A1, AND (breadth[base].net − breadth[quote].net) supports the direction by ≥ breadthMin.', exit: '2R.', invalidation: 'stop.', timeout: '8 closes.',
  eligibility: 'as A1', costAssumptions: COSTS,
  params: { deadbandZ: 0.5, consistMin: 50, breadthMin: 1 }, paramBounds: { breadthMin: [1, 4] },
  variants: [{ breadthMin: 1 }, { breadthMin: 2 }],
  readsFeatures: ['horizons[10].R', 'horizons[10].P', 'net.breadth[base|quote].net', 'net.gap'],
  decide(ctx) {
    const h = H(ctx.feat, 10); if (!h || !ctx.net) return no();
    const dir = sgn(h.R); if (dir === 0) return no();
    const [base, quote] = ctx.pair.split('_');
    const spread = (ctx.net.breadth[base]?.net || 0) - (ctx.net.breadth[quote]?.net || 0);
    const consist = Math.abs(h.P) >= (ctx.params.consistMin ?? 50);
    const breadthOk = dir > 0 ? spread >= (ctx.params.breadthMin ?? 1) : spread <= -(ctx.params.breadthMin ?? 1);
    return sig(consist && breadthOk, dir, ['consist=' + consist, 'breadth=' + breadthOk]);
  },
});

// ── A3 — + structure/energy alignment (frozen production descriptors) ─────────
const A3 = defineCandidate({
  id: 'A3_plus_structure_energy', family: 'A_baseline', direction: 'WITH',
  hypothesis: 'Add production energy-direction alignment and exclude chaotic/dead energy.',
  entry: 'as A2, AND prod energyDirection matches and is not CHAOTIC/DEAD.', exit: '2R.', invalidation: 'energy flips or dies.', timeout: '8 closes.',
  eligibility: 'as A2', costAssumptions: COSTS,
  params: { deadbandZ: 0.5, consistMin: 50, breadthMin: 1 }, paramBounds: {},
  variants: [{}],
  readsFeatures: ['horizons[10].*', 'net.breadth', 'prod.energy.energyDirection', 'prod.energy.energyLevel'],
  decide(ctx) {
    const a2 = A2.decide(ctx); if (!a2.arm) return a2;
    const en = ctx.prod && ctx.prod.energy; if (!en) return no();
    const want = a2.direction === 'LONG' ? 'BULLISH' : 'BEARISH';
    const ok = en.energyDirection === want && en.energyLevel !== 'DEAD';
    const invalidate = en.energyDirection && en.energyDirection !== want && en.energyDirection !== 'BALANCED';
    return { arm: ok, direction: a2.direction, trigger: ok, invalidate, reasons: ['A2 pass', 'energy=' + en.energyDirection] };
  },
});

// ── B — recent 4-candle continuation after a meaningful 10-candle move ────────
const B = defineCandidate({
  id: 'B_continuation_4after10', family: 'B_continuation', direction: 'WITH',
  hypothesis: 'After a meaningful 10-candle move, a fresh consistent 4-candle push in the same direction continues.',
  entry: '|z10| ≥ meaningfulZ AND sign(R4)=sign(R10) AND |P4| ≥ pressMin.', exit: '2R.', invalidation: 'R4 flips against R10.', timeout: '6 closes.',
  eligibility: 'complete snapshot; ≥10 candles', costAssumptions: COSTS,
  params: { meaningfulZ: 1.0, pressMin: 60 }, paramBounds: { meaningfulZ: [0.5, 2], pressMin: [40, 80] },
  variants: [{ pressMin: 50 }, { pressMin: 70 }],
  readsFeatures: ['horizons[10].z', 'horizons[10].R', 'horizons[4].R', 'horizons[4].P'],
  decide(ctx) {
    const h10 = H(ctx.feat, 10), h4 = H(ctx.feat, 4); if (!h10 || !h4) return no();
    const dir = sgn(h10.R); if (dir === 0) return no();
    const meaningful = h10.z == null ? false : Math.abs(h10.z) >= (ctx.params.meaningfulZ ?? 1);
    const push = sgn(h4.R) === dir && Math.abs(h4.P) >= (ctx.params.pressMin ?? 60);
    const invalidate = sgn(h4.R) === -dir;
    return { arm: meaningful && push, direction: dir > 0 ? 'LONG' : 'SHORT', trigger: meaningful && push, invalidate, reasons: ['meaningful=' + meaningful, 'push=' + push] };
  },
});

// ── C–F — reuse frozen production adaptive families (read-only via ctx.prod) ──
function prodDir(ms) { return /BULLISH/.test(ms) ? 'LONG' : /BEARISH/.test(ms) ? 'SHORT' : null; }

const C = defineCandidate({
  id: 'C_early_expansion', family: 'C_early_expansion', direction: 'WITH',
  hypothesis: 'Early adaptive expansion out of accepted balance (production EARLY/ATTEMPTING, not late/overextended) resumes.',
  entry: 'marketState *_EXPANSION AND expansion∈{EARLY,ATTEMPTING} AND freshness∉{LATE,EXHAUSTED}.', exit: '2R.', invalidation: 'freshness LATE or expansion OVEREXTENDED/DEVELOPED.', timeout: '8 closes.',
  eligibility: 'production per-pair engines available', costAssumptions: COSTS,
  params: {}, paramBounds: {}, variants: [{}],
  readsFeatures: ['prod.marketState.state', 'prod.expansion.state', 'prod.freshness.state'],
  decide(ctx) {
    const p = ctx.prod; if (!p || !p.marketState) return no();
    const ms = p.marketState.state; const dir = prodDir(ms);
    const arm = /_(EXPANSION)$/.test(ms) && p.expansion && ['EARLY', 'ATTEMPTING', 'CONFIRMED'].includes(p.expansion.state) && p.freshness && !['LATE', 'EXHAUSTED'].includes(p.freshness.state) && dir;
    const invalidate = p.freshness && ['LATE', 'EXHAUSTED'].includes(p.freshness.state) || (p.expansion && ['OVEREXTENDED', 'DEVELOPED'].includes(p.expansion.state));
    return { arm: !!arm, direction: dir, trigger: !!arm, invalidate: !!invalidate, reasons: ['ms=' + ms, 'exp=' + (p.expansion && p.expansion.state)] };
  },
});

const D = defineCandidate({
  id: 'D_first_pullback', family: 'D_first_pullback', direction: 'WITH',
  hypothesis: 'A first controlled pullback within a fresh impulse resumes in the impulse direction.',
  entry: 'marketState *_PULLBACK AND pullback.isPullback AND not late.', exit: '2R.', invalidation: 'not late lost / structure invalidated.', timeout: '8 closes.',
  eligibility: 'production engines', costAssumptions: COSTS,
  params: {}, paramBounds: {}, variants: [{}],
  readsFeatures: ['prod.marketState.state', 'prod.marketState.pullback.isPullback', 'prod.freshness.state'],
  decide(ctx) {
    const p = ctx.prod; if (!p || !p.marketState) return no();
    const ms = p.marketState.state; const dir = prodDir(ms);
    const isPb = p.marketState.pullback && p.marketState.pullback.isPullback;
    const notLate = p.freshness && !['LATE', 'EXHAUSTED'].includes(p.freshness.state);
    const arm = /_(PULLBACK)$/.test(ms) && isPb && notLate && dir;
    return { arm: !!arm, direction: dir, trigger: !!arm, invalidate: p.freshness && ['LATE', 'EXHAUSTED'].includes(p.freshness.state), reasons: ['ms=' + ms, 'pb=' + !!isPb] };
  },
});

const E = defineCandidate({
  id: 'E_compression_release', family: 'E_compression_release', direction: 'WITH',
  hypothesis: 'A valid compression that begins releasing with building directional pressure expands in the pressure direction.',
  entry: 'marketState COMPRESSION AND compression∈{ACTIVE,TIGHT,RELEASING} AND pressure building/dominant.', exit: '2R.', invalidation: 'pressure balances or compression fails.', timeout: '8 closes.',
  eligibility: 'production engines', costAssumptions: COSTS,
  params: {}, paramBounds: {}, variants: [{}],
  readsFeatures: ['prod.marketState.state', 'prod.compression.state', 'prod.pressure.pressureState'],
  decide(ctx) {
    const p = ctx.prod; if (!p || !p.marketState) return no();
    const ms = p.marketState.state, ps = p.pressure && p.pressure.pressureState;
    const dir = ps && /BULLISH/.test(ps) ? 'LONG' : ps && /BEARISH/.test(ps) ? 'SHORT' : null;
    const arm = ms === 'COMPRESSION' && p.compression && ['ACTIVE', 'TIGHT', 'RELEASING'].includes(p.compression.state) && ps && /(BUILDING|DOMINANT|FORMING)/.test(ps) && dir;
    return { arm: !!arm, direction: dir, trigger: !!(arm && p.compression && p.compression.state === 'RELEASING'), invalidate: ps === 'BALANCED', reasons: ['comp=' + (p.compression && p.compression.state), 'press=' + ps] };
  },
});

const F = defineCandidate({
  id: 'F_failed_extension', family: 'F_failed_extension', direction: 'AGAINST',
  hypothesis: 'A failed extension (production FAILED_*_EXPANSION) rotates in the OPPOSING direction.',
  entry: 'marketState FAILED_BULLISH_EXPANSION ⇒ SHORT (and mirror), while not already overextended against.', exit: '2R.', invalidation: 'the failed state resolves back with-trend.', timeout: '8 closes.',
  eligibility: 'production engines', costAssumptions: COSTS,
  params: {}, paramBounds: {}, variants: [{}],
  readsFeatures: ['prod.marketState.state'],
  decide(ctx) {
    const p = ctx.prod; if (!p || !p.marketState) return no();
    const ms = p.marketState.state;
    const dir = ms === 'FAILED_BULLISH_EXPANSION' ? 'SHORT' : ms === 'FAILED_BEARISH_EXPANSION' ? 'LONG' : null;
    return { arm: !!dir, direction: dir, trigger: !!dir, invalidate: false, reasons: ['ms=' + ms] };
  },
});

// ── Control (null benchmark) and No-signal ───────────────────────────────────
const CONTROL = defineCandidate({
  id: 'CTRL_pseudo_random', family: 'control', direction: 'NEUTRAL',
  hypothesis: 'Deterministic pseudo-random direction — a NULL benchmark to bound spurious performance.',
  entry: 'hash(pair, close) → LONG/SHORT/NONE (~1/3 each).', exit: '2R.', invalidation: 'none.', timeout: '8 closes.',
  eligibility: 'complete snapshot', costAssumptions: COSTS,
  params: { seed: 'stage3' }, paramBounds: {}, variants: [{}],
  readsFeatures: ['none (uses close timestamp only)'],
  decide(ctx) {
    const hsh = parseInt(crypto.createHash('sha256').update(`${ctx.pair}|${ctx.closeMs}|stage3`).digest('hex').slice(0, 8), 16) % 3;
    const dir = hsh === 0 ? 'LONG' : hsh === 1 ? 'SHORT' : null;
    return { arm: !!dir, direction: dir, trigger: !!dir, invalidate: false, reasons: ['pseudo-random'] };
  },
});

const NOSIGNAL = defineCandidate({
  id: 'NULL_no_signal', family: 'control', direction: 'NEUTRAL',
  hypothesis: 'Never signal — the do-nothing option; the lower bound on activity.',
  entry: 'never.', exit: 'n/a', invalidation: 'n/a', timeout: 'n/a', eligibility: 'n/a', costAssumptions: 'none',
  params: {}, paramBounds: {}, variants: [{}], readsFeatures: [],
  decide() { return no(); },
});

function no() { return { arm: false, direction: null, trigger: false, invalidate: false, reasons: [] }; }
function sig(pass, dir, reasons) { return { arm: !!pass, direction: dir > 0 ? 'LONG' : 'SHORT', trigger: !!pass, invalidate: false, reasons }; }

const REGISTRY = makeRegistry([A0, A1, A2, A3, B, C, D, E, F, CONTROL, NOSIGNAL]);

module.exports = { REGISTRY, A0, A1, A2, A3, B, C, D, E, F, CONTROL, NOSIGNAL };
