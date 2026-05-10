'use strict';

/**
 * Outcome Review — Phase 11b
 *
 * Runs after each hourly update. Looks back at journal entries from
 * exactly 6h, 12h, and 24h ago and fills in what actually happened:
 *
 *   1. For each top setup recorded at that time, fetch subsequent spread data
 *   2. Measure how far price moved in the bias direction
 *   3. Determine whether the call was correct
 *   4. Call AI to write a concise verdict on the cycle
 *   5. Patch outcome_6h / outcome_12h / outcome_24h on the journal row
 *
 * The outcome columns become the ground truth for future rule improvement.
 */

const OpenAI = require('openai');
const { supabase } = require('./supabase');

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ─── Config ───────────────────────────────────────────────────────────────────

const REVIEW_WINDOWS = [
  { hours: 6,  column: 'outcome_6h'  },
  { hours: 12, column: 'outcome_12h' },
  { hours: 24, column: 'outcome_24h' },
];

// A setup is "correct" if the spread moved at least this far in bias direction
const MIN_CONTINUATION_THRESHOLD = 0.0005; // 5 pips in spread units

// ─── Spread movement measurement ─────────────────────────────────────────────

/**
 * Fetches spread rows for an instrument between two timestamps.
 * Returns the net change in spread_6h from start to end.
 */
async function measureSpreadOutcome(instrument, fromTime, toTime) {
  const { data: rows, error } = await supabase
    .from('pair_strength_spreads')
    .select('time, spread_6h, spread_12h')
    .eq('instrument', instrument)
    .gte('time', fromTime)
    .lte('time', toTime)
    .order('time', { ascending: true });

  if (error || !rows || rows.length < 2) return null;

  const first = rows[0];
  const last  = rows[rows.length - 1];

  const spread6h_start  = parseFloat(first.spread_6h  || 0);
  const spread6h_end    = parseFloat(last.spread_6h   || 0);
  const spread12h_start = parseFloat(first.spread_12h || 0);
  const spread12h_end   = parseFloat(last.spread_12h  || 0);

  const delta6h  = spread6h_end  - spread6h_start;
  const delta12h = spread12h_end - spread12h_start;

  return {
    spread6h_start:  +spread6h_start.toFixed(6),
    spread6h_end:    +spread6h_end.toFixed(6),
    spread12h_start: +spread12h_start.toFixed(6),
    spread12h_end:   +spread12h_end.toFixed(6),
    delta6h:  +delta6h.toFixed(6),
    delta12h: +delta12h.toFixed(6),
    candles:  rows.length,
  };
}

/**
 * Evaluates whether a setup's outcome was correct.
 * bias: 'BUY' | 'SELL'
 * Returns: 'CORRECT' | 'INCORRECT' | 'FLAT' | 'INSUFFICIENT_DATA'
 */
function classifyOutcome(bias, spreadDelta) {
  if (!spreadDelta) return 'INSUFFICIENT_DATA';

  const delta = spreadDelta.delta6h;
  if (Math.abs(delta) < MIN_CONTINUATION_THRESHOLD) return 'FLAT';

  const biasDirPositive = bias === 'BUY';
  const movedInBiasDir  = biasDirPositive ? delta > 0 : delta < 0;

  return movedInBiasDir ? 'CORRECT' : 'INCORRECT';
}

// ─── AI verdict ───────────────────────────────────────────────────────────────

async function generateAiVerdict(journalEntry, setupOutcomes, windowHours) {
  const client = getClient();

  // Build the setup performance summary for the prompt
  const setupLines = setupOutcomes.map(so => {
    const { instrument, bias, confidence, state, outcome, spreadDelta } = so;
    const pair = instrument.replace('_', '/');
    const d6   = spreadDelta ? spreadDelta.delta6h : null;
    const dir  = d6 != null ? (d6 > 0 ? 'positive' : d6 < 0 ? 'negative' : 'flat') : 'unknown';
    const mag  = d6 != null ? Math.abs(d6).toFixed(6) : 'unknown';

    return `  ${pair} [${bias} @ ${confidence}% | ${state}]: spread moved ${dir} by ${mag} → ${outcome}`;
  }).join('\n');

  const correctCount   = setupOutcomes.filter(s => s.outcome === 'CORRECT').length;
  const incorrectCount = setupOutcomes.filter(s => s.outcome === 'INCORRECT').length;
  const flatCount      = setupOutcomes.filter(s => s.outcome === 'FLAT').length;
  const totalSetups    = setupOutcomes.length;

  const sentimentCorrect = evaluateSentimentCorrectness(journalEntry, setupOutcomes);

  const prompt = `You are reviewing the performance of an automated forex strength-based trading system.

JOURNAL ENTRY (${windowHours} hours ago):
- Session: ${journalEntry.session_name} [${journalEntry.session_quality}]
- Risk Sentiment: ${journalEntry.risk_sentiment} (confidence: ${journalEntry.risk_confidence}%)
- Market scan: ${journalEntry.trend_pairs} trend, ${journalEntry.pullback_pairs} pullback, ${journalEntry.ready_pairs} ready-to-enter, ${journalEntry.no_trade_pairs} no-trade
- Summary at the time: "${journalEntry.summary}"

SETUP PERFORMANCE (${windowHours}H outcome):
${setupLines || '  No active setups were recorded this cycle.'}

SCORECARD: ${correctCount} correct, ${incorrectCount} incorrect, ${flatCount} flat out of ${totalSetups} setups.

Write a concise performance review covering:
1. Which calls were right and why they likely worked (or didn't)
2. Whether sentiment (${journalEntry.risk_sentiment}) correctly filtered or incorrectly blocked trades
3. One specific pattern or rule the system should note for future reference
4. An accuracy score from 0–100 for this cycle

Rules:
- Be direct and specific. No filler phrases.
- Do not use raw decimals. Describe direction and magnitude in qualitative terms (e.g. "strong continuation", "small adverse move", "flat — no follow-through").
- Maximum 5 sentences for the verdict.

Return JSON:
{
  "verdict": "<5 sentences max>",
  "accuracy_score": <0-100>,
  "sentiment_assessment": "<1 sentence: was the sentiment call correct and did it help or hurt?>"
}`;

  try {
    const response = await client.chat.completions.create({
      model:           'gpt-4o-mini',
      max_tokens:      500,
      temperature:     0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'user', content: prompt },
      ],
    });

    return JSON.parse(response.choices[0].message.content.trim());
  } catch (err) {
    console.error(`[OUTCOME] AI verdict failed: ${err.message}`);
    return {
      verdict:              'AI verdict unavailable.',
      accuracy_score:       null,
      sentiment_assessment: null,
    };
  }
}

function evaluateSentimentCorrectness(journalEntry, setupOutcomes) {
  if (!setupOutcomes.length) return null;
  const correctCount = setupOutcomes.filter(s => s.outcome === 'CORRECT').length;
  const rate = correctCount / setupOutcomes.length;

  if (journalEntry.risk_sentiment === 'NEUTRAL') {
    // Neutral was correct if setups mostly failed or stayed flat
    return rate <= 0.4;
  }
  if (journalEntry.risk_sentiment === 'RISK_ON' || journalEntry.risk_sentiment === 'RISK_OFF') {
    // Directional call was correct if setups mostly worked
    return rate >= 0.6;
  }
  return null;
}

// ─── Review one window ────────────────────────────────────────────────────────

async function reviewWindow(hours, column) {
  // Find journal entries from exactly {hours} hours ago that haven't been reviewed yet
  const targetTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  // Look within a ±35 minute window around the target hour
  const windowStart = new Date(targetTime.getTime() - 35 * 60 * 1000).toISOString();
  const windowEnd   = new Date(targetTime.getTime() + 35 * 60 * 1000).toISOString();

  const { data: entries, error } = await supabase
    .from('hourly_market_journal')
    .select('id, time, session_name, session_quality, risk_sentiment, risk_confidence, risk_sentiment_details, trend_pairs, pullback_pairs, ready_pairs, no_trade_pairs, top_setups, summary')
    .gte('time', windowStart)
    .lte('time', windowEnd)
    .is(column, null); // only entries not yet reviewed for this window

  if (error) {
    console.error(`[OUTCOME-${hours}H] Query error: ${error.message}`);
    return;
  }

  if (!entries?.length) {
    console.log(`[OUTCOME-${hours}H] No pending entries.`);
    return;
  }

  for (const entry of entries) {
    console.log(`[OUTCOME-${hours}H] Reviewing entry from ${entry.time}`);

    const fromTime = entry.time;
    const toTime   = new Date().toISOString();

    // Measure outcome for each top setup
    const setups = entry.top_setups || [];
    const setupOutcomes = [];

    for (const setup of setups) {
      const spreadDelta = await measureSpreadOutcome(setup.instrument, fromTime, toTime);
      const outcome     = classifyOutcome(setup.bias, spreadDelta);

      setupOutcomes.push({
        instrument:  setup.instrument,
        bias:        setup.bias,
        confidence:  setup.confidence,
        state:       setup.state,
        outcome,
        spreadDelta,
      });
    }

    // AI verdict on this cycle
    const aiVerdict = await generateAiVerdict(entry, setupOutcomes, hours);

    // Compose the outcome object
    const outcomeData = {
      reviewed_at:          new Date().toISOString(),
      window_hours:         hours,
      setups:               setupOutcomes.map(so => ({
        instrument:   so.instrument,
        bias:         so.bias,
        confidence:   so.confidence,
        state:        so.state,
        outcome:      so.outcome,
        delta6h:      so.spreadDelta?.delta6h ?? null,
        delta12h:     so.spreadDelta?.delta12h ?? null,
        candles_seen: so.spreadDelta?.candles ?? 0,
      })),
      correct_count:        setupOutcomes.filter(s => s.outcome === 'CORRECT').length,
      incorrect_count:      setupOutcomes.filter(s => s.outcome === 'INCORRECT').length,
      flat_count:           setupOutcomes.filter(s => s.outcome === 'FLAT').length,
      total_setups:         setupOutcomes.length,
      accuracy_score:       aiVerdict.accuracy_score,
      sentiment_correct:    evaluateSentimentCorrectness(entry, setupOutcomes),
      verdict:              aiVerdict.verdict,
      sentiment_assessment: aiVerdict.sentiment_assessment,
    };

    // Patch the journal row
    const { error: patchErr } = await supabase
      .from('hourly_market_journal')
      .update({ [column]: outcomeData })
      .eq('id', entry.id);

    if (patchErr) {
      console.error(`[OUTCOME-${hours}H] Patch failed for ${entry.id}: ${patchErr.message}`);
    } else {
      console.log(`[OUTCOME-${hours}H] ✓ ${entry.time} — ${outcomeData.correct_count}/${outcomeData.total_setups} correct. Score: ${outcomeData.accuracy_score}`);
      console.log(`[OUTCOME-${hours}H] Verdict: ${outcomeData.verdict}`);
    }
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function runOutcomeReviews() {
  for (const { hours, column } of REVIEW_WINDOWS) {
    try {
      await reviewWindow(hours, column);
    } catch (err) {
      console.error(`[OUTCOME-${hours}H] Unexpected error: ${err.message}`);
    }
  }
}

module.exports = { runOutcomeReviews };
