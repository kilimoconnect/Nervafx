'use strict';

/**
 * Energy Direction Engine — Energy-driven currency direction & pair monitoring
 *
 * Runs each pipeline cycle (after session_activity + m15_spreads + flow_performance).
 *
 * System flow:
 *   1. Market Energy ≥ 50 → triggers direction evaluation
 *   2. Currencies with aligned 3H + 6H → confirmed STRONG or WEAK
 *   3. Pairs formed: one STRONG currency + one WEAK currency
 *   4. Direction PERSISTS even if 3H/6H temporarily diverges
 *   5. Direction only changes when NEW energy ≥ 50 event fires
 *   6. M15 monitors for: PULLBACK → COMPRESSION → READY → ENTRY
 *   7. New energy events flagged as CONTINUATION or REVERSAL per currency
 *
 * DB tables:
 *   energy_currency_state  — current confirmed direction per currency (8 rows max)
 *   energy_signal_pairs    — active pairs with phase monitoring
 */

const { supabase } = require('./supabase');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const ENERGY_THRESHOLD = 50;

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
 *   READY       → after compression/pullback, momentum returns in flow direction
 *   ENTRY       → strong confirmation: M15 + 3H aligned + impulse
 */
function detectPhase(prevPhase, dir, v45, v90, spread3h, impulseScore, impulseAligned, deCombo) {
  const flowSign = dir === 'BUY' ? 1 : -1;
  const v45Dir = v45 * flowSign;  // positive = with flow, negative = against
  const v90Dir = v90 * flowSign;
  const h3Dir = spread3h * flowSign;
  const absV45 = Math.abs(v45);

  // ENTRY: strong multi-timeframe confirmation
  if (v45Dir > 0.00008 && h3Dir > 0 && impulseAligned && impulseScore >= 40 && deCombo >= 35) {
    return 'ENTRY';
  }

  // READY: momentum returning in flow direction after pullback/compression
  if ((prevPhase === 'PULLBACK' || prevPhase === 'COMPRESSION') && v45Dir > 0.00005 && h3Dir > 0) {
    return 'READY';
  }

  // Also detect READY from fresh 3H push or M15 push after any non-entry phase
  if (prevPhase !== 'MONITORING' && v45Dir > 0.00010 && absV45 > Math.abs(v90) * 1.05) {
    return 'READY';
  }

  // COMPRESSION: low M15 movement after pullback
  if ((prevPhase === 'PULLBACK' || prevPhase === 'COMPRESSION') && absV45 < 0.00005) {
    return 'COMPRESSION';
  }

  // PULLBACK: M15 moving against flow direction
  if (v45Dir < -0.00003 && prevPhase !== 'ENTRY') {
    return 'PULLBACK';
  }

  // If we had READY/ENTRY and conditions fade, go back to monitoring
  if (prevPhase === 'ENTRY' && (v45Dir < 0 || !impulseAligned || impulseScore < 25)) {
    return 'MONITORING';
  }

  if (prevPhase === 'READY' && v45Dir < 0.00003) {
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

  // Scan ALL hourly bars across today's sessions to find the best energy
  // that crossed the threshold. Direction is set by the peak bar, not just
  // the current one — once set, direction persists.
  let currentEnergy = 0;  // live session-level energy (for display)
  let peakEnergy = 0;     // highest hourly energy today
  let peakSession = null;
  let peakHour = null;

  for (const es of energySessions) {
    const sessEnergy = parseFloat(es.market_energy) || 0;

    // Track current session energy for display
    if (es.session_name === session && sessEnergy > currentEnergy) {
      currentEnergy = sessEnergy;
    }

    // Scan hourly bars inside this session's details
    const hourly = es.details?.hourly || [];
    for (const h of hourly) {
      const hEnergy = parseFloat(h.market_energy) || 0;
      if (hEnergy > peakEnergy) {
        peakEnergy = hEnergy;
        peakSession = es.session_name;
        peakHour = h.time;
      }
    }

    // Also consider the session-level average as a bar
    if (sessEnergy > peakEnergy) {
      peakEnergy = sessEnergy;
      peakSession = es.session_name;
    }
  }

  // If current session didn't have data, use peak as current for display
  if (!currentEnergy) currentEnergy = peakEnergy;

  console.log(`[ENERGY_DIR] Current energy: ${currentEnergy} | Peak today: ${peakEnergy} (${peakSession}${peakHour ? ' @ ' + peakHour : ''})`);

  // ── 2. Fetch latest currency strength (3H + 6H) ───────────────────────────
  const { data: csRows, error: csErr } = await supabase
    .from('currency_strength')
    .select('currency, smooth_3h, smooth_6h')
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
    };
  }

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

  // ── 5. Evaluate energy threshold ───────────────────────────────────────────
  // Use PEAK energy today — if any bar crossed the threshold, direction is set
  const thresholdMet = peakEnergy >= ENERGY_THRESHOLD;

  // Check if this is a NEW energy event (was below threshold, now above)
  const prevThresholdMet = Object.values(stateMap).some(s => s.active && s.threshold_met);
  const isNewEnergyEvent = thresholdMet && !prevThresholdMet;

  let currencyUpdates = [];
  let newPairs = [];

  if (thresholdMet) {
    // ── 6. Identify aligned currencies (3H and 6H same direction) ──────────
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

    // Sort by combined strength/weakness
    strong.sort((a, b) => b.score - a.score);
    weak.sort((a, b) => b.score - a.score);

    console.log(`[ENERGY_DIR] Threshold met (${currentEnergy}). Strong: ${strong.map(s=>s.currency).join(',')} | Weak: ${weak.map(w=>w.currency).join(',')}`);

    // ── 7. Update currency directions ──────────────────────────────────────
    const newDirections = new Map();
    for (const s of strong) newDirections.set(s.currency, 'STRONG');
    for (const w of weak)   newDirections.set(w.currency, 'WEAK');

    for (const ccy of CURRENCIES) {
      const newDir = newDirections.get(ccy) || 'NEUTRAL';
      const prev = stateMap[ccy];
      const prevDir = prev?.direction || 'NEUTRAL';

      let energyEventType = null;
      if (isNewEnergyEvent && prev?.active) {
        energyEventType = (newDir === prevDir && newDir !== 'NEUTRAL') ? 'CONTINUATION' : 'REVERSAL';
      } else if (isNewEnergyEvent) {
        energyEventType = 'NEW';
      }

      currencyUpdates.push({
        currency: ccy,
        direction: newDir,
        smooth_3h: ccyMap[ccy]?.smooth_3h || 0,
        smooth_6h: ccyMap[ccy]?.smooth_6h || 0,
        energy_at_trigger: currentEnergy,
        trigger_session: energySession,
        triggered_at: now.toISOString(),
        threshold_met: true,
        active: newDir !== 'NEUTRAL',
        energy_event_type: energyEventType,
      });
    }

    // ── 8. Form pairs (strong × weak) ──────────────────────────────────────
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

        newPairs.push({
          instrument, dir,
          strong_ccy: s.currency,
          weak_ccy: w.currency,
          trigger_energy: currentEnergy,
          trigger_session: energySession,
        });
      }
    }
  } else {
    // Energy below threshold — keep existing directions (they persist)
    // Just update threshold_met flag
    for (const ccy of CURRENCIES) {
      const prev = stateMap[ccy];
      if (prev) {
        currencyUpdates.push({
          ...prev,
          threshold_met: false,
          smooth_3h: ccyMap[ccy]?.smooth_3h || prev.smooth_3h,
          smooth_6h: ccyMap[ccy]?.smooth_6h || prev.smooth_6h,
        });
      }
    }

    // Keep existing active pairs
    for (const p of (existingPairs || [])) {
      if (p.active) {
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

  // Also get 3H spreads for pairs
  let spreadMap = {};
  if (pairInstruments.length) {
    for (const inst of pairInstruments) {
      const [base, quote] = inst.split('_');
      const h3base = ccyMap[base]?.smooth_3h || 0;
      const h3quote = ccyMap[quote]?.smooth_3h || 0;
      const h6base = ccyMap[base]?.smooth_6h || 0;
      const h6quote = ccyMap[quote]?.smooth_6h || 0;
      spreadMap[inst] = {
        spread_3h: h3base - h3quote,
        spread_6h: h6base - h6quote,
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
    if (isNewEnergyEvent && prev?.active) {
      newEnergyEvent = true;
      // Check if direction stayed same
      energyEventType = prev.dir === p.dir ? 'CONTINUATION' : 'REVERSAL';
    } else if (isNewEnergyEvent && !prev) {
      newEnergyEvent = true;
      energyEventType = 'NEW';
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
      de_combined: Math.round(deCombo * 100) / 100,
      impulse_score: impulseScore,
      impulse_aligned: impulseAligned,
      m15_state: m15State,
      new_energy_event: newEnergyEvent,
      energy_event_type: energyEventType,
      energy_level: currentEnergy,
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
  console.log(`[ENERGY_DIR] ${pairRows.length} pairs | Energy: ${currentEnergy} | Phases: ${JSON.stringify(phases)}`);

  return {
    energy: currentEnergy,
    thresholdMet,
    isNewEnergyEvent,
    pairs: pairRows.length,
    deactivated: toDeactivate.length,
  };
}

module.exports = { calculateEnergyDirection };
