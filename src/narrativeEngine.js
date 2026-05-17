'use strict';

const OpenAI = require('openai');
const { supabase }            = require('./supabase');
const { getMarketEnergyData } = require('./sessionActivity');

const TABLE = 'market_energy_narrative';

function fv(v) { return Math.round(parseFloat(v) || 0); }
function pct(v) {
  if (v == null) return 'n/a';
  return `${v >= 0 ? '+' : ''}${v}%avg`;
}
function prev(v) {
  if (v == null) return '';
  return ` (${v >= 0 ? '+' : ''}${v}%prev)`;
}

function buildPrompt(sessions, ep, marketCycle) {
  const active = sessions.filter(s => s.session_name !== 'LOW_LIQUIDITY');
  const byName = Object.fromEntries(active.map(s => [s.session_name, s]));

  const lines = active.map(s =>
    `  ${s.session_name.padEnd(10)} cycle=${s.energy_cycle||'?'} momentum=${s.energy_momentum||'n/a'}
    Mov:${fv(s.movement_score)} (${pct(s.norm_movement)})  Brd:${fv(s.breadth_score)} (${pct(s.norm_breadth)})  Agr:${fv(s.agreement_score)} (${pct(s.norm_agreement)})
    Vol:${fv(s.volatility_score)} (${pct(s.norm_volatility)})  Energy:${fv(s.market_energy)} (${pct(s.norm_energy)}${prev(s.prev_energy)})  Dom:${fv(s.dominance_score)}%
    Bull:${fv(s.bullish_breadth)}%  Bear:${fv(s.bearish_breadth)}%  Strong:${s.strongest_ccy||'?'}  Weak:${s.weakest_ccy||'?'}`
  ).join('\n\n');

  const flowStr = ep?.carryOver?.length > 1
    ? '\nSESSION FLOW: ' + ep.carryOver.map(c => `${c.session}(E:${c.energy} Brd:${c.breadth} ${c.cycle})`).join(' → ')
    : '';

  const epText = (!ep || ep.streak === 0)
    ? 'None'
    : `${ep.risk} | streak:${ep.streak} sessions (${ep.chain.join('→')}) | score:${ep.score}`;

  const a  = byName['ASIA'];
  const l  = byName['LONDON'];
  const ny = byName['NEW_YORK'];

  return `You are a senior institutional forex analyst. Produce a deep, data-driven briefing. Output ONLY a raw JSON object — no markdown fences, no explanation.

━━━ SESSION DATA ━━━
${lines}${flowStr}

EXPANSION PRESSURE: ${epText}
MARKET CYCLE CLASSIFICATION: ${marketCycle || 'UNKNOWN'}

━━━ DEFINITIONS ━━━
%avg  = % deviation vs this session's own 14-day historical average
%prev = % deviation vs the previous occurrence of the same session
COMPRESSION = suppressed participation (breadth low, pairs not moving)
EXPANSION   = broad coordinated directional move
Bull%/Bear% = magnitude-weighted directional pressure (not raw pair count)
Dom%        = one-sidedness (0=balanced, 100=one direction only)
Energy      = composite of movement × breadth × agreement

━━━ DATA SNAPSHOT ━━━
Asia   — Mov:${fv(a?.movement_score)} Brd:${fv(a?.breadth_score)} Agr:${fv(a?.agreement_score)} Energy:${fv(a?.market_energy)} Bull:${fv(a?.bullish_breadth)}% Bear:${fv(a?.bearish_breadth)}% Dom:${fv(a?.dominance_score)}% Strong:${a?.strongest_ccy||'?'} Weak:${a?.weakest_ccy||'?'}
London — Mov:${fv(l?.movement_score)} Brd:${fv(l?.breadth_score)} Agr:${fv(l?.agreement_score)} Energy:${fv(l?.market_energy)} Bull:${fv(l?.bullish_breadth)}% Bear:${fv(l?.bearish_breadth)}% Dom:${fv(l?.dominance_score)}% Strong:${l?.strongest_ccy||'?'} Weak:${l?.weakest_ccy||'?'}
NY     — Mov:${fv(ny?.movement_score)} Brd:${fv(ny?.breadth_score)} Agr:${fv(ny?.agreement_score)} Energy:${fv(ny?.market_energy)} Bull:${fv(ny?.bullish_breadth)}% Bear:${fv(ny?.bearish_breadth)}% Dom:${fv(ny?.dominance_score)}% Strong:${ny?.strongest_ccy||'?'} Weak:${ny?.weakest_ccy||'?'}

━━━ OUTPUT SCHEMA ━━━
Return exactly this structure:

{
  "cycle": {
    "bias": "NEUTRAL",
    "condition": "6-8 word label for current cycle state",
    "narrative": "2-3 sentences. What this cycle phase means, which metrics confirm it, and what it implies for directional opportunity. Reference actual numbers.",
    "trigger": "Specific metric + exact threshold that would shift the bias. E.g.: London breadth rising above 38 sustained for 2 sessions with agreement >50 would confirm bullish expansion."
  },
  "sessions": {
    "ASIA": {
      "trade_condition": "WAIT",
      "flow": "≤10 words: dominant ccy and against what",
      "analysis": "2-3 sentences specific to Asia. Reference Asia's actual numbers: its cycle, breadth vs average, dominant currency, bull/bear split, what the momentum means.",
      "signal": "Single most actionable insight citing at least one specific number.",
      "watch": "Exact metric + number threshold that would change trade_condition."
    },
    "LONDON": {
      "trade_condition": "WAIT",
      "flow": "≤10 words",
      "analysis": "2-3 sentences specific to London data.",
      "signal": "Actionable insight with number.",
      "watch": "Metric + threshold."
    },
    "NEW_YORK": {
      "trade_condition": "WAIT",
      "flow": "≤10 words",
      "analysis": "2-3 sentences specific to New York data.",
      "signal": "Actionable insight with number.",
      "watch": "Metric + threshold."
    }
  },
  "currencies": {
    "leader": "Which currency is strongest across sessions and why — cite bull%, Dom%, or consistency.",
    "laggard": "Which currency is weakest across sessions and why — cite bear%, Dom%, or consistency.",
    "theme": "Cross-session currency theme: are the same currencies dominating each session, or is there divergence? What does this mean for pair selection?"
  },
  "summary": {
    "bias": "NEUTRAL",
    "playbook": "2-3 sentences: what a trader should actually do right now given these conditions. Be direct — wait, position, watch X. Reference conditions.",
    "priority": "The single most important metric to monitor in the next session, with the exact threshold that matters.",
    "risk": "The main risk or trap in current conditions. Be specific.",
    "opportunity": "The best realistic setup if conditions improve. Name the currency pair direction if possible."
  }
}

━━━ FIELD RULES ━━━
cycle.bias / summary.bias: BULLISH | BEARISH | NEUTRAL | MIXED
  — BULLISH: bull% consistently > bear%, Dom% >20 across 2+ sessions, strong ccy recurring
  — BEARISH: opposite
  — MIXED: sessions conflict directionally
  — NEUTRAL: Dom% <15 across all sessions, no clear ccy leadership

sessions[X].trade_condition:
  FAVORABLE  = expansion or transition cycle + agreement >45 + Dom% >20
  UNFAVORABLE = compression or exhaustion + breadth declining + conflicting flow
  WAIT        = low participation or thin breadth or no clear bias

analysis, narrative, playbook: write as a professional analyst. Use numbers from the data. Do not use filler phrases like "it is important to note" or "overall". Be direct and specific.`;
}

async function generateMarketNarrative() {
  const data = await getMarketEnergyData();
  if (!data?.sessions?.length) throw new Error('No session data available');

  const { sessions, expansionPressure, marketCycle } = data;

  const prompt     = buildPrompt(sessions, expansionPressure, marketCycle);
  const ai         = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await ai.chat.completions.create({
    model:           'gpt-4o-mini',
    max_tokens:      1800,
    temperature:     0.3,
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
