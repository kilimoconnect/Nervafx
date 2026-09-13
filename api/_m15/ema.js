'use strict';

/**
 * M15 Intelligence — EMA behaviour engine (§17).
 *
 * EMA20 and EMA50 are the only explicit indicators permitted (§6). This engine
 * describes their BEHAVIOUR — price location, slopes, slope acceleration,
 * separation and its expansion, distance/acceptance, compression, EARLY
 * transition and overextension — and classifies a state. It deliberately does
 * NOT wait for an EMA20/EMA50 crossover to flag an early turn, and it never
 * emits a trade signal: EMA behaviour is supporting evidence only (§17, §21).
 *
 * Pure & no-lookahead. Slopes are volatility-normalized for cross-pair use.
 */

const { CONFIG } = require('./config');
const { emaPair } = require('./equilibrium');
const { volatilitySeries, alphaFromHalfLife, clamp } = require('./math');
const { pipSize } = require('./pairs');

function evaluateEMA(candles, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const pair = opts.pair || 'EUR_USD';
  const e = cfg.ema;
  const n = candles.length;
  if (n < e.slow + 2) return { pair, state: 'FLAT', insufficient: true };

  const { ema20, ema50 } = emaPair(candles, cfg);
  const vol = volatilitySeries(candles, cfg.volatility.trHalfLifeCandles);
  const volNow = vol[n - 1] || pipSize(pair);
  const price = candles[n - 1].close;

  // Volatility-normalized slopes (EWMA of first differences) and slope accel.
  const aSlope = alphaFromHalfLife(cfg.volatility.fastHalfLifeCandles);
  let s20 = 0, s50 = 0, s20prev = 0, s20accel = 0;
  for (let i = 1; i < n; i++) {
    s20prev = s20;
    s20 += aSlope * ((ema20[i] - ema20[i - 1]) - s20);
    s50 += aSlope * ((ema50[i] - ema50[i - 1]) - s50);
    s20accel += aSlope * ((s20 - s20prev) - s20accel);
  }
  const slope20 = s20 / volNow;                 // per-candle slope in vol units
  const slope50 = s50 / volNow;
  const slopeAccel = s20accel / volNow;

  const sep = ema20[n - 1] - ema50[n - 1];
  const sepVol = sep / volNow;
  // Separation expansion: EWMA of Δ|sep|, normalized.
  let sepExp = 0; { let prevAbs = Math.abs(ema20[0] - ema50[0]);
    for (let i = 1; i < n; i++) { const a = Math.abs(ema20[i] - ema50[i]); sepExp += aSlope * ((a - prevAbs) - sepExp); prevAbs = a; } }
  const separationExpanding = sepExp / volNow > 0.01;
  const distFromEma20Vol = (price - ema20[n - 1]) / volNow;

  const flatEps = e.slopeEpsilonVolMult;
  const compressed = Math.abs(sepVol) < e.compressedSepVolMult;
  const state = classify({ sepVol, slope20, slope50, slopeAccel, distFromEma20Vol, compressed, flatEps, e });

  return {
    pair, state,
    priceVsEma20: price > ema20[n - 1] ? 'ABOVE' : 'BELOW',
    priceVsEma50: price > ema50[n - 1] ? 'ABOVE' : 'BELOW',
    slope20: +slope20.toFixed(4), slope50: +slope50.toFixed(4), slopeAccel: +slopeAccel.toFixed(4),
    separation: +sep.toFixed(6), separationVol: +sepVol.toFixed(3), separationExpanding,
    distanceFromEma20Vol: +distFromEma20Vol.toFixed(3),
    compressed,
    ema20: ema20[n - 1], ema50: ema50[n - 1],
    // NOTE: intentionally no signal/entry field — EMA is supporting evidence only.
  };
}

function classify({ sepVol, slope20, slope50, slopeAccel, distFromEma20Vol, compressed, flatEps, e }) {
  const up = slope20 > flatEps, down = slope20 < -flatEps;
  const bothFlat = Math.abs(slope20) <= flatEps && Math.abs(slope50) <= flatEps;

  // Overextension first — a mature move far from EMA20 (§17, §22 upstream).
  if (distFromEma20Vol > e.overextendedDistVolMult && sepVol > 0) return 'BULLISH_OVEREXTENDED';
  if (distFromEma20Vol < -e.overextendedDistVolMult && sepVol < 0) return 'BEARISH_OVEREXTENDED';

  if (compressed && bothFlat) return 'COMPRESSED';
  if (bothFlat) return 'FLAT';

  // EARLY turn BEFORE crossover: EMA20 turning against the current separation
  // (EMA50 still leaning the old way is EXPECTED here — that is the early turn,
  // not a conflict), so this is evaluated before the CONFLICTED check (§17).
  if (sepVol <= 0 && up && slopeAccel > 0) return 'EARLY_BULLISH_TURN';
  if (sepVol >= 0 && down && slopeAccel < 0) return 'EARLY_BEARISH_TURN';

  // Conflicted: EMAs pulling opposite ways without a clean early-turn reading.
  if (slope20 > flatEps && slope50 < -flatEps) return 'CONFLICTED';
  if (slope20 < -flatEps && slope50 > flatEps) return 'CONFLICTED';

  // Established vs developing once separation confirms direction.
  if (sepVol > 0 && up) return sepVol > e.compressedSepVolMult * 2 ? 'BULLISH_ESTABLISHED' : 'BULLISH_DEVELOPING';
  if (sepVol < 0 && down) return sepVol < -e.compressedSepVolMult * 2 ? 'BEARISH_ESTABLISHED' : 'BEARISH_DEVELOPING';

  return compressed ? 'COMPRESSED' : 'FLAT';
}

module.exports = { evaluateEMA };
