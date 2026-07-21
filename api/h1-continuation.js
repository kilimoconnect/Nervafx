'use strict';

const { alignFromCandles } = require('./_h1-ema-align');

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
    if (!req._internal) {
      const gate = await requirePlan(sb, req, 'premium');
      if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
    }

    const now = new Date();

    // Historical mode: ?date=YYYY-MM-DD&hour=HH selects an H4 window to replay.
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

    const refCutoff = anchor ? anchor.toISOString() : now.toISOString();
    const anchorMs = anchor ? anchor.getTime() : now.getTime();
    const fetchSince = new Date(anchorMs - 6 * 24 * 3600000).toISOString();
    const fetchUntil = anchor ? new Date(anchorMs + H4_MS).toISOString() : now.toISOString();

    const PAGE = 1000;
    const h4Cache = {};
    const m15Cache = {};
    // Raw H1 series retained separately so the EMA-alignment gate can walk
    // full closes without re-fetching. The H1 -> H4 aggregation above only
    // keeps the last 3 completed buckets, which isn't enough for EMA50.
    const h1RawCache = {};

    // Fetch H1s (used to build synthetic H4 reference buckets)
    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const { data, error } = await sb
          .from('backtest_candles')
          .select('time, open, high, low, close')
          .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true)
          .gte('time', fetchSince).lt('time', refCutoff)
          .order('time', { ascending: true })
          .limit(PAGE);
        return { inst, data: error ? [] : data || [] };
      }));
      for (const { inst, data } of results) {
        // Stash the raw H1 series before aggregation so the EMA gate can use it.
        h1RawCache[inst] = (data || []).map(c => ({
          time: c.time,
          close: parseFloat(c.close),
        }));
        // Group H1s into 4h buckets aligned to 00/04/08/12/16/20 UTC
        const buckets = new Map();
        const cutoffMs = new Date(refCutoff).getTime();
        for (const c of data) {
          const t = new Date(c.time);
          const bucketMs = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(),
            Math.floor(t.getUTCHours() / 4) * 4, 0, 0, 0);
          const key = new Date(bucketMs).toISOString();
          let bkt = buckets.get(key);
          if (!bkt) {
            bkt = { time: key, open: null, high: -Infinity, low: Infinity, close: null, count: 0, firstMs: bucketMs };
            buckets.set(key, bkt);
          }
          const h = parseFloat(c.high), l = parseFloat(c.low), o = parseFloat(c.open), cl = parseFloat(c.close);
          if (bkt.open === null) bkt.open = o;
          if (h > bkt.high) bkt.high = h;
          if (l < bkt.low) bkt.low = l;
          bkt.close = cl;
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

    // Fetch M15 candles for the tracked window — go back 4 days so that on Monday
    // we still cover Friday's tail M15s when the ref H4 sits before the weekend.
    const m15Since = new Date(anchorMs - 4 * 24 * 3600000).toISOString();
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
      if (h4s.length < 2) continue;

      const pd = pipDiv(inst);
      const pair = inst.replace('_', '/');

      // Reference candle = last complete H4 before the tracked window (H4[-1]);
      // H4[-2] and H4[-3] are used for direction confirmation.
      const ref  = h4s[h4s.length - 1];
      const ref2 = h4s[h4s.length - 2];
      const ref3 = h4s.length >= 3 ? h4s[h4s.length - 3] : null;
      const refStart = ref.time;
      const trackStart = anchor
        ? anchor.toISOString()
        : new Date(new Date(refStart).getTime() + H4_MS).toISOString();

      // Direction confirmation. Primary: last H4 broke against the H4 before.
      // Fallback: H4[-2] broke, but only if H4[-1]'s own body agrees. Prevents
      // a stale H4 break from firing after the very next H4 has already
      // reversed direction.
      const r1BuyBrk  = ref.close  > ref2.high;
      const r1SellBrk = ref.close  < ref2.low;
      const r2BuyBrk  = ref3 ? ref2.close > ref3.high : false;
      const r2SellBrk = ref3 ? ref2.close < ref3.low  : false;
      const refBullish = ref.close > ref.open;
      const refBearish = ref.close < ref.open;

      // The last H4 is checked first; if it produced no break at all, the H4
      // before it stands on its own. The fallback used to also require the
      // last H4's body to agree, which meant a flat or opposing one killed
      // the signal outright.
      const buyConfirm  = r1BuyBrk  || r2BuyBrk;
      const sellConfirm = r1SellBrk || r2SellBrk;

      let confirmedDirection = null;
      if (buyConfirm && !sellConfirm) confirmedDirection = 'BUY';
      else if (sellConfirm && !buyConfirm) confirmedDirection = 'SELL';
      else if (buyConfirm && sellConfirm) {
        if (r1BuyBrk) confirmedDirection = 'BUY';
        else if (r1SellBrk) confirmedDirection = 'SELL';
        else confirmedDirection = refBullish ? 'BUY' : 'SELL';
      }
      if (!confirmedDirection) continue;

      // Strength of the confirming break (prev H4 broke its own predecessor by
      // this many pips) — used to rank pairs.
      let refBreakPips = 0;
      if (confirmedDirection === 'BUY') {
        if (r1BuyBrk) refBreakPips = (ref.close - ref2.high) / pd;
        else if (r2BuyBrk) refBreakPips = (ref2.close - ref3.high) / pd;
      } else {
        if (r1SellBrk) refBreakPips = (ref2.low - ref.close) / pd;
        else if (r2SellBrk) refBreakPips = (ref3.low - ref2.close) / pd;
      }
      refBreakPips = Math.round(refBreakPips * 10) / 10;

      const refRange = ref.high - ref.low;
      if (refRange < pd) continue;

      const refBodyPct = refRange > 0 ? Math.round((Math.abs(ref.close - ref.open) / refRange) * 100) : 0;
      const upperWickPct = refRange > 0
        ? Math.round(((ref.high - Math.max(ref.open, ref.close)) / refRange) * 100)
        : 0;
      const lowerWickPct = refRange > 0
        ? Math.round(((Math.min(ref.open, ref.close) - ref.low) / refRange) * 100)
        : 0;
      const refRangePips = Math.round((refRange / pd) * 10) / 10;
      const refBodyPips = Math.round((Math.abs(ref.close - ref.open) / pd) * 10) / 10;

      // M15 candles (full window for lookback + tracking)
      const m15all = m15Cache[inst] || [];
      if (m15all.length < 25) continue;

      const trackStartMs = new Date(trackStart).getTime();

      // Phase 1: locate the TRIGGER M15 — first M15 inside the current H4 window
      // that closes beyond the highest high (BUY) or lowest low (SELL) of the
      // preceding 24 M15 candles.
      let triggerAllIdx = -1;
      let breakLevel = 0;
      const direction = confirmedDirection;
      for (let i = 24; i < m15all.length; i++) {
        const c = m15all[i];
        const cMs = new Date(c.time).getTime();
        if (cMs < trackStartMs) continue;
        // Blackout window: skip triggers between 21:00 and 22:00 UTC (00:00-01:00 EAT)
        if (new Date(c.time).getUTCHours() === 21) continue;

        let maxHigh = -Infinity, minLow = Infinity;
        for (let j = i - 24; j < i; j++) {
          if (m15all[j].high > maxHigh) maxHigh = m15all[j].high;
          if (m15all[j].low < minLow) minLow = m15all[j].low;
        }

        if (direction === 'BUY' && c.close > maxHigh) { triggerAllIdx = i; breakLevel = maxHigh; break; }
        if (direction === 'SELL' && c.close < minLow) { triggerAllIdx = i; breakLevel = minLow; break; }
      }
      if (triggerAllIdx === -1) continue;

      const trigger = m15all[triggerAllIdx];

      // H1 EMA alignment gate at trigger time.
      const triggerMs = new Date(trigger.time).getTime();
      const emaAlign = alignFromCandles(h1RawCache[inst] || [], triggerMs, direction);
      if (!emaAlign.aligned) continue;
      const m15s = m15all.slice(triggerAllIdx);
      const triggerIdx = 0;
      const triggerBreakPips = direction === 'BUY'
        ? (trigger.close - breakLevel) / pd
        : (breakLevel - trigger.close) / pd;

      // Initial score
      let score = 50;
      score += 20;
      if (triggerBreakPips > 12) score += 15;
      else if (triggerBreakPips > 6) score += 10;
      else if (triggerBreakPips > 3) score += 5;

      const triggerBull = trigger.close > trigger.open;
      if ((direction === 'BUY' && triggerBull) || (direction === 'SELL' && !triggerBull)) score += 5;

      score = Math.max(20, Math.min(98, score));
      const initialScore = score;

      const timeline = [{
        time: trigger.time,
        score,
        label: 'Trigger 1',
        event: direction === 'BUY'
          ? 'Close above 24-M15 high (' + Math.round(triggerBreakPips * 10) / 10 + ' pips)'
          : 'Close below 24-M15 low (' + Math.round(triggerBreakPips * 10) / 10 + ' pips)',
        qualified: true,
        m15: {
          open: trigger.open, high: trigger.high, low: trigger.low, close: trigger.close,
          bull: triggerBull,
          bodyPips: Math.round((Math.abs(trigger.close - trigger.open) / pd) * 10) / 10,
        },
      }];

      // Break candle counts as Trigger 1; the setup qualifies once a monitoring
      // candle posts delta >= +6 and score > 75 to become Trigger 2.
      let firstTriggerTime = trigger.time;
      let qualifiedTime = null;

      let runHigh = trigger.high;
      let runLow = trigger.low;
      let prevC = trigger;
      let state = 'MONITORING';
      let stoppedTime = null;

      for (let i = triggerIdx + 1; i < m15s.length; i++) {
        const c = m15s[i];

        // Closing back inside the reference range used to end monitoring
        // outright. It now scores as the heaviest single penalty and tracking
        // continues, so a pair that dips back in and then breaks out again
        // stays visible instead of being dropped at the first pullback.
        const backInside = c.close < ref.high && c.close > ref.low;

        const cBull = c.close > c.open;
        const cBody = Math.abs(c.close - c.open);
        const cBodyPips = Math.round((cBody / pd) * 10) / 10;
        const cRange = c.high - c.low;
        let delta = 0;
        const events = [];

        // Bigger than any other single event, since this was previously fatal.
        if (backInside) { delta -= 8; events.push('Back inside prev H4 range'); }

        const brokeFor = direction === 'BUY' ? c.close > prevC.high : c.close < prevC.low;

        // 1. New high/low
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
        //    No penalty for a candle that simply failed to break the previous M15 level.
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

        // 3b. Chop / indecision
        if (cRange > 0 && (cRange / pd) > 6) {
          const bodyPct = (cBody / cRange) * 100;
          const upperPct = ((c.high - Math.max(c.open, c.close)) / cRange) * 100;
          const lowerPct = ((Math.min(c.open, c.close) - c.low) / cRange) * 100;
          if (bodyPct < 25 && upperPct > 30 && lowerPct > 30) {
            delta -= 2;
            events.push('Choppy candle');
          }
        }

        // 4. Pullback depth vs H4 reference range
        if (direction === 'BUY') {
          const retrace = (runHigh - c.low) / refRange;
          if (retrace > 0.7) { delta -= 3; events.push('Deep pullback'); }
        } else {
          const retrace = (c.high - runLow) / refRange;
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
        // Looking for Trigger 2: delta >= +6 AND running score above 75.
        if (qualifiedTime === null && delta >= 6 && score > 75) {
          qualifiedTime = c.time;
          entryLabel = 'Trigger 2';
          justQualified = true;
        }

        timeline.push({
          time: c.time,
          score,
          delta,
          label: entryLabel,
          event: justQualified
            ? 'Delta +' + delta + ' (' + (events.join(', ') || 'No change') + ')'
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
        qualified: true,
        // Trigger 2 kept as an informational milestone, not a gate.
        strongConfirmTime: qualifiedTime,
        stoppedTime,
        triggerBreakPips: Math.round(triggerBreakPips * 10) / 10,
        refBreakPips,
        refHour: {
          time: refStart,
          open: ref.open, high: ref.high, low: ref.low, close: ref.close,
          bodyPct: refBodyPct, upperWickPct, lowerWickPct,
          rangePips: refRangePips, bodyPips: refBodyPips,
          direction: ref.close > ref.open ? 'BUY' : 'SELL',
        },
        timeline,
        m15Count: m15s.length - triggerIdx,
      });
    }

    // Sort by trigger time ascending (earliest break first); tie-break by
    // refBreakPips desc then triggerBreakPips desc. Every pair that gets here
    // has triggered, so the qualified/unqualified split the first comparison
    // used to make no longer separates anything.
    pairs.sort((a, b) => {
      if (a.triggerTime && !b.triggerTime) return -1;
      if (!a.triggerTime && b.triggerTime) return 1;
      const at = a.triggerTime || a.breakTime;
      const bt = b.triggerTime || b.breakTime;
      if (at !== bt) return at < bt ? -1 : 1;
      if ((b.refBreakPips || 0) !== (a.refBreakPips || 0)) return (b.refBreakPips || 0) - (a.refBreakPips || 0);
      return b.triggerBreakPips - a.triggerBreakPips;
    });
    res.json({ pairs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
