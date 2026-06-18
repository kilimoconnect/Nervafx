'use strict';

/**
 * Energy Direction Engine — 2-slot direction confirmation with session expiry
 *
 * Trigger: 6H CS momentum (3h increasing, ≥30 pips) AND 5+ of 8 currencies changed direction
 * Slots:   Up to 2 active confirmations if they represent different currency configurations
 * Expiry:  Each confirmation lasts 2 sessions after the one it was confirmed in
 * Entry:   Starts next session after confirmation, based on M15 strength alignment
 *
 * DB tables:
 *   energy_currency_state  — per-slot currency directions (PK: slot + currency)
 *   energy_signal_pairs    — per-slot signal pairs with M15 phase (PK: slot + instrument)
 */

const { supabase } = require('./supabase');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const MIN_CURRENCY_CHANGES = 5;

const VALID_PAIRS = new Set([
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
]);

const SESSION_ORDER = { ASIA: 0, LONDON: 1, NEW_YORK: 2 };
const NEXT_SESSION = { ASIA: 'LONDON', LONDON: 'NEW_YORK', NEW_YORK: 'ASIA' };

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

function nextSessionName(session) {
  return NEXT_SESSION[session] || 'LONDON';
}

function nextSessionDate(dateStr, session) {
  if (session === 'NEW_YORK') {
    const d = new Date(dateStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  return dateStr;
}

/**
 * M15 phase detection — tracks pair behavior relative to flow direction.
 */
function detectPhase(prevPhase, dir, v45, v90, spread3h, impulseScore, impulseAligned, deCombo) {
  const flowSign = dir === 'BUY' ? 1 : -1;
  const v45Dir = v45 * flowSign;
  const h3Dir = spread3h * flowSign;
  const absV45 = Math.abs(v45);

  if (prevPhase === 'ENTRY' && v45Dir > 0.00008 && h3Dir > 0 && impulseAligned && impulseScore >= 40 && deCombo >= 35) {
    return 'MOVING';
  }
  if ((prevPhase === 'PULLBACK' || prevPhase === 'COMPRESSION') && v45Dir > 0.00005 && h3Dir > 0) {
    return 'ENTRY';
  }
  if (prevPhase !== 'ENTRY' && prevPhase !== 'MOVING' && v45Dir > 0.00008 && h3Dir > 0 && impulseAligned && impulseScore >= 40) {
    return 'ENTRY';
  }
  if (prevPhase !== 'MONITORING' && prevPhase !== 'ENTRY' && prevPhase !== 'MOVING' && v45Dir > 0.00010 && absV45 > Math.abs(v90) * 1.05) {
    return 'ENTRY';
  }
  if ((prevPhase === 'PULLBACK' || prevPhase === 'COMPRESSION') && absV45 < 0.00005) {
    return 'COMPRESSION';
  }
  if (v45Dir < -0.00003 && prevPhase !== 'MOVING') {
    return 'PULLBACK';
  }
  if (prevPhase === 'MOVING' && (v45Dir < 0 || !impulseAligned || impulseScore < 25)) {
    return 'MONITORING';
  }
  if (prevPhase === 'ENTRY' && v45Dir < 0.00003) {
    return 'MONITORING';
  }
  return prevPhase || 'MONITORING';
}

async function calculateEnergyDirection() {
  const now = new Date();
  const session = getSession(now.getUTCHours());

  if (session === 'LOW_LIQUIDITY') {
    console.log('[ENERGY_DIR] Low liquidity window — skipping');
    return { pairs: 0 };
  }

  const currDate = getSessionDate(now, session);
  const currSessNum = sessionNum(currDate, session);

  // ── 1. Get current market energy ───────────────────────────────────────────
  const todayStr = now.toISOString().slice(0, 10);

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

  let currentEnergy = 0;
  for (const es of energySessions) {
    const sessEnergy = parseFloat(es.market_energy) || 0;
    if (es.session_name === session && sessEnergy > currentEnergy) {
      currentEnergy = sessEnergy;
    }
  }

  // ── 2. Fetch last 3 hours of currency strength for momentum check ──────────
  const { data: csRows, error: csErr } = await supabase
    .from('currency_strength')
    .select('currency, smooth_2h, smooth_3h, smooth_6h, smooth_12h, raw_6h, time')
    .order('time', { ascending: false })
    .limit(24);

  if (csErr) throw new Error(`Energy dir strength fetch: ${csErr.message}`);
  if (!csRows?.length) {
    console.log('[ENERGY_DIR] No strength data');
    return { pairs: 0 };
  }

  const byTime = {};
  for (const r of csRows) {
    const tk = r.time;
    if (!byTime[tk]) byTime[tk] = {};
    if (!byTime[tk][r.currency]) {
      byTime[tk][r.currency] = {
        smooth_2h: parseFloat(r.smooth_2h) || 0,
        smooth_3h: parseFloat(r.smooth_3h) || 0,
        smooth_6h: parseFloat(r.smooth_6h) || 0,
        smooth_12h: parseFloat(r.smooth_12h) || 0,
        raw_6h: parseFloat(r.raw_6h) || 0,
      };
    }
  }
  const timeKeys = Object.keys(byTime).sort();
  const last3 = timeKeys.slice(-3);

  const latestTime = last3[last3.length - 1];
  const ccyMap = {};
  for (const ccy of CURRENCIES) {
    ccyMap[ccy] = byTime[latestTime]?.[ccy] || { smooth_2h: 0, smooth_3h: 0, smooth_6h: 0, smooth_12h: 0, raw_6h: 0 };
  }

  // ── 2b. Momentum trigger: 6H CS sum increasing for 3 consecutive hours ────
  const sums = last3.map(tk => {
    const vals = CURRENCIES.filter(c => byTime[tk]?.[c]).map(c => byTime[tk][c].smooth_6h);
    if (vals.length < 2) return 0;
    return Math.abs(Math.max(...vals)) + Math.abs(Math.min(...vals));
  });

  let triggerBar = null;
  const hasMomentum = sums.length === 3 && sums[2] > sums[1] && sums[1] > sums[0] && sums[2] >= 0.003;

  if (hasMomentum) {
    const csTime = latestTime || now.toISOString();
    const roundedHour = new Date(new Date(csTime).setMinutes(0, 0, 0)).toISOString();
    triggerBar = {
      energy: Math.round(sums[2] * 10000),
      time: roundedHour,
      session: getSession(new Date(roundedHour).getUTCHours()),
    };
  }

  const triggerEnergy = triggerBar ? triggerBar.energy : Math.round(sums[sums.length - 1] * 10000);
  const triggerSession = triggerBar ? triggerBar.session : null;
  const triggerHour = triggerBar ? triggerBar.time : null;

  const sumStrs = sums.map(s => Math.round(s * 10000) + 'p').join(' → ');
  console.log(`[ENERGY_DIR] Energy: ${currentEnergy} | 6H sums: ${sumStrs} ${hasMomentum ? '→ MOMENTUM' : '→ no momentum'}`);

  // ── 3. Load existing state for both slots ─────────────────────────────────
  const { data: existingState } = await supabase
    .from('energy_currency_state')
    .select('*');

  const slotRows = { 1: [], 2: [] };
  for (const s of (existingState || [])) {
    const sn = s.slot || 1;
    if (!slotRows[sn]) slotRows[sn] = [];
    slotRows[sn].push(s);
  }

  const slotDirMaps = {};
  const slotMeta = {};
  for (const [sn, rows] of Object.entries(slotRows)) {
    const active = rows.filter(r => r.active);
    if (active.length) {
      slotDirMaps[sn] = {};
      for (const r of active) slotDirMaps[sn][r.currency] = r.direction;
      slotMeta[sn] = {
        confirmed_session: active[0].confirmed_session,
        confirmed_date: active[0].confirmed_date,
        triggered_at: active[0].triggered_at,
      };
    }
  }

  // ── 4. Expire slots past 2 sessions ───────────────────────────────────────
  for (const [sn, meta] of Object.entries(slotMeta)) {
    if (!meta.confirmed_date || !meta.confirmed_session) continue;
    const confNum = sessionNum(meta.confirmed_date, meta.confirmed_session);
    const elapsed = currSessNum - confNum;
    if (elapsed > 2) {
      console.log(`[ENERGY_DIR] Slot ${sn} EXPIRED (confirmed ${meta.confirmed_session} ${meta.confirmed_date}, ${elapsed} sessions ago)`);
      await supabase
        .from('energy_currency_state')
        .update({ active: false })
        .eq('slot', parseInt(sn));
      await supabase
        .from('energy_signal_pairs')
        .update({ active: false, last_updated: now.toISOString() })
        .eq('slot', parseInt(sn));
      delete slotDirMaps[sn];
      delete slotMeta[sn];
    }
  }

  // ── 5. Load existing signal pairs ─────────────────────────────────────────
  const { data: existingPairs } = await supabase
    .from('energy_signal_pairs')
    .select('*')
    .eq('active', true);

  const pairMap = {};
  for (const p of (existingPairs || [])) {
    pairMap[`${p.slot || 1}_${p.instrument}`] = p;
  }

  // ── 6. Evaluate new direction confirmation ────────────────────────────────
  let newConfirmation = false;
  let targetSlot = null;
  let currencyUpdates = [];
  let newSlotPairs = [];

  if (hasMomentum) {
    const ranked = CURRENCIES
      .filter(ccy => ccyMap[ccy])
      .map(ccy => {
        const d = ccyMap[ccy];
        const combined = d.smooth_6h;
        return { currency: ccy, h3: d.smooth_6h, h6: d.smooth_6h, combined };
      })
      .sort((a, b) => b.combined - a.combined);

    const strong = ranked.slice(0, 3).filter(c => c.combined > 0)
      .map(c => ({ currency: c.currency, h3: c.h3, h6: c.h6, score: Math.abs(c.combined) }));
    const weak = ranked.slice(-3).filter(c => c.combined < 0)
      .map(c => ({ currency: c.currency, h3: c.h3, h6: c.h6, score: Math.abs(c.combined) }));

    strong.sort((a, b) => b.score - a.score);
    weak.sort((a, b) => b.score - a.score);

    // Build new direction map
    const newDirMap = {};
    for (const ccy of CURRENCIES) newDirMap[ccy] = 'NEUTRAL';
    for (const s of strong) newDirMap[s.currency] = 'STRONG';
    for (const w of weak) newDirMap[w.currency] = 'WEAK';

    const activeSlots = Object.keys(slotDirMaps).map(Number);

    if (activeSlots.length === 0) {
      newConfirmation = true;
      targetSlot = 1;
      console.log(`[ENERGY_DIR] No active slots — new confirmation → slot 1`);
    } else {
      // Compare against most recent active slot
      const latestSlot = activeSlots.reduce((best, s) => {
        const bMeta = slotMeta[best];
        const sMeta = slotMeta[s];
        if (!bMeta) return s;
        if (!sMeta) return best;
        return sessionNum(sMeta.confirmed_date, sMeta.confirmed_session) >
               sessionNum(bMeta.confirmed_date, bMeta.confirmed_session) ? s : best;
      });

      const prevDirMap = slotDirMaps[latestSlot];
      let changes = 0;
      for (const ccy of CURRENCIES) {
        if ((newDirMap[ccy] || 'NEUTRAL') !== (prevDirMap[ccy] || 'NEUTRAL')) changes++;
      }

      console.log(`[ENERGY_DIR] Direction changes vs slot ${latestSlot}: ${changes}/8 (need ${MIN_CURRENCY_CHANGES})`);

      if (changes >= MIN_CURRENCY_CHANGES) {
        newConfirmation = true;
        if (!activeSlots.includes(1)) {
          targetSlot = 1;
        } else if (!activeSlots.includes(2)) {
          targetSlot = 2;
        } else {
          const s1Num = sessionNum(slotMeta[1]?.confirmed_date, slotMeta[1]?.confirmed_session);
          const s2Num = sessionNum(slotMeta[2]?.confirmed_date, slotMeta[2]?.confirmed_session);
          targetSlot = s1Num <= s2Num ? 1 : 2;
          console.log(`[ENERGY_DIR] Both slots active — replacing oldest (slot ${targetSlot})`);
        }
      }
    }

    if (newConfirmation && targetSlot) {
      const entrySession = nextSessionName(session);
      const entryDate = nextSessionDate(currDate, session);

      console.log(`[ENERGY_DIR] ═══ NEW DIRECTION — slot ${targetSlot}, ${triggerEnergy}p @ ${session} ${currDate} ═══`);
      console.log(`[ENERGY_DIR]   Entry eligible: ${entrySession} ${entryDate}`);

      // Deactivate old data in target slot before inserting new
      await supabase
        .from('energy_currency_state')
        .delete()
        .eq('slot', targetSlot);
      await supabase
        .from('energy_signal_pairs')
        .update({ active: false, last_updated: now.toISOString() })
        .eq('slot', targetSlot);

      for (const ccy of CURRENCIES) {
        const dir = newDirMap[ccy];
        const snap = dir === 'STRONG'
          ? strong.find(s => s.currency === ccy)
          : dir === 'WEAK'
            ? weak.find(w => w.currency === ccy)
            : null;

        const prevDir = slotDirMaps[targetSlot]?.[ccy] || 'NEUTRAL';
        let eventType = 'NEW';
        if (prevDir !== 'NEUTRAL' && dir !== 'NEUTRAL') {
          eventType = prevDir === dir ? 'CONTINUATION' : 'REVERSAL';
        } else if (prevDir !== 'NEUTRAL' && dir === 'NEUTRAL') {
          eventType = 'DROPPED';
        }

        if (eventType !== 'NEW' || dir !== 'NEUTRAL') {
          console.log(`[ENERGY_DIR]   ${ccy}: ${dir} (${eventType})`);
        }

        currencyUpdates.push({
          slot: targetSlot,
          currency: ccy,
          direction: dir,
          smooth_3h: snap?.h3 || ccyMap[ccy]?.smooth_6h || 0,
          smooth_6h: snap?.h6 || ccyMap[ccy]?.smooth_6h || 0,
          energy_at_trigger: triggerEnergy,
          trigger_session: session,
          triggered_at: triggerHour || now.toISOString(),
          confirmed_session: session,
          confirmed_date: currDate,
          threshold_met: true,
          active: dir !== 'NEUTRAL',
          energy_event_type: eventType,
        });
      }

      // Form pairs from strong × weak
      for (const s of strong) {
        for (const w of weak) {
          const fwd = `${s.currency}_${w.currency}`;
          const rev = `${w.currency}_${s.currency}`;
          let instrument, dir;
          if (VALID_PAIRS.has(fwd)) { instrument = fwd; dir = 'BUY'; }
          else if (VALID_PAIRS.has(rev)) { instrument = rev; dir = 'SELL'; }
          else continue;

          console.log(`[ENERGY_DIR]   ${instrument.replace('_','/')} ${dir} (${s.currency}↑ ${w.currency}↓)`);

          newSlotPairs.push({
            slot: targetSlot,
            instrument, dir,
            strong_ccy: s.currency,
            weak_ccy: w.currency,
            trigger_energy: triggerEnergy,
            trigger_session: session,
            triggered_at: triggerHour || now.toISOString(),
            entry_eligible_session: entrySession,
            entry_eligible_date: entryDate,
          });
        }
      }
    }
  }

  // ── 7. Collect all active pairs (new + existing from other slots) ─────────
  const allPairs = [...newSlotPairs];

  for (const p of (existingPairs || [])) {
    if (!p.active) continue;
    // Skip pairs from the slot we just replaced
    if (newConfirmation && targetSlot && (p.slot || 1) === targetSlot) continue;
    allPairs.push({
      slot: p.slot || 1,
      instrument: p.instrument,
      dir: p.dir,
      strong_ccy: p.strong_ccy,
      weak_ccy: p.weak_ccy,
      trigger_energy: p.trigger_energy,
      trigger_session: p.trigger_session,
      triggered_at: p.triggered_at,
      entry_eligible_session: p.entry_eligible_session,
      entry_eligible_date: p.entry_eligible_date,
    });
  }

  // ── 8. Fetch M15 data for phase updates ───────────────────────────────────
  const pairInstruments = [...new Set(allPairs.map(p => p.instrument))];
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

  let spreadMap = {};
  if (pairInstruments.length) {
    for (const inst of pairInstruments) {
      const [base, quote] = inst.split('_');
      spreadMap[inst] = {
        spread_3h: (ccyMap[base]?.smooth_6h || 0) - (ccyMap[quote]?.smooth_6h || 0),
        spread_6h: (ccyMap[base]?.smooth_6h || 0) - (ccyMap[quote]?.smooth_6h || 0),
        spread_12h: (ccyMap[base]?.smooth_12h || 0) - (ccyMap[quote]?.smooth_12h || 0),
      };
    }
  }

  // ── 9. Update phases for each pair ────────────────────────────────────────
  const pairRows = allPairs.map(p => {
    const m15 = m15Map[p.instrument];
    const sp = spreadMap[p.instrument] || {};
    const prevKey = `${p.slot}_${p.instrument}`;
    const prev = pairMap[prevKey];

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

    let newEnergyEvent = false;
    let energyEventType = null;
    if (newConfirmation && p.slot === targetSlot) {
      newEnergyEvent = true;
      energyEventType = prev?.active ? (prev.dir === p.dir ? 'CONTINUATION' : 'REVERSAL') : 'NEW';
    }

    return {
      slot: p.slot,
      instrument: p.instrument,
      dir: p.dir,
      strong_ccy: p.strong_ccy,
      weak_ccy: p.weak_ccy,
      phase,
      phase_changed_at: phase !== prevPhase ? now.toISOString() : (prev?.phase_changed_at || now.toISOString()),
      trigger_energy: p.trigger_energy,
      trigger_session: p.trigger_session,
      triggered_at: p.triggered_at || now.toISOString(),
      entry_eligible_session: p.entry_eligible_session,
      entry_eligible_date: p.entry_eligible_date,
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

  // ── 10. Deactivate pairs no longer in any active set ──────────────────────
  const activeKeys = new Set(pairRows.map(p => `${p.slot}_${p.instrument}`));
  const toDeactivate = (existingPairs || [])
    .filter(p => p.active && !activeKeys.has(`${p.slot || 1}_${p.instrument}`))
    .map(p => ({ slot: p.slot || 1, instrument: p.instrument }));

  // ── 11. Upsert to DB ─────────────────────────────────────────────────────
  if (currencyUpdates.length) {
    const { error } = await supabase
      .from('energy_currency_state')
      .upsert(currencyUpdates, { onConflict: 'slot,currency', ignoreDuplicates: false });
    if (error) console.error('[ENERGY_DIR] Currency state upsert:', error.message);
  }

  if (pairRows.length) {
    const { error } = await supabase
      .from('energy_signal_pairs')
      .upsert(pairRows, { onConflict: 'slot,instrument', ignoreDuplicates: false });
    if (error) console.error('[ENERGY_DIR] Pair upsert:', error.message);
  }

  for (const d of toDeactivate) {
    await supabase
      .from('energy_signal_pairs')
      .update({ active: false, last_updated: now.toISOString() })
      .eq('slot', d.slot)
      .eq('instrument', d.instrument);
  }

  const activeSlotCount = Object.keys(slotMeta).length + (newConfirmation ? 1 : 0);
  const phases = {};
  for (const p of pairRows) phases[p.phase] = (phases[p.phase] || 0) + 1;
  console.log(`[ENERGY_DIR] ${activeSlotCount} active slot(s) | ${pairRows.length} pairs | Trigger: ${triggerEnergy}p | Phases: ${JSON.stringify(phases)}`);

  return {
    energy: currentEnergy,
    thresholdMet: !!triggerBar,
    isNewConfirmation: newConfirmation,
    targetSlot,
    pairs: pairRows.length,
    deactivated: toDeactivate.length,
  };
}

module.exports = { calculateEnergyDirection };
