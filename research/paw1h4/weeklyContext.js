'use strict';

/**
 * Weekly MARKET CONTEXT for the multi-approach W1→H4 engine (CONTEXT_VERSION below).
 *
 * Causal, price-action only. From COMPLETED weekly candles knowable at the H4
 * assessment time it derives:
 *   • the confirmed weekly swing structure + trend (reuses weeklyTrend.js),
 *   • an established weekly BALANCE area (upper/lower boundary + midpoint) when one
 *     exists — distinct from an unclear/absent trend; NEUTRAL alone is NOT a balance,
 *   • the confirmed structural levels (weekly swing highs/lows) and when each became
 *     knowable,
 *   • the current H4 price's structural LOCATION relative to those references,
 *   • supporting / conflicting / missing evidence.
 *
 * Trend and balance can COEXIST (a contained range inside a larger trend); we report
 * both and describe the relationship rather than forcing one exclusive label.
 *
 * Current-week H4 candles may interact with these weekly references but NEVER change
 * the completed weekly assessment, and are never called a completed weekly breakout.
 */

const agg = require('./aggregate');
const { buildWeeklyContext } = require('./weeklyTrend');
const { confirmedAsOf } = require('./swings');
const { pipSize } = require('./config');

const CONTEXT_VERSION = 'w1h4-context-1.0.0';

// Research v1 thresholds (documented a priori; NOT tuned on returns).
const BALANCE = {
  minClosesInside: 2,     // completed weekly closes within [lower,upper] after both boundaries knowable
  minWidthPips: 10,       // ignore degenerate near-zero bands
};

function median(xs) { if (!xs.length) return 0; const a = xs.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function medAbsDelta(closes) { const d = []; for (let i = 1; i < closes.length; i++) d.push(Math.abs(closes[i] - closes[i - 1])); return median(d); }
const iso = (ms) => (ms == null || !isFinite(ms) ? null : new Date(ms).toISOString());

// Timeframe descriptor: trend TF (W1 or D1) + entry TF (H4 or H1) + display names.
const MTF_W1H4 = { trend: (h1, a) => agg.w1(h1, a), entry: (h1, a) => agg.h4(h1, a), trendName: 'weekly', entryName: 'H4', trendLabel: 'W1', entryLabel: 'H4' };
const MTF_D1H1 = { trend: (h1, a) => agg.d1(h1, a), entry: (h1, a) => agg.h1AsOf(h1, a), trendName: 'daily', entryName: 'H1', trendLabel: 'D1', entryLabel: 'H1' };

/**
 * @param h1      raw H1 candles for one pair
 * @param asOfMs  assessment time (causal)
 * @param cfg     strategy config (uses cfg.swing, cfg.execution)
 * @param pair    instrument (for pip size)
 * @param mtf     timeframe descriptor (trend/entry aggregators + names); default W1→H4
 */
function buildMarketContext(h1, asOfMs, cfg, pair, mtf) {
  mtf = mtf || MTF_W1H4;
  const TN = mtf.trendName, EN = mtf.entryName;
  const pip = pipSize(pair || cfg.pair || 'EUR_USD');
  const w1 = mtf.trend(h1, asOfMs);   // trend-TF candles (W1 or D1)
  const h4 = mtf.entry(h1, asOfMs);   // entry-TF candles (H4 or H1)
  const trend = buildWeeklyContext(w1, cfg.swing);
  const bias = trend.biasAt(asOfMs);
  const conf = confirmedAsOf(trend.pivots, asOfMs);
  const highs = conf.filter((p) => p.type === 'HIGH');
  const lows = conf.filter((p) => p.type === 'LOW');

  // ── Weekly balance area ────────────────────────────────────────────────────
  // Boundaries = the most recent confirmed weekly swing HIGH (upper) and LOW (lower).
  // A balance is CONFIRMED only when ≥ minClosesInside completed weekly closes sit
  // within [lower, upper] AFTER both boundaries became knowable (contained range).
  let balance = null;
  if (highs.length && lows.length) {
    const up = highs[highs.length - 1], lo = lows[lows.length - 1];
    const upper = up.price, lower = lo.price;
    if (upper - lower >= BALANCE.minWidthPips * pip) {
      const knownMs = Math.max(up.confirmedAtMs, lo.confirmedAtMs);   // balance fully knowable once the later boundary confirms
      const spanStart = Math.min(up.extremeTimeMs, lo.extremeTimeMs); // oscillation that forms the balance begins at the earlier boundary
      const width = upper - lower;
      // Completed weekly closes over the formation span (all ≤ asOf, both boundaries
      // confirmed by asOf → causal). We never use a forming weekly candle.
      const inside = w1.filter((c) => c.closeMs > spanStart && c.closeMs <= asOfMs && c.close >= lower && c.close <= upper);
      // A balance requires OSCILLATION, not a one-way pass: contained closes that reach
      // BOTH halves AND cross the midpoint at least twice (back and forth). A trend
      // crosses the band once and is therefore not called a balance.
      const mid = (upper + lower) / 2;
      const touchedUpperHalf = inside.some((c) => c.close >= lower + width * 0.6);
      const touchedLowerHalf = inside.some((c) => c.close <= lower + width * 0.4);
      let crossings = 0; for (let k = 1; k < inside.length; k++) { if (Math.sign(inside[k].close - mid) !== Math.sign(inside[k - 1].close - mid) && inside[k].close !== mid && inside[k - 1].close !== mid) crossings++; }
      const confirmed = inside.length >= BALANCE.minClosesInside && touchedUpperHalf && touchedLowerHalf && crossings >= 2;
      balance = {
        confirmed, upper, lower, mid: +((upper + lower) / 2).toFixed(8), widthPips: +((width / pip)).toFixed(1),
        upperKnownUtc: iso(up.confirmedAtMs), lowerKnownUtc: iso(lo.confirmedAtMs), establishedUtc: iso(knownMs),
        closesInside: inside.length,
        crossings,
        reason: confirmed ? 'established weekly balance (closes oscillate across both boundaries)'
          : (inside.length < BALANCE.minClosesInside ? `only ${inside.length} contained weekly close(s)` : (crossings < 2 ? 'one-way through the band — a trend, not a balance' : 'contained closes did not reach both boundaries')),
      };
    }
  }

  // ── Structural location of the latest completed H4 close ───────────────────
  const lastH4 = h4.length ? h4[h4.length - 1] : null;
  const px = lastH4 ? lastH4.close : null;
  // Proximity buffer: an H4 adaptive scale (median |Δclose| over last 24 H4) with a
  // floor of the execution buffer; handles zero/flat scale by falling back to the floor.
  const h4Scale = h4.length > 2 ? medAbsDelta(h4.slice(-24).map((c) => c.close)) : 0;
  const buffer = Math.max(h4Scale, (cfg.execution.bufferPips || 2) * pip);

  let location = { zone: 'NO_BALANCE', buffer: +(buffer / pip).toFixed(1) };
  if (balance && px != null) {
    const { upper, lower } = balance;
    let zone;
    if (Math.abs(px - upper) <= buffer) zone = 'AT_UPPER';
    else if (Math.abs(px - lower) <= buffer) zone = 'AT_LOWER';
    else if (px > upper) zone = 'ABOVE_UPPER';
    else if (px < lower) zone = 'BELOW_LOWER';
    else zone = 'INSIDE';
    const midBand = balance.widthPips * 0.25;   // "middle of range" = within 25% of width of mid
    const inMiddle = Math.abs((px - balance.mid) / pip) <= midBand;
    location = {
      zone, inMiddle, buffer: +(buffer / pip).toFixed(1),
      h4Close: px, h4CloseUtc: iso(lastH4.closeMs),
      distToUpperPips: +(((upper - px) / pip)).toFixed(1),
      distToLowerPips: +(((px - lower) / pip)).toFixed(1),
    };
  } else if (px != null) {
    const nearHigh = highs.length ? highs[highs.length - 1].price : null;
    const nearLow = lows.length ? lows[lows.length - 1].price : null;
    location = { zone: 'NO_BALANCE', buffer: +(buffer / pip).toFixed(1), h4Close: px, h4CloseUtc: iso(lastH4.closeMs), nearestHigh: nearHigh, nearestLow: nearLow };
  }

  // ── Evidence ────────────────────────────────────────────────────────────────
  const cap = TN.charAt(0).toUpperCase() + TN.slice(1);
  const supporting = [], conflicting = [], missing = [];
  if (bias.bias === 'BULLISH' || bias.bias === 'BEARISH') supporting.push(`${cap} trend ${bias.bias} (confirmed structure).`);
  if (balance && balance.confirmed) supporting.push(`Established ${TN} balance ${balance.lower}–${balance.upper} (${balance.closesInside} contained closes).`);
  if (bias.bias === 'NEUTRAL' && !(balance && balance.confirmed)) conflicting.push(`${cap} structure NEUTRAL but no established balance — range is NOT demonstrated.`);
  if ((bias.bias === 'BULLISH' || bias.bias === 'BEARISH') && balance && balance.confirmed) supporting.push('Trend and a local balance coexist — treat the balance as a staging area within the trend.');
  if (!highs.length || !lows.length) missing.push(`Insufficient confirmed ${TN} swings for boundaries.`);
  if (!lastH4) missing.push(`No completed ${EN} candle at the assessment time.`);

  return {
    version: CONTEXT_VERSION, pair: pair || cfg.pair || null, asOfUtc: iso(asOfMs),
    trendLabel: mtf.trendLabel, entryLabel: mtf.entryLabel,
    trend: { bias: bias.bias, eligibilityStartUtc: iso(bias.eligibilityStartMs), invalidationLevel: bias.invalidationLevel },
    balance, location,
    references: {
      structuralHighs: highs.map((p) => ({ price: p.price, knownUtc: iso(p.confirmedAtMs) })),
      structuralLows: lows.map((p) => ({ price: p.price, knownUtc: iso(p.confirmedAtMs) })),
    },
    evidence: { supporting, conflicting, missing },
    // handles for the approach detectors (not serialized to the client directly)
    _internal: { w1, h4, trend, conf, highs, lows, bias, pip, buffer, trendName: TN, entryName: EN },
  };
}

module.exports = { buildMarketContext, CONTEXT_VERSION, BALANCE, MTF_W1H4, MTF_D1H1 };
