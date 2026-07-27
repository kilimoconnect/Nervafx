'use strict';

/**
 * GET /api/currency-state
 *
 * Currency STATE engine. Reuses the composite M15 layers from
 * /api/currency-strength-m15-45m (movement, persistence, acceleration, breadth,
 * trend, session + signed conviction) and classifies each currency, each M15
 * step, into a market state:
 *
 *   🚀 Explosive · 📈/📉 Healthy · 🔄 Pullback · 🔻 Exhaustion
 *   🔁 Reversal · ⚠️ Transition · ⏸️ Compression · 💀 Dead
 *
 * A per-currency energy is derived from movement + breadth. Same window rules
 * as the strength engine (live = last 24h, ?date=YYYY-MM-DD = that day).
 */

const { cors } = require('./_db');
const strengthHandler = require('./currency-strength-m15-45m.js');

const CCYS = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

const STATES = {
  EXPLOSIVE_BULL: { emoji: '🚀', label: 'Explosive Bull', dir: 'BULL' },
  EXPLOSIVE_BEAR: { emoji: '🚀', label: 'Explosive Bear', dir: 'BEAR' },
  HEALTHY_BULL:   { emoji: '📈', label: 'Healthy Bull',   dir: 'BULL' },
  HEALTHY_BEAR:   { emoji: '📉', label: 'Healthy Bear',   dir: 'BEAR' },
  PULLBACK:       { emoji: '🔄', label: 'Pullback',       dir: null   },
  EXHAUSTION:     { emoji: '🔻', label: 'Exhaustion',     dir: null   },
  REVERSAL:       { emoji: '🔁', label: 'Reversal',       dir: null   },
  TRANSITION:     { emoji: '⚠️', label: 'Transition',     dir: null   },
  COMPRESSION:    { emoji: '⏸️', label: 'Compression',    dir: null   },
  DEAD:           { emoji: '💀', label: 'Dead',           dir: null   },
};

// Classify one currency at one step from its conviction (signed ±100) + layers.
function classify(conv, L, prevConv) {
  const dir = conv > 0 ? 1 : conv < 0 ? -1 : 0;
  const mag = Math.abs(conv);
  const accel   = L.accel || 0;       // signed: + = accelerating in dir
  const persist = L.persistence || 0;
  const breadth = L.breadth || 0;
  const trend   = L.trend || 0;
  const move    = L.movement || 0;

  // Reversal — conviction flipped sign vs the previous step, with force behind it.
  if (prevConv != null && Math.sign(prevConv) !== 0 && dir !== 0 &&
      Math.sign(prevConv) !== dir && mag >= 25 && accel >= 20) return 'REVERSAL';

  // Dead — no activity anywhere.
  if (move < 20 && breadth < 45 && mag < 20) return 'DEAD';

  // Compression — coiling: little movement, mixed board.
  if (mag < 20 && move < 30) return 'COMPRESSION';

  // Explosive — strong, accelerating, broad.
  if (mag >= 60 && accel >= 40 && breadth >= 70) return dir > 0 ? 'EXPLOSIVE_BULL' : 'EXPLOSIVE_BEAR';

  // Exhaustion — strong but fading fast.
  if (mag >= 45 && accel <= -25) return 'EXHAUSTION';

  // Pullback — established move, still net directional, easing short-term.
  if (mag >= 25 && persist >= 50 && accel < 0) return 'PULLBACK';

  // Healthy trend — solid, persistent, clean, not fading.
  if (mag >= 35 && persist >= 50 && trend >= 45 && accel >= 0)
    return dir > 0 ? 'HEALTHY_BULL' : 'HEALTHY_BEAR';

  return 'TRANSITION';
}

// Invoke the strength engine in-process to reuse its layer computation.
function invokeStrength(query) {
  return new Promise((resolve) => {
    const req = { method: 'GET', query: query || {}, headers: {}, _internal: true };
    let payload = null, code = 200;
    const res = {
      setHeader() {}, status(c) { code = c; return this; },
      json(d) { payload = d; resolve({ code, data: d }); return this; },
      end() { resolve({ code, data: payload }); },
    };
    strengthHandler(req, res).catch(e => resolve({ code: 500, data: { error: e.message } }));
  });
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const r = await invokeStrength(req.query);
    if (r.data?.error) throw new Error(r.data.error);
    const steps = r.data.steps || [];

    const prev = {}; // per-currency previous conviction (for reversal detection)
    const out = steps.map(s => {
      const states = {};
      for (const c of CCYS) {
        const conv = s.score?.[c] ?? 0;
        const L = s.layers?.[c] || {};
        const energy = Math.round(((L.movement || 0) + (L.breadth || 0)) / 2);
        const key = classify(conv, L, prev[c]);
        states[c] = {
          key, emoji: STATES[key].emoji, label: STATES[key].label, dir: STATES[key].dir,
          conviction: conv, energy, layers: L,
        };
        prev[c] = conv;
      }
      return { time: s.time, signalTime: s.signalTime, states };
    });

    res.json({
      currencies: CCYS,
      states: STATES,
      current: out.length ? out[out.length - 1] : null,
      steps: out,
    });
  } catch (e) {
    console.error('[currency-state]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
