'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

// GET /api/session-continuity?days=30
// Returns pairs whose direction (BUY/SELL) continued from one session to the next.
// Groups hourly currency_strength by session, ranks currencies, forms pairs,
// then finds consecutive sessions where the same pair kept the same direction.

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
  if (h >= 23 || h < 7) return 'ASIA';
  if (h >= 7 && h < 13) return 'LONDON';
  if (h >= 13 && h < 21) return 'NEW_YORK';
  return null; // LOW_LIQUIDITY 21-23
}

function sessionDate(iso, session) {
  const d = new Date(iso);
  // Asia 23:00 belongs to the next calendar day's session block
  if (session === 'ASIA' && d.getUTCHours() === 23) {
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

    // Fetch currency_strength with pagination
    const allRows = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('currency_strength')
        .select('time, currency, smooth_2h')
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

    // For each hour, compute session and currency values
    // Group by session block (date + session name)
    const sessionBlocks = {}; // key: "2025-06-17|LONDON"
    for (const [hk, rows] of Object.entries(byHour)) {
      const hour = parseInt(hk.slice(11, 13), 10);
      const sess = getSession(hour);
      if (!sess) continue; // skip LOW_LIQUIDITY

      const iso = hk + ':00:00Z';
      const dateKey = sessionDate(iso, sess);
      const blockKey = `${dateKey}|${sess}`;

      if (!sessionBlocks[blockKey]) {
        sessionBlocks[blockKey] = { date: dateKey, session: sess, hours: {} };
      }
      for (const r of rows) {
        const val = parseFloat(r.smooth_2h) || 0;
        if (!sessionBlocks[blockKey].hours[r.currency]) {
          sessionBlocks[blockKey].hours[r.currency] = [];
        }
        sessionBlocks[blockKey].hours[r.currency].push(val);
      }
    }

    // For each session block: average smooth_2h per currency, rank, form pairs
    const sessionList = [];
    for (const [key, block] of Object.entries(sessionBlocks)) {
      const ranked = CURRENCIES.map(ccy => {
        const vals = block.hours[ccy] || [];
        const avg = vals.length ? vals[vals.length - 1] : 0; // use last hour of session
        return { currency: ccy, val: avg };
      }).sort((a, b) => b.val - a.val);

      const strong = ranked.slice(0, 3).filter(c => c.val > 0);
      const weak = ranked.slice(-3).filter(c => c.val < 0).reverse();
      const sum = (ranked[0]?.val ? Math.abs(ranked[0].val) : 0) +
                  (ranked[7]?.val ? Math.abs(ranked[7].val) : 0);

      const pairs = [];
      for (const s of strong) {
        for (const w of weak) {
          const fwd = `${s.currency}_${w.currency}`;
          const rev = `${w.currency}_${s.currency}`;
          let instrument, dir;
          if (VALID_PAIRS.has(fwd)) { instrument = fwd; dir = 'BUY'; }
          else if (VALID_PAIRS.has(rev)) { instrument = rev; dir = 'SELL'; }
          else continue;
          const spread = Math.abs(s.val - w.val);
          pairs.push({ instrument, dir, strong: s.currency, weak: w.currency, spread });
        }
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

    // Find continuations: same pair + same dir in consecutive sessions
    const continuations = [];
    for (let i = 1; i < sessionList.length; i++) {
      const prev = sessionList[i - 1];
      const curr = sessionList[i];

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

    // Live-check: for the current session, verify directions against the latest hour.
    // If a pair's direction flipped mid-session, drop the stale continuation.
    const nowH = new Date().getUTCHours();
    const currSess = getSession(nowH);
    if (currSess && continuations.length) {
      const hourKeys = Object.keys(byHour).sort();
      const latestHk = hourKeys[hourKeys.length - 1];
      if (latestHk && byHour[latestHk]) {
        const latestRows = byHour[latestHk];
        const liveCcyMap = {};
        for (const r of latestRows) {
          if (!liveCcyMap[r.currency]) liveCcyMap[r.currency] = parseFloat(r.smooth_2h) || 0;
        }
        const liveRanked = CURRENCIES
          .map(ccy => ({ currency: ccy, val: liveCcyMap[ccy] || 0 }))
          .sort((a, b) => b.val - a.val);
        const liveStrong = new Set(liveRanked.slice(0, 3).filter(c => c.val > 0).map(c => c.currency));
        const liveWeak = new Set(liveRanked.slice(-3).filter(c => c.val < 0).map(c => c.currency));

        const liveDirs = {};
        for (const s of liveStrong) {
          for (const w of liveWeak) {
            const fwd = `${s}_${w}`, rev = `${w}_${s}`;
            if (VALID_PAIRS.has(fwd)) liveDirs[fwd] = 'BUY';
            else if (VALID_PAIRS.has(rev)) liveDirs[rev] = 'SELL';
          }
        }

        for (const c of continuations) {
          if (c.toSession === currSess) {
            c.pairs = c.pairs.filter(p => liveDirs[p.instrument] === p.dir);
          }
        }
      }
    }

    const filtered = continuations.filter(c => c.pairs.length > 0);
    res.json({ continuations: filtered.reverse(), total: filtered.length });
  } catch (e) {
    console.error('[SESSION-CONTINUITY]', e.message);
    res.status(500).json({ error: e.message });
  }
};
