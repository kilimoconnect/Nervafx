const OpenAI = require('openai');
const { supabase } = require('./supabase');
const { getCurrentSession, applySessionFilter } = require('./sessionEngine');

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

  const depthRatio     = Math.abs(s6) > 0.000001 ? Math.abs(s3) / Math.abs(s6) : 0;
  const recentAccel    = accel6h.slice(-8);
  const decelCycles    = recentAccel.filter(a => a * dir > 0.0000001).length;
  const isDecelerating = decelCycles >= 4;

  const s6StableCount  = delta6h.slice(-14).filter(d => d * dir >= -0.000005).length;
  const s12StableCount = delta12h.slice(-14).filter(d => d * dir >= -0.000005).length;

  const bEarly = baseArr.slice(-24, -12); const bLate = baseArr.slice(-12);
  const qEarly = quoteArr.slice(-24, -12); const qLate = quoteArr.slice(-12);
  const bAvgEarly = bEarly.reduce((a, b) => a + b, 0) / (bEarly.length || 1);
  const bAvgLate  = bLate.reduce((a, b) => a + b, 0)  / (bLate.length  || 1);
  const qAvgEarly = qEarly.reduce((a, b) => a + b, 0) / (qEarly.length || 1);
  const qAvgLate  = qLate.reduce((a, b) => a + b, 0)  / (qLate.length  || 1);

  const baseShift  = (bAvgLate - bAvgEarly) * dir;
  const quoteShift = (qAvgEarly - qAvgLate) * dir;

  // ── Lifecycle: duration is the PRIMARY driver ─────────────────────────────
  //   1–3 cycles  → EARLY_PULLBACK  (completion ≤33)
  //   4–8 cycles  → MID_PULLBACK    (completion 34–65)
  //   slowing     → LATE_PULLBACK   (completion >65)
  let phase, completion;
  if (state.state === 'READY_TO_ENTER') {
    phase = 'RE_EXPANDING';
    completion = Math.min(95, 20 + expansionCycles * 15);
  } else if (state.state === 'TREND') {
    phase = 'TRENDING';
    completion = 50;
  } else {
    const durationScore = Math.min(1, compressionCycles / 8) * 60; // caps at 8 cycles → 60pts
    const depthScore    = (depthRatio > 0.1 && depthRatio < 0.8) ? 15
                        : (depthRatio >= 0.8 ? 10 : 3);
    const decelScore    = (decelCycles / 8) * 25;
    const raw = durationScore + depthScore + decelScore;
    completion = Math.round(Math.min(95, Math.max(5, raw)));
    phase = completion <= 33 ? 'EARLY_PULLBACK'
          : completion <= 65 ? 'MID_PULLBACK'
          : 'LATE_PULLBACK';
  }

  // ── Trend Health: 12H stability now contributes — weakening 12H lowers score ─
  // Fix: previously s12StableCount was computed but never used in trend_health
  const trend_health = Math.round(Math.min(100,
    (s6  * dir > 0 ? 25 : 0) +               // 6H direction   max 25
    (s12 * dir > 0 ? 20 : 0) +               // 12H direction  max 20
    Math.min(Math.abs(s6) / 0.006, 1) * 20 + // 6H magnitude   max 20
    (s6StableCount  / 14) * 20 +              // 6H stability   max 20
    (s12StableCount / 14) * 15                // 12H stability  max 15 — key fix
  ));                                          // total max = 100

  // ── Pullback Quality: healthy, controlled pullbacks reach ≥70% ────────────
  // Fix: 1–3 cycle pullbacks were unfairly penalized even when clean
  const pullback_quality = Math.round(Math.min(100,
    // Depth: controlled range (0.1–0.75) is the sweet spot
    (depthRatio > 0.1 && depthRatio < 0.75 ? 35 : 15) +
    // Deceleration: primary quality signal — is counter-pressure fading?
    (isDecelerating ? 30 : (decelCycles >= 2 ? 14 : 8)) +
    // Duration: 1–3 cycles not penalized if other factors are clean
    (compressionCycles >= 4 && compressionCycles <= 12 ? 20
     : compressionCycles >= 1 && compressionCycles <= 3 ? 16
     : 5) +
    // 6H held direction during compression = clean pullback
    (s6StableCount / 14) * 15
  ));

  // ── Cleanliness (unchanged formula, new label) ────────────────────────────
  const deltaVar    = delta6h.slice(-12).reduce((sum, v) => sum + v * v, 0) / 12;
  const cleanliness = Math.round(Math.min(100, Math.max(20, 95 - deltaVar * 4000000)));
  const cleanlinessLabel = cleanliness >= 85 ? 'VERY CLEAN'
    : cleanliness >= 70 ? 'CLEAN'
    : cleanliness >= 50 ? 'MODERATE'
    : 'NOISY';

  // ── Counter Pressure: strength of current counter-trend force ─────────────
  // Duration + depth drive it up. Deceleration drives it down.
  // 1 cycle → LOW  |  5–7 cycles not decelerating → HIGH  |  8+ decelerating → MODERATE
  const rawCounter     = Math.min(compressionCycles / 10, 1) * 65 + depthRatio * 25;
  const decelReduction = isDecelerating ? Math.round((decelCycles / 8) * 20) : 0;
  const counterPressure = Math.round(Math.min(100, Math.max(0, rawCounter - decelReduction)));
  const counterPressureLabel = counterPressure >= 75 ? 'EXTREME'
    : counterPressure >= 50 ? 'HIGH'
    : counterPressure >= 25 ? 'MODERATE'
    : 'LOW';

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
    cleanlinessLabel,
    counterPressure, counterPressureLabel,
    scores: { continuation, trend_health, pullback_quality, cleanliness },
  };
}

// ─── Qualitative descriptions ─────────────────────────────────────────────────

function describeMetrics(m, state, base, quote) {
  const { dir, compressionCycles, expansionCycles, depthRatio,
          decelCycles, isDecelerating, s6StableCount, s12StableCount,
          baseShift, quoteShift, phase, completion,
          cleanlinessLabel, counterPressureLabel } = m;
  const bias    = state.bias;
  const biasDir = dir === 1 ? 'bullish' : 'bearish';

  const depthDesc = depthRatio < 0.20 ? 'very shallow — 3H barely compressed relative to 6H'
    : depthRatio < 0.40 ? 'light — 3H compressed to roughly a quarter of 6H magnitude'
    : depthRatio < 0.65 ? 'moderate — 3H around half of 6H magnitude, controlled depth'
    : depthRatio < 0.85 ? 'deep — 3H reaching towards 6H magnitude, stronger counter-pressure'
    : 'aggressive — 3H nearly matching 6H magnitude, heavy counter-trend force';

  const decelDesc = decelCycles >= 6 ? `strongly decelerating — counter-trend force fading in ${decelCycles} of last 8 cycles`
    : decelCycles >= 4 ? `decelerating — counter-trend pressure weakening over recent cycles`
    : decelCycles >= 2 ? `mixed signals — some deceleration emerging but not yet dominant`
    : `still building — counter-trend force has not shown clear deceleration`;

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
    EARLY_PULLBACK: `Early stage — 3H compression in first ${compressionCycles} H1 cycle${compressionCycles > 1 ? 's' : ''}, 6H trend structure intact`,
    MID_PULLBACK:   `Mid pullback — 3H has been compressing for ${compressionCycles} H1 cycles, 6H holding direction`,
    LATE_PULLBACK:  `Late pullback — ${compressionCycles} cycles of compression, deceleration signals emerging, structure approaching base formation`,
    RE_EXPANDING:   `Re-expansion active — 3H has turned ${biasDir} for ${expansionCycles} cycle${expansionCycles > 1 ? 's' : ''}, spread lifecycle resuming`,
    EXHAUSTING:     `Structural exhaustion — spread momentum failing to extend, lifecycle deteriorating`,
  }[phase] || '';

  const counterPressureDesc = {
    LOW:      'counter-trend force is minimal — setup developing freely',
    MODERATE: 'counter-trend force is present but manageable — continuation possible',
    HIGH:     'significant counter-trend force active — setup requires more time or deceleration',
    EXTREME:  'aggressive counter-trend force — lifecycle must show clear deceleration before continuation is viable',
  }[counterPressureLabel] || '';

  return {
    phaseDesc, depthDesc, decelDesc, s6Desc, s12Desc, baseDesc, quoteDesc,
    compressionCycles, expansionCycles, decelCycles, phase, completion,
    biasDir, cleanlinessLabel, counterPressureLabel, counterPressureDesc,
  };
}

// ─── Risk sentiment context ───────────────────────────────────────────────────

const REGIME_STRENGTH = {
  RISK_ON:  { AUD: 1, NZD: 1, GBP: 0.5, CAD: 0.5, EUR: 0, USD: -0.5, CHF: -0.5, JPY: -1 },
  RISK_OFF: { AUD: -1, NZD: -1, GBP: -0.5, CAD: -0.5, EUR: 0, USD: 0.5, CHF: 0.5, JPY: 1 },
};

const CURRENCY_ROLE = {
  USD: 'primary reserve and liquidity currency — bid during deleveraging and dollar shortages; weight softens when risk appetite returns',
  JPY: 'primary carry-trade funding and safe-haven currency — weight increases sharply when risk aversion rises; recedes as carry trade appetite returns',
  CHF: 'European safe-haven — weight increases during geopolitical stress and broad risk-off; recedes as fear subsides',
  AUD: 'high-yielding risk-sensitive commodity currency — weight supported by global growth and carry appetite; among the first to face pressure when risk aversion rises',
  NZD: 'high-yielding risk-sensitive currency closely tied to AUD — weight tracks global risk appetite and commodity cycles',
  GBP: 'semi-risk-sensitive reserve currency — weight broadly tracks global risk appetite',
  EUR: 'large reserve currency — moderately risk-sensitive; weight defensively positioned during acute global stress',
  CAD: 'oil-linked commodity currency — weight tied to energy demand and growth expectations',
};

function computeMacroAlignment(sentimentRow, state, base, quote) {
  if (!sentimentRow || sentimentRow.sentiment === 'NEUTRAL') return 'NEUTRAL';
  if ((sentimentRow.confidence || 0) < 35) return 'NEUTRAL';
  const regime = sentimentRow.sentiment;
  const exp    = REGIME_STRENGTH[regime] || {};
  const score  = (state.bias === 'BUY' ? 1 : -1) * ((exp[base] ?? 0) - (exp[quote] ?? 0));
  if (score >  0.5) return 'ALIGNED';
  if (score < -0.5) return 'CONFLICTED';
  return 'NEUTRAL';
}

function describeSentiment(s, base, quote) {
  if (!s) return null;

  const FLOW_SIGNALS = [
    { key: 'equity_score',  pos: 'global equities expanding — institutional risk appetite supported',
                             neg: 'global equities under pressure — institutional risk appetite deteriorating' },
    { key: 'gold_score',    pos: 'gold demand declining — capital not seeking safety',
                             neg: 'gold in demand — capital weight moving toward safety assets' },
    { key: 'jpy_score',     pos: 'JPY weight receding — carry trade appetite returning',
                             neg: 'JPY weight increasing — carry positions being unwound, safety flows active' },
    { key: 'chf_score',     pos: 'CHF weight receding — European/global fear subsiding',
                             neg: 'CHF weight increasing — defensive positioning in European safe haven' },
    { key: 'usd_score',     pos: 'USD weight softening — dollar liquidity not being hoarded',
                             neg: 'USD weight increasing — dollar liquidity demand rising, deleveraging pressure present' },
    { key: 'oil_score',     pos: 'oil aligned with equities — global demand signal intact',
                             neg: 'oil and equity flows diverging — growth or supply concern signal' },
    { key: 'audjpy_score',  pos: 'AUD/JPY carry spread recovering — risk appetite and carry flows returning',
                             neg: 'AUD/JPY carry spread declining — carry unwind, risk aversion broadening' },
    { key: 'nzdjpy_score',  pos: 'NZD/JPY carry spread positive — risk appetite broadly supported',
                             neg: 'NZD/JPY carry spread declining — NZD facing risk-off pressure' },
  ];

  const drivers = FLOW_SIGNALS
    .filter(d => Math.abs(s[d.key] || 0) > 18)
    .sort((a, b) => Math.abs(s[b.key] || 0) - Math.abs(s[a.key] || 0))
    .slice(0, 4)
    .map(d => (s[d.key] || 0) > 0 ? d.pos : d.neg);

  const accel = s.accel_composite || 0;
  const accelDesc =
    accel >  30 ? 'risk-on conditions building momentum — pace is accelerating'
  : accel >  10 ? 'risk-on conditions developing gradually'
  : accel < -30 ? 'risk-off conditions intensifying — pace of deterioration is accelerating'
  : accel < -10 ? 'risk-off conditions gradually building'
  :               'cross-asset conditions broadly stable — no sharp directional shift';

  const envDesc =
    s.environment === 'STRESS'   ? 'STRESS — multiple defensive assets moving simultaneously, conditions unstable'
  : s.environment === 'ELEVATED' ? 'ELEVATED — above-normal cross-asset activity, monitor for escalation'
  :                                 'CALM — orderly cross-asset conditions';

  return {
    sentiment:   s.sentiment,
    environment: s.environment,
    envDesc,
    confidence:  s.confidence,
    drivers:     drivers.length ? drivers : ['no dominant directional flow — conditions broadly balanced'],
    baseRole:    `${base}: ${CURRENCY_ROLE[base] || 'broadly tracked'}`,
    quoteRole:   `${quote}: ${CURRENCY_ROLE[quote] || 'broadly tracked'}`,
    accelDesc,
  };
}

// ─── Core analysis ────────────────────────────────────────────────────────────

async function analyzeSetup(instrument, state, sentimentRow) {
  const { base, quote, baseArr, quoteArr, spread3h, spread6h, spread12h }
    = await getHistory(instrument);

  const metrics        = computeMetrics(state, spread3h, spread6h, spread12h, baseArr, quoteArr);
  if (!metrics) throw new Error('Not enough data points');

  const desc           = describeMetrics(metrics, state, base, quote);
  const macroAlignment = computeMacroAlignment(sentimentRow, state, base, quote);
  const sd             = describeSentiment(sentimentRow, base, quote);

  const macroAlignmentDesc =
    macroAlignment === 'ALIGNED'    ? 'macro flow is consistent with this bias'
  : macroAlignment === 'CONFLICTED' ? 'macro flow is working against this bias'
  :                                    'macro flow is neutral for this pair';

  // ── Session context (deterministic) ────────────────────────────────────────
  const sessionObj    = getCurrentSession();
  const sessionFilter = applySessionFilter(instrument, state.confidence, sessionObj);
  const marketParticipation = sessionObj.activity_index >= 75 ? 'STRONG'
    : sessionObj.activity_index >= 45 ? 'MODERATE'
    : 'LOW';
  const continuationSupport = !sessionFilter.trade_blocked
    && ['VERY_HIGH', 'HIGH'].includes(sessionObj.quality)
    && (sessionFilter.session_delta ?? 0) >= 0;
  const sessionDeltaDesc = sessionFilter.trade_blocked
    ? 'session blocked — trades not permitted'
    : sessionFilter.session_delta > 0
      ? `+${sessionFilter.session_delta} pts — ${base}/${quote} is well-suited to this session`
      : sessionFilter.session_delta < 0
        ? `${sessionFilter.session_delta} pts — ${base}/${quote} is off-peak this session`
        : 'neutral — no pair-specific session edge';

  console.log(`[AI] ${instrument} → ${metrics.phase} ${metrics.completion}% cp:${metrics.counterPressureLabel} clean:${metrics.cleanlinessLabel} macro:${macroAlignment} session:${sessionObj.session}(${sessionObj.quality}) participation:${marketParticipation} | comp=${metrics.compressionCycles}cyc depth=${metrics.depthRatio.toFixed(2)} decel=${metrics.decelCycles}/8`);

  const client = getClient();

  const macroSection = sd ? `
MACRO / FLOW OF MONEY:
- Risk Regime: ${sd.sentiment} [${sd.environment}] | Confidence: ${sd.confidence}%
- Environment: ${sd.envDesc}
- Active flows: ${sd.drivers.join('; ')}
- Momentum: ${sd.accelDesc}
- ${sd.baseRole}
- ${sd.quoteRole}
- Macro alignment: ${macroAlignment} — ${macroAlignmentDesc}
` : '\nMACRO / FLOW OF MONEY: data not available\n';

  const sessionSection = `
SESSION / MARKET TIMING:
- Session: ${sessionObj.label} [${sessionObj.quality}] | Activity index: ${sessionObj.activity_index}%
- Market participation: ${marketParticipation}
- Pair session fit: ${sessionDeltaDesc}
- Environment: ${sessionObj.quality_desc}
- Continuation support: ${continuationSupport ? 'YES — session conditions support continuation trades' : 'REDUCED — session conditions are not optimal for continuation'}
`;

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

STRUCTURAL RULES:
1. NEVER include raw decimal numbers (e.g. 0.00136, -0.00043). Forbidden.
2. Cycle counts are allowed (e.g. "6 H1 cycles", "last 8 cycles").
3. Use engine vocabulary: 3H compression, 6H spread, 12H alignment, spread lifecycle, re-expansion, compression velocity, counter-trend force.
4. Lifecycle phase and counter_pressure are engine-determined and FIXED — text must align with them.
5. No trade recommendations. No entry/exit signals.

LANGUAGE RULES — most important:
6. NEVER use predictive language: "will", "leads to", "must", "should move", "expect to see", "typically results in". These imply future prediction. They are forbidden.
7. ALWAYS use environment language: "environment remains supportive for", "conditions are consistent with", "flow is currently weighted toward", "regime provides context for", "weight of capital appears toward".
8. STRICT SEPARATION — structure sections (structure_analysis, trend_assessment, pullback_quality_text, momentum_shift) must contain NO macro references. They describe price structure only.
9. STRICT SEPARATION — flow_of_money must contain NO cycle counts or spread values. It describes macro capital positioning only.
10. Write as if briefing a senior analyst — precise, direct, no filler phrases.
11. session_context describes ONLY market timing and participation — no price structure, no macro regime references, no predictions. Use: "participation environment is", "session conditions are consistent with", "timing environment supports".`,
      },
      {
        role: 'user',
        content: `Interpret the structure and macro context for ${instrument.replace('_', '/')}:

ENGINE STATE:
- Bias: ${state.bias} | Market State: ${state.state} | Confidence: ${state.confidence}%
- Lifecycle: ${desc.phase} — ${desc.phaseDesc}
- Phase completion: ${desc.completion}% (engine-determined)
- Counter Pressure: ${desc.counterPressureLabel} — ${desc.counterPressureDesc}
- Market Cleanliness: ${desc.cleanlinessLabel} (${metrics.scores.cleanliness}%)

STRUCTURAL FACTS:
- 3H compression: ${desc.compressionCycles} consecutive H1 cycle${desc.compressionCycles !== 1 ? 's' : ''} | Depth: ${desc.depthDesc}
- Compression velocity (6H acceleration): ${desc.decelDesc}
- 6H spread: ${desc.s6Desc}
- 12H spread: ${desc.s12Desc}
- ${desc.baseDesc}
- ${desc.quoteDesc}

SCORES (engine-computed, use as-is):
{ "continuation": ${metrics.scores.continuation}, "trend_health": ${metrics.scores.trend_health}, "pullback_quality": ${metrics.scores.pullback_quality}, "cleanliness": ${metrics.scores.cleanliness} }
${macroSection}${sessionSection}
Return this exact JSON. All text: no raw decimals, use cycle counts, engine terminology, environment language only:
{
  "structure_type": "HEALTHY_PULLBACK"|"WEAK_PULLBACK"|"STRONG_TREND"|"REVERSAL_RISK"|"CHOPPY"|"EXHAUSTED",
  "market_quality": "CLEAN"|"NOISY"|"CHOPPY",
  "warning": <null or one short observation — no decimals, no predictions>,
  "summary": <one sentence: name 3H/6H behavior, cycle count, and whether macro flow is supportive or neutral — no decimals, no predictions>,
  "details": {
    "lifecycle_phase": "${desc.phase}",
    "lifecycle_completion": ${desc.completion},
    "counter_pressure": "${desc.counterPressureLabel}",
    "scores": { "continuation": ${metrics.scores.continuation}, "trend_health": ${metrics.scores.trend_health}, "pullback_quality": ${metrics.scores.pullback_quality}, "cleanliness": ${metrics.scores.cleanliness} },
    "structure_analysis": <2 sentences: pure price structure — describe 3H vs 6H spread relationship, cite cycle counts — NO macro references>,
    "trend_assessment": <2 sentences: how ${base} and ${quote} strength behaved over 48H — pure structure, NO macro references>,
    "pullback_quality_text": <1-2 sentences: characterize compression depth and duration — NO macro references>,
    "momentum_shift": <1-2 sentences: describe compression velocity — fading or building — NO macro references>,
    "flow_of_money": <2-3 sentences: describe where capital weight is currently positioned at the macro level — name which currencies carry the weight and which face pressure — connect the current regime to how it relates to ${base} and ${quote} positioning — NO cycle counts, NO spread values, NO predictions — use: "flow remains supportive for", "conditions are consistent with", "weight of capital appears toward">,
    "session_context": <1 sentence: describe how current session conditions relate to this pair — timing and participation environment only — no structure references, no predictions>,
    "support_factors": [<up to 3 strings: structural spread facts only — no decimals>],
    "risk_factors": [<up to 3 strings: structural or macro positioning risks — no decimals, no predictions>]
  }
}`,
      },
    ],
  });

  const parsed = JSON.parse(response.choices[0].message.content.trim());

  // Enforce all deterministic fields — AI must not override these
  parsed.details.lifecycle_phase        = metrics.phase;
  parsed.details.lifecycle_completion   = metrics.completion;
  parsed.details.scores                 = metrics.scores;
  parsed.details.counter_pressure       = metrics.counterPressureLabel;
  parsed.details.cleanliness_label      = metrics.cleanlinessLabel;
  parsed.details.macro_alignment        = macroAlignment;
  parsed.details.session                = sessionObj.session;
  parsed.details.session_label          = sessionObj.label;
  parsed.details.session_quality        = sessionObj.quality;
  parsed.details.market_participation   = marketParticipation;
  parsed.details.continuation_support   = continuationSupport;

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

  const sentimentRow = await getLatestSentiment();
  if (sentimentRow) {
    console.log(`[AI] Macro: ${sentimentRow.sentiment} [${sentimentRow.environment}] conf:${sentimentRow.confidence}%`);
  }

  const PRIORITY = {
    READY_TO_ENTER:    5,
    PULLBACK_ACTIVE:   4,
    BASE_FORMING:      3,
    PULLBACK_STARTING: 2,
    REVERSAL_CONFIRMED: 2,
    TREND:             1,
  };

  console.log(`[AI] States: ${JSON.stringify(
    (states || []).reduce((a, s) => { a[s.state] = (a[s.state] || 0) + 1; return a; }, {})
  )}`);

  const targets = (states || [])
    .filter(s => PRIORITY[s.state] !== undefined && s.confidence >= 40)
    .sort((a, b) => {
      const pa = PRIORITY[a.state] || 0, pb = PRIORITY[b.state] || 0;
      return pa !== pb ? pb - pa : b.confidence - a.confidence;
    })
    .slice(0, 10);

  if (!targets.length) { console.log('[AI] No active setups'); return; }

  console.log(`[AI] Analyzing: ${targets.map(t => `${t.instrument}(${t.state}@${t.confidence}%)`).join(', ')}`);

  for (const state of targets) {
    try {
      const result = await analyzeSetup(state.instrument, state, sentimentRow);
      await saveAnalysis(state.instrument, latest.time, result);
      const sc = result.details?.scores || {};
      const ma = result.details?.macro_alignment || 'NEUTRAL';
      const cp = result.details?.counter_pressure || '—';
      console.log(`[AI] ✓ ${state.instrument}: ${result.details?.lifecycle_phase} ${result.details?.lifecycle_completion}% cp:${cp} macro:${ma} | cont=${sc.continuation} trend=${sc.trend_health} pbq=${sc.pullback_quality} clean=${sc.cleanliness}`);
    } catch (err) {
      console.error(`[AI] ✗ ${state.instrument}: ${err.message}`);
    }
  }
}

module.exports = { analyzeActiveSetups };
