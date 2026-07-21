'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

// GET /api/session-continuity?days=30
// For each session, uses 6H strength to rank currencies and form pairs.
// Checks the 2 previous sessions for continuation (same pair + same direction).
// Filters by growing spread; the live session additionally requires 2H
// strength to agree with the pair's direction. That 2H strength is derived
// from M15 candles at request time, so it refreshes every 15 minutes.

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const VALID_PAIRS = new Set([
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD',
  'CHF_JPY','CAD_JPY','CAD_CHF',
]);

function getSession(h) {
  if (h >= 22 || h < 6) return 'ASIA';
  if (h >= 6 && h < 12) return 'LONDON';
  if (h >= 12 && h < 21) return 'NEW_YORK';
  return null; // LOW_LIQUIDITY 21-22
}

function sessionDate(iso, session) {
  const d = new Date(iso);
  if (session === 'ASIA' && d.getUTCHours() >= 22) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

function sessionOrder(s) {
  return s === 'ASIA' ? 0 : s === 'LONDON' ? 1 : 2;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const days = Math.min(420, parseInt(req.query?.days || '30', 10) || 30);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Fetch currency_strength (6H for session pairs, 2H for confirmation)
    const allRows = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('currency_strength')
        .select('time, currency, smooth_6h')
        .gte('time', since)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      allRows.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    // Group by hour
    const byHour = {};
    for (const r of allRows) {
      const hk = r.time.slice(0, 13);
      (byHour[hk] = byHour[hk] || []).push(r);
    }

    // Group by session block (date + session name)
    const sessionBlocks = {};
    for (const [hk, rows] of Object.entries(byHour)) {
      const hour = parseInt(hk.slice(11, 13), 10);
      const sess = getSession(hour);
      if (!sess) continue;

      const iso = hk + ':00:00Z';
      const dateKey = sessionDate(iso, sess);
      const blockKey = `${dateKey}|${sess}`;

      if (!sessionBlocks[blockKey]) {
        sessionBlocks[blockKey] = { date: dateKey, session: sess, hours: {} };
      }
      for (const r of rows) {
        const val6h = parseFloat(r.smooth_6h) || 0;
        if (!sessionBlocks[blockKey].hours[r.currency]) {
          sessionBlocks[blockKey].hours[r.currency] = [];
        }
        sessionBlocks[blockKey].hours[r.currency].push({ val6h });
      }
    }

    // For each session block: use 6H to rank currencies and form pairs
    const sessionList = [];
    for (const [key, block] of Object.entries(sessionBlocks)) {
      const ccyVals6h = {};
      for (const ccy of CURRENCIES) {
        const vals = block.hours[ccy] || [];
        ccyVals6h[ccy] = vals.length ? vals[vals.length - 1].val6h : 0;
      }
      const ranked = CURRENCIES.map(ccy => ({ currency: ccy, val: ccyVals6h[ccy] }))
        .sort((a, b) => b.val - a.val);
      const sum = (ranked[0]?.val ? Math.abs(ranked[0].val) : 0) +
                  (ranked[7]?.val ? Math.abs(ranked[7].val) : 0);

      const pairs = [];
      for (const instrument of VALID_PAIRS) {
        const [base, quote] = instrument.split('_');
        const bVal = ccyVals6h[base] || 0;
        const qVal = ccyVals6h[quote] || 0;
        const dir = bVal >= qVal ? 'BUY' : 'SELL';
        const strong = dir === 'BUY' ? base : quote;
        const weak = dir === 'BUY' ? quote : base;
        const spread = Math.abs(bVal - qVal);
        pairs.push({ instrument, dir, strong, weak, spread });
      }

      sessionList.push({
        date: block.date,
        session: block.session,
        strongest: ranked[0],
        weakest: ranked[ranked.length - 1],
        sum,
        pairs,
      });
    }

    // Sort by date + session order
    sessionList.sort((a, b) => {
      const dc = a.date.localeCompare(b.date);
      return dc !== 0 ? dc : sessionOrder(a.session) - sessionOrder(b.session);
    });

    // Live 2H currency strength, computed from M15 candles so it refreshes
    // every 15 minutes. The currency_strength table only carries hourly rows
    // AND lags the candle feed — measured on 2026-07-21 its newest row was
    // 06:00 while M15 had already closed 08:00, a two-hour gap. A pair could
    // therefore sit blocked (or wrongly allowed) on a stale direction.
    //
    // Method: for each pair take the % change across the last 2 hours
    // (8 complete M15 bars), credit the base currency +change and the quote
    // -change, then average per currency over the 7 pairs it appears in.
    const M15_BARS_2H = 8;
    const latest2h = {};
    for (const ccy of CURRENCIES) latest2h[ccy] = 0;
    {
      // 6h window gives ~24 bars per pair (672 rows across the 28) — well
      // clear of the 9 needed, with slack for gaps, and under the row cap.
      const m15Since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const { data: m15Rows } = await sb
        .from('backtest_candles')
        .select('instrument, time, close')
        .in('instrument', [...VALID_PAIRS])
        .eq('timeframe', 'M15')
        .eq('complete', true)
        .gte('time', m15Since)
        .order('time', { ascending: false })
        .limit(1000);

      const closesByInst = {};
      for (const c of (m15Rows || [])) {
        (closesByInst[c.instrument] = closesByInst[c.instrument] || []).push(parseFloat(c.close));
      }
      const sums = {}, counts = {};
      for (const ccy of CURRENCIES) { sums[ccy] = 0; counts[ccy] = 0; }
      for (const [inst, closes] of Object.entries(closesByInst)) {
        // Newest first: index 0 is the latest close, index 8 is 2 hours back.
        if (closes.length <= M15_BARS_2H) continue;
        const nowPx = closes[0], thenPx = closes[M15_BARS_2H];
        if (!thenPx) continue;
        const pct = ((nowPx - thenPx) / thenPx) * 100;
        const [base, quote] = inst.split('_');
        sums[base]  += pct; counts[base]++;
        sums[quote] -= pct; counts[quote]++;
      }
      for (const ccy of CURRENCIES) {
        if (counts[ccy]) latest2h[ccy] = sums[ccy] / counts[ccy];
      }
    }
    const h2Dirs = {};
    for (const instrument of VALID_PAIRS) {
      const [base, quote] = instrument.split('_');
      h2Dirs[instrument] = (latest2h[base] || 0) >= (latest2h[quote] || 0) ? 'BUY' : 'SELL';
    }

    // Find continuations: same pair + same dir across up to 2 previous sessions
    // e.g. LONDON checks ASIA (1 back) + previous NEW_YORK (2 back)
    const continuations = [];
    for (let i = 1; i < sessionList.length; i++) {
      const curr = sessionList[i];

      const lookback = Math.min(2, i);
      for (let back = 1; back <= lookback; back++) {
        const prev = sessionList[i - back];

        const prevMap = {};
        for (const p of prev.pairs) prevMap[p.instrument] = p;

        const continued = [];
        for (const p of curr.pairs) {
          const prevP = prevMap[p.instrument];
          if (prevP && prevP.dir === p.dir) {
            continued.push({
              instrument: p.instrument,
              dir: p.dir,
              strong: p.strong,
              weak: p.weak,
              prevSpread: prevP.spread,
              currSpread: p.spread,
              growing: p.spread > prevP.spread,
            });
          }
        }

        if (continued.length) {
          continuations.push({
            date: curr.date,
            fromSession: prev.session,
            toSession: curr.session,
            fromDate: prev.date,
            strongest: curr.strongest,
            weakest: curr.weakest,
            sum: curr.sum,
            pairs: continued.sort((a, b) => b.currSpread - a.currSpread),
          });
        }
      }
    }

    // Determine the current session so the live block can get the extra
    // 2H direction confirmation.
    const nowH = new Date().getUTCHours();
    const currSess = getSession(nowH);
    const currDate = currSess ? sessionDate(new Date().toISOString(), currSess) : null;

    // Filter: growing spread for all; 2H direction confirmation for the
    // current session only. The H1 breakout requirement that used to gate
    // the live session has been removed — a continuation no longer has to
    // wait for an H1 close beyond the previous H1's high/low to show up.
    const has2h = Object.values(latest2h).some(v => v !== 0);
    for (const c of continuations) {
      const isCurrentSession = currSess && c.toSession === currSess && c.date === currDate;
      c.pairs = c.pairs
        .filter(p => {
          if (!p.growing) return false;
          if (isCurrentSession) {
            if (has2h && h2Dirs[p.instrument] !== p.dir) return false;
          }
          return true;
        })
        .sort((a, b) => b.currSpread - a.currSpread);
    }
    const filtered = continuations.filter(c => c.pairs.length > 0);
    res.json({ continuations: filtered.reverse(), total: filtered.length });
  } catch (e) {
    console.error('[SESSION-CONTINUITY]', e.message);
    res.status(500).json({ error: e.message });
  }
};
