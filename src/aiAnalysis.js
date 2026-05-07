const OpenAI = require('openai');
const { supabase } = require('./supabase');

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ─── Fetch last 48 smoothed values + 3H/6H/12H spreads ───────────────────────

async function getSmoothedHistory(instrument) {
  const [base, quote] = instrument.split('_');

  const { data: strengthData, error: sErr } = await supabase
    .from('currency_strength')
    .select('time, currency, smooth_6h')
    .in('currency', [base, quote])
    .order('time', { ascending: false })
    .limit(100);

  if (sErr) throw sErr;

  const { data: spreadData, error: spErr } = await supabase
    .from('pair_strength_spreads')
    .select('time, spread_3h, spread_6h, spread_12h')
    .eq('instrument', instrument)
    .order('time', { ascending: false })
    .limit(48);

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

  const sorted = spreadData.sort((a, b) => new Date(a.time) - new Date(b.time)).slice(-48);
  const spread3h  = sorted.map(d => +parseFloat(d.spread_3h  || 0).toFixed(5));
  const spread6h  = sorted.map(d => +parseFloat(d.spread_6h  || 0).toFixed(5));
  const spread12h = sorted.map(d => +parseFloat(d.spread_12h || 0).toFixed(5));

  // Per-step change in 6H spread (momentum)
  const spread6hDelta = spread6h.map((v, i) =>
    i === 0 ? 0 : +(v - spread6h[i - 1]).toFixed(5)
  );

  console.log(`[AI] ${instrument} data: base=${baseArr.length} pts, spread3h=${spread3h.length} pts`);

  const s3  = (+state.spread_3h  || 0).toFixed(5);
  const s6  = (+state.spread_6h  || 0).toFixed(5);
  const s12 = (+state.spread_12h || 0).toFixed(5);

  const client = getClient();

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1400,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are an analyst for a currency strength engine that tracks 3H, 6H, and 12H smoothed spread values.

Your analysis MUST:
- Reference specific timeframes: 3H spread, 6H spread, 12H spread
- Count actual cycles from the data arrays (e.g. "3H compression lasted 6 H1 cycles")
- Use engine terminology: compression, re-expansion, spread lifecycle, pullback depth, dominant bias
- Describe WHAT IS HAPPENING in the spread data, not generic market commentary

Your analysis MUST NOT:
- Mention price, candlesticks, economic data, or external news
- Give trade recommendations or entry/exit signals
- Use generic phrases like "potential for continuation", "momentum has stalled", "market may reverse"
- Reference anything outside the 3H/6H/12H spread arrays provided

Return ONLY valid JSON.`,
      },
      {
        role: 'user',
        content: `Analyze ${instrument.replace('_', '/')} — bias: ${state.bias}, engine state: ${state.state}, confidence: ${state.confidence}%
Current spreads: 3H=${s3}  6H=${s6}  12H=${s12}

Last 48 H1 smoothed values (index 0 = oldest, index 47 = most recent):
${base} strength (smooth_6h): ${JSON.stringify(baseArr)}
${quote} strength (smooth_6h): ${JSON.stringify(quoteArr)}
3H spread (${base}−${quote}): ${JSON.stringify(spread3h)}
6H spread (${base}−${quote}): ${JSON.stringify(spread6h)}
12H spread (${base}−${quote}): ${JSON.stringify(spread12h)}
6H spread per-step delta: ${JSON.stringify(spread6hDelta)}

IMPORTANT — use exact values from the arrays above. Count cycles. Reference the data directly.

Return this exact JSON (all text fields must reference 3H/6H/12H spread behavior — no generic language):
{
  "structure_type": "HEALTHY_PULLBACK"|"WEAK_PULLBACK"|"STRONG_TREND"|"REVERSAL_RISK"|"CHOPPY"|"EXHAUSTED",
  "market_quality": "CLEAN"|"NOISY"|"CHOPPY",
  "warning": <null or max 10-word structural observation referencing 3H/6H/12H>,
  "summary": <one sentence, MUST reference 3H/6H/12H spreads and cycle count — no generic language>,
  "details": {
    "lifecycle_phase": "EARLY_PULLBACK"|"MID_PULLBACK"|"LATE_PULLBACK"|"RE_EXPANDING"|"TRENDING"|"EXHAUSTING",
    "lifecycle_completion": <integer 0-100: how far through current phase based on spread patterns>,
    "scores": {
      "continuation": <integer 0-100: probability current spread structure continues>,
      "trend_health": <integer 0-100: 12H+6H alignment strength and stability over 48H>,
      "pullback_quality": <integer 0-100: how controlled and proportional the 3H compression is>,
      "cleanliness": <integer 0-100: smoothness and consistency of spread progression>
    },
    "structure_analysis": <2 sentences: describe the 3H/6H/12H spread pattern with specific cycle counts and values>,
    "trend_assessment": <2 sentences: describe how ${base} vs ${quote} strength evolved — reference specific indices or values>,
    "pullback_quality_text": <1-2 sentences: describe 3H compression depth and duration in cycles — is spread_3h shrinking proportionally to spread_6h>,
    "momentum_shift": <1-2 sentences: describe spread_6h delta trend — cite how many cycles it accelerated/decelerated>,
    "support_factors": [<up to 3 strings: each must reference 3H, 6H, or 12H spread behavior — no external factors>],
    "risk_factors": [<up to 3 strings: each must reference 3H, 6H, or 12H compression/expansion behavior only>]
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
  const { details, ...top } = result;
  // Map scores.continuation (0-100) → continuation_probability (0-1) for DB column
  const cont = details?.scores?.continuation ?? null;
  const continuation_probability = cont !== null ? cont / 100 : null;

  // trend_health column: derive label from score
  const th = details?.scores?.trend_health ?? 0;
  const trend_health = th >= 70 ? 'STRONG' : th >= 45 ? 'MODERATE' : 'WEAK';

  const { error } = await supabase
    .from('ai_analysis')
    .upsert(
      {
        instrument,
        time,
        structure_type:         top.structure_type         || null,
        trend_health,
        continuation_probability,
        market_quality:         top.market_quality         || null,
        warning:                top.warning                || null,
        summary:                top.summary                || null,
        details:                details                    || null,
      },
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

  const PRIORITY = {
    READY_TO_ENTER:    4,
    PULLBACK_ACTIVE:   3,
    PULLBACK_STARTING: 2,
    TREND:             1,
  };

  console.log(`[AI] State breakdown: ${JSON.stringify(
    (states || []).reduce((acc, s) => { acc[s.state] = (acc[s.state]||0)+1; return acc; }, {})
  )}`);

  const targets = (states || [])
    .filter(s => PRIORITY[s.state] !== undefined && s.confidence >= 40)
    .sort((a, b) => {
      const pa = PRIORITY[a.state]||0, pb = PRIORITY[b.state]||0;
      return pa !== pb ? pb - pa : b.confidence - a.confidence;
    })
    .slice(0, 6);

  if (!targets.length) {
    console.log('[AI] No active setups to analyze');
    return;
  }

  console.log(`[AI] Analyzing ${targets.length} setup(s): ${targets.map(t=>`${t.instrument}(${t.state}@${t.confidence}%)`).join(', ')}`);

  for (const state of targets) {
    try {
      const result = await analyzeSetup(state.instrument, state);
      await saveAnalysis(state.instrument, latest.time, result);
      const sc = result.details?.scores || {};
      console.log(`[AI] ✓ ${state.instrument}: ${result.details?.lifecycle_phase} | cont=${sc.continuation}% trend=${sc.trend_health}% pbq=${sc.pullback_quality}% clean=${sc.cleanliness}%`);
    } catch (err) {
      console.error(`[AI] ✗ ${state.instrument}: ${err.message}`);
    }
  }
}

module.exports = { analyzeActiveSetups };
