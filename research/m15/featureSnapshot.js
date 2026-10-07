'use strict';

/**
 * M15 Strategy Research — as-of-close feature snapshot (Stage 2). Deterministic:
 * the same synchronized histories + feature version reproduce the same snapshot
 * (tolerance-exact). Uses the Stage-1 no-lookahead `syncAsOf`. Optional read-only
 * descriptors borrow the production engines WITHOUT changing their outputs.
 */

const crypto = require('crypto');
const { PAIRS, M15, syncAsOf } = require('./loader');
const { NS, FEATURE_VERSION, FEATURE_CONFIG, pairFeatures, currencyMovement, featureHash } = require('./features');

/** UTC-hour session label (research descriptor; not a gate). */
function sessionOf(ms) {
  const h = new Date(ms).getUTCHours();
  if (h >= 0 && h < 7) return 'TOKYO';
  if (h >= 7 && h < 12) return 'LONDON';
  if (h >= 12 && h < 16) return 'LONDON_NY';
  if (h >= 16 && h < 21) return 'NEWYORK';
  return 'OFF_HOURS';
}

/** Optional read-only descriptors from the production engines (no output change). */
function descriptorsFor(pair, candles) {
  try {
    const { evaluateEnergy } = require('../../api/_m15/energy');
    const { evaluateEMA } = require('../../api/_m15/ema');
    const { evaluateEquilibrium } = require('../../api/_m15/equilibrium');
    const { detectStructure } = require('../../api/_m15/structure');
    const en = evaluateEnergy(candles, { pair });
    const ema = evaluateEMA(candles, { pair });
    const eq = evaluateEquilibrium(candles, { pair });
    const st = detectStructure(candles, { pair });
    return {
      energyLevel: en.energyLevel, energyDirection: en.energyDirection, energyAcceleration: en.energyAcceleration,
      emaState: ema.state,
      distanceVol: eq ? +(+eq.distanceVol).toFixed(3) : null,
      structureDirection: st.current ? st.current.direction : 'NONE', structuralLegs: (st.legs || []).length,
    };
  } catch (e) { return { descriptorError: e.message }; }
}

function featureSnapshot(historiesByPair, evaluationCloseUtc, opts = {}) {
  const cfg = opts.cfg || FEATURE_CONFIG;
  const view = syncAsOf(historiesByPair, evaluationCloseUtc);
  if (view.frameOpenMs == null) return { ok: false, reason: 'NO_DATA', evaluationCloseUtc, missing: view.missing };

  const pairs = {};
  const RByN = {}; for (const N of NS) RByN[N] = {};
  for (const p of PAIRS) {
    const cs = view.bySync[p];
    const f = pairFeatures(cs, { pair: p, cfg });
    if (opts.descriptors) f.descriptors = descriptorsFor(p, cs);
    pairs[p] = f;
    for (const N of NS) RByN[N][p] = f.horizons[N] ? f.horizons[N].R : null;
  }
  const network = {}; for (const N of NS) network[N] = currencyMovement(RByN[N], { N, cfg });

  const fingerprint = PAIRS.map((p) => { const cs = view.bySync[p]; const last = cs[cs.length - 1]; return `${p}:${cs.length}:${last ? last.openMs + ':' + last.close : 'na'}`; }).join('|');
  const inputHash = crypto.createHash('sha256').update(`${view.frameOpenMs}|${FEATURE_VERSION}|${fingerprint}`).digest('hex').slice(0, 16);

  return {
    ok: true,
    featureVersion: FEATURE_VERSION,
    featureHash: featureHash(cfg),
    inputHash,
    evaluationCloseUtc, frameOpenMs: view.frameOpenMs,
    frameOpenIso: new Date(view.frameOpenMs).toISOString(),
    closeIso: new Date(view.frameOpenMs + M15).toISOString(),
    session: sessionOf(view.frameOpenMs),
    aligned: view.aligned, missing: view.missing, laggards: view.laggards,
    pairs, network,
  };
}

module.exports = { featureSnapshot, sessionOf, descriptorsFor };
