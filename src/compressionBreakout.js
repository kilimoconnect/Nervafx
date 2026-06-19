'use strict';

/**
 * Trade Approval — M15 Strength Alignment Entry
 *
 * Lifecycle (per signal pair):
 *   1. WAITING:   Pair confirmed, waiting for eligible session + M15 alignment + H1 breakout
 *   2. ENTRY:     All three conditions met
 *   3. REMOVED:   Slot expired or direction no longer holds
 *
 * Entry gate (all required):
 *   - Session eligible (next session after direction confirmation)
 *   - M15 currency strength aligned (strong ccy > 0, weak ccy < 0)
 *   - H1 breakout: BUY = H1 close > previous H1 high, SELL = H1 close < previous H1 low
 *
 * DB tables:
 *   m15_structure_watch  — per-pair trade state tracking
 *   compression_baseline — kept for backward compat
 */

const { supabase } = require('./supabase');

const SESSION_ORDER = { ASIA: 0, LONDON: 1, NEW_YORK: 2 };

function getSession(utcHour) {
  if (utcHour >= 23 || utcHour < 7)  return 'ASIA';
  if (utcHour >= 7  && utcHour < 13) return 'LONDON';
  if (utcHour >= 13 && utcHour < 21) return 'NEW_YORK';
  return 'LOW_LIQUIDITY';
}

function getSessionDate(now, session) {
  const d = new Date(now);
  if (session === 'ASIA' && d.getUTCHours() === 23) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

function sessionNum(dateStr, session) {
  if (!dateStr || !session) return 0;
  const d = new Date(dateStr + 'T12:00:00Z');
  const days = Math.floor(d.getTime() / 86400000);
  return days * 3 + (SESSION_ORDER[session] || 0);
}

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

// ─── M15 Strength Alignment Entry ──────────────────────────────────────────

async function updateM15StructureWatch() {
  const now = new Date();
  const currSession = getSession(now.getUTCHours());

  if (currSession === 'LOW_LIQUIDITY') {
    console.log('[STRUCT] Low liquidity — skipping');
    return [];
  }

  const currDate = getSessionDate(now, currSession);
  const currSessNum = sessionNum(currDate, currSession);

  const { data: signalPairs } = await supabase
    .from('energy_signal_pairs')
    .select('instrument, dir, strong_ccy, weak_ccy, triggered_at, slot, entry_eligible_session, entry_eligible_date')
    .eq('active', true);

  if (!signalPairs?.length) {
    console.log('[STRUCT] No active signal pairs — deactivating all');
    const { data: existingWatch } = await supabase
      .from('m15_structure_watch')
      .select('*');
    const toDeactivate = (existingWatch || []).filter(w => w.state !== 'INACTIVE');
    if (toDeactivate.length) {
      const rows = toDeactivate.map(w => ({ ...w, state: 'INACTIVE', updated_at: now.toISOString() }));
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

  // Fetch latest M15 currency strength for alignment check
  const { data: m15CsRows } = await supabase
    .from('m15_currency_strength')
    .select('time, values')
    .order('time', { ascending: false })
    .limit(1);

  const m15Vals = m15CsRows?.[0]?.values || {};

  // Fetch latest M15 candle per instrument for entry price
  const instruments = signalPairs.map(p => p.instrument);
  const m15Map = {};
  if (instruments.length) {
    const { data: m15Candles } = await supabase
      .from('backtest_candles')
      .select('instrument, time, open, high, low, close')
      .in('instrument', instruments)
      .eq('timeframe', 'M15')
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(instruments.length * 2);
    for (const c of (m15Candles || [])) {
      if (!m15Map[c.instrument]) {
        m15Map[c.instrument] = {
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        };
      }
    }
  }

  // Fetch last 2 complete H1 candles per instrument for breakout check + SL
  const h1Map = {};
  if (instruments.length) {
    const { data: h1Candles } = await supabase
      .from('backtest_candles')
      .select('instrument, time, open, high, low, close')
      .in('instrument', instruments)
      .eq('timeframe', 'H1')
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(instruments.length * 2);
    for (const c of (h1Candles || [])) {
      if (!h1Map[c.instrument]) h1Map[c.instrument] = [];
      if (h1Map[c.instrument].length < 2) {
        h1Map[c.instrument].push({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        });
      }
    }
  }

  const results = [];

  for (const sp of signalPairs) {
    const existing = watchMap[sp.instrument] || null;
    const trigRef = sp.triggered_at || null;
    const latest = m15Map[sp.instrument];
    if (!latest) continue;

    // Check session eligibility: entry starts NEXT session after confirmation
    const eligibleSession = sp.entry_eligible_session;
    const eligibleDate = sp.entry_eligible_date;
    const eligibleNum = sessionNum(eligibleDate, eligibleSession);
    const isEligible = currSessNum >= eligibleNum;

    // Check M15 strength alignment
    const m15Strong = m15Vals[sp.strong_ccy] || 0;
    const m15Weak = m15Vals[sp.weak_ccy] || 0;
    const m15Aligned = m15Strong > 0 && m15Weak < 0;

    // Determine pair state
    const isNew = !existing || existing.state === 'INACTIVE';
    const isReversal = !isNew && existing.direction !== sp.dir;
    const isNewEvent = !isNew && trigRef && existing.trigger_ref !== trigRef;

    let entry;
    if (isNew || isReversal || (isNewEvent && existing.state === 'REMOVED')) {
      const reason = isNew ? 'NEW' : isReversal ? 'REVERSAL' : 'NEW EVENT';
      entry = {
        instrument: sp.instrument,
        direction: sp.dir,
        state: 'WAITING',
        impulse_high: latest.high,
        impulse_low: latest.low,
        pullback_high: null,
        pullback_low: null,
        entry_price: null,
        invalidation_price: null,
        validation_started_at: now.toISOString(),
        trigger_ref: trigRef,
      };
      console.log(`[STRUCT] ${sp.instrument} ${sp.dir} → WAITING (${reason}, eligible: ${eligibleSession} ${eligibleDate})`);
    } else {
      entry = { ...existing };
      if (isNewEvent) entry.trigger_ref = trigRef;
    }

    // ── State machine: WAITING → ENTRY ──
    // Requires: eligible session + M15 aligned + H1 breakout
    // H1 breakout: BUY = latest H1 close > previous H1 high
    //              SELL = latest H1 close < previous H1 low

    const h1Candles = h1Map[sp.instrument] || [];
    const h1Latest = h1Candles[0];
    const h1Prev = h1Candles[1];
    let h1Breakout = false;
    if (h1Latest && h1Prev) {
      if (sp.dir === 'BUY') {
        h1Breakout = h1Latest.close > h1Prev.high;
      } else {
        h1Breakout = h1Latest.close < h1Prev.low;
      }
    }

    if (entry.state === 'WAITING' && isEligible && m15Aligned && h1Breakout) {
        // SL from last 2 H1 candles
        const sl = sp.dir === 'BUY'
          ? Math.min(...h1Candles.map(c => c.low))
          : Math.max(...h1Candles.map(c => c.high));

        entry.state = 'ENTRY';
        entry.entry_price = latest.close;
        entry.invalidation_price = sl;
        console.log(`[STRUCT] ${sp.instrument} ${sp.dir} ENTRY — M15 aligned (${sp.strong_ccy}: ${m15Strong.toFixed(4)}, ${sp.weak_ccy}: ${m15Weak.toFixed(4)}) + H1 breakout (close ${h1Latest.close.toFixed(5)} ${sp.dir === 'BUY' ? '>' : '<'} prev ${sp.dir === 'BUY' ? h1Prev.high.toFixed(5) : h1Prev.low.toFixed(5)}) | Price: ${latest.close.toFixed(5)} | SL: ${sl.toFixed(5)}`);
    } else if (entry.state === 'WAITING' && isEligible && m15Aligned && !h1Breakout && h1Latest && h1Prev) {
        console.log(`[STRUCT] ${sp.instrument} ${sp.dir} WAITING — M15 aligned but no H1 breakout (close ${h1Latest.close.toFixed(5)} ${sp.dir === 'BUY' ? '<=' : '>='} prev ${sp.dir === 'BUY' ? h1Prev.high.toFixed(5) : h1Prev.low.toFixed(5)})`);
    }

    results.push(entry);
  }

  // Deactivate pairs no longer in signal set (preserve ENTRY)
  const activeInstruments = new Set(signalPairs.map(p => p.instrument));
  const preserveStates = new Set(['ENTRY']);
  for (const w of (existingWatch || [])) {
    if (!activeInstruments.has(w.instrument) && w.state !== 'INACTIVE' && !preserveStates.has(w.state)) {
      console.log(`[STRUCT] ${w.instrument} removed from signal set — INACTIVE`);
      results.push({ ...w, state: 'INACTIVE', updated_at: now.toISOString() });
    }
  }

  // Upsert all
  if (results.length) {
    const rows = results.map(r => ({ ...r, updated_at: now.toISOString() }));
    let { error } = await supabase
      .from('m15_structure_watch')
      .upsert(rows, { onConflict: 'instrument' });
    if (error && /validation_started_at|trigger_ref/.test(error.message)) {
      console.warn('[STRUCT] Missing columns — apply migration. Saving without per-pair fields.');
      const stripped = rows.map(({ validation_started_at, trigger_ref, ...rest }) => rest);
      ({ error } = await supabase.from('m15_structure_watch').upsert(stripped, { onConflict: 'instrument' }));
    }
    if (error) console.error('[STRUCT] Upsert error:', error.message);
  }

  const waiting = results.filter(r => r.state === 'WAITING');
  const entries = results.filter(r => r.state === 'ENTRY');
  const removed = results.filter(r => r.state === 'REMOVED');
  console.log(`[STRUCT] ${waiting.length} WAITING, ${entries.length} ENTRY, ${removed.length} REMOVED, ${results.length} total`);

  return results;
}

async function runCompressionBreakout() {
  const baseline = await updateCompressionBaseline();
  const structures = await updateM15StructureWatch();
  return { baseline, structures };
}

module.exports = { runCompressionBreakout, updateCompressionBaseline, updateM15StructureWatch };
