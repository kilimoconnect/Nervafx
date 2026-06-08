'use strict';

/**
 * Compression Breakout + M15 Price Structure Entry
 *
 * H1 detects market-wide compression opportunity:
 *   Energy < 35 → compression baseline starts
 *   Energy keeps falling → baseline updates (tracks lowest)
 *   Energy starts rising → baseline locks
 *   Energy recovers / crosses threshold → directional discovery
 *   Approved pairs generated from energy_signal_pairs
 *
 * M15 executes on approved pairs using price structure:
 *   WATCHING → IMPULSE_DETECTED → PULLBACK_ACTIVE →
 *   STRUCTURE_FORMED → ENTRY_READY
 *
 * State machine per pair:
 *   WATCHING:           waiting for impulse move
 *   IMPULSE_DETECTED:   strong directional M15 move found
 *   PULLBACK_ACTIVE:    price retracing against impulse
 *   STRUCTURE_FORMED:   pullback created swing structure (lower high / higher low)
 *   ENTRY_READY:        M15 close broke past pullback level → trade ready
 *   INVALIDATED:        price broke past invalidation level
 *
 * DB tables:
 *   compression_baseline     — single row tracking compression state
 *   m15_structure_watch      — per-pair structure tracking
 */

const { supabase } = require('./supabase');
const { config }   = require('./config');

const COMPRESSION_THRESHOLD = 35;  // Energy below this = compression
const IMPULSE_MIN_CANDLES   = 3;   // Minimum consecutive directional M15 candles
const IMPULSE_MIN_MOVE      = 0.0015; // Minimum impulse move size (% of price)
const PULLBACK_MIN_RETRACE  = 0.3;   // Pullback must retrace at least 30% of impulse

// ─── Compression Baseline ────────────────────────────────────────────────────

async function updateCompressionBaseline() {
  // Get current market energy from latest hourly_session_activity
  const { data: latest } = await supabase
    .from('hourly_session_activity')
    .select('market_energy, time_utc')
    .order('time_utc', { ascending: false })
    .limit(3);

  if (!latest?.length) return null;

  const currentEnergy = parseFloat(latest[0].market_energy) || 0;
  const prevEnergy    = latest.length > 1 ? (parseFloat(latest[1].market_energy) || 0) : currentEnergy;

  // Get or create baseline
  const { data: existing } = await supabase
    .from('compression_baseline')
    .select('*')
    .eq('id', 1)
    .single();

  const baseline = existing || {
    id: 1,
    active: false,
    baseline_energy: 100,
    baseline_locked: false,
    compression_start: null,
    lock_time: null,
    recovery_detected: false,
  };

  // State machine
  if (currentEnergy < COMPRESSION_THRESHOLD && !baseline.active) {
    // Enter compression
    baseline.active = true;
    baseline.baseline_energy = currentEnergy;
    baseline.baseline_locked = false;
    baseline.compression_start = latest[0].time_utc;
    baseline.lock_time = null;
    baseline.recovery_detected = false;
    console.log(`[COMP-BRK] Compression started — energy ${currentEnergy}`);

  } else if (baseline.active && !baseline.baseline_locked) {
    if (currentEnergy < baseline.baseline_energy) {
      // Energy still falling — update baseline
      baseline.baseline_energy = currentEnergy;
      console.log(`[COMP-BRK] Baseline updated — energy ${currentEnergy}`);
    } else if (currentEnergy > baseline.baseline_energy + 3) {
      // Energy rising — lock baseline
      baseline.baseline_locked = true;
      baseline.lock_time = latest[0].time_utc;
      console.log(`[COMP-BRK] Baseline LOCKED at ${baseline.baseline_energy} — energy recovering to ${currentEnergy}`);
    }

  } else if (baseline.active && baseline.baseline_locked) {
    if (currentEnergy >= 55) {
      // Energy recovered past threshold — directional discovery phase
      baseline.recovery_detected = true;
      console.log(`[COMP-BRK] Recovery! Energy ${currentEnergy} crossed 55 — directional discovery active`);
    }
  }

  // Reset if energy drops back below baseline after lock (false breakout)
  if (baseline.active && baseline.baseline_locked && currentEnergy < baseline.baseline_energy) {
    baseline.baseline_locked = false;
    baseline.baseline_energy = currentEnergy;
    baseline.recovery_detected = false;
    console.log(`[COMP-BRK] Reset — energy fell back to ${currentEnergy}`);
  }

  // Upsert
  await supabase
    .from('compression_baseline')
    .upsert({ ...baseline, updated_at: new Date().toISOString() }, { onConflict: 'id' });

  return baseline;
}

// ─── M15 Price Structure Watch ───────────────────────────────────────────────

async function updateM15StructureWatch() {
  // Get approved pairs from energy_signal_pairs
  const { data: signalPairs } = await supabase
    .from('energy_signal_pairs')
    .select('instrument, dir, phase')
    .eq('active', true);

  if (!signalPairs?.length) {
    console.log('[COMP-BRK] No active signal pairs — skipping M15 structure watch');
    return [];
  }

  // Get existing structure watch states
  const { data: existingWatch } = await supabase
    .from('m15_structure_watch')
    .select('*');

  const watchMap = {};
  for (const w of (existingWatch || [])) watchMap[w.instrument] = w;

  // Get latest M15 candles for each pair (last 20 candles = 5 hours)
  const results = [];

  for (const sp of signalPairs) {
    const { data: candles } = await supabase
      .from('backtest_candles')
      .select('time, open, high, low, close')
      .eq('instrument', sp.instrument)
      .eq('timeframe', 'M15')
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(20);

    if (!candles || candles.length < 5) continue;

    // Reverse to ascending order
    const asc = candles.reverse().map(c => ({
      time: c.time,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
    }));

    const existing = watchMap[sp.instrument] || {
      instrument: sp.instrument,
      direction: sp.dir,
      state: 'WATCHING',
      impulse_high: null,
      impulse_low: null,
      pullback_high: null,
      pullback_low: null,
      entry_price: null,
      invalidation_price: null,
    };

    // Direction change = new directional discovery → reset structure
    if (existing.direction && existing.direction !== sp.dir) {
      console.log(`[COMP-BRK] ${sp.instrument} direction changed ${existing.direction}→${sp.dir} — resetting structure`);
      existing.state = 'WATCHING';
      existing.impulse_high = null;
      existing.impulse_low = null;
      existing.pullback_high = null;
      existing.pullback_low = null;
      existing.entry_price = null;
      existing.invalidation_price = null;
    }
    existing.direction = sp.dir;

    // Run state machine
    const updated = processStructure(existing, asc, sp.dir);
    results.push(updated);
  }

  // Only remove pairs that are no longer in signal pairs AND had a direction reversal
  // or were explicitly removed. Pairs persist across sessions — they only get removed
  // when the energy engine removes them from signal pairs (direction change/reversal).
  const activeInstruments = new Set(signalPairs.map(p => p.instrument));
  for (const w of (existingWatch || [])) {
    if (!activeInstruments.has(w.instrument) && w.state !== 'INACTIVE') {
      console.log(`[COMP-BRK] ${w.instrument} removed from signal pairs — deactivating structure`);
      results.push({ ...w, state: 'INACTIVE', updated_at: new Date().toISOString() });
    }
  }

  // Upsert all
  if (results.length) {
    const rows = results.map(r => ({
      ...r,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase
      .from('m15_structure_watch')
      .upsert(rows, { onConflict: 'instrument' });
    if (error) console.error('[COMP-BRK] Upsert error:', error.message);
  }

  const ready = results.filter(r => r.state === 'ENTRY_READY');
  const structured = results.filter(r => r.state === 'STRUCTURE_FORMED');
  const watching = results.filter(r => r.state === 'WATCHING' || r.state === 'IMPULSE_DETECTED' || r.state === 'PULLBACK_ACTIVE');
  console.log(`[COMP-BRK] M15 Structure: ${ready.length} ENTRY_READY, ${structured.length} STRUCTURE_FORMED, ${watching.length} watching, ${results.length} total`);

  return results;
}

// ─── Price Structure State Machine ───────────────────────────────────────────

function processStructure(state, candles, direction) {
  const isBuy = direction === 'BUY';
  const latest = candles[candles.length - 1];
  const prev   = candles[candles.length - 2];

  // Invalidated or inactive — do not process further
  // Pair stays removed until a new directional discovery re-adds it
  if (state.state === 'INVALIDATED' || state.state === 'INACTIVE') {
    return state;
  }

  // ── WATCHING → detect impulse ──
  if (state.state === 'WATCHING') {
    const impulse = detectImpulse(candles, direction);
    if (impulse) {
      state.state = 'IMPULSE_DETECTED';
      state.impulse_high = impulse.high;
      state.impulse_low = impulse.low;
      state.pullback_high = null;
      state.pullback_low = null;
    }
    return state;
  }

  // ── IMPULSE_DETECTED → detect pullback ──
  // Pullback = any candle that moves against the impulse direction.
  // Even 1 candle counts — the charts show 1-3 candle pullbacks.
  if (state.state === 'IMPULSE_DETECTED') {
    if (isInvalidated(state, latest, isBuy)) {
      state.state = 'INVALIDATED';
      console.log(`[COMP-BRK] ${state.instrument} INVALIDATED at IMPULSE_DETECTED`);
      return state;
    }

    if (isBuy) {
      // BUY: any candle with a lower low than previous = pullback starting
      if (latest.low < prev.low || latest.close < prev.close) {
        state.state = 'PULLBACK_ACTIVE';
        state.pullback_low = latest.low;
        state.pullback_high = state.impulse_high; // high before pullback
      }
    } else {
      // SELL: any candle with a higher high than previous = pullback starting
      if (latest.high > prev.high || latest.close > prev.close) {
        state.state = 'PULLBACK_ACTIVE';
        state.pullback_high = latest.high;
        state.pullback_low = state.impulse_low; // low before pullback
      }
    }
    return state;
  }

  // ── PULLBACK_ACTIVE → track swing + detect structure + detect break ──
  // Combines PULLBACK + STRUCTURE_FORMED + ENTRY detection in one state.
  // As soon as pullback swing is established and price breaks past it → ENTRY.
  if (state.state === 'PULLBACK_ACTIVE' || state.state === 'STRUCTURE_FORMED') {
    if (isInvalidated(state, latest, isBuy)) {
      state.state = 'INVALIDATED';
      console.log(`[COMP-BRK] ${state.instrument} INVALIDATED at ${state.state}`);
      return state;
    }

    if (isBuy) {
      // Track pullback low (deepest retrace)
      if (latest.low < (state.pullback_low || Infinity)) {
        state.pullback_low = latest.low;
      }
      // Pullback high = the swing high before the pullback
      if (!state.pullback_high) state.pullback_high = state.impulse_high;

      // Structure formed when price stops making new lows (current low > pullback_low)
      if (state.state === 'PULLBACK_ACTIVE' && latest.low > state.pullback_low) {
        state.state = 'STRUCTURE_FORMED';
        state.entry_price = state.pullback_high;
        state.invalidation_price = state.pullback_low;
      }

      // Break entry: M15 close above pullback high
      if (state.state === 'STRUCTURE_FORMED' && latest.close > state.entry_price) {
        state.state = 'ENTRY_READY';
        state.entry_price = latest.close;
      }
    } else {
      // Track pullback high (highest retrace)
      if (latest.high > (state.pullback_high || 0)) {
        state.pullback_high = latest.high;
      }
      // Pullback low = the swing low before the pullback
      if (!state.pullback_low) state.pullback_low = state.impulse_low;

      // Structure formed when price stops making new highs (current high < pullback_high)
      if (state.state === 'PULLBACK_ACTIVE' && latest.high < state.pullback_high) {
        state.state = 'STRUCTURE_FORMED';
        state.entry_price = state.pullback_low;
        state.invalidation_price = state.pullback_high;
      }

      // Break entry: M15 close below pullback low
      if (state.state === 'STRUCTURE_FORMED' && latest.close < state.entry_price) {
        state.state = 'ENTRY_READY';
        state.entry_price = latest.close;
      }
    }
    return state;
  }

  // ── ENTRY_READY → stays until consumed or invalidated ──
  if (state.state === 'ENTRY_READY') {
    if (isInvalidated(state, latest, isBuy)) {
      state.state = 'INVALIDATED';
      console.log(`[COMP-BRK] ${state.instrument} INVALIDATED after ENTRY_READY`);
    }
  }

  return state;
}

function detectImpulse(candles, direction) {
  const isBuy = direction === 'BUY';
  const recent = candles.slice(-10); // last 10 M15 candles (~2.5 hours)
  if (recent.length < 4) return null;

  // Scan sliding windows of 3-8 candles for a net directional move
  // Doesn't require consecutive same-direction candles — mixed candles
  // within an impulse still count if net move is directional enough
  let bestImpulse = null;

  for (let winSize = 3; winSize <= Math.min(8, recent.length); winSize++) {
    const window = recent.slice(-winSize);
    const windowHigh = Math.max(...window.map(c => c.high));
    const windowLow  = Math.min(...window.map(c => c.low));
    const netMove    = window[window.length - 1].close - window[0].open;
    const midPrice   = (windowHigh + windowLow) / 2;
    const totalRange = (windowHigh - windowLow) / midPrice;

    // Net move must be in the signal direction and meet minimum size
    const directional = isBuy ? netMove > 0 : netMove < 0;
    if (!directional) continue;
    if (totalRange < IMPULSE_MIN_MOVE) continue;

    // Directional efficiency: net move / total range > 40%
    // Ensures the move is predominantly in one direction
    const efficiency = Math.abs(netMove) / (windowHigh - windowLow);
    if (efficiency < 0.35) continue;

    // Count how many candles closed in the signal direction (majority rule)
    const dirCount = window.filter(c => isBuy ? c.close > c.open : c.close < c.open).length;
    if (dirCount < winSize * 0.5) continue; // at least half must be directional

    if (!bestImpulse || totalRange > bestImpulse.moveSize) {
      bestImpulse = { high: windowHigh, low: windowLow, streak: winSize, moveSize: totalRange };
    }
  }

  return bestImpulse;
}

function isInvalidated(state, candle, isBuy) {
  if (isBuy) {
    // BUY: invalidated if close below impulse low
    if (state.impulse_low && candle.close < state.impulse_low) return true;
    // Or below pullback low (if structure formed)
    if (state.state === 'STRUCTURE_FORMED' && state.invalidation_price && candle.close < state.invalidation_price) return true;
  } else {
    // SELL: invalidated if close above impulse high
    if (state.impulse_high && candle.close > state.impulse_high) return true;
    // Or above pullback high (if structure formed)
    if (state.state === 'STRUCTURE_FORMED' && state.invalidation_price && candle.close > state.invalidation_price) return true;
  }
  return false;
}

// ─── Main entry point ────────────────────────────────────────────────────────

async function runCompressionBreakout() {
  const baseline = await updateCompressionBaseline();
  const structures = await updateM15StructureWatch();
  return { baseline, structures };
}

module.exports = { runCompressionBreakout, updateCompressionBaseline, updateM15StructureWatch };
