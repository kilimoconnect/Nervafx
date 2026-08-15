'use strict';

/**
 * /api/liquidity-failure?action=<coverage|snapshot|history|backfill|outcomes|backtest>
 *
 * Single Serverless Function fronting the whole Liquidity Failure Engine, to keep
 * the project's function count down. Each action preserves the behaviour of its
 * former standalone route; public paths are mapped in via vercel.json rewrites.
 *
 *   GET  coverage   — DB-derived coverage descriptor
 *   GET  snapshot   — point-in-time replay (?at / ?mode=latest_available)
 *   GET  history    — persisted signals within a range (no outcomes)
 *   POST backfill   — chronological idempotent backfill (admin, chunked)
 *   POST outcomes   — separate outcome processor (admin)
 *   GET  backtest   — metrics report over stored outcomes
 */

const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');
const { getCoverageCached, resolveSnapshotTime, scanSnapshot } = require('./_lfe-scan');
const { fetchClosed, fetchPairHistoryRange } = require('./_lfe-data');
const { runBackfill, createMemoryStore, makeMemoryEvaluate } = require('./_lfe-backfill');
const { createDbStore } = require('./_lfe-persist');
const { simulateOutcome } = require('./_lfe-outcome');
const { backtestReport, compareConfirmation } = require('./_lfe-metrics');
const { CONFIG, PAIRS, M15_MS, EVAL_MODE, DISPLAY_TIMEZONES } = require('./_lfe-constants');

const DAY = 24 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || 'snapshot';
  const sb = getClient();
  try {
    switch (action) {
      case 'coverage': return await coverage(req, res, sb);
      case 'snapshot': return await snapshot(req, res, sb);
      case 'history': return await history(req, res, sb);
      case 'backfill': return await backfill(req, res, sb);
      case 'outcomes': return await outcomes(req, res, sb);
      case 'backtest': return await backtest(req, res, sb);
      default: return res.status(400).json({ error: 'unknown action: ' + action });
    }
  } catch (e) {
    console.error('[liquidity-failure]', action, e.message);
    return res.status(500).json({ error: e.message });
  }
};
module.exports.maxDuration = 300;

// ── gates ────────────────────────────────────────────────────────────────────
async function requirePremium(req, res, sb) {
  if (req._internal) return true;
  const g = await requirePlan(sb, req, 'premium');
  if (g.error) { res.status(g.status).json({ error: g.error, upgrade: g.upgrade }); return false; }
  return true;
}
function adminOk(req) {
  const a = process.env.LFE_ADMIN_KEY;
  return req._internal || (a && req.headers['x-lfe-admin'] === a);
}
function methodGuard(req, res, method) {
  if (req.method !== method) { res.status(405).json({ error: method + ' only' }); return false; }
  return true;
}

// ── coverage ─────────────────────────────────────────────────────────────────
async function coverage(req, res, sb) {
  if (!methodGuard(req, res, 'GET')) return;
  if (!(await requirePremium(req, res, sb))) return;
  const cov = await getCoverageCached(sb, req.query.refresh === '1');
  if (!cov.ok) return res.status(503).json({ error: 'NO_COVERAGE', warnings: cov.warnings || [] });
  return res.json({
    engineVersion: CONFIG.version,
    configurationVersion: CONFIG.version,
    commonEarliest: cov.commonEarliestRawIso,
    earliestSelectable: cov.earliestSelectableIso,
    commonLatest: cov.commonLatestIso,
    warmupMs: cov.warmupMs,
    coverageByPair: cov.perPair
      ? Object.fromEntries(Object.entries(cov.perPair).map(([p, v]) => [p, {
        earliest: new Date(v.pairEarliest).toISOString(), latestClose: new Date(v.pairLatestClose).toISOString(),
      }]))
      : {},
    missingCandleWarnings: cov.warnings,
    displayTimezones: DISPLAY_TIMEZONES,
  });
}

// ── snapshot ─────────────────────────────────────────────────────────────────
async function snapshot(req, res, sb) {
  if (!methodGuard(req, res, 'GET')) return;
  if (!(await requirePremium(req, res, sb))) return;
  const cov = await getCoverageCached(sb);
  if (!cov.ok) return res.status(503).json({ error: 'NO_COVERAGE', warnings: cov.warnings || [] });
  const input = {
    at: req.query.at || null,
    timezone: req.query.timezone || 'UTC',
    mode: req.query.mode === EVAL_MODE.LATEST_AVAILABLE ? EVAL_MODE.LATEST_AVAILABLE : undefined,
  };
  const resolved = resolveSnapshotTime(input, cov);
  if (!resolved.ok) return res.status(422).json(resolved.error);
  const body = await scanSnapshot(sb, resolved.ctx, cov);
  res.setHeader('Cache-Control', resolved.ctx.mode === EVAL_MODE.HISTORICAL
    ? 's-maxage=86400, stale-while-revalidate=86400'
    : 's-maxage=55, stale-while-revalidate=30');
  return res.json(body);
}

// ── history ──────────────────────────────────────────────────────────────────
async function history(req, res, sb) {
  if (!methodGuard(req, res, 'GET')) return;
  if (!(await requirePremium(req, res, sb))) return;
  const q = req.query;
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
  let query = sb.from('liquidity_failure_signals')
    .select('signal_key, pair, direction, setup_type, classification, score, state, first_seen_at, updated_at, config_version, payload', { count: 'exact' })
    .order('first_seen_at', { ascending: false });
  if (q.from) query = query.gte('first_seen_at', new Date(q.from).toISOString());
  if (q.to) query = query.lte('first_seen_at', new Date(q.to).toISOString());
  if (q.direction) query = query.eq('direction', q.direction);
  if (q.setupType) query = query.eq('setup_type', q.setupType);
  if (q.pair) query = query.eq('pair', q.pair);
  if (q.state) query = query.eq('state', q.state);
  if (q.minimumScore) query = query.gte('score', parseFloat(q.minimumScore));
  query = query.range(offset, offset + limit - 1);
  const { data, error, count } = await query;
  if (error) throw error;
  let items = data || [];
  if (q.failedSide) items = items.filter((r) => r.payload && r.payload.failedSide === q.failedSide);
  return res.json({
    engineVersion: CONFIG.version,
    page: { limit, offset, count: count != null ? count : items.length, returned: items.length },
    items,
  });
}

// ── backfill ─────────────────────────────────────────────────────────────────
async function backfill(req, res, sb) {
  if (!methodGuard(req, res, 'POST')) return;
  if (!adminOk(req)) return res.status(403).json({ error: 'forbidden' });
  const cov = await getCoverageCached(sb);
  if (!cov.ok) return res.status(503).json({ error: 'NO_COVERAGE' });
  const q = req.query;
  const rangeFrom = q.from ? new Date(q.from).getTime() : cov.earliestSelectable;
  const rangeTo = q.to ? new Date(q.to).getTime() : cov.latestAvailable;
  const dryRun = q.dryRun === '1';
  const chunkMs = (q.chunkDays ? parseInt(q.chunkDays, 10) : 14) * DAY;
  const pairs = q.pair ? [q.pair] : PAIRS;
  const chunkFrom = q.checkpoint ? parseInt(q.checkpoint, 10) : rangeFrom;
  const chunkTo = Math.min(chunkFrom + chunkMs, rangeTo);
  // Backfill steps hourly by default (4x cheaper than M15); signals persist
  // across steps and dedupe by key, so hourly still captures them.
  const stepMs = Math.max(1, q.stepMinutes ? parseInt(q.stepMinutes, 10) : 60) * 60 * 1000;
  if (chunkFrom > rangeTo) return res.json({ rangeDone: true, message: 'checkpoint past range end' });

  const histories = {};
  const fetchErrors = [];
  for (const pair of pairs) {
    try { histories[pair] = await fetchPairHistoryRange(sb, pair, chunkFrom, chunkTo); }
    catch (e) { fetchErrors.push({ pair, error: e.message }); }
  }
  const store = dryRun ? createMemoryStore() : createDbStore(sb, CONFIG);
  const evaluate = makeMemoryEvaluate(histories, CONFIG);
  const result = await runBackfill({
    evaluate, store, from: chunkFrom, to: chunkTo, dryRun, pairs, cfg: CONFIG, stepMs,
    batchPairs: q.batchPairs ? parseInt(q.batchPairs, 10) : CONFIG.backtest.batchPairs,
  });
  const rangeDone = chunkTo >= rangeTo;
  return res.json({
    chunk: { fromMs: chunkFrom, toMs: chunkTo, from: new Date(chunkFrom).toISOString(), to: new Date(chunkTo).toISOString() },
    rangeDone,
    checkpoint: rangeDone ? null : { nextMs: chunkTo + stepMs },
    rangeProgressPct: rangeTo > rangeFrom ? Math.round(((chunkTo - rangeFrom) / (rangeTo - rangeFrom)) * 1000) / 1000 : 1,
    stepMinutes: stepMs / 60000, chunkDays: chunkMs / DAY,
    created: result.created, dupes: result.dupes, steps: result.progress.steps,
    evalErrors: result.errors, fetchErrors, dryRun, configVersion: CONFIG.version,
  });
}

// ── outcomes ─────────────────────────────────────────────────────────────────
async function outcomes(req, res, sb) {
  if (!methodGuard(req, res, 'POST')) return;
  if (!adminOk(req)) return res.status(403).json({ error: 'forbidden' });
  const q = req.query;
  const limit = Math.min(parseInt(q.limit, 10) || 200, 500);
  const { data: signals, error } = await sb.from('liquidity_failure_signals')
    .select('signal_key, pair, direction, config_version, payload')
    .eq('config_version', CONFIG.version)
    .order('first_seen_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  const spread = CONFIG.backtest.spread, slippage = CONFIG.backtest.slippage;
  let processed = 0, skipped = 0;
  for (const s of (signals || [])) {
    const sig = s.payload || {};
    const risk = sig.risk;
    const confirmAtMs = sig.confirmAtMs || (sig.confirmation && sig.confirmation.confirmAtMs);
    if (!risk || !risk.ok || confirmAtMs == null) { skipped += 1; continue; }
    const horizonMs = confirmAtMs + CONFIG.backtest.maxHoldCandles * M15_MS;
    const m15 = await fetchClosed(sb, s.pair, 'M15', Math.min(horizonMs, Date.now()), M15_MS, CONFIG.backtest.maxHoldCandles + 8);
    const future = m15.filter((c) => c.openMs >= confirmAtMs);
    const plan = { direction: s.direction, entry: risk.entry, stop: risk.stop, target: risk.target, entryMs: confirmAtMs };
    const o = simulateOutcome(plan, future, { spread, slippage, maxHoldCandles: CONFIG.backtest.maxHoldCandles, cfg: CONFIG });
    const row = {
      signal_key: s.signal_key,
      outcome: o.status === 'WIN' ? 'TARGET_REACHED' : (o.status === 'LOSS' ? 'STOPPED' : 'EXPIRED'),
      resolved_at: o.exitTime ? new Date(o.exitTime).toISOString() : null,
      r_multiple: o.resultR, config_version: CONFIG.version,
      metrics: Object.assign({}, o, {
        pair: s.pair, direction: s.direction, setupType: sig.setupType, failedSide: sig.failedSide,
        classification: sig.classification, score: sig.score ? sig.score.total : null,
        levelType: sig.event ? sig.event.levelType : null, entryMs: confirmAtMs,
      }),
    };
    const up = await sb.from('liquidity_failure_outcomes').upsert(row, { onConflict: 'signal_key,config_version' });
    if (up.error) throw up.error;
    processed += 1;
  }
  return res.json({ engineVersion: CONFIG.version, processed, skipped, considered: (signals || []).length });
}

// ── backtest ─────────────────────────────────────────────────────────────────
async function backtest(req, res, sb) {
  if (!methodGuard(req, res, 'GET')) return;
  if (!(await requirePremium(req, res, sb))) return;
  const q = req.query;
  let query = sb.from('liquidity_failure_outcomes')
    .select('signal_key, r_multiple, resolved_at, config_version, metrics')
    .eq('config_version', CONFIG.version).limit(5000);
  if (q.from) query = query.gte('resolved_at', new Date(q.from).toISOString());
  if (q.to) query = query.lte('resolved_at', new Date(q.to).toISOString());
  const { data, error } = await query;
  if (error) throw error;
  let outs = (data || []).map((r) => Object.assign({}, r.metrics, { resultR: r.r_multiple }));
  if (q.pair) outs = outs.filter((o) => o.pair === q.pair);
  if (q.minScore) outs = outs.filter((o) => (o.score || 0) >= parseFloat(q.minScore));
  const withMode = outs.filter((o) => o.mode);
  return res.json({
    engineVersion: CONFIG.version,
    sampleSize: outs.length,
    report: backtestReport(outs, CONFIG),
    confirmationComparison: withMode.length ? compareConfirmation(withMode) : null,
    note: 'Outcomes are analytical only; profitability is not claimed unless an untouched test period stays positive after costs.',
  });
}
