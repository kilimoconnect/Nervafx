'use strict';

/**
 * Candidate configuration m15-cfg-1.1.0 — "space is a per-trade test" (Phase 2, C1).
 *
 * Identical to the frozen baseline m15-cfg-1.0.0 EXCEPT the space gate's APPLICATION
 * (not its numbers). Evidence (docs/phase1 + scripts/m15/diagnose-gates.js):
 *   • 48.8% of INSUFFICIENT_SPACE primary rejections had NO routed candidate.
 *   • 80.4% of independent space failures had no candidate.
 *   • barrier for routed candidates was a minor internal swing (median 0.146 vol).
 * So on the baseline, "insufficient space" is asserted where no trade — hence no
 * entry/stop — exists. This candidate makes space N/A without a candidate, tests
 * usable room in R once a setup exists, and stops the pre-candidate space check
 * from blocking the agreement grade. The engines read `cfg.space.mode`; when it is
 * absent (the frozen baseline) they take the legacy path, so 1.0.0 is untouched
 * and reproduces Phase One byte-for-byte.
 *
 * This is ONE rule change (space application). Barrier QUALITY (ignoring minor
 * internal swings) is deliberately NOT changed here — it is a separate future
 * candidate to be shadow-tested, per the one-change-at-a-time discipline.
 */

const { CONFIG } = require('./config');

// Deep clone the frozen baseline (plain data), then override only space + version.
const base = JSON.parse(JSON.stringify(CONFIG));

const CONFIG_1_1_0 = Object.freeze({
  ...base,
  version: 'm15-cfg-1.1.0',
  space: {
    ...base.space,
    mode: 'per_trade',        // decide-level: N/A without a candidate; test room in R
    minRoomR: 1.0,            // require ≥ 1R of usable room to the opposing barrier
    deferAgreement: true,     // ALSO relax the agreement space gate (signal-admitting)
  },
});

// 1.1.0a — correctness/safety ONLY: per-trade space at the decide stage, but the
// agreement space gate is KEPT. Relabels no-candidate rejections and blocks
// undefined-risk / thin-room setups WITHOUT admitting new chop candidates.
const CONFIG_1_1_0A = Object.freeze({
  ...base,
  version: 'm15-cfg-1.1.0a',
  space: { ...base.space, mode: 'per_trade', minRoomR: 1.0, deferAgreement: false },
});

module.exports = { CONFIG_1_1_0, CONFIG_1_1_0A };
