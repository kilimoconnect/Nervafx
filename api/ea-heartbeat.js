'use strict';

const { getClient, cors } = require('./_db');

async function resolveApiKey(sb, key) {
  if (!key) return null;
  const { data } = await sb
    .from('ea_settings')
    .select('user_id')
    .eq('api_key', key)
    .single();
  return data?.user_id || null;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const sb     = getClient();
    const apiKey = req.headers['x-ea-key'];
    const userId = await resolveApiKey(sb, apiKey);
    if (!userId) return res.status(401).json({ error: 'Invalid API key' });

    const b = req.body || {};

    const { error } = await sb
      .from('ea_accounts')
      .upsert({
        user_id:         userId,
        account_number:  b.account_number || null,
        broker_name:     b.broker_name || null,
        balance:         b.balance ?? 0,
        equity:          b.equity ?? 0,
        floating_pl:     b.floating_pl ?? 0,
        margin_used:     b.margin_used ?? 0,
        margin_free:     b.margin_free ?? 0,
        open_positions:  b.open_positions || [],
        trade_history:   b.trade_history || [],
        last_heartbeat:  new Date().toISOString(),
      }, { onConflict: 'user_id' });

    if (error) throw new Error(error.message);

    res.json({ ok: true, server_time: new Date().toISOString() });
  } catch (e) {
    console.error('[EA-HEARTBEAT]', e.message);
    res.status(500).json({ error: e.message });
  }
};
