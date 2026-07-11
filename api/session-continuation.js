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

// Build a synthetic session candle from an ordered array of M15 (or any-TF) candles
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
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    if (!req._internal) {
      const gate = await requirePlan(sb, req, 'premium');
      if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
    }

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

    const prev  = previousSession(cur.name, cur.start);
    const prev2 = previousSession(prev.name, prev.start);
    const prev3 = previousSession(prev2.name, prev2.start);

    const fetchSince = prev3.start.toISOString();
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

    const prevStartISO  = prev.start.toISOString();
    const prevEndISO    = prev.end.toISOString();
    const prev2StartISO = prev2.start.toISOString();
    const prev2EndISO   = prev2.end.toISOString();
    const prev3StartISO = prev3.start.toISOString();
    const prev3EndISO   = prev3.end.toISOString();
    const trackStartISO = trackStart.toISOString();
    const curEndISO     = curEnd.toISOString();

    const pairs = [];

    for (const inst of VALID_PAIRS) {
      const all = m15Cache[inst] || [];
      if (!all.length) continue;

      const pd = pipDiv(inst);
      const pair = inst.replace('_', '/');

      // Build synthetic candles for the last three sessions
      const prevM15s  = all.filter(c => c.time >= prevStartISO  && c.time < prevEndISO);
      const prev2M15s = all.filter(c => c.time >= prev2StartISO && c.time < prev2EndISO);
      const prev3M15s = all.filter(c => c.time >= prev3StartISO && c.time < prev3EndISO);
      const ref  = buildSessionCandle(inst, prevM15s);
      const ref2 = buildSessionCandle(inst, prev2M15s);
      const ref3 = buildSessionCandle(inst, prev3M15s);
      if (!ref || !ref2) continue;

      // Direction confirmation: one of the last two sessions must have CLOSED beyond
      // its own previous session's high (BUY) or low (SELL).
      const r1BuyBrk  = ref.close  > ref2.high;
      const r1SellBrk = ref.close  < ref2.low;
      const r2BuyBrk  = ref3 ? ref2.close > ref3.high : false;
      const r2SellBrk = ref3 ? ref2.close < ref3.low  : false;

      const buyConfirm  = r1BuyBrk  || r2BuyBrk;
      const sellConfirm = r1SellBrk || r2SellBrk;

      let confirmedDirection = null;
      if (buyConfirm && !sellConfirm) confirmedDirection = 'BUY';
      else if (sellConfirm && !buyConfirm) confirmedDirection = 'SELL';
      else if (buyConfirm && sellConfirm) {
        if (r1BuyBrk) confirmedDirection = 'BUY';
        else if (r1SellBrk) confirmedDirection = 'SELL';
        else confirmedDirection = r2BuyBrk ? 'BUY' : 'SELL';
      }
      if (!confirmedDirection) continue;

      // Strength of the confirming break (prev session broke its own predecessor
      // by this many pips) — used to rank pairs.
      let refBreakPips = 0;
      if (confirmedDirection === 'BUY') {
        if (r1BuyBrk) refBreakPips = (ref.close - ref2.high) / pd;
        else if (r2BuyBrk) refBreakPips = (ref2.close - ref3.high) / pd;
      } else {
        if (r1SellBrk) refBreakPips = (ref2.low - ref.close) / pd;
        else if (r2SellBrk) refBreakPips = (ref3.low - ref2.close) / pd;
      }
      refBreakPips = Math.round(refBreakPips * 10) / 10;

      // Current session's M15 candles
      const curM15s = all.filter(c => c.time >= trackStartISO && c.time < curEndISO);
      if (!curM15s.length) continue;

      // Phase 1: locate the TRIGGER M15 — first M15 that closes beyond the prev session's
      // high in the confirmed BUY direction, or below its low in the confirmed SELL
      // direction. Monitoring only starts here.
      let triggerIdx = -1;
      const direction = confirmedDirection;
      for (let i = 0; i < curM15s.length; i++) {
        const c = curM15s[i];
        // Blackout window: skip triggers between 21:00 and 22:00 UTC (00:00-01:00 EAT)
        if (new Date(c.time).getUTCHours() === 21) continue;
        if (direction === 'BUY' && c.close > ref.high) { triggerIdx = i; break; }
        if (direction === 'SELL' && c.close < ref.low) { triggerIdx = i; break; }
      }
      if (triggerIdx === -1) continue;

      const trigger = curM15s[triggerIdx];
      const triggerBreakPips = direction === 'BUY'
        ? (trigger.close - ref.high) / pd
        : (ref.low - trigger.close) / pd;

      // Initial score
      let score = 50;
      score += 20; // baseline for triggering
      if (triggerBreakPips > 15) score += 15;
      else if (triggerBreakPips > 8) score += 10;
      else if (triggerBreakPips > 4) score += 5;

      const triggerBull = trigger.close > trigger.open;
      if ((direction === 'BUY' && triggerBull) || (direction === 'SELL' && !triggerBull)) score += 5;

      score = Math.max(20, Math.min(98, score));
      const initialScore = score;

      const timeline = [{
        time: trigger.time,
        score,
        label: 'Break',
        event: direction === 'BUY'
          ? 'Close above prev session high (' + Math.round(triggerBreakPips * 10) / 10 + ' pips)'
          : 'Close below prev session low (' + Math.round(triggerBreakPips * 10) / 10 + ' pips)',
        m15: {
          open: trigger.open, high: trigger.high, low: trigger.low, close: trigger.close,
          bull: triggerBull,
          bodyPips: Math.round((Math.abs(trigger.close - trigger.open) / pd) * 10) / 10,
        },
      }];

      let qualifiedTime = score >= 84 ? trigger.time : null;
      if (qualifiedTime) {
        timeline[0].label = 'Trigger';
        timeline[0].qualified = true;
      }

      let runHigh = trigger.high;
      let runLow = trigger.low;
      let prevC = trigger;
      let state = 'MONITORING';
      let stoppedTime = null;

      for (let i = triggerIdx + 1; i < curM15s.length; i++) {
        const c = curM15s[i];

        // Invalidation: close back inside prev session's range
        if (c.close < ref.high && c.close > ref.low) {
          state = 'STOPPED';
          stoppedTime = c.time;
          timeline.push({
            time: c.time,
            score,
            delta: 0,
            label: 'Monitoring Stopped',
            event: 'Close back inside prev session range',
            m15: {
              open: c.open, high: c.high, low: c.low, close: c.close,
              bull: c.close > c.open,
              bodyPips: Math.round((Math.abs(c.close - c.open) / pd) * 10) / 10,
            },
          });
          break;
        }

        const cBull = c.close > c.open;
        const cBody = Math.abs(c.close - c.open);
        const cBodyPips = Math.round((cBody / pd) * 10) / 10;
        const cRange = c.high - c.low;
        let delta = 0;
        const events = [];

        const brokeFor = direction === 'BUY' ? c.close > prevC.high : c.close < prevC.low;

        // 1. New high/low — only rewarded when the candle also closes through structure
        if (direction === 'BUY') {
          if (c.high > runHigh) {
            runHigh = c.high;
            if (brokeFor) { delta += 3; events.push('New high'); }
            else { events.push('New high (wick only)'); }
          } else if (c.high < prevC.high && c.low < prevC.low) {
            delta -= 4; events.push('Lower high + lower low');
          } else if (c.high < prevC.high) {
            delta -= 2; events.push('Lower high');
          }
        } else {
          if (c.low < runLow) {
            runLow = c.low;
            if (brokeFor) { delta += 3; events.push('New low'); }
            else { events.push('New low (wick only)'); }
          } else if (c.low > prevC.low && c.high > prevC.high) {
            delta -= 4; events.push('Higher low + higher high');
          } else if (c.low > prevC.low) {
            delta -= 2; events.push('Higher low');
          }
        }

        // 2. M15 close beyond previous M15 high/low
        //    Reward continuation break; adverse close still penalizes; no penalty for
        //    a candle that simply failed to break the previous M15 level.
        if (direction === 'BUY' && c.close > prevC.high) {
          delta += 4; events.push('Close above prev M15 high');
        } else if (direction === 'SELL' && c.close < prevC.low) {
          delta += 4; events.push('Close below prev M15 low');
        } else if (direction === 'BUY' && c.close < prevC.low) {
          delta -= 6; events.push('Close below prev M15 low');
        } else if (direction === 'SELL' && c.close > prevC.high) {
          delta -= 6; events.push('Close above prev M15 high');
        } else {
          events.push('No break of structure');
        }

        // 3. Body strength (M15 scale)
        if (direction === 'BUY') {
          if (cBull && cBodyPips > 6) { delta += 2; events.push('Strong bull body'); }
          else if (!cBull && cBodyPips > 6) { delta -= 3; events.push('Strong bear body'); }
          if (!cBull && cBody > 0) {
            const prevBody = Math.abs(prevC.close - prevC.open);
            if (cBody > prevBody * 1.2 && prevC.close > prevC.open) {
              delta -= 4; events.push('Bearish engulfing');
            }
          }
        } else {
          if (!cBull && cBodyPips > 6) { delta += 2; events.push('Strong bear body'); }
          else if (cBull && cBodyPips > 6) { delta -= 3; events.push('Strong bull body'); }
          if (cBull && cBody > 0) {
            const prevBody = Math.abs(prevC.close - prevC.open);
            if (cBody > prevBody * 1.2 && prevC.close < prevC.open) {
              delta -= 4; events.push('Bullish engulfing');
            }
          }
        }

        // 3b. Chop / indecision — small body + big wicks on both sides
        if (cRange > 0 && (cRange / pd) > 6) {
          const bodyPct = (cBody / cRange) * 100;
          const upperPct = ((c.high - Math.max(c.open, c.close)) / cRange) * 100;
          const lowerPct = ((Math.min(c.open, c.close) - c.low) / cRange) * 100;
          if (bodyPct < 25 && upperPct > 30 && lowerPct > 30) {
            delta -= 2;
            events.push('Choppy candle');
          }
        }

        // 4. Pullback depth vs reference session range
        if (direction === 'BUY') {
          const retrace = (runHigh - c.low) / ref.range;
          if (retrace > 0.7) { delta -= 3; events.push('Deep pullback'); }
        } else {
          const retrace = (c.high - runLow) / ref.range;
          if (retrace > 0.7) { delta -= 3; events.push('Deep pullback'); }
        }

        score = Math.max(0, Math.min(100, score + delta));

        let statusLabel = '';
        if (score >= 85) statusLabel = 'Strong Continuation';
        else if (score >= 70) statusLabel = 'Continuation Holding';
        else if (score >= 50) statusLabel = 'Weakening';
        else if (score >= 30) statusLabel = 'Possible Reversal';
        else statusLabel = 'Continuation Failed';

        let entryLabel = statusLabel;
        let justQualified = false;
        if (qualifiedTime === null && score >= 84) {
          qualifiedTime = c.time;
          entryLabel = 'Trigger';
          justQualified = true;
        }

        timeline.push({
          time: c.time,
          score,
          delta,
          label: entryLabel,
          event: justQualified
            ? 'Score crossed 84 (' + (events.join(', ') || 'No change') + ')'
            : (events.join(', ') || 'No change'),
          qualified: justQualified || undefined,
          m15: {
            open: c.open, high: c.high, low: c.low, close: c.close,
            bull: cBull, bodyPips: cBodyPips,
          },
        });

        prevC = c;
      }

      const currentScore = score;
      let currentLabel;
      if (state === 'STOPPED') currentLabel = 'Monitoring Stopped';
      else if (currentScore >= 85) currentLabel = 'Strong Continuation';
      else if (currentScore >= 70) currentLabel = 'Continuation Holding';
      else if (currentScore >= 50) currentLabel = 'Weakening';
      else if (currentScore >= 30) currentLabel = 'Possible Reversal';
      else currentLabel = 'Continuation Failed';

      pairs.push({
        pair,
        instrument: inst,
        direction,
        currentScore,
        currentLabel,
        initialScore,
        state,
        breakTime: trigger.time,
        triggerTime: qualifiedTime,
        qualified: qualifiedTime !== null,
        stoppedTime,
        triggerBreakPips: Math.round(triggerBreakPips * 10) / 10,
        refBreakPips,
        refSession: {
          name: prev.name,
          start: prevStartISO,
          end: prevEndISO,
          open: ref.open, high: ref.high, low: ref.low, close: ref.close,
          bodyPct: ref.bodyPct, upperWickPct: ref.upperWickPct, lowerWickPct: ref.lowerWickPct,
          rangePips: ref.rangePips, bodyPips: ref.bodyPips,
          direction: ref.bull ? 'BUY' : 'SELL',
        },
        currentSession: {
          name: cur.name,
          start: trackStartISO,
          end: curEndISO,
        },
        timeline,
        m15Count: curM15s.length - triggerIdx,
      });
    }

    // Sort: qualified first; then by prev-session break strength (refBreakPips
    // desc); then by trigger/break time asc; finally by triggerBreakPips desc.
    pairs.sort((a, b) => {
      if (a.triggerTime && !b.triggerTime) return -1;
      if (!a.triggerTime && b.triggerTime) return 1;
      if ((b.refBreakPips || 0) !== (a.refBreakPips || 0)) return (b.refBreakPips || 0) - (a.refBreakPips || 0);
      const at = a.triggerTime || a.breakTime;
      const bt = b.triggerTime || b.breakTime;
      if (at !== bt) return at < bt ? -1 : 1;
      return b.triggerBreakPips - a.triggerBreakPips;
    });
    res.json({ pairs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
