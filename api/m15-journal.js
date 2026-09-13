'use strict';

/**
 * /api/m15-journal — per-user manual observation journal (Phase 4).
 *
 * GET  → the CALLER'S OWN entries only.  POST → add/update one of the caller's
 * entries (SEEN | SKIPPED | MANUALLY_TRADED). Every query is scoped to the
 * verified Supabase user id; a client can never read or write another user's
 * rows, and no client-supplied user_id is trusted. Entries are self-reported and
 * NEVER place, size, or manage an order. Requires migration 023 (m15i_journal).
 */

const { getClient } = require('./_db');
const { buildJournalEntry } = require('./_m15/journal');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
async function verifyToken(sb, req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return { user: null, error: 'No token' };
  const { data: { user }, error } = await sb.auth.getUser(token);
  return { user: user || null, error: error?.message || null };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const sb = getClient();
    const { user, error: authErr } = await verifyToken(sb, req);
    if (!user) return res.status(401).json({ error: authErr || 'Unauthorized' });

    if (req.method === 'GET') {
      const { data, error } = await sb.from('m15i_journal')
        .select('*').eq('user_id', user.id)          // ← scoped to the caller only
        .order('created_at', { ascending: false }).limit(500);
      if (error) throw new Error(error.message);
      return res.json({ ok: true, entries: data || [], selfReported: true });
    }

    if (req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
      let row;
      try { row = buildJournalEntry(user.id, body); } catch (e) { return res.status(400).json({ error: e.message }); }
      const { data, error } = await sb.from('m15i_journal')
        .upsert(row, { onConflict: 'user_id,episode_id,action' }).select().limit(1);
      if (error) throw new Error(error.message);
      return res.json({ ok: true, entry: (data && data[0]) || row, selfReported: true });
    }

    return res.status(405).json({ error: 'GET or POST' });
  } catch (e) {
    return res.status(500).json({ error: e.message, note: 'Requires migration 023 (m15i_journal) applied.' });
  }
};
