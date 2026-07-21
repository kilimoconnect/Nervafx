'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

// GET /api/session-continuity-evolution?date=YYYY-MM-DD&session=NEW_YORK
//
// Replays one session in 15-minute steps so you can watch how the pair list
// arrived at what the card shows. At each M15 anchor it recomputes the same
// 2H currency strength the live gate in session-continuity.js uses — % change
// across the last 8 complete M15 bars, credited +base / -quote and averaged
// per currency — then derives every pair's direction and spread from it.

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const VALID_PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD',
  'CHF_JPY','CAD_JPY','CAD_CHF',
];

const M15_MS = 15 * 60 * 1000;
const M15_BARS_2H = 8;

// Session windows in UTC, matching src/sessionEngine.js after the one-hour
// shift. ASIA wraps midnight: on date D it runs D-1 22:00 → D 06:00.
const SESSION_WINDOW = {
  ASIA:     { startHour: 22, endHour: 6,  wraps: true  },
  LONDON:   { startHour: 6,  endHour: 12, wraps: false },
  NEW_YORK: { startHour: 12, endHour: 21, wraps: false },
};

function sessionBounds(dateStr, session) {
  const w = SESSION_WINDOW[session];
  if (!w) return null;
  const end = new Date(`${dateStr}T00:00:00Z`);
  end.setUTCHours(w.endHour, 0, 0, 0);
  const start = new Date(end);
  if (w.wraps) {
    // 22:00 the previous calendar day through 06:00 on `dateStr`.
    start.setUTCDate(start.getUTCDate() - 1);
  }
  start.setUTCHours(w.startHour, 0, 0, 0);
  return { start, end };
}

async function fetchM15(sb, sinceIso, untilIso) {
  const PAGE = 1000;
  const rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('backtest_candles')
      .select('instrument, time, close')
      .in('instrument', VALID_PAIRS)
      .eq('timeframe', 'M15')
      .eq('complete', true)
      .gte('time', sinceIso)
      .lte('time', untilIso)
      .order('time', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return rows;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const date = (req.query?.date || '').slice(0, 10);
    const session = (req.query?.session || '').toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
    const bounds = sessionBounds(date, session);
    if (!bounds) return res.status(400).json({ error: 'session must be ASIA, LONDON or NEW_YORK' });

    // Stop at the last closed M15 so a partially-formed bar never appears.
    const lastClosed = Math.floor(Date.now() / M15_MS) * M15_MS - M15_MS;
    const endMs = Math.min(bounds.end.getTime(), lastClosed);
    if (endMs < bounds.start.getTime()) {
      return res.json({ date, session, steps: [], note: 'Session has not started yet' });
    }

    // Warm up 2h before the session so the very first step has its 8 bars.
    const warmSince = new Date(bounds.start.getTime() - 3 * 60 * 60 * 1000).toISOString();
    const raw = await fetchM15(sb, warmSince, new Date(endMs).toISOString());

    // Index closes per instrument by bar timestamp.
    const byInst = {};
    for (const r of raw) {
      const ms = new Date(r.time).getTime();
      (byInst[r.instrument] = byInst[r.instrument] || new Map()).set(ms, parseFloat(r.close));
    }

    const steps = [];
    for (let t = bounds.start.getTime(); t <= endMs; t += M15_MS) {
      const sums = {}, counts = {};
      for (const ccy of CURRENCIES) { sums[ccy] = 0; counts[ccy] = 0; }

      let contributing = 0;
      for (const inst of VALID_PAIRS) {
        const m = byInst[inst];
        if (!m) continue;
        const nowPx = m.get(t);
        const thenPx = m.get(t - M15_BARS_2H * M15_MS);
        if (nowPx == null || thenPx == null || !thenPx) continue;
        contributing++;
        const pct = ((nowPx - thenPx) / thenPx) * 100;
        const [base, quote] = inst.split('_');
        sums[base]  += pct; counts[base]++;
        sums[quote] -= pct; counts[quote]++;
      }
      // Skip anchors with thin coverage (market gaps, rollover) rather than
      // emitting a step built from a handful of pairs.
      if (contributing < VALID_PAIRS.length * 0.7) continue;

      const strength = {};
      for (const ccy of CURRENCIES) {
        strength[ccy] = counts[ccy] ? +(sums[ccy] / counts[ccy]).toFixed(4) : 0;
      }

      const pairs = VALID_PAIRS.map(inst => {
        const [base, quote] = inst.split('_');
        const b = strength[base], q = strength[quote];
        return {
          instrument: inst,
          dir: b >= q ? 'BUY' : 'SELL',
          spread: +Math.abs(b - q).toFixed(4),
        };
      }).sort((a, b) => b.spread - a.spread);

      const ranked = CURRENCIES.map(c => ({ currency: c, val: strength[c] }))
        .sort((a, b) => b.val - a.val);

      steps.push({
        time: new Date(t).toISOString(),
        strength,
        strongest: ranked[0],
        weakest: ranked[ranked.length - 1],
        pairs,
      });
    }

    res.json({
      date,
      session,
      start: bounds.start.toISOString(),
      end: new Date(endMs).toISOString(),
      steps,
      total: steps.length,
    });
  } catch (e) {
    console.error('[SESSION-CONTINUITY-EVOLUTION]', e.message);
    res.status(500).json({ error: e.message });
  }
};
