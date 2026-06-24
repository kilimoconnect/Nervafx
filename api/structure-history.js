'use strict';

/**
 * GET /api/structure-history
 *
 * Layer 10 — Historical Review + Layer 11 — Forecast, from structure_snapshots.
 *
 * Modes:
 *   ?pair=EUR_USD          → 24h evolution + trend age + forecast for one pair
 *   ?view=7d               → 7-day review: best/worst pairs, most persistent trends
 *   ?view=session          → per-session (Asia/London/NY) averages
 *   (default)              → latest snapshot summary + counts
 */

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');
const engine = require('./structure-engine');

function getSession(h) {
  if (h >= 21 || h < 7) return 'ASIA';
  if (h >= 7 && h < 13) return 'LONDON';
  return 'NEW_YORK';
}

const fmtP = p => p == null ? null : (Math.abs(p) >= 50 ? +p.toFixed(2) : +p.toFixed(5));

// Trend maturity phase from age vs average run length
function maturityPhase(pct) {
  if (pct == null) return 'UNKNOWN';
  if (pct < 40) return 'YOUNG';
  if (pct < 80) return 'DEVELOPING';
  if (pct <= 110) return 'MATURE';
  return 'OVEREXTENDED';
}

// Build a human "trend evolution" story from the 24h state sequence (oldest→newest)
function evolutionNarrative(asc) {
  const out = [];
  let prevState = null, prevTrend = null;
  for (let i = 0; i < asc.length; i++) {
    const r = asc[i];
    const phrases = [];
    if (i === 0) phrases.push(`${cap(r.trend)} structure`);
    if (r.trend !== prevTrend && i > 0) phrases.push(`shift to ${cap(r.trend)}`);
    if (r.choch) phrases.push('character change (CHoCH)');
    if (r.bos_direction) phrases.push('break of structure');
    if (r.market_state !== prevState) phrases.push(stateStory(r.market_state));
    if (phrases.length) out.push({ time: r.time_utc, text: phrases.join(' · ') });
    prevState = r.market_state; prevTrend = r.trend;
  }
  return out.slice(-8);
}
const cap = s => s ? s.charAt(0) + s.slice(1).toLowerCase() : s;
function stateStory(s) {
  return ({
    COMPRESSION: 'compression building', ACCUMULATION: 'accumulation',
    EXPANSION: 'expansion begins', TREND: 'trend running',
    LATE_TREND: 'trend maturing', EXHAUSTION: 'exhaustion appears',
    REVERSAL_RISK: 'reversal risk', CHOPPY: 'choppy / no edge',
  })[s] || (s || '').toLowerCase().replace('_', ' ');
}

// Trend age: how many consecutive most-recent snapshots share the latest trend
function trendAge(rows) {
  if (!rows.length) return 0;
  const latest = rows[0].trend;
  let age = 0;
  for (const r of rows) { if (r.trend === latest) age++; else break; }
  return age;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const pair = req.query?.pair || null;
    const view = req.query?.view || null;
    const at = req.query?.at || null;

    // ── Historical snapshot of all pairs at a chosen hour ────────────────────
    if (at) {
      const d = new Date(at);
      d.setUTCMinutes(0, 0, 0);
      const hourStart = d.toISOString();
      const hourEnd = new Date(d.getTime() + 3600000).toISOString();
      const { data, error } = await sb
        .from('structure_snapshots')
        .select('*')
        .gte('time_utc', hourStart)
        .lt('time_utc', hourEnd);
      if (error) throw error;
      const rows = data || [];
      if (!rows.length) return res.json({ generatedAt: hourStart, historical: true, pairs: [], currencies: {}, approvedCount: 0, note: 'no snapshot at this hour' });

      const pairResults = {};
      for (const r of rows) pairResults[r.instrument] = { trend: r.trend, structureScore: r.structure_score };
      const currencies = engine.aggregateCurrencies(pairResults);

      const pairs = rows.map(r => ({
        instrument: r.instrument,
        trend: r.trend,
        structureScore: r.structure_score,
        structureLabel: r.structure_label,
        state: r.market_state,
        trendValid: r.trend_valid,
        bos: r.bos_direction ? { direction: r.bos_direction, level: r.bos_level } : null,
        choch: r.choch || null,
        efficiency: r.efficiency, persistence: r.persistence, expansion: r.expansion, pullbackQuality: r.pullback_quality,
        nearestSupport: r.nearest_support != null ? { price: r.nearest_support } : null,
        nearestResistance: r.nearest_resistance != null ? { price: r.nearest_resistance } : null,
        invalidation: r.invalidation,
        price: null,
        m15: r.m15_score != null ? { score: r.m15_score, state: r.m15_state } : null,
        approval: { approved: !!r.trade_approved, reasons: [] },
      })).sort((a, b) => b.structureScore - a.structureScore);

      return res.json({
        generatedAt: hourStart, historical: true,
        pairs, currencies,
        approvedCount: pairs.filter(p => p.approval.approved).length,
      });
    }

    // ── Per-pair 24h evolution + forecast ────────────────────────────────────
    if (pair) {
      const since = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
      const { data, error } = await sb
        .from('structure_snapshots')
        .select('*')
        .eq('instrument', pair)
        .gte('time_utc', since)
        .order('time_utc', { ascending: false })
        .limit(200);
      if (error) throw error;
      const rows = data || [];
      if (!rows.length) return res.json({ pair, history: [], forecast: null, note: 'no history yet' });

      const last24 = rows.filter(r => new Date(r.time_utc) >= new Date(Date.now() - 24 * 3600000));
      const currentAge = trendAge(rows);

      // Historical average trend run-length for this pair (over the stored window)
      const runs = [];
      let run = 0, prev = null;
      // iterate oldest→newest
      for (const r of [...rows].reverse()) {
        if (r.trend === prev) run++;
        else { if (run) runs.push(run); run = 1; prev = r.trend; }
      }
      if (run) runs.push(run);
      const avgRun = runs.length ? runs.reduce((s, x) => s + x, 0) / runs.length : 0;

      // Forecast: continuation vs exhaustion from age relative to average
      let continuation = null, exhaustion = null;
      if (avgRun > 0) {
        const ratio = currentAge / avgRun;
        continuation = Math.max(5, Math.min(95, Math.round(100 - ratio * 55)));
        exhaustion = 100 - continuation;
      }
      // Breakout success: of past BOS snapshots, how many were followed by a higher structure score next hour
      let bosTotal = 0, bosSuccess = 0;
      const asc = [...rows].reverse();
      for (let i = 0; i < asc.length - 1; i++) {
        if (asc[i].bos_direction) {
          bosTotal++;
          if ((asc[i + 1].structure_score || 0) >= (asc[i].structure_score || 0)) bosSuccess++;
        }
      }
      const breakoutSuccess = bosTotal ? Math.round((bosSuccess / bosTotal) * 100) : null;

      // Live structural detail for this pair (levels, swings, BOS age, trend health …)
      let live = null;
      try {
        const [h1q, m15q] = await Promise.all([
          sb.from('backtest_candles').select('time, open, high, low, close')
            .eq('instrument', pair).eq('timeframe', 'H1').eq('complete', true)
            .order('time', { ascending: false }).limit(500),
          sb.from('backtest_candles').select('time, open, high, low, close')
            .eq('instrument', pair).eq('timeframe', 'M15').eq('complete', true)
            .order('time', { ascending: false }).limit(40),
        ]);
        const map = c => ({ time: c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close });
        live = engine.analysePair((h1q.data || []).map(map).reverse(), (m15q.data || []).map(map).reverse());
      } catch (_) { /* fall back to stored snapshot */ }

      const r0 = rows[0];
      const trend = live?.trend || r0.trend;
      const dir = trend === 'BULLISH' ? 'higher' : trend === 'BEARISH' ? 'lower' : 'sideways';
      const support = live?.nearestSupport || (r0.nearest_support != null ? { price: r0.nearest_support } : null);
      const resistance = live?.nearestResistance || (r0.nearest_resistance != null ? { price: r0.nearest_resistance } : null);
      const invalidation = live?.invalidation ?? r0.invalidation;
      const target = live?.nextTarget ?? null;
      const health = live?.trendHealth ?? null;

      // Trend maturity
      const maturityPct = avgRun > 0 ? Math.round((currentAge / avgRun) * 100) : null;
      const maturity = maturityPhase(maturityPct);

      // Continuation drivers & risk factors
      const drivers = [], risks = [];
      if ((live?.trendValid || r0.trend_valid) === 'VALID') drivers.push('Trend still valid');
      else risks.push('Trend validation weakening');
      if (trend === 'BEARISH' && resistance) drivers.push('Resistance holding above');
      if (trend === 'BULLISH' && support) drivers.push('Support holding below');
      if (!live?.choch && !r0.choch) drivers.push(`No ${trend === 'BEARISH' ? 'bullish' : 'bearish'} CHoCH`);
      else risks.push('Opposing CHoCH printed');
      if ((live?.efficiency ?? r0.efficiency) >= 55) drivers.push('Directional efficiency strong');
      else risks.push('Directional efficiency fading');
      if ((live?.persistence ?? r0.persistence) >= 60) drivers.push('Persistence strong');
      if ((live?.pullbackQuality ?? r0.pullback_quality) < 55) risks.push('Pullbacks becoming deeper');
      if (maturityPct != null && maturityPct >= 90) risks.push('Trend age at/over average lifespan');
      if ((live?.state || r0.market_state) === 'EXHAUSTION') risks.push('Exhaustion signs present');

      // Scenario forecast (probabilities normalised to 100)
      let scenarios = [];
      if (continuation != null) {
        let pCont = continuation;
        let pRange = Math.round((100 - pCont) * 0.65);
        let pRev = 100 - pCont - pRange;
        scenarios = [
          { type: 'Continuation', prob: pCont,
            text: `Continuation ${dir}${target ? ' toward ' + fmtP(target) : ''}${resistance && trend === 'BEARISH' ? ' while ' + fmtP(resistance.price) + ' caps' : ''}${support && trend === 'BULLISH' ? ' while ' + fmtP(support.price) + ' holds' : ''}` },
          { type: 'Range', prob: pRange,
            text: support && resistance ? `Range between ${fmtP(support.price)} and ${fmtP(resistance.price)}` : 'Range / consolidation' },
          { type: 'Reversal', prob: pRev,
            text: `${trend === 'BEARISH' ? 'Bullish' : 'Bearish'} CHoCH ${trend === 'BEARISH' ? 'above ' + fmtP(invalidation) : 'below ' + fmtP(invalidation)}` },
        ].sort((a, b) => b.prob - a.prob);
      }

      return res.json({
        pair,
        summary: {
          direction: trend,
          structureScore: live?.structureScore ?? r0.structure_score,
          structureLabel: live?.structureLabel ?? r0.structure_label,
          marketState: live?.state ?? r0.market_state,
          trendValid: live?.trendValid ?? r0.trend_valid,
          trendHealth: health,
          trendHealthParts: live ? { de: live.efficiency, persistence: live.persistence, pullback: live.pullbackQuality } : null,
          trendAgeHours: currentAge,
          avgTrendAgeHours: Math.round(avgRun * 10) / 10,
          trendMaturityPct: maturityPct,
          trendMaturity: maturity,
        },
        priceAction: {
          price: fmtP(live?.price ?? null),
          lastBOS: live?.bos ? { level: fmtP(live.bos.level), direction: live.bos.direction, ageHours: live.bos.ageHours } : null,
          lastCHoCH: live?.choch || r0.choch || null,
          swingHigh: fmtP(live?.swingHigh ?? null),
          swingLow: fmtP(live?.swingLow ?? null),
        },
        levels: {
          support: support ? { price: fmtP(support.price), strength: support.strength || null, touches: support.touches ?? null } : null,
          resistance: resistance ? { price: fmtP(resistance.price), strength: resistance.strength || null, touches: resistance.touches ?? null } : null,
          invalidation: fmtP(invalidation),
          nextTarget: fmtP(target),
        },
        forecast: {
          currentTrend: trend,
          continuationProbability: continuation,
          exhaustionProbability: exhaustion,
          breakoutSuccessProbability: breakoutSuccess,
          drivers, risks, scenarios,
        },
        evolution: evolutionNarrative(asc),
        history: last24.map(r => ({
          time: r.time_utc, score: r.structure_score, label: r.structure_label,
          trend: r.trend, state: r.market_state, trendValid: r.trend_valid,
          bos: r.bos_direction, choch: r.choch, m15Score: r.m15_score, approved: r.trade_approved,
        })),
      });
    }

    // ── 7-day review ─────────────────────────────────────────────────────────
    if (view === '7d') {
      const since = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
      const { data, error } = await sb
        .from('structure_snapshots')
        .select('instrument, structure_score, trend, bos_direction, trade_approved, time_utc')
        .gte('time_utc', since)
        .order('time_utc', { ascending: false })
        .limit(20000);
      if (error) throw error;
      const rows = data || [];

      const byPair = {};
      for (const r of rows) {
        const p = (byPair[r.instrument] ||= { scores: [], approvals: 0, bos: 0, n: 0 });
        p.scores.push(r.structure_score || 0);
        if (r.trade_approved) p.approvals++;
        if (r.bos_direction) p.bos++;
        p.n++;
      }
      const summary = Object.entries(byPair).map(([instrument, p]) => ({
        instrument,
        avgScore: Math.round(p.scores.reduce((s, x) => s + x, 0) / p.scores.length),
        approvals: p.approvals,
        bosEvents: p.bos,
        snapshots: p.n,
      }));
      summary.sort((a, b) => b.avgScore - a.avgScore);

      return res.json({
        view: '7d',
        best: summary.slice(0, 5),
        worst: summary.slice(-5).reverse(),
        mostApproved: [...summary].sort((a, b) => b.approvals - a.approvals).slice(0, 5),
        mostBreakouts: [...summary].sort((a, b) => b.bosEvents - a.bosEvents).slice(0, 5),
      });
    }

    // ── Session review ───────────────────────────────────────────────────────
    if (view === 'session') {
      const since = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
      const { data, error } = await sb
        .from('structure_snapshots')
        .select('structure_score, expansion, bos_direction, time_utc')
        .gte('time_utc', since)
        .limit(20000);
      if (error) throw error;
      const buckets = { ASIA: [], LONDON: [], NEW_YORK: [] };
      for (const r of data || []) {
        const s = getSession(new Date(r.time_utc).getUTCHours());
        buckets[s].push(r);
      }
      const out = {};
      for (const [s, arr] of Object.entries(buckets)) {
        const n = arr.length || 1;
        out[s] = {
          avgStructure: Math.round(arr.reduce((x, r) => x + (r.structure_score || 0), 0) / n),
          avgExpansion: Math.round(arr.reduce((x, r) => x + (r.expansion || 0), 0) / n),
          bosEvents: arr.filter(r => r.bos_direction).length,
          snapshots: arr.length,
        };
      }
      return res.json({ view: 'session', sessions: out });
    }

    // ── Default: latest snapshot summary ─────────────────────────────────────
    const { data: latest } = await sb
      .from('structure_snapshots')
      .select('time_utc').order('time_utc', { ascending: false }).limit(1);
    const latestTime = latest?.[0]?.time_utc || null;
    let counts = { total: 0, approved: 0 };
    if (latestTime) {
      const { data } = await sb
        .from('structure_snapshots')
        .select('trade_approved').eq('time_utc', latestTime);
      counts = { total: (data || []).length, approved: (data || []).filter(r => r.trade_approved).length };
    }
    return res.json({ latestTime, ...counts });
  } catch (e) {
    console.error('[STRUCTURE-HISTORY]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 30;
