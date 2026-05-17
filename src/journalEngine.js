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
const { getMarketEnergyData } = require('./sessionActivity');

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

  if (!latest) return { as_of: null, pairs: [] };

  const { data: rows } = await supabase
    .from('market_states')
    .select('instrument, state, bias, confidence, spread_3h, spread_6h, spread_12h, reason')
    .eq('time', latest.time);

  return { as_of: latest.time, pairs: rows || [] };
}

async function collectStrength() {
  // Get the latest strength snapshot — one row per currency at the latest time
  const { data: latest, error: latestErr } = await supabase
    .from('currency_strength')
    .select('time')
    .order('time', { ascending: false })
    .limit(1)
    .single();

  if (latestErr) { console.warn('[JOURNAL] collectStrength latest time:', latestErr.message); return { as_of: null, currencies: [] }; }
  if (!latest) return { as_of: null, currencies: [] };

  const { data: rows, error: rowsErr } = await supabase
    .from('currency_strength')
    .select('currency, smooth_3h, smooth_6h, smooth_12h, normalized_3h, normalized_6h, normalized_12h')
    .eq('time', latest.time);

  if (rowsErr) { console.warn('[JOURNAL] collectStrength rows:', rowsErr.message); return { as_of: null, currencies: [] }; }
  return { as_of: latest.time, currencies: rows || [] };
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

// Returns the tracked_pullback_pairs array from the most recent journal entry.
// Shape per element: { instrument, bias, entered_at, latest_state, latest_conf }
async function collectTrackedPullbacks() {
  const { data } = await supabase
    .from('hourly_market_journal')
    .select('tracked_pullback_pairs')
    .order('time', { ascending: false })
    .limit(1)
    .single();
  return data?.tracked_pullback_pairs || [];
}

async function collectM15Impulses() {
  // Matches getM15AllActive() on the dashboard: all non-FLAT states, |smooth_45m| >= threshold.
  // The notification bar uses a stricter filter (EXPANDING + TF-aligned) separately.
  const CS_THRESHOLD = 0.00100;

  // Use latest timestamp that has non-FLAT rows — avoids the top-of-hour window
  // where the M15 pipeline may have just written fresh FLAT candles for all pairs.
  const { data: latest } = await supabase
    .from('m15_pair_spreads')
    .select('time')
    .neq('state', 'FLAT')
    .order('time', { ascending: false })
    .limit(1)
    .single();

  if (!latest) return [];

  const { data: rows } = await supabase
    .from('m15_pair_spreads')
    .select('instrument, smooth_45m, smooth_90m, smooth_180m, state')
    .eq('time', latest.time)
    .neq('state', 'FLAT');

  return (rows || [])
    .filter(r => Math.abs(parseFloat(r.smooth_45m) || 0) >= CS_THRESHOLD)
    .sort((a, b) => Math.abs(parseFloat(b.smooth_45m)) - Math.abs(parseFloat(a.smooth_45m)))
    .map(r => ({
      instrument:  r.instrument,
      bias:        parseFloat(r.smooth_45m) >= 0 ? 'BUY' : 'SELL',
      state:       r.state,
      smooth_45m:  parseFloat(r.smooth_45m),
      smooth_90m:  parseFloat(r.smooth_90m),
      smooth_180m: parseFloat(r.smooth_180m),
    }));
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

function buildSummary({ session, sentiment, states, signals, aiAnalysis, topSetups, m15Impulses, trackedPullbacks, newPullbackCount, marketEnergy }) {
  const lines = [];

  // 1. Market Energy Analysis (primary)
  if (marketEnergy?.sessions?.length) {
    const SESS_LABEL = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York' };
    const sessLines = marketEnergy.sessions
      .filter(s => s.session_name !== 'LOW_LIQUIDITY')
      .map(s => {
        const name = SESS_LABEL[s.session_name] || s.session_name;
        const cycle = (s.energy_cycle || '').replace(/_/g, ' ');
        const eng   = Math.round(s.market_energy || 0);
        const brd   = Math.round(s.breadth_score || 0);
        const liq   = Math.round(s.liquidity_score || 0);
        const bull  = Math.round(s.bullish_breadth || 0);
        const bear  = Math.round(s.bearish_breadth || 0);
        const strong = s.strongest_ccy || '—';
        const weak   = s.weakest_ccy || '—';
        return `${name}: ${cycle} E:${eng} Mom:${brd} Liq:${liq} ▲${bull}%/▼${bear}% ${strong}↑ ${weak}↓`;
      });
    lines.push(sessLines.join(' | '));

    if (marketEnergy.marketCycle) {
      lines.push(`Market cycle: ${marketEnergy.marketCycle.replace(/_/g, ' ')}.`);
    }
  } else {
    lines.push(`${session.label}: No market energy data available.`);
  }

  // 2. Top setups (if any)
  if (topSetups.length > 0) {
    const setStr = topSetups.slice(0, 3).map(s =>
      `${pairLabel(s.instrument)} ${s.bias} ${s.confidence}%`
    ).join(', ');
    lines.push(`Top setups: ${setStr}.`);
  }

  // 3. Signals
  if (signals.entered.length > 0) {
    const sigStr = signals.entered.map(s => `${pairLabel(s.instrument)} ${s.signal}`).join(', ');
    lines.push(`Entries: ${sigStr}.`);
  }

  // 4. M15 impulse moves
  if (m15Impulses && m15Impulses.length > 0) {
    const m15Str = m15Impulses.map(r => `${pairLabel(r.instrument)} ${r.bias}`).join(', ');
    lines.push(`M15 impulses: ${m15Str}.`);
  }

  return lines.join(' ');
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function writeJournalEntry() {
  const now     = new Date();
  const hourTs  = floorHour(now);
  const session = getCurrentSession(now);

  // Collect everything in parallel
  const [sentiment, statesResult, strengthResult, pairRankings, signals, aiAnalysis, m15Impulses, prevTracked] = await Promise.all([
    collectSentiment(),
    collectStates(),
    collectStrength(),
    collectPairRankings(),
    collectSignals(),
    collectAiAnalysis(),
    collectM15Impulses().catch(() => []),
    collectTrackedPullbacks(),
  ]);

  // Unwrap timestamped results
  const states           = statesResult.pairs;
  const statesAsOf       = statesResult.as_of;
  const currencyStrength = strengthResult.currencies;
  const strengthAsOf     = strengthResult.as_of;

  // ── Cumulative pullback tracker ────────────────────────────────────────────
  // Build a state map for fast lookup
  const stateMap = {};
  states.forEach(s => { stateMap[s.instrument] = s; });

  // Carry forward existing tracked pairs — drop only on confirmed reversal/bias-flip/trend-complete.
  // NO_TRADE with matching bias = 6H spread temporarily collapsed but 12H still intact → keep
  // tracking; the setup may recover. Only drop when direction is structurally gone.
  const carried = [];
  for (const t of prevTracked) {
    const cur = stateMap[t.instrument];
    if (!cur) { carried.push(t); continue; }                       // no current data → keep
    if (cur.state === 'REVERSAL_DEVELOPING') continue;             // 6H flipped against 12H
    if (cur.state === 'REVERSAL_CONFIRMED') continue;              // full reversal — 12H also flipped
    if (!cur.bias || cur.bias === 'NONE') continue;                // lost directional bias
    if (cur.bias !== t.bias) continue;                             // direction flipped
    if (cur.state === 'TREND') continue;                           // episode completed
    // NO_TRADE with same bias: 6H spread too small but 12H intact → pause, don't evict
    carried.push({ ...t, latest_state: cur.state, latest_conf: cur.confidence });
  }

  // Add pairs entering pullback for the first time this cycle
  const trackedSet = new Set(carried.map(t => t.instrument));
  const newEntries = [];
  for (const s of states) {
    if (['PULLBACK_STARTING', 'PULLBACK_ACTIVE', 'BASE_FORMING'].includes(s.state) && !trackedSet.has(s.instrument)) {
      newEntries.push({
        instrument:   s.instrument,
        bias:         s.bias,
        entered_at:   hourTs.toISOString(),
        latest_state: s.state,
        latest_conf:  s.confidence,
      });
    }
  }

  const tracked_pullback_pairs = [...carried, ...newEntries];
  const new_pullback_pairs     = newEntries.length;

  // Derive counts from tracked set (pullback/ready) + raw current-hour (trend/no-trade)
  const trend_pairs    = states.filter(s => s.state === 'TREND').length;
  const no_trade_pairs = states.filter(s => s.state === 'NO_TRADE').length;
  const pullback_pairs = tracked_pullback_pairs.filter(t => ['PULLBACK_STARTING', 'PULLBACK_ACTIVE', 'BASE_FORMING'].includes(t.latest_state)).length;
  const ready_pairs    = tracked_pullback_pairs.filter(t => t.latest_state === 'READY_TO_ENTER').length;

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
  }));

  // Signals summary for storage
  const signals_summary = {
    entered:   signals.entered.map(s => ({ instrument: s.instrument, signal: s.signal, confidence: s.confidence, reason: s.reason })),
    waiting:   signals.waiting.map(s => ({ instrument: s.instrument, confidence: s.confidence })),
    no_trade:  signals.no_trade.map(s => ({ instrument: s.instrument })),
  };

  // Fetch market energy for summary
  let marketEnergy = null;
  try { marketEnergy = await getMarketEnergyData(); } catch (_) {}

  // Build narrative summary
  const summary = buildSummary({
    session, sentiment, states, signals, aiAnalysis, topSetups, m15Impulses,
    trackedPullbacks: tracked_pullback_pairs,
    newPullbackCount: new_pullback_pairs,
    marketEnergy,
  });

  // Preserve existing m15_impulses if fresh collection came back empty
  // (top-of-hour FLAT window can blank out m15 data and overwrite a good snapshot)
  let m15ImpulsesFinal = m15Impulses;
  if (!m15ImpulsesFinal.length) {
    const { data: existing } = await supabase
      .from('hourly_market_journal')
      .select('m15_impulses')
      .eq('time', hourTs.toISOString())
      .maybeSingle();
    if (existing?.m15_impulses?.length) m15ImpulsesFinal = existing.m15_impulses;
  }

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
    market_states:           { as_of: statesAsOf,   pairs: states },
    currency_strength:       { as_of: strengthAsOf, currencies: currency_strength },
    risk_sentiment_details,
    ai_analysis:             aiAnalysis,
    signals_summary,
    pair_rankings:           pairRankings.slice(0, 28),
    m15_impulses:            m15ImpulsesFinal,
    tracked_pullback_pairs,
    new_pullback_pairs,
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
