'use strict';

/**
 * NervaFX Currency Movement Engine — persistence (isolated, best-effort).
 *
 * Writes to its OWN table (cme_currency_movement_values) — never the existing
 * currency-strength tables. Idempotent by (evaluated_at, window, currency,
 * engine_version). Never throws; historical (read-only) requests skip it.
 */

async function persistCme(sb, scan) {
  const rows = [];
  const at = scan.generatedAt;
  const version = scan.engineVersion || 'v1';
  for (const [win, w] of Object.entries(scan.windows || {})) {
    if (!w || w.status !== 'OK' || !w.currencies) continue;
    for (const [cur, m] of Object.entries(w.currencies)) {
      rows.push({
        engine_version: version,
        evaluated_at: at,
        window: win,
        currency: cur,
        raw_movement: m.rawMovement,
        movement_score: m.movementScore,
        state: m.state,
        rank: m.rank,
        breadth_h1: m.breadthH1,
        breadth_15m: m.breadth15M,
        breadth_combined: m.breadthCombined,
        efficiency: m.efficiency,
        persistence: m.persistence,
        acceleration: m.acceleration,
        movement_score_15m_component: m.breadth15M != null ? m.breadth15M : null,
        micro_acceleration: m.microAcceleration,
        micro_persistence: m.persistence,
        micro_breadth: m.breadth15M,
        micro_state: m.microState || null,
        metrics: m,
      });
    }
  }
  if (!rows.length) return { persisted: true, rows: 0, error: null };
  try {
    const { error } = await sb.from('cme_currency_movement_values')
      .upsert(rows, { onConflict: 'evaluated_at,window,currency,engine_version' });
    if (error) throw error;
    return { persisted: true, rows: rows.length, error: null };
  } catch (e) {
    return { persisted: false, rows: 0, error: e.message };
  }
}

module.exports = { persistCme };
