'use strict';

/**
 * POST /api/m15-snapshot — durable post-close snapshot writer (Phase 3).
 *
 * Server-side only, protected by CRON_SECRET (same as run-pipeline). The existing
 * external scheduler already hits the pipeline every few minutes; point it here
 * too (or call this from run-pipeline). Because it may fire late and pairs may lag,
 * it reconciles a bounded catch-up window of completed M15 closes and is idempotent:
 * a repeat for the same close+version updates in place (unique keys), never
 * duplicates. It writes the run as PENDING, fills detail, then flips to COMPLETE —
 * so a reader never sees a partial 28-pair calc as complete. Missing pairs / errors
 * / retries are recorded and the run is marked INCOMPLETE. NEVER places an order.
 *
 * Requires migration sql/022 (m15i_* tables) applied. Until then the writes error
 * and the endpoint reports DB integration unverified.
 */

const { getClient } = require('./_db');
const { CONFIG_1_1_0A } = require('./_m15/config-1_1_0');
const { configHash } = require('./_m15/config');
const { loadSynchronized } = require('./_m15/load');
const { runNetwork } = require('./_m15/coordinator');
const { gateWaterfall, isArmed } = require('./_m15/diagnostics');
const { episodeId } = require('./_m15/forward');
const { PAIRS, CURRENCIES } = require('./_m15/pairs');
const { M15_MS } = require('./_m15/data');
const { plannedCloses, closeOf, snapshotStatus, snapshotKey } = require('./_m15/snapshot');

const CFG = CONFIG_1_1_0A;
const VERSION = CFG.version;

function authorized(req) {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  return !!process.env.CRON_SECRET && auth === process.env.CRON_SECRET;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'POST' });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const sb = getClient();
  const nowMs = Date.now();
  const maxCatchup = Math.min(16, parseInt(req.query?.catchup || '8', 10) || 8);

  try {
    // which recent frames are already COMPLETE for this version?
    const sinceIso = new Date(nowMs - (maxCatchup + 2) * M15_MS).toISOString();
    const { data: doneRows, error: qErr } = await sb.from('m15i_analysis_runs')
      .select('source_candle_time,status').eq('calculation_version', VERSION).eq('status', 'COMPLETE').gte('source_candle_time', sinceIso);
    if (qErr) throw new Error(`runs query: ${qErr.message}`);
    const completeSet = new Set((doneRows || []).map((r) => new Date(r.source_candle_time).getTime()));

    // Process OLDEST first so armed episodes build forward (stable episode ids).
    const frames = plannedCloses(nowMs, completeSet, { cfg: CFG, maxCatchup }).slice().reverse();
    const results = [];
    for (const frame of frames) results.push(await writeOne(sb, frame, nowMs));

    return res.json({ ok: true, version: VERSION, processed: results.length, results });
  } catch (e) {
    return res.status(500).json({ ok: false, version: VERSION, error: e.message, note: 'If tables are missing, apply sql/022 (m15i_* tables) first (DB integration unverified).' });
  }
};

async function writeOne(sb, frameOpenMs, nowMs) {
  const closeMs = closeOf(frameOpenMs);
  const srcIso = new Date(frameOpenMs).toISOString();
  try {
    const { evalMs, candlesByPair, sync } = await loadSynchronized(sb, { atMs: closeMs, cfg: CFG });
    const run = runNetwork(candlesByPair, { evalMs, cfg: CFG, diagnostics: true, syncState: sync.reason });
    const pairsProcessed = PAIRS.filter((p) => (candlesByPair[p] || []).length > 0).length;
    const missingPairs = sync.missing || PAIRS.filter((p) => (candlesByPair[p] || []).length === 0);
    const status = snapshotStatus({ pairsProcessed, pairsExpected: 28, syncState: sync.reason, missingPairs });
    const key = snapshotKey(evalMs, VERSION, run.run.inputDataHash);

    // 1) run row PENDING (atomic flip to final status at the end)
    await upsert(sb, 'm15i_analysis_runs', {
      source_candle_time: srcIso, close_time: new Date(closeMs).toISOString(), analysis_time: new Date(nowMs).toISOString(),
      calculation_version: VERSION, input_data_hash: run.run.inputDataHash, idempotency_key: key,
      status: 'PENDING', sync_state: sync.reason, pairs_processed: pairsProcessed, pairs_expected: 28,
      missing_pairs: missingPairs, error: null, updated_at: new Date(nowMs).toISOString(),
    }, 'source_candle_time,calculation_version');

    // 2) detail — per-pair states/rankings/setups + currencies (only when COMPLETE)
    if (status === 'COMPLETE') {
      const pairStates = [], rankings = [], setups = [];
      for (const r of run.ranking) {
        const rec = run.pairs[r.pair]; const w = gateWaterfall(rec, { cfg: CFG });
        pairStates.push(row({ instrument: r.pair, current_state: rec.marketState.state, structural_events: rec.diag.movement ? null : null }));
        rankings.push(row({ instrument: r.pair, rank: r.rank, score: r.score, decision: rec.decision, data: { snapshot: rec.snapshot, agreement: rec.agreement.state, gates: w.gates, failingGates: w.failingGates } }));
        if (rec.setup) setups.push(row({ instrument: r.pair, strategy: rec.strategy, direction: rec.setup.direction, trigger_price: rec.setup.triggerPrice, entry_zone_low: rec.setup.entryZoneLow, entry_zone_high: rec.setup.entryZoneHigh, invalidation_price: rec.setup.invalidationPrice, stop_price: rec.setup.stopPrice, stop_pips: rec.setup.stopPips, target1: rec.setup.target1, target2: rec.setup.target2, rr: rec.setup.rr, freshness: rec.setup.freshness, decision: rec.decision, reasons: rec.reasons || null, gates: w.gates, episode_key: `${r.pair}|${rec.setup.direction}|${srcIso}` }));
      }
      const cur = run.currencies;
      const strengths = CURRENCIES.map((c) => rowC({ currency: c, data: cur.strength.byCurrency[c] }));
      const powers = CURRENCIES.map((c) => rowC({ currency: c, data: cur.power.byCurrency[c] }));
      const structs = CURRENCIES.map((c) => rowC({ currency: c, data: cur.structure.byCurrency[c] }));

      await upsert(sb, 'm15i_pair_states', pairStates, 'instrument,source_candle_time,calculation_version');
      await upsert(sb, 'm15i_pair_rankings', rankings, 'source_candle_time,instrument,calculation_version');
      if (setups.length) await upsert(sb, 'm15i_setups', setups, 'instrument,source_candle_time,calculation_version');
      await upsert(sb, 'm15i_currency_strength', strengths, 'currency,source_candle_time,calculation_version');
      await upsert(sb, 'm15i_currency_power', powers, 'currency,source_candle_time,calculation_version');
      await upsert(sb, 'm15i_currency_structure', structs, 'currency,source_candle_time,calculation_version');

      // In-app notifications for NEW actionable episodes (deduped by episode+version).
      // Episode identity carries forward: if this pair was armed the same direction
      // at the previous close, reuse that episode's first close; else it starts here.
      const prevIso = new Date(frameOpenMs - M15_MS).toISOString();
      for (const r of run.ranking) {
        const rec = run.pairs[r.pair];
        if (!(isArmed(rec.decision) && rec.setup)) continue;
        const dir = rec.setup.direction;
        let firstIso = srcIso;
        try {
          const { data: prev } = await sb.from('m15i_setups').select('episode_key')
            .eq('instrument', r.pair).eq('calculation_version', VERSION).eq('source_candle_time', prevIso).eq('direction', dir).limit(1);
          if (prev && prev[0] && prev[0].episode_key) firstIso = prev[0].episode_key.split('|')[2] || srcIso;
        } catch (_) { /* first close */ }
        const firstMs = Date.parse(firstIso);
        const epId = episodeId(r.pair, dir, firstMs, run.run.calculationVersion);
        // stamp the stable episode_key (first close) on this setup row
        await sb.from('m15i_setups').update({ episode_key: `${r.pair}|${dir}|${firstIso}` })
          .eq('instrument', r.pair).eq('calculation_version', VERSION).eq('source_candle_time', srcIso).then(() => {}, () => {});
        // dedup: unique(episode_id, engine_version) makes this a no-op if already sent
        await sb.from('m15i_notifications').upsert({
          episode_id: epId, pair: r.pair, direction: dir, engine_version: run.run.calculationVersion,
          source_candle_time: srcIso, close_time: new Date(closeMs).toISOString(),
        }, { onConflict: 'episode_id,engine_version', ignoreDuplicates: true }).then(() => {}, () => {});
      }
    }

    // 3) flip status (idempotent: same row by unique key)
    await upsert(sb, 'm15i_analysis_runs', { source_candle_time: srcIso, calculation_version: VERSION, status, updated_at: new Date().toISOString() }, 'source_candle_time,calculation_version');
    return { close: new Date(closeMs).toISOString(), frameOpen: srcIso, status, pairsProcessed, missing: missingPairs };

    function row(o) { return { source_candle_time: srcIso, analysis_time: new Date(nowMs).toISOString(), calculation_version: VERSION, input_data_hash: run.run.inputDataHash, ...o }; }
    function rowC(o) { return { source_candle_time: srcIso, analysis_time: new Date(nowMs).toISOString(), calculation_version: VERSION, input_data_hash: run.run.inputDataHash, ...o }; }
  } catch (e) {
    // record the failure against the run and bump retry_count (best-effort)
    await sb.from('m15i_analysis_runs').update({ status: 'INCOMPLETE', error: e.message, retry_count: (await retryCount(sb, srcIso)) + 1, updated_at: new Date().toISOString() })
      .eq('source_candle_time', srcIso).eq('calculation_version', VERSION).then(() => {}, () => {});
    return { close: new Date(closeMs).toISOString(), frameOpen: srcIso, status: 'INCOMPLETE', error: e.message };
  }
}

async function upsert(sb, table, rows, onConflict) {
  const { error } = await sb.from(table).upsert(rows, { onConflict });
  if (error) throw new Error(`${table}: ${error.message}`);
}
async function retryCount(sb, srcIso) {
  const { data } = await sb.from('m15i_analysis_runs').select('retry_count').eq('source_candle_time', srcIso).eq('calculation_version', VERSION).limit(1);
  return data?.[0]?.retry_count || 0;
}

module.exports.maxDuration = 120;
