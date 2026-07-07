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

function previousSession(name, start) {
  let prevName, prevStart;
  if (name === 'ASIA') {
    prevName = 'NY';
    prevStart = new Date(start);
    prevStart.setUTCHours(13, 0, 0, 0);
  } else if (name === 'LONDON') {
    prevName = 'ASIA';
    prevStart = new Date(start);
    prevStart.setUTCDate(prevStart.getUTCDate() - 1);
    prevStart.setUTCHours(21, 0, 0, 0);
  } else {
    prevName = 'LONDON';
    prevStart = new Date(start);
    prevStart.setUTCHours(7, 0, 0, 0);
  }
  const day = prevStart.getUTCDay();
  if (day === 6) {
    prevStart.setUTCDate(prevStart.getUTCDate() - 1);
  } else if (day === 0 && prevStart.getUTCHours() < 21) {
    prevStart.setUTCDate(prevStart.getUTCDate() - 2);
  }
  return { name: prevName, start: prevStart, end: sessionEnd(prevName, prevStart) };
}

function buildSessionCandle(inst, candles) {
  if (!candles.length) return null;
  const pd = pipDiv(inst);
  const open = candles[0].open;
  const close = candles[candles.length - 1].close;
  let high = -Infinity, low = Infinity;
  for (const c of candles) {
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
    lastCandle: candles[candles.length - 1],
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

    const cur = anchor
      ? { name: anchorSession, start: anchor }
      : currentSessionAt(now);
    const curEnd = sessionEnd(cur.name, cur.start);
    const trackStart = cur.start;

    const prev = previousSession(cur.name, cur.start);

    const fetchSince = prev.start.toISOString();
    const fetchUntil = anchor ? curEnd.toISOString() : now.toISOString();

    const PAGE = 1000;
    const h1Cache = {};

    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const allData = [];
        let off = 0;
        while (true) {
          const { data, error } = await sb
            .from('backtest_candles')
            .select('time, open, high, low, close')
            .eq('instrument', inst).eq('timeframe', 'H1')
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
        h1Cache[inst] = data.map(c => ({
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
      const allH1 = h1Cache[inst] || [];
      if (!allH1.length) continue;

      const pd = pipDiv(inst);
      const pair = inst.replace('_', '/');

      const prevH1s = allH1.filter(c => c.time >= prevStartISO && c.time < prevEndISO);
      const ref = buildSessionCandle(inst, prevH1s);
      if (!ref) continue;

      const refDirection = ref.bull ? 'BUY' : 'SELL';

      let score = 50;

      if (ref.bodyPct >= 80) score += 25;
      else if (ref.bodyPct >= 65) score += 20;
      else if (ref.bodyPct >= 50) score += 15;
      else if (ref.bodyPct >= 35) score += 8;

      const rejectionWick = ref.bull ? ref.upperWickPct : ref.lowerWickPct;
      if (rejectionWick <= 5) score += 10;
      else if (rejectionWick <= 15) score += 5;
      else if (rejectionWick >= 30) score -= 5;

      if (ref.rangePips > 60) score += 5;
      else if (ref.rangePips > 35) score += 3;

      score = Math.max(20, Math.min(98, score));
      const initialScore = score;

      const today = allH1.filter(c => c.time >= trackStartISO && c.time < curEndISO);

      const timeline = [{
        time: trackStartISO,
        score,
        label: cur.name + ' Session Open',
        event: refDirection === 'BUY' ? 'Bullish Expansion' : 'Bearish Expansion',
      }];

      let runHigh = ref.bull ? ref.close : ref.high;
      let runLow = ref.bull ? ref.low : ref.close;
      let prevH1 = ref.lastCandle;

      for (let i = 0; i < today.length; i++) {
        const h1 = today[i];
        const h1Bull = h1.close > h1.open;
        const h1Body = Math.abs(h1.close - h1.open);
        const h1BodyPips = Math.round((h1Body / pd) * 10) / 10;
        let delta = 0;
        const events = [];

        const brokeFor = refDirection === 'BUY' ? h1.close > prevH1.high : h1.close < prevH1.low;

        // 1. New high/low — only rewarded when the candle also closes through structure
        if (refDirection === 'BUY') {
          if (h1.high > runHigh) {
            runHigh = h1.high;
            if (brokeFor) { delta += 3; events.push('New high'); }
            else { events.push('New high (wick only)'); }
          } else if (h1.high < prevH1.high && h1.low < prevH1.low) {
            delta -= 4; events.push('Lower high + lower low');
          } else if (h1.high < prevH1.high) {
            delta -= 2; events.push('Lower high');
          }
        } else {
          if (h1.low < runLow) {
            runLow = h1.low;
            if (brokeFor) { delta += 3; events.push('New low'); }
            else { events.push('New low (wick only)'); }
          } else if (h1.low > prevH1.low && h1.high > prevH1.high) {
            delta -= 4; events.push('Higher low + higher high');
          } else if (h1.low > prevH1.low) {
            delta -= 2; events.push('Higher low');
          }
        }

        // 2. Break of structure (closing)
        if (refDirection === 'BUY' && h1.close > prevH1.high) {
          delta += 4; events.push('Close above prev H1 high');
        } else if (refDirection === 'SELL' && h1.close < prevH1.low) {
          delta += 4; events.push('Close below prev H1 low');
        } else if (refDirection === 'BUY' && h1.close < prevH1.low) {
          delta -= 6; events.push('Close below prev H1 low');
        } else if (refDirection === 'SELL' && h1.close > prevH1.high) {
          delta -= 6; events.push('Close above prev H1 high');
        } else {
          events.push('No break of structure');
        }

        // 3. Body strength (H1 scale)
        if (refDirection === 'BUY') {
          if (h1Bull && h1BodyPips > 10) { delta += 2; events.push('Strong bull body'); }
          else if (!h1Bull && h1BodyPips > 10) { delta -= 3; events.push('Strong bear body'); }
          if (!h1Bull && h1Body > 0) {
            const prevBody = Math.abs(prevH1.close - prevH1.open);
            if (h1Body > prevBody * 1.2 && prevH1.close > prevH1.open) {
              delta -= 4; events.push('Bearish engulfing');
            }
          }
        } else {
          if (!h1Bull && h1BodyPips > 10) { delta += 2; events.push('Strong bear body'); }
          else if (h1Bull && h1BodyPips > 10) { delta -= 3; events.push('Strong bull body'); }
          if (h1Bull && h1Body > 0) {
            const prevBody = Math.abs(prevH1.close - prevH1.open);
            if (h1Body > prevBody * 1.2 && prevH1.close < prevH1.open) {
              delta -= 4; events.push('Bullish engulfing');
            }
          }
        }

        // 3b. Chop / indecision — small body + big wicks on both sides
        {
          const h1Range = h1.high - h1.low;
          if (h1Range > 0 && (h1Range / pd) > 12) {
            const bodyPct = (h1Body / h1Range) * 100;
            const upperPct = ((h1.high - Math.max(h1.open, h1.close)) / h1Range) * 100;
            const lowerPct = ((Math.min(h1.open, h1.close) - h1.low) / h1Range) * 100;
            if (bodyPct < 25 && upperPct > 30 && lowerPct > 30) {
              delta -= 2;
              events.push('Choppy candle');
            }
          }
        }

        // 4. Pullback depth vs reference session range
        if (refDirection === 'BUY') {
          const retrace = (runHigh - h1.low) / ref.range;
          if (retrace > 0.7) { delta -= 3; events.push('Deep pullback'); }
        } else {
          const retrace = (h1.high - runLow) / ref.range;
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
          time: h1.time,
          score,
          delta,
          label: statusLabel,
          event: events.join(', ') || 'No change',
          h1: {
            open: h1.open, high: h1.high, low: h1.low, close: h1.close,
            bull: h1Bull, bodyPips: h1BodyPips,
          },
        });

        prevH1 = h1;
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
        h1Count: today.length,
      });
    }

    pairs.sort((a, b) => b.currentScore - a.currentScore);
    res.json({ pairs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
