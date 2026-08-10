'use strict';

const { loadStrength, strengthGate } = require('./_strength-gate');
const { loadSharpReversalTriggers } = require('./_sharp-reversal-trigger');

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

// Candles are stamped with their OPEN time, but a break is only confirmed when
// the candle closes. This engine triggers on M15 (H1 is only used to build the
// synthetic H4 reference), so the signal fires 15 minutes after the trigger
// candle's timestamp.
const TRIGGER_TF_MS = 15 * 60 * 1000;
const closeTimeOf = iso => iso ? new Date(new Date(iso).getTime() + TRIGGER_TF_MS).toISOString() : null;

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

    // The one trigger for this engine — the Sharp Reversal engine evaluated at
    // the As-of time; it anchors to the reversal run active then.
    const h4WinStartISO = anchor ? anchor.toISOString() : new Date(Math.floor(now.getTime() / H4_MS) * H4_MS).toISOString();
    const atMs = req.query?.at ? new Date(req.query.at).getTime() : NaN;
    const srEvalISO = !isNaN(atMs)
      ? new Date(Math.min(atMs, new Date(fetchUntil).getTime())).toISOString()
      : fetchUntil;
    const srTriggers = await loadSharpReversalTriggers(sb, h4WinStartISO, srEvalISO);

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

    // Hourly 3H/6H/12H strength, keyed hour -> currency. This engine triggers
    // on M15, so the gate reads the previous completed hour — see the module.
    const strengthByHour = await loadStrength(sb, m15Since, fetchUntil);

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
      const pd = pipDiv(inst);
      const pair = inst.replace('_', '/');

      // Current H4 window start — no previous-H4 reference data.
      const trackStart = anchor
        ? anchor.toISOString()
        : new Date(Math.floor(now.getTime() / H4_MS) * H4_MS).toISOString();

      // One trigger, from the Sharp Reversal engine (Standard or Scalp, whichever
      // crossed first). Direction comes from that signal.
      const srTrig = srTriggers[inst];
      if (!srTrig) continue;
      let triggerMs = new Date(srTrig.triggerTime).getTime();
      if (isNaN(triggerMs)) continue;
      const direction = srTrig.direction;
      const refBreakPips = 0;

      // M15 candles for tracking.
      const m15all = m15Cache[inst] || [];
      if (!m15all.length) continue;

      const trackStartMs = new Date(trackStart).getTime();

      // Anchor monitoring to the M15 candle live when the Sharp Reversal fired.
      if (triggerMs < trackStartMs) triggerMs = trackStartMs;   // cross predates the H4 window → monitor from its start
      let triggerAllIdx = -1;
      for (let i = 0; i < m15all.length; i++) {
        if (new Date(m15all[i].time).getTime() <= triggerMs) triggerAllIdx = i; else break;
      }
      if (triggerAllIdx === -1) continue;   // no M15 at/before the trigger yet
      const trigger = m15all[triggerAllIdx];
      const m15s = m15all.slice(triggerAllIdx);
      const triggerIdx = 0;
      const triggerBreakPips = 0;

      // The trigger M15 candle IS the reference — back-inside and pullback are
      // judged against it and the move built from it, not a previous H4.
      const refHigh = trigger.high, refLow = trigger.low;
      const refRange = Math.max(trigger.high - trigger.low, pd);
      const triggerBull = trigger.close > trigger.open;
      const tBody = Math.abs(trigger.close - trigger.open);
      const refBodyPct = Math.round((tBody / refRange) * 100);
      const upperWickPct = Math.round(((trigger.high - Math.max(trigger.open, trigger.close)) / refRange) * 100);
      const lowerWickPct = Math.round(((Math.min(trigger.open, trigger.close) - trigger.low) / refRange) * 100);
      const refRangePips = Math.round((refRange / pd) * 10) / 10;
      const refBodyPips = Math.round((tBody / pd) * 10) / 10;

      // Initial score — baseline + body alignment.
      let score = 50;
      score += 20;
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
        const backInside = c.close < refHigh && c.close > refLow;

        const cBull = c.close > c.open;
        const cBody = Math.abs(c.close - c.open);
        const cBodyPips = Math.round((cBody / pd) * 10) / 10;
        const cRange = c.high - c.low;
        let delta = 0;
        const events = [];

        // Bigger than any other single event, since this was previously fatal.
        if (backInside) { delta -= 8; events.push('Back inside prev H4 range'); }

        // Strength gate, scored rather than fatal here: a stretch where neither
        // currency holds conviction weakens the case without ending a run that
        // may well reassert itself.
        const cStrength = strengthGate(strengthByHour, inst, direction, new Date(c.time).getTime(), TRIGGER_TF_MS);
        if (!cStrength.ok) { delta -= 5; events.push('No strength conviction'); }

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
        // Looking for Trigger 2: delta >= +6 AND running score above 75.
        // Trigger 2 = any candle closing beyond the previous candle's high
        // (BUY) / low (SELL) in the trend direction, score > 50, points aside.
        if (qualifiedTime === null && delta >= 4 && brokeFor && score > 50) {
          qualifiedTime = c.time;
          entryLabel = 'Trigger 2';
          justQualified = true;
        }

        timeline.push({
          time: c.time,
          // The row's score is only known once the candle closes.
          closeTime: closeTimeOf(c.time),
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
        // Summary of the trigger M15 candle (shown where the old H4 ref row was).
        refHour: {
          time: trigger.time,
          open: trigger.open, high: trigger.high, low: trigger.low, close: trigger.close,
          bodyPct: refBodyPct, upperWickPct, lowerWickPct,
          rangePips: refRangePips, bodyPips: refBodyPips,
          direction: triggerBull ? 'BUY' : 'SELL',
        },
        timeline,
        m15Count: m15s.length - triggerIdx,
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
