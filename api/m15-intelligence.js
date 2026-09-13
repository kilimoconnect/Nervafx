'use strict';

/**
 * GET /api/m15-intelligence  — M15 Market Intelligence (read-only, analytical).
 *
 * Live:     no query           → latest completed M15 frame.
 * Replay:   ?at=ISO            → reconstructs exactly what was known at that M15
 *                                close (no future data, §28). HISTORY MODE.
 * Detail:   ?pair=EUR_USD      → adds the full per-pair record + candles to chart.
 *
 * Runs the deterministic coordinator on completed M15 candles only. This route
 * never writes to the DB and never places, manages, or suggests a broker order.
 * Manual triggers require live bid/ask which this read route does not fetch, so
 * setups are shown as plans; live-trigger firing is handled by the cron layer.
 */

const { cors, getClient } = require('./_db');
const { loadSynchronized } = require('./_m15/load');
const { runNetwork } = require('./_m15/coordinator');
const { CONFIG_1_1_0A } = require('./_m15/config-1_1_0');
const { isArmed } = require('./_m15/diagnostics');
const { isPaused, applyOperatorPause } = require('./_m15/notify');
const { closeOf, freshness } = require('./_m15/snapshot');
const { M15_MS } = require('./_m15/data');

// Published engine: Phase 2 accepted version (space is a per-trade test).
const CFG = CONFIG_1_1_0A;

/** Actionable / Developing / Blocked / Unavailable per the Phase-2 state contract. */
function categoryOf(rec, hasData, stale) {
  if (!hasData) return 'UNAVAILABLE';
  if (isArmed(rec.decision) && rec.setup && !stale) return 'ACTIONABLE';
  if (/^WATCH_/.test(rec.decision)) return 'DEVELOPING';
  return 'BLOCKED';
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const atMs = req.query.at ? Date.parse(req.query.at) : null;
    if (req.query.at && Number.isNaN(atMs)) return res.status(400).json({ error: 'invalid ?at (use ISO time)' });
    const nowMs = Date.now();

    const { evalMs, candlesByPair, sync } = await loadSynchronized(sb, { atMs, nowMs, cfg: CFG });
    const run = runNetwork(candlesByPair, { evalMs, nowMs, cfg: CFG, syncState: sync.reason, noCriticalNews: true });
    const closeMs = closeOf(evalMs);
    const fresh = freshness(closeMs, nowMs, CFG);
    const missing = sync.missing || [];

    // Currency dashboard (8 currencies): strength + power + structure merged.
    const currencies = mergeCurrencies(run);

    // All-pairs scanner, ranked, with the Actionable/Developing/Blocked/Unavailable
    // category and available room in R (only when a valid setup defines it).
    const counts = { ACTIONABLE: 0, DEVELOPING: 0, BLOCKED: 0, UNAVAILABLE: 0 };
    const scan = run.ranking.map((r) => {
      const p = run.pairs[r.pair];
      const hasData = (candlesByPair[r.pair] || []).length > 0;
      const category = categoryOf(p, hasData, fresh.stale);
      counts[category]++;
      const roomR = p.setup && p.setup.availableSpaceVol != null ? p.setup.availableSpaceVol : null;
      return {
        rank: r.rank, pair: r.pair, decision: p.decision, strategy: p.strategy, category,
        marketState: p.marketState.state, direction: p.snapshot.direction,
        movementStage: p.snapshot.movementStage,
        energyLevel: p.snapshot.energyLevel, energyDirection: p.snapshot.energyDirection, energyAcceleration: p.snapshot.energyAcceleration,
        emaState: p.snapshot.emaState, compression: p.snapshot.compression, expansion: p.snapshot.expansion,
        freshness: p.snapshot.freshness, pressure: p.snapshot.pressure,
        agreement: p.agreement.state, strengthDiff: Math.round(p.strengthDiff || 0),
        availableRoomR: roomR, primaryReason: p.decision,
        score: r.score, qualifies: r.qualifies,
      };
    });

    // Operator incident pause (§P5): suppress Actionable + notices, keep history.
    const paused = isPaused();
    const pausedView = applyOperatorPause(scan, counts, paused);

    const detailPair = req.query.pair;
    const detail = detailPair && run.pairs[detailPair]
      ? buildDetail(run, detailPair, candlesByPair[detailPair])
      : null;

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=30');
    res.json({
      ok: true,
      // ── disclosure contract (Phase 3) ──────────────────────────────────────
      source: 'recompute',                       // read route recomputes; stored snapshots come from /api/m15-snapshot
      engineVersion: run.run.calculationVersion, // published: m15-cfg-1.1.0a
      evalMs, evalIso: new Date(evalMs).toISOString(),        // frame open
      closeIso: new Date(closeMs).toISOString(), // EXACT UTC M15 close (frame + 15m)
      historyMode: atMs != null,
      liveTriggerMonitoring: atMs == null,       // replay never monitors live triggers
      ordersDisabled: true, analyticalManualOnly: true,
      completeness: { pairsProcessed: Object.values(candlesByPair).filter((a) => a && a.length > 0).length, pairsExpected: 28, syncState: sync.reason, missing, complete: sync.reason === 'ALIGNED' && missing.length === 0 },
      freshness: fresh,                          // { ageSeconds, ageCandles, stale }
      paused, pauseReason: paused ? 'PAUSED_BY_OPERATOR' : null,
      counts: pausedView.counts,                 // ACTIONABLE / DEVELOPING / BLOCKED / UNAVAILABLE
      sync: { state: sync.reason, laggards: sync.laggards || [], missing },
      calculationVersion: run.run.calculationVersion,
      currencies, scan: pausedView.scan, detail,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

function mergeCurrencies(run) {
  const { strength, power, structure } = run.currencies;
  return strength.ranked.map((ccy) => ({
    currency: ccy,
    strength: strength.byCurrency[ccy].strengthScore,
    strengthRank: strength.byCurrency[ccy].strengthRank,
    strengthDirection: strength.byCurrency[ccy].strengthDirection,
    strengthAcceleration: strength.byCurrency[ccy].strengthAcceleration,
    breadth: strength.byCurrency[ccy].breadth,
    power: power.byCurrency[ccy].powerScore,
    powerState: power.byCurrency[ccy].powerState,
    powerDirection: power.byCurrency[ccy].powerDirection,
    structure: structure.byCurrency[ccy].state,
    participation: structure.byCurrency[ccy].participation,
    supportingPairs: structure.byCurrency[ccy].supportingPairs,
    conflictingPairs: structure.byCurrency[ccy].conflictingPairs,
  }));
}

function buildDetail(run, pair, candles) {
  const p = run.pairs[pair];
  return {
    pair,
    marketState: p.marketState.state,
    stateEvidence: p.marketState.evidence,
    decision: p.decision, strategy: p.strategy,
    agreement: p.agreement,               // full component breakdown + reasons (§30)
    setup: p.setup,
    snapshot: p.snapshot,
    candles: (candles || []).slice(-140), // last 140 M15 for the chart
  };
}

module.exports.maxDuration = 60;
