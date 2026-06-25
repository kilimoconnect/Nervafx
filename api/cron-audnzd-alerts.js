'use strict';

const { createClient } = require('@supabase/supabase-js');
const { checkAudNzdAlerts } = require('../src/audnzdAlerts');

const ADMIN_ID = '140f3854-2c85-488c-8e0a-0f965d562654';

async function verifyAdmin(sb, req) {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!auth) return false;
  if (process.env.CRON_SECRET && auth === process.env.CRON_SECRET) return true;
  if (req.headers['x-vercel-cron'] === '1') return true;
  const { data: { user } } = await sb.auth.getUser(auth);
  return user?.id === ADMIN_ID;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  if (!(await verifyAdmin(sb, req))) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const result = await checkAudNzdAlerts(sb);
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[CRON-AUDNZD]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
