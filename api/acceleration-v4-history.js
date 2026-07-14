'use strict';

/**
 * GET /api/acceleration-v4-history?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Pre-fetches H1 + M15 candles for every pair across the range ONCE, then
 * iterates every 15-minute anchor in memory. Much faster than invoking the
 * live handler per anchor — a 1-day scan is ~56 DB queries instead of ~5400.
 */

const { createClient } = require('@supabase/supabase-js');
const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');
const v4 = require('./acceleration-v4.js');

const VALID_PAIRS = v4.VALID_PAIRS;
const analysePair = v4.analysePair;
const computeCurrencyStrength = v4.computeCurrencyStrength;
const strengthAligned = v4.strengthAligned;

function getServiceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Fetch all candles for one pair/timeframe across a wide window with pagination.
async function fetchAll(sb, inst, tf, since, until) {
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('backtest_candles')
      .select('time, open, high, low, close, volume')
      .eq('instrument', inst).eq('timeframe', tf).eq('complete', true)
      .gte('time', since).lte('time', until)
      .order('time', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all.push(...data.map(c => ({
      time: c.time,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low:  parseFloat(c.low),
      close: parseFloat(c.close),
      volume: c.volume == null ? 0 : Number(c.volume),
      _ms: new Date(c.time).getTime(),
    })));
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const gate = await requirePlan(getServiceClient(), req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
  } catch (e) { return res.status(500).json({ error: e.message }); }

  const from = req.query?.from;
  const to   = req.query?.to;
  const strengthTf = (req.query?.strengthTf === 'm15') ? 'M15' : 'H1';
  if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' });

  const start = new Date(from + 'T00:00:00Z');
  let end     = new Date(to   + 'T23:45:00Z');
  if (isNaN(start) || isNaN(end)) return res.status(400).json({ error: 'invalid dates' });

  // Never scan future anchors — no new candles exist past 'now', so the
  // engine would just re-analyse the same slice and print the last-known
  // signal for every 15-min bucket until 'to' 23:45. Snap end to the most
  // recent completed M15 boundary at or before now.
  const nowMs        = Date.now();
  const lastComplete = Math.floor(nowMs / (15 * 60000)) * (15 * 60000) - 15 * 60000;
  if (end.getTime() > lastComplete) end = new Date(lastComplete);

  const t0 = Date.now();
  const sb = getClient();

  // Fetch enough history for the indicators to warm up. H1 needs 51 candles for
  // EMA50; M15 needs 51 for ATR50. Add generous buffer for the earliest anchor.
  const fetchSince = new Date(start.getTime() - 5 * 24 * 3600000).toISOString();
  const fetchUntil = new Date(end.getTime()   + 60 * 60000).toISOString();

  const cache = {};
  const errors = [];
  for (let b = 0; b < VALID_PAIRS.length; b += 7) {
    const batch = VALID_PAIRS.slice(b, b + 7);
    await Promise.all(batch.map(async inst => {
      try {
        const [h1, m15] = await Promise.all([
          fetchAll(sb, inst, 'H1',  fetchSince, fetchUntil),
          fetchAll(sb, inst, 'M15', fetchSince, fetchUntil),
        ]);
        cache[inst] = { h1, m15 };
      } catch (e) {
        errors.push(`${inst}: ${e.message}`);
        cache[inst] = { h1: [], m15: [] };
      }
    }));
  }

  const rows = [];
  const CAP = 4000;
  let anchor = new Date(start.getTime());
  let iterations = 0;

  while (anchor <= end && iterations < CAP) {
    const day = anchor.getUTCDay();
    const skipWeekend = day === 6 || (day === 0 && anchor.getUTCHours() < 21);
    if (!skipWeekend) {
      const anchorMs = anchor.getTime();
      const results = [];
      const pairH1Slice  = {};
      const pairM15Slice = {};
      for (const inst of VALID_PAIRS) {
        const cached = cache[inst];
        if (!cached) continue;
        // Slice to snapshots strictly on or before the anchor
        const h1Slice  = cached.h1.filter(c  => c._ms  <= anchorMs);
        const m15Slice = cached.m15.filter(c => c._ms <= anchorMs);
        if (h1Slice.length < 51 || m15Slice.length < 51) continue;
        pairH1Slice[inst]  = h1Slice;
        pairM15Slice[inst] = m15Slice;
        const r = analysePair(inst, h1Slice, m15Slice, {
          requireBreakout: strengthTf !== 'M15',
          dayBreakSource:  strengthTf === 'M15' ? 'M15' : 'H1',
        });
        if (r) results.push(r);
      }
      // Per-anchor currency strength — H1 by default, M15 when the caller
      // explicitly requests the M15-strength variant.
      const strength = computeCurrencyStrength(
        strengthTf === 'M15' ? pairM15Slice : pairH1Slice,
        strengthTf,
      );

      // Only include pairs where the H1 bias is set (Close > EMA20 > EMA50 for
      // BUY, Close < EMA20 < EMA50 for SELL) — the same filter the live card
      // applies. This is redundant with `qualifies` (which already requires H1
      // direction), but stated explicitly so the semantics are obvious here.
      const biased = results.filter(r => r.direction != null);
      // Fold currency-strength alignment into qualifies, matching live handler.
      for (const r of biased) {
        const [base, quote] = r.instrument.split('_');
        r.currencyStrength = {
          base:  { code: base,  value: strength[base]  },
          quote: { code: quote, value: strength[quote] },
          aligned: strengthAligned(r.instrument, r.direction, strength, strengthTf),
        };
        r.qualifies = r.qualifies && r.currencyStrength.aligned;
        if (r.rules) r.rules.strengthAligned = r.currencyStrength.aligned;
      }
      biased.sort((a, b) => b.finalScore - a.finalScore);
      const qualifiedPairs = biased.filter(r => r.qualifies);
      if (qualifiedPairs.length) {
        // Keep the full pair record so the frontend can hydrate the detail modal
        // straight from history without re-fetching.
        rows.push({
          time: anchor.toISOString(),
          count: qualifiedPairs.length,
          pairs: qualifiedPairs.slice(0, 5).map(p => ({
            pair: p.pair,
            instrument: p.instrument,
            direction: p.direction,
            finalScore: p.finalScore,
            components: p.components,
            rules: p.rules,
            price: p.price,
            currencyStrength: p.currencyStrength,
          })),
        });
      }
    }
    anchor = new Date(anchor.getTime() + 15 * 60000);
    iterations++;
  }

  res.json({
    from, to,
    strengthTf,
    anchors_scanned: iterations,
    qualified: rows.length,
    duration_sec: Math.round((Date.now() - t0) / 100) / 10,
    errors: errors.slice(0, 5),
    rows,
  });
};

module.exports.maxDuration = 300;
