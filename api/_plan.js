'use strict';

/**
 * Shared auth + subscription plan helpers.
 *
 * verifyToken(sb, req)          — extract user from Bearer token
 * getPlan(sb, userId)           — { plan, status, expires_at }
 * requirePlan(sb, req, minPlan) — gate endpoint behind a minimum plan
 */

const PLAN_LEVELS = { free: 0, pro: 1, premium: 2 };

const PLAN_PRICES = { pro: 59, premium: 89 };

// Admin — permanent premium, never expires
const ADMIN_UIDS = new Set([
  '140f3854-2c85-488c-8e0a-0f965d562654', // Henry Muleke
]);

/* ── Auth ──────────────────────────────────────────────────────────────────── */

async function verifyToken(sb, req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return { user: null, error: 'No token' };
  const { data: { user }, error } = await sb.auth.getUser(token);
  return { user: user || null, error: error?.message || null };
}

/* ── Plan lookup ───────────────────────────────────────────────────────────── */

async function getPlan(sb, userId) {
  // Admin bypass — always premium, never expires
  if (ADMIN_UIDS.has(userId)) {
    return { plan: 'premium', status: 'active', expires_at: null, started_at: null };
  }

  const { data, error } = await sb
    .from('subscriptions')
    .select('plan, status, expires_at, started_at, flw_tx_ref')
    .eq('user_id', userId)
    .single();

  // No row → free
  if (error || !data) return { plan: 'free', status: 'active', expires_at: null };

  // Auto-downgrade expired paid plans
  if (data.plan !== 'free' && data.expires_at && new Date(data.expires_at) < new Date()) {
    return { plan: 'free', status: 'expired', expires_at: data.expires_at };
  }

  return {
    plan:       data.plan,
    status:     data.status,
    expires_at: data.expires_at,
    started_at: data.started_at,
  };
}

/* ── Gate helper ───────────────────────────────────────────────────────────── */

async function requirePlan(sb, req, minPlan) {
  const { user, error: authErr } = await verifyToken(sb, req);
  if (!user) return { error: authErr || 'Unauthorized', status: 401 };

  const sub = await getPlan(sb, user.id);
  const userLevel = PLAN_LEVELS[sub.plan] ?? 0;
  const needed    = PLAN_LEVELS[minPlan]  ?? 0;

  if (userLevel < needed) {
    return {
      error: `${minPlan.charAt(0).toUpperCase() + minPlan.slice(1)} plan required`,
      status: 403,
      upgrade: true,
      current: sub.plan,
      required: minPlan,
    };
  }

  return { user, plan: sub.plan, sub };
}

module.exports = { PLAN_LEVELS, PLAN_PRICES, verifyToken, getPlan, requirePlan };
