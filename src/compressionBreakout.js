'use strict';

/**
 * Expansion → Persistence Validation → Trade Approval
 *
 * New pair lifecycle (replaces old compression breakout):
 *
 *   1. VALIDATING:  Pair formed after confluence bar. Monitored for 1 hour.
 *                   During this window, M15 high/low are tracked as reference levels.
 *
 *   2. APPROVED:    After 1h, 3H currency strength still supports the pair
 *                   (strong ccy 3H > 0, weak ccy 3H < 0). Trade approved.
 *                   Waiting for M15 pullback entry:
 *                     BUY  → M15 close below the 2h-window high
 *                     SELL → M15 close above the 2h-window low
 *
 *   3. ENTRY:       Pullback condition met — trade entry signal.
 *
 *   4. REMOVED:     3H currency strength reversed (strong flipped negative
 *                   or weak flipped positive). Pair removed at any stage.
 *
 * DB tables:
 *   m15_structure_watch  — per-pair state tracking (reuses existing table)
 *   compression_baseline — kept for backward compat (updated but not critical)
 */

const { supabase } = require('./supabase');

const VALIDATION_HOURS = 1;

// ─── Compression Baseline (kept for backward compat) ────────────────────────

async function updateCompressionBaseline() {
  const { data: latest } = await supabase
    .from('hourly_session_activity')
    .select('market_energy, time_utc')
    .order('time_utc', { ascending: false })
    .limit(3);

  if (!latest?.length) return null;

  const currentEnergy = parseFloat(latest[0].market_energy) || 0;

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

  if (currentEnergy < 35 && !baseline.active) {
    baseline.active = true;
    baseline.baseline_energy = currentEnergy;
    baseline.baseline_locked = false;
    baseline.compression_start = latest[0].time_utc;
    baseline.lock_time = null;
    baseline.recovery_detected = false;
  } else if (baseline.active && !baseline.baseline_locked) {
    if (currentEnergy < baseline.baseline_energy) {
      baseline.baseline_energy = currentEnergy;
    } else if (currentEnergy > baseline.baseline_energy + 3) {
      baseline.baseline_locked = true;
      baseline.lock_time = latest[0].time_utc;
    }
  } else if (baseline.active && baseline.baseline_locked) {
    if (currentEnergy >= 60) {
      baseline.recovery_detected = true;
    }
  }

  if (baseline.active && baseline.baseline_locked && currentEnergy < baseline.baseline_energy) {
    baseline.baseline_locked = false;
    baseline.baseline_energy = currentEnergy;
    baseline.recovery_detected = false;
  }

  await supabase
    .from('compression_baseline')
    .upsert({ ...baseline, updated_at: new Date().toISOString() }, { onConflict: 'id' });

  return baseline;
}

// ─── Expansion → Persistence → Trade Approval ──────────────────────────────

async function updateM15StructureWatch() {
  const { data: signalPairs } = await supabase
    .from('energy_signal_pairs')
    .select('instrument, dir, strong_ccy, weak_ccy, triggered_at')
    .eq('active', true);

  if (!signalPairs?.length) {
    console.log('[STRUCT] No active signal pairs — deactivating all');
    const { data: existingWatch } = await supabase
      .from('m15_structure_watch')
      .select('*');
    const toDeactivate = (existingWatch || []).filter(w => w.state !== 'INACTIVE');
    if (toDeactivate.length) {
      const rows = toDeactivate.map(w => ({ ...w, state: 'INACTIVE', updated_at: new Date().toISOString() }));
      await supabase.from('m15_structure_watch').upsert(rows, { onConflict: 'instrument' });
      console.log(`[STRUCT] Deactivated ${rows.length} entries`);
    }
    return [];
  }

  // Fetch existing watch states
  const { data: existingWatch } = await supabase
    .from('m15_structure_watch')
    .select('*');
  const watchMap = {};
  for (const w of (existingWatch || [])) watchMap[w.instrument] = w;

  // Fetch current 3H currency strength for persistence checks
  const { data: csRows } = await supabase
    .from('currency_strength')
    .select('currency, smooth_3h')
    .order('time', { ascending: false })
    .limit(8);
  const strengthMap = {};
  const seen3h = new Set();
  for (const r of (csRows || [])) {
    if (seen3h.has(r.currency)) continue;
    seen3h.add(r.currency);
    strengthMap[r.currency] = parseFloat(r.smooth_3h) || 0;
  }

  const now = new Date();
  const results = [];

  for (const sp of signalPairs) {
    const existing = watchMap[sp.instrument] || null;
    const trigRef = sp.triggered_at || null;

    // Check 3H persistence: strong ccy still positive, weak ccy still negative
    const strong3h = strengthMap[sp.strong_ccy] ?? 0;
    const weak3h = strengthMap[sp.weak_ccy] ?? 0;
    const directionHolds = strong3h > 0 && weak3h < 0;

    // Fetch latest M15 candle for current price
    const { data: m15Candles } = await supabase
      .from('backtest_candles')
      .select('time, open, high, low, close')
      .eq('instrument', sp.instrument)
      .eq('timeframe', 'M15')
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(1);

    if (!m15Candles?.length) continue;
    const latest = {
      time: m15Candles[0].time,
      open: parseFloat(m15Candles[0].open),
      high: parseFloat(m15Candles[0].high),
      low: parseFloat(m15Candles[0].low),
      close: parseFloat(m15Candles[0].close),
    };

    // Per-pair lifecycle:
    //   NEW pair (or re-activated)            → fresh validation
    //   REVERSAL (direction flipped)          → fresh validation
    //   New energy event on a REMOVED pair    → fresh validation
    //   CONTINUATION (same dir, any state)    → keep state and clock
    const isNew = !existing || existing.state === 'INACTIVE';
    const isReversal = !isNew && existing.direction !== sp.dir;
    const isNewEvent = !isNew && trigRef && existing.trigger_ref !== trigRef;

    let entry;
    if (isNew || isReversal || (isNewEvent && existing.state === 'REMOVED')) {
      // (Re)start validation — H1 candle at direction confirmation = reference level
      const { data: h1Candles } = await supabase
        .from('backtest_candles')
        .select('time, high, low')
        .eq('instrument', sp.instrument)
        .eq('timeframe', 'H1')
        .lte('time', sp.triggered_at || now.toISOString())
        .order('time', { ascending: false })
        .limit(1);

      const h1 = h1Candles?.[0];
      const refHigh = h1 ? parseFloat(h1.high) : latest.high;
      const refLow = h1 ? parseFloat(h1.low) : latest.low;
      const reason = isNew ? 'NEW' : isReversal ? 'REVERSAL' : 'NEW EVENT';

      entry = {
        instrument: sp.instrument,
        direction: sp.dir,
        state: 'VALIDATING',
        impulse_high: refHigh,   // H1 high at direction confirmation
        impulse_low: refLow,     // H1 low at direction confirmation
        pullback_high: null,
        pullback_low: null,
        entry_price: null,
        invalidation_price: null,
        validation_started_at: now.toISOString(),  // per-pair 1h clock starts NOW
        trigger_ref: trigRef,
      };
      console.log(`[STRUCT] ${sp.instrument} ${sp.dir} → VALIDATING (${reason}, 1h clock started, H1 ref H:${refHigh.toFixed(5)} L:${refLow.toFixed(5)})`);

    } else {
      entry = { ...existing };
      if (isNewEvent) entry.trigger_ref = trigRef;  // continuation event — keep state & clock
    }

    // Per-pair validation clock — anchored to when THIS pair entered validation,
    // never to the (possibly hours-old) confluence bar time.
    const validationStart = entry.validation_started_at
      ? new Date(entry.validation_started_at)
      : (sp.triggered_at ? new Date(sp.triggered_at) : now);
    const hoursValidating = (now - validationStart) / 3600000;

    // ── State machine ───────────────────────────────────────────────────────

    if (entry.state === 'VALIDATING') {
      // Wait the full per-pair 2h persistence window
      if (hoursValidating >= VALIDATION_HOURS) {
        if (!directionHolds) {
          entry.state = 'REMOVED';
          console.log(`[STRUCT] ${sp.instrument} REMOVED — 3H reversed (${sp.strong_ccy}: ${strong3h.toFixed(5)}, ${sp.weak_ccy}: ${weak3h.toFixed(5)})`);
        } else {
          entry.state = 'APPROVED';
          console.log(`[STRUCT] ${sp.instrument} APPROVED — 3H holds after ${hoursValidating.toFixed(1)}h (${sp.strong_ccy}: +${strong3h.toFixed(5)}, ${sp.weak_ccy}: ${weak3h.toFixed(5)})`);
        }
      }
    }

    if (entry.state === 'APPROVED') {
      if (!directionHolds) {
        entry.state = 'REMOVED';
        console.log(`[STRUCT] ${sp.instrument} REMOVED — 3H reversed after approval`);
      } else {
        // Trade entry: price confirms direction by closing past the H1 reference level
        // BUY:  M15 close ABOVE the H1 high at direction confirmation
        // SELL: M15 close BELOW the H1 low at direction confirmation
        if (sp.dir === 'BUY' && latest.close > entry.impulse_high) {
          // SL = lowest low of last 2 H1 candles
          const { data: slCandles } = await supabase
            .from('backtest_candles')
            .select('low')
            .eq('instrument', sp.instrument)
            .eq('timeframe', 'H1')
            .eq('complete', true)
            .order('time', { ascending: false })
            .limit(2);
          const sl = slCandles?.length ? Math.min(...slCandles.map(c => parseFloat(c.low))) : entry.impulse_low;
          entry.state = 'ENTRY';
          entry.entry_price = latest.close;
          entry.invalidation_price = sl;
          console.log(`[STRUCT] ${sp.instrument} BUY ENTRY — M15 close ${latest.close.toFixed(5)} > H1 high ${entry.impulse_high.toFixed(5)} | SL ${sl.toFixed(5)}`);
        } else if (sp.dir === 'SELL' && latest.close < entry.impulse_low) {
          // SL = highest high of last 2 H1 candles
          const { data: slCandles } = await supabase
            .from('backtest_candles')
            .select('high')
            .eq('instrument', sp.instrument)
            .eq('timeframe', 'H1')
            .eq('complete', true)
            .order('time', { ascending: false })
            .limit(2);
          const sl = slCandles?.length ? Math.max(...slCandles.map(c => parseFloat(c.high))) : entry.impulse_high;
          entry.state = 'ENTRY';
          entry.entry_price = latest.close;
          entry.invalidation_price = sl;
          console.log(`[STRUCT] ${sp.instrument} SELL ENTRY — M15 close ${latest.close.toFixed(5)} < H1 low ${entry.impulse_low.toFixed(5)} | SL ${sl.toFixed(5)}`);
        }
      }
    }

    if (entry.state === 'ENTRY') {
      if (!directionHolds) {
        entry.state = 'REMOVED';
        console.log(`[STRUCT] ${sp.instrument} REMOVED — 3H reversed after entry`);
      }
    }

    results.push(entry);
  }

  // Deactivate pairs no longer in signal set
  const activeInstruments = new Set(signalPairs.map(p => p.instrument));
  for (const w of (existingWatch || [])) {
    if (!activeInstruments.has(w.instrument) && w.state !== 'INACTIVE') {
      console.log(`[STRUCT] ${w.instrument} removed from signal pairs — INACTIVE`);
      results.push({ ...w, state: 'INACTIVE', updated_at: new Date().toISOString() });
    }
  }

  // Upsert all
  if (results.length) {
    const rows = results.map(r => ({ ...r, updated_at: new Date().toISOString() }));
    let { error } = await supabase
      .from('m15_structure_watch')
      .upsert(rows, { onConflict: 'instrument' });
    if (error && /validation_started_at|trigger_ref/.test(error.message)) {
      // Columns not migrated yet — run supabase/migration_structure_validation.sql
      console.warn('[STRUCT] validation_started_at/trigger_ref columns missing — apply migration_structure_validation.sql. Saving without per-pair clock.');
      const stripped = rows.map(({ validation_started_at, trigger_ref, ...rest }) => rest);
      ({ error } = await supabase.from('m15_structure_watch').upsert(stripped, { onConflict: 'instrument' }));
    }
    if (error) console.error('[STRUCT] Upsert error:', error.message);
  }

  const validating = results.filter(r => r.state === 'VALIDATING');
  const approved = results.filter(r => r.state === 'APPROVED');
  const entry = results.filter(r => r.state === 'ENTRY');
  const removed = results.filter(r => r.state === 'REMOVED');
  console.log(`[STRUCT] ${validating.length} VALIDATING, ${approved.length} APPROVED, ${entry.length} ENTRY, ${removed.length} REMOVED, ${results.length} total`);

  return results;
}

// ─── Main entry point ────────────────────────────────────────────────────────

async function runCompressionBreakout() {
  const baseline = await updateCompressionBaseline();
  const structures = await updateM15StructureWatch();
  return { baseline, structures };
}

module.exports = { runCompressionBreakout, updateCompressionBaseline, updateM15StructureWatch };
