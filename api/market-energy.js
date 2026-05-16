'use strict';

/**
 * GET /api/market-energy
 *
 * Returns the most recent completed row per session from market_energy_sessions
 * (ASIA, LONDON, NEW_YORK, LOW_LIQUIDITY), ordered for display.
 *
 * Response: { sessions: [...], expansionPressure: { streak, score, risk, chain,
 *   cycles, carryOver, factors } }
 *
 * Each session row is augmented with delta_movement / delta_breadth /
 * delta_agreement / delta_energy (vs the immediately preceding active session).
 */

const { getClient, cors } = require('./_db');

const SESSION_ORDER    = ['ASIA', 'LONDON', 'NEW_YORK', 'LOW_LIQUIDITY'];
const SESS_LABEL       = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York' };
const SESS_NEXT        = { ASIA: 'LONDON', LONDON: 'NEW_YORK', NEW_YORK: 'ASIA' };
const COMPRESSED_CYCLE = new Set(['DEAD', 'COMPRESSION', 'PRESSURE_BUILDING']);

function round1(v) { return Math.round(parseFloat(v) || 0); }
function avg(arr, field) {
  if (!arr.length) return 0;
  return arr.reduce((s, r) => s + (parseFloat(r[field]) || 0), 0) / arr.length;
}

/**
 * Multi-factor expansion pressure.
 * Factors:
 *   0.35 – streak persistence   (how many consecutive compressed sessions)
 *   0.25 – agreement persistence (high agreement during compression = organized suppression)
 *   0.25 – volatility suppression (low vol = coiling energy)
 *   0.15 – session transition quality (London next = 80, NY next = 65, Asia = 30)
 */
function computeExpansionPressure(sequence) {
  // Trailing run of compressed sessions, working backwards
  const trailing = [];
  for (let i = sequence.length - 1; i >= 0; i--) {
    if (COMPRESSED_CYCLE.has(sequence[i].energy_cycle)) {
      trailing.unshift(sequence[i]);
    } else {
      break;
    }
  }

  // Carry-over: last 5 sessions (or fewer) to show energy/breadth progression
  const carryOver = sequence.slice(-5).map(s => ({
    session: SESS_LABEL[s.session_name] || s.session_name,
    energy:  round1(s.market_energy),
    breadth: round1(s.breadth_score),
    cycle:   s.energy_cycle,
  }));

  const streak = trailing.length;
  if (streak === 0) {
    return { streak: 0, score: 0, risk: 'NONE', chain: [], cycles: [], carryOver, factors: null };
  }

  const streakScore    = Math.min(100, streak * 34);
  const agrPersistence = avg(trailing, 'agreement_score');
  const volSuppression = Math.max(0, 100 - avg(trailing, 'volatility_score'));

  // Predict next session from the last compressed one
  const lastSessName   = trailing[trailing.length - 1]?.session_name;
  const nextSessName   = SESS_NEXT[lastSessName] || 'LONDON';
  const transitionBonus = nextSessName === 'LONDON'   ? 80
                        : nextSessName === 'NEW_YORK'  ? 65
                        :                               30;

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

  const chain = trailing.map(s => SESS_LABEL[s.session_name] || s.session_name);

  return {
    streak, score, risk, chain,
    cycles:  trailing.map(s => s.energy_cycle),
    carryOver,
    factors: { streakScore: Math.round(streakScore), agrPersistence: Math.round(agrPersistence),
               volSuppression: Math.round(volSuppression), transitionBonus },
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  try {
    const sb    = getClient();
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const cols  =
      'session_date, session_name, session_start, session_end, ' +
      'movement_score, breadth_score, agreement_score, volatility_score, ' +
      'acceleration_score, compression_score, compression_streak, ' +
      'expansion_readiness, market_energy, energy_cycle, active_pairs, ' +
      'bullish_breadth, bearish_breadth, ' +
      'dominance_score, strongest_ccy, weakest_ccy';

    // Fetch last 7 days, all rows, newest first
    const { data, error } = await sb
      .from('market_energy_sessions')
      .select(cols)
      .gte('session_date', since)
      .order('session_date',  { ascending: false })
      .order('session_start', { ascending: false });

    if (error) throw error;

    const rows = data || [];

    // Most recent row per session_name (rows are newest-first)
    const bySession = {};
    for (const row of rows) {
      if (!bySession[row.session_name]) bySession[row.session_name] = row;
    }

    // Chronological active sequence (skip LOW_LIQUIDITY), oldest → newest, last 8
    const sequence = rows
      .filter(r => r.session_name !== 'LOW_LIQUIDITY')
      .reverse()
      .slice(-8);

    // Compute session-to-session deltas from the chronological sequence
    // Key: session_name → delta vs immediately preceding session
    const deltas = {};
    for (let i = 1; i < sequence.length; i++) {
      const curr = sequence[i];
      const prev = sequence[i - 1];
      deltas[curr.session_name] = {
        delta_movement:  round1(curr.movement_score  - prev.movement_score),
        delta_breadth:   round1(curr.breadth_score   - prev.breadth_score),
        delta_agreement: round1(curr.agreement_score - prev.agreement_score),
        delta_energy:    round1(curr.market_energy   - prev.market_energy),
      };
    }

    // Augment session cards with deltas
    const sessions = SESSION_ORDER
      .map(n => {
        const row = bySession[n];
        if (!row) return null;
        return { ...row, ...(deltas[n] || {}) };
      })
      .filter(Boolean);

    const expansionPressure = computeExpansionPressure(sequence);

    res.json({ sessions, expansionPressure });
  } catch (e) {
    console.error('[MARKET-ENERGY]', e.message);
    res.status(500).json({ error: e.message });
  }
};
