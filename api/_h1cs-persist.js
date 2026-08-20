'use strict';

/**
 * NervaFX H1 Continuation Engine — SESSION persistence (isolated, best-effort).
 *
 * Writes to SEPARATE session tables (h1_session_setups / h1_session_history) so
 * Session records can never overwrite, delete or collide with Generic records.
 * Idempotent: active row upserted by stable setup_id; a transition is appended
 * only when the state actually changes. Never throws. Historical (read-only)
 * requests must NOT call this — the route gates it.
 */

async function persistSessionScan(sb, scan) {
  const active = (scan.setups || []).filter((s) => s.setupId);
  let transitionsAppended = 0;
  try {
    for (const s of active) {
      const up = await sb.from('h1_session_setups').upsert({
        setup_id: s.setupId,
        mode: s.mode,
        pair: s.instrument,
        direction: s.direction,
        state: s.state,
        score: s.score != null ? Math.round(s.score) : null,
        grade: s.grade || null,
        reference_session_end: s.referenceSessionEndUtc,
        payload: s,
        updated_at: scan.generatedAt,
      }, { onConflict: 'setup_id' });
      if (up && up.error) throw up.error;

      const { data: last, error: le } = await sb.from('h1_session_history')
        .select('state').eq('setup_id', s.setupId).order('at', { ascending: false }).limit(1);
      if (le) throw le;
      const lastState = last && last[0] ? last[0].state : null;
      if (lastState !== s.state) {
        const ins = await sb.from('h1_session_history').insert({
          setup_id: s.setupId,
          mode: s.mode,
          pair: s.instrument,
          direction: s.direction,
          state: s.state,
          reason: (s.reasonCodes || []).join(','),
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

module.exports = { persistSessionScan };
