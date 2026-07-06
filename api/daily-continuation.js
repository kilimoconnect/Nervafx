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
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

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
    const fetchSince = prevDayStart.toISOString();
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

      // Split into yesterday and today candles
      const dayStartISO = dayStart.toISOString();
      const yesterday = candles.filter(c => c.time >= prevDayStart.toISOString() && c.time < dayStartISO);
      const today = candles.filter(c => c.time >= dayStartISO);

      if (yesterday.length < 5) continue;

      // Build yesterday's synthetic daily candle
      const ydOpen = yesterday[0].open;
      const ydClose = yesterday[yesterday.length - 1].close;
      let ydHigh = -Infinity, ydLow = Infinity;
      for (const c of yesterday) {
        if (c.high > ydHigh) ydHigh = c.high;
        if (c.low < ydLow) ydLow = c.low;
      }
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

      // Phase 1: Initial continuation score from yesterday's candle
      let score = 50;

      // Body dominance
      if (ydBodyPct >= 80) score += 25;
      else if (ydBodyPct >= 65) score += 20;
      else if (ydBodyPct >= 50) score += 15;
      else if (ydBodyPct >= 35) score += 8;
      else score += 0;

      // Clean close (small rejection wick)
      const rejectionWick = ydBull ? upperWickPct : lowerWickPct;
      if (rejectionWick <= 5) score += 10;
      else if (rejectionWick <= 15) score += 5;
      else if (rejectionWick >= 30) score -= 5;

      // Range strength
      if (ydRangePips > 100) score += 5;
      else if (ydRangePips > 60) score += 3;

      score = Math.max(20, Math.min(98, score));
      const initialScore = score;

      // Phase 2: H1 updates
      const timeline = [{
        time: dayStartISO,
        score,
        label: 'Daily Open',
        event: ydDirection === 'BUY' ? 'Bullish Expansion' : 'Bearish Expansion',
      }];

      let runHigh = ydBull ? ydClose : ydHigh;
      let runLow = ydBull ? ydLow : ydClose;
      let prevH1 = yesterday[yesterday.length - 1];

      for (let i = 0; i < today.length; i++) {
        const h1 = today[i];
        const h1Bull = h1.close > h1.open;
        const h1Body = Math.abs(h1.close - h1.open);
        const h1BodyPips = Math.round((h1Body / pd) * 10) / 10;
        const h1Range = h1.high - h1.low;
        let delta = 0;
        const events = [];

        // Closing break of structure in the continuation direction
        const brokeFor = ydDirection === 'BUY' ? h1.close > prevH1.high : h1.close < prevH1.low;

        // 1. New high/low — only rewarded when the candle also closes through structure
        if (ydDirection === 'BUY') {
          if (h1.high > runHigh) {
            runHigh = h1.high;
            if (brokeFor) {
              delta += 3;
              events.push('New high');
            } else {
              events.push('New high (wick only)');
            }
          } else if (h1.high < prevH1.high && h1.low < prevH1.low) {
            delta -= 4;
            events.push('Lower high + lower low');
          } else if (h1.high < prevH1.high) {
            delta -= 2;
            events.push('Lower high');
          }
        } else {
          if (h1.low < runLow) {
            runLow = h1.low;
            if (brokeFor) {
              delta += 3;
              events.push('New low');
            } else {
              events.push('New low (wick only)');
            }
          } else if (h1.low > prevH1.low && h1.high > prevH1.high) {
            delta -= 4;
            events.push('Higher low + higher high');
          } else if (h1.low > prevH1.low) {
            delta -= 2;
            events.push('Higher low');
          }
        }

        // 2. H1 close beyond previous H1 high/low
        if (ydDirection === 'BUY' && h1.close > prevH1.high) {
          delta += 4;
          events.push('Close above prev H1 high');
        } else if (ydDirection === 'SELL' && h1.close < prevH1.low) {
          delta += 4;
          events.push('Close below prev H1 low');
        } else if (ydDirection === 'BUY' && h1.close < prevH1.low) {
          delta -= 6;
          events.push('Close below prev H1 low');
        } else if (ydDirection === 'SELL' && h1.close > prevH1.high) {
          delta -= 6;
          events.push('Close above prev H1 high');
        } else {
          // No break of structure in the continuation direction — penalize
          delta -= 2;
          events.push('No break of structure');
        }

        // 3. Body strength
        if (ydDirection === 'BUY') {
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

        // 4. Pullback depth — check if price has retraced too far
        if (ydDirection === 'BUY') {
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
      if (currentScore >= 85) currentLabel = 'Strong Continuation';
      else if (currentScore >= 70) currentLabel = 'Continuation Holding';
      else if (currentScore >= 50) currentLabel = 'Weakening';
      else if (currentScore >= 30) currentLabel = 'Possible Reversal';
      else currentLabel = 'Continuation Failed';

      pairs.push({
        pair,
        instrument: inst,
        direction: ydDirection,
        currentScore,
        currentLabel,
        initialScore,
        yesterday: {
          open: ydOpen, high: ydHigh, low: ydLow, close: ydClose,
          bodyPct: ydBodyPct, upperWickPct, lowerWickPct,
          rangePips: ydRangePips, bodyPips: ydBodyPips,
          direction: ydDirection,
        },
        timeline,
        h1Count: today.length,
      });
    }

    // Sort: highest score first
    pairs.sort((a, b) => b.currentScore - a.currentScore);

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
