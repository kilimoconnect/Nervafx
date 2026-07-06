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
    // Fetch enough history to survive weekends: last complete H4 + tracked window M15s
    const fetchSince = new Date(anchorMs - 6 * 24 * 3600000).toISOString();
    const fetchUntil = anchor ? new Date(anchorMs + H4_MS).toISOString() : now.toISOString();

    const PAGE = 1000;
    const h4Cache = {};
    const m15Cache = {};

    // Fetch last complete H4 candles per pair
    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const { data, error } = await sb
          .from('backtest_candles')
          .select('time, open, high, low, close')
          .eq('instrument', inst).eq('timeframe', 'H4').eq('complete', true)
          .gte('time', fetchSince).lt('time', refCutoff)
          .order('time', { ascending: false })
          .limit(3);
        return { inst, data: error ? [] : (data || []).reverse() };
      }));
      for (const { inst, data } of results) {
        h4Cache[inst] = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
      }
    }

    // Fetch M15 candles covering the reference window + tracked window
    const m15Since = new Date(anchorMs - 2 * H4_MS).toISOString();
    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const { data, error } = await sb
          .from('backtest_candles')
          .select('time, open, high, low, close')
          .eq('instrument', inst).eq('timeframe', 'M15')
          .gte('time', m15Since).lte('time', fetchUntil)
          .order('time', { ascending: true })
          .limit(PAGE);
        return { inst, data: error ? [] : data || [] };
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

      // Range strength (H4 scale)
      if (refRangePips > 60) score += 5;
      else if (refRangePips > 35) score += 3;

      score = Math.max(20, Math.min(98, score));
      const initialScore = score;

      // Phase 2: M15 updates within the current H4 window
      const m15all = m15Cache[inst] || [];
      const refWindowM15s = m15all.filter(c => c.time >= refStart && c.time < trackStart);
      const today = m15all.filter(c => c.time >= trackStart);

      const timeline = [{
        time: trackStart,
        score,
        label: 'Window Open',
        event: refDirection === 'BUY' ? 'Bullish Expansion' : 'Bearish Expansion',
      }];

      let runHigh = refBull ? ref.close : ref.high;
      let runLow = refBull ? ref.low : ref.close;
      let prevM15 = refWindowM15s.length ? refWindowM15s[refWindowM15s.length - 1] : ref;

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
            if (brokeFor) {
              delta += 3;
              events.push('New high');
            } else {
              events.push('New high (wick only)');
            }
          } else if (m15.high < prevM15.high && m15.low < prevM15.low) {
            delta -= 4;
            events.push('Lower high + lower low');
          } else if (m15.high < prevM15.high) {
            delta -= 2;
            events.push('Lower high');
          }
        } else {
          if (m15.low < runLow) {
            runLow = m15.low;
            if (brokeFor) {
              delta += 3;
              events.push('New low');
            } else {
              events.push('New low (wick only)');
            }
          } else if (m15.low > prevM15.low && m15.high > prevM15.high) {
            delta -= 4;
            events.push('Higher low + higher high');
          } else if (m15.low > prevM15.low) {
            delta -= 2;
            events.push('Higher low');
          }
        }

        // 2. M15 close beyond previous M15 high/low
        if (refDirection === 'BUY' && m15.close > prevM15.high) {
          delta += 4;
          events.push('Close above prev M15 high');
        } else if (refDirection === 'SELL' && m15.close < prevM15.low) {
          delta += 4;
          events.push('Close below prev M15 low');
        } else if (refDirection === 'BUY' && m15.close < prevM15.low) {
          delta -= 6;
          events.push('Close below prev M15 low');
        } else if (refDirection === 'SELL' && m15.close > prevM15.high) {
          delta -= 6;
          events.push('Close above prev M15 high');
        } else {
          events.push('No break of structure');
        }

        // 3. Body strength (M15 scale)
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

        // 3b. Chop / indecision — small body + big wicks on both sides
        {
          const m15Range = m15.high - m15.low;
          if (m15Range > 0 && (m15Range / pd) > 6) {
            const bodyPct = (m15Body / m15Range) * 100;
            const upperPct = ((m15.high - Math.max(m15.open, m15.close)) / m15Range) * 100;
            const lowerPct = ((Math.min(m15.open, m15.close) - m15.low) / m15Range) * 100;
            if (bodyPct < 25 && upperPct > 30 && lowerPct > 30) {
              delta -= 2;
              events.push('Choppy candle');
            }
          }
        }

        // 4. Pullback depth — retraced too far against the reference candle
        if (refDirection === 'BUY') {
          const retrace = (runHigh - m15.low) / refRange;
          if (retrace > 0.7) { delta -= 3; events.push('Deep pullback'); }
        } else {
          const retrace = (m15.high - runLow) / refRange;
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
        refHour: {
          time: refStart,
          open: ref.open, high: ref.high, low: ref.low, close: ref.close,
          bodyPct: refBodyPct, upperWickPct, lowerWickPct,
          rangePips: refRangePips, bodyPips: refBodyPips,
          direction: refDirection,
        },
        timeline,
        m15Count: today.length,
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
