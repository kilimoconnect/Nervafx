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

    // Determine "today" and "yesterday" in UTC (forex day = 21:00 UTC to 21:00 UTC)
    const now = new Date();
    const todayDate = req.query?.date;
    let dayStart, prevDayStart;

    if (todayDate) {
      // User picks June 23 = they want June 23's forex day
      // Forex day for June 23 starts June 22 at 21:00 UTC
      const picked = new Date(todayDate + 'T00:00:00Z');
      picked.setUTCDate(picked.getUTCDate() - 1);
      dayStart = new Date(picked);
      dayStart.setUTCHours(21, 0, 0, 0);
      prevDayStart = new Date(dayStart.getTime() - 24 * 3600000);
      // Skip weekends for prevDayStart (if picking Monday, yesterday = Friday)
      const pdDay2 = prevDayStart.getUTCDay();
      if (pdDay2 === 6) prevDayStart.setUTCDate(prevDayStart.getUTCDate() - 2);
      else if (pdDay2 === 5) prevDayStart.setUTCDate(prevDayStart.getUTCDate() - 1);
    } else {
      // Auto-detect current forex day
      const h = now.getUTCHours();
      const base = new Date(now);
      base.setUTCMinutes(0, 0, 0);
      if (h >= 21) {
        dayStart = new Date(base); dayStart.setUTCHours(21);
      } else {
        dayStart = new Date(base); dayStart.setUTCDate(dayStart.getUTCDate() - 1); dayStart.setUTCHours(21);
      }
      // Skip weekends: "today" should be the last trading day
      // dayStart is the start of the forex day (prev calendar day 21:00)
      // If dayStart falls on Fri 21:00 (= Saturday's forex day), go back to Thu 21:00
      // If dayStart falls on Sat 21:00 (= Sunday's forex day), go back to Thu 21:00
      const dsDay = dayStart.getUTCDay();
      if (dsDay === 5) { // Friday 21:00 = Saturday forex day → back to Thursday 21:00
        dayStart.setUTCDate(dayStart.getUTCDate() - 1);
      } else if (dsDay === 6) { // Saturday 21:00 = Sunday forex day → back to Thursday 21:00
        dayStart.setUTCDate(dayStart.getUTCDate() - 2);
      }
      prevDayStart = new Date(dayStart.getTime() - 24 * 3600000);
      // Skip weekends for prevDayStart (Monday: prevDay lands on Saturday)
      const pdDay = prevDayStart.getUTCDay();
      if (pdDay === 6) prevDayStart.setUTCDate(prevDayStart.getUTCDate() - 2); // Sat → Thu
      else if (pdDay === 5) prevDayStart.setUTCDate(prevDayStart.getUTCDate() - 1); // Fri → Thu
    }

    const dayEnd = new Date(dayStart.getTime() + 24 * 3600000);

    // Also compute day-before-yesterday (D-2) and D-3 starts with weekend skipping,
    // so the direction check can look at breaks over the last two ref candles.
    function backOneTradingDay(from) {
      const prev = new Date(from.getTime() - 24 * 3600000);
      const d = prev.getUTCDay();
      if (d === 6) prev.setUTCDate(prev.getUTCDate() - 2);
      else if (d === 5) prev.setUTCDate(prev.getUTCDate() - 1);
      return prev;
    }
    const prev2DayStart = backOneTradingDay(prevDayStart);
    const prev3DayStart = backOneTradingDay(prev2DayStart);

    const fetchSince = prev3DayStart.toISOString();
    const fetchUntil = todayDate ? dayEnd.toISOString() : (now < dayEnd ? now : dayEnd).toISOString();

    // Fetch H1 candles for all pairs covering yesterday + today
    const PAGE = 1000;
    const candleCache = {};

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
        candleCache[inst] = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
      }
    }

    const pairs = [];

    for (const inst of VALID_PAIRS) {
      const candles = candleCache[inst] || [];
      if (candles.length < 2) continue;

      const pd = pipDiv(inst);
      const pair = inst.replace('_', '/');

      // Split into daily windows: today, D-1 (yesterday), D-2, D-3
      const dayStartISO = dayStart.toISOString();
      const prevDayStartISO = prevDayStart.toISOString();
      const prev2StartISO = prev2DayStart.toISOString();
      const prev3StartISO = prev3DayStart.toISOString();

      const yesterday = candles.filter(c => c.time >= prevDayStartISO && c.time < dayStartISO);
      const dayBefore = candles.filter(c => c.time >= prev2StartISO && c.time < prevDayStartISO);
      const day3 = candles.filter(c => c.time >= prev3StartISO && c.time < prev2StartISO);
      const today = candles.filter(c => c.time >= dayStartISO);

      if (yesterday.length < 5 || dayBefore.length < 5) continue;

      // Build a synthetic daily candle from an H1 window
      function synth(win) {
        if (!win.length) return null;
        const open = win[0].open;
        const close = win[win.length - 1].close;
        let high = -Infinity, low = Infinity;
        for (const c of win) {
          if (c.high > high) high = c.high;
          if (c.low < low) low = c.low;
        }
        return { open, high, low, close };
      }

      const d1 = synth(yesterday);
      const d2 = synth(dayBefore);
      const d3 = synth(day3);
      if (!d1 || !d2) continue;

      // Direction confirmation: one of the last two daily candles must have CLOSED
      // beyond its own previous day's high (BUY) or low (SELL).
      const d1BreakBuy  = d1.close > d2.high;
      const d1BreakSell = d1.close < d2.low;
      const d2BreakBuy  = d3 ? d2.close > d3.high : false;
      const d2BreakSell = d3 ? d2.close < d3.low  : false;

      const buyConfirm  = d1BreakBuy  || d2BreakBuy;
      const sellConfirm = d1BreakSell || d2BreakSell;

      let confirmedDirection = null;
      if (buyConfirm && !sellConfirm) confirmedDirection = 'BUY';
      else if (sellConfirm && !buyConfirm) confirmedDirection = 'SELL';
      else if (buyConfirm && sellConfirm) {
        // Both fired — prefer the more recent (D-1) break
        if (d1BreakBuy) confirmedDirection = 'BUY';
        else if (d1BreakSell) confirmedDirection = 'SELL';
        else confirmedDirection = d2BreakBuy ? 'BUY' : 'SELL';
      }
      if (!confirmedDirection) continue;

      // D-1 = the level reference for triggering monitoring today
      const ydOpen = d1.open;
      const ydClose = d1.close;
      const ydHigh = d1.high;
      const ydLow = d1.low;
      const ydRange = ydHigh - ydLow;
      if (ydRange < pd) continue;

      const ydBody = Math.abs(ydClose - ydOpen);
      const ydBull = ydClose > ydOpen;
      const ydDirection = ydBull ? 'BUY' : 'SELL';
      const ydBodyPct = Math.round((ydBody / ydRange) * 100);
      const upperWick = ydBull ? ydHigh - ydClose : ydHigh - ydOpen;
      const lowerWick = ydBull ? ydOpen - ydLow : ydClose - ydLow;
      const upperWickPct = Math.round((upperWick / ydRange) * 100);
      const lowerWickPct = Math.round((lowerWick / ydRange) * 100);
      const ydRangePips = Math.round((ydRange / pd) * 10) / 10;
      const ydBodyPips = Math.round((ydBody / pd) * 10) / 10;

      // Phase 1: locate the TRIGGER H1 — first H1 that closes beyond yesterday's high
      // in the confirmed BUY direction, or below yesterday's low in the confirmed SELL
      // direction. Monitoring only starts here.
      let triggerIdx = -1;
      const direction = confirmedDirection;
      for (let i = 0; i < today.length; i++) {
        const c = today[i];
        // Blackout window: skip triggers between 21:00 and 22:00 UTC (00:00-01:00 EAT)
        if (new Date(c.time).getUTCHours() === 21) continue;
        if (direction === 'BUY' && c.close > ydHigh) { triggerIdx = i; break; }
        if (direction === 'SELL' && c.close < ydLow) { triggerIdx = i; break; }
      }

      // No trigger yet — skip this pair
      if (triggerIdx === -1) continue;

      const trigger = today[triggerIdx];
      const triggerBreakPips = direction === 'BUY'
        ? (trigger.close - ydHigh) / pd
        : (ydLow - trigger.close) / pd;

      // Initial score = 50 + bonus proportional to how far past the level the trigger closed
      let score = 50;
      score += 20; // baseline for triggering
      if (triggerBreakPips > 20) score += 15;
      else if (triggerBreakPips > 10) score += 10;
      else if (triggerBreakPips > 5) score += 5;

      // Body direction alignment bonus (trigger H1 body vs direction)
      const triggerBull = trigger.close > trigger.open;
      if ((direction === 'BUY' && triggerBull) || (direction === 'SELL' && !triggerBull)) score += 5;

      score = Math.max(20, Math.min(98, score));
      const initialScore = score;

      // Phase 2: score subsequent H1s until a close falls back inside [ydLow, ydHigh]
      const timeline = [{
        time: trigger.time,
        score,
        label: 'Trigger',
        event: direction === 'BUY'
          ? 'Close above prev daily high (' + Math.round(triggerBreakPips * 10) / 10 + ' pips)'
          : 'Close below prev daily low (' + Math.round(triggerBreakPips * 10) / 10 + ' pips)',
        h1: {
          open: trigger.open, high: trigger.high, low: trigger.low, close: trigger.close,
          bull: triggerBull,
          bodyPips: Math.round((Math.abs(trigger.close - trigger.open) / pd) * 10) / 10,
        },
      }];

      let runHigh = direction === 'BUY' ? trigger.high : trigger.high;
      let runLow = direction === 'SELL' ? trigger.low : trigger.low;
      let prevH1 = trigger;
      let state = 'MONITORING';
      let stoppedTime = null;

      for (let i = triggerIdx + 1; i < today.length; i++) {
        const h1 = today[i];

        // Invalidation check: close back inside yesterday's daily range
        if (h1.close < ydHigh && h1.close > ydLow) {
          state = 'STOPPED';
          stoppedTime = h1.time;
          timeline.push({
            time: h1.time,
            score,
            delta: 0,
            label: 'Monitoring Stopped',
            event: 'Close back inside prev daily range',
            h1: {
              open: h1.open, high: h1.high, low: h1.low, close: h1.close,
              bull: h1.close > h1.open,
              bodyPips: Math.round((Math.abs(h1.close - h1.open) / pd) * 10) / 10,
            },
          });
          break;
        }

        const h1Bull = h1.close > h1.open;
        const h1Body = Math.abs(h1.close - h1.open);
        const h1BodyPips = Math.round((h1Body / pd) * 10) / 10;
        const h1Range = h1.high - h1.low;
        let delta = 0;
        const events = [];

        const brokeFor = direction === 'BUY' ? h1.close > prevH1.high : h1.close < prevH1.low;

        // 1. New high/low — only rewarded when the candle also closes through structure
        if (direction === 'BUY') {
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

        // 2. H1 close beyond previous H1 high/low
        //    Reward continuation break; adverse close still penalizes; no penalty for
        //    a candle that simply failed to break the previous H1 level.
        if (direction === 'BUY' && h1.close > prevH1.high) {
          delta += 4; events.push('Close above prev H1 high');
        } else if (direction === 'SELL' && h1.close < prevH1.low) {
          delta += 4; events.push('Close below prev H1 low');
        } else if (direction === 'BUY' && h1.close < prevH1.low) {
          delta -= 6; events.push('Close below prev H1 low');
        } else if (direction === 'SELL' && h1.close > prevH1.high) {
          delta -= 6; events.push('Close above prev H1 high');
        } else {
          events.push('No break of structure');
        }

        // 3. Body strength
        if (direction === 'BUY') {
          if (h1Bull && h1BodyPips > 10) { delta += 2; events.push('Strong bull body'); }
          else if (!h1Bull && h1BodyPips > 10) { delta -= 3; events.push('Strong bear body'); }
          if (!h1Bull && h1Body > 0 && h1Range > 0) {
            const prevBody = Math.abs(prevH1.close - prevH1.open);
            if (h1Body > prevBody * 1.2 && prevH1.close > prevH1.open) {
              delta -= 4; events.push('Bearish engulfing');
            }
          }
        } else {
          if (!h1Bull && h1BodyPips > 10) { delta += 2; events.push('Strong bear body'); }
          else if (h1Bull && h1BodyPips > 10) { delta -= 3; events.push('Strong bull body'); }
          if (h1Bull && h1Body > 0 && h1Range > 0) {
            const prevBody = Math.abs(prevH1.close - prevH1.open);
            if (h1Body > prevBody * 1.2 && prevH1.close < prevH1.open) {
              delta -= 4; events.push('Bullish engulfing');
            }
          }
        }

        // 3b. Chop / indecision — small body + big wicks on both sides
        if (h1Range > 0 && (h1Range / pd) > 12) {
          const bodyPct = (h1Body / h1Range) * 100;
          const upperPct = ((h1.high - Math.max(h1.open, h1.close)) / h1Range) * 100;
          const lowerPct = ((Math.min(h1.open, h1.close) - h1.low) / h1Range) * 100;
          if (bodyPct < 25 && upperPct > 30 && lowerPct > 30) {
            delta -= 2;
            events.push('Choppy candle');
          }
        }

        // 4. Pullback depth vs yesterday's range
        if (direction === 'BUY') {
          const retrace = (runHigh - h1.low) / ydRange;
          if (retrace > 0.7) { delta -= 3; events.push('Deep pullback'); }
        } else {
          const retrace = (h1.high - runLow) / ydRange;
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
      if (state === 'STOPPED') currentLabel = 'Monitoring Stopped';
      else if (currentScore >= 85) currentLabel = 'Strong Continuation';
      else if (currentScore >= 70) currentLabel = 'Continuation Holding';
      else if (currentScore >= 50) currentLabel = 'Weakening';
      else if (currentScore >= 30) currentLabel = 'Possible Reversal';
      else currentLabel = 'Continuation Failed';

      if (state === 'STOPPED') continue;

      pairs.push({
        pair,
        instrument: inst,
        direction,
        currentScore,
        currentLabel,
        initialScore,
        state,
        triggerTime: trigger.time,
        stoppedTime,
        triggerBreakPips: Math.round(triggerBreakPips * 10) / 10,
        yesterday: {
          open: ydOpen, high: ydHigh, low: ydLow, close: ydClose,
          bodyPct: ydBodyPct, upperWickPct, lowerWickPct,
          rangePips: ydRangePips, bodyPips: ydBodyPips,
          direction: ydDirection,
        },
        timeline,
        h1Count: today.length - triggerIdx,
      });
    }

    // Sort: earliest trigger first; tie-break by trigger break pips (stronger first)
    pairs.sort((a, b) => {
      if (a.triggerTime !== b.triggerTime) return a.triggerTime < b.triggerTime ? -1 : 1;
      return b.triggerBreakPips - a.triggerBreakPips;
    });

    res.json({
      dayStart: dayStart.toISOString(),
      prevDayStart: prevDayStart.toISOString(),
      pairs,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
