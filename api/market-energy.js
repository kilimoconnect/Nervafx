'use strict';

/**
 * GET /api/market-energy
 *
 * Returns the most recent completed row per session from market_energy_sessions,
 * augmented with session-relative context:
 *   norm_*     — % deviation from that session's own historical average
 *   prev_*     — delta vs the previous occurrence of the SAME session (not cross-session)
 *
 * Also returns expansionPressure with multi-factor score and carryOver energy chain.
 */

const { getClient, cors } = require('./_db');

const SESSION_ORDER    = ['ASIA', 'LONDON', 'NEW_YORK', 'LOW_LIQUIDITY'];
const SESS_LABEL       = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York' };
const SESS_NEXT        = { ASIA: 'LONDON', LONDON: 'NEW_YORK', NEW_YORK: 'ASIA' };
const COMPRESSED_CYCLE = new Set(['DEAD', 'COMPRESSION', 'LOW_PARTICIPATION']);

function r(v) { return Math.round(parseFloat(v) || 0); }

function avgField(arr, field) {
  if (!arr.length) return 0;
  return arr.reduce((s, row) => s + (parseFloat(row[field]) || 0), 0) / arr.length;
}

/** % deviation of current value from a reference (avg or prev). Null if no reference or extreme. */
function pctVsRef(current, ref) {
  if (!ref) return null;
  const pct = Math.round((current / ref - 1) * 100);
  return Math.abs(pct) > 200 ? null : pct; // cap: near-zero ref produces meaningless extremes
}

/**
 * Multi-factor expansion pressure.
 * COMPRESSED_CYCLE now includes LOW_PARTICIPATION since thin Asia counts.
 * Factors:
 *   0.35 – streak persistence
 *   0.25 – agreement during compression (organized suppression = more coiled)
 *   0.25 – volatility suppression (low vol = coiling)
 *   0.15 – session transition quality (London next = 80, NY = 65, Asia = 30)
 */
function computeExpansionPressure(sequence) {
  const trailing = [];
  for (let i = sequence.length - 1; i >= 0; i--) {
    if (COMPRESSED_CYCLE.has(sequence[i].energy_cycle)) {
      trailing.unshift(sequence[i]);
    } else {
      break;
    }
  }

  // Carry-over: last 5 sessions to show energy progression
  const carryOver = sequence.slice(-5).map(s => ({
    session: SESS_LABEL[s.session_name] || s.session_name,
    energy:  r(s.market_energy),
    breadth: r(s.breadth_score),
    cycle:   s.energy_cycle,
  }));

  const streak = trailing.length;
  if (streak === 0) {
    return { streak: 0, score: 0, risk: 'NONE', chain: [], cycles: [], carryOver, factors: null };
  }

  const streakScore    = Math.min(100, streak * 34);
  const agrPersistence = avgField(trailing, 'agreement_score');
  const volSuppression = Math.max(0, 100 - avgField(trailing, 'volatility_score'));

  const lastSessName    = trailing[trailing.length - 1]?.session_name;
  const nextSessName    = SESS_NEXT[lastSessName] || 'LONDON';
  const transitionBonus = nextSessName === 'LONDON'  ? 80
                        : nextSessName === 'NEW_YORK' ? 65
                        :                              30;

  const score = Math.round(
    0.35 * streakScore     +
    0.25 * agrPersistence  +
    0.25 * volSuppression  +
    0.15 * transitionBonus
  );

  const risk  = score >= 70 ? 'HIGH'
              : score >= 50 ? 'BUILDING'
              : score >= 25 ? 'LOW'
              :               'MINIMAL';

  return {
    streak, score, risk,
    chain:   trailing.map(s => SESS_LABEL[s.session_name] || s.session_name),
    cycles:  trailing.map(s => s.energy_cycle),
    carryOver,
    factors: {
      streakScore:    Math.round(streakScore),
      agrPersistence: Math.round(agrPersistence),
      volSuppression: Math.round(volSuppression),
      transitionBonus,
    },
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  try {
    const sb    = getClient();
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const cols  =
      'session_date, session_name, session_start, session_end, ' +
      'movement_score, breadth_score, agreement_score, volatility_score, ' +
      'acceleration_score, compression_score, compression_streak, ' +
      'expansion_readiness, market_energy, energy_cycle, active_pairs, ' +
      'bullish_breadth, bearish_breadth, ' +
      'dominance_score, strongest_ccy, weakest_ccy';

    // 14 days to ensure enough historical rows per session for a meaningful baseline
    const { data, error } = await sb
      .from('market_energy_sessions')
      .select(cols)
      .gte('session_date', since)
      .order('session_date',  { ascending: false })
      .order('session_start', { ascending: false });

    if (error) throw error;

    const rows = data || [];

    // ── Per-session history (newest-first within each name) ───────────────────
    const histBySession = {};
    for (const row of rows) {
      const n = row.session_name;
      if (!histBySession[n]) histBySession[n] = [];
      histBySession[n].push(row);
    }

    // Most recent row per session_name
    const bySession = {};
    for (const [name, sessRows] of Object.entries(histBySession)) {
      bySession[name] = sessRows[0];
    }

    // ── Session-relative baselines ────────────────────────────────────────────
    // Exclude the current (most recent) row from the historical average so we
    // can meaningfully compare "this Asia vs typical Asia."
    const sessionBaselines = {};
    for (const [name, sessRows] of Object.entries(histBySession)) {
      const baseline = sessRows.slice(1); // historical rows, newest-first
      const prev     = sessRows[1] || null;
      if (!baseline.length) { sessionBaselines[name] = null; continue; }
      sessionBaselines[name] = {
        avg_movement:   avgField(baseline, 'movement_score'),
        avg_breadth:    avgField(baseline, 'breadth_score'),
        avg_agreement:  avgField(baseline, 'agreement_score'),
        avg_volatility: avgField(baseline, 'volatility_score'),
        avg_energy:     avgField(baseline, 'market_energy'),
        prev_row:       prev,
        n:              baseline.length,
      };
    }

    // ── Build augmented session cards ─────────────────────────────────────────
    const sessions = SESSION_ORDER.map(name => {
      const row = bySession[name];
      if (!row) return null;

      const bl  = sessionBaselines[name];
      let rel   = {};

      if (bl) {
        // % vs historical session average (this session vs its own typical behavior)
        rel.norm_movement   = pctVsRef(row.movement_score,  bl.avg_movement);
        rel.norm_breadth    = pctVsRef(row.breadth_score,   bl.avg_breadth);
        rel.norm_agreement  = pctVsRef(row.agreement_score, bl.avg_agreement);
        rel.norm_volatility = pctVsRef(row.volatility_score,bl.avg_volatility);
        rel.norm_energy     = pctVsRef(row.market_energy,   bl.avg_energy);
        rel.baseline_n      = bl.n;

        // % vs previous occurrence of the SAME session (Asia vs last Asia, not vs London)
        if (bl.prev_row) {
          rel.prev_movement  = pctVsRef(row.movement_score,  bl.prev_row.movement_score);
          rel.prev_breadth   = pctVsRef(row.breadth_score,   bl.prev_row.breadth_score);
          rel.prev_agreement = pctVsRef(row.agreement_score, bl.prev_row.agreement_score);
          rel.prev_energy    = pctVsRef(row.market_energy,   bl.prev_row.market_energy);
        }
      }

      return { ...row, ...rel };
    }).filter(Boolean);

    // ── Chronological sequence for pressure panel ─────────────────────────────
    const sequence = rows
      .filter(r => r.session_name !== 'LOW_LIQUIDITY')
      .reverse()   // oldest → newest
      .slice(-8);

    const expansionPressure = computeExpansionPressure(sequence);

    res.json({ sessions, expansionPressure });
  } catch (e) {
    console.error('[MARKET-ENERGY]', e.message);
    res.status(500).json({ error: e.message });
  }
};
