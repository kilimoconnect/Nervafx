const { config } = require('./config');
const { supabase } = require('./supabase');

const MIN_SPREAD = 0.0020;
const STRONG_SPREAD = 0.0040;

// ─── Core logic ──────────────────────────────────────────────────────────────

function detectBias(spread_6h, spread_12h) {
  if (spread_12h > 0 && spread_6h > 0) return 'BUY';
  if (spread_12h < 0 && spread_6h < 0) return 'SELL';
  return 'NONE';
}

function detectState({ spread_3h, spread_6h, spread_12h }, changes, prevState, bias) {
  const { c3h, c6h } = changes;

  // Bias disagrees between timeframes → REVERSAL if magnitude exists, else NO_TRADE
  if (bias === 'NONE') {
    return Math.abs(spread_6h) >= MIN_SPREAD ? 'REVERSAL' : 'NO_TRADE';
  }

  // Spread too small to act on
  if (Math.abs(spread_6h) < MIN_SPREAD) return 'NO_TRADE';

  if (bias === 'BUY') {
    if (prevState === 'PULLBACK' && c3h > 0) return 'CONTINUATION';
    if (c3h < 0) return 'PULLBACK';
    if (c6h > 0) return 'TREND';
  }

  if (bias === 'SELL') {
    if (prevState === 'PULLBACK' && c3h < 0) return 'CONTINUATION';
    if (c3h > 0) return 'PULLBACK';
    if (c6h < 0) return 'TREND';
  }

  return 'NO_TRADE';
}

function scoreConfidence({ spread_6h, spread_12h }, changes, state, bias, prevState) {
  if (bias === 'NONE' || state === 'NO_TRADE') return 0;

  const dir = bias === 'BUY' ? 1 : -1;
  let score = 0;

  // 12h and 6h aligned
  if (spread_12h * dir > 0 && spread_6h * dir > 0) score += 25;

  // Spread above threshold
  if (Math.abs(spread_6h) >= MIN_SPREAD) score += 25;

  // 3h change confirms direction
  if (changes.c3h * dir > 0) score += 20;

  // 6h change confirms direction
  if (changes.c6h * dir > 0) score += 20;

  // Previous pullback resolved
  if (prevState === 'PULLBACK') score += 10;

  return Math.min(score, 100);
}

function buildReason(bias, state, spread_6h, spread_12h, changes, prevState) {
  if (state === 'NO_TRADE') {
    if (bias === 'NONE') return '12H and 6H spreads disagree; no clear directional bias.';
    return `Spread too small (abs ${Math.abs(spread_6h).toFixed(5)} < ${MIN_SPREAD}); no tradeable bias.`;
  }

  const dir = bias === 'BUY' ? 'bullish' : 'bearish';
  const abs6 = Math.abs(spread_6h).toFixed(5);
  const strong = Math.abs(spread_6h) >= STRONG_SPREAD ? ' (strong)' : '';

  switch (state) {
    case 'TREND':
      // 3H is still expanding with the trend — watching for it to weaken (pullback zone upcoming)
      return `${bias} trend: 12H and 6H both aligned${strong}. 3H momentum expanding. Watch for 3H to weaken/compress — that is your pullback entry zone.`;

    case 'PULLBACK':
      // 3H weakened (c3h < 0) — it may still be positive, just compressing. This is NOT trend failure.
      // A healthy pullback means 3H is weaker than before, while 6H and 12H hold their direction.
      { const depth = spread_3h * (bias === 'BUY' ? 1 : -1) > 0.001 ? 'Light' : spread_3h * (bias === 'BUY' ? 1 : -1) > -0.001 ? 'Moderate' : 'Deep';
        return `${bias} bias intact (6H + 12H). ${depth} pullback: 3H momentum compressing (${changes.c3h.toFixed(5)}). Waiting for 3H to re-expand — that triggers the entry.`; }

    case 'CONTINUATION':
      // After pullback: 3H started re-expanding (c3h > 0). This is the entry trigger.
      return `${bias} continuation: pullback ended, 3H momentum re-expanding (+${changes.c3h.toFixed(5)}). 6H and 12H remain aligned. Entry condition met.`;

    case 'REVERSAL':
      return `12H spread (${spread_12h >= 0 ? 'positive' : 'negative'}) conflicts with 6H spread; structural disagreement. Possible directional reversal underway.`;

    default:
      return '';
  }
}

function classifyRow(spread, prevSpread, prevState) {
  const { spread_3h, spread_6h, spread_12h } = spread;

  const c3h = prevSpread ? spread_3h - prevSpread.spread_3h : 0;
  const c6h = prevSpread ? spread_6h - prevSpread.spread_6h : 0;
  const c12h = prevSpread ? spread_12h - prevSpread.spread_12h : 0;
  const changes = { c3h, c6h, c12h };

  const bias = detectBias(spread_6h, spread_12h);
  const state = detectState({ spread_3h, spread_6h, spread_12h }, changes, prevState, bias);
  const confidence = scoreConfidence({ spread_6h, spread_12h }, changes, state, bias, prevState);
  const reason = buildReason(bias, state, spread_6h, spread_12h, changes, prevState);

  return {
    time: spread.time,
    instrument: spread.instrument,
    bias,
    state,
    confidence,
    spread_3h,
    spread_6h,
    spread_12h,
    spread_change_3h: prevSpread ? c3h : null,
    spread_change_6h: prevSpread ? c6h : null,
    spread_change_12h: prevSpread ? c12h : null,
    reason,
  };
}

// ─── Data layer ───────────────────────────────────────────────────────────────

async function fetchAllSpreads() {
  const lookup = {};

  for (const instrument of config.instruments) {
    const { data, error } = await supabase
      .from('pair_strength_spreads')
      .select('time, instrument, spread_3h, spread_6h, spread_12h')
      .eq('instrument', instrument)
      .order('time', { ascending: true });

    if (error) throw new Error(`Spread fetch error (${instrument}): ${error.message}`);
    lookup[instrument] = data || [];
  }

  return lookup;
}

async function upsertStates(rows) {
  if (rows.length === 0) return;
  const { error } = await supabase
    .from('market_states')
    .upsert(rows, { onConflict: 'time,instrument', ignoreDuplicates: false });
  if (error) throw new Error(`State upsert error: ${error.message}`);
}

// ─── Backfill ─────────────────────────────────────────────────────────────────

async function backfillStates() {
  console.log('[STATE] Fetching all spread data...');
  const lookup = await fetchAllSpreads();

  let total = 0;
  const BATCH_SIZE = 500;
  let batch = [];

  for (const instrument of config.instruments) {
    const rows = lookup[instrument];
    let prevSpread = null;
    let prevState = null;

    for (const row of rows) {
      const result = classifyRow(row, prevSpread, prevState);
      batch.push(result);
      prevSpread = row;
      prevState = result.state;

      if (batch.length >= BATCH_SIZE) {
        await upsertStates(batch);
        total += batch.length;
        batch = [];
      }
    }
  }

  if (batch.length > 0) {
    await upsertStates(batch);
    total += batch.length;
  }

  console.log(`[STATE] Backfill done. ${total} market state rows stored.`);
  return { total };
}

// ─── Incremental ──────────────────────────────────────────────────────────────

async function calculateLatestStates() {
  const results = [];

  for (const instrument of config.instruments) {
    // Get current and previous spread
    const { data: spreads, error } = await supabase
      .from('pair_strength_spreads')
      .select('time, instrument, spread_3h, spread_6h, spread_12h')
      .eq('instrument', instrument)
      .order('time', { ascending: false })
      .limit(2);

    if (error || !spreads || spreads.length === 0) continue;

    const current = spreads[0];
    const prev = spreads[1] || null;

    // Get previous state
    let prevState = null;
    if (prev) {
      const { data: ps } = await supabase
        .from('market_states')
        .select('state')
        .eq('instrument', instrument)
        .eq('time', prev.time)
        .single();
      if (ps) prevState = ps.state;
    }

    results.push(classifyRow(current, prev, prevState));
  }

  await upsertStates(results);
  console.log(`[STATE] Stored ${results.length} market states for latest candle`);
  return results;
}

// ─── Display ──────────────────────────────────────────────────────────────────

async function printLatestStates() {
  const { data, error } = await supabase
    .from('market_states')
    .select('instrument, bias, state, confidence, spread_6h, spread_12h, reason')
    .order('time', { ascending: false })
    .limit(28);

  if (error) throw new Error(error.message);

  const sorted = (data || []).sort((a, b) => b.confidence - a.confidence);

  console.log('\nMarket States (ranked by confidence):');
  console.log('─'.repeat(80));
  for (const r of sorted) {
    const s6 = Number(r.spread_6h).toFixed(5);
    const s12 = Number(r.spread_12h).toFixed(5);
    console.log(
      `${r.instrument.padEnd(8)} ${r.bias.padEnd(5)} ${r.state.padEnd(13)} conf:${String(r.confidence).padStart(3)}  6h:${s6}  12h:${s12}`
    );
    if (r.reason) console.log(`         ${r.reason}`);
  }
}

module.exports = { backfillStates, calculateLatestStates, printLatestStates, classifyRow };
