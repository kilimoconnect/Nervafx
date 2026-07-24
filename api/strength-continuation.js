'use strict';

// Strength Continuation Engine.
//
// Qualification is pure currency strength — no EMA or other trend gate. A pair
// is in the universe only if one of its currencies carries |strength| >= 0.0015
// on smooth_6h OR smooth_12h (base bid up, or quote sold off, sets the
// direction). From there the first trigger is an H1 close beyond the preceding
// 6-H1 high/low, monitoring runs on M30, and Trigger 2 fires when a monitoring
// candle posts delta >= +6 with running score above 75.
//
// Scoped to the current UTC day (or ?date=YYYY-MM-DD), evaluated live.

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');
const { loadStrength } = require('./_strength-gate');

const VALID_PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];

function isJpy(inst) { return inst.includes('JPY'); }
function pipDiv(inst) { return isJpy(inst) ? 0.01 : 0.0001; }

// Trigger runs on H1 (fires 1h after its timestamp); monitoring runs on M30.
const TRIGGER_TF_MS = 60 * 60 * 1000;
const MONITOR_TF_MS = 30 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const closeTimeOf = (iso, tfMs = TRIGGER_TF_MS) =>
  iso ? new Date(new Date(iso).getTime() + tfMs).toISOString() : null;

// ── Strength gate (6H / 12H at 0.0015) ──────────────────────────────────────
// loadStrength returns byHour[hour][ccy] = [smooth_3h, smooth_6h, smooth_12h].
// This engine only looks at indices 1 (6H) and 2 (12H).
const STRENGTH_MIN = 0.0015;
const STALE_HOURS = 3;
const H6 = 1, H12 = 2;

// Newest strength row already published at or before a candle's close, walking
// back over any pipeline gap. A row stamped at hour H derives from the H1 candle
// opening at H, so it only exists once that candle closes at H+1h — reading it
// against a candle that closes at closeMs is therefore not lookahead.
function readingsAt(byHour, closeMs, ccy) {
  const latest = Math.floor((closeMs - HOUR_MS) / HOUR_MS) * HOUR_MS;
  for (let b = 0; b <= STALE_HOURS; b++) {
    const hk = new Date(latest - b * HOUR_MS).toISOString().slice(0, 13);
    const v = byHour[hk]?.[ccy];
    if (v !== undefined) return v;
  }
  return null;
}

// Does a leg carry >= 0.0015 conviction in `direction` on 6H or 12H? Returns the
// leg doing the most work, or { ok:false }. A strength outage passes unjudged.
function strengthGate(byHour, inst, direction, openMs, tfMs) {
  const closeMs = openMs + tfMs;
  const [base, quote] = inst.split('_');
  const b = readingsAt(byHour, closeMs, base);
  const q = readingsAt(byHour, closeMs, quote);
  if (!b || !q) return { ok: true, nodata: true };

  let best = null;
  const consider = (currency, value, horizon) => {
    if (!best || Math.abs(value) > Math.abs(best.value)) best = { currency, value, horizon };
  };
  for (const [idx, label] of [[H6, '6H'], [H12, '12H']]) {
    const bv = b[idx], qv = q[idx];
    const baseOk  = direction === 'BUY' ? bv >=  STRENGTH_MIN : bv <= -STRENGTH_MIN;
    const quoteOk = direction === 'BUY' ? qv <= -STRENGTH_MIN : qv >=  STRENGTH_MIN;
    if (baseOk)  consider(base,  bv, label);
    if (quoteOk) consider(quote, qv, label);
  }
  return best ? { ok: true, ...best } : { ok: false };
}

// Direction implied by strength as of a given moment (asOfMs). Null when
// neither side qualifies or strength is unavailable; the stronger side wins a
// tie. Passing a candle's close time keeps historical days lookahead-free.
function directionFromStrength(byHour, inst, asOfMs) {
  const buy  = strengthGate(byHour, inst, 'BUY',  asOfMs, 0);
  const sell = strengthGate(byHour, inst, 'SELL', asOfMs, 0);
  const buyOk  = buy.ok  && !buy.nodata  && buy.currency;
  const sellOk = sell.ok && !sell.nodata && sell.currency;
  if (buyOk && !sellOk)  return { direction: 'BUY',  gate: buy };
  if (sellOk && !buyOk)  return { direction: 'SELL', gate: sell };
  if (buyOk && sellOk)   return Math.abs(buy.value) >= Math.abs(sell.value)
    ? { direction: 'BUY', gate: buy } : { direction: 'SELL', gate: sell };
  return null;
}

// ── M30 synthesis (no native M30 feed — pair consecutive M15s) ───────────────
function m30FromM15(m15s) {
  const buckets = new Map();
  for (const c of m15s) {
    const ms = new Date(c.time).getTime();
    const key = Math.floor(ms / MONITOR_TF_MS) * MONITOR_TF_MS;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ ms, c });
  }
  const out = [];
  for (const [key, parts] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (parts.length < 2) continue;
    parts.sort((a, b) => a.ms - b.ms);
    const cs = parts.map(p => p.c);
    out.push({
      time: new Date(key).toISOString(),
      open: parseFloat(cs[0].open),
      close: parseFloat(cs[cs.length - 1].close),
      high: Math.max(...cs.map(c => parseFloat(c.high))),
      low: Math.min(...cs.map(c => parseFloat(c.low))),
    });
  }
  return out;
}

// Synthetic candle over an ordered array (used for the 6-H1 reference block).
function buildCandle(inst, candles) {
  if (!candles.length) return null;
  const pd = pipDiv(inst);
  const open = candles[0].open;
  const close = candles[candles.length - 1].close;
  let high = -Infinity, low = Infinity;
  for (const c of candles) { if (c.high > high) high = c.high; if (c.low < low) low = c.low; }
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

    // Current UTC day, or a specific ?date=YYYY-MM-DD.
    const qDate = req.query?.date;
    let dayStart;
    if (qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate)) {
      dayStart = new Date(qDate + 'T00:00:00Z');
    } else {
      dayStart = new Date(now);
      dayStart.setUTCHours(0, 0, 0, 0);
    }
    if (isNaN(dayStart.getTime())) { dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0); }
    const dayEnd = new Date(dayStart.getTime() + 24 * HOUR_MS);
    const isToday = dayEnd.getTime() > now.getTime();
    const trackEnd = isToday ? now : dayEnd;

    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayEnd.getTime();
    const trackEndMs = trackEnd.getTime();

    // H1 back 2 days before the day so the 6-H1 lookback has candles even at
    // 00:00, and across a weekend.
    const fetchSince = new Date(dayStartMs - 2 * 24 * HOUR_MS).toISOString();
    const fetchUntil = trackEnd.toISOString();

    const PAGE = 1000;
    const h1Cache  = {};   // H1 for the trigger scan + reference
    const m30Cache = {};   // M30 (from M15) for monitoring

    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const h1Data = [];
        let off = 0;
        while (true) {
          const { data, error } = await sb
            .from('backtest_candles')
            .select('time, open, high, low, close')
            .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true)
            .gte('time', fetchSince).lte('time', fetchUntil)
            .order('time', { ascending: true })
            .range(off, off + PAGE - 1);
          if (error) throw error;
          if (!data || !data.length) break;
          h1Data.push(...data);
          if (data.length < PAGE) break;
          off += PAGE;
        }

        const m15Data = [];
        let m15Off = 0;
        while (true) {
          const { data, error } = await sb
            .from('backtest_candles')
            .select('time, open, high, low, close')
            .eq('instrument', inst).eq('timeframe', 'M15').eq('complete', true)
            .gte('time', fetchSince).lte('time', fetchUntil)
            .order('time', { ascending: true })
            .range(m15Off, m15Off + PAGE - 1);
          if (error) throw error;
          if (!data || !data.length) break;
          m15Data.push(...data);
          if (data.length < PAGE) break;
          m15Off += PAGE;
        }

        return { inst, h1: h1Data, m15: m15Data };
      }));

      for (const { inst, h1, m15 } of results) {
        h1Cache[inst] = h1.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
        m30Cache[inst] = m30FromM15(m15);
      }
    }

    // Hourly 3H/6H/12H strength, keyed hour -> currency.
    const strengthByHour = await loadStrength(sb, fetchSince, fetchUntil);

    const pairs = [];

    for (const inst of VALID_PAIRS) {
      const all = h1Cache[inst] || [];
      if (all.length < 8) continue;

      const pd = pipDiv(inst);
      const pair = inst.replace('_', '/');

      // Phase 1: first H1 inside the day that (a) has a qualifying strength
      // direction as of its own close and (b) closes beyond the preceding
      // 6-H1 high (BUY) or low (SELL). Direction is judged per candle from the
      // strength published at that close — never from "now" — so a historical
      // day reconstructs with the strength that actually existed then, with no
      // lookahead.
      const BREAK_LOOKBACK = 6;
      let triggerIdx = -1;
      let breakLevel = 0;
      let direction = null;
      for (let i = BREAK_LOOKBACK; i < all.length; i++) {
        const c = all[i];
        const cMs = new Date(c.time).getTime();
        if (cMs < dayStartMs || cMs >= trackEndMs) continue;

        const dirAt = directionFromStrength(strengthByHour, inst, cMs + TRIGGER_TF_MS);
        if (!dirAt) continue;

        let maxHigh = -Infinity, minLow = Infinity;
        for (let j = i - BREAK_LOOKBACK; j < i; j++) {
          if (all[j].high > maxHigh) maxHigh = all[j].high;
          if (all[j].low < minLow) minLow = all[j].low;
        }
        if (dirAt.direction === 'BUY' && c.close > maxHigh) { triggerIdx = i; breakLevel = maxHigh; direction = 'BUY'; break; }
        if (dirAt.direction === 'SELL' && c.close < minLow) { triggerIdx = i; breakLevel = minLow; direction = 'SELL'; break; }
      }
      if (triggerIdx === -1) continue;

      const trigger = all[triggerIdx];
      const triggerMs = new Date(trigger.time).getTime();

      // Reference block = the 6 H1 candles the trigger broke out of.
      const refCandles = all.slice(triggerIdx - BREAK_LOOKBACK, triggerIdx);
      const ref = buildCandle(inst, refCandles);
      if (!ref) continue;

      // Strength detail at the trigger (for display).
      const trigStrength = strengthGate(strengthByHour, inst, direction, triggerMs, TRIGGER_TF_MS);

      // Monitoring: M30 candles opening after the trigger H1 closes, to day end.
      const triggerCloseMs = triggerMs + TRIGGER_TF_MS;
      const monCandles = (m30Cache[inst] || []).filter(c => {
        const ms = new Date(c.time).getTime();
        return ms >= triggerCloseMs && ms < trackEndMs;
      });

      const triggerBreakPips = direction === 'BUY'
        ? (trigger.close - breakLevel) / pd
        : (breakLevel - trigger.close) / pd;

      // Initial score
      let score = 50;
      score += 20;
      if (triggerBreakPips > 15) score += 15;
      else if (triggerBreakPips > 8) score += 10;
      else if (triggerBreakPips > 4) score += 5;

      const triggerBull = trigger.close > trigger.open;
      if ((direction === 'BUY' && triggerBull) || (direction === 'SELL' && !triggerBull)) score += 5;

      score = Math.max(20, Math.min(98, score));
      const initialScore = score;

      const timeline = [{
        time: trigger.time,
        closeTime: closeTimeOf(trigger.time),
        score,
        label: 'Trigger 1',
        event: direction === 'BUY'
          ? 'Close above 6-H1 high (' + Math.round(triggerBreakPips * 10) / 10 + ' pips)'
          : 'Close below 6-H1 low (' + Math.round(triggerBreakPips * 10) / 10 + ' pips)',
        qualified: true,
        h1: {
          open: trigger.open, high: trigger.high, low: trigger.low, close: trigger.close,
          bull: triggerBull,
          bodyPips: Math.round((Math.abs(trigger.close - trigger.open) / pd) * 10) / 10,
        },
      }];

      let firstTriggerTime = trigger.time;
      let qualifiedTime = null;

      let runHigh = trigger.high;
      let runLow = trigger.low;
      let prevC = trigger;
      let state = 'MONITORING';
      let stoppedTime = null;

      for (let i = 0; i < monCandles.length; i++) {
        const c = monCandles[i];

        // Closing back inside the broken 6-H1 range is the heaviest single
        // penalty, but tracking continues so a re-break stays visible.
        const backInside = c.close < ref.high && c.close > ref.low;

        const cBull = c.close > c.open;
        const cBody = Math.abs(c.close - c.open);
        const cBodyPips = Math.round((cBody / pd) * 10) / 10;
        const cRange = c.high - c.low;
        let delta = 0;
        const events = [];

        if (backInside) { delta -= 8; events.push('Back inside broken 6-H1 range'); }

        // Strength gate, scored not fatal: an M30 where neither currency holds
        // 0.0015 conviction weakens the case without ending the run.
        const cStrength = strengthGate(strengthByHour, inst, direction, new Date(c.time).getTime(), MONITOR_TF_MS);
        if (!cStrength.ok) { delta -= 5; events.push('No strength conviction'); }

        const brokeFor = direction === 'BUY' ? c.close > prevC.high : c.close < prevC.low;

        // 1. New high/low — rewarded only on a close through structure
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

        // 2. M30 close beyond previous M30 high/low
        if (direction === 'BUY' && c.close > prevC.high) {
          delta += 4; events.push('Close above prev M30 high');
        } else if (direction === 'SELL' && c.close < prevC.low) {
          delta += 4; events.push('Close below prev M30 low');
        } else if (direction === 'BUY' && c.close < prevC.low) {
          delta -= 6; events.push('Close below prev M30 low');
        } else if (direction === 'SELL' && c.close > prevC.high) {
          delta -= 6; events.push('Close above prev M30 high');
        } else {
          events.push('No break of structure');
        }

        // 3. Body strength (pip thresholds carried over from the H1 engine)
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

        // 3b. Chop / indecision — small body + big wicks both sides
        if (cRange > 0 && (cRange / pd) > 6) {
          const bodyPct = (cBody / cRange) * 100;
          const upperPct = ((c.high - Math.max(c.open, c.close)) / cRange) * 100;
          const lowerPct = ((Math.min(c.open, c.close) - c.low) / cRange) * 100;
          if (bodyPct < 25 && upperPct > 30 && lowerPct > 30) {
            delta -= 2; events.push('Choppy candle');
          }
        }

        // 4. Pullback depth vs the broken 6-H1 range
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
        if (qualifiedTime === null && delta >= 6 && score > 75) {
          qualifiedTime = c.time;
          entryLabel = 'Trigger 2';
          justQualified = true;
        }

        timeline.push({
          time: c.time,
          closeTime: closeTimeOf(c.time, MONITOR_TF_MS),
          score,
          delta,
          label: entryLabel,
          event: justQualified
            ? 'Delta +' + delta + ' (' + (events.join(', ') || 'No change') + ')'
            : (events.join(', ') || 'No change'),
          qualified: justQualified || undefined,
          m30: {
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

      const refStartISO = refCandles[0].time;
      const refEndISO   = trigger.time;

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
        triggerTime: firstTriggerTime,
        triggerCloseTime: closeTimeOf(firstTriggerTime),
        // Which leg and horizon carried the >= 0.0015 strength.
        strength: trigStrength.nodata || !trigStrength.currency ? null : {
          currency: trigStrength.currency,
          horizon: trigStrength.horizon,
          value: +trigStrength.value.toFixed(5),
        },
        qualified: true,
        strongConfirmTime: qualifiedTime,
        stoppedTime,
        triggerBreakPips: Math.round(triggerBreakPips * 10) / 10,
        refBreakPips: 0,
        refSession: {
          name: 'Prior 6H structure',
          start: refStartISO,
          end: refEndISO,
          open: ref.open, high: ref.high, low: ref.low, close: ref.close,
          bodyPct: ref.bodyPct, upperWickPct: ref.upperWickPct, lowerWickPct: ref.lowerWickPct,
          rangePips: ref.rangePips, bodyPips: ref.bodyPips,
          direction: ref.bull ? 'BUY' : 'SELL',
        },
        currentSession: {
          name: 'Today (UTC)',
          start: dayStart.toISOString(),
          end: trackEnd.toISOString(),
        },
        timeline,
        monitorCount: monCandles.length,
      });
    }

    // Ranked by live score, strongest continuation first; ties on break size
    // then which fired first.
    pairs.sort((a, b) => {
      if (b.currentScore !== a.currentScore) return b.currentScore - a.currentScore;
      if ((b.triggerBreakPips || 0) !== (a.triggerBreakPips || 0)) {
        return (b.triggerBreakPips || 0) - (a.triggerBreakPips || 0);
      }
      const at = a.triggerTime || a.breakTime;
      const bt = b.triggerTime || b.breakTime;
      return at < bt ? -1 : at > bt ? 1 : 0;
    });

    res.json({ pairs, day: dayStart.toISOString().slice(0, 10) });
  } catch (e) {
    console.error('[strength-continuation]', e);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
