'use strict';

/**
 * POST /api/session-energy-ai
 *
 * Receives the full stacked-bar chart data from the client (sequence of
 * sessions with component contributions), builds a structured prompt, and
 * calls OpenAI to read the energy pattern and predict the next session.
 *
 * Body: { chartData: [{ date, session, state, score, csBonus,
 *                       movementPart, breadthPart, directionPart, expansionPart }] }
 *
 * Returns: { read, prediction, regime, confidence, pattern, warning }
 */

const OpenAI         = require('openai');
const { cors }       = require('./_db');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const _cache = new Map();

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function fingerprint(chartData) {
  return chartData.map(e => `${e.date}:${e.session}:${e.score}`).join('|');
}

function pad(v, n) { return String(v ?? '').padEnd(n); }
function padL(v, n) { return String(v ?? '').padStart(n); }

function buildPrompt(chartData) {
  // Dedupe (keep last entry per date+session in case of duplicates)
  const seen = new Set();
  const rows = [];
  for (const e of chartData) {
    const k = `${e.date}:${e.session}`;
    if (!seen.has(k)) { seen.add(k); rows.push(e); }
  }

  // Compression streak into latest
  let compStreak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].state === 'COMPRESSION' || rows[i].state === 'DEAD') compStreak++;
    else break;
  }

  const latest = rows[rows.length - 1];

  // Readiness per row: non-expansion streak × 25, capped 100
  const isHigh = s => s === 'EXPANSION' || s === 'EXPLOSIVE';
  const withReadiness = rows.map((e, i) => {
    let streak = 0;
    for (let j = i; j >= 0 && !isHigh(rows[j].state); j--) streak++;
    return { ...e, readiness: Math.min(100, streak * 25) };
  });

  // Next session label
  const SESS_AFTER = { ASIA: 'London', LONDON: 'New York', NEW_YORK: 'Asia (next day)' };
  const nextSession = SESS_AFTER[latest?.session] || 'next session';

  // Chart table (exactly what the user sees)
  const header = `DATE        SESSION    STATE          SCR  MOV   BRD   AGR   EXP   CS  READY`;
  const divider = `─`.repeat(header.length);
  const tableRows = withReadiness.map(e => {
    const cs = e.csBonus > 0 ? `+${e.csBonus}` : e.csBonus < 0 ? `${e.csBonus}` : ` 0`;
    return [
      pad(e.date, 11),
      pad(e.session, 10),
      pad(e.state, 14),
      padL(e.score, 4),
      padL((+e.movementPart).toFixed(1),  5),
      padL((+e.breadthPart).toFixed(1),   5),
      padL((+e.directionPart).toFixed(1), 5),
      padL((+e.expansionPart).toFixed(1), 5),
      padL(cs, 4),
      padL(e.readiness, 5),
    ].join('  ');
  });

  const dominant = e => {
    const parts = [
      { name: 'Movement',  v: +e.movementPart  },
      { name: 'Breadth',   v: +e.breadthPart   },
      { name: 'Agreement', v: +e.directionPart },
      { name: 'Expansion', v: +e.expansionPart },
    ];
    return parts.sort((a,b) => b.v - a.v)[0].name;
  };

  // Pattern narrative per date
  const byDate = {};
  for (const e of withReadiness) {
    if (!byDate[e.date]) byDate[e.date] = [];
    byDate[e.date].push(e);
  }
  const narrative = Object.entries(byDate).sort(([a],[b]) => a.localeCompare(b)).map(([date, sessions]) => {
    const parts = sessions.map(e => `${e.session}:${e.state}(${e.score},dom=${dominant(e)})`).join(' → ');
    return `  ${date}: ${parts}`;
  }).join('\n');

  return { header, divider, tableRows, narrative, compStreak, latest, nextSession };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  try {
    const chartData = req.body?.chartData;
    if (!chartData?.length) return res.json({ read: null });

    // Cache check
    const fp = fingerprint(chartData);
    const cached = _cache.get(fp);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return res.json(cached.result);
    }

    const { header, divider, tableRows, narrative, compStreak, latest, nextSession } = buildPrompt(chartData);

    const prompt = `You are the AI pattern-recognition layer of a professional forex session energy system.
The system measures real market energy per trading session using 4 components:
  MOV  = Movement contribution  (pair avg % move × 0.40 weight)
  BRD  = Breadth contribution   (% of 28 pairs moving × 0.35 weight)
  AGR  = Agreement contribution (directional agreement × 0.10 weight)
  EXP  = Expansion contribution (acceleration vs historical × 0.15 weight)
  SCR  = Total energy score (sum of components, 0–100)
  READY = Coiling pressure: consecutive non-expansion sessions × 25, capped 100

Energy states: DEAD(0–20) / COMPRESSION(20–40) / STABLE(40–60) / EXPANSION(60–80) / EXPLOSIVE(80–100)
CS = Currency Signal bonus (±2 for strong CS, 0 otherwise)

STACKED BAR CHART — full session history (exactly what the user sees):
${header}
${divider}
${tableRows.join('\n')}

SESSION FLOW (date: session transitions with dominant component):
${narrative}

KEY CONTEXT:
  Compression streak (consecutive sessions at COMPRESSION or lower): ${compStreak}
  Latest session: ${latest ? `${latest.date} ${latest.session} → ${latest.state} (score ${latest.score})` : 'unknown'}
  Next expected session: ${nextSession}

ANALYSIS RULES:
1. Read the COMPONENT BREAKDOWN — not just the total score. Two sessions with score=50 can be structurally opposite.
2. HIGH breadth + HIGH movement = real coordinated expansion. HIGH movement + LOW breadth = noise/false move.
3. HIGH agreement + rising breadth = trend confirmation. LOW agreement = directionless churn.
4. READY line rising → coiling pressure building → expansion more probable. Dropping after EXPANSION = release.
5. CS bonus presence on the leading component = institutional confirmation.
6. Use environmental language: "conditions are consistent with", "pressure has been accumulating", "participation suggests". NEVER use "will", "must", "expect", "should".

Return ONLY this JSON (no markdown, no explanation):
{
  "pattern": "COMPRESSION_BUILDING"|"EXPANSION_RELEASING"|"TREND_REGIME"|"EXHAUSTION"|"TRANSITIONING"|"MIXED",
  "read": "<2 sentences: what the component breakdown and session flow shows — be specific about which components dominated and why it matters>",
  "regime": "RISK_ON"|"RISK_OFF"|"CAUTIOUS"|"NEUTRAL"|"TRANSITIONING",
  "confidence": <0–100>,
  "prediction": {
    "session": "${nextSession}",
    "state": "DEAD"|"COMPRESSION"|"STABLE"|"EXPANSION"|"EXPLOSIVE",
    "dominant_component": "Movement"|"Breadth"|"Agreement"|"Expansion",
    "reasoning": "<1–2 sentences: what in the chart supports this prediction — cite specific components or pattern>",
    "confidence": <0–100>
  },
  "warning": <null or one short caution — only if a clear structural risk is visible in the component data>
}`;

    const ai = getOpenAI();
    const completion = await ai.chat.completions.create({
      model:           'gpt-4o-mini',
      max_tokens:      600,
      temperature:     0.15,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    });

    const result = JSON.parse(completion.choices[0].message.content);
    _cache.set(fp, { ts: Date.now(), result });

    res.json(result);
  } catch (e) {
    console.error('[SESSION-ENERGY-AI]', e.message);
    res.status(500).json({ error: e.message });
  }
};
