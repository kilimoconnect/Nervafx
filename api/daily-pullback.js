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

function prevForexDay(d) {
  const prev = new Date(d.getTime() - 24 * 3600000);
  const pd = prev.getUTCDay();
  if (pd === 6) prev.setUTCDate(prev.getUTCDate() - 2);
  else if (pd === 5) prev.setUTCDate(prev.getUTCDate() - 1);
  return prev;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    // Determine "today" forex day (21:00 UTC to 21:00 UTC), same as daily-continuation
    const now = new Date();
    const todayDate = req.query?.date;
    let dayStart;

    if (todayDate) {
      const picked = new Date(todayDate + 'T00:00:00Z');
      picked.setUTCDate(picked.getUTCDate() - 1);
      dayStart = new Date(picked);
      dayStart.setUTCHours(21, 0, 0, 0);
    } else {
      const h = now.getUTCHours();
      const base = new Date(now);
      base.setUTCMinutes(0, 0, 0);
      if (h >= 21) {
        dayStart = new Date(base); dayStart.setUTCHours(21);
      } else {
        dayStart = new Date(base); dayStart.setUTCDate(dayStart.getUTCDate() - 1); dayStart.setUTCHours(21);
      }
      const dsDay = dayStart.getUTCDay();
      if (dsDay === 5) dayStart.setUTCDate(dayStart.getUTCDate() - 1);
      else if (dsDay === 6) dayStart.setUTCDate(dayStart.getUTCDate() - 2);
    }

    // Previous 4 completed forex days (enough for impulse + up to 2 pullbacks + spare)
    const boundaries = [dayStart];
    for (let i = 0; i < 4; i++) boundaries.unshift(prevForexDay(boundaries[0]));
    // boundaries = [d-4, d-3, d-2, d-1, dayStart]

    const dayEnd = new Date(dayStart.getTime() + 24 * 3600000);
    const fetchSince = boundaries[0].toISOString();
    const fetchUntil = todayDate ? dayEnd.toISOString() : (now < dayEnd ? now : dayEnd).toISOString();

    // Fetch H1 candles for all pairs
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

    // Fetch M15 candles for today (15-minute live updates)
    const m15Cache = {};
    const m15Since = dayStart.toISOString();
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
            .gte('time', m15Since).lte('time', fetchUntil)
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

    const dayStartISO = dayStart.toISOString();
    const pairs = [];

    for (const inst of VALID_PAIRS) {
      const allCandles = candleCache[inst] || [];
      if (allCandles.length < 10) continue;

      const pd = pipDiv(inst);
      const pair = inst.replace('_', '/');

      // Build synthetic daily candles for the 4 completed days before today
      const dailyCandles = [];
      for (let d = 0; d < boundaries.length - 1; d++) {
        const start = boundaries[d].toISOString();
        const end = boundaries[d + 1].toISOString();
        const h1s = allCandles.filter(c => c.time >= start && c.time < end);
        if (h1s.length < 5) continue;

        const open = h1s[0].open;
        const close = h1s[h1s.length - 1].close;
        let high = -Infinity, low = Infinity;
        for (const c of h1s) {
          if (c.high > high) high = c.high;
          if (c.low < low) low = c.low;
        }
        const range = high - low;
        if (range < pd) continue;
        const body = Math.abs(close - open);

        dailyCandles.push({
          dayStart: start,
          open, high, low, close,
          bull: close > open,
          body,
          range,
          bodyPct: Math.round((body / range) * 100),
          rangePips: Math.round((range / pd) * 10) / 10,
          bodyPips: Math.round((body / pd) * 10) / 10,
          lastH1: h1s[h1s.length - 1],
        });
      }

      if (dailyCandles.length < 2) continue;

      // Detect pullback pattern ENDING YESTERDAY:
      // strong impulse day, then 1-2 counter-trend pullback candles, last pullback = yesterday.
      // Today is the expected continuation day (tracked live below).
      const n = dailyCandles.length;
      let pattern = null;

      // Pattern B: impulse at n-3, pullbacks at n-2 and n-1
      if (n >= 3) {
        const impulse = dailyCandles[n - 3];
        const pb1 = dailyCandles[n - 2];
        const pb2 = dailyCandles[n - 1];

        if (impulse.bodyPct >= 40) {
          const pb1Counter = impulse.bull ? !pb1.bull : pb1.bull;
          const pb2Counter = impulse.bull ? !pb2.bull : pb2.bull;
          const pb1Small = pb1.body < impulse.body * 0.6;
          const pb2Small = pb2.body < impulse.body * 0.6;

          if ((pb1Counter || pb1Small) && (pb2Counter || pb2Small) && (pb1Counter || pb2Counter)) {
            pattern = { impulse, pullbacks: [pb1, pb2] };
          }
        }
      }

      // Pattern A: impulse at n-2, pullback at n-1 (preferred if both match — fresher impulse)
      if (n >= 2) {
        const impulse = dailyCandles[n - 2];
        const pb = dailyCandles[n - 1];

        if (impulse.bodyPct >= 40) {
          const pbCounter = impulse.bull ? !pb.bull : pb.bull;
          const pbSmall = pb.body < impulse.body * 0.6;
          if (pbCounter && pbSmall) {
            pattern = { impulse, pullbacks: [pb] };
          }
        }
      }

      if (!pattern) continue;

      const { impulse, pullbacks } = pattern;
      const direction = impulse.bull ? 'BUY' : 'SELL';

      // Pullback stats
      let pbContained = true;
      let pbExtreme; // deepest point of the pullback
      if (impulse.bull) {
        pbExtreme = Math.min(...pullbacks.map(p => p.low));
        if (pbExtreme < impulse.open) pbContained = false;
      } else {
        pbExtreme = Math.max(...pullbacks.map(p => p.high));
        if (pbExtreme > impulse.open) pbContained = false;
      }
      const pbDepth = impulse.bull
        ? (impulse.close - pbExtreme) / impulse.range
        : (pbExtreme - impulse.close) / impulse.range;
      const pbDepthPct = Math.round(pbDepth * 100);
      const maxPbBodyPct = Math.max(...pullbacks.map(p => p.bodyPct));

      // Phase 1: initial score from pattern quality
      let score = 50;

      // Impulse strength
      if (impulse.bodyPct >= 75) score += 15;
      else if (impulse.bodyPct >= 60) score += 10;
      else score += 5;

      // Pullback containment
      if (pbContained) score += 10;
      else score -= 5;

      // Pullback candles small
      if (maxPbBodyPct <= 30) score += 8;
      else if (maxPbBodyPct <= 50) score += 4;

      // Pullback depth (shallow = healthy)
      if (pbDepth <= 0.38) score += 8;
      else if (pbDepth <= 0.5) score += 4;
      else if (pbDepth > 0.7) score -= 10;

      // Impulse range strength
      if (impulse.rangePips > 100) score += 4;
      else if (impulse.rangePips > 60) score += 2;

      score = Math.max(20, Math.min(98, score));
      const initialScore = score;

      // Phase 2: today's M15 updates (same engine as daily-continuation, 15-minute cadence)
      const today = m15Cache[inst] || [];

      const timeline = [{
        time: dayStartISO,
        score,
        label: 'Daily Open',
        event: (direction === 'BUY' ? 'Bullish' : 'Bearish') + ' pullback setup (' + pullbacks.length + ' PB candle' + (pullbacks.length > 1 ? 's' : '') + ')',
      }];

      // Reference range for retrace checks = impulse range
      const refRange = impulse.range;
      let runHigh = direction === 'BUY' ? Math.max(impulse.high, ...pullbacks.map(p => p.high)) : impulse.high;
      let runLow = direction === 'SELL' ? Math.min(impulse.low, ...pullbacks.map(p => p.low)) : impulse.low;
      let prevH1 = pullbacks[pullbacks.length - 1].lastH1;

      for (let i = 0; i < today.length; i++) {
        const h1 = today[i];
        const h1Bull = h1.close > h1.open;
        const h1Body = Math.abs(h1.close - h1.open);
        const h1BodyPips = Math.round((h1Body / pd) * 10) / 10;
        let delta = 0;
        const events = [];

        // 1. New high/low in continuation direction
        if (direction === 'BUY') {
          if (h1.high > runHigh) {
            delta += 3;
            events.push('New high');
            runHigh = h1.high;
          } else if (h1.high < prevH1.high && h1.low < prevH1.low) {
            delta -= 4;
            events.push('Lower high + lower low');
          } else if (h1.high < prevH1.high) {
            delta -= 2;
            events.push('Lower high');
          }
        } else {
          if (h1.low < runLow) {
            delta += 3;
            events.push('New low');
            runLow = h1.low;
          } else if (h1.low > prevH1.low && h1.high > prevH1.high) {
            delta -= 4;
            events.push('Higher low + higher high');
          } else if (h1.low > prevH1.low) {
            delta -= 2;
            events.push('Higher low');
          }
        }

        // 2. H1 close beyond previous H1 high/low
        if (direction === 'BUY' && h1.close > prevH1.high) {
          delta += 4;
          events.push('Close above prev H1 high');
        } else if (direction === 'SELL' && h1.close < prevH1.low) {
          delta += 4;
          events.push('Close below prev H1 low');
        } else if (direction === 'BUY' && h1.close < prevH1.low) {
          delta -= 6;
          events.push('Close below prev H1 low');
        } else if (direction === 'SELL' && h1.close > prevH1.high) {
          delta -= 6;
          events.push('Close above prev H1 high');
        }

        // 3. Body strength
        if (direction === 'BUY') {
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

        // 4. Pullback getting too deep — invalidation zone
        if (direction === 'BUY') {
          const retrace = (runHigh - h1.low) / refRange;
          if (retrace > 0.7) { delta -= 3; events.push('Deep pullback'); }
          if (h1.close < impulse.open) { delta -= 6; events.push('Below impulse open'); }
        } else {
          const retrace = (h1.high - runLow) / refRange;
          if (retrace > 0.7) { delta -= 3; events.push('Deep pullback'); }
          if (h1.close > impulse.open) { delta -= 6; events.push('Above impulse open'); }
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

      // Today's building daily candle (partial, from H1s so far)
      let todayCandle = null;
      if (today.length >= 1) {
        const tOpen = today[0].open;
        const tClose = today[today.length - 1].close;
        let tHigh = -Infinity, tLow = Infinity;
        for (const c of today) {
          if (c.high > tHigh) tHigh = c.high;
          if (c.low < tLow) tLow = c.low;
        }
        const tRange = tHigh - tLow;
        if (tRange >= pd) {
          const tBody = Math.abs(tClose - tOpen);
          todayCandle = {
            open: tOpen, high: tHigh, low: tLow, close: tClose,
            bull: tClose > tOpen,
            bodyPct: Math.round((tBody / tRange) * 100),
            rangePips: Math.round((tRange / pd) * 10) / 10,
            bodyPips: Math.round((tBody / pd) * 10) / 10,
            partial: true,
          };
        }
      }

      pairs.push({
        pair,
        instrument: inst,
        direction,
        currentScore,
        currentLabel,
        initialScore,
        impulse: {
          open: impulse.open, high: impulse.high, low: impulse.low, close: impulse.close,
          bull: impulse.bull, bodyPct: impulse.bodyPct,
          rangePips: impulse.rangePips, bodyPips: impulse.bodyPips,
        },
        pullbacks: pullbacks.map(p => ({
          open: p.open, high: p.high, low: p.low, close: p.close,
          bull: p.bull, bodyPct: p.bodyPct,
          rangePips: p.rangePips, bodyPips: p.bodyPips,
        })),
        pullbackCount: pullbacks.length,
        pbDepthPct,
        pbContained,
        today: todayCandle,
        timeline,
        h1Count: today.length,
      });
    }

    // Sort: highest score first
    pairs.sort((a, b) => b.currentScore - a.currentScore);

    res.json({
      dayStart: dayStart.toISOString(),
      pairs,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
