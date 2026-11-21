'use strict';

/**
 * NervaFX Inverted Flow — observation stream builders (pure).
 *
 * Each builder returns an ASCENDING array of observations [{ value, ms, ... }] for the block engine:
 *   closeObs       — one observation per completed candle close (honest for all NervaFX history/live,
 *                    which is completed midpoint candles only; NO intrabar path is fabricated).
 *   indexObs       — one observation per synchronized zero-sum basket snapshot, rebased to the daily
 *                    baseline as % points (reconciles with the Evolution engine).
 *   simulatedEURUSD— the deterministic A–D quote path from the reference example (labelled simulation;
 *                    the only place "quote updates" are real, because no broker quote feed is stored).
 */

const { idxAtOrBefore } = require('../comparison/index-build');

/** Completed-candle closes → observations. `resMs` is the candle interval; completion = openMs+resMs. */
function closeObs(candles, resMs, resolution) {
  const out = [];
  for (const c of (candles || [])) {
    const openMs = c.openMs != null ? c.openMs : Date.parse(c.time);
    if (!isFinite(openMs) || !isFinite(+c.close)) continue;
    out.push({ value: +c.close, ms: openMs + (resMs || 0), resolution: resolution || null, openMs });
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}

/**
 * Zero-sum index → observations rebased to the daily baseline, in % points (pp).
 *   built      result of buildIndices(byPairM15, {baseMs:M15_MS})
 *   ccy        currency
 *   baselineMs 00:00 EAT day start (dayStart). The baseline value is the index at/just before it.
 *   cutoffMs   include snapshots with ms in (baselineMs, cutoffMs]; default built.lastMs.
 * Each observation value = 100·(index/baseline − 1) pp; one per synchronized basket snapshot. The
 * reset at a new baseline starts a NEW series (callers pass one day's window), so a daily reset never
 * produces a reversal or a jump from the prior day.
 */
function indexObs(built, ccy, baselineMs, cutoffMs) {
  if (!built || !built.ok) return { ok: false, reason: (built && built.reason) || 'no index' };
  const base = idxAtOrBefore(built, ccy, baselineMs);
  if (!base || !(base.value > 0)) return { ok: false, reason: 'no baseline value at daily open' };
  const cutoff = cutoffMs == null ? built.lastMs : cutoffMs;
  const tl = built.timeline, series = built.index[ccy];
  const out = [];
  for (let i = 0; i < tl.length; i++) {
    const t = tl[i];
    if (t < baselineMs || t > cutoff) continue;
    const v = series[i];
    out.push({ value: 100 * (v / base.value - 1), ms: t, raw: v, constituentCount: 28 });
  }
  return { ok: true, observations: out, baselineValue: base.value, baselineMs };
}

/**
 * The reference A–D EUR/USD quote sequence (SIMULATED — labelled, never broker history).
 * anchor 1.0830, 5-pip step (0.00050). Produces exactly:
 *   A  green  1.0830 → 1.0835, width 20
 *   B  green  1.0835 → 1.0840, width 80 (4× A), with visible retreats
 *   C  red    reversal 1.0835 → 1.0830, width 55; trace peaks at 1.0843 then falls to 1.0830 on the 55th
 *   D  forming 1.0830 → 1.0827, width 20 (a move to 1.0825 would confirm the next down continuation)
 * Each observation carries a bid/ask around the midpoint; one pair of consecutive updates in B shares
 * an identical midpoint with a shifted bid/ask (feed activity with a level trace).
 */
function simulatedEURUSD() {
  const r5 = (x) => Math.round(x * 1e5) / 1e5;         // round to 5 dp (fractional-pip precision)
  const obs = [];
  let ms = Date.UTC(2025, 4, 1, 8, 0, 0);              // arbitrary start; width ≠ time
  const push = (mid, dtSec) => {
    const m = r5(mid);
    obs.push({ value: m, ms, bid: r5(m - 0.00004), ask: r5(m + 0.00004), eventId: 'sim' + obs.length });
    ms += (dtSec || 2) * 1000;
  };

  // anchor seed (not counted as activity)
  push(1.0830, 0);

  // A — 20 updates rising 1.0830 → 1.0835 (stay inside (1.0830,1.0835) until the 20th).
  for (let i = 1; i <= 19; i++) { const base = 1.0830 + (i / 20) * 0.0005; const wig = (i % 2 ? 1 : -1) * 0.00002; push(Math.min(1.08348, Math.max(1.08306, base + wig)), 3); }
  push(1.0835, 3);                                     // 20th → confirms A (up)

  // B — 80 updates oscillating 1.0836–1.0839, ending 1.0840 (several retreats).
  for (let i = 1; i <= 79; i++) {
    let mid;
    if (i === 40) { obs.push({ value: 1.0838, ms, bid: r5(1.0838 - 0.00006), ask: r5(1.0838 + 0.00006), eventId: 'sim' + obs.length }); ms += 2000; continue; } // same-midpoint feed tick (shifted bid/ask) at i=41
    if (i === 41) { mid = 1.0838; }                   // identical midpoint to i=40 → activity+1, flat trace
    else if (i % 7 === 0) mid = 1.08362;              // deeper retreat
    else mid = (i % 2 ? 1.08392 : 1.08368);           // normal oscillation
    push(mid, 2);
  }
  push(1.0840, 2);                                    // 80th → confirms B (up continuation)

  // C — 55 updates: peak 1.0843, fall to 1.0836, bounce, then 1.0830 on the 55th → red reversal.
  const cPath = [];
  cPath.push(1.08415, 1.0842, 1.08425, 1.0843);       // rise to the peak (obs 1–4)
  for (let i = 5; i <= 14; i++) cPath.push(r5(1.0843 - (i - 4) * 0.00007));   // decline toward ~1.08365
  for (let i = 15; i <= 24; i++) cPath.push(r5(1.08365 + (i - 14) * 0.00005)); // bounce toward ~1.0841
  for (let i = 25; i <= 54; i++) cPath.push(r5(1.0841 - (i - 24) * 0.000036)); // gentle decline toward ~1.08301 (never ≤1.0830 before the 55th)
  for (let k = 0; k < cPath.length; k++) { const v = Math.min(1.08448, Math.max(1.08302, cPath[k])); push(v, 5); }
  push(1.0830, 5);                                    // 55th → confirms C (down reversal 1.0835→1.0830)

  // D — 20 updates declining 1.0830 → 1.0827 (forming; 1.0825 would confirm the next down continuation).
  for (let i = 1; i <= 19; i++) { const base = 1.0830 - (i / 20) * 0.0003; const wig = (i % 2 ? 1 : -1) * 0.00002; push(Math.min(1.08315, Math.max(1.08262, base + wig)), 4); }
  push(1.0827, 4);                                    // 20th (still forming)

  return {
    anchor: 1.0830, step: 0.0005, precision: 5, pip: 0.0001, stepPips: 5,
    label: 'Simulated example', instrument: 'EUR/USD',
    observations: obs,
    segments: [
      { name: 'A', kind: 'up', activity: 20, open: 1.0830, close: 1.0835 },
      { name: 'B', kind: 'up', activity: 80, open: 1.0835, close: 1.0840 },
      { name: 'C', kind: 'reversal', activity: 55, open: 1.0835, close: 1.0830, peak: 1.0843 },
      { name: 'D', kind: 'forming', activity: 20, open: 1.0830, latest: 1.0827, confirmsAt: 1.0825 },
    ],
  };
}

module.exports = { closeObs, indexObs, simulatedEURUSD };
