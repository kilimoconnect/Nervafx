'use strict';

/**
 * POST /api/create-checkout
 *
 * Body: { plan: 'pro' | 'premium' }
 * Returns: { tx_ref, amount, currency, customer, meta, public_key }
 *
 * Generates a secure tx_ref and returns the config the client needs
 * to launch the Flutterwave Inline payment modal.
 *
 * If the user is upgrading from Pro → Premium, charges only the
 * prorated difference for the remaining days on their current plan.
 */

const { cors, getClient } = require('./_db');
const { verifyToken, getPlan, PLAN_PRICES, PLAN_LEVELS } = require('./_plan');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  try {
    const sb = getClient();
    const { user, error: authErr } = await verifyToken(sb, req);
    if (!user) return res.status(401).json({ error: authErr || 'Unauthorized' });

    const { plan } = req.body || {};
    if (!plan || !PLAN_PRICES[plan]) {
      return res.status(400).json({ error: 'Invalid plan. Must be "pro" or "premium".' });
    }

    // Get current subscription
    const currentSub = await getPlan(sb, user.id);
    const currentLevel = PLAN_LEVELS[currentSub.plan] ?? 0;
    const targetLevel  = PLAN_LEVELS[plan] ?? 0;

    if (currentLevel >= targetLevel && currentSub.status === 'active') {
      return res.status(400).json({ error: `You already have the ${currentSub.plan} plan.` });
    }

    let amount = PLAN_PRICES[plan];
    let isUpgrade = false;
    let remainingDays = 0;

    // Pro → Premium upgrade: charge prorated difference
    if (currentSub.plan === 'pro' && plan === 'premium' && currentSub.status === 'active' && currentSub.expires_at) {
      const now = new Date();
      const expires = new Date(currentSub.expires_at);
      remainingDays = Math.max(0, Math.ceil((expires - now) / (1000 * 60 * 60 * 24)));

      if (remainingDays > 0) {
        isUpgrade = true;
        // Daily rate difference × remaining days
        const proDailyRate    = PLAN_PRICES.pro / 30;
        const premDailyRate   = PLAN_PRICES.premium / 30;
        const dailyDifference = premDailyRate - proDailyRate;
        amount = Math.max(1, Math.round(dailyDifference * remainingDays * 100) / 100);
      }
    }

    const tx_ref = `nfx-${user.id.slice(0, 8)}-${plan}-${Date.now()}`;
    const label  = plan.charAt(0).toUpperCase() + plan.slice(1);
    const description = isUpgrade
      ? `Upgrade to ${label} — ${remainingDays} days remaining (prorated)`
      : `${label} Plan — $${amount}/mo`;

    res.json({
      public_key: process.env.FLW_PUBLIC_KEY,
      tx_ref,
      amount,
      currency: 'USD',
      customer: {
        email: user.email,
        name:  user.user_metadata?.full_name || user.email,
      },
      meta: {
        user_id: user.id,
        plan,
        is_upgrade: isUpgrade,
        remaining_days: remainingDays,
      },
      customizations: {
        title:       'NervaFX',
        description,
        logo:        '/nervafx-logo.png',
      },
    });
  } catch (e) {
    console.error('[CHECKOUT]', e.message);
    res.status(500).json({ error: e.message });
  }
};
