'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

// GET /api/session-continuity-evolution?date=YYYY-MM-DD&session=ASIA|LONDON|NEW_YORK
//
// Replays one session hour by hour so you can watch how the pair list arrived
// at what the card shows. It reads the same currency_strength table the engine
// itself uses, so the figures here are the figures that produced the card:
//
//   smooth_6h — ranks the currencies and sets each pair's direction and
//               spread. This is what the card displays and sorts by, so it
//               is what the timeline ranks by too.
//   smooth_2h — the extra direction confirmation the live session applies.
//               Carried per pair as dir2h/agrees so you can see where the
//               2H view disagreed with the 6H ranking.
//
// Steps are hourly because currency_strength holds one row per hour per
// currency. That table is the engine's source of truth, so the drill-down
// follows its cadence rather than interpolating a finer one from candles.

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const VALID_PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD',
  'CHF_JPY','CAD_JPY','CAD_CHF',
];

const HOUR_MS = 60 * 60 * 1000;

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
  if (w.wraps) start.setUTCDate(start.getUTCDate() - 1);
  start.setUTCHours(w.startHour, 0, 0, 0);
  return { start, end };
}

async function fetchStrength(sb, sinceIso, untilIso) {
  const PAGE = 1000;
  const rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('currency_strength')
      .select('time, currency, smooth_6h, smooth_2h')
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

    // Never show an hour that hasn't completed.
    const lastComplete = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS;
    const endMs = Math.min(bounds.end.getTime(), lastComplete);
    if (endMs < bounds.start.getTime()) {
      return res.json({ date, session, steps: [], total: 0, note: 'Session has not started yet' });
    }

    const rows = await fetchStrength(
      sb,
      bounds.start.toISOString(),
      new Date(endMs).toISOString()
    );

    // hourKey -> currency -> { v6, v2 }
    const byHour = {};
    for (const r of rows) {
      const hk = r.time.slice(0, 13);
      (byHour[hk] = byHour[hk] || {})[r.currency] = {
        v6: parseFloat(r.smooth_6h) || 0,
        v2: parseFloat(r.smooth_2h) || 0,
      };
    }

    const steps = [];
    for (let t = bounds.start.getTime(); t <= endMs; t += HOUR_MS) {
      const hk = new Date(t).toISOString().slice(0, 13);
      const hour = byHour[hk];
      // currency_strength lags the candle feed, so late hours in a live
      // session may simply not be published yet. Skip rather than emit a
      // step built from a partial currency set.
      if (!hour || Object.keys(hour).length < CURRENCIES.length) continue;

      const s6 = {}, s2 = {};
      for (const c of CURRENCIES) {
        s6[c] = hour[c]?.v6 ?? 0;
        s2[c] = hour[c]?.v2 ?? 0;
      }

      // Rank by 6H — the same basis the card uses to order its pairs.
      const pairs = VALID_PAIRS.map(inst => {
        const [base, quote] = inst.split('_');
        const dir   = s6[base] >= s6[quote] ? 'BUY' : 'SELL';
        const dir2h = s2[base] >= s2[quote] ? 'BUY' : 'SELL';
        return {
          instrument: inst,
          dir,
          spread: +Math.abs(s6[base] - s6[quote]).toFixed(6),
          dir2h,
          agrees: dir === dir2h,
        };
      }).sort((a, b) => b.spread - a.spread);

      const ranked = CURRENCIES.map(c => ({ currency: c, val: s6[c] }))
        .sort((a, b) => b.val - a.val);

      steps.push({
        time: new Date(t).toISOString(),
        // Strength for the hour beginning at t is derived from the H1 candle
        // that opens at t, so the reading only exists once that candle closes.
        closeTime: new Date(t + HOUR_MS).toISOString(),
        strength: s6,
        strength2h: s2,
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
      note: steps.length ? undefined : 'No published strength rows for this session yet',
    });
  } catch (e) {
    console.error('[SESSION-CONTINUITY-EVOLUTION]', e.message);
    res.status(500).json({ error: e.message });
  }
};
