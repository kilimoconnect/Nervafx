'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');
const { loadStrength, strengthGate } = require('./_strength-gate');
const { loadSharpReversalTriggers } = require('./_sharp-reversal-trigger');

const VALID_PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];

function isJpy(inst) { return inst.includes('JPY'); }
function pipDiv(inst) { return isJpy(inst) ? 0.01 : 0.0001; }

// Candles are stamped with their OPEN time, but a break is only confirmed when
// the candle closes. This engine triggers on H1, so the signal fires an hour
// after the trigger candle's timestamp.
const TRIGGER_TF_MS = 60 * 60 * 1000;
const closeTimeOf = iso => iso ? new Date(new Date(iso).getTime() + TRIGGER_TF_MS).toISOString() : null;

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
    const dayStartMs = dayStart.getTime();

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

    // Widen by 5 extra days so we always have ≥ 51 complete H1 candles for
    // the EMA50 that gates the trigger.
    const fetchSince = new Date(prev3DayStart.getTime() - 5 * 24 * 3600000).toISOString();
    const fetchUntil = todayDate ? dayEnd.toISOString() : (now < dayEnd ? now : dayEnd).toISOString();

    // The one trigger for this engine — the Sharp Reversal engine (Standard or
    // Scalp, earliest cross) evaluated at the page's as-of time (fetchUntil).
    const srTriggers = await loadSharpReversalTriggers(sb, fetchUntil);

    // Hourly 3H/6H/12H strength, keyed hour -> currency.
    const strengthByHour = await loadStrength(sb, fetchSince, fetchUntil);

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

      // One trigger, from the Sharp Reversal engine (Standard or Scalp,
      // whichever fired first). Direction comes from that signal — the old
      // daily-break confirmation, EMA gate and strength gate are gone.
      const srTrig = srTriggers[inst];
      if (!srTrig) continue;
      let triggerMs = new Date(srTrig.triggerTime).getTime();
      if (isNaN(triggerMs)) continue;
      if (triggerMs < dayStartMs) triggerMs = dayStartMs;   // cross predates the day → monitor from day start
      const direction = srTrig.direction;
      const refBreakPips = 0;

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

      // Anchor monitoring to the H1 candle that was live when the Sharp Reversal
      // fired; monitoring then scores every following H1 exactly as before.
      if (!today.length) continue;
      let triggerIdx = -1;
      for (let i = 0; i < today.length; i++) {
        if (new Date(today[i].time).getTime() <= triggerMs) triggerIdx = i; else break;
      }
      if (triggerIdx === -1) triggerIdx = 0;   // fired before the first H1 of the day
      const trigger = today[triggerIdx];
      const triggerBreakPips = 0;

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
        closeTime: closeTimeOf(trigger.time),
        score,
        label: 'Trigger 1',
        event: 'Sharp Reversal trigger — ' + direction + (srTrig.mode ? ' (' + (srTrig.mode === 'swing' ? 'Scalp' : 'Standard') + ')' : ''),
        qualified: true,
        h1: {
          open: trigger.open, high: trigger.high, low: trigger.low, close: trigger.close,
          bull: triggerBull,
          bodyPips: Math.round((Math.abs(trigger.close - trigger.open) / pd) * 10) / 10,
        },
      }];

      // Break candle counts as Trigger 1; the setup qualifies once a monitoring
      // candle posts delta >= +6 and score > 75 to become Trigger 2.
      let firstTriggerTime = trigger.time;
      let qualifiedTime = null;

      let runHigh = direction === 'BUY' ? trigger.high : trigger.high;
      let runLow = direction === 'SELL' ? trigger.low : trigger.low;
      let prevH1 = trigger;
      let state = 'MONITORING';
      let stoppedTime = null;

      for (let i = triggerIdx + 1; i < today.length; i++) {
        const h1 = today[i];

        // Closing back inside the reference range used to end monitoring
        // outright. It now scores as the heaviest single penalty and tracking
        // continues, so a pair that dips back in and then breaks out again
        // stays visible instead of being dropped at the first pullback.
        const backInside = h1.close < ydHigh && h1.close > ydLow;

        const h1Bull = h1.close > h1.open;
        const h1Body = Math.abs(h1.close - h1.open);
        const h1BodyPips = Math.round((h1Body / pd) * 10) / 10;
        const h1Range = h1.high - h1.low;
        let delta = 0;
        const events = [];

        // Bigger than any other single event, since this was previously fatal.
        if (backInside) { delta -= 8; events.push('Back inside prev daily range'); }

        // Strength gate, scored rather than fatal here: an hour where neither
        // currency holds conviction weakens the case without ending a run that
        // may well reassert itself.
        const cStrength = strengthGate(strengthByHour, inst, direction, new Date(h1.time).getTime(), TRIGGER_TF_MS);
        if (!cStrength.ok) { delta -= 5; events.push('No strength conviction'); }

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

        // Break candle = Trigger 1. Trigger 2 = any monitoring candle that
        // closes beyond the previous candle's high (BUY) / low (SELL) in the
        // trend direction, with running score above 50 — regardless of points.
        let entryLabel = statusLabel;
        let justQualified = false;
        if (qualifiedTime === null && delta >= 4 && brokeFor && score > 50) {
          qualifiedTime = h1.time;
          entryLabel = 'Trigger 2';
          justQualified = true;
        }

        timeline.push({
          time: h1.time,
          // The row's score is only known once the candle closes.
          closeTime: closeTimeOf(h1.time),
          score,
          delta,
          label: entryLabel,
          event: justQualified
            ? 'Delta +' + delta + ' (' + (events.join(', ') || 'No change') + ')'
            : (events.join(', ') || 'No change'),
          qualified: justQualified || undefined,
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
        direction,
        currentScore,
        currentLabel,
        initialScore,
        state,
        breakTime: trigger.time,
        firstTriggerTime,
        // Monitoring begins at the FIRST trigger — the break candle itself.
        // These previously pointed at Trigger 2 (the first monitoring candle
        // to post delta >= +6 with score above 75), so a pair that broke but
        // never got that second confirmation was filtered out of the page
        // entirely. Reaching this point means the break happened, so the pair
        // is tracked from here.
        triggerTime: firstTriggerTime,
        // When the break was actually confirmed — the trigger candle's close.
        triggerCloseTime: closeTimeOf(firstTriggerTime),
        // Trigger came from the Sharp Reversal engine, which mode won the race.
        strength: null,
        srMode: srTrig.mode === 'swing' ? 'Scalp' : srTrig.mode === 'standard' ? 'Standard' : null,
        qualified: true,
        // Trigger 2 kept as an informational milestone, not a gate.
        strongConfirmTime: qualifiedTime,
        stoppedTime,
        triggerBreakPips: Math.round(triggerBreakPips * 10) / 10,
        refBreakPips,
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

    // Sort by trigger time ascending (earliest break first); tie-break by
    // refBreakPips desc then triggerBreakPips desc. Every pair that gets here
    // has triggered, so the qualified/unqualified split the first comparison
    // used to make no longer separates anything.
    // Ranked by second trigger — the pair whose Trigger 2 came first (earliest)
    // leads — then by points (highest live score). Pairs that never reached
    // Trigger 2 fall to the bottom, ordered by score among themselves.
    pairs.sort((a, b) => {
      const as = a.strongConfirmTime;
      const bs = b.strongConfirmTime;
      if (as && !bs) return -1;
      if (!as && bs) return 1;
      if (as && bs && as !== bs) return as < bs ? -1 : 1;
      return b.currentScore - a.currentScore;
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
