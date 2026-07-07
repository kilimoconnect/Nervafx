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

const H4_MS = 4 * 3600000;

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const now = new Date();

    // Optional historical mode: ?date=YYYY-MM-DD&hour=HH selects a specific H4 window to replay.
    // Hour is floored to the nearest H4 boundary (00, 04, 08, 12, 16, 20).
    const qDate = req.query?.date;
    const qHour = req.query?.hour;
    let anchor = null;
    if (qDate && qHour !== undefined && qHour !== '') {
      const hh = parseInt(qHour, 10);
      const parsed = new Date(qDate + 'T00:00:00Z');
      if (!isNaN(parsed.getTime())) {
        parsed.setUTCHours(Math.floor(hh / 4) * 4, 0, 0, 0);
        anchor = parsed;
      }
    }

    // Reference H4 must be strictly before the anchor window (or before now in live mode)
    const refCutoff = anchor ? anchor.toISOString() : now.toISOString();
    const anchorMs = anchor ? anchor.getTime() : now.getTime();
    // Fetch enough history to survive weekends: last complete H4 + tracked window H1s
    const fetchSince = new Date(anchorMs - 6 * 24 * 3600000).toISOString();
    const fetchUntil = anchor ? new Date(anchorMs + H4_MS).toISOString() : now.toISOString();

    const PAGE = 1000;
    const h1Cache = {};
    const h4Cache = {};

    // Single H1 fetch covers both H4-bucket synthesis and the H1 tracking inside the window
    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const { data, error } = await sb
          .from('backtest_candles')
          .select('time, open, high, low, close')
          .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true)
          .gte('time', fetchSince).lte('time', fetchUntil)
          .order('time', { ascending: true })
          .limit(PAGE);
        return { inst, data: error ? [] : data || [] };
      }));
      for (const { inst, data } of results) {
        const parsed = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
        h1Cache[inst] = parsed;

        // Build H4 buckets aligned to 00/04/08/12/16/20 UTC from the H1s dated before refCutoff
        const buckets = new Map();
        const cutoffMs = new Date(refCutoff).getTime();
        for (const c of parsed) {
          if (new Date(c.time).getTime() >= cutoffMs) continue;
          const t = new Date(c.time);
          const bucketMs = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(),
            Math.floor(t.getUTCHours() / 4) * 4, 0, 0, 0);
          const key = new Date(bucketMs).toISOString();
          let bkt = buckets.get(key);
          if (!bkt) {
            bkt = { time: key, open: null, high: -Infinity, low: Infinity, close: null, count: 0, firstMs: bucketMs };
            buckets.set(key, bkt);
          }
          if (bkt.open === null) bkt.open = c.open;
          if (c.high > bkt.high) bkt.high = c.high;
          if (c.low < bkt.low) bkt.low = c.low;
          bkt.close = c.close;
          bkt.count++;
        }
        const complete = Array.from(buckets.values())
          .filter(bk => bk.count === 4 && (bk.firstMs + H4_MS) <= cutoffMs)
          .sort((a, b) => a.firstMs - b.firstMs);
        h4Cache[inst] = complete.slice(-3).map(bk => ({
          time: bk.time, open: bk.open, high: bk.high, low: bk.low, close: bk.close,
        }));
      }
    }

    const pairs = [];

    for (const inst of VALID_PAIRS) {
      const h4s = h4Cache[inst] || [];
      if (!h4s.length) continue;

      const pd = pipDiv(inst);
      const pair = inst.replace('_', '/');

      // Reference candle = last complete H4 before the tracked window
      const ref = h4s[h4s.length - 1];
      const refStart = ref.time;
      const trackStart = anchor
        ? anchor.toISOString()
        : new Date(new Date(refStart).getTime() + H4_MS).toISOString();

      const refRange = ref.high - ref.low;
      if (refRange < pd) continue;

      const refBody = Math.abs(ref.close - ref.open);
      const refBull = ref.close > ref.open;
      const refDirection = refBull ? 'BUY' : 'SELL';
      const refBodyPct = Math.round((refBody / refRange) * 100);
      const upperWick = refBull ? ref.high - ref.close : ref.high - ref.open;
      const lowerWick = refBull ? ref.open - ref.low : ref.close - ref.low;
      const upperWickPct = Math.round((upperWick / refRange) * 100);
      const lowerWickPct = Math.round((lowerWick / refRange) * 100);
      const refRangePips = Math.round((refRange / pd) * 10) / 10;
      const refBodyPips = Math.round((refBody / pd) * 10) / 10;

      // Phase 1: Initial continuation score from the reference H4 candle
      let score = 50;

      if (refBodyPct >= 80) score += 25;
      else if (refBodyPct >= 65) score += 20;
      else if (refBodyPct >= 50) score += 15;
      else if (refBodyPct >= 35) score += 8;

      const rejectionWick = refBull ? upperWickPct : lowerWickPct;
      if (rejectionWick <= 5) score += 10;
      else if (rejectionWick <= 15) score += 5;
      else if (rejectionWick >= 30) score -= 5;

      if (refRangePips > 60) score += 5;
      else if (refRangePips > 35) score += 3;

      score = Math.max(20, Math.min(98, score));
      const initialScore = score;

      // Phase 2: H1 updates within the current H4 window
      const h1all = h1Cache[inst] || [];
      const refWindowH1s = h1all.filter(c => c.time >= refStart && c.time < trackStart);
      const today = h1all.filter(c => c.time >= trackStart);

      const timeline = [{
        time: trackStart,
        score,
        label: 'Window Open',
        event: refDirection === 'BUY' ? 'Bullish Expansion' : 'Bearish Expansion',
      }];

      let runHigh = refBull ? ref.close : ref.high;
      let runLow = refBull ? ref.low : ref.close;
      let prevH1 = refWindowH1s.length ? refWindowH1s[refWindowH1s.length - 1] : ref;

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

        // 2. H1 close beyond previous H1 high/low
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

        // 4. Pullback depth — retraced too far against the reference candle
        if (refDirection === 'BUY') {
          const retrace = (runHigh - h1.low) / refRange;
          if (retrace > 0.7) { delta -= 3; events.push('Deep pullback'); }
        } else {
          const retrace = (h1.high - runLow) / refRange;
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
        refHour: {
          time: refStart,
          open: ref.open, high: ref.high, low: ref.low, close: ref.close,
          bodyPct: refBodyPct, upperWickPct, lowerWickPct,
          rangePips: refRangePips, bodyPips: refBodyPips,
          direction: refDirection,
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
