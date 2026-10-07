/* Typed FIXTURE adapter for the manual-decision workspace (DEMO/SYNTHETIC).
 *
 * The frontend talks ONLY to this adapter, never to the fixture engine or any
 * backend. It returns the pre-generated, contract-accurate fixture payload. On any
 * failure it THROWS (surfaced as an explicit error state) — there is no hidden
 * fill-forward or synthetic fallback.
 *
 * Contract (the same shape the real classifier/network would map into):
 *   Workspace = { meta, modelHealth, watchlist: [ { pair, label, scenario, candles[], frames[] } ] }
 *   candles[] = { openMs, open, high, low, close }                       // M15 only
 *   frames[]  = per completed close, immutable as-of that close:
 *     { candleIdx, asOfCloseMs, asOfCloseUtc, asOfCloseEat,
 *       primaryState, previousState, transition,
 *       windows{context_48_36h, transition_24h, present_12h},
 *       priceStories{h12,h24,h36,h48}, compare12,
 *       strengthBoard[8], otherPairConfirmation,  // leave-one-pair-out = OTHER-PAIR confirmation, NOT independence
 *       events[], structure, evidenceFor[], evidenceAgainst[], explanation,
 *       nextCondition, invalidationReference, invalidationLevel, extendedMove,
 *       dataHealth{available,reason,stale,closedMarket,aligned,pairsPresent,pairsExpected} }
 *
 * To wire the REAL backend later, replace getWorkspace() with a fetch to
 * /api/m15-intelligence (+ a per-pair replay endpoint) and map the response into
 * this exact shape. Do NOT silently fall back to fixtures on error — surface it.
 */
(function (global) {
  'use strict';
  var FORCE_ERROR = false;   // demo toggle to exercise the error state (no fabrication)

  var Adapter = {
    provenance: 'SYNTHETIC',
    setForceError: function (v) { FORCE_ERROR = !!v; },
    getForceError: function () { return FORCE_ERROR; },

    // Returns the workspace payload or THROWS. No fallback data on failure.
    getWorkspace: function () {
      if (FORCE_ERROR) throw new Error('Simulated adapter error — the UI must show an explicit error state and must NOT fabricate data.');
      var f = global.NFX_FIXTURES;
      if (!f || !f.watchlist) throw new Error('Fixtures not loaded (fixtures.js missing). No synthetic fallback is invented.');
      return f;
    },

    // Convenience: a watchlist entry by pair id, or null.
    getPair: function (ws, pairId) {
      for (var i = 0; i < ws.watchlist.length; i++) if (ws.watchlist[i].pair === pairId) return ws.watchlist[i];
      return null;
    },
  };

  global.NFXAdapter = Adapter;
})(window);
