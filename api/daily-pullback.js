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

function forexDayBoundaries(count) {
  const now = new Date();
  const h = now.getUTCHours();
  let current;
  if (h >= 21) {
    current = new Date(now); current.setUTCHours(21, 0, 0, 0);
  } else {
    current = new Date(now); current.setUTCDate(current.getUTCDate() - 1); current.setUTCHours(21, 0, 0, 0);
  }
  // Skip weekends for current day
  const dsDay = current.getUTCDay();
  if (dsDay === 5) current.setUTCDate(current.getUTCDate() - 1);
  else if (dsDay === 6) current.setUTCDate(current.getUTCDate() - 2);

  const days = [current];
  for (let i = 1; i < count; i++) {
    let prev = new Date(days[days.length - 1].getTime() - 24 * 3600000);
    const pd = prev.getUTCDay();
    if (pd === 6) prev.setUTCDate(prev.getUTCDate() - 2);
    else if (pd === 5) prev.setUTCDate(prev.getUTCDate() - 1);
    days.push(prev);
  }
  return days.reverse();
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    // Get last 6 forex day boundaries (to build 5 complete daily candles + today partial)
    const dayBoundaries = forexDayBoundaries(7);
    const fetchSince = dayBoundaries[0].toISOString();
    const fetchUntil = new Date().toISOString();

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

    const pairs = [];

    for (const inst of VALID_PAIRS) {
      const allCandles = candleCache[inst] || [];
      if (allCandles.length < 10) continue;

      const pd = pipDiv(inst);
      const pair = inst.replace('_', '/');

      // Build synthetic daily candles from H1s for each forex day
      const dailyCandles = [];
      for (let d = 0; d < dayBoundaries.length - 1; d++) {
        const start = dayBoundaries[d].toISOString();
        const end = dayBoundaries[d + 1].toISOString();
        const h1s = allCandles.filter(c => c.time >= start && c.time < end);
        if (h1s.length < 3) continue;

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
        const bull = close > open;

        dailyCandles.push({
          date: dayBoundaries[d].toISOString().slice(0, 10),
          dayStart: start,
          open, high, low, close,
          bull,
          body,
          range,
          bodyPct: Math.round((body / range) * 100),
          rangePips: Math.round((range / pd) * 10) / 10,
          bodyPips: Math.round((body / pd) * 10) / 10,
          h1Count: h1s.length,
        });
      }

      // Also build today's partial candle
      if (dayBoundaries.length > 0) {
        const todayStart = dayBoundaries[dayBoundaries.length - 1].toISOString();
        const todayH1s = allCandles.filter(c => c.time >= todayStart);
        if (todayH1s.length >= 1) {
          const open = todayH1s[0].open;
          const close = todayH1s[todayH1s.length - 1].close;
          let high = -Infinity, low = Infinity;
          for (const c of todayH1s) {
            if (c.high > high) high = c.high;
            if (c.low < low) low = c.low;
          }
          const range = high - low;
          if (range >= pd) {
            const body = Math.abs(close - open);
            dailyCandles.push({
              date: 'today',
              dayStart: todayStart,
              open, high, low, close,
              bull: close > open,
              body,
              range,
              bodyPct: Math.round((body / range) * 100),
              rangePips: Math.round((range / pd) * 10) / 10,
              bodyPips: Math.round((body / pd) * 10) / 10,
              h1Count: todayH1s.length,
              partial: true,
            });
          }
        }
      }

      if (dailyCandles.length < 3) continue;

      // Pattern detection: impulse → pullback (1-2 candles) → continuation
      // Scan from end backwards for the pattern
      let pattern = null;

      for (let i = dailyCandles.length - 1; i >= 2; i--) {
        // Try: impulse at i-2 or i-3, pullback at i-1 (or i-2 and i-1), continuation at i
        // Pattern A: impulse(i-2), pullback(i-1), continuation(i)
        if (i >= 2) {
          const impulse = dailyCandles[i - 2];
          const pullback = dailyCandles[i - 1];
          const cont = dailyCandles[i];
          const dir = impulse.bull ? 'BUY' : 'SELL';

          // Impulse must be strong
          if (impulse.bodyPct < 40) continue;

          // Pullback must be counter-trend and smaller
          const pbCounterTrend = impulse.bull ? !pullback.bull : pullback.bull;
          const pbSmall = pullback.body < impulse.body * 0.6;

          if (pbCounterTrend && pbSmall) {
            // Check pullback stays within impulse range
            let pbContained = true;
            if (impulse.bull) {
              if (pullback.low < impulse.open) pbContained = false;
            } else {
              if (pullback.high > impulse.open) pbContained = false;
            }

            // Continuation candle direction matches impulse
            const contAligned = impulse.bull ? cont.bull : !cont.bull;

            // Score the pattern
            let score = 40;
            // Impulse strength
            if (impulse.bodyPct >= 75) score += 15;
            else if (impulse.bodyPct >= 60) score += 10;
            else score += 5;

            // Pullback quality
            if (pbContained) score += 15;
            if (pullback.bodyPct <= 30) score += 10;
            else if (pullback.bodyPct <= 50) score += 5;

            // Pullback depth relative to impulse
            const pbDepth = impulse.bull
              ? (impulse.close - pullback.low) / impulse.range
              : (pullback.high - impulse.close) / impulse.range;
            if (pbDepth <= 0.38) score += 10;
            else if (pbDepth <= 0.50) score += 5;
            else if (pbDepth > 0.70) score -= 10;

            // Continuation
            let phase = 'PULLBACK';
            if (contAligned) {
              phase = 'CONTINUATION';
              score += 10;
              if (cont.bodyPct >= 50) score += 5;
              // Continuation breaks beyond impulse close
              if (impulse.bull && cont.close > impulse.close) score += 5;
              else if (!impulse.bull && cont.close < impulse.close) score += 5;
            } else {
              score -= 5;
            }

            score = Math.max(0, Math.min(100, score));

            if (score >= 30) {
              pattern = {
                direction: dir,
                phase,
                score,
                pbDepthPct: Math.round(pbDepth * 100),
                pbContained,
                pullbackCount: 1,
                candles: [impulse, pullback, cont],
                impulseIdx: 0,
                pullbackIdx: [1],
                contIdx: 2,
              };
              break;
            }
          }
        }

        // Pattern B: impulse(i-3), pullback(i-2, i-1), continuation(i)
        if (i >= 3) {
          const impulse = dailyCandles[i - 3];
          const pb1 = dailyCandles[i - 2];
          const pb2 = dailyCandles[i - 1];
          const cont = dailyCandles[i];
          const dir = impulse.bull ? 'BUY' : 'SELL';

          if (impulse.bodyPct < 40) continue;

          const pb1Counter = impulse.bull ? !pb1.bull : pb1.bull;
          const pb2Counter = impulse.bull ? !pb2.bull : pb2.bull;
          const pb1Small = pb1.body < impulse.body * 0.6;
          const pb2Small = pb2.body < impulse.body * 0.6;

          if ((pb1Counter || pb1Small) && (pb2Counter || pb2Small) && (pb1Counter || pb2Counter)) {
            let pbContained = true;
            if (impulse.bull) {
              if (Math.min(pb1.low, pb2.low) < impulse.open) pbContained = false;
            } else {
              if (Math.max(pb1.high, pb2.high) > impulse.open) pbContained = false;
            }

            const contAligned = impulse.bull ? cont.bull : !cont.bull;

            let score = 40;
            if (impulse.bodyPct >= 75) score += 15;
            else if (impulse.bodyPct >= 60) score += 10;
            else score += 5;

            if (pbContained) score += 15;
            if (Math.max(pb1.bodyPct, pb2.bodyPct) <= 30) score += 10;
            else if (Math.max(pb1.bodyPct, pb2.bodyPct) <= 50) score += 5;

            const pbLow = impulse.bull
              ? Math.min(pb1.low, pb2.low) : Math.max(pb1.high, pb2.high);
            const pbDepth = impulse.bull
              ? (impulse.close - pbLow) / impulse.range
              : (pbLow - impulse.close) / impulse.range;
            if (pbDepth <= 0.38) score += 10;
            else if (pbDepth <= 0.50) score += 5;
            else if (pbDepth > 0.70) score -= 10;

            let phase = 'PULLBACK';
            if (contAligned) {
              phase = 'CONTINUATION';
              score += 10;
              if (cont.bodyPct >= 50) score += 5;
              if (impulse.bull && cont.close > impulse.close) score += 5;
              else if (!impulse.bull && cont.close < impulse.close) score += 5;
            } else {
              score -= 5;
            }

            score = Math.max(0, Math.min(100, score));

            if (score >= 30 && (!pattern || score > pattern.score)) {
              pattern = {
                direction: dir,
                phase,
                score,
                pbDepthPct: Math.round(pbDepth * 100),
                pbContained,
                pullbackCount: 2,
                candles: [impulse, pb1, pb2, cont],
                impulseIdx: 0,
                pullbackIdx: [1, 2],
                contIdx: 3,
              };
              break;
            }
          }
        }
      }

      if (!pattern) continue;

      let label;
      if (pattern.score >= 80) label = 'Strong Setup';
      else if (pattern.score >= 65) label = 'Good Setup';
      else if (pattern.score >= 50) label = 'Forming';
      else label = 'Weak';

      pairs.push({
        pair,
        instrument: inst,
        direction: pattern.direction,
        phase: pattern.phase,
        score: pattern.score,
        label,
        pullbackCount: pattern.pullbackCount,
        pbDepthPct: pattern.pbDepthPct,
        pbContained: pattern.pbContained,
        candles: pattern.candles,
        impulseIdx: pattern.impulseIdx,
        pullbackIdx: pattern.pullbackIdx,
        contIdx: pattern.contIdx,
      });
    }

    pairs.sort((a, b) => b.score - a.score);

    res.json({ pairs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
