// src/m15.js — M15 Spread Engine
//
// Mirrors the H1 pipeline entirely but at M15 granularity, inside the hourly run:
//   M15 candles → currency strength → normalize → EMA smooth → pair spread → state
//
// Lookback mapping (positional, same logic as H1 strength.js):
//   3 M15 candles  = 45 min   ←→  H1's 3-candle / 3H lookback
//   6 M15 candles  = 90 min   ←→  H1's 6-candle / 6H lookback
//  12 M15 candles  = 180 min  ←→  H1's 12-candle / 12H lookback
//
// Output: m15_pair_spreads  (one row per instrument per run)

const { config }          = require('./config');
const { supabase }        = require('./supabase');
const { fetchCandles, sleep, RATE_LIMIT_DELAY } = require('./oanda');

const CURRENCIES         = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const PAIRS_PER_CURRENCY = 7;
const LOOKBACKS          = [3, 6, 12];   // M15 candle counts → 45M / 90M / 180M
const FETCH              = 20;           // candles pulled per instrument (newest-first)
const MIN_CANDLES        = 14;           // refIdx(0) + offset(1) + maxLB(12) + 1

/**
 * Compute Directional Efficiency from OHLC candles (ascending order).
 * DE = (|final_close - initial_open| / sum(high - low)) × 100
 */
function computeDE(candles) {
  if (!candles || candles.length < 2) return 0;
  const netMove = Math.abs(candles[candles.length - 1].close - candles[0].open);
  let totalTravel = 0;
  for (const c of candles) totalTravel += c.high - c.low;
  if (totalTravel === 0) return 0;
  return Math.min(100, (netMove / totalTravel) * 100);
}

// Simple EMA: (prev + current) / 2 — identical to smooth.js
function ema(prev, current) {
  if (prev === null || prev === undefined) return current;
  return (prev + current) / 2;
}

// State detection from smoothed 45M vs 90M spread values.
// |smooth_45m| > |smooth_90m| × 1.1  → EXPANDING  (pressure building)
// |smooth_45m| < |smooth_90m| × 0.9  → COMPRESSING (pressure fading)
// opposite signs                      → REVERSING   (direction flipping)
// both near zero (<0.00005)           → FLAT
// otherwise                           → STEADY
function computeState(s45, s90) {
  const m45 = Math.abs(s45);
  const m90 = Math.abs(s90);
  if (m45 < 0.00005 && m90 < 0.00005) return 'FLAT';
  if ((s45 > 0 && s90 < 0) || (s45 < 0 && s90 > 0)) return 'REVERSING';
  if (m45 > m90 * 1.1) return 'EXPANDING';
  if (m45 < m90 * 0.9) return 'COMPRESSING';
  return 'STEADY';
}

/**
 * Compute impulse metrics from real M15 candle price action.
 * Uses last 4 candles (1 hour) for impulse, full array for ATR normalisation.
 * @param {Array} candles - sorted ascending by time, each { open, high, low, close }
 * @returns {{ velocity, body_ratio, consec_dir, impulse_dir, impulse_score }}
 */
function computeImpulse(candles) {
  const empty = { velocity: 0, body_ratio: 0, consec_dir: 0, impulse_dir: 0, impulse_score: 0 };
  if (!candles || candles.length < 4) return empty;

  const recent = candles.slice(-4); // last 4 M15 = 1 hour

  // ATR from all candles for normalisation
  let atrSum = 0;
  for (const c of candles) atrSum += c.high - c.low;
  const avgRange = atrSum / candles.length;
  if (avgRange === 0) return empty;

  // 1. Velocity: net move over 4 candles / average candle range
  const netMove = Math.abs(recent[recent.length - 1].close - recent[0].open);
  const velocity = netMove / avgRange;

  // 2. Body ratio: total body / total range (high = directional candles)
  let bodySum = 0, rangeSum = 0;
  for (const c of recent) {
    bodySum  += Math.abs(c.close - c.open);
    rangeSum += c.high - c.low;
  }
  const bodyRatio = rangeSum > 0 ? bodySum / rangeSum : 0;

  // 3. Consecutive directional closes (from most recent backward)
  let consecDir = 1;
  const lastDir = recent[recent.length - 1].close >= recent[recent.length - 1].open ? 1 : -1;
  for (let i = recent.length - 2; i >= 0; i--) {
    const dir = recent[i].close >= recent[i].open ? 1 : -1;
    if (dir === lastDir) consecDir++;
    else break;
  }

  // 4. Net impulse direction: +1 bullish, -1 bearish
  const impulseDir = recent[recent.length - 1].close >= recent[0].open ? 1 : -1;

  // 5. Composite score: velocity 45%, body dominance 30%, consecutive 25%
  const velScore    = Math.min(100, velocity * 33);
  const bodyScore   = Math.min(100, bodyRatio * 125);
  const consecScore = (consecDir / 4) * 100;
  const impulseScore = Math.min(100, Math.round(
    velScore * 0.45 + bodyScore * 0.30 + consecScore * 0.25
  ));

  return {
    velocity:      Math.round(velocity * 100) / 100,
    body_ratio:    Math.round(bodyRatio * 100) / 100,
    consec_dir:    consecDir,
    impulse_dir:   impulseDir,
    impulse_score: impulseScore,
  };
}

// Calculate and store M15 spreads for the latest common closed candle.
// Called once per hourly update cycle (after H1 strength/smooth/spreads).
async function calculateLatestM15Spreads() {
  // ── 1. Fetch FETCH complete M15 candles per instrument (newest first) ────────
  const arrays = {};

  for (const instrument of config.instruments) {
    const raw = await fetchCandles(instrument, { count: FETCH, granularity: 'M15' });

    // Keep only completed candles; store newest-first for positional indexing
    // Full OHLC retained for DE computation (close also used for spread calc)
    const complete = raw
      .filter(c => c.complete === true)
      .map(c => ({
        time:  new Date(c.time).toISOString(),
        open:  parseFloat(c.mid.o),
        high:  parseFloat(c.mid.h),
        low:   parseFloat(c.mid.l),
        close: parseFloat(c.mid.c),
      }))
      .reverse()   // OANDA returns ascending when using count; reverse → newest first
      .slice(0, FETCH);

    if (complete.length < MIN_CANDLES) {
      throw new Error(
        `[M15] Not enough M15 candles for ${instrument}: need ${MIN_CANDLES}, got ${complete.length}`
      );
    }

    arrays[instrument] = complete;
    await sleep(RATE_LIMIT_DELAY);
  }

  // ── 2. RefTime = oldest "most recent candle" across all 28 instruments ───────
  // (Mirrors strength.js — ensures all instruments have data at this time)
  const refTime = config.instruments
    .map(inst => arrays[inst][0].time)
    .sort()[0];

  // ── 3. Compute normalised currency strength at a positional offset ───────────
  // offset=0 → current candle (T), offset=1 → one M15 before T (for EMA prev)
  function computeNormAtOffset(offset) {
    const raw = {};
    for (const c of CURRENCIES) raw[c] = { 3: 0, 6: 0, 12: 0 };

    for (const instrument of config.instruments) {
      const arr          = arrays[instrument];
      const [base, quote] = instrument.split('_');

      // Find the newest candle that is at-or-before refTime (normally index 0)
      const refIdx = arr.findIndex(c => c.time <= refTime);
      if (refIdx === -1)
        throw new Error(`[M15] ${instrument}: no M15 candle at or before ${refTime}`);

      const currentIdx = refIdx + offset;
      if (currentIdx >= arr.length)
        throw new Error(`[M15] ${instrument}: insufficient data at offset ${offset}`);

      const closeNow = arr[currentIdx].close;

      for (const lb of LOOKBACKS) {
        const pastIdx = currentIdx + lb;
        if (pastIdx >= arr.length)
          throw new Error(
            `[M15] ${instrument}: not enough candles for lb=${lb} at offset=${offset}`
          );
        const mv = (closeNow - arr[pastIdx].close) / arr[pastIdx].close;
        raw[base][lb] += mv;
        raw[quote][lb] -= mv;
      }
    }

    // Normalise by number of pairs per currency (7)
    const norm = {};
    for (const c of CURRENCIES) {
      norm[c] = {
        3:  raw[c][3]  / PAIRS_PER_CURRENCY,
        6:  raw[c][6]  / PAIRS_PER_CURRENCY,
        12: raw[c][12] / PAIRS_PER_CURRENCY,
      };
    }
    return norm;
  }

  const normCurrent = computeNormAtOffset(0); // T  (latest closed M15)
  const normPrev    = computeNormAtOffset(1); // T-1 (one M15 candle earlier)

  // ── 4. EMA smooth per currency: smooth = (prev_norm + current_norm) / 2 ─────
  const smoothStrength = {};
  for (const c of CURRENCIES) {
    smoothStrength[c] = {
      3:  ema(normPrev[c][3],  normCurrent[c][3]),
      6:  ema(normPrev[c][6],  normCurrent[c][6]),
      12: ema(normPrev[c][12], normCurrent[c][12]),
    };
  }

  // ── 5. Compute pair spreads (raw & smooth) + DE for all 28 instruments ─────
  const rows = config.instruments.map(instrument => {
    const [base, quote] = instrument.split('_');
    const nb = normCurrent[base],    nq = normCurrent[quote];
    const sb = smoothStrength[base], sq = smoothStrength[quote];

    const spread_45m  = nb[3]  - nq[3];
    const spread_90m  = nb[6]  - nq[6];
    const spread_180m = nb[12] - nq[12];

    const smooth_45m  = sb[3]  - sq[3];
    const smooth_90m  = sb[6]  - sq[6];
    const smooth_180m = sb[12] - sq[12];

    // Compute DE + impulse from the OANDA candles we already have (ascending order)
    const candlesAsc = arrays[instrument].slice().reverse(); // newest-first → oldest-first
    const de = Math.round(computeDE(candlesAsc) * 10) / 10;
    const impulse = computeImpulse(candlesAsc);

    return {
      time: refTime,
      instrument,
      spread_45m,
      spread_90m,
      spread_180m,
      smooth_45m,
      smooth_90m,
      smooth_180m,
      state: computeState(smooth_45m, smooth_90m),
      de_combined: de,
      impulse_score: impulse.impulse_score,
      impulse_dir:   impulse.impulse_dir,
      velocity:      impulse.velocity,
      body_ratio:    impulse.body_ratio,
      consec_dir:    impulse.consec_dir,
    };
  });

  // ── 6. Upsert to m15_pair_spreads ────────────────────────────────────────────
  let { error } = await supabase
    .from('m15_pair_spreads')
    .upsert(rows, { onConflict: 'time,instrument', ignoreDuplicates: false });

  // Graceful fallback: if new columns don't exist yet, retry without them
  if (error && error.message && (error.message.includes('de_combined') || error.message.includes('impulse_score'))) {
    console.warn('[M15] Missing columns — upserting without DE/impulse (run migration)');
    const rowsLite = rows.map(({ de_combined, impulse_score, impulse_dir, velocity, body_ratio, consec_dir, ...rest }) => rest);
    const retry = await supabase
      .from('m15_pair_spreads')
      .upsert(rowsLite, { onConflict: 'time,instrument', ignoreDuplicates: false });
    error = retry.error;
  }

  if (error) throw new Error(`[M15] Upsert error: ${error.message}`);

  console.log(`[M15] Stored 28 M15 spreads for ${refTime}`);
  return { time: refTime, rows };
}

module.exports = { calculateLatestM15Spreads, computeState, computeImpulse, computeDE };
