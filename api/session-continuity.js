'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

// GET /api/session-continuity?days=30
//
// Treats each trading session as a candle. For every pair the session opens at
// the first H1 bar of the session and closes at the last one; close above open
// makes it a BUY session, below makes it a SELL session. A continuation is a
// session whose direction matches the session before it — the move carried on
// rather than reversed.
//
// This replaces the earlier model, which derived direction by comparing two
// currencies' 6H strength readings. Direction now comes from what price
// actually did between the session's open and its close.
//
// Magnitude is reported two ways because they answer different questions:
//   movePips — the move in the pair's own pips, for reading
//   movePct  — the same move as a percentage, for ranking and for the
//              growing check, since raw pips are not comparable across pairs
//              (80 pips on GBP/JPY is not 80 pips on EUR/CHF)
//
// The live session is still in progress, so its candle is partial and its move
// is necessarily smaller than a finished session's. Those blocks are flagged
// partial:true so the caller can avoid judging them on size alone.

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const VALID_PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD',
  'CHF_JPY','CAD_JPY','CAD_CHF',
];

function pipDiv(inst) { return inst.includes('JPY') ? 0.01 : 0.0001; }

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

// When the session closes, so we can tell a finished block from a live one.
const SESSION_END_HOUR = { ASIA: 6, LONDON: 12, NEW_YORK: 21 };
function sessionEndMs(dateKey, session) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCHours(SESSION_END_HOUR[session] ?? 21, 0, 0, 0);
  return d.getTime();
}

async function fetchH1(sb, sinceIso) {
  const PAGE = 1000;
  const rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('backtest_candles')
      .select('instrument, time, open, close')
      .in('instrument', VALID_PAIRS)
      .eq('timeframe', 'H1')
      .eq('complete', true)
      .gte('time', sinceIso)
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

    const days = Math.min(420, parseInt(req.query?.days || '30', 10) || 30);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // ── Build a session candle per pair ─────────────────────────────────────
    // Bars arrive oldest-first, so the first bar seen for a session sets the
    // open and every later bar overwrites the close.
    const candles = await fetchH1(sb, since);

    const blocks = {}; // `${date}|${session}` -> { date, session, pairs }
    for (const c of candles) {
      const hour = new Date(c.time).getUTCHours();
      const sess = getSession(hour);
      if (!sess) continue; // low-liquidity hours belong to no session
      const dateKey = sessionDate(c.time, sess);
      const key = `${dateKey}|${sess}`;
      const b = blocks[key] || (blocks[key] = { date: dateKey, session: sess, pairs: {} });
      const existing = b.pairs[c.instrument];
      if (!existing) b.pairs[c.instrument] = { open: parseFloat(c.open), close: parseFloat(c.close) };
      else existing.close = parseFloat(c.close);
    }

    // ── Per session: pair directions, plus currency strength from the moves ──
    const now = Date.now();
    const sessionList = [];
    for (const b of Object.values(blocks)) {
      const pairs = [];
      const sums = {}, counts = {};
      for (const c of CURRENCIES) { sums[c] = 0; counts[c] = 0; }

      for (const inst of VALID_PAIRS) {
        const sc = b.pairs[inst];
        if (!sc || !sc.open) continue;
        const pct = ((sc.close - sc.open) / sc.open) * 100;
        const dir = sc.close >= sc.open ? 'BUY' : 'SELL';
        const [base, quote] = inst.split('_');
        sums[base]  += pct; counts[base]++;
        sums[quote] -= pct; counts[quote]++;
        pairs.push({
          instrument: inst,
          dir,
          strong: dir === 'BUY' ? base : quote,
          weak:   dir === 'BUY' ? quote : base,
          movePct:  Math.abs(pct),
          movePips: Math.abs(sc.close - sc.open) / pipDiv(inst),
        });
      }
      if (!pairs.length) continue;

      // Session currency strength = mean % move across the 7 pairs a currency
      // appears in, signed so a rising base counts for it and against its quote.
      const strength = {};
      for (const c of CURRENCIES) strength[c] = counts[c] ? sums[c] / counts[c] : 0;
      const ranked = CURRENCIES.map(c => ({ currency: c, val: strength[c] }))
        .sort((a, b2) => b2.val - a.val);

      sessionList.push({
        date: b.date,
        session: b.session,
        strongest: ranked[0],
        weakest: ranked[ranked.length - 1],
        sum: Math.abs(ranked[0].val) + Math.abs(ranked[ranked.length - 1].val),
        pairs,
        partial: sessionEndMs(b.date, b.session) > now,
      });
    }

    sessionList.sort((a, b) => {
      const dc = a.date.localeCompare(b.date);
      return dc !== 0 ? dc : sessionOrder(a.session) - sessionOrder(b.session);
    });

    // ── Continuations: this session's direction matches an earlier one ───────
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
          const pp = prevMap[p.instrument];
          if (!pp || pp.dir !== p.dir) continue;
          continued.push({
            instrument: p.instrument,
            dir: p.dir,
            strong: p.strong,
            weak: p.weak,
            prevMovePips: pp.movePips,
            currMovePips: p.movePips,
            prevMovePct:  pp.movePct,
            currMovePct:  p.movePct,
            // Extending harder than the session it followed. Meaningless while
            // the current session is still open, hence the partial flag.
            growing: p.movePct > pp.movePct,
          });
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
            partial: curr.partial,
            pairs: continued.sort((a, b) => b.currMovePct - a.currMovePct),
          });
        }
      }
    }

    // ── Live session gets an extra 2H strength confirmation ──────────────────
    // Only the newest hour is needed, so this is 8 rows rather than the whole
    // range.
    const nowH = new Date().getUTCHours();
    const currSess = getSession(nowH);
    const currDate = currSess ? sessionDate(new Date().toISOString(), currSess) : null;

    const latest2h = {};
    const { data: csRows } = await sb
      .from('currency_strength')
      .select('time, currency, smooth_2h')
      .order('time', { ascending: false })
      .limit(CURRENCIES.length);
    for (const r of (csRows || [])) {
      if (latest2h[r.currency] === undefined) latest2h[r.currency] = parseFloat(r.smooth_2h) || 0;
    }
    const h2Dirs = {};
    for (const instrument of VALID_PAIRS) {
      const [base, quote] = instrument.split('_');
      h2Dirs[instrument] = (latest2h[base] || 0) >= (latest2h[quote] || 0) ? 'BUY' : 'SELL';
    }
    const has2h = Object.values(latest2h).some(v => v !== 0);

    for (const c of continuations) {
      const isCurrentSession = currSess && c.toSession === currSess && c.date === currDate;
      c.pairs = c.pairs
        .filter(p => {
          // A finished session must have extended its predecessor. A live one
          // cannot be judged that way yet — it has only run part of its span —
          // so direction alone carries it, plus the 2H check below.
          if (!c.partial && !p.growing) return false;
          if (isCurrentSession && has2h && h2Dirs[p.instrument] !== p.dir) return false;
          return true;
        })
        .sort((a, b) => b.currMovePct - a.currMovePct);
    }

    const filtered = continuations.filter(c => c.pairs.length > 0);
    res.json({ continuations: filtered.reverse(), total: filtered.length });
  } catch (e) {
    console.error('[SESSION-CONTINUITY]', e.message);
    res.status(500).json({ error: e.message });
  }
};
