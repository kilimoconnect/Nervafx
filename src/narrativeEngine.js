'use strict';

const OpenAI = require('openai');
const { supabase }            = require('./supabase');
const { getMarketEnergyData } = require('./sessionActivity');

const TABLE = 'market_energy_narrative';

function fv(v) { return Math.round(parseFloat(v) || 0); }

// ── Data collection ─────────────────────────────────────────────────────────

async function fetchPreviousSessions() {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 3);
  const today = new Date().toISOString().slice(0, 10);

  const { data } = await supabase
    .from('market_energy_sessions')
    .select('session_date, session_name, energy_cycle, market_energy, movement_score, breadth_score, agreement_score, dominance_score, bullish_breadth, bearish_breadth, strongest_ccy, weakest_ccy, tradability_score, tradability_grade, directional_control, volatility_type')
    .gte('session_date', cutoff.toISOString().slice(0, 10))
    .lt('session_date', today)
    .neq('session_name', 'LOW_LIQUIDITY')
    .order('session_date', { ascending: false })
    .order('session_name', { ascending: true })
    .limit(9);

  return (data || []).slice(0, 6);
}

async function fetchHourlyTrend() {
  const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('hourly_session_activity')
    .select('time_utc, session_name, market_energy, dispersion_score, movement_score, breadth_score, agreement_score, directional_control, tradability_score, de_score')
    .gte('time_utc', since)
    .order('time_utc', { ascending: true })
    .limit(12);
  return data || [];
}

async function fetchEnergyPairs() {
  const { data } = await supabase
    .from('energy_signal_pairs')
    .select('instrument, dir, phase, de_combined, impulse_score, impulse_aligned')
    .eq('active', true);
  return data || [];
}

// ── Prompt builder ──────────────────────────────────────────────────────────

function buildPrompt(sessions, ep, marketCycle, prevSessions, hourlyTrend, energyPairs) {
  const active = sessions.filter(s => s.session_name !== 'LOW_LIQUIDITY');
  const byName = Object.fromEntries(active.map(s => [s.session_name, s]));

  const sessBlock = active.map(s =>
    `${s.session_name}: cycle=${s.energy_cycle||'?'} Energy=${fv(s.market_energy)} Disp=${fv(s.dispersion_score||0)} Mov=${fv(s.movement_score)} Brd=${fv(s.breadth_score)} Agr=${fv(s.agreement_score)} Dir=${fv(s.directional_control||0)} Trad=${fv(s.tradability_score||0)} VolType=${s.volatility_type||'?'} Bull=${fv(s.bullish_breadth)}% Bear=${fv(s.bearish_breadth)}% Dom=${fv(s.dominance_score)}% Strong=${s.strongest_ccy||'?'} Weak=${s.weakest_ccy||'?'}`
  ).join('\n');

  // Session flow
  const flowStr = ep?.carryOver?.length > 1
    ? 'SESSION FLOW: ' + ep.carryOver.map(c => `${c.session}(E:${c.energy} Brd:${c.breadth} ${c.cycle})`).join(' → ')
    : '';

  // Hourly trend (last 12h)
  const trendBlock = hourlyTrend.length
    ? 'HOURLY TREND (last 12h):\n' + hourlyTrend.map(h =>
        `  ${h.time_utc.slice(11,16)} ${(h.session_name||'').padEnd(10)} E=${fv(h.market_energy)} Disp=${fv(h.dispersion_score)} Mov=${fv(h.movement_score)} Brd=${fv(h.breadth_score)} Agr=${fv(h.agreement_score)} Dir=${fv(h.directional_control)} Trad=${fv(h.tradability_score)} DE=${fv(h.de_score)}`
      ).join('\n')
    : '';

  // Previous sessions for comparison
  const prevBlock = prevSessions.length
    ? 'PREVIOUS SESSIONS:\n' + prevSessions.map(s =>
        `  ${s.session_date} ${s.session_name.padEnd(10)} cycle=${s.energy_cycle||'?'} E=${fv(s.market_energy)} Brd=${fv(s.breadth_score)} Agr=${fv(s.agreement_score||0)} Dir=${fv(s.directional_control||0)} Trad=${fv(s.tradability_score||0)} Strong=${s.strongest_ccy||'?'} Weak=${s.weakest_ccy||'?'}`
      ).join('\n')
    : '';

  // Active signal pairs
  const pairsBlock = energyPairs.length
    ? 'ACTIVE SIGNAL PAIRS:\n' + energyPairs.map(p =>
        `  ${p.instrument.replace('_','/')} ${p.dir} phase=${p.phase} DE=${fv(p.de_combined)} imp=${p.impulse_score||0}${p.impulse_aligned?'✓':''}`
      ).join('\n')
    : 'No active signal pairs.';

  return `You are a senior institutional forex trading intelligence engine. Your job is to produce ACTIONABLE intelligence, NOT metric commentary.

CRITICAL RULES:
- NEVER repeat metric values back. The user already sees the dashboard.
- ALWAYS explain IMPLICATIONS and CONTRADICTIONS between metrics.
- ALWAYS compare to previous sessions when data is available.
- ALWAYS give specific thresholds for what would change the bias.
- Be direct. No filler phrases. Every sentence must add value.

━━━ LIVE SESSION DATA ━━━
${sessBlock}
${flowStr}

${trendBlock}

${prevBlock}

${pairsBlock}

EXPANSION PRESSURE: ${(!ep || ep.streak === 0) ? 'None' : `${ep.risk} | streak:${ep.streak} (${ep.chain?.join('→')||''})`}
MARKET CYCLE: ${marketCycle || 'UNKNOWN'}

━━━ OUTPUT SCHEMA (return raw JSON, no markdown) ━━━
{
  "engine_conflicts": {
    "detected": true/false,
    "conflicts": [
      {
        "conflict": "High Breadth (71) + Low Agreement (32)",
        "meaning": "Many pairs moving but not in same direction — capital rotating, not trending",
        "implication": "Avoid trend-following. Watch for rotation to resolve into direction."
      }
    ]
  },
  "session_flow": {
    "pattern": "Asia Expansion → London Low Participation → NY ?",
    "interpretation": "1-2 sentences: what the session-to-session transition means. Was momentum carried forward or abandoned?",
    "follow_through": true/false
  },
  "expansion_probability": {
    "score": 38,
    "label": "LOW/MODERATE/HIGH",
    "factors": "1-2 sentences: what drives the probability up or down right now"
  },
  "historical_comparison": {
    "vs_previous": "1-2 sentences comparing current session to the same session yesterday. Cite specific numbers that changed.",
    "trend": "IMPROVING/DETERIORATING/STABLE"
  },
  "cycle": {
    "classification": "LOW_PARTICIPATION/COMPRESSION/EXPANSION/TRANSITION/etc",
    "confidence": 82,
    "narrative": "2 sentences max. What this cycle means for trading. No metric repetition."
  },
  "sessions": {
    "ASIA": {
      "intelligence": "2 sentences of actual intelligence. Explain contradictions, implications, what the data MEANS for trading.",
      "quality": "STRONG/MODERATE/WEAK/AVOID"
    },
    "LONDON": {
      "intelligence": "2 sentences",
      "quality": "STRONG/MODERATE/WEAK/AVOID"
    },
    "NEW_YORK": {
      "intelligence": "2 sentences",
      "quality": "STRONG/MODERATE/WEAK/AVOID"
    }
  },
  "currencies": {
    "leader": "Which currency is leading and WHY (not just 'USD is strong')",
    "laggard": "Which currency is weakest and WHY",
    "theme": "1 sentence: cross-session currency theme"
  },
  "what_changes_bias": {
    "to_bullish": "Specific conditions: e.g. Agreement > 55 + Dispersion > 40 + AUD maintains leadership",
    "to_bearish": "Specific conditions",
    "current_bias": "NEUTRAL/BULLISH/BEARISH/MIXED"
  },
  "decision": {
    "action": "TRADE/WAIT/REDUCE",
    "environment": "3-5 word label e.g. 'Low Participation Rotation'",
    "reason": "1-2 sentences: why this action, what would change it",
    "best_setup": "If TRADE: name the pair and direction. If WAIT: what to watch.",
    "risk_trap": "The main trap in current conditions"
  },
  "summary": {
    "playbook": "2-3 sentences: what a trader should do RIGHT NOW. Be direct.",
    "priority_metric": "The ONE metric to watch and its threshold"
  }
}

FIELD RULES:
- expansion_probability.score: 0-100 based on dispersion trend + breadth + agreement + energy momentum
- cycle.confidence: 0-100 how clear the cycle classification is
- engine_conflicts: detect when metrics CONTRADICT each other (high breadth + low agreement, high movement + low directional control, etc)
- what_changes_bias: must cite SPECIFIC numbers and conditions, not vague statements
- decision.action: TRADE only if tradability > 50 AND agreement > 45 AND dispersion > 35
- All text: professional analyst tone. Every sentence must contain insight, not description.`;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function generateMarketNarrative() {
  const data = await getMarketEnergyData();
  if (!data?.sessions?.length) throw new Error('No session data available');

  const { sessions, expansionPressure, marketCycle } = data;
  const [prevSessions, hourlyTrend, energyPairs] = await Promise.all([
    fetchPreviousSessions(),
    fetchHourlyTrend(),
    fetchEnergyPairs(),
  ]);

  const prompt = buildPrompt(sessions, expansionPressure, marketCycle, prevSessions, hourlyTrend, energyPairs);
  const ai     = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await ai.chat.completions.create({
    model:           'gpt-4o-mini',
    max_tokens:      3000,
    temperature:     0.25,
    response_format: { type: 'json_object' },
    messages:        [{ role: 'user', content: prompt }],
  });

  const raw    = completion.choices[0].message.content.trim();
  const result = JSON.parse(raw);

  const { error } = await supabase
    .from(TABLE)
    .upsert({ id: 1, computed_at: new Date().toISOString(), result: raw }, { onConflict: 'id' });

  if (error) throw new Error(`narrative upsert: ${error.message}`);

  return result;
}

module.exports = { generateMarketNarrative };
