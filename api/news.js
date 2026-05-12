const { getClient, cors } = require('./_db');

const ADMIN_ID = '140f3854-2c85-488c-8e0a-0f965d562654';

async function verifyAdmin(sb, req) {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!auth) return false;
  try {
    const { data, error } = await sb.auth.getUser(auth);
    return !error && data?.user?.id === ADMIN_ID;
  } catch { return false; }
}

module.exports = async function handler(req, res) {
  cors(res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = getClient();

  // ── GET ─────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    // Admin: ?all=1  →  full dataset with optional from/to filters
    if (req.query?.all === '1') {
      if (!(await verifyAdmin(sb, req))) return res.status(403).json({ error: 'Admin only' });
      const from = req.query.from; // YYYY-MM-DD
      const to   = req.query.to;   // YYYY-MM-DD
      let q = sb.from('forex_news').select('*').order('event_time', { ascending: true }).limit(2000);
      if (from) q = q.gte('event_time', from + 'T00:00:00Z');
      if (to)   q = q.lte('event_time', to   + 'T23:59:59Z');
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ events: data || [] });
    }

    // Public: timezone-aware range (?from=ISO&to=ISO) — preferred, used by dashboard
    if (req.query?.from || req.query?.to) {
      let q = sb
        .from('forex_news')
        .select('id,event_time,currency,event_name,impact,forecast,previous,actual')
        .order('event_time', { ascending: true });
      if (req.query.from) q = q.gte('event_time', req.query.from);
      if (req.query.to)   q = q.lte('event_time', req.query.to);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ events: data || [] });
    }

    // Public: specific date (?date=YYYY-MM-DD) — UTC day boundaries (legacy fallback)
    if (req.query?.date) {
      const date = req.query.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
      const { data, error } = await sb
        .from('forex_news')
        .select('id,event_time,currency,event_name,impact,forecast,previous,actual')
        .gte('event_time', date + 'T00:00:00Z')
        .lte('event_time', date + 'T23:59:59Z')
        .order('event_time', { ascending: true });
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ events: data || [] });
    }

    // Public: next 48h only
    const now    = new Date().toISOString();
    const cutoff = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const { data, error } = await sb
      .from('forex_news')
      .select('*')
      .gte('event_time', now)
      .lte('event_time', cutoff)
      .order('event_time', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ events: data || [] });
  }

  // ── POST — save events (admin only) ────────────────────────────────────────
  if (req.method === 'POST') {
    if (!(await verifyAdmin(sb, req))) return res.status(403).json({ error: 'Admin only' });

    const { events } = req.body || {};
    if (!Array.isArray(events) || !events.length)
      return res.status(400).json({ error: 'events[] required' });

    // Upsert — prevents dupes if same event_time + currency + event_name
    const rows = events.map(e => ({
      event_time: e.event_time,
      currency:   (e.currency || '').toUpperCase().slice(0, 3),
      event_name: e.event_name || 'Unknown Event',
      impact:     (['HIGH','MEDIUM','LOW'].includes((e.impact||'').toUpperCase())
                    ? e.impact.toUpperCase() : 'MEDIUM'),
      forecast:   e.forecast  || null,
      previous:   e.previous  || null,
      actual:     e.actual    || null,
    }));

    const { data, error } = await sb.from('forex_news').insert(rows).select();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ saved: data?.length || 0 });
  }

  // ── DELETE — remove event by id (admin only) ───────────────────────────────
  if (req.method === 'DELETE') {
    if (!(await verifyAdmin(sb, req))) return res.status(403).json({ error: 'Admin only' });

    const { id, date } = req.body || {};

    if (date) {
      // Delete all events for a given date (YYYY-MM-DD)
      const { error } = await sb
        .from('forex_news')
        .delete()
        .gte('event_time', date + 'T00:00:00Z')
        .lte('event_time', date + 'T23:59:59Z');
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ deleted: true });
    }

    if (id) {
      const { error } = await sb.from('forex_news').delete().eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ deleted: true });
    }

    return res.status(400).json({ error: 'id or date required' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
