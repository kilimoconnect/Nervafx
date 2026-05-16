'use strict';

/**
 * POST /api/market-energy-narrative
 *
 * Receives the 4 session cards + expansion pressure object from the client,
 * builds a structured prompt, and returns a 2-sentence institutional narrative
 * describing the current market session flow.
 *
 * Body: { sessions: [...], expansionPressure: { streak, risk, chain } }
 * Returns: { narrative: "<text>" }
 */

const OpenAI       = require('openai');
const { cors }     = require('./_db');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const _cache       = new Map();

function fingerprint(sessions, ep) {
  return sessions.map(s =>
    `${s.session_name}:${s.energy_cycle}:${Math.round(s.market_energy || 0)}:${Math.round(s.expansion_readiness || 0)}`
  ).join('|') + `|${ep?.risk || 'NONE'}:${ep?.streak || 0}`;
}

function buildPrompt(sessions, ep) {
  const active = sessions.filter(s => s.session_name !== 'LOW_LIQUIDITY');

  const f = v => Math.round(parseFloat(v) || 0);

  const lines = active.map(s => {
    const name = s.session_name.replace('_', ' ');
    return (
      `  ${name.padEnd(10)} ${(s.energy_cycle || '').padEnd(18)} ` +
      `Mov:${f(s.movement_score)} Brd:${f(s.breadth_score)} ` +
      `Agr:${f(s.agreement_score)} Vol:${f(s.volatility_score)} | ` +
      `Bull:${f(s.bullish_breadth)}% Bear:${f(s.bearish_breadth)}% | ` +
      `Energy:${f(s.market_energy)} Ready:${f(s.expansion_readiness)}`
    );
  }).join('\n');

  const epText = ep?.streak > 0
    ? `Compression sequence: ${ep.chain.join(' → ')} — ${ep.streak} session${ep.streak !== 1 ? 's' : ''}, pressure: ${ep.risk}`
    : 'No active compression sequence — market is active or expanding.';

  return `You are a professional institutional forex market analyst reading session energy data.

SESSION DATA (most recent 24 h):
${lines}

CROSS-SESSION PRESSURE:
  ${epText}

ENERGY CYCLE DEFINITIONS:
  DEAD = no participation | COMPRESSION = suppressed, low breadth
  PRESSURE_BUILDING = compression streak accumulating | TRANSITION = energy rising
  CONTROLLED = directional, moderate movement | BALANCED = healthy, not expanding
  EXPANSION = broad coordinated move | EXPLOSIVE = max participation
  EXHAUSTION = expansion fading, breadth retreating

Write exactly 2 sentences of institutional market narrative.
Rules:
  - Sentence 1: describe what the session flow shows (what happened across sessions)
  - Sentence 2: what the structure now suggests (probability or caution)
  - Permitted phrases: "participation remained subdued", "breadth expanding", "directional agreement elevated", "pressure accumulating", "conditions consistent with", "suggests"
  - Forbidden words: "will", "must", "expect", "predict"
  - No markdown. No labels. No intro. Output only the 2 sentences.`;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  try {
    const { sessions, expansionPressure } = req.body || {};
    if (!sessions?.length) return res.json({ narrative: null });

    const fp     = fingerprint(sessions, expansionPressure);
    const cached = _cache.get(fp);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return res.json(cached.result);
    }

    const prompt     = buildPrompt(sessions, expansionPressure);
    const ai         = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await ai.chat.completions.create({
      model:       'gpt-4o-mini',
      max_tokens:  160,
      temperature: 0.2,
      messages:    [{ role: 'user', content: prompt }],
    });

    const narrative = completion.choices[0].message.content.trim();
    const result    = { narrative };
    _cache.set(fp, { ts: Date.now(), result });

    res.json(result);
  } catch (e) {
    console.error('[ME-NARRATIVE]', e.message);
    res.status(500).json({ error: e.message });
  }
};
