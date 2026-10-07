'use strict';

/** Stage 6 — build docs/research/research_health.json (read-only). Health of the
 * latest verified close + currency strength + pressure horizons as EXPLANATIONS
 * (descriptors, not signals). No writes, no orders. */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { M15, PAIRS, syncAsOf, loadAllPairsFromDb } = require('../../research/m15/loader');
const { featureSnapshot } = require('../../research/m15/featureSnapshot');
const { researchHealth } = require('../../research/m15/health');

function env() { const t = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8'); const e = {}; for (const l of t.split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)\s*=\s*(.*)$/); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); } return e; }

async function main() {
  const e = env(); const sb = createClient(e.SUPABASE_URL, e.SUPABASE_SERVICE_KEY);
  const nowMs = Date.now();
  const hist = await loadAllPairsFromDb(sb, { fromIso: new Date(nowMs - 8 * 24 * 3600e3).toISOString() });
  // frame = the latest completed close the data supports
  const lastOpen = Math.max(...PAIRS.map((p) => hist[p].length ? hist[p][hist[p].length - 1].openMs : 0));
  const T = lastOpen + M15;
  const view = syncAsOf(hist, T);
  const health = researchHealth(view, { nowMs });
  const snap = featureSnapshot(hist, T);
  const x = snap.network[10].x;
  const strength = Object.keys(x).map((c) => ({ currency: c, x10: +x[c].toFixed(6) })).sort((a, b) => b.x10 - a.x10);
  const horizons = ['EUR_USD', 'GBP_JPY', 'AUD_USD'].map((p) => ({ pair: p, R: { 4: snap.pairs[p].horizons[4] && +snap.pairs[p].horizons[4].R.toFixed(6), 6: snap.pairs[p].horizons[6] && +snap.pairs[p].horizons[6].R.toFixed(6), 8: snap.pairs[p].horizons[8] && +snap.pairs[p].horizons[8].R.toFixed(6), 10: snap.pairs[p].horizons[10] && +snap.pairs[p].horizons[10].R.toFixed(6) } }));

  const out = {
    generatedAt: new Date(nowMs).toISOString(),
    engineVersion: 'm15-cfg-1.1.0a', featureVersion: 'm15-feat-1.0.0', researchVersion: 'm15-research-3.0.0',
    health,
    explanations: { note: 'Currency strength (network x, N=10) and the 4 pressure horizons are DESCRIPTORS shown to explain state — NOT tradable signals. No candidate is selected.', currencyStrength: strength, pressureHorizons: horizons },
  };
  fs.mkdirSync(path.join(__dirname, '..', '..', 'docs', 'research'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', '..', 'docs', 'research', 'research_health.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ latestCloseUtc: health.latestCloseUtc, latestCloseEat: health.latestCloseEat, complete: health.complete, stale: health.stale, ageSec: health.dataAgeSeconds, topStrength: strength.slice(0, 3) }, null, 2));
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
