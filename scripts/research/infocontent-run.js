'use strict';

/**
 * Stage E driver — runs the FROZEN information-content evaluation on the available data.
 *
 * No real held-out market data (and no bid/ask) is available in this environment, so the
 * run uses SYNTHETIC fixtures and is labelled SYNTHETIC_EXPLORATORY with ESTIMATED
 * economics. Per the registered gates this provenance can only yield INSUFFICIENT_EVIDENCE
 * — the run exercises the full pipeline and proves NONE PASSED is preserved. It writes:
 *   docs/research/infocontent/report.json  (+ hashes)
 * Nothing is pushed/deployed; no live signals/scheduler/broker.
 *   node scripts/research/infocontent-run.js
 */

const fs = require('fs');
const path = require('path');
const { classify } = require('../../research/m15/classifier');
const { describeNetwork } = require('../../research/m15/strengthnet');
const { describePriceAction } = require('../../research/m15/priceaction');
const { evaluate, registrationHash } = require('../../research/m15/infocontent');
const gen = require('./build-replay');

const M15 = 15 * 60 * 1000;

function framesFor(pair, H, step = 3) {
  const candles = H[pair]; const frames = []; let prevCloseMs = 0;
  for (let i = 0; i < candles.length; i += step) {
    const t = candles[i].openMs + M15;
    const net = describeNetwork(H, { asOfCloseMs: t });
    const r = classify(pair, H, { asOfCloseMs: t, network: net });
    const rPO = classify(pair, { [pair]: candles }, { asOfCloseMs: t });     // price-only (no network)
    const pa = describePriceAction(candles, { pair, asOfCloseMs: t });
    const newEvents = (pa.events || []).filter((e) => e.ms > prevCloseMs && e.ms <= t);
    frames.push({ candleIdx: i, asOfCloseMs: t, primaryState: r.primaryState, priceOnlyState: rPO.primaryState, confirmed: !!(r.strength && r.strength.independentlyConfirmed), newEvents });
    prevCloseMs = t;
  }
  return { pair, candles, frames };
}

function build() {
  const T = Date.UTC(2026, 8, 11, 0, 0, 0);
  const descent = gen.network(T, 192, { GBP: 0.03, EUR: -0.03 }, 'EUR_GBP', gen.eurgbpDescent(T));
  const shock = gen.network(T, 192, {}, 'GBP_AUD', gen.gbpaudShock(T));
  const mild = gen.network(T, 192, { EUR: 0.012, USD: -0.012 }, 'EUR_USD', gen.mkPair(T, 192, 0.012));
  return [framesFor('EUR_GBP', descent), framesFor('GBP_AUD', shock), framesFor('EUR_USD', mild)];
}

if (require.main === module) {
  const perPair = build();
  // ESTIMATED spread (mid-only): 1 pip in price units, charged once.
  const report = evaluate(perPair, { provenance: 'SYNTHETIC_EXPLORATORY', horizon: 8, scenario: { spread: 0.0001, delay: 0 } });
  const dir = path.join(__dirname, '..', '..', 'docs', 'research', 'infocontent');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  const summary = { verdicts: Object.fromEntries(Object.entries(report.hypotheses).map(([k, v]) => [k, v.verdict])), registrationHash, dataHash: report.dataHash, provenance: report.provenance, economics: report.economics, stage5: report.stage5Preserved.decision };
  fs.writeFileSync(path.join(dir, 'report.summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

module.exports = { build, framesFor };
