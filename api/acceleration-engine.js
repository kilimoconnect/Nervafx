'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const VALID_PAIRS = new Set([
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
]);

const PHASES = {
  IDLE: 'idle',
  BIRTH: 'birth',
  GROWTH: 'growth',
  EXHAUSTION: 'exhaustion',
};

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const days = Math.min(30, parseInt(req.query?.days || '1', 10) || 1);
    const qFrom = req.query?.from;
    const qTo = req.query?.to;
    const until = qTo ? new Date(qTo + 'T23:59:59Z').toISOString() : new Date().toISOString();
    const since = qFrom ? new Date(qFrom + 'T00:00:00Z').toISOString()
      : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Extra lookback for lifecycle state buildup (2 hours of M15 bars = 8 bars)
    const fetchSince = new Date(new Date(since).getTime() - 2 * 3600000).toISOString();

    // Fetch M15 currency strength (45M smooth at 15-min intervals)
    const allStrength = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('m15_currency_strength')
        .select('time, values')
        .gte('time', fetchSince)
        .lte('time', until)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      allStrength.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    // Fetch hourly 3H smoothed strength for trend confirmation
    const h3Rows = [];
    let h3off = 0;
    while (true) {
      const { data, error } = await sb
        .from('currency_strength')
        .select('time, currency, smooth_3h')
        .gte('time', fetchSince)
        .lte('time', until)
        .order('time', { ascending: true })
        .range(h3off, h3off + PAGE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      h3Rows.push(...data);
      if (data.length < PAGE) break;
      h3off += PAGE;
    }

    const h3ByTime = {};
    for (const r of h3Rows) {
      if (!h3ByTime[r.time]) h3ByTime[r.time] = {};
      h3ByTime[r.time][r.currency] = (parseFloat(r.smooth_3h) || 0) * 10000;
    }
    const h3Timestamps = Object.keys(h3ByTime).sort();

    function getH3(ccy, atTime) {
      let best = null;
      for (let i = h3Timestamps.length - 1; i >= 0; i--) {
        if (h3Timestamps[i] <= atTime) { best = h3ByTime[h3Timestamps[i]]; break; }
      }
      return best ? (best[ccy] || 0) : 0;
    }

    // Fetch H1 candles for break confirmation
    const candleSince = new Date(new Date(fetchSince).getTime() - 2 * 3600000).toISOString();
    const h1Cache = {};
    const ALL_PAIRS = [...VALID_PAIRS];
    for (let b = 0; b < ALL_PAIRS.length; b += 7) {
      const batch = ALL_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const { data, error } = await sb
          .from('backtest_candles')
          .select('time, open, high, low, close')
          .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true)
          .gte('time', candleSince).lte('time', until)
          .order('time', { ascending: true }).limit(500);
        return { inst, data: error ? [] : data || [] };
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

    // Fetch M15 candles for break confirmation
    const m15Cache = {};
    for (let b = 0; b < ALL_PAIRS.length; b += 7) {
      const batch = ALL_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const allData = [];
        let off = 0;
        while (true) {
          const { data, error } = await sb
            .from('backtest_candles')
            .select('time, open, high, low, close')
            .eq('instrument', inst).eq('timeframe', 'M15').eq('complete', true)
            .gte('time', candleSince).lte('time', until)
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

    // Per-currency lifecycle state (persists across timestamps)
    const state = {};
    for (const ccy of CURRENCIES) {
      state[ccy] = {
        phase: PHASES.IDLE,
        direction: null,
        consecutiveCount: 0,
        peakAccel: 0,
        birthTime: null,
        prevAccel: 0,
      };
    }

    const rows = [];

    for (let t = 1; t < allStrength.length; t++) {
      const cur = allStrength[t];
      const prev = allStrength[t - 1];
      const time = cur.time;
      if (!cur.values || !prev.values) continue;

      const curVals = cur.values;
      const prevVals = prev.values;

      const ranking = [];

      for (const ccy of CURRENCIES) {
        const s45 = (parseFloat(curVals[ccy]) || 0) * 10000;
        const s45prev = (parseFloat(prevVals[ccy]) || 0) * 10000;
        const accel = s45 - s45prev;
        const accelR = Math.round(accel * 100) / 100;
        const s45R = Math.round(s45 * 100) / 100;
        const dir = accel > 0 ? 'bull' : accel < 0 ? 'bear' : null;
        const absAccel = Math.abs(accel);
        const st = state[ccy];

        if (!dir) {
          st.phase = PHASES.IDLE;
          st.direction = null;
          st.consecutiveCount = 0;
          st.peakAccel = 0;
          st.birthTime = null;
        } else if (dir !== st.direction) {
          st.phase = PHASES.BIRTH;
          st.direction = dir;
          st.consecutiveCount = 1;
          st.peakAccel = absAccel;
          st.birthTime = time;
        } else {
          st.consecutiveCount++;

          if (absAccel >= st.peakAccel) {
            st.peakAccel = absAccel;
            st.phase = st.consecutiveCount >= 2 ? PHASES.GROWTH : PHASES.BIRTH;
          } else if (absAccel < st.peakAccel * 0.6) {
            st.phase = PHASES.EXHAUSTION;
          } else if (st.consecutiveCount >= 2) {
            st.phase = PHASES.GROWTH;
          }
        }

        st.prevAccel = accel;

        ranking.push({
          currency: ccy,
          acceleration: accelR,
          s45: s45R,
          phase: st.phase,
          direction: st.direction,
          consecutive: st.consecutiveCount,
          peakAccel: Math.round(st.peakAccel * 100) / 100,
          birthTime: st.birthTime,
        });
      }

      // Skip timestamps before requested range (lookback was for state buildup)
      if (time < since) continue;

      // Score: normalize
      const maxAbs = Math.max(...ranking.map(a => Math.abs(a.acceleration)), 0.01);
      for (const a of ranking) {
        a.score = Math.round((a.acceleration / maxAbs) * 100);
      }

      ranking.sort((a, b) => b.acceleration - a.acceleration);

      // Detect ROTATION
      const exhausting = ranking.filter(a => a.phase === PHASES.EXHAUSTION);
      const emerging = ranking.filter(a => a.phase === PHASES.BIRTH || a.phase === PHASES.GROWTH);
      const rotations = [];
      for (const ex of exhausting) {
        for (const em of emerging) {
          if (ex.direction === em.direction) continue;
          rotations.push({
            from: ex.currency, fromPhase: ex.phase, fromDir: ex.direction,
            to: em.currency, toPhase: em.phase, toDir: em.direction,
          });
        }
      }

      // Detect LEADERSHIP
      const leaders = ranking
        .filter(a => a.phase === PHASES.GROWTH && a.birthTime)
        .sort((a, b) => a.birthTime < b.birthTime ? -1 : 1);
      const leaderCcys = new Set();
      if (leaders.length > 0) {
        const earliestBirth = leaders[0].birthTime;
        for (const l of leaders) {
          if (l.birthTime === earliestBirth) leaderCcys.add(l.currency);
        }
      }
      for (const a of ranking) {
        a.isLeader = leaderCcys.has(a.currency);
      }

      // Generate CONFIRMED pairs: Growth/Birth bulls vs Growth/Birth bears + break
      const bulls = ranking.filter(a =>
        a.direction === 'bull' && (a.phase === PHASES.GROWTH || a.phase === PHASES.BIRTH)
      ).sort((a, b) => b.s45 - a.s45);

      const bears = ranking.filter(a =>
        a.direction === 'bear' && (a.phase === PHASES.GROWTH || a.phase === PHASES.BIRTH)
      ).sort((a, b) => a.s45 - b.s45);

      const candidates = [];
      const topBulls = bulls.slice(0, 3);
      const topBears = bears.slice(0, 3);

      for (const strong of topBulls) {
        for (const weak of topBears) {
          const fwd = strong.currency + '_' + weak.currency;
          const rev = weak.currency + '_' + strong.currency;
          let inst, pair, direction;
          if (VALID_PAIRS.has(fwd)) {
            inst = fwd; pair = strong.currency + '/' + weak.currency; direction = 'BUY';
          } else if (VALID_PAIRS.has(rev)) {
            inst = rev; pair = weak.currency + '/' + strong.currency; direction = 'SELL';
          } else continue;

          // H1 break check
          const h1Candles = h1Cache[inst] || [];
          let h1ci = -1;
          for (let k = h1Candles.length - 1; k >= 0; k--) {
            if (h1Candles[k].time <= time) { h1ci = k; break; }
          }
          let h1Break = false;
          let h1Level = null;
          if (h1ci >= 1) {
            const h1c = h1Candles[h1ci];
            const h1p = h1Candles[h1ci - 1];
            if (direction === 'BUY' && h1c.close > h1p.high) { h1Break = true; h1Level = h1p.high; }
            else if (direction === 'SELL' && h1c.close < h1p.low) { h1Break = true; h1Level = h1p.low; }
          }

          // M15 break check
          const m15Candles = m15Cache[inst] || [];
          let m15ci = -1;
          for (let k = m15Candles.length - 1; k >= 0; k--) {
            if (m15Candles[k].time <= time) { m15ci = k; break; }
          }
          let m15Break = false;
          let m15Level = null;
          if (m15ci >= 1) {
            const m15c = m15Candles[m15ci];
            const m15p = m15Candles[m15ci - 1];
            if (direction === 'BUY' && m15c.close > m15p.high) { m15Break = true; m15Level = m15p.high; }
            else if (direction === 'SELL' && m15c.close < m15p.low) { m15Break = true; m15Level = m15p.low; }
          }

          if (!h1Break || !m15Break) continue;

          // 3H strength confirmation:
          // BUY = strongCcy accelerating up — strongCcy must be stronger on 3H
          // SELL = strongCcy up, weakCcy down — strongCcy must be stronger on 3H
          const strong3H = getH3(strong.currency, time);
          const weak3H = getH3(weak.currency, time);
          if (strong3H <= weak3H) continue;

          // Confidence score
          let confidence = 0;
          if (strong.phase === PHASES.GROWTH) confidence += 20;
          if (strong.phase === PHASES.BIRTH) confidence += 10;
          if (weak.phase === PHASES.GROWTH) confidence += 20;
          if (weak.phase === PHASES.BIRTH) confidence += 10;
          confidence += Math.min(strong.consecutive, 5) * 4;
          confidence += Math.min(weak.consecutive, 5) * 4;
          if (h1Break) confidence += 15;
          if (m15Break) confidence += 10;
          if (h1Break && m15Break) confidence += 10;
          if (strong.isLeader) confidence += 5;
          if (weak.isLeader) confidence += 5;
          if (strong.phase === PHASES.EXHAUSTION) confidence -= 20;
          if (weak.phase === PHASES.EXHAUSTION) confidence -= 20;
          confidence = Math.min(100, Math.max(0, confidence));

          const spread = Math.round((strong.s45 - weak.s45) * 100) / 100;

          // Body % from M15 candle
          let bodyPct = 0;
          if (m15ci >= 1) {
            const currBody = Math.abs(m15Candles[m15ci].close - m15Candles[m15ci].open);
            const prevBody = Math.abs(m15Candles[m15ci - 1].close - m15Candles[m15ci - 1].open) || 0.00001;
            bodyPct = Math.round((currBody / prevBody) * 100);
          }

          candidates.push({
            pair, direction,
            strongCcy: strong.currency, weakCcy: weak.currency,
            strongS45: strong.s45, weakS45: weak.s45,
            strongH3: Math.round(strong3H * 100) / 100,
            weakH3: Math.round(weak3H * 100) / 100,
            strongPhase: strong.phase, weakPhase: weak.phase,
            strongConsec: strong.consecutive, weakConsec: weak.consecutive,
            strongIsLeader: strong.isLeader, weakIsLeader: weak.isLeader,
            h1Break, h1Level, m15Break, m15Level,
            spread, bodyPct, confidence,
          });
        }
      }

      candidates.sort((a, b) => b.confidence - a.confidence || b.spread - a.spread);

      rows.push({
        time,
        ranking,
        candidates,
        rotations: rotations.length ? rotations : undefined,
      });
    }

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
