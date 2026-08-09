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
// the candle closes. The trigger runs on H1 (fires 1h after its timestamp);
// post-trigger monitoring runs on M30 (fires 30 min after its timestamp).
const TRIGGER_TF_MS = 60 * 60 * 1000;
const MONITOR_TF_MS = 30 * 60 * 1000;
const closeTimeOf = (iso, tfMs = TRIGGER_TF_MS) =>
  iso ? new Date(new Date(iso).getTime() + tfMs).toISOString() : null;

// No M30 feed exists — only H1 and M15 are stored — so the monitoring series is
// built by pairing each :00+:15 and :30+:45 M15 candle. A 30-minute bar is
// emitted only when both of its M15 candles are present, which naturally
// excludes the currently forming half-hour.
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
    if (parts.length < 2) continue; // half-hour not yet complete
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


// Sessions (all UTC hours):
//   ASIA:   21:00 (prev day) → 07:00  (10h)
//   LONDON: 07:00 → 13:00                (6h)
//   NY:     13:00 → 21:00                (8h)
const SESSION_ORDER = ['ASIA', 'LONDON', 'NY'];

function currentSessionAt(t) {
  const d = new Date(t);
  const h = d.getUTCHours();
  let name, start;
  if (h >= 21) {
    name = 'ASIA';
    start = new Date(d); start.setUTCHours(21, 0, 0, 0);
  } else if (h < 6) {
    name = 'ASIA';
    start = new Date(d); start.setUTCDate(start.getUTCDate() - 1); start.setUTCHours(21, 0, 0, 0);
  } else if (h < 12) {
    name = 'LONDON';
    start = new Date(d); start.setUTCHours(6, 0, 0, 0);
  } else {
    name = 'NY';
    start = new Date(d); start.setUTCHours(12, 0, 0, 0);
  }
  return { name, start };
}

function sessionEnd(name, start) {
  const end = new Date(start);
  // ASIA 21:00→06:00 (9h, absorbs low-liquidity), LONDON 06:00→12:00 (6h),
  // NY 12:00→21:00 (9h).
  if (name === 'ASIA')   end.setUTCHours(end.getUTCHours() + 9);
  if (name === 'LONDON') end.setUTCHours(end.getUTCHours() + 6);
  if (name === 'NY')     end.setUTCHours(end.getUTCHours() + 9);
  return end;
}

function previousSession(name, start) {
  let prevName, prevStart;
  if (name === 'ASIA') {
    prevName = 'NY';
    prevStart = new Date(start);
    prevStart.setUTCHours(12, 0, 0, 0);
  } else if (name === 'LONDON') {
    prevName = 'ASIA';
    prevStart = new Date(start);
    prevStart.setUTCDate(prevStart.getUTCDate() - 1);
    prevStart.setUTCHours(21, 0, 0, 0);
  } else {
    prevName = 'LONDON';
    prevStart = new Date(start);
    prevStart.setUTCHours(6, 0, 0, 0);
  }
  const day = prevStart.getUTCDay();
  if (day === 6) {
    prevStart.setUTCDate(prevStart.getUTCDate() - 1);
  } else if (day === 0 && prevStart.getUTCHours() < 21) {
    prevStart.setUTCDate(prevStart.getUTCDate() - 2);
  }
  return { name: prevName, start: prevStart, end: sessionEnd(prevName, prevStart) };
}

// Build a synthetic session candle from an ordered array of candles (H1 here,
// but the maths is timeframe-agnostic)
function buildSessionCandle(inst, candles) {
  if (!candles.length) return null;
  const pd = pipDiv(inst);
  const open = candles[0].open;
  const close = candles[candles.length - 1].close;
  let high = -Infinity, low = Infinity;
  for (const c of candles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
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

    const qDate = req.query?.date;
    const qSession = (req.query?.session || '').toUpperCase();
    let anchor = null;
    let anchorSession = null;

    if (qDate && SESSION_ORDER.includes(qSession)) {
      const base = new Date(qDate + 'T00:00:00Z');
      if (!isNaN(base.getTime())) {
        anchor = new Date(base);
        if (qSession === 'ASIA') { anchor.setUTCDate(anchor.getUTCDate() - 1); anchor.setUTCHours(21, 0, 0, 0); }
        if (qSession === 'LONDON') anchor.setUTCHours(6, 0, 0, 0);
        if (qSession === 'NY') anchor.setUTCHours(12, 0, 0, 0);
        anchorSession = qSession;
      }
    }

    const cur = anchor
      ? { name: anchorSession, start: anchor }
      : currentSessionAt(now);
    const curEnd = sessionEnd(cur.name, cur.start);
    const trackStart = cur.start;

    const prev  = previousSession(cur.name, cur.start);
    const prev2 = previousSession(prev.name, prev.start);
    const prev3 = previousSession(prev2.name, prev2.start);

    const fetchSince = prev3.start.toISOString();
    const fetchUntil = anchor ? curEnd.toISOString() : now.toISOString();

    // The one trigger for this engine — the Sharp Reversal engine (Standard or
    // Scalp, earliest cross) evaluated at the page's as-of time (fetchUntil).
    const srTriggers = await loadSharpReversalTriggers(sb, fetchUntil);

    const PAGE = 1000;
    // H1 series driving the trigger and the session-reference candles.
    const candleCache = {};
    // Separate H1 cache used only by the EMA-alignment gate on the trigger.
    // Fetched further back to guarantee ≥ 51 complete H1 candles for EMA50.
    const h1Cache = {};
    // M30 (synthesized from M15) driving post-trigger monitoring only.
    const m30Cache = {};
    const h1Since = new Date(new Date(fetchSince).getTime() - 5 * 24 * 3600000).toISOString();

    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const allData = [];
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
          allData.push(...data);
          if (data.length < PAGE) break;
          off += PAGE;
        }
        const { data: h1Data, error: h1Err } = await sb
          .from('backtest_candles')
          .select('time, close')
          .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true)
          .gte('time', h1Since).lte('time', fetchUntil)
          .order('time', { ascending: true })
          .limit(400);
        if (h1Err) throw h1Err;

        // M15 for the monitoring series — synthesized into M30 below.
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
        return { inst, data: allData, h1: h1Data || [], m15: m15Data };
      }));
      for (const { inst, data, h1, m15 } of results) {
        candleCache[inst] = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
        h1Cache[inst] = h1.map(c => ({ time: c.time, close: parseFloat(c.close) }));
        m30Cache[inst] = m30FromM15(m15);
      }
    }

    // Hourly 3H/6H/12H strength, keyed hour -> currency.
    const strengthByHour = await loadStrength(sb, fetchSince, fetchUntil);

    const prevStartISO  = prev.start.toISOString();
    const prevEndISO    = prev.end.toISOString();
    const prev2StartISO = prev2.start.toISOString();
    const prev2EndISO   = prev2.end.toISOString();
    const prev3StartISO = prev3.start.toISOString();
    const prev3EndISO   = prev3.end.toISOString();
    const trackStartISO = trackStart.toISOString();
    const curEndISO     = curEnd.toISOString();

    const pairs = [];

    for (const inst of VALID_PAIRS) {
      const all = candleCache[inst] || [];
      if (!all.length) continue;

      const pd = pipDiv(inst);
      const pair = inst.replace('_', '/');

      if (all.length < 2) continue;

      // One trigger, from the Sharp Reversal engine (Standard or Scalp, whichever
      // crossed first). Direction comes from that signal — no previous-session data.
      const srTrig = srTriggers[inst];
      if (!srTrig) continue;
      let triggerMs = new Date(srTrig.triggerTime).getTime();
      if (isNaN(triggerMs)) continue;
      const direction = srTrig.direction;
      const refBreakPips = 0;

      const trackStartMs = new Date(trackStartISO).getTime();
      const curEndMs = new Date(curEndISO).getTime();

      // Trigger must fall before the session ends; a cross that predates the
      // session simply starts monitoring at the session open.
      if (triggerMs >= curEndMs) continue;
      if (triggerMs < trackStartMs) triggerMs = trackStartMs;

      // Anchor the timeline to the H1 that was live when the Sharp Reversal
      // fired; monitoring then scores the M30 series from that point, as before.
      let triggerAllIdx = -1;
      for (let i = 0; i < all.length; i++) {
        const ms = new Date(all[i].time).getTime();
        if (ms <= triggerMs && ms >= trackStartMs) triggerAllIdx = i;
        else if (ms > triggerMs) break;
      }
      if (triggerAllIdx === -1) continue;   // no session H1 at/before the trigger yet
      const trigger = all[triggerAllIdx];

      // The trigger H1 candle IS the reference — back-inside and pullback are
      // judged against it and the move built from it, not a previous session.
      const refHigh = trigger.high, refLow = trigger.low;
      const refRange = Math.max(trigger.high - trigger.low, pd);
      const tBull = trigger.close > trigger.open;
      const tBody = Math.abs(trigger.close - trigger.open);
      const refBodyPct = Math.round((tBody / refRange) * 100);
      const refUpperWickPct = Math.round(((trigger.high - Math.max(trigger.open, trigger.close)) / refRange) * 100);
      const refLowerWickPct = Math.round(((Math.min(trigger.open, trigger.close) - trigger.low) / refRange) * 100);
      const refRangePips = Math.round((refRange / pd) * 10) / 10;
      const refBodyPips = Math.round((tBody / pd) * 10) / 10;

      // Monitoring runs on the M30 series, from the first completed M30 at or
      // after the Sharp Reversal trigger through to session end.
      const monCandles = (m30Cache[inst] || []).filter(c => {
        const ms = new Date(c.time).getTime();
        return ms >= triggerMs && ms < curEndMs;
      });
      const triggerBreakPips = 0;

      // Initial score
      let score = 50;
      score += 20; // baseline for triggering
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

      let runHigh = trigger.high;
      let runLow = trigger.low;
      let prevC = trigger;
      let state = 'MONITORING';
      let stoppedTime = null;

      for (let i = 0; i < monCandles.length; i++) {
        const c = monCandles[i];

        // Closing back inside the reference range used to end monitoring
        // outright. It now scores as the heaviest single penalty and tracking
        // continues, so a pair that dips back in and then breaks out again
        // stays visible instead of being dropped at the first pullback.
        const backInside = c.close < refHigh && c.close > refLow;

        const cBull = c.close > c.open;
        const cBody = Math.abs(c.close - c.open);
        const cBodyPips = Math.round((cBody / pd) * 10) / 10;
        const cRange = c.high - c.low;
        let delta = 0;
        const events = [];

        // Bigger than any other single event, since this was previously fatal.
        if (backInside) { delta -= 8; events.push('Back inside prev session range'); }

        // Strength gate, scored rather than fatal here: an M30 where neither
        // currency holds conviction weakens the case without ending a run that
        // may well reassert itself. Strength is hourly, so the gate reads the
        // freshest row already published at each M30 close — no lookahead.
        const cStrength = strengthGate(strengthByHour, inst, direction, new Date(c.time).getTime(), MONITOR_TF_MS);
        if (!cStrength.ok) { delta -= 5; events.push('No strength conviction'); }

        const brokeFor = direction === 'BUY' ? c.close > prevC.high : c.close < prevC.low;

        // Did this M30 set a new session extreme (highest high / lowest low
        // since the trigger)? Used as a Trigger 2 requirement.
        let newExtreme = false;

        // 1. New high/low — only rewarded when the candle also closes through structure
        if (direction === 'BUY') {
          if (c.high > runHigh) {
            runHigh = c.high; newExtreme = true;
            if (brokeFor) { delta += 3; events.push('New high'); }
            else { events.push('New high (wick only)'); }
          } else if (c.high < prevC.high && c.low < prevC.low) {
            delta -= 4; events.push('Lower high + lower low');
          } else if (c.high < prevC.high) {
            delta -= 2; events.push('Lower high');
          }
        } else {
          if (c.low < runLow) {
            runLow = c.low; newExtreme = true;
            if (brokeFor) { delta += 3; events.push('New low'); }
            else { events.push('New low (wick only)'); }
          } else if (c.low > prevC.low && c.high > prevC.high) {
            delta -= 4; events.push('Higher low + higher high');
          } else if (c.low > prevC.low) {
            delta -= 2; events.push('Higher low');
          }
        }

        // 2. H1 close beyond previous H1 high/low
        //    Reward continuation break; adverse close still penalizes; no penalty for
        //    a candle that simply failed to break the previous H1 level.
        if (direction === 'BUY' && c.close > prevC.high) {
          delta += 4; events.push('Close above prev H1 high');
        } else if (direction === 'SELL' && c.close < prevC.low) {
          delta += 4; events.push('Close below prev H1 low');
        } else if (direction === 'BUY' && c.close < prevC.low) {
          delta -= 6; events.push('Close below prev H1 low');
        } else if (direction === 'SELL' && c.close > prevC.high) {
          delta -= 6; events.push('Close above prev H1 high');
        } else {
          events.push('No break of structure');
        }

        // 3. Body strength (H1 scale)
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

        // 3b. Chop / indecision — small body + big wicks on both sides
        if (cRange > 0 && (cRange / pd) > 6) {
          const bodyPct = (cBody / cRange) * 100;
          const upperPct = ((c.high - Math.max(c.open, c.close)) / cRange) * 100;
          const lowerPct = ((Math.min(c.open, c.close) - c.low) / cRange) * 100;
          if (bodyPct < 25 && upperPct > 30 && lowerPct > 30) {
            delta -= 2;
            events.push('Choppy candle');
          }
        }

        // 4. Pullback depth vs the move built since the trigger
        if (direction === 'BUY') {
          const moveExt = Math.max(runHigh - refLow, pd);
          const retrace = (runHigh - c.low) / moveExt;
          if (retrace > 0.7) { delta -= 3; events.push('Deep pullback'); }
        } else {
          const moveExt = Math.max(refHigh - runLow, pd);
          const retrace = (c.high - runLow) / moveExt;
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
        // Trigger 2 = any monitoring candle that closes beyond the previous
        // candle's high (BUY) / low (SELL) in the trend direction, with running
        // score above 50 — regardless of points or a new session extreme.
        if (qualifiedTime === null && delta >= 4 && brokeFor && score > 50) {
          qualifiedTime = c.time;
          entryLabel = 'Trigger 2';
          justQualified = true;
        }

        timeline.push({
          time: c.time,
          // The row's score is only known once the M30 candle closes.
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
        // Summary of the trigger H1 candle (shown where the old session ref was).
        refSession: {
          name: cur.name,
          start: trigger.time,
          end: curEndISO,
          open: trigger.open, high: trigger.high, low: trigger.low, close: trigger.close,
          bodyPct: refBodyPct, upperWickPct: refUpperWickPct, lowerWickPct: refLowerWickPct,
          rangePips: refRangePips, bodyPips: refBodyPips,
          direction: tBull ? 'BUY' : 'SELL',
        },
        currentSession: {
          name: cur.name,
          start: trackStartISO,
          end: curEndISO,
        },
        timeline,
        monitorCount: monCandles.length,
      });
    }

    // Sort by trigger time ascending (earliest break first); tie-break by
    // refBreakPips desc then triggerBreakPips desc. Every pair that gets here
    // has triggered, so the qualified/unqualified split the first comparison
    // used to make no longer separates anything.
    // Ranked by live score, strongest continuation first. Ties break on how far
    // the trigger cleared its level, then on which fired first.
    pairs.sort((a, b) => {
      // Earliest Trigger 2 first, then highest points (live score); no-T2 last.
      const as = a.strongConfirmTime;
      const bs = b.strongConfirmTime;
      if (as && !bs) return -1;
      if (!as && bs) return 1;
      if (as && bs && as !== bs) return as < bs ? -1 : 1;
      return b.currentScore - a.currentScore;
    });
    res.json({ pairs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
