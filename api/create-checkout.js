'use strict';

/**
 * POST /api/create-checkout
 *
 * Body: { plan: 'pro' | 'premium' }
 * Returns: { tx_ref, amount, currency, customer, meta, public_key }
 *
 * Generates a secure tx_ref and returns the config the client needs
 * to launch the Flutterwave Inline payment modal.
 */

const { cors, getClient } = require('./_db');
const { verifyToken, PLAN_PRICES } = require('./_plan');

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

    const amount = PLAN_PRICES[plan];
    const tx_ref = `nfx-${user.id.slice(0, 8)}-${plan}-${Date.now()}`;
    const label  = plan.charAt(0).toUpperCase() + plan.slice(1);

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
      },
      customizations: {
        title:       'NervaFX',
        description: `${label} Plan — $${amount}/mo`,
        logo:        '/nervafx-logo.png',
      },
    });
  } catch (e) {
    console.error('[CHECKOUT]', e.message);
    res.status(500).json({ error: e.message });
  }
};
