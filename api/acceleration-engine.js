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

    const days = Math.min(30, parseInt(req.query?.days || '2', 10) || 2);
    const qFrom = req.query?.from;
    const qTo = req.query?.to;
    const until = qTo ? new Date(qTo + 'T23:59:59Z').toISOString() : new Date().toISOString();
    const since = qFrom ? new Date(qFrom + 'T00:00:00Z').toISOString()
      : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Extra lookback for lifecycle state buildup
    const fetchSince = new Date(new Date(since).getTime() - 6 * 3600000).toISOString();

    // Fetch hourly currency strength
    const allRows = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('currency_strength')
        .select('time, currency, smooth_3h')
        .gte('time', fetchSince)
        .lte('time', until)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      allRows.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    const byTime = {};
    for (const r of allRows) {
      if (!byTime[r.time]) byTime[r.time] = {};
      byTime[r.time][r.currency] = (parseFloat(r.smooth_3h) || 0) * 10000;
    }

    // Fetch H1 candles for break confirmation
    const candleSince = new Date(new Date(fetchSince).getTime() - 2 * 3600000).toISOString();
    const candleCache = {};
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
        candleCache[inst] = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
      }
    }

    // Fetch M15 candles for cross-timeframe confirmation
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

    const timestamps = Object.keys(byTime).sort();

    // Per-currency lifecycle state (persists across timestamps)
    const state = {};
    for (const ccy of CURRENCIES) {
      state[ccy] = {
        phase: PHASES.IDLE,
        direction: null,       // 'bull' or 'bear'
        consecutiveCount: 0,
        peakAccel: 0,
        birthTime: null,
        prevAccel: 0,
      };
    }

    const rows = [];

    for (let t = 1; t < timestamps.length; t++) {
      const time = timestamps[t];
      const prevTime = timestamps[t - 1];
      const cur = byTime[time];
      const prev = byTime[prevTime];
      if (!cur || !prev) continue;
      if (Object.keys(cur).length < 8 || Object.keys(prev).length < 8) continue;

      const ranking = [];

      for (const ccy of CURRENCIES) {
        const s3 = cur[ccy] || 0;
        const s3prev = prev[ccy] || 0;
        const accel = s3 - s3prev;
        const accelR = Math.round(accel * 100) / 100;
        const s3R = Math.round(s3 * 100) / 100;
        const dir = accel > 0 ? 'bull' : accel < 0 ? 'bear' : null;
        const absAccel = Math.abs(accel);
        const st = state[ccy];

        // Phase transition logic
        if (!dir) {
          // No acceleration — reset to idle
          st.phase = PHASES.IDLE;
          st.direction = null;
          st.consecutiveCount = 0;
          st.peakAccel = 0;
          st.birthTime = null;
        } else if (dir !== st.direction) {
          // Direction changed — BIRTH of new cycle
          st.phase = PHASES.BIRTH;
          st.direction = dir;
          st.consecutiveCount = 1;
          st.peakAccel = absAccel;
          st.birthTime = time;
        } else {
          // Same direction continues
          st.consecutiveCount++;

          if (absAccel >= st.peakAccel) {
            // Acceleration still growing — GROWTH
            st.peakAccel = absAccel;
            st.phase = st.consecutiveCount >= 2 ? PHASES.GROWTH : PHASES.BIRTH;
          } else if (absAccel < st.peakAccel * 0.6) {
            // Acceleration dropped significantly — EXHAUSTION
            st.phase = PHASES.EXHAUSTION;
          } else if (st.consecutiveCount >= 2) {
            // Holding but not growing — still GROWTH
            st.phase = PHASES.GROWTH;
          }
        }

        st.prevAccel = accel;

        ranking.push({
          currency: ccy,
          acceleration: accelR,
          s3: s3R,
          phase: st.phase,
          direction: st.direction,
          consecutive: st.consecutiveCount,
          peakAccel: Math.round(st.peakAccel * 100) / 100,
          birthTime: st.birthTime,
        });
      }

      // Skip timestamps before requested range (we used lookback for state buildup)
      if (time < since) continue;

      // Score: normalize
      const maxAbs = Math.max(...ranking.map(a => Math.abs(a.acceleration)), 0.01);
      for (const a of ranking) {
        a.score = Math.round((a.acceleration / maxAbs) * 100);
      }

      // Sort ranking by acceleration descending
      ranking.sort((a, b) => b.acceleration - a.acceleration);

      // Detect ROTATION: any currency entering Exhaustion while another enters Birth/Growth
      const exhausting = ranking.filter(a => a.phase === PHASES.EXHAUSTION);
      const emerging = ranking.filter(a => a.phase === PHASES.BIRTH || a.phase === PHASES.GROWTH);
      const rotations = [];
      for (const ex of exhausting) {
        for (const em of emerging) {
          if (ex.direction === em.direction) continue; // same direction = not rotation
          rotations.push({
            from: ex.currency,
            fromPhase: ex.phase,
            fromDir: ex.direction,
            to: em.currency,
            toPhase: em.phase,
            toDir: em.direction,
          });
        }
      }

      // Detect LEADERSHIP: earliest birthTime among Growth currencies
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
      ).sort((a, b) => b.s3 - a.s3);

      const bears = ranking.filter(a =>
        a.direction === 'bear' && (a.phase === PHASES.GROWTH || a.phase === PHASES.BIRTH)
      ).sort((a, b) => a.s3 - b.s3);

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
          const h1Candles = candleCache[inst] || [];
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

          if (!h1Break && !m15Break) continue;

          // Confidence score
          let confidence = 0;
          // Phase scoring
          if (strong.phase === PHASES.GROWTH) confidence += 20;
          if (strong.phase === PHASES.BIRTH) confidence += 10;
          if (weak.phase === PHASES.GROWTH) confidence += 20;
          if (weak.phase === PHASES.BIRTH) confidence += 10;
          // Consecutive periods
          confidence += Math.min(strong.consecutive, 5) * 4;
          confidence += Math.min(weak.consecutive, 5) * 4;
          // Break alignment
          if (h1Break) confidence += 15;
          if (m15Break) confidence += 10;
          if (h1Break && m15Break) confidence += 10; // bonus for both
          // Leadership
          if (strong.isLeader) confidence += 5;
          if (weak.isLeader) confidence += 5;
          // Exhaustion penalty (shouldn't happen but safety)
          if (strong.phase === PHASES.EXHAUSTION) confidence -= 20;
          if (weak.phase === PHASES.EXHAUSTION) confidence -= 20;

          confidence = Math.min(100, Math.max(0, confidence));

          const spread = Math.round((strong.s3 - weak.s3) * 100) / 100;

          // Body % from H1
          let bodyPct = 0;
          if (h1ci >= 1) {
            const currBody = Math.abs(h1Candles[h1ci].close - h1Candles[h1ci].open);
            const prevBody = Math.abs(h1Candles[h1ci - 1].close - h1Candles[h1ci - 1].open) || 0.00001;
            bodyPct = Math.round((currBody / prevBody) * 100);
          }

          candidates.push({
            pair, direction,
            strongCcy: strong.currency, weakCcy: weak.currency,
            strongS3: strong.s3, weakS3: weak.s3,
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
