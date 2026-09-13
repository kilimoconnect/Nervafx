'use strict';

/**
 * Phase 2 — baseline (m15-cfg-1.0.0) vs candidate (m15-cfg-1.1.0, space per-trade)
 * on IDENTICAL time-corrected inputs (same loader, same coordinator, same closes).
 * READ-ONLY. Reports per-denominator deltas, the decision-transition matrix,
 * new/removed setup episodes, room-in-R, and LABELLED outcome estimates, split
 * into a declared dev and eval period. No DB writes, no orders.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { CONFIG } = require('../../api/_m15/config');
const { CONFIG_1_1_0, CONFIG_1_1_0A } = require('../../api/_m15/config-1_1_0');
const CANDIDATES = [{ name: '1_1_0a', cfg: CONFIG_1_1_0A }, { name: '1_1_0', cfg: CONFIG_1_1_0 }];
const { PAIRS, split } = require('../../api/_m15/pairs');
const { toCandle, M15_MS } = require('../../api/_m15/data');
const { replayFrameOpen } = require('../../api/_m15/load');
const { runNetwork } = require('../../api/_m15/coordinator');
const { reduceEpisodes, isArmed } = require('../../api/_m15/diagnostics');

const FROM = '2026-07-01', TO = '2026-09-11', WARMUP = 260;
const DEV_END = Date.parse('2026-08-16T00:00:00Z');           // dev < DEV_END ≤ eval
const OUTDIR = path.join(__dirname, '..', '..', 'docs', 'phase2');
const fromMs = Date.parse(FROM + 'T00:00:00Z'), toMs = Date.parse(TO + 'T23:59:59Z');

function env() { const t = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8'); const e = {}; for (const l of t.split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)\s*=\s*(.*)$/); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); } return e; }
async function loadPair(sb, p, fi, ti) { const all = []; let o = 0; for (;;) { const { data, error } = await sb.from('backtest_candles').select('time,open,high,low,close,volume,complete').eq('instrument', p).eq('timeframe', 'M15').eq('complete', true).gte('time', fi).lte('time', ti).order('time', { ascending: true }).range(o, o + 999); if (error) throw new Error(error.message); all.push(...data); if (data.length < 1000) break; o += 1000; } return all.map(toCandle); }
function lastIdxLe(a, t) { let lo = 0, hi = a.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].openMs <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
function inc(o, k) { o[k] = (o[k] || 0) + 1; }
function sessionOf(ms) { const h = new Date(ms).getUTCHours(); if (h >= 0 && h < 7) return 'ASIA'; if (h >= 7 && h < 12) return 'LONDON'; if (h >= 12 && h < 17) return 'LONDON_NY'; if (h >= 17 && h < 21) return 'NY'; return 'LATE'; }

// compact outcome estimator (same assumptions as replay-cadence)
function estimate(setup, future, cfg) {
  if (!setup || !future.length) return { label: 'NO_DATA' };
  const dir = setup.direction === 'BULLISH' ? 1 : -1, trig = setup.triggerPrice, stop = setup.stopPrice, t1 = setup.target1, t2 = setup.target2;
  const risk = Math.abs(trig - stop) || 1e-9; let filled = false, mfe = 0, mae = 0; const expiry = cfg.trigger.expiryCandles;
  for (let i = 0; i < future.length; i++) { const c = future[i];
    if (!filled) { if (i > expiry) return { label: 'NO_FILL' }; const thru = dir > 0 ? c.high >= trig : c.low <= trig; if (thru) filled = true; else continue; }
    mfe = Math.max(mfe, dir > 0 ? (c.high - trig) / risk : (trig - c.low) / risk);
    mae = Math.max(mae, dir > 0 ? (trig - c.low) / risk : (c.high - trig) / risk);
    const hitStop = dir > 0 ? c.low <= stop : c.high >= stop, hitT2 = dir > 0 ? c.high >= t2 : c.low <= t2, hitT1 = dir > 0 ? c.high >= t1 : c.low <= t1;
    if (hitStop && (hitT2 || hitT1)) return { label: 'AMBIGUOUS', mfe: +mfe.toFixed(2), mae: +mae.toFixed(2) };
    if (hitT2) return { label: 'T2', r: 2, mfe: +mfe.toFixed(2) };
    if (hitStop) return { label: 'STOP', r: -1, mae: +mae.toFixed(2) };
  }
  return { label: filled ? 'OPEN' : 'NO_FILL', mfe: +mfe.toFixed(2) };
}

async function main() {
  const e = env(); const sb = createClient(e.SUPABASE_URL, e.SUPABASE_SERVICE_KEY);
  fs.mkdirSync(OUTDIR, { recursive: true });
  const pre = new Date(fromMs - (WARMUP + 40) * M15_MS * 3).toISOString();
  const byPair = {}; for (const p of PAIRS) byPair[p] = await loadPair(sb, p, pre, new Date(toMs).toISOString());
  console.error('loaded', Math.min(...PAIRS.map(p => byPair[p].length)), 'min/pair');

  const first = Math.ceil(fromMs / M15_MS) * M15_MS, last = Math.floor(toMs / M15_MS) * M15_MS;
  const period = (ms) => (ms < DEV_END ? 'dev' : 'eval');
  const decBase = {}, tlBase = [];
  const C = {}; for (const c of CANDIDATES) C[c.name] = { dec: {}, tl: [], transition: {}, changed: 0, changedByPeriod: { dev: 0, eval: 0 } };
  let evals = 0;

  for (let T = first; T <= last; T += M15_MS) {
    const fo = replayFrameOpen(T, false);
    const cbp = {}; let ok = true;
    for (const p of PAIRS) { const i = lastIdxLe(byPair[p], fo); if (i < WARMUP - 1) ok = false; cbp[p] = i < 0 ? [] : byPair[p].slice(Math.max(0, i - WARMUP + 1), i + 1); }
    if (!ok) continue;
    const rb = runNetwork(cbp, { evalMs: fo, cfg: CONFIG });
    const fb = { ms: fo, pairs: {} };
    const runs = {}; for (const c of CANDIDATES) runs[c.name] = runNetwork(cbp, { evalMs: fo, cfg: c.cfg });
    const frames = {}; for (const c of CANDIDATES) frames[c.name] = { ms: fo, pairs: {} };
    for (const p of PAIRS) {
      const db = rb.pairs[p].decision; evals++; inc(decBase, db);
      fb.pairs[p] = { decision: db, direction: rb.pairs[p].snapshot.direction, strategy: rb.pairs[p].strategy };
      for (const c of CANDIDATES) {
        const dc = runs[c.name].pairs[p].decision; inc(C[c.name].dec, dc);
        frames[c.name].pairs[p] = { decision: dc, direction: runs[c.name].pairs[p].snapshot.direction, strategy: runs[c.name].pairs[p].strategy };
        if (db !== dc) { C[c.name].changed++; inc(C[c.name].transition, `${db}→${dc}`); C[c.name].changedByPeriod[period(fo)]++; }
      }
    }
    tlBase.push(fb); for (const c of CANDIDATES) C[c.name].tl.push(frames[c.name]);
  }

  const epB = reduceEpisodes(tlBase);
  const keyOf = (e) => `${e.pair}|${e.direction}|${e.firstMs}`;
  const setB = new Set(epB.map(keyOf));
  const clusterOf = (p) => { const { base, quote } = split(p); return [base, quote].sort().join(''); };
  const enrich = (eps, cfg) => eps.map((ep) => {
    const arr = byPair[ep.pair]; const si = lastIdxLe(arr, ep.firstMs);
    const cbp = {}; for (const p of PAIRS) { const i = lastIdxLe(byPair[p], ep.firstMs); cbp[p] = i < 0 ? [] : byPair[p].slice(Math.max(0, i - WARMUP + 1), i + 1); }
    const run = runNetwork(cbp, { evalMs: ep.firstMs, cfg });
    const setup = run.pairs[ep.pair] && run.pairs[ep.pair].setup;
    const future = arr.slice(si + 1, si + 1 + 200);
    return { pair: ep.pair, direction: ep.direction, strategy: ep.strategy, firstIso: ep.firstIso, ageCandles: ep.ageCandles, endReason: ep.endReason,
      session: sessionOf(ep.firstMs), cluster: clusterOf(ep.pair), period: period(ep.firstMs),
      hasSetup: !!setup, stopPips: setup ? setup.stopPips : null, availableSpaceVol: setup ? setup.availableSpaceVol : null,
      outcome: setup ? estimate(setup, future, cfg) : { label: 'NO_SETUP' } };
  });
  const outcomeTally = (eps) => { const t = {}; for (const x of eps) inc(t, x.outcome.label); return t; };
  const byField = (eps, f) => { const t = {}; for (const x of eps) inc(t, x[f]); return t; };

  const candidatesOut = {};
  for (const c of CANDIDATES) {
    const st = C[c.name]; const epC = reduceEpisodes(st.tl); const setC = new Set(epC.map(keyOf));
    const added = epC.filter((e) => !setB.has(keyOf(e)));
    const removed = epB.filter((e) => !setC.has(keyOf(e)));
    const addedEnr = enrich(added, c.cfg);
    candidatesOut[c.name] = {
      version: c.cfg.version,
      decisions: sort(st.dec), episodes: epC.length, armedFrames: countArmed(st.tl),
      changedPairFrames: st.changed, changedPct: +(100 * st.changed / evals).toFixed(3), changedByPeriod: st.changedByPeriod,
      transitionMatrix: sort(st.transition),
      episodesAdded: added.length, episodesRemoved: removed.length,
      addedEpisodes: { byStrategy: byField(addedEnr, 'strategy'), bySession: byField(addedEnr, 'session'), byPeriod: byField(addedEnr, 'period'), outcomes: outcomeTally(addedEnr), list: addedEnr },
      removedEpisodes: removed.map((e) => ({ pair: e.pair, direction: e.direction, strategy: e.strategy, firstIso: e.firstIso, endReason: e.endReason })),
    };
    console.error(`\n=== BASELINE vs ${c.cfg.version} ===`);
    console.error(`changed pair-frames ${st.changed} (${candidatesOut[c.name].changedPct}%)  dev ${st.changedByPeriod.dev} / eval ${st.changedByPeriod.eval}`);
    console.error(`episodes: baseline ${epB.length} → candidate ${epC.length}  (added ${added.length}, removed ${removed.length})`);
    console.error('top transitions:', JSON.stringify(Object.fromEntries(Object.entries(sort(st.transition)).slice(0, 6))));
    console.error('added-episode outcomes (LABELLED):', JSON.stringify(outcomeTally(addedEnr)));
  }

  const summary = {
    window: { from: FROM, to: TO, warmup: WARMUP, closes: tlBase.length, evaluations: evals },
    devEvalSplit: { devBefore: '2026-08-16', note: 'Previously-inspected history — NOT an untouched holdout. Prospective shadow test required before trusting outcomes (Bailey et al.).' },
    baseline: { version: CONFIG.version, hash: 'be69b3c4af041e9d', decisions: sort(decBase), episodes: epB.length, armedFrames: countArmed(tlBase) },
    candidates: candidatesOut,
  };
  fs.writeFileSync(path.join(OUTDIR, 'compare_baseline_vs_candidates.json'), JSON.stringify(summary, null, 2));
  console.error('\nwrote', path.join(OUTDIR, 'compare_baseline_vs_candidates.json'));
}
function countArmed(tlx) { let n = 0; for (const f of tlx) for (const p of Object.keys(f.pairs)) if (isArmed(f.pairs[p].decision)) n++; return n; }
function sort(o) { const r = {}; for (const k of Object.keys(o).sort((a, b) => o[b] - o[a])) r[k] = o[k]; return r; }
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
