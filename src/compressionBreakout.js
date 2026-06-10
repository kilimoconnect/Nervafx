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
 *   Direction confirmation = impulse (no separate detection needed).
 *   PULLBACK_ACTIVE → STRUCTURE_FORMED → ENTRY_READY
 *
 * State machine per pair:
 *   PULLBACK_ACTIVE:    monitoring for pullback against the confirmed direction
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
const IMPULSE_LOOKBACK      = 20;  // M15 candles to derive impulse range from (~5 hours)

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
    if (currentEnergy >= 70) {
      // Energy recovered past threshold — directional discovery phase
      baseline.recovery_detected = true;
      console.log(`[COMP-BRK] Recovery! Energy ${currentEnergy} crossed 70 — directional discovery active`);
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
    console.log('[COMP-BRK] No active signal pairs — deactivating all structure watch entries');
    // Deactivate all existing watch entries since no signal pairs are active
    const { data: existingWatch } = await supabase
      .from('m15_structure_watch')
      .select('*');
    const toDeactivate = (existingWatch || []).filter(w => w.state !== 'INACTIVE');
    if (toDeactivate.length) {
      const rows = toDeactivate.map(w => ({ ...w, state: 'INACTIVE', updated_at: new Date().toISOString() }));
      await supabase.from('m15_structure_watch').upsert(rows, { onConflict: 'instrument' });
      console.log(`[COMP-BRK] Deactivated ${rows.length} structure watch entries`);
    }
    return [];
  }

  // Get existing structure watch states
  const { data: existingWatch } = await supabase
    .from('m15_structure_watch')
    .select('*');

  const watchMap = {};
  for (const w of (existingWatch || [])) watchMap[w.instrument] = w;

  // Get latest M15 candles for each pair (last 30 candles = 7.5 hours)
  const results = [];

  for (const sp of signalPairs) {
    const { data: candles } = await supabase
      .from('backtest_candles')
      .select('time, open, high, low, close')
      .eq('instrument', sp.instrument)
      .eq('timeframe', 'M15')
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(30);

    if (!candles || candles.length < 5) continue;

    // Reverse to ascending order
    const asc = candles.reverse().map(c => ({
      time: c.time,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
    }));

    const existing = watchMap[sp.instrument] || null;
    let needsInit = false;

    let entry;
    if (!existing) {
      // Brand new pair — initialize
      entry = {
        instrument: sp.instrument,
        direction: sp.dir,
        state: null, // will be set below
        impulse_high: null,
        impulse_low: null,
        pullback_high: null,
        pullback_low: null,
        entry_price: null,
        invalidation_price: null,
      };
      needsInit = true;
    } else {
      entry = { ...existing };

      // Re-activate if pair was INACTIVE or INVALIDATED but is back in signal pairs
      if (entry.state === 'INACTIVE' || entry.state === 'INVALIDATED') {
        console.log(`[COMP-BRK] ${sp.instrument} re-activated (was ${entry.state})`);
        needsInit = true;
      }

      // Direction change → reset
      if (entry.direction && entry.direction !== sp.dir) {
        console.log(`[COMP-BRK] ${sp.instrument} direction changed ${entry.direction}→${sp.dir}`);
        needsInit = true;
      }
    }

    entry.direction = sp.dir;

    // Skip WATCHING + IMPULSE_DETECTED entirely — direction confirmation IS the impulse.
    // Use the recent M15 candle range as impulse levels and go straight to PULLBACK_ACTIVE.
    if (needsInit) {
      const recentWindow = asc.slice(-IMPULSE_LOOKBACK);
      const impHigh = Math.max(...recentWindow.map(c => c.high));
      const impLow  = Math.min(...recentWindow.map(c => c.low));

      entry.state = 'PULLBACK_ACTIVE';
      entry.impulse_high = impHigh;
      entry.impulse_low = impLow;
      entry.pullback_high = sp.dir === 'BUY' ? impHigh : null;
      entry.pullback_low  = sp.dir === 'SELL' ? impLow : null;
      entry.entry_price = null;
      entry.invalidation_price = null;
      console.log(`[COMP-BRK] ${sp.instrument} ${sp.dir} → PULLBACK_ACTIVE immediately (impulse H:${impHigh.toFixed(5)} L:${impLow.toFixed(5)})`);
    }

    // Run state machine
    const updated = processStructure(entry, asc, sp.dir);
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
  const pullback = results.filter(r => r.state === 'PULLBACK_ACTIVE');
  console.log(`[COMP-BRK] M15 Structure: ${ready.length} ENTRY_READY, ${structured.length} STRUCTURE_FORMED, ${pullback.length} PULLBACK_ACTIVE, ${results.length} total`);

  return results;
}

// ─── Price Structure State Machine ───────────────────────────────────────────

function processStructure(state, candles, direction) {
  const isBuy = direction === 'BUY';
  const latest = candles[candles.length - 1];

  // Invalidated or inactive — do not process further
  if (state.state === 'INVALIDATED' || state.state === 'INACTIVE') {
    return state;
  }

  // ── PULLBACK_ACTIVE / STRUCTURE_FORMED → track swing + detect structure + entry ──
  // Pairs always start at PULLBACK_ACTIVE (impulse is the direction confirmation itself).
  if (state.state === 'PULLBACK_ACTIVE' || state.state === 'STRUCTURE_FORMED') {
    if (isInvalidated(state, latest, isBuy)) {
      state.state = 'INVALIDATED';
      console.log(`[COMP-BRK] ${state.instrument} INVALIDATED at ${state.state}`);
      return state;
    }

    if (isBuy) {
      if (latest.low < (state.pullback_low || Infinity)) {
        state.pullback_low = latest.low;
      }
      if (!state.pullback_high) state.pullback_high = state.impulse_high;

      if (state.state === 'PULLBACK_ACTIVE' && latest.low > state.pullback_low) {
        state.state = 'STRUCTURE_FORMED';
        state.entry_price = state.pullback_high;
        state.invalidation_price = state.pullback_low;
      }

      if (state.state === 'STRUCTURE_FORMED' && latest.close > state.entry_price) {
        state.state = 'ENTRY_READY';
        state.entry_price = latest.close;
      }
    } else {
      if (latest.high > (state.pullback_high || 0)) {
        state.pullback_high = latest.high;
      }
      if (!state.pullback_low) state.pullback_low = state.impulse_low;

      if (state.state === 'PULLBACK_ACTIVE' && latest.high < state.pullback_high) {
        state.state = 'STRUCTURE_FORMED';
        state.entry_price = state.pullback_low;
        state.invalidation_price = state.pullback_high;
      }

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

// detectImpulse removed — direction confirmation IS the impulse.
// Pairs skip WATCHING/IMPULSE_DETECTED and start at PULLBACK_ACTIVE.

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
