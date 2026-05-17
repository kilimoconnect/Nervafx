'use strict';

const OpenAI = require('openai');
const { supabase }          = require('./supabase');
const { getMarketEnergyData } = require('./sessionActivity');

const TABLE = 'market_energy_narrative';

function fv(v) { return Math.round(parseFloat(v) || 0); }
function pctStr(v) {
  if (v == null) return '';
  return `(${v >= 0 ? '+' : ''}${v}%avg)`;
}

function buildPrompt(sessions, ep, marketCycle) {
  const active = sessions.filter(s => s.session_name !== 'LOW_LIQUIDITY');
  const byName = Object.fromEntries(active.map(s => [s.session_name, s]));

  const lines = active.map(s => {
    const prevE = s.prev_energy != null ? `(${s.prev_energy >= 0 ? '+' : ''}${s.prev_energy}%prev)` : '';
    return (
      `  ${s.session_name.padEnd(10)} ${(s.energy_cycle||'').padEnd(18)} ` +
      `Mov:${fv(s.movement_score)}${pctStr(s.norm_movement)} ` +
      `Brd:${fv(s.breadth_score)}${pctStr(s.norm_breadth)} ` +
      `Agr:${fv(s.agreement_score)}${pctStr(s.norm_agreement)} ` +
      `Vol:${fv(s.volatility_score)}${pctStr(s.norm_volatility)} ` +
      `Energy:${fv(s.market_energy)}${pctStr(s.norm_energy)}${prevE} ` +
      `Momentum:${s.energy_momentum||'n/a'} ` +
      `Bull:${fv(s.bullish_breadth)}% Bear:${fv(s.bearish_breadth)}% Dom:${fv(s.dominance_score)}% ` +
      `Strong:${s.strongest_ccy||'?'} Weak:${s.weakest_ccy||'?'}`
    );
  }).join('\n');

  let flowStr = '';
  if (ep?.carryOver?.length > 1) {
    flowStr = '\nSESSION FLOW: ' +
      ep.carryOver.map(c => `${c.session}(E:${c.energy} Brd:${c.breadth} ${c.cycle})`).join('→');
  }

  const epText = (!ep || ep.streak === 0)
    ? 'No compression.'
    : `${ep.risk} | streak:${ep.streak} (${ep.chain.join('→')}) | score:${ep.score}`;

  const a  = byName['ASIA'];
  const l  = byName['LONDON'];
  const ny = byName['NEW_YORK'];

  return `You are an institutional forex trading desk analyst. Output ONLY a raw JSON object — no markdown, no explanation.

SESSION DATA:
${lines}${flowStr}
EXPANSION PRESSURE: ${epText}
MARKET CYCLE: ${marketCycle||'UNKNOWN'}

DEFINITIONS:
  %avg = deviation from this session's own historical average (not vs other sessions)
  COMPRESSION = suppressed breadth | EXPANSION = broad coordinated move
  Bull%/Bear% = magnitude-weighted directional pressure (not pair count)
  Dom% = how one-sided the move is (0=balanced, 100=completely one direction)

Return exactly this JSON structure:
{
  "cycle": {
    "bias": "NEUTRAL",
    "condition": "...",
    "trigger": "..."
  },
  "sessions": {
    "ASIA": {
      "trade_condition": "WAIT",
      "flow": "...",
      "signal": "...",
      "watch": "..."
    },
    "LONDON": {
      "trade_condition": "WAIT",
      "flow": "...",
      "signal": "...",
      "watch": "..."
    },
    "NEW_YORK": {
      "trade_condition": "WAIT",
      "flow": "...",
      "signal": "...",
      "watch": "..."
    }
  },
  "summary": {
    "bias": "NEUTRAL",
    "priority": "...",
    "risk": "...",
    "opportunity": "..."
  }
}

FIELD RULES — enforce strictly:

cycle.bias: one of BULLISH | BEARISH | NEUTRAL | MIXED
  Base on: Dom%>${fv(a?.dominance_score)||fv(l?.dominance_score)||fv(ny?.dominance_score)}, Bull%/Bear% split, strongest/weakest ccy consistency across sessions

cycle.condition: ≤12 words. What the current market cycle means for directional opportunity RIGHT NOW.

cycle.trigger: ≤18 words. Cite a SPECIFIC metric and threshold: "London breadth above 35 with agreement >45 would confirm expansion entry"

sessions[X].trade_condition: one of FAVORABLE | UNFAVORABLE | WAIT
  FAVORABLE = expansion/transition + agreement >45 + dominance >20
  UNFAVORABLE = compression/exhaustion + declining breadth + conflicting flow
  WAIT = low participation + thin breadth + no clear bias

sessions[X].flow: ≤10 words. Which ccy is dominant and against what. E.g. "USD bid, AUD and NZD offered"

sessions[X].signal: ≤18 words. The single most actionable insight for that session. Must include at least one number.

sessions[X].watch: ≤18 words. Specific metric threshold that would change the trade_condition. Must cite a number.

summary.bias: same scale as cycle.bias — overall cross-session directional bias

summary.priority: ≤20 words. The #1 thing to watch in the next session. Cite a metric and threshold.

summary.risk: ≤15 words. The main risk to avoid given current conditions.

summary.opportunity: ≤15 words. The best setup if conditions improve. Be specific.

DATA REFERENCE:
  Asia — Mov:${fv(a?.movement_score)} Brd:${fv(a?.breadth_score)} Agr:${fv(a?.agreement_score)} Energy:${fv(a?.market_energy)} Strong:${a?.strongest_ccy} Weak:${a?.weakest_ccy} Dom:${fv(a?.dominance_score)}%
  London — Mov:${fv(l?.movement_score)} Brd:${fv(l?.breadth_score)} Agr:${fv(l?.agreement_score)} Energy:${fv(l?.market_energy)} Strong:${l?.strongest_ccy} Weak:${l?.weakest_ccy} Dom:${fv(l?.dominance_score)}%
  NY — Mov:${fv(ny?.movement_score)} Brd:${fv(ny?.breadth_score)} Agr:${fv(ny?.agreement_score)} Energy:${fv(ny?.market_energy)} Strong:${ny?.strongest_ccy} Weak:${ny?.weakest_ccy} Dom:${fv(ny?.dominance_score)}%`;
}

async function generateMarketNarrative() {
  const data = await getMarketEnergyData();
  if (!data?.sessions?.length) throw new Error('No session data available');

  const { sessions, expansionPressure, marketCycle } = data;

  const prompt     = buildPrompt(sessions, expansionPressure, marketCycle);
  const ai         = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await ai.chat.completions.create({
    model:           'gpt-4o-mini',
    max_tokens:      600,
    temperature:     0.2,
    response_format: { type: 'json_object' },
    messages:        [{ role: 'user', content: prompt }],
  });

  const result = JSON.parse(completion.choices[0].message.content.trim());

  const { error } = await supabase
    .from(TABLE)
    .upsert({ id: 1, computed_at: new Date().toISOString(), result }, { onConflict: 'id' });

  if (error) throw new Error(`narrative upsert: ${error.message}`);

  return result;
}

module.exports = { generateMarketNarrative };
