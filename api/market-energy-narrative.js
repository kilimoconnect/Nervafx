'use strict';

/**
 * POST /api/market-energy-narrative
 *
 * Receives the 4 session cards + expansion pressure object from the client,
 * builds a structured prompt with specific metric values and deltas, and
 * returns a 2-sentence institutional narrative.
 *
 * Body: { sessions: [...], expansionPressure: { streak, score, risk, chain, carryOver } }
 * Returns: { narrative: "<text>" }
 */

const OpenAI       = require('openai');
const { cors }     = require('./_db');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const _cache       = new Map();

function fingerprint(sessions, ep) {
  return sessions.map(s =>
    `${s.session_name}:${s.energy_cycle}:${Math.round(s.market_energy || 0)}:${Math.round(s.expansion_readiness || 0)}:${Math.round(s.breadth_score || 0)}`
  ).join('|') + `|${ep?.risk || 'NONE'}:${ep?.score || 0}`;
}

function fv(v) { return Math.round(parseFloat(v) || 0); }
function fdelta(v) {
  const n = Math.round(parseFloat(v) || 0);
  if (n === 0) return '±0';
  return n > 0 ? `+${n}` : `${n}`;
}

function buildPrompt(sessions, ep) {
  const active = sessions.filter(s => s.session_name !== 'LOW_LIQUIDITY');

  // Per-session detailed line with actual values and deltas
  const lines = active.map(s => {
    const name = s.session_name.replace('_', ' ');
    const hasDelta = s.delta_movement != null;
    const deltaStr = hasDelta
      ? ` [Δ Mov:${fdelta(s.delta_movement)} Brd:${fdelta(s.delta_breadth)} Agr:${fdelta(s.delta_agreement)} Egy:${fdelta(s.delta_energy)}]`
      : '';
    return (
      `  ${name.padEnd(10)} ${(s.energy_cycle || '').padEnd(18)} ` +
      `Mov:${fv(s.movement_score)} Brd:${fv(s.breadth_score)} ` +
      `Agr:${fv(s.agreement_score)} Vol:${fv(s.volatility_score)} | ` +
      `Bull:${fv(s.bullish_breadth)}% Bear:${fv(s.bearish_breadth)}% | ` +
      `Energy:${fv(s.market_energy)} Ready:${fv(s.expansion_readiness)}` +
      deltaStr
    );
  }).join('\n');

  // Carry-over energy/breadth progression chain
  let carryOverStr = '';
  if (ep?.carryOver?.length > 1) {
    const chain = ep.carryOver.map(c => `${c.session}(E:${c.energy} B:${c.breadth})`).join(' → ');
    carryOverStr = `\nSESSION FLOW (oldest → newest):\n  ${chain}`;
  }

  // Expansion pressure context
  let epText;
  if (!ep || ep.streak === 0) {
    epText = 'No active compression sequence — market is active or expanding.';
  } else {
    const factorStr = ep.factors
      ? ` (streak factor:${ep.factors.streakScore}, agr:${ep.factors.agrPersistence}, vol-suppress:${ep.factors.volSuppression}, transition:${ep.factors.transitionBonus})`
      : '';
    epText = `Compression sequence: ${ep.chain.join(' → ')} — ${ep.streak} session${ep.streak !== 1 ? 's' : ''}, pressure score:${ep.score}, risk:${ep.risk}${factorStr}`;
  }

  return `You are a professional institutional forex market analyst reading session energy data.

SESSION DATA (most recent 24 h):
${lines}
${carryOverStr}
CROSS-SESSION PRESSURE:
  ${epText}

ENERGY CYCLE DEFINITIONS:
  DEAD = no participation | COMPRESSION = suppressed, low breadth
  PRESSURE_BUILDING = compression streak accumulating | TRANSITION = energy rising
  CONTROLLED_TREND = directional, moderate movement | QUIET_BALANCE = healthy, not expanding
  ACTIVE_EXPANSION = broad coordinated move | CHAOTIC_EXPANSION = high move, poor agreement
  EXPLOSIVE = max participation | EXHAUSTION = expansion fading, breadth retreating

METRIC RANGES: all scores 0–100. Breadth<30 = thin; Agr<40 = disorganized; Energy>60 = active.
Delta values show change vs the immediately preceding active session.

Write exactly 2 sentences of institutional market narrative using the specific numbers above.
Rules:
  - Sentence 1: cite at least 2 concrete metric values (e.g. "Breadth remained below 20% across Asia…" or "agreement rose ${fdelta(active[active.length-1]?.delta_agreement || 0)} to ${fv(active[active.length-1]?.agreement_score)} in New York")
  - Sentence 2: interpret what the session structure and deltas suggest about near-term market conditions
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
      max_tokens:  180,
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
