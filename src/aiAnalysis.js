const OpenAI = require('openai');
const { supabase } = require('./supabase');

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ─── Fetch last N smoothed values from Supabase ───────────────────────────────

async function getSmoothedHistory(instrument, limit = 48) {
  const [base, quote] = instrument.split('_');

  const { data: strengthData, error: sErr } = await supabase
    .from('currency_strength')
    .select('time, currency, smooth_6h')
    .in('currency', [base, quote])
    .order('time', { ascending: false })
    .limit(limit * 2 + 4);

  if (sErr) throw sErr;

  const { data: spreadData, error: spErr } = await supabase
    .from('pair_strength_spreads')
    .select('time, spread_6h')
    .eq('instrument', instrument)
    .order('time', { ascending: false })
    .limit(limit);

  if (spErr) throw spErr;

  return { strengthData, spreadData, base, quote };
}

// ─── Core analysis ────────────────────────────────────────────────────────────

async function analyzeSetup(instrument, state) {
  const { strengthData, spreadData, base, quote } = await getSmoothedHistory(instrument);

  // Sort oldest → newest, take last 48
  const baseArr = strengthData
    .filter(d => d.currency === base)
    .sort((a, b) => new Date(a.time) - new Date(b.time))
    .slice(-48)
    .map(d => +parseFloat(d.smooth_6h || 0).toFixed(5));

  const quoteArr = strengthData
    .filter(d => d.currency === quote)
    .sort((a, b) => new Date(a.time) - new Date(b.time))
    .slice(-48)
    .map(d => +parseFloat(d.smooth_6h || 0).toFixed(5));

  const spreadArr = spreadData
    .sort((a, b) => new Date(a.time) - new Date(b.time))
    .slice(-48)
    .map(d => +parseFloat(d.spread_6h || 0).toFixed(5));

  console.log(`[AI] ${instrument} data: base=${baseArr.length} pts, quote=${quoteArr.length} pts, spread=${spreadArr.length} pts`);

  // Spread momentum (change per step)
  const spreadChanges = spreadArr.map((v, i) =>
    i === 0 ? 0 : +(v - spreadArr[i - 1]).toFixed(5)
  );

  const client = getClient();

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1200,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a professional forex market structure analyst. Your role is PURELY to analyze market structure — describe what the data shows. Do NOT give trade recommendations, entry signals, or tell anyone to buy/sell. Focus only on: what structure looks like, strength/weakness of trend, quality of pullback, risk factors. Return ONLY valid JSON.`,
      },
      {
        role: 'user',
        content: `Analyze ${instrument.replace('_', '/')} market structure — ${state.bias} bias, state: ${state.state}, confidence: ${state.confidence}%, spreads: 3H=${(+state.spread_3h||0).toFixed(5)} 6H=${(+state.spread_6h||0).toFixed(5)} 12H=${(+state.spread_12h||0).toFixed(5)}.

Last 48 smoothed H1 values (oldest → newest, covering ~48 hours):
${base} strength: ${JSON.stringify(baseArr)}
${quote} strength: ${JSON.stringify(quoteArr)}
Spread (${base}−${quote}): ${JSON.stringify(spreadArr)}
Spread momentum: ${JSON.stringify(spreadChanges)}

Return this exact JSON structure (no trade signals — pure structure analysis only):
{
  "structure_type": "HEALTHY_PULLBACK"|"WEAK_PULLBACK"|"STRONG_TREND"|"REVERSAL_RISK"|"CHOPPY"|"EXHAUSTED",
  "trend_health": "STRONG"|"MODERATE"|"WEAK",
  "continuation_probability": <0.0-1.0, probability the current structure continues — not a signal>,
  "market_quality": "CLEAN"|"NOISY"|"CHOPPY",
  "warning": <null or max 8-word structural observation>,
  "summary": <one sentence max 12 words describing structure only>,
  "details": {
    "structure_analysis": <2 sentences: what the 48H spread pattern reveals about structure>,
    "trend_assessment": <2 sentences: how base vs quote strength evolved over 48H>,
    "pullback_quality": <1-2 sentences: depth and character of compression — healthy or aggressive>,
    "momentum_shift": <1-2 sentences: how momentum changed over the 48H window — accelerating, stalling, or reversing>,
    "support_factors": [<up to 3 short strings: structural factors that support continuation>],
    "risk_factors": [<up to 3 short strings: structural factors that could break the setup>]
  }
}`,
      },
    ],
  });

  const text = response.choices[0].message.content.trim();
  return JSON.parse(text);
}

// ─── Persist to Supabase ──────────────────────────────────────────────────────

async function saveAnalysis(instrument, time, result) {
  const { details, ...summary } = result;
  const { error } = await supabase
    .from('ai_analysis')
    .upsert(
      { instrument, time, ...summary, details: details || null },
      { onConflict: 'instrument,time' }
    );
  if (error) throw new Error(`AI save error: ${error.message}`);
}

// ─── Main entry point — called from updater ───────────────────────────────────

async function analyzeActiveSetups() {
  if (!process.env.OPENAI_API_KEY) {
    console.log('[AI] No OPENAI_API_KEY — skipping');
    return;
  }

  // Get latest market states
  const { data: latest, error: tErr } = await supabase
    .from('market_states')
    .select('time')
    .order('time', { ascending: false })
    .limit(1)
    .single();

  if (tErr || !latest) { console.log('[AI] No states found'); return; }

  const { data: states, error: sErr } = await supabase
    .from('market_states')
    .select('instrument, state, bias, confidence, spread_3h, spread_6h, spread_12h')
    .eq('time', latest.time);

  if (sErr) throw sErr;

  // Actual state values from stateDetect.js:
  // TREND, PULLBACK_STARTING, PULLBACK_ACTIVE, READY_TO_ENTER, REVERSAL_RISK, NO_TRADE
  const PRIORITY = {
    READY_TO_ENTER:    4,
    PULLBACK_ACTIVE:   3,
    PULLBACK_STARTING: 2,
    TREND:             1,
  };

  console.log(`[AI] Total states received: ${(states || []).length}`);
  console.log(`[AI] State breakdown: ${JSON.stringify(
    (states || []).reduce((acc, s) => { acc[s.state] = (acc[s.state] || 0) + 1; return acc; }, {})
  )}`);

  const targets = (states || [])
    .filter(s => {
      const ok = PRIORITY[s.state] !== undefined && s.confidence >= 40;
      if (!ok && s.confidence >= 40) console.log(`[AI] Skipping ${s.instrument}: state=${s.state} not in priority map`);
      return ok;
    })
    .sort((a, b) => {
      const pa = PRIORITY[a.state] || 0, pb = PRIORITY[b.state] || 0;
      return pa !== pb ? pb - pa : b.confidence - a.confidence;
    })
    .slice(0, 6);

  if (!targets.length) {
    console.log('[AI] No active setups to analyze (all pairs below threshold or NO_TRADE)');
    return;
  }

  console.log(`[AI] Analyzing ${targets.length} setup(s): ${targets.map(t => `${t.instrument}(${t.state}@${t.confidence}%)`).join(', ')}`);

  for (const state of targets) {
    try {
      const result = await analyzeSetup(state.instrument, state);
      await saveAnalysis(state.instrument, latest.time, result);
      console.log(`[AI] ✓ ${state.instrument}: ${result.structure_type} cont=${Math.round(result.continuation_probability * 100)}%`);
    } catch (err) {
      console.error(`[AI] ✗ ${state.instrument}: ${err.message}`);
    }
  }
}

module.exports = { analyzeActiveSetups };
