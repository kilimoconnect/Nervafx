'use strict';

/**
 * NervaFX H1 Continuation Engine — full-day historical replay (read-only).
 *
 * Replays every completed H1 boundary of a local day through the SAME
 * evaluateSetup() the live engine uses. Efficient + serverless-safe: each pair's
 * candles are fetched ONCE (covering warm-up + the day), then sanitized/evaluated
 * in memory per hour — never 24 × 28 database scans. Pair failures are isolated;
 * lookahead is impossible because sanitizeH1 bounds every hour to closed candles.
 * Never persists.
 */

const {
  PAIRS, STATES, HOUR_MS, FETCH_LIMIT, ENGINE_VERSION, CONFIGURATION_VERSION,
} = require('./_h1c-constants');
const { sanitizeH1, h1DataBounds } = require('./_h1c-data');
const { evaluateSetup } = require('./_h1c-state');
const { localDayBoundsUtc, localStr } = require('./_h1c-time');
// _db required lazily so replayDay can be unit-tested (with an injected fetch)
// without the Supabase client installed.

const BATCH = 7;

const STATE_PRIORITY = {
  CONTINUATION_CONFIRMED: 6, SECOND_PUSH_STARTED: 5, CONTINUATION_READY: 4,
  PULLBACK_VALID: 3, PULLBACK_FORMING: 2, IMPULSE_LOCKED: 1, SEARCHING: 0,
  INVALIDATED: -1, EXPIRED: -2,
};

async function fetchPairRowsDb(sb, inst, fromMs, toMs) {
  const client = sb || require("./_db").getClient();
  const { data, error } = await client
    .from('backtest_candles')
    .select('time, open, high, low, close')
    .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true)
    .gte('time', new Date(fromMs).toISOString())
    .lte('time', new Date(toMs).toISOString())
    .order('time', { ascending: true })
    .limit(2000);
  if (error) throw error;
  return data || [];
}

/**
 * @param {object} opts
 *   date: 'YYYY-MM-DD'  (local calendar day)
 *   timezone: IANA zone
 *   latestCloseMs?: cap (defaults to live data bounds)
 *   fetchPairRows?: async (inst) => rows   (injectable; defaults to DB)
 */
async function replayDay(sb, opts) {
  const tz = opts.timezone || 'Africa/Dar_es_Salaam';
  const { startMs, endMs } = localDayBoundsUtc(opts.date, tz);

  let latestCloseMs = opts.latestCloseMs;
  if (latestCloseMs === undefined) {
    try { latestCloseMs = (await h1DataBounds(sb)).latestCloseMs; } catch (_) { latestCloseMs = null; }
  }
  const dayEndEval = latestCloseMs != null ? Math.min(endMs, latestCloseMs) : endMs;

  const fromMs = startMs - FETCH_LIMIT * HOUR_MS;   // warm-up lookback
  const fetchRows = opts.fetchPairRows || ((inst) => fetchPairRowsDb(sb, inst, fromMs, endMs));

  // Fetch each pair once (batched), isolating failures.
  const rowsByPair = {};
  const pairErrors = [];
  for (let b = 0; b < PAIRS.length; b += BATCH) {
    const batch = PAIRS.slice(b, b + BATCH);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(batch.map(async (inst) => {
      try { return { inst, rows: await fetchRows(inst) }; }
      catch (e) { return { inst, error: e.message }; }
    }));
    for (const r of results) {
      if (r.error) { pairErrors.push({ pair: r.inst.replace('_', '/'), error: r.error }); rowsByPair[r.inst] = []; }
      else rowsByPair[r.inst] = r.rows;
    }
  }

  // Replay each H1 boundary of the day in memory.
  const startH = Math.ceil(startMs / HOUR_MS) * HOUR_MS;
  const hourlySummaries = [];
  const transitions = [];
  const dataWarnings = [];
  const prev = {}; // inst -> { state, setupId }

  for (let h = startH; h <= dayEndEval; h += HOUR_MS) {
    const stateCounts = {};
    const setupsThisHour = [];
    for (const inst of PAIRS) {
      let res;
      try {
        const san = sanitizeH1(rowsByPair[inst] || [], h);
        if (!san.ok) { dataWarnings.push({ pair: inst.replace('_', '/'), evaluatedAtUtc: new Date(h).toISOString(), reason: san.reason }); continue; }
        res = evaluateSetup(san.candles, {});
      } catch (e) {
        pairErrors.push({ pair: inst.replace('_', '/'), evaluatedAtUtc: new Date(h).toISOString(), error: e.message });
        continue;
      }
      const st = res.state;
      stateCounts[st] = (stateCounts[st] || 0) + 1;
      const ref = res.reference;
      const dir = ref ? (ref.direction > 0 ? 'BUY' : 'SELL') : null;
      const setupId = ref ? `${inst}:${dir}:${ref.endTime}` : null;
      if (ref && st !== STATES.SEARCHING) {
        setupsThisHour.push({ pair: inst.replace('_', '/'), instrument: inst, direction: dir, state: st, score: res.setupScore != null ? res.setupScore : null, setupId });
      }

      // Transition = state change hour-to-hour (ignore SEARCHING↔SEARCHING and the initial →SEARCHING).
      const before = prev[inst];
      const fromState = before ? before.state : null;
      if (st !== fromState && (st !== STATES.SEARCHING || (fromState && fromState !== STATES.SEARCHING))) {
        transitions.push({
          pair: inst.replace('_', '/'), instrument: inst, direction: dir, setupId,
          fromState, toState: st,
          score: res.setupScore != null ? res.setupScore : null,
          evaluatedAtUtc: new Date(h).toISOString(),
          evaluatedAtLocal: localStr(h, tz),
          reasonCodes: res.reasons || [],
          invalidationCode: res.invalidation || null,
        });
      }
      prev[inst] = { state: st, setupId };
    }

    const topSetups = setupsThisHour
      .sort((a, b) => (STATE_PRIORITY[b.state] || 0) - (STATE_PRIORITY[a.state] || 0) || (b.score || 0) - (a.score || 0))
      .slice(0, 3);
    hourlySummaries.push({
      evaluatedAtUtc: new Date(h).toISOString(),
      evaluatedAtLocal: localStr(h, tz),
      stateCounts,
      setupCount: setupsThisHour.length,
      topSetups,
    });
  }

  return {
    historicalMode: true,
    date: opts.date,
    timezone: tz,
    dayStartUtc: new Date(startMs).toISOString(),
    dayEndUtc: new Date(endMs).toISOString(),
    engineVersion: ENGINE_VERSION,
    configurationVersion: CONFIGURATION_VERSION,
    hoursEvaluated: hourlySummaries.length,
    hourlySummaries,
    transitions,
    pairErrors,
    dataWarnings,
  };
}

module.exports = { replayDay, fetchPairRowsDb, STATE_PRIORITY };
