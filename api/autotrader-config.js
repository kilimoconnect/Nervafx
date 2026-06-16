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

      // Read risk settings from user profile
      const { data: profile } = await sb
        .from('profiles')
        .select('account_size, max_daily_risk_pct, max_trades, min_rr')
        .eq('id', userId)
        .single();

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
        api_key:              settings.api_key,
        auto_trading_enabled: settings.auto_trading_enabled,
        // From profile
        max_trades:           profile?.max_trades || 3,
        max_daily_risk_pct:   profile?.max_daily_risk_pct || 2,
        min_rr:               profile?.min_rr || 2,
        account_size:         profile?.account_size || 10000,
        // Broker state
        broker_connected:     brokerConnected,
        last_heartbeat:       account?.last_heartbeat || null,
        account_number:       account?.account_number || null,
        broker_name:          account?.broker_name || null,
        balance:              account?.balance || 0,
        equity:               account?.equity || 0,
        floating_pl:          account?.floating_pl || 0,
        margin_used:          account?.margin_used || 0,
        margin_free:          account?.margin_free || 0,
        open_positions:       account?.open_positions || [],
        trade_history:        account?.trade_history || [],
        pending_commands:     pending || [],
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (body.auto_trading_enabled == null) return res.status(400).json({ error: 'auto_trading_enabled required' });

      const { error } = await sb
        .from('ea_settings')
        .update({
          auto_trading_enabled: !!body.auto_trading_enabled,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);
      if (error) throw new Error(error.message);

      return res.json({ ok: true, auto_trading_enabled: !!body.auto_trading_enabled });
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    console.error('[AUTOTRADER-CONFIG]', e.message);
    res.status(500).json({ error: e.message });
  }
};
