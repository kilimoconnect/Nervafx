'use strict';

/**
 * POST /api/flutterwave-webhook
 *
 * Receives Flutterwave payment webhooks, verifies the transaction
 * server-side, and upserts the user's subscription row.
 */

const { getClient } = require('./_db');
const { PLAN_PRICES } = require('./_plan');

module.exports = async function handler(req, res) {
  // No CORS — server-to-server only
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    // ── 1. Verify webhook hash ────────────────────────────────────────────
    const hash = req.headers['verif-hash'];
    if (!hash || hash !== process.env.FLW_WEBHOOK_HASH) {
      console.warn('[WEBHOOK] Invalid verif-hash');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { event, data } = req.body || {};
    if (event !== 'charge.completed' || !data) {
      return res.status(200).json({ status: 'ignored' });
    }

    const { tx_ref, id: txId, status, amount, currency, customer, meta } = data;

    // Only process successful charges
    if (status !== 'successful') {
      return res.status(200).json({ status: 'not_successful' });
    }

    const sb = getClient();

    // ── 2. Idempotency — already processed? ──────────────────────────────
    const { data: existing } = await sb
      .from('subscriptions')
      .select('flw_tx_ref')
      .eq('flw_tx_ref', tx_ref)
      .single();

    if (existing) {
      return res.status(200).json({ status: 'already_processed' });
    }

    // ── 3. Server-side verification with Flutterwave ─────────────────────
    const verifyRes = await fetch(
      `https://api.flutterwave.com/v3/transactions/${txId}/verify`,
      { headers: { 'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}` } }
    );
    const verifyData = await verifyRes.json();

    if (
      verifyData.status !== 'success' ||
      verifyData.data?.status !== 'successful'
    ) {
      console.warn('[WEBHOOK] Verification failed for tx', txId);
      return res.status(400).json({ error: 'Transaction verification failed' });
    }

    // ── 4. Determine plan from meta or tx_ref ────────────────────────────
    const plan = meta?.plan || tx_ref.split('-')[2];  // nfx-{uid}-{plan}-{ts}
    if (!PLAN_PRICES[plan]) {
      console.warn('[WEBHOOK] Unknown plan from tx_ref:', tx_ref);
      return res.status(400).json({ error: 'Unknown plan' });
    }

    // Verify amount matches expected price
    const expectedAmount = PLAN_PRICES[plan];
    if (verifyData.data.amount < expectedAmount) {
      console.warn('[WEBHOOK] Amount mismatch:', verifyData.data.amount, 'vs', expectedAmount);
      return res.status(400).json({ error: 'Amount mismatch' });
    }

    // ── 5. Find user by meta.user_id or by customer email ────────────────
    let userId = meta?.user_id;
    if (!userId && customer?.email) {
      // Fallback: look up by email
      const { data: users } = await sb.auth.admin.listUsers();
      const found = users?.users?.find(u => u.email === customer.email);
      userId = found?.id;
    }

    if (!userId) {
      console.error('[WEBHOOK] Cannot resolve user for tx:', tx_ref);
      return res.status(400).json({ error: 'User not found' });
    }

    // ── 6. Upsert subscription ───────────────────────────────────────────
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const { error: upsertErr } = await sb
      .from('subscriptions')
      .upsert({
        user_id:    userId,
        plan,
        status:     'active',
        flw_tx_ref: tx_ref,
        flw_tx_id:  txId,
        amount:     verifyData.data.amount,
        currency:   verifyData.data.currency || currency || 'USD',
        started_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    if (upsertErr) {
      console.error('[WEBHOOK] Upsert error:', upsertErr.message);
      return res.status(500).json({ error: 'Failed to update subscription' });
    }

    console.log(`[WEBHOOK] Activated ${plan} for user ${userId} (tx: ${tx_ref})`);
    res.status(200).json({ status: 'ok', plan });
  } catch (e) {
    console.error('[WEBHOOK]', e.message);
    res.status(500).json({ error: e.message });
  }
};
