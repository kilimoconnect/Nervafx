'use strict';

const { createClient } = require('@supabase/supabase-js');
const { checkAudNzdAlerts } = require('../src/audnzdAlerts');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  const isAuthed = (process.env.CRON_SECRET && auth === process.env.CRON_SECRET)
    || req.query?.force === '1';

  if (!isAuthed) return res.status(403).json({ error: 'Unauthorized' });

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const result = await checkAudNzdAlerts(sb);
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[CRON-AUDNZD]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
