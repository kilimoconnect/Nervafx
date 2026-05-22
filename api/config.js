'use strict';

/**
 * GET /api/config
 *
 * Returns public client-side config (Supabase URL + anon key).
 * These are PUBLIC keys safe to expose — they only allow
 * operations permitted by Row Level Security policies.
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  res.json({
    supabase_url:  process.env.SUPABASE_URL,
    supabase_anon: process.env.SUPABASE_ANON_KEY,
  });
};
