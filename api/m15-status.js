'use strict';

/**
 * GET /api/m15-status — operational status of the M15 snapshot pipeline (Phase 4).
 *
 * Read-only. Reports the latest COMPLETE snapshot, data age, missing pairs,
 * processing lag, last successful scheduled run, and engine version — so stale or
 * incomplete data is never mistaken for a current opportunity. Degrades to
 * status:UNVERIFIED (not an error) when migration 022 has not been applied yet.
 * Requires a valid user token. No order/execution path.
 */

const { getClient } = require('./_db');
const { CONFIG_1_1_0A } = require('./_m15/config-1_1_0');
const { configHash } = require('./_m15/config');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
async function verifyToken(sb, req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return { user: null };
  const { data: { user } } = await sb.auth.getUser(token);
  return { user: user || null };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET' });
  const version = `${CONFIG_1_1_0A.version}+${configHash(CONFIG_1_1_0A)}`;
  try {
    const sb = getClient();
    const { user } = await verifyToken(sb, req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const nowMs = Date.now();

    // latest COMPLETE run for the published version
    const { data: complete, error: cErr } = await sb.from('m15i_analysis_runs')
      .select('source_candle_time,close_time,analysis_time,pairs_processed,missing_pairs,calculation_version,status')
      .eq('calculation_version', version).eq('status', 'COMPLETE')
      .order('source_candle_time', { ascending: false }).limit(1);
    if (cErr) {
      // table absent (022 not applied) or query error → UNVERIFIED, not a failure
      return res.json({ ok: true, status: 'UNVERIFIED', engineVersion: version,
        note: 'No stored snapshots yet — apply sql/022 and run /api/m15-snapshot (owner action).', detail: cErr.message });
    }
    const latest = complete && complete[0];
    // most recent run of any status (to expose PENDING/INCOMPLETE lag)
    const { data: recent } = await sb.from('m15i_analysis_runs')
      .select('source_candle_time,close_time,analysis_time,status,retry_count,error,missing_pairs')
      .eq('calculation_version', version).order('source_candle_time', { ascending: false }).limit(1);
    const last = recent && recent[0];

    const ageOf = (iso) => (iso ? Math.round((nowMs - Date.parse(iso)) / 1000) : null);
    const lagOf = (a, c) => (a && c ? Math.round((Date.parse(a) - Date.parse(c)) / 1000) : null);

    return res.json({
      ok: true,
      status: latest ? 'READY' : 'NO_COMPLETE_SNAPSHOT',
      engineVersion: version,
      latestComplete: latest ? {
        sourceCandleTime: latest.source_candle_time, closeTime: latest.close_time,
        closeEat: latest.close_time ? new Date(latest.close_time).toLocaleString('en-GB', { timeZone: 'Africa/Nairobi' }) : null,
        pairsProcessed: latest.pairs_processed, missingPairs: latest.missing_pairs || [],
        dataAgeSeconds: ageOf(latest.close_time),
        processingLagSeconds: lagOf(latest.analysis_time, latest.close_time),
      } : null,
      lastRun: last ? { status: last.status, sourceCandleTime: last.source_candle_time, retryCount: last.retry_count, error: last.error || null } : null,
      lastSuccessfulRunAt: latest ? latest.analysis_time : null,
      analyticalManualOnly: true, ordersDisabled: true,
    });
  } catch (e) {
    return res.json({ ok: true, status: 'UNVERIFIED', engineVersion: version, note: e.message });
  }
};
