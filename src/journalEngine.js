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

const ENERGY_PHASES = ['ENTRY', 'READY', 'COMPRESSION', 'PULLBACK', 'MONITORING'];

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
    instrument:              r.instrument,
    structure_type:          r.structure_type,
    trend_health:            r.trend_health,
    market_quality:          r.market_quality,
    summary:                 r.summary,
    warning:                 r.warning || null,
    lifecycle_phase:         r.details?.lifecycle_phase || null,
    lifecycle_completion:    r.details?.lifecycle_completion || null,
    scores:                  r.details?.scores || null,
    counter_pressure:        r.details?.counter_pressure || null,
    cleanliness_label:       r.details?.cleanliness_label || null,
    session_context:         r.details?.session_context || null,
    confluence_assessment:   r.details?.confluence_assessment || null,
    engine_confluence:       r.details?.engine_confluence || null,
    confluence_pct:          r.details?.confluence_pct || null,
  }));
}

async function collectEnergySignals() {
  // Fetch active energy signal pairs with phase monitoring data
  const { data: pairs, error: pErr } = await supabase
    .from('energy_signal_pairs')
    .select('instrument, dir, strong_ccy, weak_ccy, phase, phase_changed_at, trigger_energy, trigger_session, triggered_at, v45, v90, spread_3h, spread_6h, de_combined, impulse_score, impulse_aligned, m15_state, energy_level, new_energy_event, energy_event_type, active')
    .eq('active', true)
    .order('energy_level', { ascending: false });

  if (pErr) console.warn('[JOURNAL] collectEnergySignals pairs:', pErr.message);

  // Fetch currency direction states
  const { data: states, error: sErr } = await supabase
    .from('energy_currency_state')
    .select('currency, direction, smooth_3h, smooth_6h, energy_at_trigger, trigger_session, threshold_met, active, energy_event_type');

  if (sErr) console.warn('[JOURNAL] collectEnergySignals states:', sErr.message);

  const activePairs = (pairs || []).filter(p => p.active);
  const currencyStates = (states || []);

  // Phase breakdown
  const phaseBreakdown = {};
  for (const phase of ENERGY_PHASES) phaseBreakdown[phase] = [];
  for (const p of activePairs) {
    const ph = p.phase || 'MONITORING';
    if (!phaseBreakdown[ph]) phaseBreakdown[ph] = [];
    phaseBreakdown[ph].push(p);
  }

  // Currency breakdown
  const strongCurrencies = currencyStates.filter(s => s.direction === 'STRONG' && s.active);
  const weakCurrencies   = currencyStates.filter(s => s.direction === 'WEAK' && s.active);

  const peakEnergy = activePairs.length ? Math.max(...activePairs.map(p => p.energy_level || 0)) : 0;

  return {
    pairs: activePairs,
    currencyStates,
    strongCurrencies,
    weakCurrencies,
    phaseBreakdown,
    peakEnergy,
    totalPairs: activePairs.length,
  };
}

// ─── Summary builder ──────────────────────────────────────────────────────────

function buildSummary({ session, sentiment, signals, energySignals, m15Impulses, marketEnergy }) {
  const lines = [];

  // 1. Energy Direction overview (primary)
  if (energySignals && energySignals.totalPairs > 0) {
    const es = energySignals;
    const strongStr = es.strongCurrencies.map(c => c.currency).join(',') || 'none';
    const weakStr   = es.weakCurrencies.map(c => c.currency).join(',') || 'none';
    lines.push(`Energy ${Math.round(es.peakEnergy)}: Strong ${strongStr} | Weak ${weakStr} | ${es.totalPairs} pairs active.`);

    // Phase breakdown — only show phases that have pairs
    const phaseStrs = [];
    for (const phase of ENERGY_PHASES) {
      const pairs = es.phaseBreakdown[phase] || [];
      if (pairs.length) {
        const pairStr = pairs.slice(0, 3).map(p => pairLabel(p.instrument)).join(', ');
        const suffix = pairs.length > 3 ? ` +${pairs.length - 3}` : '';
        phaseStrs.push(`${phase}(${pairs.length}): ${pairStr}${suffix}`);
      }
    }
    if (phaseStrs.length) lines.push(phaseStrs.join(' | '));
  } else {
    // Fallback to market energy session data
    if (marketEnergy?.sessions?.length) {
      const SESS_LABEL = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York' };
      const sessLines = marketEnergy.sessions
        .filter(s => s.session_name !== 'LOW_LIQUIDITY')
        .map(s => {
          const name = SESS_LABEL[s.session_name] || s.session_name;
          const eng  = Math.round(s.market_energy || 0);
          return `${name}: E:${eng}`;
        });
      lines.push(sessLines.join(' | ') + ' — no energy pairs active.');
    } else {
      lines.push(`${session.label}: No energy data available.`);
    }
  }

  // 2. Signals
  if (signals.entered.length > 0) {
    const sigStr = signals.entered.map(s => `${pairLabel(s.instrument)} ${s.signal}`).join(', ');
    lines.push(`Entries: ${sigStr}.`);
  }

  // 3. M15 impulse moves (filtered to energy pairs)
  if (m15Impulses && m15Impulses.length > 0) {
    const energyPairSet = energySignals?.pairs?.length
      ? new Set(energySignals.pairs.map(p => p.instrument))
      : null;
    const filtered = energyPairSet
      ? m15Impulses.filter(r => energyPairSet.has(r.instrument))
      : m15Impulses;
    if (filtered.length) {
      const m15Str = filtered.slice(0, 5).map(r => `${pairLabel(r.instrument)} ${r.bias}`).join(', ');
      lines.push(`M15 impulses: ${m15Str}.`);
    }
  }

  // 4. Sentiment context
  if (sentiment) {
    const env = sentiment.environment || 'unknown';
    const conf = Math.round(sentiment.confidence || 0);
    lines.push(`Sentiment: ${env} (${conf}% conf).`);
  }

  return lines.join(' ');
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function writeJournalEntry() {
  const now     = new Date();
  const hourTs  = floorHour(now);
  const session = getCurrentSession(now);

  // Collect everything in parallel
  const [sentiment, statesResult, strengthResult, pairRankings, signals, aiAnalysis, m15Impulses, prevTracked, energySignals] = await Promise.all([
    collectSentiment(),
    collectStates(),
    collectStrength(),
    collectPairRankings(),
    collectSignals(),
    collectAiAnalysis(),
    collectM15Impulses().catch(() => []),
    collectTrackedPullbacks(),
    collectEnergySignals().catch(() => ({ pairs: [], currencyStates: [], strongCurrencies: [], weakCurrencies: [], phaseBreakdown: {}, peakEnergy: 0, totalPairs: 0 })),
  ]);

  // Unwrap timestamped results
  const states           = statesResult.pairs;
  const statesAsOf       = statesResult.as_of;
  const currencyStrength = strengthResult.currencies;
  const strengthAsOf     = strengthResult.as_of;

  // ── Energy-based phase tracker ──────────────────────────────────────────────
  // Track energy signal pairs by phase (replaces old pullback tracker).
  // Carry forward previous tracked pairs, update phase from energy_signal_pairs.
  const energyPairMap = {};
  for (const p of (energySignals.pairs || [])) {
    energyPairMap[p.instrument] = p;
  }

  // Carry forward tracked pairs — drop if pair is no longer active in energy signals
  const carried = [];
  for (const t of prevTracked) {
    const cur = energyPairMap[t.instrument];
    if (!cur) continue;                                            // pair deactivated → drop
    if (cur.dir !== t.bias) continue;                              // direction reversed → drop
    carried.push({
      ...t,
      latest_state: cur.phase,
      latest_conf:  cur.de_combined || 0,
      energy_level: cur.energy_level || 0,
    });
  }

  // Add new energy pairs not previously tracked
  const trackedSet = new Set(carried.map(t => t.instrument));
  const newEntries = [];
  for (const p of (energySignals.pairs || [])) {
    if (!trackedSet.has(p.instrument)) {
      newEntries.push({
        instrument:   p.instrument,
        bias:         p.dir,
        entered_at:   p.triggered_at || hourTs.toISOString(),
        latest_state: p.phase,
        latest_conf:  p.de_combined || 0,
        energy_level: p.energy_level || 0,
      });
    }
  }

  const tracked_pullback_pairs = [...carried, ...newEntries];
  const new_pullback_pairs     = newEntries.length;

  // Phase-based counts from energy signal pairs
  const entry_pairs       = (energySignals.phaseBreakdown?.ENTRY || []).length;
  const ready_pairs       = (energySignals.phaseBreakdown?.READY || []).length;
  const compression_pairs = (energySignals.phaseBreakdown?.COMPRESSION || []).length;
  const pullback_pairs    = (energySignals.phaseBreakdown?.PULLBACK || []).length;
  const monitoring_pairs  = (energySignals.phaseBreakdown?.MONITORING || []).length;

  // Legacy counts from market_states (still useful for broad market view)
  const trend_pairs    = states.filter(s => s.state === 'TREND').length;
  const no_trade_pairs = states.filter(s => s.state === 'NO_TRADE').length;

  // Top setups: energy pairs in ENTRY/READY phase, sorted by DE combo score
  const topSetups = (energySignals.pairs || [])
    .filter(p => p.phase === 'ENTRY' || p.phase === 'READY')
    .sort((a, b) => (b.de_combined || 0) - (a.de_combined || 0))
    .slice(0, 5)
    .map(p => ({
      instrument:    p.instrument,
      phase:         p.phase,
      bias:          p.dir,
      de_combined:   p.de_combined || 0,
      energy_level:  p.energy_level || 0,
      impulse_score: p.impulse_score || 0,
      strong_ccy:    p.strong_ccy,
      weak_ccy:      p.weak_ccy,
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
    session, sentiment, signals, energySignals, m15Impulses, marketEnergy,
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

  // Compose energy snapshot for storage
  const energy_snapshot = {
    peak_energy:       energySignals.peakEnergy,
    total_pairs:       energySignals.totalPairs,
    strong_currencies: energySignals.strongCurrencies.map(c => ({ currency: c.currency, smooth_3h: c.smooth_3h, smooth_6h: c.smooth_6h })),
    weak_currencies:   energySignals.weakCurrencies.map(c => ({ currency: c.currency, smooth_3h: c.smooth_3h, smooth_6h: c.smooth_6h })),
    phase_counts: {
      ENTRY:       entry_pairs,
      READY:       ready_pairs,
      COMPRESSION: compression_pairs,
      PULLBACK:    pullback_pairs,
      MONITORING:  monitoring_pairs,
    },
    pairs: (energySignals.pairs || []).map(p => ({
      instrument:    p.instrument,
      dir:           p.dir,
      phase:         p.phase,
      strong_ccy:    p.strong_ccy,
      weak_ccy:      p.weak_ccy,
      energy_level:  p.energy_level,
      de_combined:   p.de_combined,
      impulse_score: p.impulse_score,
      v45:           p.v45,
      spread_3h:     p.spread_3h,
    })),
  };

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
    energy_snapshot,
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
