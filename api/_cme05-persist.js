'use strict';

/**
 * NervaFX Currency Movement Engine (5M) — persistence (isolated).
 * Own tables cme05_currency_movement_values / cme05_pair_structure. Never throws.
 */

async function persistCme05(sb, scan) {
  const rows = [];
  const at = scan.generatedAt;
  const version = scan.engineVersion || 'v1';
  const configVersion = scan.configurationVersion || 'structure_5m_v1';
  for (const [win, w] of Object.entries(scan.windows || {})) {
    if (!w || w.status !== 'OK' || !w.currencies) continue;
    for (const [cur, m] of Object.entries(w.currencies)) {
      const st = m.structure || {};
      rows.push({
        engine_version: version, configuration_version: configVersion, evaluated_at: at,
        window_name: win, currency: cur,
        raw_movement: m.rawMovement, movement_score: m.movementScore, state: m.state, rank: m.rank,
        breadth_h1: m.breadthH1, breadth_combined: m.breadthCombined,
        efficiency: m.efficiency, persistence: m.persistence, acceleration: m.acceleration,
        structure_score: st.structureScore != null ? st.structureScore : null,
        structure_direction: st.structureDirection || null,
        structure_classification: st.structureClassification || null,
        structure_breadth: st.structureBreadth != null ? st.structureBreadth : null,
        confirmed_movement_score: m.confirmedMovementScore != null ? m.confirmedMovementScore : null,
        structure_agreement: st.agreement || null,
        metrics: m,
      });
    }
  }

  let currencyRows = 0, pairRows = 0, err = null;
  try {
    if (rows.length) {
      const { error } = await sb.from('cme05_currency_movement_values').upsert(rows, { onConflict: 'evaluated_at,window_name,currency,engine_version' });
      if (error) throw error;
      currencyRows = rows.length;
    }
  } catch (e) { err = e.message; }

  try {
    const pairs = (scan.pairEdges || []).map((e) => {
      const bos = e.h1BreakOfStructure || {};
      return {
        engine_version: version, configuration_version: configVersion, evaluated_at: at,
        pair: e.pair, base_currency: e.baseCurrency, quote_currency: e.quoteCurrency,
        bos_direction: bos.direction || 'NONE', bos_type: bos.breakType || 'NO_BREAK',
        previous_high: bos.previousHigh, previous_low: bos.previousLow, broken_level: bos.brokenLevel,
        break_distance_price: bos.breakDistancePrice, break_distance_atr: bos.breakDistanceATR,
        close_quality: bos.closeQuality, body_atr: bos.bodyATR, atr20: bos.atr20,
        bos_strength_grade: bos.strengthGrade, decisive_break: !!bos.decisiveBreak,
        pair_structure_score: e.baseStructureScore, pair_movement_edge: e.pairMovementEdge,
        pair_confirmed_edge: e.pairConfirmedEdge, structure_edge: e.structureEdge,
        structure_agreement: e.structureAgreement, opportunity: e.opportunity, metrics: e,
      };
    });
    if (pairs.length) {
      const { error } = await sb.from('cme05_pair_structure').upsert(pairs, { onConflict: 'evaluated_at,pair,configuration_version' });
      if (error) throw error;
      pairRows = pairs.length;
    }
  } catch (e) { err = err ? err + ' | ' + e.message : e.message; }

  return { persisted: !err, rows: currencyRows + pairRows, currencyRows, pairRows, error: err };
}

module.exports = { persistCme05 };
