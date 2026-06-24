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

function getSession(h) {
  if (h >= 21 || h < 7) return 'ASIA';
  if (h >= 7 && h < 13) return 'LONDON';
  return 'NEW_YORK';
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

      return res.json({
        pair,
        history: last24.map(r => ({
          time: r.time_utc, score: r.structure_score, label: r.structure_label,
          trend: r.trend, state: r.market_state, trendValid: r.trend_valid,
          bos: r.bos_direction, choch: r.choch, m15Score: r.m15_score,
          approved: r.trade_approved,
        })),
        forecast: {
          currentTrend: rows[0].trend,
          trendAgeHours: currentAge,
          avgTrendAgeHours: Math.round(avgRun * 10) / 10,
          continuationProbability: continuation,
          exhaustionProbability: exhaustion,
          breakoutSuccessProbability: breakoutSuccess,
        },
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
