'use strict';

/**
 * POST /api/market-energy-narrative
 *
 * Body: { sessions, expansionPressure, marketCycle }
 *
 * Returns structured JSON with 5 AI-generated sections:
 *   marketCycle  — 3 sentences on the current regime
 *   asia         — 3 sentences on the Asia session
 *   london       — 3 sentences on the London session
 *   newYork      — 3 sentences on the New York session
 *   footer       — 5 sentences cross-session synthesis + historical context
 */

const OpenAI   = require('openai');
const { cors } = require('./_db');

const CACHE_TTL_MS = 60 * 60 * 1000;
const _cache       = new Map();

function fingerprint(sessions, ep, marketCycle) {
  return sessions.map(s =>
    `${s.session_name}:${s.energy_cycle}:${Math.round(s.market_energy || 0)}:${Math.round(s.norm_energy ?? 999)}:${Math.round(s.breadth_score || 0)}`
  ).join('|') + `|${ep?.risk || 'NONE'}:${ep?.score || 0}:${marketCycle || 'NONE'}`;
}

function fv(v) { return Math.round(parseFloat(v) || 0); }

function pctStr(v, label) {
  if (v == null) return '';
  const sign = v >= 0 ? '+' : '';
  return label ? `(${sign}${v}% vs avg ${label})` : `(${sign}${v}%avg)`;
}

function buildPrompt(sessions, ep, marketCycle) {
  const active = sessions.filter(s => s.session_name !== 'LOW_LIQUIDITY');
  const byName = Object.fromEntries(active.map(s => [s.session_name, s]));

  const lines = active.map(s => {
    const name = s.session_name.replace('_', ' ');
    const prevE = s.prev_energy != null ? `(${s.prev_energy >= 0 ? '+' : ''}${s.prev_energy}%prev)` : '';
    return (
      `  ${name.padEnd(10)} ${(s.energy_cycle || '').padEnd(18)} ` +
      `Mov:${fv(s.movement_score)}${pctStr(s.norm_movement)} ` +
      `Brd:${fv(s.breadth_score)}${pctStr(s.norm_breadth)} ` +
      `Agr:${fv(s.agreement_score)}${pctStr(s.norm_agreement)} ` +
      `Vol:${fv(s.volatility_score)}${pctStr(s.norm_volatility)} | ` +
      `Energy:${fv(s.market_energy)}${pctStr(s.norm_energy)}${prevE} ` +
      `Momentum:${s.energy_momentum || 'n/a'} ` +
      `Bull:${fv(s.bullish_breadth)}% Bear:${fv(s.bearish_breadth)}% Dom:${fv(s.dominance_score)}%`
    );
  }).join('\n');

  let flowStr = '';
  if (ep?.carryOver?.length > 1) {
    flowStr = '\nSESSION FLOW (oldest→newest): ' +
      ep.carryOver.map(c => `${c.session}(E:${c.energy} Brd:${c.breadth} ${c.cycle})`).join(' → ');
  }

  const epText = (!ep || ep.streak === 0)
    ? 'No compression sequence active.'
    : `${ep.risk} | streak:${ep.streak} sessions (${ep.chain.join('→')}) | score:${ep.score}` +
      (ep.factors ? ` [streak:${ep.factors.streakScore} agr:${ep.factors.agrPersistence} volSuppress:${ep.factors.volSuppression} transition:${ep.factors.transitionBonus}]` : '');

  const a  = byName['ASIA'];
  const l  = byName['LONDON'];
  const ny = byName['NEW_YORK'];

  return `You are a senior institutional forex market analyst writing a structured intelligence report.

SESSION DATA (most recent 24 h):
${lines}${flowStr}
EXPANSION PRESSURE: ${epText}
MARKET CYCLE: ${marketCycle || 'UNKNOWN'}

DEFINITIONS:
  %avg = how this session compares to its OWN historical average (not other sessions)
  Positive %avg = running hotter than its own norm — significant regardless of absolute value
  COMPRESSION = suppressed breadth, organised suppression | EXPANSION = broad coordinated move
  LOW_PARTICIPATION = thin/disorganised | TRANSITION = breadth and move building
  EXPLOSIVE = peak participation | EXHAUSTION = expansion fading

Return a single raw JSON object — no markdown, no code fences, no extra keys:
{
  "marketCycle": "...",
  "asia": "...",
  "london": "...",
  "newYork": "...",
  "footer": "..."
}

SECTION REQUIREMENTS:

marketCycle — exactly 3 sentences:
  S1: Name the regime (${marketCycle}) and what it means for current directional opportunity
  S2: Reference the session energy flow to explain how this regime developed (cite specific energy values)
  S3: What structural conditions would signal a transition to the next regime

asia — exactly 3 sentences:
  S1: State ${a?.energy_cycle} and cite Mov:${fv(a?.movement_score)} ${pctStr(a?.norm_movement, 'Asia')}, Brd:${fv(a?.breadth_score)} ${pctStr(a?.norm_breadth, 'Asia')}, Energy:${fv(a?.market_energy)} ${pctStr(a?.norm_energy, 'Asia')}
  S2: Interpret breadth vs agreement — does the pair-level agreement ${fv(a?.agreement_score)} suggest organised flow or scattered moves
  S3: Explain what ${a?.energy_momentum} momentum means given the historical context and what to watch

london — exactly 3 sentences:
  S1: State ${l?.energy_cycle} and cite Mov:${fv(l?.movement_score)} ${pctStr(l?.norm_movement, 'London')}, Brd:${fv(l?.breadth_score)} ${pctStr(l?.norm_breadth, 'London')}, Agr:${fv(l?.agreement_score)} ${pctStr(l?.norm_agreement, 'London')}
  S2: Participation quality — does London's breadth at this level represent structural weakness or normal variation
  S3: Cross-session link — how does this London read in context of the Asia session that preceded it

newYork — exactly 3 sentences:
  S1: State ${ny?.energy_cycle} and cite Mov:${fv(ny?.movement_score)} ${pctStr(ny?.norm_movement, 'NY')}, Brd:${fv(ny?.breadth_score)} ${pctStr(ny?.norm_breadth, 'NY')}, Energy:${fv(ny?.market_energy)} ${pctStr(ny?.norm_energy, 'NY')}
  S2: What does NY breadth at this level historically imply — is this shallow pullback or structural deterioration
  S3: Interpret the ${ny?.energy_momentum} momentum signal and what follow-through conditions to monitor

footer — exactly 5 sentences:
  S1: Identify which session deviated most from its own historical norm and explain the structural implication
  S2: Cross-session narrative — connect Asia → London → NY as one continuous story
  S3: Expansion pressure: what does ${ep?.risk} pressure with ${ep?.streak || 0}-session streak suggest about timing
  S4: Identify the single most important leading indicator to watch in the next session
  S5: One sentence on overall market posture in institutional language

Rules — strictly enforced:
  - Every sentence citing metrics MUST include at least one %avg figure
  - Forbidden words: will, must, expect, predict, guarantee, certainly, definitely
  - Permitted: suggests, indicates, consistent with, conditions favor, pressure accumulating, watching for, historically associated with`;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  try {
    const { sessions, expansionPressure, marketCycle } = req.body || {};
    if (!sessions?.length) return res.json({ marketCycle: null, asia: null, london: null, newYork: null, footer: null });

    const fp     = fingerprint(sessions, expansionPressure, marketCycle);
    const cached = _cache.get(fp);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return res.json(cached.result);

    const prompt     = buildPrompt(sessions, expansionPressure, marketCycle);
    const ai         = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await ai.chat.completions.create({
      model:           'gpt-4o-mini',
      max_tokens:      1000,
      temperature:     0.25,
      response_format: { type: 'json_object' },
      messages:        [{ role: 'user', content: prompt }],
    });

    const parsed = JSON.parse(completion.choices[0].message.content.trim());
    const result = {
      marketCycle: parsed.marketCycle || null,
      asia:        parsed.asia        || null,
      london:      parsed.london      || null,
      newYork:     parsed.newYork     || null,
      footer:      parsed.footer      || null,
    };

    _cache.set(fp, { ts: Date.now(), result });
    res.json(result);
  } catch (e) {
    console.error('[ME-NARRATIVE]', e.message);
    res.status(500).json({ error: e.message });
  }
};
