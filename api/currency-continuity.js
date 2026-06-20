'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

// GET /api/currency-continuity?days=30
// Per-currency continuation analysis across sessions.
// For each session, stores net currency movement (smooth_6h in pips).
// Continuation: same sign AND current >= 30% of previous.
// Strong continuation: same sign AND current >= 50% of previous.

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

function getSession(h) {
  if (h >= 23 || h < 7) return 'ASIA';
  if (h >= 7 && h < 13) return 'LONDON';
  if (h >= 13 && h < 21) return 'NEW_YORK';
  return null;
}

function sessionDate(iso, session) {
  const d = new Date(iso);
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

    // Group by session block
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
        const val = parseFloat(r.smooth_6h) || 0;
        if (!sessionBlocks[blockKey].hours[r.currency]) {
          sessionBlocks[blockKey].hours[r.currency] = [];
        }
        sessionBlocks[blockKey].hours[r.currency].push(val);
      }
    }

    // End-of-session smooth_6h per currency (in pips)
    const sessionList = [];
    for (const [key, block] of Object.entries(sessionBlocks)) {
      const movements = {};
      for (const ccy of CURRENCIES) {
        const vals = block.hours[ccy] || [];
        const raw = vals.length ? vals[vals.length - 1] : 0;
        movements[ccy] = Math.round(raw * 10000 * 10) / 10;
      }
      sessionList.push({ date: block.date, session: block.session, movements });
    }

    sessionList.sort((a, b) => {
      const dc = a.date.localeCompare(b.date);
      return dc !== 0 ? dc : sessionOrder(a.session) - sessionOrder(b.session);
    });

    // Currency continuations between consecutive sessions
    const continuations = [];
    for (let i = 1; i < sessionList.length; i++) {
      const curr = sessionList[i];
      const prev = sessionList[i - 1];

      const currencies = [];
      for (const ccy of CURRENCIES) {
        const prevMov = prev.movements[ccy] || 0;
        const currMov = curr.movements[ccy] || 0;

        if (prevMov === 0) continue;
        const sameSign = (prevMov > 0 && currMov > 0) || (prevMov < 0 && currMov < 0);
        if (!sameSign) continue;

        const ratio = Math.round((Math.abs(currMov) / Math.abs(prevMov)) * 100);
        if (ratio < 30) continue;

        currencies.push({
          currency: ccy,
          prevPips: prevMov,
          currPips: currMov,
          ratio,
          strong: ratio >= 50,
        });
      }

      if (currencies.length) {
        currencies.sort((a, b) => b.ratio - a.ratio);
        continuations.push({
          date: curr.date,
          fromSession: prev.session,
          toSession: curr.session,
          fromDate: prev.date,
          currencies,
          continuedCount: currencies.length,
          strongCount: currencies.filter(c => c.strong).length,
        });
      }
    }

    // Session performance: per-session currency movements
    const sessions = sessionList.map(s => ({
      date: s.date,
      session: s.session,
      movements: s.movements,
      strongest: Object.entries(s.movements).reduce((best, [ccy, val]) => val > best.val ? { currency: ccy, val } : best, { currency: '', val: -Infinity }),
      weakest: Object.entries(s.movements).reduce((best, [ccy, val]) => val < best.val ? { currency: ccy, val } : best, { currency: '', val: Infinity }),
    }));

    res.json({
      continuations: continuations.reverse(),
      total: continuations.length,
      sessions: sessions.reverse(),
      sessionCount: sessions.length,
    });
  } catch (e) {
    console.error('[CURRENCY-CONTINUITY]', e.message);
    res.status(500).json({ error: e.message });
  }
};
