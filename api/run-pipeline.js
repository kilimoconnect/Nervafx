'use strict';

/**
 * POST /api/run-pipeline
 *
 * Manually triggers the analysis pipeline using candle data already in Supabase.
 * Runs: strength → smooth → spreads → journal
 * Skips: OANDA fetch (candles must already be CLEAN), AI analysis, outcomes.
 *
 * Protected: requires admin JWT (same ID check as the dashboard Admin button).
 *
 * Usage:  POST /api/run-pipeline   (with Bearer token header)
 */

const { createClient } = require('@supabase/supabase-js');
const { calculateLatestStates }          = require('../src/stateDetect');
const { calculateLatestSignals }         = require('../src/signals');
const { checkLatestSignals }             = require('../src/risk');
const { calculateLatestSessionActivity } = require('../src/sessionActivity');
const { writeJournalEntry }              = require('../src/journalEngine');

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
// Uses positional (candle-count) lookbacks instead of calendar-hour arithmetic.
// This means "3H" = 3 completed H1 candles back, not "now - 3 hours".
// Weekend gaps are invisible — there are simply no candles then, so the 12th
// candle back from Monday morning lands on Friday, not a dead Saturday slot.

async function runStrength(sb) {
  const MIN_CANDLES = 13; // current (0) + max lookback (12) = 13 minimum
  const FETCH       = 20; // a little extra headroom

  // Fetch last FETCH complete H1 candles per instrument, newest first
  const arrays = {};
  for (const inst of INSTRUMENTS) {
    const { data, error } = await sb
      .from('market_candles')
      .select('time, close')
      .eq('instrument', inst)
      .eq('timeframe', 'H1')
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(FETCH);
    if (error) throw new Error(`candle fetch ${inst}: ${error.message}`);
    if (!data || data.length < MIN_CANDLES)
      throw new Error(`Not enough candles for ${inst}: need ${MIN_CANDLES}, got ${data?.length ?? 0}`);
    arrays[inst] = data.map(c => ({ time: new Date(c.time).toISOString(), close: parseFloat(c.close) }));
  }

  // Reference time = the oldest "most recent candle" across all instruments
  // (guards against one instrument being one candle ahead of the rest)
  const refTime = INSTRUMENTS.map(inst => arrays[inst][0].time).sort()[0];

  // Compute raw strength using positional offsets — no timestamp arithmetic
  const raw = {
    3:  Object.fromEntries(CURRENCIES.map(c => [c, 0])),
    6:  Object.fromEntries(CURRENCIES.map(c => [c, 0])),
    12: Object.fromEntries(CURRENCIES.map(c => [c, 0])),
  };

  for (const inst of INSTRUMENTS) {
    const arr = arrays[inst];
    const [base, quote] = inst.split('_');

    // Starting index: first candle at or before refTime (normally 0, may be 1 if inst is 1 ahead)
    const refIdx = arr.findIndex(c => c.time <= refTime);
    if (refIdx === -1) throw new Error(`${inst}: no candle at or before ${refTime}`);

    const closeNow = arr[refIdx].close;
    for (const lb of LOOKBACKS) {
      const pastIdx = refIdx + lb;
      if (pastIdx >= arr.length)
        throw new Error(`${inst}: not enough candles for ${lb}-candle lookback`);
      const mv = (closeNow - arr[pastIdx].close) / arr[pastIdx].close;
      raw[lb][base]  += mv;
      raw[lb][quote] -= mv;
    }
  }

  const rows = CURRENCIES.map(currency => ({
    time:           refTime,
    currency,
    raw_3h:         raw[3][currency],
    raw_6h:         raw[6][currency],
    raw_12h:        raw[12][currency],
    normalized_3h:  raw[3][currency]  / PAIRS_PER_CURRENCY,
    normalized_6h:  raw[6][currency]  / PAIRS_PER_CURRENCY,
    normalized_12h: raw[12][currency] / PAIRS_PER_CURRENCY,
  }));

  const { error: upsErr } = await sb
    .from('currency_strength')
    .upsert(rows, { onConflict: 'time,currency', ignoreDuplicates: false });
  if (upsErr) throw new Error(`strength upsert: ${upsErr.message}`);

  return refTime;
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
    rows.push({
      time:           latestTime,
      instrument:     inst,
      base_currency:  base,
      quote_currency: quote,
      spread_3h:      s3h,
      spread_6h:      s6h,
      spread_12h:     s12h,
      // weighted_score and bias are computed at read time in api/spreads.js, not stored
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
  await step('states',   () => calculateLatestStates());
  await step('signals',  () => calculateLatestSignals());
  await step('risk',             () => checkLatestSignals());
  await step('session_activity', () => calculateLatestSessionActivity());
  await step('journal',          () => writeJournalEntry());

  return res.json({
    ok:           true,
    strength_time: strengthTime,
    elapsed_ms:   Date.now() - t0,
    steps:        log,
  });
};
