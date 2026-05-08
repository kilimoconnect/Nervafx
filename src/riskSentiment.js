/**
 * Risk Sentiment Engine — Phase 9
 *
 * Answers: "Is the environment supportive for continuation trading?"
 *
 * Sources:
 *   OANDA candles  → SPX500_USD, NAS100_USD, XAU_USD, BCO_USD
 *   Existing DB    → currency_strength (USD, JPY, CHF smooth values)
 *   Existing DB    → pair_strength_spreads (AUD_JPY, NZD_JPY spread_6h)
 *
 * Pipeline per run:
 *   1. Fetch raw component values
 *   2. Compute raw scores  (-100..+100)
 *   3. Apply EMA smoothing (α=0.45) using previous row  ← stops hourly flipping
 *   4. Compute nuanced oil score  (context-aware, not just direction)
 *   5. Detect acceleration / stress environment
 *   6. Weighted net score → RISK_ON / RISK_OFF / NEUTRAL
 *   7. Upsert to risk_sentiment table
 */

const { supabase } = require('./supabase');
const { fetchAndParseCandles, sleep, RATE_LIMIT_DELAY } = require('./oanda');

// ─── Instruments ─────────────────────────────────────────────────────────────
const RISK_CANDLE_INSTRUMENTS = [
  'SPX500_USD',  // S&P 500
  'NAS100_USD',  // NASDAQ 100
  'XAU_USD',     // Gold spot
  'BCO_USD',     // Brent Crude Oil
];

// ─── Normalization caps ───────────────────────────────────────────────────────
const CAPS = {
  equity: 1.5,    // ±1.5% 12/24H smoothed momentum for equity indices
  gold:   1.0,    // ±1.0% smoothed momentum for gold
  oil:    2.0,    // ±2.0% raw 12H momentum for oil (before context adjustment)
  jpy:    0.020,  // smooth_6h strength units for JPY
  chf:    0.015,  // smooth_6h strength units for CHF
  usd:    0.020,  // smooth_6h strength units for USD
  audjpy: 0.020,  // spread_6h pair strength spread
  nzdjpy: 0.020,
  accel:  0.40,   // % per H acceleration cap for price instruments
};

// ─── Weights (must sum to 1.0) ────────────────────────────────────────────────
// Source: user-specified final weight table
const WEIGHTS = {
  equity:  0.25,  // SPX500 + NAS100 composite
  jpy:     0.18,  // JPY safe-haven (inverted)
  chf:     0.12,  // CHF safe-haven (inverted)
  gold:    0.15,  // Gold (inverted)
  oil:     0.06,  // Brent Crude (context-aware)
  audjpy:  0.10,  // AUD/JPY carry barometer
  nzdjpy:  0.07,  // NZD/JPY carry barometer
  usd:     0.07,  // USD pressure / liquidity stress (inverted)
};
// Total: 0.25+0.18+0.12+0.15+0.06+0.10+0.07+0.07 = 1.00 ✓

// EMA smoothing factor: 0.45 new + 0.55 previous
// Gives ~55% weight to history, prevents hourly signal flipping
const EMA_ALPHA = 0.45;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function norm(value, cap) {
  if (!cap || value == null || isNaN(value)) return 0;
  return Math.round(Math.max(-100, Math.min(100, (value / cap) * 100)));
}

// Percent change from n candles ago
function momentumN(candles, n) {
  if (!candles || candles.length < n + 1) return null;
  const sorted = [...candles].sort((a, b) => (a.time < b.time ? -1 : 1));
  const cur  = sorted[sorted.length - 1].close;
  const prev = sorted[sorted.length - 1 - n].close;
  if (!prev) return null;
  return (cur - prev) / prev * 100;
}

// Smoothed momentum: 60% × 12H + 40% × 24H
// Reduces impact of single-hour spikes vs a pure 12H window
function smoothedMomentum(candles) {
  const m12 = momentumN(candles, 12);
  const m24 = momentumN(candles, 24);
  if (m12 == null && m24 == null) return null;
  if (m12 == null) return m24;
  if (m24 == null) return m12;
  return m12 * 0.60 + m24 * 0.40;
}

// Acceleration: how fast is the move vs its own recent average?
// Returns % per H above/below the expected rate derived from 12H window.
// Positive = accelerating, Negative = decelerating/reversing
function calcAcceleration(candles) {
  const m3  = momentumN(candles, 3);
  const m12 = momentumN(candles, 12);
  if (m3 == null || m12 == null) return null;
  const avgRate3h = m12 / 4; // 12H pace expressed as a 3H equivalent
  return m3 - avgRate3h;
}

// Average two nullable scores (ignores nulls)
function avg2(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return b;
  if (b == null) return a;
  return Math.round((a + b) / 2);
}

// EMA smooth: blend raw score with previous row's value for the same field
function emaSmooth(raw, prev, field) {
  if (prev == null || prev[field] == null) return raw;
  return Math.round(EMA_ALPHA * raw + (1 - EMA_ALPHA) * prev[field]);
}

// ─── Data fetchers ────────────────────────────────────────────────────────────

async function fetchRiskCandles() {
  const result = {};
  for (const instrument of RISK_CANDLE_INSTRUMENTS) {
    try {
      // Need 25 candles: 24 periods for smoothedMomentum + 3 for acceleration
      const candles = await fetchAndParseCandles(instrument, { count: 27 });
      result[instrument] = candles;
      console.log(`[SENTIMENT] ${instrument}: ${candles.length} candles`);
    } catch (err) {
      console.warn(`[SENTIMENT] ${instrument} unavailable: ${err.message}`);
      result[instrument] = [];
    }
    await sleep(RATE_LIMIT_DELAY);
  }
  return result;
}

async function getLatestStrength() {
  // USD now included for pressure score
  const { data, error } = await supabase
    .from('currency_strength')
    .select('currency, smooth_3h, smooth_6h, smooth_12h, time')
    .in('currency', ['USD', 'JPY', 'CHF', 'AUD', 'NZD'])
    .not('smooth_6h', 'is', null)
    .order('time', { ascending: false })
    .limit(25); // 5 currencies × recent rows

  if (error) throw new Error(`Strength fetch error: ${error.message}`);

  const latest = {};
  for (const row of data || []) {
    if (!latest[row.currency]) {
      latest[row.currency] = {
        s3h:  parseFloat(row.smooth_3h  || 0),
        s6h:  parseFloat(row.smooth_6h  || 0),
        s12h: parseFloat(row.smooth_12h || 0),
      };
    }
  }
  return latest;
}

async function getLatestSpreads() {
  const { data, error } = await supabase
    .from('pair_strength_spreads')
    .select('instrument, spread_6h, time')
    .in('instrument', ['AUD_JPY', 'NZD_JPY'])
    .order('time', { ascending: false })
    .limit(10);

  if (error) throw new Error(`Spreads fetch error: ${error.message}`);

  const latest = {};
  for (const row of data || []) {
    if (!latest[row.instrument]) latest[row.instrument] = parseFloat(row.spread_6h);
  }
  return latest;
}

// Fetch the most recent completed sentiment row for EMA smoothing
async function getPreviousSentiment() {
  const { data } = await supabase
    .from('risk_sentiment')
    .select('equity_score, jpy_score, chf_score, gold_score, oil_score, usd_score, audjpy_score, nzdjpy_score')
    .order('time', { ascending: false })
    .limit(1);
  return data?.[0] || null;
}

// ─── Main calculation ─────────────────────────────────────────────────────────
async function calculateLatestSentiment() {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const time = now.toISOString();

  // Fetch all inputs in parallel
  const [riskCandles, strength, spreads, prevSentiment] = await Promise.all([
    fetchRiskCandles(),
    getLatestStrength(),
    getLatestSpreads(),
    getPreviousSentiment(),
  ]);

  const spxCandles = riskCandles['SPX500_USD'] || [];
  const nasCandles = riskCandles['NAS100_USD'] || [];
  const goldCandles = riskCandles['XAU_USD']   || [];
  const oilCandles  = riskCandles['BCO_USD']   || [];

  // ─── Raw component scores ─────────────────────────────────────────────────

  // 1. Equity — smoothed 12/24H momentum, rising = risk on
  const spxMom = smoothedMomentum(spxCandles);
  const nasMom = smoothedMomentum(nasCandles);
  const rawEquity = avg2(
    spxMom != null ? norm(spxMom, CAPS.equity) : null,
    nasMom != null ? norm(nasMom, CAPS.equity) : null,
  );

  // 2. JPY — safe-haven inverted: JPY strong = risk off (negative score)
  const jpyData  = strength['JPY'];
  const rawJpy   = jpyData ? norm(-jpyData.s6h, CAPS.jpy) : 0;

  // 3. CHF — safe-haven inverted: CHF strong = risk off
  const chfData  = strength['CHF'];
  const rawChf   = chfData ? norm(-chfData.s6h, CAPS.chf) : 0;

  // 4. Gold — inverted: gold rising = safe-haven demand = risk off
  const goldMom  = smoothedMomentum(goldCandles);
  const rawGold  = goldMom != null ? norm(-goldMom, CAPS.gold) : 0;

  // 5. Oil — context-aware nuanced scoring
  //    Rule A: Oil rising + equities also rising  → RISK ON  (demand/growth)
  //    Rule B: Oil spiking + equities flat/falling → RISK OFF (supply shock / geopolitical)
  //    Rule C: Both falling                        → mild RISK OFF (recession fear)
  //    Rule D: Otherwise                           → attenuated
  const oilMom12 = momentumN(oilCandles, 12);
  let rawOil = 0;
  if (oilMom12 != null) {
    const oilNorm   = norm(oilMom12, CAPS.oil);
    const equityDir = rawEquity > 8 ? 1 : rawEquity < -8 ? -1 : 0;

    if (oilNorm > 20 && equityDir <= 0) {
      // Supply shock / geopolitical spike while equities don't confirm
      rawOil = -Math.round(oilNorm * 0.55);
    } else if (oilNorm > 0 && equityDir > 0) {
      // Healthy co-rise: growth story
      rawOil = oilNorm;
    } else if (oilNorm < 0 && equityDir < 0) {
      // Both falling: recession fear
      rawOil = Math.round(oilNorm * 0.5);
    } else {
      // Divergent or neutral: attenuate signal
      rawOil = Math.round(oilNorm * 0.25);
    }
  }

  // 6. USD pressure — USD strengthening = liquidity stress = risk off (inverted)
  //    Also amplified by short-term acceleration: fast USD strengthening = panic/deleveraging
  const usdData = strength['USD'];
  let rawUsd = 0;
  if (usdData) {
    const usdBase  = norm(-usdData.s6h, CAPS.usd); // base: USD strong → negative score
    // Acceleration: is USD moving faster than its recent average pace?
    // usdData.s3h = recent 3H strength; usdData.s6h / 2 = expected 3H at same pace
    const usdAccelRaw = usdData.s3h - usdData.s6h / 2;
    const accelBoost  = norm(-usdAccelRaw, CAPS.usd / 4) * 0.25; // amplify acceleration
    rawUsd = Math.round(Math.max(-100, Math.min(100, usdBase + accelBoost)));
  }

  // 7. AUD/JPY — carry/risk-appetite barometer
  const rawAudjpy  = norm(spreads['AUD_JPY'] ?? 0, CAPS.audjpy);

  // 8. NZD/JPY — carry/risk-appetite barometer
  const rawNzdjpy  = norm(spreads['NZD_JPY'] ?? 0, CAPS.nzdjpy);

  // ─── EMA smoothing — apply to each component using previous row ───────────
  const equity_score  = emaSmooth(rawEquity,  prevSentiment, 'equity_score');
  const jpy_score     = emaSmooth(rawJpy,     prevSentiment, 'jpy_score');
  const chf_score     = emaSmooth(rawChf,     prevSentiment, 'chf_score');
  const gold_score    = emaSmooth(rawGold,    prevSentiment, 'gold_score');
  const oil_score     = emaSmooth(rawOil,     prevSentiment, 'oil_score');
  const usd_score     = emaSmooth(rawUsd,     prevSentiment, 'usd_score');
  const audjpy_score  = emaSmooth(rawAudjpy,  prevSentiment, 'audjpy_score');
  const nzdjpy_score  = emaSmooth(rawNzdjpy,  prevSentiment, 'nzdjpy_score');

  // ─── Acceleration + environment detection ────────────────────────────────
  // Detects if defensive assets are moving FASTER than their recent average.
  // This catches panic / deleveraging events before they fully register in direction scores.

  const goldAccel    = calcAcceleration(goldCandles);  // positive = gold accelerating up
  const spxAccel     = calcAcceleration(spxCandles);   // negative = equities accelerating down
  const jpyAccelRaw  = jpyData ? (jpyData.s3h - jpyData.s6h / 2) : 0;  // positive = JPY accelerating (risk-off pressure)
  const usdAccelRaw  = usdData ? (usdData.s3h - usdData.s6h / 2) : 0;  // abs value matters

  const stressSignals = [
    goldAccel  != null && goldAccel  >  0.25,  // gold surging (>0.25% per H above avg)
    spxAccel   != null && spxAccel   < -0.25,  // equities collapsing faster than avg
    jpyAccelRaw > 0.004,                        // JPY strengthening rapidly (safe-haven rush)
    Math.abs(usdAccelRaw) > 0.005,              // USD moving rapidly (liquidity disruption)
  ].filter(Boolean);

  const environment =
    stressSignals.length >= 3 ? 'STRESS'   :
    stressSignals.length >= 2 ? 'ELEVATED' : 'CALM';

  // Composite acceleration score (-100..+100)
  // Positive = risk-on momentum accelerating; Negative = risk-off assets accelerating
  const accel_composite = Math.round(
    (spxAccel   != null ? norm( spxAccel,   CAPS.accel) : 0) * 0.40 +
    (goldAccel  != null ? norm(-goldAccel,  CAPS.accel) : 0) * 0.30 +
    norm(-jpyAccelRaw, CAPS.usd / 5) * 0.30
  );

  // ─── Weighted net score ───────────────────────────────────────────────────
  const net_score = parseFloat((
    equity_score * WEIGHTS.equity  +
    jpy_score    * WEIGHTS.jpy     +
    chf_score    * WEIGHTS.chf     +
    gold_score   * WEIGHTS.gold    +
    oil_score    * WEIGHTS.oil     +
    audjpy_score * WEIGHTS.audjpy  +
    nzdjpy_score * WEIGHTS.nzdjpy  +
    usd_score    * WEIGHTS.usd
  ).toFixed(2));

  // ─── Sentiment classification ─────────────────────────────────────────────
  let sentiment;
  if      (net_score >  15) sentiment = 'RISK_ON';
  else if (net_score < -15) sentiment = 'RISK_OFF';
  else                       sentiment = 'NEUTRAL';

  // STRESS override: violent multi-asset panic → force RISK_OFF unless strongly RISK_ON
  if (environment === 'STRESS' && net_score < 30) {
    sentiment = 'RISK_OFF';
  }

  // ─── Confidence: component agreement × signal strength ───────────────────
  const dir = net_score > 0 ? 1 : net_score < 0 ? -1 : 0;
  const allScores = [equity_score, jpy_score, chf_score, gold_score, oil_score, usd_score, audjpy_score, nzdjpy_score];
  const agreeing  = dir === 0 ? 4 : allScores.filter(v => (dir > 0 ? v > 0 : v < 0)).length;

  let confidence = Math.min(100, Math.round(
    (agreeing / allScores.length) * 50 +
    (Math.abs(net_score) / 100) * 50
  ));

  // Reduce confidence when environment is unstable (contradictory / violent signals)
  if (environment === 'STRESS')   confidence = Math.round(confidence * 0.70);
  if (environment === 'ELEVATED') confidence = Math.round(confidence * 0.85);

  const risk_on_score  = parseFloat(Math.max(0,  net_score).toFixed(2));
  const risk_off_score = parseFloat(Math.max(0, -net_score).toFixed(2));

  const row = {
    time,
    sentiment,
    environment,
    confidence,
    net_score,
    risk_on_score,
    risk_off_score,
    equity_score,
    jpy_score,
    chf_score,
    gold_score,
    oil_score,
    usd_score,
    audjpy_score,
    nzdjpy_score,
    accel_composite,
  };

  const { error } = await supabase
    .from('risk_sentiment')
    .upsert(row, { onConflict: 'time', ignoreDuplicates: false });

  if (error) throw new Error(`Sentiment upsert error: ${error.message}`);

  console.log(
    `[SENTIMENT] ${sentiment} [${environment}] | net:${net_score} conf:${confidence}% accel:${accel_composite} | ` +
    `eq:${equity_score} jpy:${jpy_score} chf:${chf_score} gold:${gold_score} oil:${oil_score} usd:${usd_score} ` +
    `audjpy:${audjpy_score} nzdjpy:${nzdjpy_score}`
  );
  return row;
}

module.exports = { calculateLatestSentiment };
