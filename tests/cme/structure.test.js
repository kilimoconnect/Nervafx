'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  detectH1BreakOfStructure, calculatePairStructureScore, currencyDirFromPair,
  aggregateCurrencyStructure, currencyStructureScore, classifyStructureAgreement,
  confirmedMovementScore, classifyMicroAgreement,
} = require('../../api/_cme-structure');

const ATR = 0.0010;
const c = (o, h, l, cl) => ({ open: o, high: h, low: l, close: cl });
const prev = c(1.09950, 1.10000, 1.09900, 1.09960); // prevHigh 1.10000, prevLow 1.09900

// 1–6 direction / wick / equality
test('bullish BOS: close above previous high', () => {
  const b = detectH1BreakOfStructure(c(1.09990, 1.10040, 1.09985, 1.10030), prev, ATR);
  assert.equal(b.direction, 'BULLISH'); assert.equal(b.breakType, 'CLOSE_BREAK'); assert.equal(b.brokenLevel, 1.10000);
});
test('bearish BOS: close below previous low', () => {
  const b = detectH1BreakOfStructure(c(1.09950, 1.09960, 1.09850, 1.09870), prev, ATR);
  assert.equal(b.direction, 'BEARISH'); assert.equal(b.breakType, 'CLOSE_BREAK'); assert.equal(b.brokenLevel, 1.09900);
});
test('wick above previous high but close below → WICK_REJECTION (not bullish)', () => {
  const b = detectH1BreakOfStructure(c(1.09980, 1.10030, 1.09970, 1.09995), prev, ATR); // high>1.10000, close<1.10000
  assert.equal(b.direction, 'NONE'); assert.equal(b.breakType, 'WICK_REJECTION');
});
test('wick below previous low but close above → WICK_REJECTION (not bearish)', () => {
  const b = detectH1BreakOfStructure(c(1.09950, 1.09960, 1.09880, 1.09910), prev, ATR); // low<1.09900, close>1.09900
  assert.equal(b.direction, 'NONE'); assert.equal(b.breakType, 'WICK_REJECTION');
});
test('close exactly equal to previous high → NO break', () => {
  const b = detectH1BreakOfStructure(c(1.09980, 1.10000, 1.09970, 1.10000), prev, ATR);
  assert.equal(b.direction, 'NONE');
});
test('close exactly equal to previous low → NO break', () => {
  const b = detectH1BreakOfStructure(c(1.09950, 1.09960, 1.09880, 1.09900), prev, ATR);
  assert.equal(b.direction, 'NONE');
});

// 7–8 distance + grade boundaries
test('break distance ATR and grade boundaries (0.10 / 0.30 / 0.70 / 1.20)', () => {
  const grade = (k) => detectH1BreakOfStructure(c(1.09990, 1.10000 + k * ATR + 0.00002, 1.09985, 1.10000 + k * ATR), prev, ATR);
  assert.equal(grade(0.05).strengthGrade, 'MARGINAL');
  assert.equal(grade(0.10).strengthGrade, 'WEAK');
  assert.equal(grade(0.30).strengthGrade, 'STRONG');
  assert.equal(grade(0.30).decisiveBreak, true);
  assert.equal(grade(0.20).decisiveBreak, false);
  assert.equal(grade(0.70).strengthGrade, 'VERY_STRONG');
  assert.equal(grade(1.20).strengthGrade, 'EXPLOSIVE');
  assert.ok(Math.abs(grade(0.30).breakDistanceATR - 0.30) < 1e-6);
});

// 9–10 close quality + zero range
test('close quality: bullish toward high, bearish toward low; clamped', () => {
  const bull = detectH1BreakOfStructure(c(1.09990, 1.10050, 1.09990, 1.10048), prev, ATR); // close near high
  assert.ok(bull.closeQuality >= 0.9);
  const bear = detectH1BreakOfStructure(c(1.09950, 1.09960, 1.09850, 1.09852), prev, ATR); // close near low
  assert.ok(bear.closeQuality >= 0.9);
});
test('zero-range candle is safe (closeQuality 0)', () => {
  const b = detectH1BreakOfStructure(c(1.10050, 1.10050, 1.10050, 1.10050), prev, ATR);
  assert.equal(b.closeQuality, 0);
  assert.equal(calculatePairStructureScore({ direction: 'NONE', breakType: 'NO_BREAK' }), 0);
});

// 11–12 orientation
test('base currency keeps pair direction; quote inverts', () => {
  assert.equal(currencyDirFromPair('EUR_USD', 'EUR', 'BULLISH'), 'BULLISH');
  assert.equal(currencyDirFromPair('EUR_USD', 'USD', 'BULLISH'), 'BEARISH');
  assert.equal(currencyDirFromPair('EUR_USD', 'EUR', 'BEARISH'), 'BEARISH');
  assert.equal(currencyDirFromPair('EUR_USD', 'USD', 'BEARISH'), 'BULLISH');
});

// 13–15 currency breadth / coverage / mixed
function entry(pair, dir, decisive) { return { pair, bos: { direction: dir, breakType: dir === 'NONE' ? 'NO_BREAK' : 'CLOSE_BREAK', decisiveBreak: !!decisive }, score: decisive ? 80 : 40 }; }
test('currency structure breadth across seven pairs', () => {
  const entries = [ // USD as base in these; bullish USD pairs → USD bullish
    entry('USD_JPY', 'BULLISH', true), entry('USD_CHF', 'BULLISH', true), entry('USD_CAD', 'BULLISH', true), entry('USD_...' , 'NONE'),
    { pair: 'EUR_USD', bos: { direction: 'BEARISH', breakType: 'CLOSE_BREAK', decisiveBreak: true }, score: 80 }, // EUR/USD bearish → USD bullish
    entry('AUD_USD', 'NONE'), entry('GBP_USD', 'NONE'),
  ].map((e) => (e.pair === 'USD_...' ? entry('USD_AUD', 'NONE') : e));
  const agg = aggregateCurrencyStructure('USD', entries);
  assert.equal(agg.availablePairCount, 7);
  assert.equal(agg.decisiveBullishBreakCount, 4);   // 3 USD-base + 1 EUR/USD bearish
  assert.equal(agg.classification, 'BROAD_STRUCTURE');
  assert.ok(agg.bullishStructureBreadth > 0.5);
  const ss = currencyStructureScore(agg, +1);
  assert.equal(ss.structureDirection, 'BULLISH');
  assert.ok(ss.structureScore > 0 && ss.structureScore <= 100);
});
test('missing-pair coverage is reduced', () => {
  const agg = aggregateCurrencyStructure('USD', [entry('USD_JPY', 'BULLISH', true), entry('USD_CHF', 'BULLISH', true)]);
  assert.equal(agg.availablePairCount, 2);
  assert.ok(agg.coverage < 1);
});
test('mixed bullish+bearish decisive → MIXED_STRUCTURE', () => {
  const agg = aggregateCurrencyStructure('USD', [entry('USD_JPY', 'BULLISH', true), { pair: 'USD_CHF', bos: { direction: 'BEARISH', breakType: 'CLOSE_BREAK', decisiveBreak: true }, score: 80 }]);
  assert.equal(agg.classification, 'MIXED_STRUCTURE');
});

// 16–18 agreement
test('structure agreement classes', () => {
  const broadBull = aggregateCurrencyStructure('USD', [entry('USD_JPY', 'BULLISH', true), entry('USD_CHF', 'BULLISH', true)]);
  assert.equal(classifyStructureAgreement(50, broadBull), 'STRUCTURE_CONFIRMED');
  assert.equal(classifyStructureAgreement(-50, broadBull), 'STRUCTURE_CONFLICT');   // move down, structure up
  const none = aggregateCurrencyStructure('USD', [entry('USD_JPY', 'NONE'), entry('USD_CHF', 'NONE')]);
  assert.equal(classifyStructureAgreement(50, none), 'MOVEMENT_WITHOUT_STRUCTURE');
  const oneBull = aggregateCurrencyStructure('USD', [entry('USD_JPY', 'BULLISH', true), entry('USD_CHF', 'NONE')]);
  assert.equal(classifyStructureAgreement(10, oneBull), 'STRUCTURE_LEADS_MOVEMENT'); // decisive but weak move
  assert.equal(classifyStructureAgreement(0, none), 'NEUTRAL');
});
test('confirmedMovementScore blends and re-signs', () => {
  assert.equal(confirmedMovementScore(60, 80), Math.round((0.7 * 60 + 0.3 * 80) * 10) / 10);
  assert.ok(confirmedMovementScore(-60, 80) < 0);
});

// 19–21 micro
test('micro confirms / diverges / leads / unavailable', () => {
  assert.equal(classifyMicroAgreement('BULLISH', 'BULLISH', 2), 'MICRO_CONFIRMS_H1');
  assert.equal(classifyMicroAgreement('BULLISH', 'BEARISH', 2), 'MICRO_DIVERGES_FROM_H1');
  assert.equal(classifyMicroAgreement('NONE', 'BULLISH', 2), 'MICRO_LEADS_H1');
  assert.equal(classifyMicroAgreement('BULLISH', null, 0), 'MICRO_UNAVAILABLE');
});
