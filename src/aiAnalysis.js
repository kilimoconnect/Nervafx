const OpenAI = require('openai');
const { supabase } = require('./supabase');

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ─── Fetch last N smoothed values from Supabase ───────────────────────────────

async function getSmoothedHistory(instrument, limit = 24) {
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

  // Sort oldest → newest, take last 24
  const baseArr = strengthData
    .filter(d => d.currency === base)
    .sort((a, b) => new Date(a.time) - new Date(b.time))
    .slice(-24)
    .map(d => +parseFloat(d.smooth_6h || 0).toFixed(5));

  const quoteArr = strengthData
    .filter(d => d.currency === quote)
    .sort((a, b) => new Date(a.time) - new Date(b.time))
    .slice(-24)
    .map(d => +parseFloat(d.smooth_6h || 0).toFixed(5));

  const spreadArr = spreadData
    .sort((a, b) => new Date(a.time) - new Date(b.time))
    .slice(-24)
    .map(d => +parseFloat(d.spread_6h || 0).toFixed(5));

  // Spread momentum (change per step)
  const spreadChanges = spreadArr.map((v, i) =>
    i === 0 ? 0 : +(v - spreadArr[i - 1]).toFixed(5)
  );

  const client = getClient();

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 700,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a professional forex market structure analyst. Analyze smoothed H1 data and return a detailed JSON assessment. Be specific and concise. Return ONLY valid JSON.`,
      },
      {
        role: 'user',
        content: `Analyze ${instrument.replace('_', '/')} — ${state.bias} bias, state: ${state.state}, confidence: ${state.confidence}%, spread behavior: ${state.spread_behavior || '?'}.

Last 24 smoothed H1 values (oldest → newest):
${base} strength: ${JSON.stringify(baseArr)}
${quote} strength: ${JSON.stringify(quoteArr)}
Spread (${base}−${quote}): ${JSON.stringify(spreadArr)}
Spread momentum: ${JSON.stringify(spreadChanges)}

Return this exact JSON structure:
{
  "structure_type": "HEALTHY_PULLBACK"|"WEAK_PULLBACK"|"STRONG_TREND"|"REVERSAL_RISK"|"CHOPPY"|"EXHAUSTED",
  "trend_health": "STRONG"|"MODERATE"|"WEAK",
  "continuation_probability": <0.0-1.0>,
  "market_quality": "CLEAN"|"NOISY"|"CHOPPY",
  "warning": <null or max 8-word string>,
  "summary": <one sentence max 12 words>,
  "details": {
    "structure_analysis": <2 sentences: what the spread pattern shows>,
    "trend_assessment": <2 sentences: base vs quote strength behavior>,
    "pullback_quality": <1-2 sentences: is compression healthy or aggressive>,
    "entry_timing": <1 sentence: is now good, early, or late to enter>,
    "support_factors": [<up to 3 short strings, what supports the setup>],
    "risk_factors": [<up to 3 short strings, what could invalidate it>],
    "ai_verdict": "ENTER"|"WAIT"|"AVOID"
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
    .select('instrument, state, bias, confidence, spread_behavior')
    .eq('time', latest.time);

  if (sErr) throw sErr;

  // Priority tiers — analyze top 6 setups across active states
  const PRIORITY = {
    READY_TO_ENTER:   4,
    ENTRY_ACTIVE:     4,
    PULLBACK_ACTIVE:  3,
    PULLBACK_STARTING:2,
    TREND_FORMING:    1,
  };

  const targets = (states || [])
    .filter(s => PRIORITY[s.state] !== undefined && s.confidence >= 40)
    .sort((a, b) => {
      const pa = PRIORITY[a.state] || 0, pb = PRIORITY[b.state] || 0;
      return pa !== pb ? pb - pa : b.confidence - a.confidence;
    })
    .slice(0, 6);

  if (!targets.length) {
    console.log('[AI] No active setups to analyze (all pairs below threshold or NO_TRADE)');
    return;
  }

  console.log(`[AI] Analyzing ${targets.length} setup(s)...`);

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
