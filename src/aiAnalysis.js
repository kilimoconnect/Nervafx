const OpenAI = require('openai');
const { supabase } = require('./supabase');

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ─── Fetch pair history ───────────────────────────────────────────────────────

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

// ─── Fetch latest risk sentiment row ─────────────────────────────────────────

async function getLatestSentiment() {
  const { data, error } = await supabase
    .from('risk_sentiment')
    .select('*')
    .order('time', { ascending: false })
    .limit(1);
  if (error) {
    console.warn(`[AI] Could not fetch risk sentiment: ${error.message}`);
    return null;
  }
  return data?.[0] || null;
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

  const delta3h  = spread3h.map((v, i) => i === 0 ? 0 : v - spread3h[i - 1]);
  const delta6h  = spread6h.map((v, i) => i === 0 ? 0 : v - spread6h[i - 1]);
  const delta12h = spread12h.map((v, i) => i === 0 ? 0 : v - spread12h[i - 1]);
  const accel6h  = delta6h.map((v, i) => i === 0 ? 0 : v - delta6h[i - 1]);

  let compressionCycles = 0;
  for (let i = n - 1; i > 0; i--) {
    if (delta3h[i] * dir < -0.000001) compressionCycles++;
    else break;
  }
  let expansionCycles = 0;
  for (let i = n - 1; i > 0; i--) {
    if (delta3h[i] * dir > 0.000001) expansionCycles++;
    else break;
  }

  const depthRatio   = Math.abs(s6) > 0.000001 ? Math.abs(s3) / Math.abs(s6) : 0;
  const recentAccel  = accel6h.slice(-8);
  const decelCycles  = recentAccel.filter(a => a * dir > 0.0000001).length;
  const isDecelerating = decelCycles >= 4;

  const s6StableCount  = delta6h.slice(-14).filter(d => d * dir >= -0.000005).length;
  const s12StableCount = delta12h.slice(-14).filter(d => d * dir >= -0.000005).length;

  const bEarly = baseArr.slice(-24, -12);  const bLate = baseArr.slice(-12);
  const qEarly = quoteArr.slice(-24, -12); const qLate = quoteArr.slice(-12);
  const bAvgEarly = bEarly.reduce((a, b) => a + b, 0) / (bEarly.length || 1);
  const bAvgLate  = bLate.reduce((a, b) => a + b, 0)  / (bLate.length  || 1);
  const qAvgEarly = qEarly.reduce((a, b) => a + b, 0) / (qEarly.length || 1);
  const qAvgLate  = qLate.reduce((a, b) => a + b, 0)  / (qLate.length  || 1);

  const baseShift  = (bAvgLate - bAvgEarly) * dir;
  const quoteShift = (qAvgEarly - qAvgLate) * dir;

  let phase, completion;
  if (state.state === 'READY_TO_ENTER') {
    phase = 'RE_EXPANDING';
    completion = Math.min(95, 20 + expansionCycles * 15);
  } else if (state.state === 'TREND') {
    phase = 'TRENDING';
    completion = 50;
  } else {
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
    trend_health     * 0.30 +
    pullback_quality * 0.30 +
    cleanliness      * 0.15 +
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

// ─── Qualitative descriptions ─────────────────────────────────────────────────

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

// ─── Risk sentiment — qualitative description for AI context ──────────────────

// How each currency behaves in each regime:
// +1 = expected to strengthen, −1 = expected to weaken, 0 = neutral
const REGIME_STRENGTH = {
  RISK_ON:  { AUD: 1, NZD: 1, GBP: 0.5, CAD: 0.5, EUR: 0, USD: -0.5, CHF: -0.5, JPY: -1 },
  RISK_OFF: { AUD: -1, NZD: -1, GBP: -0.5, CAD: -0.5, EUR: 0, USD: 0.5, CHF: 0.5, JPY: 1 },
};

// What each currency represents in the global flow-of-money picture
const CURRENCY_ROLE = {
  USD: 'the world\'s primary reserve and liquidity currency — aggressively bid during deleveraging, panic, and dollar shortages; weakens when risk appetite returns and capital flows into higher-yielding assets',
  JPY: 'the primary carry-trade funding and safe-haven currency — strengthens sharply when risk aversion rises as carry trades unwind and capital returns to Japan; weakens when global risk appetite supports carry trade expansion',
  CHF: 'a European safe-haven and capital-preservation currency — attracted during geopolitical stress and European instability; weakens as fear recedes and capital seeks yield',
  AUD: 'a high-yielding commodity and risk-sensitive currency — benefits from global growth, commodity demand, and carry appetite; among the first sold when risk aversion rises',
  NZD: 'a high-yielding risk-sensitive currency closely tied to AUD — flows with global risk appetite and commodity cycles; vulnerable to sharp carry unwinds',
  GBP: 'a semi-risk-sensitive reserve currency — broadly tracks global risk appetite but also influenced by UK-specific dynamics; tends to weaken modestly in broad risk-off environments',
  EUR: 'a large global reserve currency — moderately risk-sensitive; behaves defensively during acute global stress as dollar demand rises but does not typically receive direct safe-haven flows',
  CAD: 'an oil-linked commodity currency tied to North American growth — benefits from rising oil demand and global expansion; pressured when energy prices fall or growth fears dominate',
};

// Deterministic: does the macro regime support or conflict with this pair's setup?
function computeMacroAlignment(sentimentRow, state, base, quote) {
  if (!sentimentRow || sentimentRow.sentiment === 'NEUTRAL') return 'NEUTRAL';
  if ((sentimentRow.confidence || 0) < 35) return 'NEUTRAL';

  const regime = sentimentRow.sentiment; // RISK_ON or RISK_OFF
  const exp    = REGIME_STRENGTH[regime] || {};

  const baseExpect  = exp[base]  ?? 0;
  const quoteExpect = exp[quote] ?? 0;

  // BUY = want base stronger (+), quote weaker (−)
  // SELL = want base weaker (−), quote stronger (+)
  const biasDir = state.bias === 'BUY' ? 1 : -1;
  const score   = biasDir * (baseExpect - quoteExpect);

  if (score >  0.5) return 'ALIGNED';
  if (score < -0.5) return 'CONFLICTED';
  return 'NEUTRAL';
}

// Build qualitative macro context to include in the AI prompt
function describeSentiment(s, base, quote) {
  if (!s) return null;

  // Identify dominant flow drivers by score magnitude
  const FLOW_SIGNALS = [
    { key: 'equity_score',  pos: 'global equities expanding — growth demand driving risk appetite',
                             neg: 'global equities under pressure — institutional risk appetite deteriorating' },
    { key: 'gold_score',    pos: 'gold demand declining — fear absent, capital leaving safety',
                             neg: 'gold surging — capital flowing into precious metals, fear elevated' },
    { key: 'jpy_score',     pos: 'JPY weakening — safe-haven flows receding, carry trade rebuilding',
                             neg: 'JPY strengthening aggressively — carry trades unwinding, capital rushing to safety' },
    { key: 'chf_score',     pos: 'CHF weakening — European/global fear receding',
                             neg: 'CHF strengthening — defensive flows into European safe haven' },
    { key: 'usd_score',     pos: 'USD softening — dollar liquidity not being hoarded, risk appetite present',
                             neg: 'USD strengthening — dollar liquidity demand rising, deleveraging pressure building' },
    { key: 'oil_score',     pos: 'oil rising with equities — global demand signal confirmed, growth expectations intact',
                             neg: 'oil diverging from equities — growth concern or supply-shock risk signal' },
    { key: 'audjpy_score',  pos: 'AUD/JPY carry spread recovering — high-yield appetite and risk-on rotation underway',
                             neg: 'AUD/JPY carry unwinding — risk aversion spreading, carry positions being closed' },
    { key: 'nzdjpy_score',  pos: 'NZD/JPY carry spread positive — broad risk appetite supported across Pacific currencies',
                             neg: 'NZD/JPY carry declining — NZD facing structural risk-off pressure' },
  ];

  const drivers = FLOW_SIGNALS
    .filter(d => Math.abs(s[d.key] || 0) > 18)
    .sort((a, b) => Math.abs(s[b.key] || 0) - Math.abs(s[a.key] || 0))
    .slice(0, 4)
    .map(d => (s[d.key] || 0) > 0 ? d.pos : d.neg);

  const accel = s.accel_composite || 0;
  const accelDesc =
    accel >  30 ? 'risk-on conditions accelerating sharply — momentum building fast'
  : accel >  10 ? 'risk-on conditions building gradually — not yet decisive'
  : accel < -30 ? 'risk-off conditions accelerating sharply — conditions deteriorating rapidly, avoid new risk positions'
  : accel < -10 ? 'risk-off momentum building — watch for continuation'
  :               'conditions broadly stable — no sharp directional acceleration';

  const envDesc =
    s.environment === 'STRESS'   ? 'STRESS — multiple defensive assets moving violently and simultaneously; conditions unstable'
  : s.environment === 'ELEVATED' ? 'ELEVATED — above-normal cross-asset activity; monitor for escalation'
  :                                 'CALM — orderly conditions, no panic signals';

  return {
    sentiment:  s.sentiment,
    environment: s.environment,
    envDesc,
    confidence: s.confidence,
    drivers:    drivers.length ? drivers : ['no dominant directional flow detected — conditions broadly balanced'],
    baseRole:   CURRENCY_ROLE[base]  || `${base} — broadly tracked`,
    quoteRole:  CURRENCY_ROLE[quote] || `${quote} — broadly tracked`,
    accelDesc,
  };
}

// ─── Core analysis ────────────────────────────────────────────────────────────

async function analyzeSetup(instrument, state, sentimentRow) {
  const { base, quote, baseArr, quoteArr, spread3h, spread6h, spread12h }
    = await getHistory(instrument);

  const metrics = computeMetrics(state, spread3h, spread6h, spread12h, baseArr, quoteArr);
  if (!metrics) throw new Error('Not enough data points');

  const desc           = describeMetrics(metrics, state, base, quote);
  const macroAlignment = computeMacroAlignment(sentimentRow, state, base, quote);
  const sd             = describeSentiment(sentimentRow, base, quote);

  const macroAlignmentDesc =
    macroAlignment === 'ALIGNED'    ? 'macro regime supports this pair\'s directional bias'
  : macroAlignment === 'CONFLICTED' ? 'macro regime is working against this pair\'s directional bias'
  :                                    'macro regime is neutral for this pair';

  console.log(`[AI] ${instrument} → ${metrics.phase} ${metrics.completion}% | macro:${macroAlignment}${sd ? ` [${sd.sentiment}]` : ''} | comp=${metrics.compressionCycles}cyc depth=${metrics.depthRatio.toFixed(2)} decel=${metrics.decelCycles}/8`);

  const client = getClient();

  // Build macro section for prompt — only included when sentiment data is available
  const macroSection = sd ? `
MACRO / FLOW OF MONEY:
- Risk Regime: ${sd.sentiment} [${sd.environment}] | Confidence: ${sd.confidence}%
- Environment: ${sd.envDesc}
- Active flows: ${sd.drivers.join('; ')}
- Momentum: ${sd.accelDesc}
- ${base} role: ${sd.baseRole}
- ${quote} role: ${sd.quoteRole}
- Macro alignment for this setup: ${macroAlignment} — ${macroAlignmentDesc}
` : '\nMACRO / FLOW OF MONEY: data not available\n';

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1200,
    temperature: 0.15,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are the interpretive layer of a currency strength engine.
The engine computes all numbers deterministically. Your job is to write what the numbers MEAN.

RULES — strictly enforced:
1. NEVER include raw decimal numbers (e.g. 0.00136, -0.00043). Forbidden entirely.
2. Cycle counts are allowed (e.g. "6 H1 cycles", "last 8 cycles").
3. Use engine vocabulary: 3H compression, 6H spread, 12H alignment, spread lifecycle, re-expansion, compression velocity, dominant bias.
4. Lifecycle phase is engine-determined and FIXED — your text must align with it, never contradict.
5. No trade recommendations. No entry/exit signals. Pure structure and flow interpretation.
6. For flow_of_money: explain where capital is moving at the macro level and connect it to this pair's specific currencies — name which currency is being bid or sold and why.
7. Write as if briefing a senior analyst — professional, precise, no filler phrases.`,
      },
      {
        role: 'user',
        content: `Interpret the structure and macro context for ${instrument.replace('_', '/')}:

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
${macroSection}
Return this exact JSON. All text fields: interpret the facts — no raw decimals, use cycle counts and engine terminology:
{
  "structure_type": "HEALTHY_PULLBACK"|"WEAK_PULLBACK"|"STRONG_TREND"|"REVERSAL_RISK"|"CHOPPY"|"EXHAUSTED",
  "market_quality": "CLEAN"|"NOISY"|"CHOPPY",
  "warning": <null or one short structural or macro observation — no decimals>,
  "summary": <one sentence: must name 3H/6H behavior, cycle count, and macro regime — no decimals>,
  "details": {
    "lifecycle_phase": "${desc.phase}",
    "lifecycle_completion": ${desc.completion},
    "scores": { "continuation": ${metrics.scores.continuation}, "trend_health": ${metrics.scores.trend_health}, "pullback_quality": ${metrics.scores.pullback_quality}, "cleanliness": ${metrics.scores.cleanliness} },
    "structure_analysis": <2 sentences: describe 3H vs 6H spread relationship and what it reveals — no decimals, cite cycle counts>,
    "trend_assessment": <2 sentences: describe how ${base} and ${quote} strength behaved over 48H — no decimals>,
    "pullback_quality_text": <1-2 sentences: characterize compression depth and duration>,
    "momentum_shift": <1-2 sentences: describe compression velocity and acceleration — fading or building>,
    "flow_of_money": <2-3 sentences: explain where capital is flowing at the macro level — name which currencies are being bid vs sold — connect the macro regime to how it affects ${base} and ${quote} specifically — if macro is ALIGNED state why it supports the setup, if CONFLICTED explain the headwind>,
    "support_factors": [<up to 3 strings: each references 3H, 6H, or 12H behavior — no decimals>],
    "risk_factors": [<up to 3 strings: structural or macro risks — no decimals>]
  }
}`,
      },
    ],
  });

  const parsed = JSON.parse(response.choices[0].message.content.trim());

  // Enforce deterministic fields — AI cannot override these
  parsed.details.lifecycle_phase      = metrics.phase;
  parsed.details.lifecycle_completion = metrics.completion;
  parsed.details.scores               = metrics.scores;
  parsed.details.macro_alignment      = macroAlignment;

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
      structure_type:           top.structure_type  || null,
      trend_health:             th >= 70 ? 'STRONG' : th >= 45 ? 'MODERATE' : 'WEAK',
      continuation_probability: (sc.continuation || 0) / 100,
      market_quality:           top.market_quality  || null,
      warning:                  top.warning         || null,
      summary:                  top.summary         || null,
      details:                  details             || null,
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

  // Fetch risk sentiment ONCE — shared context for all pair analyses
  const sentimentRow = await getLatestSentiment();
  if (sentimentRow) {
    console.log(`[AI] Macro regime: ${sentimentRow.sentiment} [${sentimentRow.environment}] conf:${sentimentRow.confidence}% accel:${sentimentRow.accel_composite}`);
  } else {
    console.log('[AI] No risk sentiment data — analysis will proceed without macro context');
  }

  const PRIORITY = { READY_TO_ENTER: 4, PULLBACK_ACTIVE: 3, PULLBACK_STARTING: 2, TREND: 1 };

  console.log(`[AI] States: ${JSON.stringify(
    (states || []).reduce((a, s) => { a[s.state] = (a[s.state] || 0) + 1; return a; }, {})
  )}`);

  const targets = (states || [])
    .filter(s => PRIORITY[s.state] !== undefined && s.confidence >= 40)
    .sort((a, b) => {
      const pa = PRIORITY[a.state] || 0, pb = PRIORITY[b.state] || 0;
      return pa !== pb ? pb - pa : b.confidence - a.confidence;
    })
    .slice(0, 6);

  if (!targets.length) { console.log('[AI] No active setups'); return; }

  console.log(`[AI] Analyzing: ${targets.map(t => `${t.instrument}(${t.state}@${t.confidence}%)`).join(', ')}`);

  for (const state of targets) {
    try {
      const result = await analyzeSetup(state.instrument, state, sentimentRow);
      await saveAnalysis(state.instrument, latest.time, result);
      const sc = result.details?.scores || {};
      const ma = result.details?.macro_alignment || 'NEUTRAL';
      console.log(`[AI] ✓ ${state.instrument}: ${result.details?.lifecycle_phase} ${result.details?.lifecycle_completion}% macro:${ma} | cont=${sc.continuation} trend=${sc.trend_health} pbq=${sc.pullback_quality} clean=${sc.cleanliness}`);
    } catch (err) {
      console.error(`[AI] ✗ ${state.instrument}: ${err.message}`);
    }
  }
}

module.exports = { analyzeActiveSetups };
