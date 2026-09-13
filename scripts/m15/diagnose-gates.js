'use strict';

/**
 * Phase 2 — gate diagnosis (read-only). Answers, on the frozen baseline over the
 * full window: how often does INSUFFICIENT_SPACE reject a pair that has NO routed
 * candidate (direction/strategy)? For candidates that DO route, what usable room
 * in R does the barrier give — and is that barrier a real zone or a minor swing?
 * Also dumps the 2026-09-10 15:00 EAT frame for EUR/GBP, AUD/CHF, EUR/CAD.
 * No DB writes, no order logic.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { CONFIG } = require('../../api/_m15/config');
const { PAIRS } = require('../../api/_m15/pairs');
const { toCandle, M15_MS } = require('../../api/_m15/data');
const { replayFrameOpen } = require('../../api/_m15/load');
const { runNetwork } = require('../../api/_m15/coordinator');
const { routeStrategy } = require('../../api/_m15/strategy');

const FROM = '2026-07-01', TO = '2026-09-11', WARMUP = 260;
const fromMs = Date.parse(FROM + 'T00:00:00Z'), toMs = Date.parse(TO + 'T23:59:59Z');
const SNAP = Date.parse('2026-09-10T12:00:00Z');

function env() { const t = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8'); const e = {}; for (const l of t.split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)\s*=\s*(.*)$/); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); } return e; }
async function loadPair(sb, p, fi, ti) { const all = []; let o = 0; for (;;) { const { data, error } = await sb.from('backtest_candles').select('time,open,high,low,close,volume,complete').eq('instrument', p).eq('timeframe', 'M15').eq('complete', true).gte('time', fi).lte('time', ti).order('time', { ascending: true }).range(o, o + 999); if (error) throw new Error(error.message); all.push(...data); if (data.length < 1000) break; o += 1000; } return all.map(toCandle); }
function lastIdxLe(a, t) { let lo = 0, hi = a.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].openMs <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; }

// usable room to the nearest opposing barrier, in R, from the current price
function roomR(diag) {
  const ex = diag.expansion, eq = diag.eq;
  if (!ex || !eq || ex.availableSpaceVol == null) return null;
  return { spaceVol: ex.availableSpaceVol, volNow: eq.volNow };
}

async function main() {
  const e = env(); const sb = createClient(e.SUPABASE_URL, e.SUPABASE_SERVICE_KEY);
  const pre = new Date(fromMs - (WARMUP + 40) * M15_MS * 3).toISOString();
  const byPair = {}; for (const p of PAIRS) byPair[p] = await loadPair(sb, p, pre, new Date(toMs).toISOString());
  console.error('loaded', Math.min(...PAIRS.map(p => byPair[p].length)), 'min/pair');

  const first = Math.ceil(fromMs / M15_MS) * M15_MS, last = Math.floor(toMs / M15_MS) * M15_MS;
  let evals = 0, spacePrimary = 0, spaceNoCandidate = 0, spaceWithCandidate = 0;
  let spaceIndepFail = 0, spaceIndepFail_noCand = 0;
  const roomRs = [];   // for candidates that route AND space-fail: usable room in R
  let snap = null;

  for (let T = first; T <= last; T += M15_MS) {
    const cbp = {}; let ok = true;
    for (const p of PAIRS) { const i = lastIdxLe(byPair[p], replayFrameOpen(T, false)); if (i < WARMUP - 1) ok = false; cbp[p] = i < 0 ? [] : byPair[p].slice(Math.max(0, i - WARMUP + 1), i + 1); }
    if (!ok) continue;
    const run = runNetwork(cbp, { evalMs: replayFrameOpen(T, false), diagnostics: true });
    const dumpFrame = (T === Math.floor(SNAP / M15_MS) * M15_MS);
    for (const p of PAIRS) {
      const rec = run.pairs[p]; const d = rec.diag; evals++;
      // would a strategy route for this pair, ignoring the pre-strategy space gate?
      const wouldRoute = !!routeStrategy({ marketState: d.marketState, compression: d.compression, pressure: d.pressure, expansion: d.expansion, energy: d.energy, movement: d.movement, freshness: d.freshness }, CONFIG);
      const spaceFail = d.expansion && d.expansion.spaceSufficient === false;
      if (spaceFail) { spaceIndepFail++; if (!wouldRoute) spaceIndepFail_noCand++; }
      if (rec.decision === 'NO_TRADE_INSUFFICIENT_SPACE') {
        spacePrimary++;
        if (wouldRoute) { spaceWithCandidate++; const r = roomR(d); if (r) roomRs.push(r.spaceVol); }
        else spaceNoCandidate++;
      }
      if (dumpFrame && ['EUR_GBP', 'AUD_CHF', 'EUR_CAD'].includes(p)) {
        snap = snap || {}; snap[p] = { decision: rec.decision, state: d.marketState.state, wouldRoute,
          spaceSufficient: d.expansion.spaceSufficient, availableSpaceVol: d.expansion.availableSpaceVol,
          distanceVol: d.expansion.distanceVol, agreement: d.agreement.state,
          lastCandle: new Date(cbp[p].slice(-1)[0].openMs).toISOString() };
      }
    }
  }
  roomRs.sort((a, b) => a - b);
  const pctl = (q) => roomRs.length ? roomRs[Math.floor(q * (roomRs.length - 1))] : null;
  console.log(JSON.stringify({
    evals,
    INSUFFICIENT_SPACE_primary: spacePrimary,
    space_primary_with_no_candidate: spaceNoCandidate,
    space_primary_with_candidate: spaceWithCandidate,
    pct_space_primary_without_candidate: +(100 * spaceNoCandidate / spacePrimary).toFixed(1),
    space_independent_fail: spaceIndepFail,
    space_independent_fail_without_candidate: spaceIndepFail_noCand,
    pct_independent_space_fail_without_candidate: +(100 * spaceIndepFail_noCand / spaceIndepFail).toFixed(1),
    space_barrier_vol_for_routed_candidates: { n: roomRs.length, p10: pctl(0.1), median: pctl(0.5), p90: pctl(0.9), min: roomRs[0], max: roomRs[roomRs.length - 1] },
    snapshot_1500EAT: snap,
  }, null, 2));
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
