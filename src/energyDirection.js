'use strict';

/**
 * Energy Direction Engine — Energy-driven currency direction & pair monitoring
 *
 * Runs each pipeline cycle (after session_activity + m15_spreads + flow_performance).
 *
 * System flow:
 *   1. Energy trigger: single H1 hourly bar with energy ≥ 55.
 *      The LATEST qualifying bar becomes the active trigger.
 *   2. Currencies with aligned 3H + 6H → confirmed STRONG or WEAK
 *   3. Pairs formed: one STRONG currency + one WEAK currency
 *   4. Direction PERSISTS even if 3H/6H temporarily diverges
 *   5. Direction only changes when NEW energy event fires (H1 or M15)
 *   6. M15 monitors for: PULLBACK → COMPRESSION → READY → ENTRY
 *   7. New energy events flagged as CONTINUATION or REVERSAL per currency
 *
 * DB tables:
 *   energy_currency_state  — current confirmed direction per currency (8 rows max)
 *   energy_signal_pairs    — active pairs with phase monitoring
 */

const { supabase } = require('./supabase');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const ENERGY_THRESHOLD_H1 = 50;
const FLOW_SPREAD_THRESHOLD = 20;  // 3H pair spread ≥ 20 pips
const FLOW_SPREAD_MIN_PAIRS = 1;   // At least 1 pair must qualify

const VALID_PAIRS = new Set([
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
]);

function getSession(utcHour) {
  if (utcHour >= 23 || utcHour < 7)  return 'ASIA';
  if (utcHour >= 7  && utcHour < 13) return 'LONDON';
  if (utcHour >= 13 && utcHour < 21) return 'NEW_YORK';
  return 'LOW_LIQUIDITY';
}

/**
 * Determine phase for a pair based on M15 behavior relative to flow direction.
 *
 * Phase transitions:
 *   MONITORING  → pair just formed, watching M15
 *   PULLBACK   → M15 retraces against flow direction
 *   COMPRESSION → after pullback, M15 range tightens (low |v45|)
 *   ENTRY       → after compression/pullback, momentum returns in flow direction (trade now)
 *   MOVING      → strong confirmation: M15 + 3H aligned + impulse (already moving, late entry)
 */
function detectPhase(prevPhase, dir, v45, v90, spread3h, impulseScore, impulseAligned, deCombo) {
  const flowSign = dir === 'BUY' ? 1 : -1;
  const v45Dir = v45 * flowSign;  // positive = with flow, negative = against
  const v90Dir = v90 * flowSign;
  const h3Dir = spread3h * flowSign;
  const absV45 = Math.abs(v45);

  // MOVING: only reachable FROM ENTRY — strong multi-TF confirmation (already in motion)
  if (prevPhase === 'ENTRY' && v45Dir > 0.00008 && h3Dir > 0 && impulseAligned && impulseScore >= 40 && deCombo >= 35) {
    return 'MOVING';
  }

  // ENTRY: momentum returning in flow direction (trade now)
  // Can be reached from PULLBACK, COMPRESSION, or directly when conditions are strong
  if ((prevPhase === 'PULLBACK' || prevPhase === 'COMPRESSION') && v45Dir > 0.00005 && h3Dir > 0) {
    return 'ENTRY';
  }

  // ENTRY from fresh strong push (any non-ENTRY/MOVING phase)
  if (prevPhase !== 'ENTRY' && prevPhase !== 'MOVING' && v45Dir > 0.00008 && h3Dir > 0 && impulseAligned && impulseScore >= 40) {
    return 'ENTRY';
  }

  // Also detect ENTRY from M15 acceleration after any non-entry phase
  if (prevPhase !== 'MONITORING' && prevPhase !== 'ENTRY' && prevPhase !== 'MOVING' && v45Dir > 0.00010 && absV45 > Math.abs(v90) * 1.05) {
    return 'ENTRY';
  }

  // COMPRESSION: low M15 movement after pullback
  if ((prevPhase === 'PULLBACK' || prevPhase === 'COMPRESSION') && absV45 < 0.00005) {
    return 'COMPRESSION';
  }

  // PULLBACK: M15 moving against flow direction
  if (v45Dir < -0.00003 && prevPhase !== 'MOVING') {
    return 'PULLBACK';
  }

  // If we had ENTRY/MOVING and conditions fade, go back to monitoring
  if (prevPhase === 'MOVING' && (v45Dir < 0 || !impulseAligned || impulseScore < 25)) {
    return 'MONITORING';
  }

  if (prevPhase === 'ENTRY' && v45Dir < 0.00003) {
    return 'MONITORING';
  }

  // Default: keep current phase or stay in MONITORING
  return prevPhase || 'MONITORING';
}

/**
 * Main pipeline function: calculate energy-driven directions and pair signals.
 */
async function calculateEnergyDirection() {
  const now = new Date();
  const session = getSession(now.getUTCHours());

  // ── 1. Get current market energy ───────────────────────────────────────────
  const todayStr = now.toISOString().slice(0, 10);

  // Try today's sessions, fall back to most recent
  let { data: energySessions, error: esErr } = await supabase
    .from('market_energy_sessions')
    .select('session_name, market_energy, details')
    .eq('session_date', todayStr)
    .order('session_name', { ascending: true });

  if (esErr) console.warn('[ENERGY_DIR] Energy session fetch:', esErr.message);

  if (!energySessions?.length) {
    const { data: latest } = await supabase
      .from('market_energy_sessions')
      .select('session_date')
      .order('session_date', { ascending: false })
      .limit(1);
    const fallbackDate = latest?.[0]?.session_date;
    if (!fallbackDate) {
      console.log('[ENERGY_DIR] No energy data available');
      return { pairs: 0 };
    }
    const { data: fb } = await supabase
      .from('market_energy_sessions')
      .select('session_name, market_energy, details')
      .eq('session_date', fallbackDate);
    energySessions = fb || [];
  }

  // Scan ALL hourly bars across today's sessions to find the LAST bar that
  // crossed ≥ threshold. This is the trigger bar — directions are snapshotted from
  // the strength at that moment and persist until a NEW bar crosses ≥ threshold.
  let currentEnergy = 0;  // live session-level energy (for display)
  const allBars = [];     // every hourly bar with energy ≥ threshold

  for (const es of energySessions) {
    const sessEnergy = parseFloat(es.market_energy) || 0;

    // Track current session energy for display
    if (es.session_name === session && sessEnergy > currentEnergy) {
      currentEnergy = sessEnergy;
    }

    // Collect hourly bars that crossed the threshold
    const hourly = es.details?.hourly || [];
    for (const h of hourly) {
      const hEnergy = parseFloat(h.market_energy) || 0;
      if (hEnergy >= ENERGY_THRESHOLD_H1) {
        allBars.push({ energy: hEnergy, time: h.time, session: es.session_name });
      }
    }
  }

  // Sort by time descending — the LAST bar to cross ≥ threshold is the trigger
  allBars.sort((a, b) => new Date(b.time) - new Date(a.time));
  const triggerBar = allBars[0] || null;

  const triggerEnergy = triggerBar ? triggerBar.energy : 0;
  const triggerSession = triggerBar ? triggerBar.session : null;
  const triggerHour = triggerBar ? triggerBar.time : null;

  // If current session didn't have data, use trigger energy for display
  if (!currentEnergy) currentEnergy = triggerEnergy;

  console.log(`[ENERGY_DIR] Current energy: ${currentEnergy} | Trigger bar: ${triggerEnergy} [H1] (${triggerSession}${triggerHour ? ' @ ' + triggerHour : ''})`);

  // ── 2. Fetch latest currency strength (3H + 6H + 12H) ──────────────────────
  const { data: csRows, error: csErr } = await supabase
    .from('currency_strength')
    .select('currency, smooth_3h, smooth_6h, smooth_12h')
    .order('time', { ascending: false })
    .limit(8);

  if (csErr) throw new Error(`Energy dir strength fetch: ${csErr.message}`);
  if (!csRows?.length) {
    console.log('[ENERGY_DIR] No strength data');
    return { pairs: 0 };
  }

  const ccyMap = {};
  const seen = new Set();
  for (const r of csRows) {
    if (seen.has(r.currency)) continue;
    seen.add(r.currency);
    ccyMap[r.currency] = {
      smooth_3h: parseFloat(r.smooth_3h) || 0,
      smooth_6h: parseFloat(r.smooth_6h) || 0,
      smooth_12h: parseFloat(r.smooth_12h) || 0,
    };
  }

  // ── 2b. Count flow spread pairs (3H spread ≥ 20 pips) ───────────────────────
  let flowSpreadCount = 0;
  for (const inst of VALID_PAIRS) {
    const [base, quote] = inst.split('_');
    const bVal = ccyMap[base]?.smooth_3h || 0;
    const qVal = ccyMap[quote]?.smooth_3h || 0;
    const spreadPips = Math.abs(bVal - qVal) * 10000;
    if (spreadPips >= FLOW_SPREAD_THRESHOLD) flowSpreadCount++;
  }
  const flowSpreadMet = flowSpreadCount >= FLOW_SPREAD_MIN_PAIRS;
  console.log(`[ENERGY_DIR] Flow spread: ${flowSpreadCount} pairs ≥ ${FLOW_SPREAD_THRESHOLD}p (need ${FLOW_SPREAD_MIN_PAIRS}) → ${flowSpreadMet ? 'MET' : 'NOT MET'}`);

  // ── 3. Load existing currency state ────────────────────────────────────────
  const { data: existingState } = await supabase
    .from('energy_currency_state')
    .select('*');

  const stateMap = {};
  for (const s of (existingState || [])) {
    stateMap[s.currency] = s;
  }

  // ── 4. Load existing signal pairs ──────────────────────────────────────────
  const { data: existingPairs } = await supabase
    .from('energy_signal_pairs')
    .select('*')
    .eq('active', true);

  const pairMap = {};
  for (const p of (existingPairs || [])) {
    pairMap[p.instrument] = p;
  }

  // ── 5. Evaluate energy threshold (H1 only) ─────────────────────────────────
  const energyMet = triggerEnergy >= ENERGY_THRESHOLD_H1;
  const thresholdMet = energyMet && flowSpreadMet;
  if (energyMet && !flowSpreadMet) {
    console.log(`[ENERGY_DIR] Energy ${triggerEnergy} ≥ ${ENERGY_THRESHOLD_H1} but flow spread NOT met (${flowSpreadCount}/${FLOW_SPREAD_MIN_PAIRS}) — directions NOT confirmed`);
  }

  // Check if this is a NEW energy event by comparing trigger bar time against
  // the stored triggered_at. A new bar crossing ≥ threshold AFTER the stored trigger
  // time means we must re-evaluate directions with fresh strength.
  const prevTriggeredAt = Object.values(stateMap)
    .filter(s => s.active && s.triggered_at)
    .map(s => new Date(s.triggered_at).getTime())
    .sort((a, b) => b - a)[0] || 0;

  const triggerBarTime = triggerHour ? new Date(triggerHour).getTime() : 0;
  const hasActiveDirections = Object.values(stateMap).some(s => s.active);
  const isNewEnergyEvent = thresholdMet && (
    !hasActiveDirections ||                    // no directions exist yet
    (triggerBarTime > prevTriggeredAt)          // new bar is newer than last trigger
  );

  let currencyUpdates = [];
  let newPairs = [];

  if (isNewEnergyEvent) {
    // ── 6. NEW energy event — snapshot currencies from CURRENT strength ────
    // This is the ONLY time directions are evaluated. Strength values are
    // locked in and persist until the next bar crosses ≥ threshold.
    const strong = [];
    const weak = [];

    for (const ccy of CURRENCIES) {
      const d = ccyMap[ccy];
      if (!d) continue;

      const h3 = d.smooth_3h;
      const h6 = d.smooth_6h;

      // Both must agree on direction (same sign) with meaningful magnitude
      if (h3 > 0.00005 && h6 > 0.00005) {
        strong.push({ currency: ccy, h3, h6, score: h3 + h6 });
      } else if (h3 < -0.00005 && h6 < -0.00005) {
        weak.push({ currency: ccy, h3, h6, score: Math.abs(h3 + h6) });
      }
    }

    strong.sort((a, b) => b.score - a.score);
    weak.sort((a, b) => b.score - a.score);

    console.log(`[ENERGY_DIR] ═══ NEW ENERGY EVENT — H1 bar ${triggerEnergy} @ ${triggerHour} (${triggerSession}) ═══`);

    // ── 7. Snapshot currency directions with trigger-time strength ─────────
    const newDirections = new Map();
    const strengthSnapshot = new Map(); // lock in the values at trigger time
    for (const s of strong) {
      newDirections.set(s.currency, 'STRONG');
      strengthSnapshot.set(s.currency, { h3: s.h3, h6: s.h6 });
    }
    for (const w of weak) {
      newDirections.set(w.currency, 'WEAK');
      strengthSnapshot.set(w.currency, { h3: w.h3, h6: w.h6 });
    }

    for (const ccy of CURRENCIES) {
      const newDir = newDirections.get(ccy) || 'NEUTRAL';
      const prev = stateMap[ccy];
      const prevDir = prev?.direction || 'NEUTRAL';
      const snap = strengthSnapshot.get(ccy) || { h3: ccyMap[ccy]?.smooth_3h || 0, h6: ccyMap[ccy]?.smooth_6h || 0 };

      let energyEventType = null;
      if (prev?.active && newDir !== 'NEUTRAL') {
        energyEventType = (newDir === prevDir) ? 'CONTINUATION' : 'REVERSAL';
      } else if (prev?.active && newDir === 'NEUTRAL') {
        energyEventType = 'DROPPED';   // was active, now neutral
      } else if (newDir !== 'NEUTRAL') {
        energyEventType = 'NEW';        // wasn't active before
      }
      // else: was neutral, still neutral → no event type

      // Log per-currency change
      if (energyEventType === 'CONTINUATION') {
        console.log(`[ENERGY_DIR]   ${ccy}: ${newDir} → CONTINUE (was ${prevDir}, still ${newDir})`);
      } else if (energyEventType === 'REVERSAL') {
        console.log(`[ENERGY_DIR]   ${ccy}: ${newDir} → REVERSAL (was ${prevDir}, now ${newDir})`);
      } else if (energyEventType === 'DROPPED') {
        console.log(`[ENERGY_DIR]   ${ccy}: NEUTRAL → DROPPED (was ${prevDir})`);
      } else if (energyEventType === 'NEW') {
        console.log(`[ENERGY_DIR]   ${ccy}: ${newDir} → NEW (was ${prevDir || 'inactive'})`);
      }

      currencyUpdates.push({
        currency: ccy,
        direction: newDir,
        smooth_3h: snap.h3,           // snapshot at trigger time — locked
        smooth_6h: snap.h6,           // snapshot at trigger time — locked
        energy_at_trigger: triggerEnergy,
        trigger_session: triggerSession,
        triggered_at: triggerHour || now.toISOString(),  // use bar time, not "now"
        threshold_met: true,
        active: newDir !== 'NEUTRAL',
        energy_event_type: energyEventType,
      });
    }

    // ── 8. Form pairs from snapshotted directions (spread ≥ 30p only) ─────
    for (const s of strong) {
      for (const w of weak) {
        const fwd = `${s.currency}_${w.currency}`;
        const rev = `${w.currency}_${s.currency}`;
        let instrument, dir;
        if (VALID_PAIRS.has(fwd)) {
          instrument = fwd; dir = 'BUY';
        } else if (VALID_PAIRS.has(rev)) {
          instrument = rev; dir = 'SELL';
        } else continue;

        // Only include pairs with 12H currency spread ≥ 30 pips
        const [base, quote] = instrument.split('_');
        const spreadPips = Math.abs((ccyMap[base]?.smooth_12h || 0) - (ccyMap[quote]?.smooth_12h || 0)) * 10000;
        if (spreadPips < 20) continue;

        // Determine if this pair is new, continuing, or reversed
        const prevPair = pairMap[instrument];
        let pairEventType = 'NEW';
        if (prevPair?.active) {
          pairEventType = (prevPair.dir === dir) ? 'CONTINUATION' : 'REVERSAL';
        }

        console.log(`[ENERGY_DIR]   ${instrument.replace('_','/')} ${dir} (${s.currency}↑ ${w.currency}↓) → ${pairEventType}${pairEventType === 'REVERSAL' ? ` (was ${prevPair.dir})` : ''}`);

        newPairs.push({
          instrument, dir,
          strong_ccy: s.currency,
          weak_ccy: w.currency,
          trigger_energy: triggerEnergy,
          trigger_session: triggerSession,
          triggered_at: triggerHour || now.toISOString(),
        });
      }
    }

    // Log pairs that will be removed (were active, not in new set)
    const newPairInstruments = new Set(newPairs.map(p => p.instrument));
    for (const p of (existingPairs || [])) {
      if (p.active && !newPairInstruments.has(p.instrument)) {
        console.log(`[ENERGY_DIR]   ${p.instrument.replace('_','/')} ${p.dir} → REMOVED (${p.strong_ccy}↑ ${p.weak_ccy}↓ no longer valid)`);
      }
    }
  } else if (hasActiveDirections) {
    // ── Directions already locked — keep them unchanged ──────────────────
    // No re-evaluation of strong/weak. Strength values stay as snapshotted.
    // Only M15 phase data gets updated (handled below in section 9–10).
    console.log(`[ENERGY_DIR] Directions locked. No new energy bar since last trigger — keeping existing directions & pairs.`);

    // Keep existing currency states exactly as they are — don't touch anything
    // (no currencyUpdates needed, they won't be upserted)

    // Keep existing active pairs for M15 phase updates (only if spread still ≥ 30p)
    for (const p of (existingPairs || [])) {
      if (p.active) {
        const [base, quote] = p.instrument.split('_');
        const spreadPips = Math.abs((ccyMap[base]?.smooth_12h || 0) - (ccyMap[quote]?.smooth_12h || 0)) * 10000;
        if (spreadPips < 20) {
          console.log(`[ENERGY_DIR]   ${p.instrument.replace('_','/')} ${p.dir} → REMOVED (12H spread ${spreadPips.toFixed(1)}p < 20p)`);
          continue;
        }
        newPairs.push({
          instrument: p.instrument,
          dir: p.dir,
          strong_ccy: p.strong_ccy,
          weak_ccy: p.weak_ccy,
          trigger_energy: p.trigger_energy,
          trigger_session: p.trigger_session,
          triggered_at: p.triggered_at,
        });
      }
    }
  } else {
    // No threshold met and no existing directions — nothing to do
    console.log(`[ENERGY_DIR] Energy below threshold (trigger: ${triggerEnergy}). No existing directions.`);
  }

  // ── 9. Fetch M15 data for all active pairs ─────────────────────────────────
  const pairInstruments = newPairs.map(p => p.instrument);

  let m15Map = {};
  if (pairInstruments.length) {
    const { data: m15Rows } = await supabase
      .from('m15_pair_spreads')
      .select('instrument, smooth_45m, smooth_90m, smooth_180m, de_combined, state, impulse_score, impulse_dir')
      .in('instrument', pairInstruments)
      .order('time', { ascending: false })
      .limit(pairInstruments.length * 2);

    for (const r of (m15Rows || [])) {
      if (!m15Map[r.instrument]) m15Map[r.instrument] = r;
    }
  }

  // Also get 3H/6H/12H spreads for pairs — use LIVE strength for monitoring
  // (phase detection and signal entry gates need current market conditions)
  // but fall back to snapshotted values if live data is missing
  let spreadMap = {};
  if (pairInstruments.length) {
    for (const inst of pairInstruments) {
      const [base, quote] = inst.split('_');
      const h3base = ccyMap[base]?.smooth_3h || 0;
      const h3quote = ccyMap[quote]?.smooth_3h || 0;
      const h6base = ccyMap[base]?.smooth_6h || 0;
      const h6quote = ccyMap[quote]?.smooth_6h || 0;
      const h12base = ccyMap[base]?.smooth_12h || 0;
      const h12quote = ccyMap[quote]?.smooth_12h || 0;
      spreadMap[inst] = {
        spread_3h: h3base - h3quote,
        spread_6h: h6base - h6quote,
        spread_12h: h12base - h12quote,
      };
    }
  }

  // ── 10. Update phases for each pair ────────────────────────────────────────
  const pairRows = newPairs.map(p => {
    const m15 = m15Map[p.instrument];
    const sp = spreadMap[p.instrument] || {};
    const prev = pairMap[p.instrument];

    const v45 = m15 ? parseFloat(m15.smooth_45m) || 0 : 0;
    const v90 = m15 ? parseFloat(m15.smooth_90m) || 0 : 0;
    const deCombo = m15 ? parseFloat(m15.de_combined) || 0 : 0;
    const impulseScore = m15 ? (m15.impulse_score || 0) : 0;
    const impulseDir = m15 ? (m15.impulse_dir || 0) : 0;
    const flowSign = p.dir === 'BUY' ? 1 : -1;
    const impulseAligned = impulseDir === flowSign;
    const m15State = m15?.state || 'FLAT';

    const prevPhase = prev?.phase || 'MONITORING';
    const phase = detectPhase(
      prevPhase, p.dir, v45, v90,
      sp.spread_3h || 0, impulseScore, impulseAligned, deCombo
    );

    // Detect new energy event for this specific pair
    let newEnergyEvent = false;
    let energyEventType = null;
    if (isNewEnergyEvent) {
      newEnergyEvent = true;
      if (prev?.active) {
        energyEventType = prev.dir === p.dir ? 'CONTINUATION' : 'REVERSAL';
      } else {
        energyEventType = 'NEW';
      }
    }

    return {
      instrument: p.instrument,
      dir: p.dir,
      strong_ccy: p.strong_ccy,
      weak_ccy: p.weak_ccy,
      phase,
      phase_changed_at: phase !== prevPhase ? now.toISOString() : (prev?.phase_changed_at || now.toISOString()),
      trigger_energy: p.trigger_energy,
      trigger_session: p.trigger_session,
      triggered_at: p.triggered_at || now.toISOString(),
      v45: Math.round(v45 * 100000) / 100000,
      v90: Math.round(v90 * 100000) / 100000,
      spread_3h: Math.round((sp.spread_3h || 0) * 100000) / 100000,
      spread_6h: Math.round((sp.spread_6h || 0) * 100000) / 100000,
      spread_12h: Math.round((sp.spread_12h || 0) * 100000) / 100000,
      de_combined: Math.round(deCombo * 100) / 100,
      impulse_score: impulseScore,
      impulse_aligned: impulseAligned,
      m15_state: m15State,
      new_energy_event: newEnergyEvent,
      energy_event_type: energyEventType,
      energy_level: p.trigger_energy || triggerEnergy,
      active: true,
      last_updated: now.toISOString(),
    };
  });

  // ── 11. Deactivate pairs no longer in the set ──────────────────────────────
  const activeInstruments = new Set(pairRows.map(p => p.instrument));
  const toDeactivate = (existingPairs || [])
    .filter(p => p.active && !activeInstruments.has(p.instrument))
    .map(p => p.instrument);

  // ── 12. Upsert to DB ──────────────────────────────────────────────────────
  if (currencyUpdates.length) {
    const { error } = await supabase
      .from('energy_currency_state')
      .upsert(currencyUpdates, { onConflict: 'currency', ignoreDuplicates: false });
    if (error) console.error('[ENERGY_DIR] Currency state upsert:', error.message);
  }

  if (pairRows.length) {
    const { error } = await supabase
      .from('energy_signal_pairs')
      .upsert(pairRows, { onConflict: 'instrument', ignoreDuplicates: false });
    if (error) console.error('[ENERGY_DIR] Pair upsert:', error.message);
  }

  if (toDeactivate.length) {
    const { error } = await supabase
      .from('energy_signal_pairs')
      .update({ active: false, last_updated: now.toISOString() })
      .in('instrument', toDeactivate);
    if (error) console.error('[ENERGY_DIR] Deactivate:', error.message);
  }

  const phases = {};
  for (const p of pairRows) phases[p.phase] = (phases[p.phase] || 0) + 1;
  console.log(`[ENERGY_DIR] ${pairRows.length} pairs | Trigger: ${triggerEnergy} (${triggerSession || 'none'}) | New event: ${isNewEnergyEvent} | Phases: ${JSON.stringify(phases)}`);

  return {
    energy: currentEnergy,
    thresholdMet,
    isNewEnergyEvent,
    pairs: pairRows.length,
    deactivated: toDeactivate.length,
  };
}

module.exports = { calculateEnergyDirection };
