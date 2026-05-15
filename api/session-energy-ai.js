'use strict';

/**
 * POST /api/session-energy-ai
 *
 * Accepts the last N session energy rows (summaries) from the client,
 * computes energy scores server-side, builds a multi-session pattern
 * description, and calls OpenAI to project upcoming market movement.
 *
 * Returns JSON: { read, upcoming_session, regime, confidence, pattern, warning }
 *
 * Result is cached in-memory by sequence fingerprint (15-min TTL) to avoid
 * redundant AI calls when the user switches tabs.
 */

const OpenAI         = require('openai');
const { getClient, cors } = require('./_db');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour (invalidated each new session)
const _cache = new Map(); // fingerprint → { ts, result }

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ── Energy helpers (mirrors client-side logic) ────────────────────────────────
function energyScore(s) {
  const mov      = parseFloat(s.avg_movement_score) || 0;
  const brd      = parseFloat(s.avg_breadth_score)  || 0;
  const expH     = parseInt(s.expansion_hours)       || 0;
  const compH    = parseInt(s.compression_hours)     || 0;
  const total    = expH + compH;
  const expRatio = total > 0 ? expH / total : 0.5;
  return Math.min(100, mov * 0.5 + brd * 0.3 + expRatio * 20);
}

function energyState(score) {
  if (score < 20) return 'DEAD';
  if (score < 40) return 'COMPRESSION';
  if (score < 60) return 'STABLE';
  if (score < 80) return 'EXPANSION';
  return 'EXPLOSIVE';
}

// ── Sequence fingerprint (changes when data changes) ─────────────────────────
function fingerprint(rows) {
  return rows.map(r => `${r.session_date_utc}:${r.session_name}:${r.avg_movement_score}`).join('|');
}

// ── Build structured prompt context ──────────────────────────────────────────
function buildContext(enriched) {
  const ORDER    = ['ASIA', 'LONDON', 'LONDON_NY', 'LATE_NY'];
  const ORDER_LABEL = { ASIA: 'Asia', LONDON: 'London', LONDON_NY: 'London/NY Overlap', LATE_NY: 'Late NY' };

  // Group by date
  const byDate = {};
  for (const e of enriched) {
    if (!byDate[e.date]) byDate[e.date] = {};
    byDate[e.date][e.session] = e;
  }

  const dates = Object.keys(byDate).sort().slice(-5);

  const days = dates.map(date => {
    const sessions = ORDER.map(sess => {
      const e = byDate[date][sess];
      if (!e) return null;
      return `  ${ORDER_LABEL[sess].padEnd(22)} ${e.state.padEnd(12)} score=${e.score.toFixed(0).padStart(3)}  mov=${e.avgMov.toFixed(0)}%  breadth=${e.avgBreadth.toFixed(0)}%  expH=${e.expH}  compH=${e.compH}`;
    }).filter(Boolean);
    return `${date}:\n${sessions.join('\n')}`;
  });

  // Full 5-day sequence (up to 20 sessions: 5 days × 4 sessions)
  const sequence = enriched.slice(-20).map(e =>
    `${e.date} ${ORDER_LABEL[e.session] || e.session}: ${e.state} (${e.score.toFixed(0)})`
  ).join('\n');

  // Compression streak
  let compStreak = 0;
  for (let i = enriched.length - 1; i >= 0; i--) {
    if (enriched[i].state === 'COMPRESSION' || enriched[i].state === 'DEAD') compStreak++;
    else break;
  }

  const latest = enriched[enriched.length - 1];

  return { days: days.join('\n\n'), sequence, compStreak, latest };
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  try {
    // Fetch last 7 days of session summaries
    const sb = getClient();
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: summaries, error } = await sb
      .from('session_performance_summary')
      .select('session_date_utc, session_name, avg_movement_score, avg_breadth_score, expansion_hours, compression_hours, dominant_state, pairs_moving_avg')
      .gte('session_date_utc', since)
      .order('session_date_utc', { ascending: true });
    if (error) throw error;
    if (!summaries?.length) return res.json({ read: null });

    // Filter weekends
    const rows = summaries.filter(s => {
      const d = new Date(s.session_date_utc).getUTCDay();
      return d !== 0 && d !== 6;
    });

    // Cache check
    const fp = fingerprint(rows);
    const cached = _cache.get(fp);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return res.json(cached.result);
    }

    // Enrich with energy scores
    const ORDER = ['ASIA', 'LONDON', 'LONDON_NY', 'LATE_NY'];
    const enriched = [];
    const byDate = {};
    for (const s of rows) {
      if (!byDate[s.session_date_utc]) byDate[s.session_date_utc] = {};
      byDate[s.session_date_utc][s.session_name] = s;
    }
    for (const date of Object.keys(byDate).sort()) {
      for (const sess of ORDER) {
        const s = byDate[date][sess];
        if (!s) continue;
        const score = energyScore(s);
        enriched.push({
          date, session: sess,
          score,
          state:       energyState(score),
          avgMov:      parseFloat(s.avg_movement_score) || 0,
          avgBreadth:  parseFloat(s.avg_breadth_score)  || 0,
          expH:        parseInt(s.expansion_hours)       || 0,
          compH:       parseInt(s.compression_hours)     || 0,
          dominant:    s.dominant_state,
        });
      }
    }

    const { days, sequence, compStreak, latest } = buildContext(enriched);

    // Determine next session label
    const SESSION_AFTER = { ASIA: 'London', LONDON: 'London/NY Overlap', LONDON_NY: 'Late NY', LATE_NY: 'Asia (next day)' };
    const nextSession = SESSION_AFTER[latest?.session] || 'next session';

    const prompt = `You are the pattern-recognition layer of a session energy engine.
The engine measures real forex market energy (movement, pair participation, expansion/compression hours) per trading session.
Energy states: DEAD (0-20) / COMPRESSION (20-40) / STABLE (40-60) / EXPANSION (60-80) / EXPLOSIVE (80-100).

SESSION DATA — last 5 trading days (chronological):
${days}

FULL 5-DAY SEQUENCE (chronological, oldest → newest, one line per session):
${sequence}

COMPRESSION STREAK INTO LATEST SESSION: ${compStreak} consecutive sessions compressed (0 = latest session is NOT compressed)
LATEST SESSION: ${latest ? `${latest.date} ${latest.session} → ${latest.state} (score ${latest.score.toFixed(0)})` : 'unknown'}
NEXT EXPECTED SESSION: ${nextSession}

Your task: analyze the multi-session energy cycle to project upcoming market conditions.

RULES:
1. Use environment language only: "conditions are consistent with", "energy flow is weighted toward", "participation environment suggests", "pressure has been accumulating".
2. NEVER use predictive language: "will", "must", "expect", "should", "leads to".
3. Reference compression streaks, expansion releases, and session-to-session transitions — these are the core pattern signals.
4. Be direct and precise — one insight per field, no padding.
5. confidence is your assessment of how clear the pattern is (0–100).

Return ONLY this JSON:
{
  "pattern": "COMPRESSION_BUILDING"|"EXPANSION_RELEASING"|"TREND_REGIME"|"EXHAUSTION"|"TRANSITIONING"|"MIXED",
  "read": "<2 sentences: what the multi-session energy pattern shows right now>",
  "upcoming_session": "<1–2 sentences: what the energy context suggests for ${nextSession}>",
  "regime": "RISK_ON"|"RISK_OFF"|"CAUTIOUS"|"NEUTRAL"|"TRANSITIONING",
  "confidence": <0-100>,
  "warning": <null or one short caution — only if a clear structural risk is visible>
}`;

    const ai = getOpenAI();
    const completion = await ai.chat.completions.create({
      model:           'gpt-4o-mini',
      max_tokens:      500,
      temperature:     0.2,
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
