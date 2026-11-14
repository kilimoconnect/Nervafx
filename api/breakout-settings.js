'use strict';

/**
 * /api/breakout-settings — the Breakout strong-threshold configuration.
 *
 *   GET  ?strategy=daily|weekly|monthly   → the active threshold + full version history.
 *   GET  (no strategy)                    → the active threshold for all three strategies.
 *   POST { strategy, strongThreshold }    → publish a NEW settings version (admin only).
 *
 * The strong-threshold is a CONFIGURABLE ASSUMPTION (symmetric integer 4–7). Changing it
 * creates a new versioned row (`bss-x-1.0.0-t<n>`) and makes it active; previously-published
 * signals keep the version + frozen params they were published under and are never rewritten.
 *
 * POST is admin-gated server-side (Bearer token → ADMIN_UIDS), returning 403 otherwise.
 */

const { getClient, cors } = require('./_db');
const { verifyToken, ADMIN_UIDS } = require('./_plan');
const { STRATEGY_KEYS, DEFAULT_PARAMS, MIN_THRESHOLD, MAX_THRESHOLD, validThreshold, versionFor, STRATEGIES } = require('../research/breakout/config');

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

async function versionsFor(sb, strategyKey) {
  const { data, error } = await sb.from('breakout_settings_versions')
    .select('version,params,active,created_at').eq('strategy_key', strategyKey)
    .order('created_at', { ascending: false });
  if (error) throw new Error('settings read: ' + error.message);
  return data || [];
}

function activeFrom(rows) {
  const act = rows.find((r) => r.active) || rows[0] || null;
  return act && act.params && act.params.strongThreshold != null ? validThreshold(act.params.strongThreshold) : DEFAULT_PARAMS.strongThreshold;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const sb = getClient();

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      const meta = { range: [MIN_THRESHOLD, MAX_THRESHOLD], default: DEFAULT_PARAMS.strongThreshold, alignment: 'EAT (UTC+3)', note: 'strongThreshold is a configurable assumption; changing it versions forward and never rewrites published signals.' };
      if (STRATEGY_KEYS.includes(String(q.strategy))) {
        const key = String(q.strategy);
        const rows = await versionsFor(sb, key);
        const threshold = activeFrom(rows);
        return res.json({ ok: true, strategy: key, threshold, activeVersion: versionFor(STRATEGIES[key].methodology, threshold), meta, history: rows.map((r) => ({ version: r.version, params: r.params, active: r.active, createdAt: r.created_at })) });
      }
      const all = {};
      for (const key of STRATEGY_KEYS) { const rows = await versionsFor(sb, key); const threshold = activeFrom(rows); all[key] = { threshold, activeVersion: versionFor(STRATEGIES[key].methodology, threshold), versions: rows.length }; }
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
      const raw = Number(body.strongThreshold);
      if (!Number.isInteger(raw) || raw < MIN_THRESHOLD || raw > MAX_THRESHOLD) {
        return res.status(400).json({ ok: false, error: `strongThreshold must be an integer in [${MIN_THRESHOLD}, ${MAX_THRESHOLD}]` });
      }
      const threshold = validThreshold(raw);
      const version = versionFor(STRATEGIES[key].methodology, threshold);

      // Deactivate the strategy's other versions, then upsert + activate this one.
      const { error: deErr } = await sb.from('breakout_settings_versions').update({ active: false }).eq('strategy_key', key).neq('version', version);
      if (deErr) throw new Error('deactivate: ' + deErr.message);
      const { error: upErr } = await sb.from('breakout_settings_versions')
        .upsert([{ strategy_key: key, version, params: { strongThreshold: threshold }, active: true }], { onConflict: 'strategy_key,version' });
      if (upErr) throw new Error('activate: ' + upErr.message);

      const rows = await versionsFor(sb, key);
      return res.json({
        ok: true, strategy: key, threshold, activeVersion: version,
        note: 'Active threshold updated. Forward processing uses it from the next trigger close; published signals are unchanged.',
        history: rows.map((r) => ({ version: r.version, params: r.params, active: r.active, createdAt: r.created_at })),
      });
    }

    return res.status(405).json({ ok: false, error: 'GET or POST' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 30;
