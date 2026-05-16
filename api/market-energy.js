'use strict';

/**
 * GET /api/market-energy
 *
 * Returns the most recent completed row per session, augmented with:
 *   norm_*          — % deviation from that session's own historical average
 *   prev_*          — % deviation from the previous occurrence of the SAME session
 *   energy_momentum — ACCELERATING / DECELERATING / STABLE
 *
 * Also returns:
 *   expansionPressure — multi-factor score + gated activation + flowNarrative
 *   marketCycle       — top-level state-transition classification (the "brain")
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

/** % deviation of current value from a reference. Null if no ref or result is extreme (>200%). */
function pctVsRef(current, ref) {
  if (!ref) return null;
  const pct = Math.round((current / ref - 1) * 100);
  return Math.abs(pct) > 200 ? null : pct;
}

// ── Flow narrative ──────────────────────────────────────────────────────────
function buildFlowNarrative(carryOver) {
  if (!carryOver || carryOver.length < 2) return null;

  const comp  = c => COMPRESSED_CYCLE.has(c);
  const exp   = c => c === 'EXPANSION' || c === 'EXPLOSIVE';
  const trans = c => c === 'TRANSITION';

  const n        = carryOver.length;
  const last     = carryOver[n - 1];
  const prev     = carryOver[n - 2];
  const energies = carryOver.map(c => c.energy);
  const sessions = carryOver.map(c => c.session);
  const cycles   = carryOver.map(c => c.cycle);

  const eStart    = energies[0];
  const eLast     = energies[n - 1];
  const ePeak     = Math.max(...energies);
  const peakIdx   = energies.lastIndexOf(ePeak);
  const peakSess  = sessions[peakIdx];

  const allComp   = cycles.every(comp);
  const wasPeaked = exp(cycles[peakIdx]) && peakIdx < n - 1;
  const risingNow = eLast > prev.energy + 3;
  const fallingNow= eLast < prev.energy - 3;
  const stateOf   = c => (c || '').toLowerCase().replace(/_/g, ' ');
  const avgE      = Math.round(energies.reduce((a, b) => a + b, 0) / n);

  if (wasPeaked && comp(last.cycle)) {
    return `${peakSess} expansion (energy ${ePeak}) has weakened into ${last.session} ${stateOf(last.cycle)} — energy retreated to ${eLast}. No directional pressure developing in the current session.`;
  }
  if (allComp && risingNow) {
    return `Compression persisting through ${sessions.slice(0, -1).join(', ')}, with mild energy accumulation into ${last.session} (${eStart} → ${eLast}). Conditions approaching inflection but breadth remains suppressed.`;
  }
  if (allComp) {
    return `Participation remains broadly suppressed — energy averaged ${avgE} across ${sessions.join(', ')}. No structural shift in session flow detected.`;
  }
  if (exp(last.cycle) && eLast > eStart) {
    return `Energy building from ${eStart} to ${eLast} through ${sessions.join(' → ')} — ${last.session} showing ${stateOf(last.cycle)} conditions with broad directional follow-through.`;
  }
  if (trans(last.cycle)) {
    return `${prev.session} ${stateOf(prev.cycle)} giving way to early ${last.session} movement (energy ${eLast}, breadth ${last.breadth}%). Transition structure forming — not yet confirmed.`;
  }
  if (fallingNow) {
    return `Energy declining from ${eStart} to ${eLast} — ${last.session} ${stateOf(last.cycle)} as participation contracts. Session flow suggests caution on directional exposure.`;
  }
  const trend = eLast > eStart + 5 ? 'gaining ground' : eLast < eStart - 5 ? 'losing ground' : 'holding flat';
  return `Mixed session flow across ${sessions.join(' → ')} — energy ${trend} (${eStart} → ${eLast}), currently ${stateOf(last.cycle)} in ${last.session}.`;
}

// ── Market cycle: top-level state-transition classification ─────────────────
function classifyMarketCycle(sequence) {
  if (!sequence.length) return null;

  const recent  = sequence.slice(-4);
  const cycles  = recent.map(s => s.energy_cycle);
  const energies= recent.map(s => parseFloat(s.market_energy) || 0);
  const eLast   = energies[energies.length - 1];
  const eFirst  = energies[0];
  const eTrend  = eLast - eFirst;
  const avgE    = energies.reduce((a, b) => a + b, 0) / energies.length;

  const comp    = c => COMPRESSED_CYCLE.has(c);
  const exp     = c => c === 'EXPANSION' || c === 'EXPLOSIVE';
  const lastC   = cycles[cycles.length - 1];

  const recentAllComp = cycles.slice(-2).every(comp);
  const anyExp        = cycles.some(exp);
  const nowExp        = exp(lastC);
  const nowTrans      = lastC === 'TRANSITION';
  const nowExhaust    = lastC === 'EXHAUSTION';

  if (nowExhaust)                           return 'CYCLE_EXHAUSTION';
  if (nowExp && eTrend >= 0)                return 'ACTIVE_EXPANSION';
  if (anyExp && recentAllComp)              return 'POST_EXPANSION_RESET';
  if (nowTrans && eTrend > 0)               return 'TRANSITION_BUILD_UP';
  if (recentAllComp && avgE < 20)           return 'DEEP_COMPRESSION';
  if (recentAllComp)                        return 'LOW_PARTICIPATION_COMPRESSION';
  return 'MIXED_ACTIVITY';
}

// ── Expansion pressure (gated: must have streak ≥ 2 + breadth + agreement compressed) ──
const COMP_BRD_MAX = 40; // avg breadth across trailing compressed sessions
const COMP_AGR_MAX = 45; // avg agreement across trailing compressed sessions

function computeExpansionPressure(sequence) {
  const trailing = [];
  for (let i = sequence.length - 1; i >= 0; i--) {
    if (COMPRESSED_CYCLE.has(sequence[i].energy_cycle)) {
      trailing.unshift(sequence[i]);
    } else {
      break;
    }
  }

  // Carry-over: last 5 sessions for flow context
  const carryOver = sequence.slice(-5).map(s => ({
    session: SESS_LABEL[s.session_name] || s.session_name,
    energy:  r(s.market_energy),
    breadth: r(s.breadth_score),
    cycle:   s.energy_cycle,
  }));

  const flowNarrative = buildFlowNarrative(carryOver);
  const streak        = trailing.length;
  const chain         = trailing.map(s => SESS_LABEL[s.session_name] || s.session_name);

  // Gate: single-session compression doesn't constitute pressure
  if (streak < 2) {
    return { streak, score: 0, risk: 'NONE', chain, cycles: trailing.map(s => s.energy_cycle), carryOver, flowNarrative, factors: null };
  }

  // Gate: breadth and agreement must actually be compressed across the trailing sessions
  const avgBrd = avgField(trailing, 'breadth_score');
  const avgAgr = avgField(trailing, 'agreement_score');
  if (avgBrd > COMP_BRD_MAX || avgAgr > COMP_AGR_MAX) {
    return { streak, score: 0, risk: 'NONE', chain, cycles: trailing.map(s => s.energy_cycle), carryOver, flowNarrative, factors: null };
  }

  const streakScore    = Math.min(100, streak * 34);
  const volSuppression = Math.max(0, 100 - avgField(trailing, 'volatility_score'));
  const lastSessName   = trailing[trailing.length - 1]?.session_name;
  const nextSessName   = SESS_NEXT[lastSessName] || 'LONDON';
  const transitionBonus= nextSessName === 'LONDON'  ? 80
                       : nextSessName === 'NEW_YORK' ? 65 : 30;

  const score = Math.round(
    0.35 * streakScore     +
    0.25 * avgAgr          + // agreement persistence: organized suppression = more pressure
    0.25 * volSuppression  +
    0.15 * transitionBonus
  );

  const risk = score >= 70 ? 'HIGH'
             : score >= 50 ? 'BUILDING'
             : score >= 25 ? 'LOW'
             :               'MINIMAL';

  return {
    streak, score, risk, chain,
    cycles:  trailing.map(s => s.energy_cycle),
    carryOver, flowNarrative,
    factors: {
      streakScore:    Math.round(streakScore),
      agrPersistence: Math.round(avgAgr),
      volSuppression: Math.round(volSuppression),
      transitionBonus,
    },
  };
}

// ── Handler ─────────────────────────────────────────────────────────────────
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

    const { data, error } = await sb
      .from('market_energy_sessions')
      .select(cols)
      .gte('session_date', since)
      .order('session_date',  { ascending: false })
      .order('session_start', { ascending: false });

    if (error) throw error;

    const rows = data || [];

    // ── Per-session history groups (newest-first) ─────────────────────────
    const histBySession = {};
    for (const row of rows) {
      const n = row.session_name;
      if (!histBySession[n]) histBySession[n] = [];
      histBySession[n].push(row);
    }

    const bySession = {};
    for (const [name, sessRows] of Object.entries(histBySession)) {
      bySession[name] = sessRows[0]; // most recent
    }

    // ── Session-relative baselines ────────────────────────────────────────
    const sessionBaselines = {};
    for (const [name, sessRows] of Object.entries(histBySession)) {
      const baseline = sessRows.slice(1);
      const prev     = sessRows[1] || null;
      if (!baseline.length) { sessionBaselines[name] = null; continue; }
      sessionBaselines[name] = {
        avg_movement:   avgField(baseline, 'movement_score'),
        avg_breadth:    avgField(baseline, 'breadth_score'),
        avg_agreement:  avgField(baseline, 'agreement_score'),
        avg_volatility: avgField(baseline, 'volatility_score'),
        avg_energy:     avgField(baseline, 'market_energy'),
        prev_row: prev,
        n:        baseline.length,
      };
    }

    // ── Augment session cards ─────────────────────────────────────────────
    const sessions = SESSION_ORDER.map(name => {
      const row = bySession[name];
      if (!row) return null;

      const bl  = sessionBaselines[name];
      let   rel = {};

      if (bl) {
        rel.norm_movement   = pctVsRef(row.movement_score,  bl.avg_movement);
        rel.norm_breadth    = pctVsRef(row.breadth_score,   bl.avg_breadth);
        rel.norm_agreement  = pctVsRef(row.agreement_score, bl.avg_agreement);
        rel.norm_volatility = pctVsRef(row.volatility_score,bl.avg_volatility);
        rel.norm_energy     = pctVsRef(row.market_energy,   bl.avg_energy);
        rel.baseline_n      = bl.n;

        if (bl.prev_row) {
          rel.prev_movement  = pctVsRef(row.movement_score,  bl.prev_row.movement_score);
          rel.prev_breadth   = pctVsRef(row.breadth_score,   bl.prev_row.breadth_score);
          rel.prev_agreement = pctVsRef(row.agreement_score, bl.prev_row.agreement_score);
          rel.prev_energy    = pctVsRef(row.market_energy,   bl.prev_row.market_energy);
        }
      }

      // Energy momentum: how is this session moving vs its own previous occurrence?
      const pe = rel.prev_energy;
      rel.energy_momentum = pe == null ? null
        : pe > 10  ? 'ACCELERATING'
        : pe < -10 ? 'DECELERATING'
        :            'STABLE';

      return { ...row, ...rel };
    }).filter(Boolean);

    // ── Chronological sequence ────────────────────────────────────────────
    const sequence = rows
      .filter(row => row.session_name !== 'LOW_LIQUIDITY')
      .reverse()
      .slice(-8);

    const expansionPressure = computeExpansionPressure(sequence);
    const marketCycle       = classifyMarketCycle(sequence);

    res.json({ sessions, expansionPressure, marketCycle });
  } catch (e) {
    console.error('[MARKET-ENERGY]', e.message);
    res.status(500).json({ error: e.message });
  }
};
