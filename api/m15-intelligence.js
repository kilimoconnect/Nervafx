'use strict';

/**
 * GET /api/m15-intelligence — NEW M15 research classifier (read-only, analytical).
 *
 * Replaces the retired M15 Intelligence engine (api/_m15/*). Loads real completed M15
 * candles for the 28 pairs from backtest_candles (mid, OANDA), finds the latest
 * SYNCHRONIZED close, runs the pure research classifier (price action + zero-sum
 * currency-strength network) for every pair as-of that close, and returns the board.
 *
 * This is a DESCRIPTION, not a trade signal. It never writes to the DB and never places,
 * manages, or suggests a broker order. No look-ahead: only candles that closed by the
 * synchronized close are used (see research/m15/loader.syncAsOf).
 */

const { getClient, cors } = require('./_db');
const { loadAllPairsFromDb, syncAsOf, PAIRS, M15 } = require('../research/m15/loader');
const { describeNetwork } = require('../research/m15/strengthnet');
const { classify, CLASSIFIER_VERSION } = require('../research/m15/classifier');

const toEat = (ms) => new Date(ms + 3 * 60 * 60 * 1000).toISOString().replace('Z', '+03:00');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  try {
    const sb = getClient();
    // ~5 days of M15 covers the 48h context + swing calibration + ATR warm-up.
    const fromIso = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const histories = await loadAllPairsFromDb(sb, { pairs: PAIRS, fromIso });

    // Latest SYNCHRONIZED completed close across the 28 pairs (no look-ahead).
    const probe = syncAsOf(histories, Date.now());
    if (probe.frameOpenMs == null) {
      return res.json({ ok: true, available: false, reason: 'NO_DATA', missing: probe.missing, version: CLASSIFIER_VERSION });
    }
    const T = probe.frameOpenMs + M15;
    const ageSec = Math.round((Date.now() - T) / 1000);
    const stale = ageSec > 20 * 60;                 // older than ~1 interval + grace

    const net = describeNetwork(histories, { asOfCloseMs: T });
    const h24 = net.windows ? net.windows.h24 : null;

    const pairs = PAIRS.map((pair) => {
      const c = classify(pair, histories, { asOfCloseMs: T, network: net });
      return {
        pair,
        state: c.primaryState,
        direction: c.progress ? c.progress.transitionDir : null,
        explanation: c.explanation,
        strength: c.strength && c.strength.available ? { gap: c.strength.gap, dir: c.strength.strengthDir, confirmed: c.strength.independentlyConfirmed, breadth: c.strength.leadingBreadth } : null,
        windows: c.windows,
        structure: { acceptedHold: c.structure.acceptedHold, confirmedPivots: c.structure.confirmedPivots, rejection: c.structure.rejection },
        evidenceFor: (c.evidenceFor || []).map((e) => e.text),
        evidenceAgainst: (c.evidenceAgainst || []).map((e) => e.text),
        qualityFlags: c.qualityFlags,
      };
    });

    const board = h24 && h24.available
      ? h24.effects.ranked.map((ccy) => ({ currency: ccy, x: h24.effects.byCurrency[ccy], breadth: h24.breadth[ccy] ? h24.breadth[ccy].fraction : 0 }))
      : null;

    res.json({
      ok: true, available: true,
      version: CLASSIFIER_VERSION,
      disclaimer: 'research classification — not a trade signal',
      asOfCloseUtc: new Date(T).toISOString(),
      asOfCloseEat: toEat(T),
      ageSeconds: ageSec, stale,
      aligned: probe.aligned, missing: probe.missing, laggards: probe.laggards,
      pairsPresent: PAIRS.length - probe.missing.length,
      board,
      networkAvailable: !!(h24 && h24.available),
      pairs,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 60;
