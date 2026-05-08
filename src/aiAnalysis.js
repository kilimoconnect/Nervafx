const OpenAI = require('openai');
const { supabase } = require('./supabase');

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ─── Fetch data ───────────────────────────────────────────────────────────────

async function getHistory(instrument) {
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

  const sortedSpreads = spreadData.sort((a, b) => new Date(a.time) - new Date(b.time)).slice(-48);

  const baseArr = strengthData.filter(d => d.currency === base)
    .sort((a, b) => new Date(a.time) - new Date(b.time)).slice(-48)
    .map(d => +parseFloat(d.smooth_6h || 0).toFixed(6));

  const quoteArr = strengthData.filter(d => d.currency === quote)
    .sort((a, b) => new Date(a.time) - new Date(b.time)).slice(-48)
    .map(d => +parseFloat(d.smooth_6h || 0).toFixed(6));

  const spread3h  = sortedSpreads.map(d => +parseFloat(d.spread_3h  || 0).toFixed(6));
  const spread6h  = sortedSpreads.map(d => +parseFloat(d.spread_6h  || 0).toFixed(6));
  const spread12h = sortedSpreads.map(d => +parseFloat(d.spread_12h || 0).toFixed(6));

  return { base, quote, baseArr, quoteArr, spread3h, spread6h, spread12h };
}

// ─── Deterministic metrics ────────────────────────────────────────────────────

function computeMetrics(state, spread3h, spread6h, spread12h, baseArr, quoteArr) {
  const bias = state.bias;
  const dir  = bias === 'BUY' ? 1 : -1;
  const n    = spread3h.length;
  if (n < 4) return null;

  const s3  = spread3h[n - 1];
  const s6  = spread6h[n - 1];
  const s12 = spread12h[n - 1];

  // Per-cycle deltas
  const delta3h  = spread3h.map((v, i) => i === 0 ? 0 : v - spread3h[i - 1]);
  const delta6h  = spread6h.map((v, i) => i === 0 ? 0 : v - spread6h[i - 1]);
  const delta12h = spread12h.map((v, i) => i === 0 ? 0 : v - spread12h[i - 1]);

  // Second derivative — acceleration of 6H spread
  const accel6h = delta6h.map((v, i) => i === 0 ? 0 : v - delta6h[i - 1]);

  // Consecutive compression cycles (3H moving against bias)
  let compressionCycles = 0;
  for (let i = n - 1; i > 0; i--) {
    if (delta3h[i] * dir < -0.000001) compressionCycles++;
    else break;
  }

  // Consecutive expansion cycles (3H resuming bias direction)
  let expansionCycles = 0;
  for (let i = n - 1; i > 0; i--) {
    if (delta3h[i] * dir > 0.000001) expansionCycles++;
    else break;
  }

  // Compression depth: |3H| as fraction of |6H|
  const depthRatio = Math.abs(s6) > 0.000001 ? Math.abs(s3) / Math.abs(s6) : 0;

  // Deceleration of compression: last 8 accel6h cycles positive in bias dir
  const recentAccel = accel6h.slice(-8);
  const decelCycles = recentAccel.filter(a => a * dir > 0.0000001).length;
  const isDecelerating = decelCycles >= 4;

  // 6H directional stability: how many of last 14 cycles held bias direction
  const s6StableCount  = delta6h.slice(-14).filter(d => d * dir >= -0.000005).length;
  const s12StableCount = delta12h.slice(-14).filter(d => d * dir >= -0.000005).length;

  // Base / quote strength trends — compare early 12 vs recent 12 cycles
  const bEarly = baseArr.slice(-24, -12); const bLate = baseArr.slice(-12);
  const qEarly = quoteArr.slice(-24, -12); const qLate = quoteArr.slice(-12);
  const bAvgEarly = bEarly.reduce((a, b) => a + b, 0) / (bEarly.length || 1);
  const bAvgLate  = bLate.reduce((a, b) => a + b, 0)  / (bLate.length  || 1);
  const qAvgEarly = qEarly.reduce((a, b) => a + b, 0) / (qEarly.length || 1);
  const qAvgLate  = qLate.reduce((a, b) => a + b, 0)  / (qLate.length  || 1);

  const baseShift  = (bAvgLate - bAvgEarly) * dir;   // positive = base strengthening in bias direction
  const quoteShift = (qAvgEarly - qAvgLate) * dir;   // positive = quote weakening (supports bias)

  // ── Lifecycle phase + completion (deterministic) ──────────────────────────
  let phase, completion;

  if (state.state === 'READY_TO_ENTER') {
    phase = 'RE_EXPANDING';
    completion = Math.min(95, 20 + expansionCycles * 15);
  } else if (state.state === 'TREND') {
    phase = 'TRENDING';
    completion = 50;
  } else {
    // PULLBACK_STARTING or PULLBACK_ACTIVE
    const durationScore = Math.min(1, compressionCycles / 10) * 50;
    const depthScore    = (depthRatio > 0.1 && depthRatio < 0.8) ? 20
                        : (depthRatio >= 0.8 ? 12 : 5);
    const decelScore    = (decelCycles / 8) * 30;
    const raw = durationScore + depthScore + decelScore;
    completion = Math.round(Math.min(95, Math.max(5, raw)));
    phase = completion <= 33 ? 'EARLY_PULLBACK'
          : completion <= 65 ? 'MID_PULLBACK'
          : 'LATE_PULLBACK';
  }

  // ── Scores (0-100, deterministic) ─────────────────────────────────────────
  const trend_health = Math.round(Math.min(100,
    (s6 * dir > 0  ? 30 : 0) +
    (s12 * dir > 0 ? 25 : 0) +
    Math.min(Math.abs(s6) / 0.006, 1) * 25 +
    (s6StableCount / 14) * 20
  ));

  const pullback_quality = Math.round(Math.min(100,
    (depthRatio > 0.1 && depthRatio < 0.75 ? 40 : 20) +
    (isDecelerating ? 30 : 10) +
    (compressionCycles >= 3 && compressionCycles <= 12 ? 15 : 5) +
    (decelCycles / 8) * 15
  ));

  const deltaVar    = delta6h.slice(-12).reduce((sum, v) => sum + v * v, 0) / 12;
  const cleanliness = Math.round(Math.min(100, Math.max(20, 95 - deltaVar * 4000000)));

  const continuation = Math.round(
    trend_health    * 0.30 +
    pullback_quality * 0.30 +
    cleanliness     * 0.15 +
    (completion / 100) * 15 +
    (isDecelerating ? 10 : 0)
  );

  return {
    dir, s3, s6, s12,
    compressionCycles, expansionCycles, depthRatio,
    decelCycles, isDecelerating, recentAccel,
    s6StableCount, s12StableCount,
    baseShift, quoteShift,
    phase, completion,
    scores: { continuation, trend_health, pullback_quality, cleanliness },
  };
}

// ─── Qualitative descriptions (no raw numbers) ────────────────────────────────

function describeMetrics(m, state, base, quote) {
  const { dir, compressionCycles, expansionCycles, depthRatio,
          decelCycles, isDecelerating, s6StableCount, s12StableCount,
          baseShift, quoteShift, phase, completion } = m;
  const bias    = state.bias;
  const biasDir = dir === 1 ? 'bullish' : 'bearish';

  const depthDesc = depthRatio < 0.20 ? 'very shallow — 3H barely compressed relative to 6H'
    : depthRatio < 0.40 ? 'light — 3H compressed to roughly a quarter of 6H magnitude'
    : depthRatio < 0.65 ? 'moderate — 3H around half of 6H magnitude, controlled depth'
    : depthRatio < 0.85 ? 'deep — 3H reaching towards 6H magnitude, stronger counter-pressure'
    : 'aggressive — 3H nearly matching 6H magnitude, heavy counter-trend pressure';

  const decelDesc = decelCycles >= 6 ? `strongly decelerating — compression velocity fading in ${decelCycles} of last 8 cycles`
    : decelCycles >= 4 ? `decelerating — counter-trend pressure weakening over recent cycles`
    : decelCycles >= 2 ? `mixed signals — some deceleration emerging but not yet dominant`
    : `still building — counter-trend pressure has not shown clear deceleration`;

  const s6Desc = s6StableCount >= 12 ? `very stable, held ${biasDir} direction consistently`
    : s6StableCount >= 9 ? `stable, ${s6StableCount} of last 14 cycles held ${biasDir} direction`
    : s6StableCount >= 6 ? `moderately stable, showing minor directional fluctuation`
    : `weakening, directional integrity declining`;

  const s12Desc = s12StableCount >= 12 ? `strongly aligned, no structural shift detected`
    : s12StableCount >= 9 ? `well aligned, ${s12StableCount} of last 14 cycles held direction`
    : `showing gradual weakening over recent cycles`;

  const baseDesc = baseShift > 0.001 ? `${base} strengthened over the 48H window — supporting ${bias} bias`
    : baseShift > -0.0005 ? `${base} broadly stable — neutral contribution to spread structure`
    : `${base} weakened over the 48H window — adding mild counter-pressure`;

  const quoteDesc = quoteShift > 0.001 ? `${quote} weakened over the 48H window — supporting ${bias} bias`
    : quoteShift > -0.0005 ? `${quote} broadly stable — neutral contribution`
    : `${quote} strengthened over the 48H window — adding counter-pressure to the spread`;

  const phaseDesc = {
    TRENDING:       `Active ${biasDir} trend — 3H and 6H both expanding in bias direction`,
    EARLY_PULLBACK: `Early pullback stage — 3H compression just started (${compressionCycles} cycles), 6H trend still intact`,
    MID_PULLBACK:   `Mid pullback — 3H has been compressing for ${compressionCycles} H1 cycles while 6H holds direction`,
    LATE_PULLBACK:  `Late pullback — ${compressionCycles} cycles of compression with deceleration signals emerging, structure approaching re-expansion`,
    RE_EXPANDING:   `Re-expansion underway — 3H has turned ${biasDir} again for ${expansionCycles} cycles, spread lifecycle resuming`,
    EXHAUSTING:     `Structural exhaustion — spread momentum failing to extend, lifecycle deteriorating`,
  }[phase] || '';

  return {
    phaseDesc, depthDesc, decelDesc, s6Desc, s12Desc, baseDesc, quoteDesc,
    compressionCycles, expansionCycles, decelCycles, phase, completion,
    biasDir,
  };
}

// ─── Core analysis ────────────────────────────────────────────────────────────

async function analyzeSetup(instrument, state) {
  const { base, quote, baseArr, quoteArr, spread3h, spread6h, spread12h }
    = await getHistory(instrument);

  const metrics = computeMetrics(state, spread3h, spread6h, spread12h, baseArr, quoteArr);
  if (!metrics) throw new Error('Not enough data points');

  const desc = describeMetrics(metrics, state, base, quote);

  console.log(`[AI] ${instrument} → ${metrics.phase} ${metrics.completion}% | comp=${metrics.compressionCycles}cyc depth=${metrics.depthRatio.toFixed(2)} decel=${metrics.decelCycles}/8`);

  const client = getClient();

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1000,
    temperature: 0.15,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are the interpretive layer of a currency strength engine.
The engine computes all numbers deterministically. Your job is to write what the numbers MEAN.

RULES — strictly enforced:
1. NEVER include raw decimal numbers (e.g. 0.00136, -0.00043). Forbidden entirely.
2. Cycle counts from the context are allowed (e.g. "6 H1 cycles", "last 8 cycles").
3. Use engine vocabulary: 3H compression, 6H spread, 12H alignment, spread lifecycle, re-expansion, compression velocity, dominant bias.
4. Lifecycle phase is engine-determined and FIXED — your text must align with it, never contradict.
5. No trade recommendations. No entry/exit signals. Pure structure interpretation.
6. Write as if briefing a senior analyst — professional, precise, no filler phrases.`,
      },
      {
        role: 'user',
        content: `Interpret the structure for ${instrument.replace('_', '/')}:

ENGINE STATE:
- Bias: ${state.bias} | Market State: ${state.state} | Confidence: ${state.confidence}%
- Lifecycle: ${desc.phase} — ${desc.phaseDesc}
- Phase completion: ${desc.completion}% (deterministic)

STRUCTURAL FACTS:
- 3H compression: ${desc.compressionCycles} consecutive H1 cycles | Depth: ${desc.depthDesc}
- Compression velocity (6H acceleration): ${desc.decelDesc}
- 6H spread: ${desc.s6Desc}
- 12H spread: ${desc.s12Desc}
- ${desc.baseDesc}
- ${desc.quoteDesc}

SCORES (engine-computed, use as-is):
{ "continuation": ${metrics.scores.continuation}, "trend_health": ${metrics.scores.trend_health}, "pullback_quality": ${metrics.scores.pullback_quality}, "cleanliness": ${metrics.scores.cleanliness} }

Return this exact JSON. All text fields: interpret the facts above — no raw decimals, use cycle counts, use engine terminology:
{
  "structure_type": "HEALTHY_PULLBACK"|"WEAK_PULLBACK"|"STRONG_TREND"|"REVERSAL_RISK"|"CHOPPY"|"EXHAUSTED",
  "market_quality": "CLEAN"|"NOISY"|"CHOPPY",
  "warning": <null or one short structural observation — no decimals>,
  "summary": <one sentence: must name 3H/6H behavior and cycle count — no decimals>,
  "details": {
    "lifecycle_phase": "${desc.phase}",
    "lifecycle_completion": ${desc.completion},
    "scores": { "continuation": ${metrics.scores.continuation}, "trend_health": ${metrics.scores.trend_health}, "pullback_quality": ${metrics.scores.pullback_quality}, "cleanliness": ${metrics.scores.cleanliness} },
    "structure_analysis": <2 sentences: describe 3H vs 6H spread relationship and what it reveals — no decimals, cite cycle counts>,
    "trend_assessment": <2 sentences: describe how ${base} and ${quote} strength behaved over 48H — interpret the shift, no decimals>,
    "pullback_quality_text": <1-2 sentences: characterize compression depth and duration — is it controlled or aggressive>,
    "momentum_shift": <1-2 sentences: describe compression velocity and acceleration — is counter-trend pressure fading or building>,
    "support_factors": [<up to 3 strings: each references 3H, 6H, or 12H spread behavior — no decimals>],
    "risk_factors": [<up to 3 strings: each references 3H, 6H, or 12H behavior — no decimals, no external factors>]
  }
}`,
      },
    ],
  });

  const parsed = JSON.parse(response.choices[0].message.content.trim());

  // Enforce lifecycle fields — AI must not override what engine computed
  parsed.details.lifecycle_phase      = metrics.phase;
  parsed.details.lifecycle_completion = metrics.completion;
  parsed.details.scores               = metrics.scores;

  return parsed;
}

// ─── Persist ──────────────────────────────────────────────────────────────────

async function saveAnalysis(instrument, time, result) {
  const { details, ...top } = result;
  const sc = details?.scores || {};
  const th = sc.trend_health || 0;

  const { error } = await supabase.from('ai_analysis').upsert(
    {
      instrument,
      time,
      structure_type:          top.structure_type  || null,
      trend_health:            th >= 70 ? 'STRONG' : th >= 45 ? 'MODERATE' : 'WEAK',
      continuation_probability: (sc.continuation || 0) / 100,
      market_quality:          top.market_quality  || null,
      warning:                 top.warning         || null,
      summary:                 top.summary         || null,
      details:                 details             || null,
    },
    { onConflict: 'instrument,time' }
  );
  if (error) throw new Error(`AI save error: ${error.message}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function analyzeActiveSetups() {
  if (!process.env.OPENAI_API_KEY) { console.log('[AI] No OPENAI_API_KEY — skipping'); return; }

  const { data: latest, error: tErr } = await supabase
    .from('market_states').select('time').order('time', { ascending: false }).limit(1).single();
  if (tErr || !latest) { console.log('[AI] No states found'); return; }

  const { data: states, error: sErr } = await supabase
    .from('market_states')
    .select('instrument, state, bias, confidence, spread_3h, spread_6h, spread_12h')
    .eq('time', latest.time);
  if (sErr) throw sErr;

  const PRIORITY = { READY_TO_ENTER: 4, PULLBACK_ACTIVE: 3, PULLBACK_STARTING: 2, TREND: 1 };

  console.log(`[AI] States: ${JSON.stringify(
    (states||[]).reduce((a,s)=>{ a[s.state]=(a[s.state]||0)+1; return a; }, {})
  )}`);

  const targets = (states || [])
    .filter(s => PRIORITY[s.state] !== undefined && s.confidence >= 40)
    .sort((a, b) => {
      const pa = PRIORITY[a.state]||0, pb = PRIORITY[b.state]||0;
      return pa !== pb ? pb - pa : b.confidence - a.confidence;
    })
    .slice(0, 6);

  if (!targets.length) { console.log('[AI] No active setups'); return; }

  console.log(`[AI] Analyzing: ${targets.map(t=>`${t.instrument}(${t.state}@${t.confidence}%)`).join(', ')}`);

  for (const state of targets) {
    try {
      const result = await analyzeSetup(state.instrument, state);
      await saveAnalysis(state.instrument, latest.time, result);
      const sc = result.details?.scores || {};
      console.log(`[AI] ✓ ${state.instrument}: ${result.details?.lifecycle_phase} ${result.details?.lifecycle_completion}% | cont=${sc.continuation} trend=${sc.trend_health} pbq=${sc.pullback_quality} clean=${sc.cleanliness}`);
    } catch (err) {
      console.error(`[AI] ✗ ${state.instrument}: ${err.message}`);
    }
  }
}

module.exports = { analyzeActiveSetups };
