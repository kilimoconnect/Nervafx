'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan }     = require('./_plan');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const sb   = getClient();
    const gate = await requirePlan(sb, req, 'pro');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const userId = gate.user.id;

    if (req.method === 'GET') {
      let { data: settings } = await sb
        .from('ea_settings')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (!settings) {
        const { data: created, error: createErr } = await sb
          .from('ea_settings')
          .insert({ user_id: userId })
          .select()
          .single();
        if (createErr) throw new Error(createErr.message);
        settings = created;
      }

      const { data: account } = await sb
        .from('ea_accounts')
        .select('*')
        .eq('user_id', userId)
        .single();

      const now = Date.now();
      const lastHb = account?.last_heartbeat ? new Date(account.last_heartbeat).getTime() : 0;
      const brokerConnected = (now - lastHb) < 30000;

      const { data: pending } = await sb
        .from('ea_commands')
        .select('id, instrument, action, params, status, created_at')
        .eq('user_id', userId)
        .in('status', ['pending', 'acked'])
        .order('created_at', { ascending: false })
        .limit(20);

      return res.json({
        api_key:               settings.api_key,
        risk_pct:              settings.risk_pct,
        max_trades:            settings.max_trades,
        direction_threshold:   settings.direction_threshold,
        auto_trading_enabled:  settings.auto_trading_enabled,
        broker_connected:      brokerConnected,
        last_heartbeat:        account?.last_heartbeat || null,
        account_number:        account?.account_number || null,
        broker_name:           account?.broker_name || null,
        balance:               account?.balance || 0,
        equity:                account?.equity || 0,
        floating_pl:           account?.floating_pl || 0,
        margin_used:           account?.margin_used || 0,
        margin_free:           account?.margin_free || 0,
        open_positions:        account?.open_positions || [],
        trade_history:         account?.trade_history || [],
        pending_commands:      pending || [],
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const updates = {};

      if (body.risk_pct != null) {
        const v = parseFloat(body.risk_pct);
        if (v < 0.1 || v > 5) return res.status(400).json({ error: 'risk_pct must be 0.1-5.0' });
        updates.risk_pct = v;
      }
      if (body.max_trades != null) {
        const v = parseInt(body.max_trades, 10);
        if (v < 1 || v > 10) return res.status(400).json({ error: 'max_trades must be 1-10' });
        updates.max_trades = v;
      }
      if (body.direction_threshold != null) {
        const v = parseFloat(body.direction_threshold);
        if (v < 30 || v > 100) return res.status(400).json({ error: 'direction_threshold must be 30-100' });
        updates.direction_threshold = v;
      }
      if (body.auto_trading_enabled != null) {
        updates.auto_trading_enabled = !!body.auto_trading_enabled;
      }

      if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });

      updates.updated_at = new Date().toISOString();

      const { error } = await sb
        .from('ea_settings')
        .update(updates)
        .eq('user_id', userId);
      if (error) throw new Error(error.message);

      return res.json({ ok: true, ...updates });
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    console.error('[AUTOTRADER-CONFIG]', e.message);
    res.status(500).json({ error: e.message });
  }
};
