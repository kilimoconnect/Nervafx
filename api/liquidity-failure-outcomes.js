'use strict';

/**
 * POST /api/liquidity-failure-outcomes
 *
 * Separate outcome processor (Portion 8D). For persisted confirmed signals whose
 * confirmation time is in the past, simulate the fixed execution model against
 * candles that come ONLY AFTER the signal timestamp, and store the result in
 * liquidity_failure_outcomes. Outcomes never leak into the replay snapshot.
 * Admin-gated. Idempotent by signal_key + config_version.
 */

const { cors, getClient } = require('./_db');
const { fetchClosed } = require('./_lfe-data');
const { simulateOutcome } = require('./_lfe-outcome');
const { CONFIG, M15_MS } = require('./_lfe-constants');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const admin = process.env.LFE_ADMIN_KEY;
  if (!req._internal && (!admin || req.headers['x-lfe-admin'] !== admin)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const sb = getClient();
  try {
    const q = req.query || {};
    const limit = Math.min(parseInt(q.limit, 10) || 200, 500);

    // Confirmed signals not yet resolved for this config version.
    const { data: signals, error } = await sb.from('liquidity_failure_signals')
      .select('signal_key, pair, direction, config_version, payload')
      .eq('config_version', CONFIG.version)
      .order('first_seen_at', { ascending: true })
      .limit(limit);
    if (error) throw error;

    const spread = CONFIG.backtest.spread;
    const slippage = CONFIG.backtest.slippage;
    let processed = 0, skipped = 0;

    for (const s of (signals || [])) {
      const sig = s.payload || {};
      const risk = sig.risk;
      const confirmAtMs = sig.confirmAtMs || (sig.confirmation && sig.confirmation.confirmAtMs);
      if (!risk || !risk.ok || confirmAtMs == null) { skipped += 1; continue; }

      // Candles strictly after the confirmation, up to the max hold window.
      const horizonMs = confirmAtMs + CONFIG.backtest.maxHoldCandles * M15_MS;
      const m15 = await fetchClosed(sb, s.pair, 'M15', Math.min(horizonMs, Date.now()), M15_MS, CONFIG.backtest.maxHoldCandles + 8);
      const future = m15.filter((c) => c.openMs >= confirmAtMs);

      const plan = { direction: s.direction, entry: risk.entry, stop: risk.stop, target: risk.target, entryMs: confirmAtMs };
      const o = simulateOutcome(plan, future, { spread, slippage, maxHoldCandles: CONFIG.backtest.maxHoldCandles, cfg: CONFIG });

      const row = {
        signal_key: s.signal_key,
        outcome: o.status === 'WIN' ? 'TARGET_REACHED' : (o.status === 'LOSS' ? 'STOPPED' : 'EXPIRED'),
        resolved_at: o.exitTime ? new Date(o.exitTime).toISOString() : null,
        r_multiple: o.resultR,
        config_version: CONFIG.version,
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

    res.json({ engineVersion: CONFIG.version, processed, skipped, considered: (signals || []).length });
  } catch (e) {
    console.error('[liquidity-failure-outcomes]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 300;
