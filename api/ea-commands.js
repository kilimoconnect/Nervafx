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

  try {
    const sb     = getClient();
    const apiKey = req.headers['x-ea-key'];
    const userId = await resolveApiKey(sb, apiKey);
    if (!userId) return res.status(401).json({ error: 'Invalid API key' });

    if (req.method === 'GET') {
      const { data, error } = await sb
        .from('ea_commands')
        .select('id, instrument, action, params')
        .eq('user_id', userId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(10);
      if (error) throw new Error(error.message);
      return res.json({ commands: data || [] });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.command_id) return res.status(400).json({ error: 'command_id required' });

      const status = b.status === 'failed' ? 'failed' : 'acked';
      const { error } = await sb
        .from('ea_commands')
        .update({
          status,
          result_ticket: b.ticket || null,
          error_message: b.error || null,
          acked_at:      new Date().toISOString(),
        })
        .eq('id', b.command_id)
        .eq('user_id', userId);
      if (error) throw new Error(error.message);

      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    console.error('[EA-COMMANDS]', e.message);
    res.status(500).json({ error: e.message });
  }
};
