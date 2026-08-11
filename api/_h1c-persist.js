'use strict';

/**
 * NervaFX H1 Continuation Engine — state persistence + history (best-effort).
 *
 * Idempotent: the active row is upserted by stable setup_id; a history row is
 * appended only when the state actually changes, so repeating the same scan adds
 * no duplicate transitions. History is append-only — completed/invalidated/
 * expired setups are never erased. Never throws and never fabricates: if the DB
 * write fails, the scan result is still returned with persistence.ok = false.
 *
 * Requires the tables in sql/010_h1_continuation.sql. If they are missing the
 * upsert errors and this reports ok:false — the scan itself is unaffected.
 */

async function persistScan(sb, scan) {
  const active = (scan.setups || []).filter((s) => s.setupId);
  let transitionsAppended = 0;
  try {
    for (const s of active) {
      const up = await sb.from('h1_continuation_setups').upsert({
        setup_id: s.setupId,
        pair: s.instrument,
        direction: s.direction,
        state: s.state,
        setup_score: s.setupScore,
        grade: s.grade,
        reference_end: s.timestamps.impulseEnd,
        payload: s,
        updated_at: scan.generatedAt,
      }, { onConflict: 'setup_id' });
      if (up && up.error) throw up.error;

      // Append a transition only if the latest recorded state differs.
      const { data: last, error: le } = await sb.from('h1_continuation_history')
        .select('state').eq('setup_id', s.setupId).order('at', { ascending: false }).limit(1);
      if (le) throw le;
      const lastState = last && last[0] ? last[0].state : null;
      if (lastState !== s.state) {
        const ins = await sb.from('h1_continuation_history').insert({
          setup_id: s.setupId,
          pair: s.instrument,
          direction: s.direction,
          state: s.state,
          reason: (s.reasons || []).join(','),
          at: scan.generatedAt,
        });
        if (ins && ins.error) throw ins.error;
        transitionsAppended++;
      }
    }
    return { persisted: true, transitionsAppended, error: null };
  } catch (e) {
    return { persisted: false, transitionsAppended, error: e.message };
  }
}

module.exports = { persistScan };
