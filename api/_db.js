// Shared Supabase client for all API functions
const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getClient() {
  if (!_client) {
    _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  }
  return _client;
}

async function getLatestTime(table) {
  const sb = getClient();
  const { data } = await sb.from(table).select('time').order('time', { ascending: false }).limit(1);
  return data?.[0]?.time || null;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=30');
}

module.exports = { getClient, getLatestTime, cors };
