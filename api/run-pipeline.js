'use strict';

/**
 * POST /api/run-pipeline
 *
 * Manually triggers the analysis pipeline using candle data already in Supabase.
 * Runs: strength → smooth → spreads → states → signals
 * Skips: OANDA fetch (candles must already be CLEAN), AI analysis, journal, outcomes.
 *
 * Protected: requires admin JWT (same ID check as the dashboard Admin button).
 *
 * Usage:  POST /api/run-pipeline   (with Bearer token header)
 */

const { createClient } = require('@supabase/supabase-js');

const ADMIN_ID = '140f3854-2c85-488c-8e0a-0f965d562654';
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const INSTRUMENTS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD',
  'CAD_JPY','CAD_CHF','CHF_JPY',
];
const LOOKBACKS = [3, 6, 12];
const PAIRS_PER_CURRENCY = 7;

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function verifyAdmin(sb, req) {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!auth) return false;
  const { data: { user } } = await sb.auth.getUser(auth);
  return user?.id === ADMIN_ID;
}

// ── Strength ──────────────────────────────────────────────────────────────────
function offsetISO(iso, hoursBack) {
  const t = new Date(iso);
  t.setUTCHours(t.getUTCHours() - hoursBack);
  return t.toISOString();
}

async function runStrength(sb) {
  const lookup = {};
  for (const inst of INSTRUMENTS) {
    const { data, error } = await sb
      .from('market_candles')
      .select('time, close')
      .eq('instrument', inst)
      .eq('timeframe', 'H1')
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(50); // 12H lookback + up to ~24H lag in latestCommonTime + buffer
    if (error) throw new Error(`candle fetch ${inst}: ${error.message}`);
    lookup[inst] = {};
    for (const c of data || []) {
      lookup[inst][new Date(c.time).toISOString()] = parseFloat(c.close);
    }
  }

  // Latest common closed candle across all instruments
  let common = null;
  for (const inst of INSTRUMENTS) {
    const times = Object.keys(lookup[inst] || {}).sort();
    if (!times.length) throw new Error(`No candles for ${inst}`);
    const latest = times[times.length - 1];
    if (!common || latest < common) common = latest;
  }

  // Calculate raw strength at that time
  const raw = {
    3:  Object.fromEntries(CURRENCIES.map(c => [c, 0])),
    6:  Object.fromEntries(CURRENCIES.map(c => [c, 0])),
    12: Object.fromEntries(CURRENCIES.map(c => [c, 0])),
  };

  for (const inst of INSTRUMENTS) {
    const [base, quote] = inst.split('_');
    const closeNow = lookup[inst][common];
    if (closeNow === undefined) throw new Error(`Missing close at ${common} for ${inst}`);

    for (const lb of LOOKBACKS) {
      const pastTime  = offsetISO(common, lb);
      const pastClose = lookup[inst][pastTime];
      if (pastClose === undefined) throw new Error(`Missing lookback ${lb}H for ${inst} at ${pastTime}`);
      const mv = (closeNow - pastClose) / pastClose;
      raw[lb][base]  += mv;
      raw[lb][quote] -= mv;
    }
  }

  const rows = CURRENCIES.map(currency => ({
    time:          common,
    currency,
    raw_3h:        raw[3][currency],
    raw_6h:        raw[6][currency],
    raw_12h:       raw[12][currency],
    normalized_3h: raw[3][currency]  / PAIRS_PER_CURRENCY,
    normalized_6h: raw[6][currency]  / PAIRS_PER_CURRENCY,
    normalized_12h: raw[12][currency] / PAIRS_PER_CURRENCY,
  }));

  const { error: upsErr } = await sb
    .from('currency_strength')
    .upsert(rows, { onConflict: 'time,currency', ignoreDuplicates: false });
  if (upsErr) throw new Error(`strength upsert: ${upsErr.message}`);

  return common;
}

// ── Smooth ────────────────────────────────────────────────────────────────────
function ema(prev, cur) {
  if (prev == null) return cur;
  return (prev + cur) / 2;
}

async function runSmooth(sb) {
  const updates = [];
  for (const currency of CURRENCIES) {
    const { data, error } = await sb
      .from('currency_strength')
      .select('id, time, currency, normalized_3h, normalized_6h, normalized_12h')
      .eq('currency', currency)
      .order('time', { ascending: false })
      .limit(2);
    if (error || !data?.length) continue;

    const current  = data[0];
    const previous = data[1] || null;
    let p3 = null, p6 = null, p12 = null;

    if (previous) {
      const { data: pr } = await sb
        .from('currency_strength')
        .select('smooth_3h, smooth_6h, smooth_12h')
        .eq('id', previous.id)
        .single();
      if (pr) { p3 = pr.smooth_3h; p6 = pr.smooth_6h; p12 = pr.smooth_12h; }
    }

    updates.push({
      id: current.id, time: current.time, currency,
      smooth_3h:  ema(p3,  current.normalized_3h),
      smooth_6h:  ema(p6,  current.normalized_6h),
      smooth_12h: ema(p12, current.normalized_12h),
    });
  }
  const { error } = await sb.from('currency_strength').upsert(updates, { onConflict: 'id' });
  if (error) throw new Error(`smooth upsert: ${error.message}`);
}

// ── Spreads ───────────────────────────────────────────────────────────────────
async function runSpreads(sb) {
  // Get latest 8 smooth rows per currency
  const csMap = {};
  for (const currency of CURRENCIES) {
    const { data } = await sb
      .from('currency_strength')
      .select('time, currency, smooth_3h, smooth_6h, smooth_12h')
      .eq('currency', currency)
      .not('smooth_3h', 'is', null)
      .order('time', { ascending: false })
      .limit(8);
    for (const r of data || []) {
      if (!csMap[r.time]) csMap[r.time] = {};
      csMap[r.time][r.currency] = r;
    }
  }

  const latestTime = Object.keys(csMap).sort().pop();
  if (!latestTime) return;

  const snapshot = csMap[latestTime];
  const rows = [];

  for (const inst of INSTRUMENTS) {
    const [base, quote] = inst.split('_');
    const b = snapshot[base], q = snapshot[quote];
    if (!b || !q) continue;

    const s3h  = (parseFloat(b.smooth_3h)  || 0) - (parseFloat(q.smooth_3h)  || 0);
    const s6h  = (parseFloat(b.smooth_6h)  || 0) - (parseFloat(q.smooth_6h)  || 0);
    const s12h = (parseFloat(b.smooth_12h) || 0) - (parseFloat(q.smooth_12h) || 0);
    const ws   = s12h * 0.40 + s6h * 0.35 + s3h * 0.15;

    rows.push({
      time: latestTime, instrument: inst,
      base_currency: base, quote_currency: quote,
      spread_3h: s3h, spread_6h: s6h, spread_12h: s12h,
      weighted_score: ws,
    });
  }

  rows.sort((a, b) => Math.abs(b.weighted_score) - Math.abs(a.weighted_score));
  const { error } = await sb
    .from('pair_strength_spreads')
    .upsert(rows, { onConflict: 'time,instrument', ignoreDuplicates: false });
  if (error) throw new Error(`spreads upsert: ${error.message}`);
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  const sb = getDB();

  try {
    const isAdmin = await verifyAdmin(sb, req);
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
  } catch (_) {
    return res.status(403).json({ error: 'Auth error' });
  }

  const log = [];
  const step = async (name, fn) => {
    try {
      await fn();
      log.push(`✓ ${name}`);
    } catch (e) {
      log.push(`✗ ${name}: ${e.message}`);
    }
  };

  const t0 = Date.now();
  let strengthTime = null;

  await step('strength', async () => { strengthTime = await runStrength(sb); });
  await step('smooth',   () => runSmooth(sb));
  await step('spreads',  () => runSpreads(sb));

  return res.json({
    ok:           true,
    strength_time: strengthTime,
    elapsed_ms:   Date.now() - t0,
    steps:        log,
  });
};
