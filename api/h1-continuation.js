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

    const now = new Date();

    // Optional historical mode: ?date=YYYY-MM-DD&hour=HH selects a specific hour to replay
    const qDate = req.query?.date;
    const qHour = req.query?.hour;
    let anchor = null;
    if (qDate && qHour !== undefined && qHour !== '') {
      const hh = String(parseInt(qHour, 10)).padStart(2, '0');
      const parsed = new Date(qDate + 'T' + hh + ':00:00Z');
      if (!isNaN(parsed.getTime())) anchor = parsed;
    }

    // Reference H1 must be strictly before the anchor hour (or before now in live mode)
    const refCutoff = anchor ? anchor.toISOString() : now.toISOString();
    const anchorMs = anchor ? anchor.getTime() : now.getTime();
    // Fetch enough history to survive weekends: last complete H1 + tracked hour M5s
    const fetchSince = new Date(anchorMs - 4 * 24 * 3600000).toISOString();
    const fetchUntil = anchor ? new Date(anchorMs + 3600000).toISOString() : now.toISOString();

    const PAGE = 1000;
    const h1Cache = {};
    const m5Cache = {};

    // Fetch last complete H1 candles per pair
    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const { data, error } = await sb
          .from('backtest_candles')
          .select('time, open, high, low, close')
          .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true)
          .gte('time', fetchSince).lt('time', refCutoff)
          .order('time', { ascending: false })
          .limit(3);
        return { inst, data: error ? [] : (data || []).reverse() };
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

    // Fetch M5 candles covering the reference hour + tracked hour
    const m5Since = new Date(anchorMs - 5 * 3600000).toISOString();
    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const { data, error } = await sb
          .from('backtest_candles')
          .select('time, open, high, low, close')
          .eq('instrument', inst).eq('timeframe', 'M5')
          .gte('time', m5Since).lte('time', fetchUntil)
          .order('time', { ascending: true })
          .limit(PAGE);
        return { inst, data: error ? [] : data || [] };
      }));
      for (const { inst, data } of results) {
        m5Cache[inst] = data.map(c => ({
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
      const h1s = h1Cache[inst] || [];
      if (!h1s.length) continue;

      const pd = pipDiv(inst);
      const pair = inst.replace('_', '/');

      // Reference candle = last complete H1 before the tracked hour
      const ref = h1s[h1s.length - 1];
      const refStart = ref.time;
      const trackStart = anchor
        ? anchor.toISOString()
        : new Date(new Date(refStart).getTime() + 3600000).toISOString();

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

      // Phase 1: Initial continuation score from the reference H1 candle
      let score = 50;

      // Body dominance
      if (refBodyPct >= 80) score += 25;
      else if (refBodyPct >= 65) score += 20;
      else if (refBodyPct >= 50) score += 15;
      else if (refBodyPct >= 35) score += 8;
      else score += 0;

      // Clean close (small rejection wick)
      const rejectionWick = refBull ? upperWickPct : lowerWickPct;
      if (rejectionWick <= 5) score += 10;
      else if (rejectionWick <= 15) score += 5;
      else if (rejectionWick >= 30) score -= 5;

      // Range strength (H1 scale)
      if (refRangePips > 25) score += 5;
      else if (refRangePips > 15) score += 3;

      score = Math.max(20, Math.min(98, score));
      const initialScore = score;

      // Phase 2: M5 updates within the current hour
      const m5all = m5Cache[inst] || [];
      const refHourM5s = m5all.filter(c => c.time >= refStart && c.time < trackStart);
      const today = m5all.filter(c => c.time >= trackStart);

      const timeline = [{
        time: trackStart,
        score,
        label: 'Hour Open',
        event: refDirection === 'BUY' ? 'Bullish Expansion' : 'Bearish Expansion',
      }];

      let runHigh = refBull ? ref.close : ref.high;
      let runLow = refBull ? ref.low : ref.close;
      let prevM5 = refHourM5s.length ? refHourM5s[refHourM5s.length - 1] : ref;

      for (let i = 0; i < today.length; i++) {
        const m5 = today[i];
        const m5Bull = m5.close > m5.open;
        const m5Body = Math.abs(m5.close - m5.open);
        const m5BodyPips = Math.round((m5Body / pd) * 10) / 10;
        let delta = 0;
        const events = [];

        // Closing break of structure in the continuation direction
        const brokeFor = refDirection === 'BUY' ? m5.close > prevM5.high : m5.close < prevM5.low;

        // 1. New high/low — only rewarded when the candle also closes through structure
        if (refDirection === 'BUY') {
          if (m5.high > runHigh) {
            runHigh = m5.high;
            if (brokeFor) {
              delta += 3;
              events.push('New high');
            } else {
              events.push('New high (wick only)');
            }
          } else if (m5.high < prevM5.high && m5.low < prevM5.low) {
            delta -= 4;
            events.push('Lower high + lower low');
          } else if (m5.high < prevM5.high) {
            delta -= 2;
            events.push('Lower high');
          }
        } else {
          if (m5.low < runLow) {
            runLow = m5.low;
            if (brokeFor) {
              delta += 3;
              events.push('New low');
            } else {
              events.push('New low (wick only)');
            }
          } else if (m5.low > prevM5.low && m5.high > prevM5.high) {
            delta -= 4;
            events.push('Higher low + higher high');
          } else if (m5.low > prevM5.low) {
            delta -= 2;
            events.push('Higher low');
          }
        }

        // 2. M5 close beyond previous M5 high/low
        if (refDirection === 'BUY' && m5.close > prevM5.high) {
          delta += 4;
          events.push('Close above prev M5 high');
        } else if (refDirection === 'SELL' && m5.close < prevM5.low) {
          delta += 4;
          events.push('Close below prev M5 low');
        } else if (refDirection === 'BUY' && m5.close < prevM5.low) {
          delta -= 6;
          events.push('Close below prev M5 low');
        } else if (refDirection === 'SELL' && m5.close > prevM5.high) {
          delta -= 6;
          events.push('Close above prev M5 high');
        } else {
          events.push('No break of structure');
        }

        // 3. Body strength (M5 scale)
        if (refDirection === 'BUY') {
          if (m5Bull && m5BodyPips > 3) { delta += 2; events.push('Strong bull body'); }
          else if (!m5Bull && m5BodyPips > 3) { delta -= 3; events.push('Strong bear body'); }
          if (!m5Bull && m5Body > 0) {
            const prevBody = Math.abs(prevM5.close - prevM5.open);
            if (m5Body > prevBody * 1.2 && prevM5.close > prevM5.open) {
              delta -= 4; events.push('Bearish engulfing');
            }
          }
        } else {
          if (!m5Bull && m5BodyPips > 3) { delta += 2; events.push('Strong bear body'); }
          else if (m5Bull && m5BodyPips > 3) { delta -= 3; events.push('Strong bull body'); }
          if (m5Bull && m5Body > 0) {
            const prevBody = Math.abs(prevM5.close - prevM5.open);
            if (m5Body > prevBody * 1.2 && prevM5.close < prevM5.open) {
              delta -= 4; events.push('Bullish engulfing');
            }
          }
        }

        // 4. Pullback depth — retraced too far against the reference candle
        if (refDirection === 'BUY') {
          const retrace = (runHigh - m5.low) / refRange;
          if (retrace > 0.7) { delta -= 3; events.push('Deep pullback'); }
        } else {
          const retrace = (m5.high - runLow) / refRange;
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
          time: m5.time,
          score,
          delta,
          label: statusLabel,
          event: events.join(', ') || 'No change',
          m5: {
            open: m5.open, high: m5.high, low: m5.low, close: m5.close,
            bull: m5Bull, bodyPips: m5BodyPips,
          },
        });

        prevM5 = m5;
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
        m5Count: today.length,
      });
    }

    // Sort: highest score first
    pairs.sort((a, b) => b.currentScore - a.currentScore);

    res.json({ pairs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
