'use strict';

/**
 * M15 Intelligence — Phase 1 offline full-cadence replay + gate waterfall.
 *
 * READ-ONLY. Loads every 28-pair M15 candle for [from−warmup, to] once, then
 * replays the UNCHANGED deterministic engine at EVERY completed M15 close in
 * [from, to] (stride configurable), with correct no-lookahead framing. Emits:
 *   - baseline_manifest.json      (frozen baseline: revision, config, convention)
 *   - cadence_summary.json        (distributions, denominators, correct vs legacy)
 *   - gate_waterfall.json         (independent gate FAILs + overlap matrix)
 *   - episodes.json               (deduplicated setup episodes + lifecycle)
 *   - outcomes.json               (LABELLED, post-hoc estimates — assumptions stated)
 *   - snapshot_<iso>.json         (one close, all 28 pairs, full per-pair waterfall)
 *
 * Never writes to the database, never places or manages any order. Not runnable
 * inside a Vercel request (it scans months of history in memory).
 *
 * Usage:
 *   NODE_PATH=<dir-with-@supabase> node scripts/m15/replay-cadence.js \
 *     --from 2026-07-01 --to 2026-09-11 --stride 1 --warmup 260 --snapshot 2026-09-10T12:00:00Z
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const { CONFIG, CONFIG_VERSION, configHash } = require('../../api/_m15/config');
const { PAIRS } = require('../../api/_m15/pairs');
const { toCandle, M15_MS } = require('../../api/_m15/data');
const { replayFrameOpen } = require('../../api/_m15/load');
const { runNetwork } = require('../../api/_m15/coordinator');
const { gateWaterfall, reduceEpisodes, isArmed } = require('../../api/_m15/diagnostics');

// ── args ─────────────────────────────────────────────────────────────────────
function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def; }
const FROM = arg('from', '2026-07-01');
const TO = arg('to', '2026-09-11');
const STRIDE = parseInt(arg('stride', '1'), 10);
const WARMUP = parseInt(arg('warmup', '260'), 10);
const SNAPSHOT = arg('snapshot', '2026-09-10T12:00:00Z');
const OUTDIR = path.join(__dirname, '..', '..', 'docs', 'phase1');

const fromMs = Date.parse(FROM + 'T00:00:00Z');
const toMs = Date.parse((TO.length === 10 ? TO + 'T23:59:59Z' : TO));
const warmupMs = fromMs - (WARMUP + 8) * 96 * M15_MS / 96 * 1; // generous pre-roll (days)

// ── env (read-only; secrets never printed) ──────────────────────────────────
function loadEnv() {
  const txt = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); }
  return env;
}

async function loadPair(sb, pair, fromIso, toIso) {
  const all = []; let offset = 0; const page = 1000;
  for (;;) {
    const { data, error } = await sb.from('backtest_candles')
      .select('time,open,high,low,close,volume,complete')
      .eq('instrument', pair).eq('timeframe', 'M15').eq('complete', true)
      .gte('time', fromIso).lte('time', toIso)
      .order('time', { ascending: true }).range(offset, offset + page - 1);
    if (error) throw new Error(`${pair}: ${error.message}`);
    all.push(...data);
    if (data.length < page) break;
    offset += page;
  }
  return all.map(toCandle);
}

// binary search: index of last candle with openMs <= t
function lastIdxLe(arr, t) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].openMs <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

function inc(map, key) { map[key] = (map[key] || 0) + 1; }

// ── outcome estimate (post-hoc, LABELLED) ────────────────────────────────────
// Assumptions (stated in outcomes.json): mid prices (no bid/ask); manual-delay =
// fill only from the candle AFTER the arm; a candle touching BOTH stop and target
// is AMBIGUOUS (M15 cannot order intrabar); no partials; 2R target; expiry from
// config. This is outcome measurement, NOT execution.
function estimateOutcome(setup, future, cfg) {
  if (!setup || !future.length) return { label: 'NO_DATA' };
  const dir = setup.direction === 'BULLISH' ? 1 : -1;
  const trig = setup.triggerPrice, stop = setup.stopPrice;
  const t1 = setup.target1, t2 = setup.target2;
  const risk = Math.abs(trig - stop) || 1e-9;
  let filled = false, mfe = 0, mae = 0;
  const expiry = cfg.trigger.expiryCandles;
  for (let i = 0; i < future.length; i++) {
    const c = future[i];
    if (!filled) {
      if (i > expiry) return { label: 'NO_FILL', reason: 'expired_unfilled', barsWaited: i };
      const through = dir > 0 ? c.high >= trig : c.low <= trig;
      if (through) filled = true; else continue;
    }
    // once filled, track excursions in R and resolve
    const fav = dir > 0 ? (c.high - trig) / risk : (trig - c.low) / risk;
    const adv = dir > 0 ? (trig - c.low) / risk : (c.high - trig) / risk;
    mfe = Math.max(mfe, fav); mae = Math.max(mae, adv);
    const hitStop = dir > 0 ? c.low <= stop : c.high >= stop;
    const hitT2 = dir > 0 ? c.high >= t2 : c.low <= t2;
    const hitT1 = dir > 0 ? c.high >= t1 : c.low <= t1;
    if (hitStop && hitT2) return { label: 'AMBIGUOUS', note: 'stop+2R in same M15 candle', mfe: +mfe.toFixed(2), mae: +mae.toFixed(2) };
    if (hitT2) return { label: 'T2', rMultiple: 2, mfe: +mfe.toFixed(2), mae: +mae.toFixed(2) };
    if (hitStop && hitT1) return { label: 'AMBIGUOUS', note: 'stop+1R same candle', mfe: +mfe.toFixed(2), mae: +mae.toFixed(2) };
    if (hitStop) return { label: 'STOP', rMultiple: -1, mfe: +mfe.toFixed(2), mae: +mae.toFixed(2) };
  }
  return { label: filled ? 'OPEN_AT_WINDOW_END' : 'NO_FILL', mfe: +mfe.toFixed(2), mae: +mae.toFixed(2) };
}

async function main() {
  const env = loadEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) { console.error('No DB creds in .env — cannot run live replay.'); process.exit(2); }
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  fs.mkdirSync(OUTDIR, { recursive: true });

  const preRollIso = new Date(fromMs - (WARMUP + 40) * M15_MS * 3).toISOString(); // ~3× warmup pre-roll
  const toIso = new Date(toMs).toISOString();
  console.error(`Loading 28 pairs ${preRollIso} → ${toIso} …`);
  const byPair = {};
  for (const p of PAIRS) { byPair[p] = await loadPair(sb, p, preRollIso, toIso); }
  const counts = PAIRS.map((p) => byPair[p].length);
  console.error(`Loaded. candles/pair min ${Math.min(...counts)} max ${Math.max(...counts)}`);

  // eligible closes: every M15 boundary in [from,to]
  const firstClose = Math.ceil(fromMs / M15_MS) * M15_MS;
  const lastClose = Math.floor(toMs / M15_MS) * M15_MS;

  const modes = ['correct', 'legacy'];
  const agg = {};
  for (const m of modes) agg[m] = { evals: 0, closes: 0, decision: {}, state: {}, agreement: {}, gateFail: {}, primary: {}, armedFrames: 0, missingExcluded: 0 };
  const overlap = {}; // "A|B" -> count (correct mode, evaluation denominator)
  const timelineCorrect = [];
  const timelineLegacy = [];
  let firstEligibleIso = null, evaluatedCloses = 0;
  const snapMs = SNAPSHOT ? Date.parse(SNAPSHOT) : null;
  let snapshotOut = null;

  for (let T = firstClose, k = 0; T <= lastClose; T += M15_MS, k++) {
    if (k % STRIDE !== 0) continue;
    for (const mode of modes) {
      const frameOpen = replayFrameOpen(T, mode === 'legacy');
      // warm-up check: all pairs need >= WARMUP candles up to frameOpen
      const cbp = {}; let ok = true; let excluded = 0;
      for (const p of PAIRS) {
        const idx = lastIdxLe(byPair[p], frameOpen);
        if (idx < WARMUP - 1) { ok = false; excluded++; }
        cbp[p] = idx < 0 ? [] : byPair[p].slice(Math.max(0, idx - WARMUP + 1), idx + 1);
      }
      if (!ok) { agg[mode].missingExcluded += excluded; continue; }
      if (mode === 'correct' && !firstEligibleIso) firstEligibleIso = new Date(frameOpen).toISOString();

      const run = runNetwork(cbp, { evalMs: frameOpen, diagnostics: true, syncState: 'ALIGNED' });
      agg[mode].closes++;
      const tlFrame = { ms: frameOpen, pairs: {} };
      for (const p of PAIRS) {
        const rec = run.pairs[p];
        agg[mode].evals++;
        inc(agg[mode].decision, rec.decision);
        inc(agg[mode].state, rec.marketState.state);
        inc(agg[mode].agreement, rec.agreement.state);
        if (isArmed(rec.decision)) agg[mode].armedFrames++;
        tlFrame.pairs[p] = { decision: rec.decision, direction: rec.snapshot.direction, strategy: rec.strategy };
        if (mode === 'correct') {
          const w = gateWaterfall(rec);
          inc(agg.correct.primary, rec.decision);
          for (const g of w.gates) if (g.status === 'FAIL') inc(agg.correct.gateFail, g.name);
          // overlap among the four spec gates (independent booleans)
          const on = ['CHAOTIC', 'INSUFFICIENT_SPACE', 'LATE', 'NO_AGREEMENT'].filter((n) => w.gates.find((g) => g.name === n && g.status === 'FAIL'));
          for (let i = 0; i < on.length; i++) for (let j = i; j < on.length; j++) inc(overlap, i === j ? on[i] : `${on[i]}|${on[j]}`);
        }
      }
      (mode === 'correct' ? timelineCorrect : timelineLegacy).push(tlFrame);

      // snapshot capture (correct + legacy) at the requested close
      if (snapMs != null && T === Math.floor(snapMs / M15_MS) * M15_MS) {
        snapshotOut = snapshotOut || {};
        snapshotOut[mode] = {
          requestedIso: new Date(snapMs).toISOString(), frameOpenIso: new Date(frameOpen).toISOString(),
          pairs: PAIRS.map((p) => {
            const rec = run.pairs[p]; const w = gateWaterfall(rec);
            return { pair: p, decision: rec.decision, marketState: rec.marketState.state, agreement: rec.agreement.state,
              direction: rec.snapshot.direction, failingGates: w.failingGates, gates: w.gates,
              lastCandleIso: new Date(cbp[p].slice(-1)[0].openMs).toISOString() };
          }),
        };
      }
    }
    evaluatedCloses++;
  }

  // episodes (correct mode)
  const episodes = reduceEpisodes(timelineCorrect, { expiryCandles: CONFIG.trigger.expiryCandles });
  // outcomes for each episode's first-armed frame (post-hoc, labelled)
  const outcomes = episodes.map((e) => {
    const arr = byPair[e.pair]; const startIdx = lastIdxLe(arr, e.firstMs);
    // rebuild the setup at first-armed frame
    const cbp = {}; for (const p of PAIRS) { const idx = lastIdxLe(byPair[p], e.firstMs); cbp[p] = idx < 0 ? [] : byPair[p].slice(Math.max(0, idx - WARMUP + 1), idx + 1); }
    const run = runNetwork(cbp, { evalMs: e.firstMs });
    const setup = run.pairs[e.pair] && run.pairs[e.pair].setup;
    const future = arr.slice(startIdx + 1, startIdx + 1 + 200); // forward window for outcome
    return { ...e, hasSetup: !!setup, outcome: setup ? estimateOutcome(setup, future, CONFIG) : { label: 'NO_SETUP' } };
  });

  // legacy-vs-correct decision delta (same closes)
  let comparedCloses = 0, diffPairFrames = 0, armedOnlyLegacy = 0, armedOnlyCorrect = 0;
  const lgByMs = Object.fromEntries(timelineLegacy.map((f) => [f.ms, f]));
  for (const f of timelineCorrect) {
    const lg = lgByMs[f.ms]; if (!lg) continue; comparedCloses++;
    for (const p of PAIRS) {
      const a = f.pairs[p].decision, b = lg.pairs[p] && lg.pairs[p].decision;
      if (b == null) continue;
      if (a !== b) diffPairFrames++;
      if (isArmed(b) && !isArmed(a)) armedOnlyLegacy++;
      if (isArmed(a) && !isArmed(b)) armedOnlyCorrect++;
    }
  }

  // ── manifest / freeze ──────────────────────────────────────────────────────
  const manifest = {
    generatedAt: new Date().toISOString(),
    revision: (process.env.GIT_REV || 'see git rev-parse HEAD'),
    configVersion: CONFIG_VERSION, configHash: configHash(CONFIG),
    thresholds: CONFIG,
    candleConvention: { timeIs: 'START (OANDA)', completeColumn: 'always true (only complete candles ingested)', priceType: 'MID (OANDA price=M)', timeframe: 'M15 only', source: 'OANDA fxpractice' },
    replayFilter: { rule: 'frameOpen = floor(T/M15)*M15 − M15 ; include open ≤ frameOpen (close ≤ T)', offGridPolicy: 'snap down to last completed close', legacyBug: 'floor(T/M15)*M15 included the candle opening at T (closes T+15) — lookahead' },
    outcomeAssumptions: { prices: 'MID (no bid/ask)', fill: 'from the candle AFTER arm (manual delay)', intrabar: 'stop+target same candle ⇒ AMBIGUOUS', target: '2R', spread: 'not applied (mid) — post-spread requires bid/ask', extrapolation: 'none — small sample' },
    window: { from: FROM, to: TO, stride: STRIDE, warmupCandles: WARMUP, firstEligibleFrameOpen: firstEligibleIso, evaluatedCloses },
    runCommand: `NODE_PATH=<@supabase dir> node scripts/m15/replay-cadence.js --from ${FROM} --to ${TO} --stride ${STRIDE} --warmup ${WARMUP}`,
  };

  const summary = {
    window: manifest.window,
    correct: withPct(agg.correct),
    legacy: withPct(agg.legacy),
    legacyVsCorrect: { comparedCloses, diffPairFrames, diffPct: pct(diffPairFrames, comparedCloses * PAIRS.length), armedOnlyLegacy, armedOnlyCorrect },
    episodesCorrect: episodes.length,
    armedFramesCorrect: agg.correct.armedFrames,
  };

  const waterfall = {
    denominators: { evaluations: agg.correct.evals, closes: agg.correct.closes, pairs: PAIRS.length, episodes: episodes.length },
    primaryDecision: sortObj(agg.correct.primary),
    independentGateFail: sortObj(agg.correct.gateFail),
    overlapMatrix: sortObj(overlap),
    note: 'independentGateFail counts each gate that WOULD reject, ignoring priority; primaryDecision is the single displayed outcome (priority order DEAD>CHAOTIC>CONFLICTED>LATE>OVEREXTENDED>INSUFFICIENT_SPACE>SPREAD>agreement).',
  };

  write('baseline_manifest.json', manifest);
  write('cadence_summary.json', summary);
  write('gate_waterfall.json', waterfall);
  write('episodes.json', { count: episodes.length, episodes });
  write('outcomes.json', { assumptions: manifest.outcomeAssumptions, note: 'ESTIMATED / post-hoc; do not extrapolate win rate from small n.', outcomes });
  if (snapshotOut) write(`snapshot_${SNAPSHOT.replace(/[:]/g, '')}.json`, snapshotOut);

  console.error('\n=== SUMMARY (correct frame) ===');
  console.error(`evaluations ${agg.correct.evals} over ${agg.correct.closes} closes; first eligible ${firstEligibleIso}`);
  console.error('armed frames:', agg.correct.armedFrames, '| unique episodes:', episodes.length);
  console.error('legacy vs correct: diff pair-frames', diffPairFrames, `(${pct(diffPairFrames, comparedCloses * PAIRS.length)}%)`, '| armed-only-legacy', armedOnlyLegacy, '| armed-only-correct', armedOnlyCorrect);
  console.error('primary decisions:', JSON.stringify(sortObj(agg.correct.primary)));
  console.error('wrote reports to', OUTDIR);
}

function withPct(a) {
  return { evals: a.evals, closes: a.closes, armedFrames: a.armedFrames, missingExcluded: a.missingExcluded,
    decision: pctObj(a.decision, a.evals), state: pctObj(a.state, a.evals), agreement: pctObj(a.agreement, a.evals) };
}
function pct(n, d) { return d ? +(100 * n / d).toFixed(2) : 0; }
function pctObj(obj, total) { const o = {}; for (const k of Object.keys(obj).sort((x, y) => obj[y] - obj[x])) o[k] = { n: obj[k], pct: pct(obj[k], total) }; return o; }
function sortObj(obj) { const o = {}; for (const k of Object.keys(obj).sort((x, y) => obj[y] - obj[x])) o[k] = obj[k]; return o; }
function write(name, obj) { fs.writeFileSync(path.join(OUTDIR, name), JSON.stringify(obj, null, 2)); }

main().catch((e) => { console.error('RUN ERROR:', e.message); process.exit(1); });
