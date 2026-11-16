'use strict';

/**
 * /api/breakout-settings — the Breakout v2 (Evolution) condition configuration.
 *
 *   GET  ?strategy=daily|weekly|monthly   → the active params + full version history.
 *   GET  (no strategy)                    → the active params for all three strategies.
 *   POST { strategy, breadthMin?, dirDeadband?, effDeadband? }
 *                                         → publish a NEW settings version (admin only).
 *
 * The condition params are CONFIGURABLE ASSUMPTIONS: breadthMin (how many of a currency's 7
 * legs must agree inside the fast window, 4–7), and the movement deadbands (default 0). Changing
 * any of them creates a new versioned row (`bss-x-2.0.0-b…f…s…d…e…`) and makes it active;
 * previously-published signals keep the version + frozen params they were published under and
 * are never rewritten. v1 vote-based signals (`bss-x-1.0.0-t…`) remain untouched.
 *
 * POST is admin-gated server-side (Bearer token → ADMIN_UIDS), returning 403 otherwise.
 */

const { getClient, cors } = require('./_db');
const { verifyToken, ADMIN_UIDS } = require('./_plan');
const { STRATEGY_KEYS, DEFAULT_PARAMS, PARAM_RANGES, validParams, versionFor, STRATEGIES } = require('../research/breakout/config');

async function versionsFor(sb, strategyKey) {
  // Degrade gracefully before the migration is applied (table missing → no stored versions yet).
  try {
    const { data, error } = await sb.from('breakout_settings_versions')
      .select('version,params,active,created_at').eq('strategy_key', strategyKey)
      .order('created_at', { ascending: false });
    if (error) return [];
    return data || [];
  } catch (_) { return []; }
}

function activeFrom(rows) {
  const act = rows.find((r) => r.active) || rows[0] || null;
  return act && act.params ? validParams(act.params) : validParams(DEFAULT_PARAMS);
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const sb = getClient();

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      const meta = {
        ranges: PARAM_RANGES, defaults: DEFAULT_PARAMS, alignment: 'EAT (UTC+3)',
        methodology: 'Evolution-qualified breakout (v2)',
        note: 'Condition params are configurable assumptions; changing one versions forward and never rewrites published signals. v1 vote-based signals are preserved separately.',
      };
      if (STRATEGY_KEYS.includes(String(q.strategy))) {
        const key = String(q.strategy);
        const rows = await versionsFor(sb, key);
        const params = activeFrom(rows);
        return res.json({ ok: true, strategy: key, params, activeVersion: versionFor(STRATEGIES[key], params), windows: STRATEGIES[key].condition, meta, history: rows.map((r) => ({ version: r.version, params: r.params, active: r.active, createdAt: r.created_at })) });
      }
      const all = {};
      for (const key of STRATEGY_KEYS) { const rows = await versionsFor(sb, key); const params = activeFrom(rows); all[key] = { params, activeVersion: versionFor(STRATEGIES[key], params), windows: STRATEGIES[key].condition, versions: rows.length }; }
      return res.json({ ok: true, strategies: all, meta });
    }

    if (req.method === 'POST') {
      const { user, error: authErr } = await verifyToken(sb, req);
      if (!user) return res.status(401).json({ ok: false, error: authErr || 'Unauthorized' });
      if (!ADMIN_UIDS.has(user.id)) return res.status(403).json({ ok: false, error: 'Admin only' });

      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
      body = body || {};
      const key = String(body.strategy || '');
      if (!STRATEGY_KEYS.includes(key)) return res.status(400).json({ ok: false, error: 'strategy must be one of ' + STRATEGY_KEYS.join(', ') });

      // start from the current active params, override only what was supplied, then validate/clamp.
      const current = activeFrom(await versionsFor(sb, key));
      const merged = validParams({
        breadthMin: body.breadthMin != null ? body.breadthMin : current.breadthMin,
        dirDeadband: body.dirDeadband != null ? body.dirDeadband : current.dirDeadband,
        effDeadband: body.effDeadband != null ? body.effDeadband : current.effDeadband,
      });
      const version = versionFor(STRATEGIES[key], merged);

      // Deactivate the strategy's other versions, then upsert + activate this one.
      const { error: deErr } = await sb.from('breakout_settings_versions').update({ active: false }).eq('strategy_key', key).neq('version', version);
      if (deErr) throw new Error('deactivate: ' + deErr.message);
      const { error: upErr } = await sb.from('breakout_settings_versions')
        .upsert([{ strategy_key: key, version, params: merged, active: true }], { onConflict: 'strategy_key,version' });
      if (upErr) throw new Error('activate: ' + upErr.message);

      const rows = await versionsFor(sb, key);
      return res.json({
        ok: true, strategy: key, params: merged, activeVersion: version,
        note: 'Active condition params updated. Forward processing uses them from the next trigger close; published signals are unchanged.',
        history: rows.map((r) => ({ version: r.version, params: r.params, active: r.active, createdAt: r.created_at })),
      });
    }

    return res.status(405).json({ ok: false, error: 'GET or POST' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 30;
