'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

const VALID_PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];

function isJpy(inst) { return inst.includes('JPY'); }
function pipDiv(inst) { return isJpy(inst) ? 0.01 : 0.0001; }

// Sessions (all UTC hours):
//   ASIA:   21:00 (prev day) → 07:00  (10h)
//   LONDON: 07:00 → 13:00                (6h)
//   NY:     13:00 → 21:00                (8h)
const SESSION_ORDER = ['ASIA', 'LONDON', 'NY'];

// Find the session containing timestamp `t` and its start Date (in UTC).
function currentSessionAt(t) {
  const d = new Date(t);
  const h = d.getUTCHours();
  let name, start;
  if (h >= 21) {
    name = 'ASIA';
    start = new Date(d); start.setUTCHours(21, 0, 0, 0);
  } else if (h < 7) {
    name = 'ASIA';
    start = new Date(d); start.setUTCDate(start.getUTCDate() - 1); start.setUTCHours(21, 0, 0, 0);
  } else if (h < 13) {
    name = 'LONDON';
    start = new Date(d); start.setUTCHours(7, 0, 0, 0);
  } else {
    name = 'NY';
    start = new Date(d); start.setUTCHours(13, 0, 0, 0);
  }
  return { name, start };
}

function sessionEnd(name, start) {
  const end = new Date(start);
  if (name === 'ASIA')   end.setUTCHours(end.getUTCHours() + 10);
  if (name === 'LONDON') end.setUTCHours(end.getUTCHours() + 6);
  if (name === 'NY')     end.setUTCHours(end.getUTCHours() + 8);
  return end;
}

// Given the start of a session, return the previous session's { name, start, end }.
function previousSession(name, start) {
  let prevName, prevStart;
  if (name === 'ASIA') {
    // Previous NY = same forex day - 1
    prevName = 'NY';
    prevStart = new Date(start);
    prevStart.setUTCHours(13, 0, 0, 0); // 13:00 same calendar day as Asia starts... but Asia starts 21:00 prev cal day
    // Asia start is on calendar day X-1 at 21:00 → previous NY is on X-1 at 13:00
    // start.getUTCDate() gives day of start (which is X-1 if start is 21:00)
    // Simpler: prev NY end = Asia start (21:00). NY duration 8h → NY start = 13:00 same cal day as Asia start.
  } else if (name === 'LONDON') {
    // Previous Asia = ends at 07:00 same cal day, starts 21:00 previous cal day
    prevName = 'ASIA';
    prevStart = new Date(start);
    prevStart.setUTCDate(prevStart.getUTCDate() - 1);
    prevStart.setUTCHours(21, 0, 0, 0);
  } else {
    // NY: previous London (same cal day 07:00-13:00)
    prevName = 'LONDON';
    prevStart = new Date(start);
    prevStart.setUTCHours(7, 0, 0, 0);
  }
  // Skip weekend: if the previous session start lands on Sat/Sun, roll back
  // Fri 21:00 UTC opens forex week (Sunday 21:00 actually), Sat/Sun sessions don't exist.
  const day = prevStart.getUTCDay();
  if (day === 6) { // Saturday session — nothing traded → back one more day
    prevStart.setUTCDate(prevStart.getUTCDate() - 1);
  } else if (day === 0 && prevStart.getUTCHours() < 21) { // Sunday before 21:00
    prevStart.setUTCDate(prevStart.getUTCDate() - 2);
  }
  return { name: prevName, start: prevStart, end: sessionEnd(prevName, prevStart) };
}

function buildSessionCandle(inst, m15s) {
  if (!m15s.length) return null;
  const pd = pipDiv(inst);
  const open = m15s[0].open;
  const close = m15s[m15s.length - 1].close;
  let high = -Infinity, low = Infinity;
  for (const c of m15s) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  const range = high - low;
  if (range < pd) return null;
  const body = Math.abs(close - open);
  const bull = close > open;
  return {
    open, high, low, close, bull, body, range,
    bodyPct: Math.round((body / range) * 100),
    rangePips: Math.round((range / pd) * 10) / 10,
    bodyPips: Math.round((body / pd) * 10) / 10,
    upperWickPct: Math.round(((bull ? high - close : high - open) / range) * 100),
    lowerWickPct: Math.round(((bull ? open - low : close - low) / range) * 100),
    lastM15: m15s[m15s.length - 1],
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const now = new Date();

    // Optional historical mode: ?date=YYYY-MM-DD&session=ASIA|LONDON|NY replays that session.
    const qDate = req.query?.date;
    const qSession = (req.query?.session || '').toUpperCase();
    let anchor = null;
    let anchorSession = null;

    if (qDate && SESSION_ORDER.includes(qSession)) {
      const base = new Date(qDate + 'T00:00:00Z');
      if (!isNaN(base.getTime())) {
        anchor = new Date(base);
        if (qSession === 'ASIA') { anchor.setUTCDate(anchor.getUTCDate() - 1); anchor.setUTCHours(21, 0, 0, 0); }
        if (qSession === 'LONDON') anchor.setUTCHours(7, 0, 0, 0);
        if (qSession === 'NY') anchor.setUTCHours(13, 0, 0, 0);
        anchorSession = qSession;
      }
    }

    // Current session (live) or picked session (historical)
    const cur = anchor
      ? { name: anchorSession, start: anchor }
      : currentSessionAt(now);
    const curEnd = sessionEnd(cur.name, cur.start);
    const trackStart = cur.start;

    // Reference session = the previous one
    const prev = previousSession(cur.name, cur.start);

    // Fetch M15 candles covering the ref session start through end-of-current-session
    const fetchSince = prev.start.toISOString();
    const fetchUntil = anchor ? curEnd.toISOString() : now.toISOString();

    const PAGE = 1000;
    const m15Cache = {};

    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const allData = [];
        let off = 0;
        while (true) {
          const { data, error } = await sb
            .from('backtest_candles')
            .select('time, open, high, low, close')
            .eq('instrument', inst).eq('timeframe', 'M15')
            .gte('time', fetchSince).lte('time', fetchUntil)
            .order('time', { ascending: true })
            .range(off, off + PAGE - 1);
          if (error) throw error;
          if (!data || !data.length) break;
          allData.push(...data);
          if (data.length < PAGE) break;
          off += PAGE;
        }
        return { inst, data: allData };
      }));
      for (const { inst, data } of results) {
        m15Cache[inst] = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
      }
    }

    const prevStartISO = prev.start.toISOString();
    const prevEndISO = prev.end.toISOString();
    const trackStartISO = trackStart.toISOString();
    const curEndISO = curEnd.toISOString();

    const pairs = [];

    for (const inst of VALID_PAIRS) {
      const m5all = m15Cache[inst] || [];
      if (!m5all.length) continue;

      const pd = pipDiv(inst);
      const pair = inst.replace('_', '/');

      // Reference session candle built from M15s in the previous session
      const prevM15s = m5all.filter(c => c.time >= prevStartISO && c.time < prevEndISO);
      const ref = buildSessionCandle(inst, prevM15s);
      if (!ref) continue;

      const refDirection = ref.bull ? 'BUY' : 'SELL';

      // Phase 1: Initial score from the reference session
      let score = 50;

      if (ref.bodyPct >= 80) score += 25;
      else if (ref.bodyPct >= 65) score += 20;
      else if (ref.bodyPct >= 50) score += 15;
      else if (ref.bodyPct >= 35) score += 8;

      const rejectionWick = ref.bull ? ref.upperWickPct : ref.lowerWickPct;
      if (rejectionWick <= 5) score += 10;
      else if (rejectionWick <= 15) score += 5;
      else if (rejectionWick >= 30) score -= 5;

      // Session-scale range bonus
      if (ref.rangePips > 60) score += 5;
      else if (ref.rangePips > 35) score += 3;

      score = Math.max(20, Math.min(98, score));
      const initialScore = score;

      // Phase 2: current session's M15 candles update the score
      const today = m5all.filter(c => c.time >= trackStartISO && c.time < curEndISO);

      const timeline = [{
        time: trackStartISO,
        score,
        label: cur.name + ' Session Open',
        event: refDirection === 'BUY' ? 'Bullish Expansion' : 'Bearish Expansion',
      }];

      let runHigh = ref.bull ? ref.close : ref.high;
      let runLow = ref.bull ? ref.low : ref.close;
      let prevM15 = ref.lastM15;

      for (let i = 0; i < today.length; i++) {
        const m15 = today[i];
        const m15Bull = m15.close > m15.open;
        const m15Body = Math.abs(m15.close - m15.open);
        const m15BodyPips = Math.round((m15Body / pd) * 10) / 10;
        let delta = 0;
        const events = [];

        // Closing break of structure in the continuation direction
        const brokeFor = refDirection === 'BUY' ? m15.close > prevM15.high : m15.close < prevM15.low;

        // 1. New high/low — only rewarded when the candle also closes through structure
        if (refDirection === 'BUY') {
          if (m15.high > runHigh) {
            runHigh = m15.high;
            if (brokeFor) { delta += 3; events.push('New high'); }
            else { events.push('New high (wick only)'); }
          } else if (m15.high < prevM15.high && m15.low < prevM15.low) {
            delta -= 4; events.push('Lower high + lower low');
          } else if (m15.high < prevM15.high) {
            delta -= 2; events.push('Lower high');
          }
        } else {
          if (m15.low < runLow) {
            runLow = m15.low;
            if (brokeFor) { delta += 3; events.push('New low'); }
            else { events.push('New low (wick only)'); }
          } else if (m15.low > prevM15.low && m15.high > prevM15.high) {
            delta -= 4; events.push('Higher low + higher high');
          } else if (m15.low > prevM15.low) {
            delta -= 2; events.push('Higher low');
          }
        }

        // 2. Break of structure (closing)
        if (refDirection === 'BUY' && m15.close > prevM15.high) {
          delta += 4; events.push('Close above prev M15 high');
        } else if (refDirection === 'SELL' && m15.close < prevM15.low) {
          delta += 4; events.push('Close below prev M15 low');
        } else if (refDirection === 'BUY' && m15.close < prevM15.low) {
          delta -= 6; events.push('Close below prev M15 low');
        } else if (refDirection === 'SELL' && m15.close > prevM15.high) {
          delta -= 6; events.push('Close above prev M15 high');
        } else {
          delta -= 2; events.push('No break of structure');
        }

        // 3. Body strength (M15 scale — pips thresholds slightly higher than M5)
        if (refDirection === 'BUY') {
          if (m15Bull && m15BodyPips > 6) { delta += 2; events.push('Strong bull body'); }
          else if (!m15Bull && m15BodyPips > 6) { delta -= 3; events.push('Strong bear body'); }
          if (!m15Bull && m15Body > 0) {
            const prevBody = Math.abs(prevM15.close - prevM15.open);
            if (m15Body > prevBody * 1.2 && prevM15.close > prevM15.open) {
              delta -= 4; events.push('Bearish engulfing');
            }
          }
        } else {
          if (!m15Bull && m15BodyPips > 6) { delta += 2; events.push('Strong bear body'); }
          else if (m15Bull && m15BodyPips > 6) { delta -= 3; events.push('Strong bull body'); }
          if (m15Bull && m15Body > 0) {
            const prevBody = Math.abs(prevM15.close - prevM15.open);
            if (m15Body > prevBody * 1.2 && prevM15.close < prevM15.open) {
              delta -= 4; events.push('Bullish engulfing');
            }
          }
        }

        // 4. Pullback depth vs reference session range
        if (refDirection === 'BUY') {
          const retrace = (runHigh - m15.low) / ref.range;
          if (retrace > 0.7) { delta -= 3; events.push('Deep pullback'); }
        } else {
          const retrace = (m15.high - runLow) / ref.range;
          if (retrace > 0.7) { delta -= 3; events.push('Deep pullback'); }
        }

        score = Math.max(0, Math.min(100, score + delta));

        let statusLabel = '';
        if (score >= 85) statusLabel = 'Strong Continuation';
        else if (score >= 70) statusLabel = 'Continuation Holding';
        else if (score >= 50) statusLabel = 'Weakening';
        else if (score >= 30) statusLabel = 'Possible Reversal';
        else statusLabel = 'Continuation Failed';

        timeline.push({
          time: m15.time,
          score,
          delta,
          label: statusLabel,
          event: events.join(', ') || 'No change',
          m15: {
            open: m15.open, high: m15.high, low: m15.low, close: m15.close,
            bull: m15Bull, bodyPips: m15BodyPips,
          },
        });

        prevM15 = m15;
      }

      const currentScore = score;
      let currentLabel;
      if (currentScore >= 85) currentLabel = 'Strong Continuation';
      else if (currentScore >= 70) currentLabel = 'Continuation Holding';
      else if (currentScore >= 50) currentLabel = 'Weakening';
      else if (currentScore >= 30) currentLabel = 'Possible Reversal';
      else currentLabel = 'Continuation Failed';

      pairs.push({
        pair,
        instrument: inst,
        direction: refDirection,
        currentScore,
        currentLabel,
        initialScore,
        refSession: {
          name: prev.name,
          start: prevStartISO,
          end: prevEndISO,
          open: ref.open, high: ref.high, low: ref.low, close: ref.close,
          bodyPct: ref.bodyPct, upperWickPct: ref.upperWickPct, lowerWickPct: ref.lowerWickPct,
          rangePips: ref.rangePips, bodyPips: ref.bodyPips,
          direction: refDirection,
        },
        currentSession: {
          name: cur.name,
          start: trackStartISO,
          end: curEndISO,
        },
        timeline,
        m15Count: today.length,
      });
    }

    pairs.sort((a, b) => b.currentScore - a.currentScore);
    res.json({ pairs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
