'use strict';

/**
 * Fixture ENGINE for the isolated manual-decision workspace (research/ui/workspace).
 *
 * Generates contract-accurate, SYNTHETIC data by running the real research modules
 * (priceaction + strengthnet + classifier) over designed candle fixtures. The frontend
 * reads ONLY this output and is kept separate from this engine. Nothing here is live,
 * no DB is touched, and every screen that consumes it is labelled DEMO / SYNTHETIC.
 *
 *   node scripts/research/build-workspace-fixtures.js
 *     → research/ui/workspace/fixtures.js   (window.NFX_FIXTURES = {...})
 *     → docs/research/workspace/fixtures.json
 */

const fs = require('fs');
const path = require('path');
const { classify } = require('../../research/m15/classifier');
const { describeNetwork } = require('../../research/m15/strengthnet');
const { describePriceAction } = require('../../research/m15/priceaction');
const { CLASSIFIER_VERSION } = require('../../research/m15/classifier');
const gen = require('./build-replay');

const M15 = 15 * 60 * 1000;
const toEat = (ms) => new Date(ms + 3 * 3600 * 1000).toISOString().replace('Z', '+03:00');

/** Forex market closed: Fri 21:00 UTC → Sun 21:00 UTC. */
function closedMarket(ms) { const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours(); if (day === 6) return true; if (day === 0 && h < 21) return true; if (day === 5 && h >= 21) return true; return false; }

function nextConditionFor(state, structure) {
  const ref = structure.provisionalLeg ? structure.provisionalLeg.extremePrice : (structure.lastPivot ? structure.lastPivot.price : null);
  const map = {
    EMERGING_MOVE_UP: { next: 'Acceptance: a held break above balance + broad other-pair strength confirming up.', inval: 'Close back below the balance zone / a confirmed lower high.' },
    EMERGING_MOVE_DOWN: { next: 'Acceptance: a held break below balance + broad other-pair strength confirming down.', inval: 'Close back above the balance zone / a confirmed higher low.' },
    ACCEPTED_TREND_UP: { next: 'Continuation hold or acceleration of present 12h momentum.', inval: 'Confirmed high pivot against context or loss of other-pair strength confirmation.' },
    ACCEPTED_TREND_DOWN: { next: 'Continuation hold or acceleration of present 12h momentum.', inval: 'Confirmed low pivot against context or loss of other-pair strength confirmation.' },
    ACCELERATING_TREND_UP: { next: 'Momentum sustained; watch for deceleration (exhaustion risk).', inval: 'Confirmed high pivot / strength no longer confirmed.' },
    ACCELERATING_TREND_DOWN: { next: 'Momentum sustained; watch for deceleration (exhaustion risk).', inval: 'Confirmed low pivot / strength no longer confirmed.' },
    EXHAUSTION_RISK_UP: { next: 'Either momentum re-accelerates or a confirmed high pivot forms.', inval: 'Re-acceleration invalidates the exhaustion read.' },
    EXHAUSTION_RISK_DOWN: { next: 'Either momentum re-accelerates or a confirmed low pivot forms.', inval: 'Re-acceleration invalidates the exhaustion read.' },
    REVERSAL_UP: { next: 'New-direction acceptance (held higher prices + strength turning up).', inval: 'Failure to hold above the confirmed low / return under it.' },
    REVERSAL_DOWN: { next: 'New-direction acceptance (held lower prices + strength turning down).', inval: 'Failure to hold below the confirmed high / return over it.' },
    CONFLICT: { next: 'Price and other-pair strength must realign before any read is actionable.', inval: 'Either side flips to agree.' },
    BALANCED_RANGE: { next: 'A held break of the balance zone with strength support.', inval: 'Continued rotation inside the range.' },
    UNAVAILABLE: { next: 'Sufficient, synchronized, fresh data at the close.', inval: null },
  };
  const m = map[state] || { next: '—', inval: null };
  return { nextCondition: m.next, invalidationReference: m.inval, invalidationLevel: ref };
}

function extendedMoveFlag(pa) {
  const h48 = pa.windows && pa.windows.h48 && pa.windows.h48.descriptors;
  const h24 = pa.windows && pa.windows.h24 && pa.windows.h24.descriptors;
  if (!h48 || !h24) return false;
  // "extended": strong persistent one-way efficiency over the full 48h context.
  return Math.abs(h48.directionalEfficiency) >= 0.7 && Math.abs(h24.directionalEfficiency) >= 0.6 && h48.actual >= 160;
}

function buildFrame(pair, H, t, prev, candleIdx) {
  const net = describeNetwork(H, { asOfCloseMs: t });
  const pa = describePriceAction(H[pair] || [], { pair, asOfCloseMs: t });
  const c = classify(pair, H, { asOfCloseMs: t, network: net, prevState: prev });
  const h24 = net.windows ? net.windows.h24 : null;
  const cov = h24 && h24.coverage ? h24.coverage : { pairsUsed: 0, pairsExpected: 28 };
  const lastOpen = t - M15;
  const staleBefore = (pa.integrity && pa.integrity.gaps || []).some((g) => g.toMs === lastOpen);
  const insufficient = !pa.state || pa.state.label === 'NO_DATA' || pa.state.label === 'INSUFFICIENT_DATA';

  let availReason = null, available = true;
  if (insufficient) { available = false; availReason = pa.state && pa.state.label === 'NO_DATA' ? 'NO_DATA' : 'INSUFFICIENT_DATA'; }
  else if (!h24 || !h24.available) { available = false; availReason = `UNSYNCHRONIZED (${h24 ? h24.reason : 'NO_NETWORK'})`; }
  else if (cov.pairsUsed < cov.pairsExpected) { available = false; availReason = `INCOMPLETE_COVERAGE (${cov.pairsUsed}/${cov.pairsExpected})`; }

  const story = (w) => (w && w.descriptors ? { coveragePct: w.coveragePct, actual: w.actualCandles, nominal: w.nominalCandles, efficiency: w.descriptors.directionalEfficiency, direction: w.descriptors.direction, range: w.descriptors.range, positionInRange: w.descriptors.positionInRange } : null);
  const board = (h24 && h24.available) ? h24.effects.ranked.map((ccy) => ({ currency: ccy, x: h24.effects.byCurrency[ccy], breadth: h24.breadth[ccy] ? h24.breadth[ccy].fraction : 0 })) : null;
  const conf = (net.leaveOnePairOut && net.leaveOnePairOut.confirmations && net.leaveOnePairOut.confirmations[pair]) || null;
  const nc = nextConditionFor(c.primaryState, c.structure);

  return {
    candleIdx, asOfCloseMs: t, asOfCloseUtc: c.asOfCloseUtc, asOfCloseEat: c.asOfCloseEat,
    primaryState: c.primaryState, previousState: c.previousState, transition: c.transition,
    windows: c.windows,
    priceStories: { h12: story(pa.windows && pa.windows.h12), h24: story(pa.windows && pa.windows.h24), h36: story(pa.windows && pa.windows.h36), h48: story(pa.windows && pa.windows.h48) },
    compare12: pa.comparison ? { latestEff: pa.comparison.latest12.directionalEfficiency, previousEff: pa.comparison.previous12.directionalEfficiency, deltaEff: pa.comparison.deltaEfficiency, latestDir: pa.comparison.latest12.direction, previousDir: pa.comparison.previous12.direction } : null,
    strengthBoard: board,
    otherPairConfirmation: conf ? { full: conf.full ? conf.full.baseMinusQuote : null, leaveOut: conf.leaveOut ? conf.leaveOut.baseMinusQuote : null, agrees: conf.independentlyConfirmed, note: 'leave-one-pair-out = OTHER-PAIR confirmation (this pair excluded); not statistical independence.' } : null,
    events: (pa.events || []).map((e) => ({ ms: e.ms, utc: new Date(e.ms).toISOString(), type: e.type, evidence: e.evidence })),
    structure: { acceptedHold: c.structure.acceptedHold, acceptedHoldDir: c.structure.acceptedHoldDir, confirmedPivots: c.structure.confirmedPivots, lastPivot: c.structure.lastPivot, provisionalLeg: c.structure.provisionalLeg, rejection: c.structure.rejection },
    evidenceFor: (c.evidenceFor || []).map((e) => e.text),
    evidenceAgainst: (c.evidenceAgainst || []).map((e) => e.text),
    explanation: c.explanation,
    nextCondition: nc.nextCondition, invalidationReference: nc.invalidationReference, invalidationLevel: nc.invalidationLevel,
    extendedMove: extendedMoveFlag(pa),
    dataHealth: { available, reason: availReason, stale: staleBefore, closedMarket: closedMarket(t), aligned: !!(h24 && h24.available && cov.pairsUsed === cov.pairsExpected), pairsPresent: cov.pairsUsed, pairsExpected: cov.pairsExpected },
    calibrationVersion: c.calibration.version,
  };
}

function framesFor(pair, H, step = 2) {
  const candles = H[pair]; const frames = []; let prev = null;
  for (let i = 0; i < candles.length; i += step) { const t = candles[i].openMs + M15; const f = buildFrame(pair, H, t, prev, i); frames.push(f); prev = f.primaryState; }
  return { pair, candles: candles.map((c) => ({ openMs: c.openMs, open: c.open, high: c.high, low: c.low, close: c.close })), frames };
}

// shaped price fixtures
function uptrend(tEnd, n, perStep) { const cl = []; let p = 150.00; for (let i = 0; i < n; i++) { p += perStep; if (i % 7 === 6) p -= perStep * 0.4; cl.push(p); } return gen.seriesEndingAt(tEnd, cl, 0.03); }

function build() {
  const T = Date.UTC(2026, 8, 11, 0, 0, 0);           // weekday close (normal)
  const Tweekend = Date.UTC(2026, 8, 12, 21, 0, 0);    // Saturday → closed-market demo

  // Each scenario = its own coherent 28-pair background + an overridden watchlist pair.
  const dsDescent = gen.network(T, 192, { GBP: 0.03, EUR: -0.03 }, 'EUR_GBP', gen.eurgbpDescent(T));
  const dsShock = gen.network(T, 192, {}, 'GBP_AUD', gen.gbpaudShock(T));
  const dsConflict = gen.network(T, 192, { EUR: 0.03, USD: -0.03 }, 'EUR_USD', gen.eurgbpDescent(T).map((c) => ({ ...c })));  // price down, strength up
  const dsExtended = gen.network(T, 192, { AUD: 0.03, JPY: -0.03 }, 'AUD_JPY', uptrend(T, 192, 0.05));
  const dsClosed = gen.network(Tweekend, 192, { GBP: 0.02, NZD: -0.02 }, 'GBP_NZD', gen.eurgbpDescent(Tweekend).map((c) => ({ ...c })));

  // UNAVAILABLE demo: a pair with only a few candles (no network either).
  const nzdCadFew = gen.seriesEndingAt(T, [0.90, 0.9003, 0.9006]);

  const watchlist = [
    { ...framesFor('EUR_GBP', dsDescent), label: 'Accepted downtrend', scenario: 'descent' },
    { ...framesFor('GBP_AUD', dsShock), label: 'Shock → reversal', scenario: 'reversal' },
    { ...framesFor('EUR_USD', dsConflict), label: 'Price vs strength conflict', scenario: 'conflict' },
    { ...framesFor('AUD_JPY', dsExtended), label: 'Extended trend (up)', scenario: 'extended' },
    { ...framesFor('GBP_NZD', dsClosed), label: 'Closed-market (weekend)', scenario: 'closed' },
    { pair: 'NZD_CAD', label: 'Unavailable (insufficient data)', scenario: 'unavailable', candles: nzdCadFew.map((c) => ({ openMs: c.openMs, open: c.open, high: c.high, low: c.low, close: c.close })), frames: [buildFrame('NZD_CAD', { NZD_CAD: nzdCadFew }, nzdCadFew[nzdCadFew.length - 1].openMs + M15, null, nzdCadFew.length - 1)] },
  ];

  return {
    meta: {
      version: 'm15-workspace-1.0.0', classifier: CLASSIFIER_VERSION,
      provenance: 'SYNTHETIC', generatedFixtureCloseUtc: new Date(T).toISOString(),
      disclaimer: 'DEMO / SYNTHETIC — designed fixtures run through the real research modules. Not live, not market data, not a trading system and not validated for profitability.',
    },
    modelHealth: {
      status: 'UNVALIDATED',
      stage5: { decision: 'NONE PASSED', immutable: true, artifact: 'docs/research/audit/stage5_scorecard_CORRECTED.json' },
      infocontent: { verdicts: { H1: 'INSUFFICIENT_EVIDENCE', H2: 'INSUFFICIENT_EVIDENCE', H3: 'INSUFFICIENT_EVIDENCE' }, registrationHash: 'c5a26dd1582726d5267694e75397c9dea28c1d36f2df5265cf1698408e4dd6b6', economics: 'ESTIMATED (mid-only)', note: 'No tradable edge demonstrated. No profitability or confidence probability is shown anywhere.' },
    },
    watchlist,
  };
}

function writeOut(payload) {
  const uiDir = path.join(__dirname, '..', '..', 'research', 'ui', 'workspace');
  const docDir = path.join(__dirname, '..', '..', 'docs', 'research', 'workspace');
  fs.mkdirSync(uiDir, { recursive: true }); fs.mkdirSync(docDir, { recursive: true });
  const json = JSON.stringify(payload);
  fs.writeFileSync(path.join(uiDir, 'fixtures.js'), `/* generated by scripts/research/build-workspace-fixtures.js — DEMO/SYNTHETIC */\nwindow.NFX_FIXTURES = ${json};\n`);
  fs.writeFileSync(path.join(docDir, 'fixtures.json'), json);
}

if (require.main === module) {
  const payload = build();
  writeOut(payload);
  console.log('workspace fixtures:', payload.watchlist.map((w) => `${w.pair}:${w.frames.length}f`).join(', '));
}

module.exports = { build, buildFrame, framesFor, closedMarket, nextConditionFor };
