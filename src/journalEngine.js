'use strict';

/**
 * Hourly Market Journal — Phase 11
 *
 * Runs at the end of each hourly update cycle.
 * Captures a full snapshot of what the system saw, what it decided, and why.
 * This record becomes the foundation for future performance review and rule improvement.
 *
 * Table: hourly_market_journal  (unique on time, floored to the hour)
 *
 * Outcome columns (outcome_6h, outcome_12h, outcome_24h) are written later
 * by a separate review pass — not here.
 */

const { supabase } = require('./supabase');
const { getCurrentSession } = require('./sessionEngine');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function floorHour(date = new Date()) {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d;
}

function pairLabel(instrument) {
  return (instrument || '').replace('_', '/');
}

// ─── Data collectors ──────────────────────────────────────────────────────────

async function collectSentiment() {
  const { data } = await supabase
    .from('risk_sentiment')
    .select('*')
    .order('time', { ascending: false })
    .limit(1);
  return data?.[0] || null;
}

async function collectStates() {
  // Get the latest batch timestamp, then pull all 28 pairs for that moment
  const { data: latest } = await supabase
    .from('market_states')
    .select('time')
    .order('time', { ascending: false })
    .limit(1)
    .single();

  if (!latest) return [];

  const { data: rows } = await supabase
    .from('market_states')
    .select('instrument, state, bias, confidence, spread_3h, spread_6h, spread_12h, reason')
    .eq('time', latest.time);

  return rows || [];
}

async function collectStrength() {
  // Get the latest strength snapshot — one row per currency at the latest time
  const { data: latest } = await supabase
    .from('currency_strength')
    .select('time')
    .order('time', { ascending: false })
    .limit(1)
    .single();

  if (!latest) return [];

  const { data: rows } = await supabase
    .from('currency_strength')
    .select('currency, smooth_3h, smooth_6h, smooth_12h, normalized_3h, normalized_6h, normalized_12h, momentum, accel_label')
    .eq('time', latest.time);

  return rows || [];
}

async function collectPairRankings() {
  const { data: latest } = await supabase
    .from('pair_strength_spreads')
    .select('time')
    .order('time', { ascending: false })
    .limit(1)
    .single();

  if (!latest) return [];

  const { data: rows } = await supabase
    .from('pair_strength_spreads')
    .select('instrument, spread_3h, spread_6h, spread_12h, weighted_score, bias')
    .eq('time', latest.time)
    .order('weighted_score', { ascending: false });

  return rows || [];
}

async function collectSignals() {
  // Signals written in the last 90 minutes (captures this cycle's output)
  const since = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const { data: rows } = await supabase
    .from('trade_signals')
    .select('instrument, signal, direction, confidence, reason, time')
    .gte('time', since)
    .order('time', { ascending: false });

  const all = rows || [];
  return {
    entered:   all.filter(s => s.signal === 'BUY' || s.signal === 'SELL'),
    waiting:   all.filter(s => s.signal === 'WAIT'),
    no_trade:  all.filter(s => s.signal === 'NO_TRADE'),
  };
}

async function collectAiAnalysis() {
  // Latest AI row per instrument — AI runs after state detection, so latest batch
  const { data: latest } = await supabase
    .from('ai_analysis')
    .select('time')
    .order('time', { ascending: false })
    .limit(1)
    .single();

  if (!latest) return [];

  const { data: rows } = await supabase
    .from('ai_analysis')
    .select('instrument, structure_type, trend_health, market_quality, summary, warning, details, time')
    .gte('time', new Date(new Date(latest.time).getTime() - 60 * 60 * 1000).toISOString());

  // Deduplicate — keep most recent per instrument
  const map = {};
  for (const r of (rows || [])) {
    if (!map[r.instrument] || r.time > map[r.instrument].time) map[r.instrument] = r;
  }

  return Object.values(map).map(r => ({
    instrument:           r.instrument,
    structure_type:       r.structure_type,
    trend_health:         r.trend_health,
    market_quality:       r.market_quality,
    summary:              r.summary,
    warning:              r.warning || null,
    lifecycle_phase:      r.details?.lifecycle_phase || null,
    lifecycle_completion: r.details?.lifecycle_completion || null,
    scores:               r.details?.scores || null,
    counter_pressure:     r.details?.counter_pressure || null,
    cleanliness_label:    r.details?.cleanliness_label || null,
    session_context:      r.details?.session_context || null,
  }));
}

// ─── Summary builder ──────────────────────────────────────────────────────────

function buildSummary({ session, sentiment, states, signals, aiAnalysis, topSetups }) {
  const lines = [];

  // 1. Session
  const sessionStr = session.trades_allowed
    ? `${session.label} (${session.quality.replace('_', ' ')} quality)`
    : `${session.label} — trading blocked (${session.block_reason || 'dead hours'})`;
  lines.push(`H1 analysis completed. Session: ${sessionStr}.`);

  // 2. Sentiment
  if (sentiment) {
    const sent = sentiment.sentiment === 'RISK_ON'  ? 'risk-on'
               : sentiment.sentiment === 'RISK_OFF' ? 'risk-off'
               : 'neutral';
    lines.push(
      `Risk sentiment: ${sent} (${(sentiment.environment || 'CALM').toLowerCase()}, ` +
      `confidence ${sentiment.confidence}%, net ${sentiment.net_score}).`
    );
  } else {
    lines.push('Risk sentiment: unavailable.');
  }

  // 3. Market overview
  const trend_pairs    = states.filter(s => s.state === 'TREND').length;
  const pullback_pairs = states.filter(s => ['PULLBACK_STARTING', 'PULLBACK_ACTIVE'].includes(s.state)).length;
  const ready_pairs    = states.filter(s => s.state === 'READY_TO_ENTER').length;
  const no_trade_pairs = states.filter(s => s.state === 'NO_TRADE').length;
  lines.push(
    `Market scan across 28 pairs: ${trend_pairs} trend, ${pullback_pairs} pullback, ` +
    `${ready_pairs} ready-to-enter, ${no_trade_pairs} no-trade.`
  );

  // 4. Top setups
  if (topSetups.length > 0) {
    const setStr = topSetups.map(s =>
      `${pairLabel(s.instrument)} ${s.bias} ${s.confidence}% [${s.state}]`
    ).join(', ');
    lines.push(`Top setups: ${setStr}.`);
  } else {
    lines.push('No active setups identified this cycle.');
  }

  // 5. Signals
  if (signals.entered.length > 0) {
    const sigStr = signals.entered.map(s => `${pairLabel(s.instrument)} ${s.signal}`).join(', ');
    lines.push(`Entry signals generated: ${sigStr}.`);
  } else if (signals.waiting.length > 0) {
    lines.push(`No entry signals. ${signals.waiting.length} pairs in waiting state.`);
  } else {
    lines.push('No signals generated this cycle.');
  }

  // 6. AI highlights — warnings and notable structure
  const notable = aiAnalysis.filter(a => a.warning || a.structure_type === 'RE-EXPANDING');
  if (notable.length > 0) {
    const aiStr = notable.map(a => {
      const parts = [`${pairLabel(a.instrument)}: ${a.structure_type}`];
      if (a.warning) parts.push(`⚠ ${a.warning}`);
      return parts.join(' — ');
    }).join('; ');
    lines.push(`AI flags: ${aiStr}.`);
  }

  // 7. No-trade reason summary
  if (!session.trades_allowed) {
    lines.push('No trades approved — outside active session hours.');
  } else if (sentiment?.sentiment === 'NEUTRAL') {
    lines.push('No trades approved — risk sentiment neutral, no clear money flow direction.');
  } else if (ready_pairs === 0) {
    lines.push('No trades approved — no pairs reached READY_TO_ENTER state.');
  }

  return lines.join(' ');
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function writeJournalEntry() {
  const now     = new Date();
  const hourTs  = floorHour(now);
  const session = getCurrentSession(now);

  // Collect everything in parallel
  const [sentiment, states, currencyStrength, pairRankings, signals, aiAnalysis] = await Promise.all([
    collectSentiment(),
    collectStates(),
    collectStrength(),
    collectPairRankings(),
    collectSignals(),
    collectAiAnalysis(),
  ]);

  // State counts
  const trend_pairs    = states.filter(s => s.state === 'TREND').length;
  const pullback_pairs = states.filter(s => ['PULLBACK_STARTING', 'PULLBACK_ACTIVE'].includes(s.state)).length;
  const ready_pairs    = states.filter(s => s.state === 'READY_TO_ENTER').length;
  const no_trade_pairs = states.filter(s => s.state === 'NO_TRADE').length;

  // Top 5 setups by confidence
  const topSetups = [...states]
    .filter(s => s.state !== 'NO_TRADE' && s.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)
    .map(s => ({
      instrument:      s.instrument,
      state:           s.state,
      bias:            s.bias,
      confidence:      s.confidence,
      spread_behavior: s.spread_behavior || null,
      reason:          s.reason || null,
    }));

  // Compact sentiment details for storage
  const risk_sentiment_details = sentiment ? {
    net_score:       sentiment.net_score,
    confidence:      sentiment.confidence,
    environment:     sentiment.environment,
    accel_composite: sentiment.accel_composite,
    equity_score:    sentiment.equity_score,
    jpy_score:       sentiment.jpy_score,
    chf_score:       sentiment.chf_score,
    gold_score:      sentiment.gold_score,
    oil_score:       sentiment.oil_score,
    usd_score:       sentiment.usd_score,
    audjpy_score:    sentiment.audjpy_score,
    nzdjpy_score:    sentiment.nzdjpy_score,
  } : null;

  // Compact currency strength (all three TFs so dashboard modal can render 3H/6H/12H bars).
  // Store smooth_* as primary and normalized_* as fallback — normalized is always available
  // immediately after strength calculation even if the smooth step hasn't run yet.
  const currency_strength = currencyStrength.map(r => ({
    currency:      r.currency,
    smooth_3h:     r.smooth_3h,
    smooth_6h:     r.smooth_6h,
    smooth_12h:    r.smooth_12h,
    normalized_3h:  r.normalized_3h,
    normalized_6h:  r.normalized_6h,
    normalized_12h: r.normalized_12h,
    momentum:      r.momentum,
    accel_label:   r.accel_label,
  }));

  // Signals summary for storage
  const signals_summary = {
    entered:   signals.entered.map(s => ({ instrument: s.instrument, signal: s.signal, confidence: s.confidence, reason: s.reason })),
    waiting:   signals.waiting.map(s => ({ instrument: s.instrument, confidence: s.confidence })),
    no_trade:  signals.no_trade.map(s => ({ instrument: s.instrument })),
  };

  // Build narrative summary
  const summary = buildSummary({ session, sentiment, states, signals, aiAnalysis, topSetups });

  // Compose journal row
  const row = {
    time:                    hourTs.toISOString(),
    session_name:            session.session,
    session_quality:         session.quality,
    risk_sentiment:          sentiment?.sentiment  || 'UNKNOWN',
    risk_confidence:         sentiment?.confidence || 0,
    total_pairs_scanned:     28,
    trend_pairs,
    pullback_pairs,
    ready_pairs,
    no_trade_pairs,
    top_setups:              topSetups,
    market_states:           states,
    currency_strength,
    risk_sentiment_details,
    ai_analysis:             aiAnalysis,
    signals_summary,
    pair_rankings:           pairRankings.slice(0, 28),
    summary,
  };

  const { error } = await supabase
    .from('hourly_market_journal')
    .upsert(row, { onConflict: 'time', ignoreDuplicates: false });

  if (error) throw new Error(`Journal write failed: ${error.message}`);

  console.log(`[JOURNAL] ✓ ${hourTs.toISOString()}`);
  console.log(`[JOURNAL] ${summary}`);
  return row;
}

module.exports = { writeJournalEntry };
