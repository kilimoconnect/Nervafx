const { config } = require('./config');
const { supabase } = require('./supabase');

const MIN_SPREAD   = 0.0020;
const STRONG_SPREAD = 0.0040;

// ─── States ───────────────────────────────────────────────────────────────────
// TREND            — 12H/6H aligned, 3H expanding with trend
// PULLBACK_STARTING — first candle of 3H weakening (compression begins)
// PULLBACK_ACTIVE   — sustained 3H compression (6H/12H still intact)
// READY_TO_ENTER    — after pullback: 3H starts re-expanding (entry trigger)
// REVERSAL_RISK     — 12H/6H directional disagreement
// NO_TRADE          — spread too small, no tradeable bias

function detectBias(spread_6h, spread_12h) {
  if (spread_12h > 0 && spread_6h > 0) return 'BUY';
  if (spread_12h < 0 && spread_6h < 0) return 'SELL';
  return 'NONE';
}

function detectState({ spread_3h, spread_6h, spread_12h }, changes, prevState, bias) {
  const { c3h, c6h } = changes;

  if (bias === 'NONE') {
    return Math.abs(spread_6h) >= MIN_SPREAD ? 'REVERSAL_RISK' : 'NO_TRADE';
  }
  if (Math.abs(spread_6h) < MIN_SPREAD) return 'NO_TRADE';

  const inPullback = prevState === 'PULLBACK_STARTING' || prevState === 'PULLBACK_ACTIVE';
  const inReady    = prevState === 'READY_TO_ENTER';

  if (bias === 'BUY') {
    // After pullback: 3H starts re-expanding → entry trigger
    if (inPullback && c3h > 0) return 'READY_TO_ENTER';
    // Stay READY while 3H continues expanding
    if (inReady && c3h > 0) return 'READY_TO_ENTER';
    // 3H weakening → pullback entering
    if (c3h < 0) {
      return (prevState === 'TREND' || prevState === 'READY_TO_ENTER' || !prevState)
        ? 'PULLBACK_STARTING'
        : 'PULLBACK_ACTIVE';
    }
    // 3H flat/positive with BUY bias → trend
    if (spread_6h > 0 && spread_12h > 0) return 'TREND';
  }

  if (bias === 'SELL') {
    if (inPullback && c3h < 0) return 'READY_TO_ENTER';
    if (inReady && c3h < 0) return 'READY_TO_ENTER';
    if (c3h > 0) {
      return (prevState === 'TREND' || prevState === 'READY_TO_ENTER' || !prevState)
        ? 'PULLBACK_STARTING'
        : 'PULLBACK_ACTIVE';
    }
    if (spread_6h < 0 && spread_12h < 0) return 'TREND';
  }

  return 'NO_TRADE';
}

// ─── Recalibrated confidence ──────────────────────────────────────────────────
// Target ranges:
//   TREND:             55–62
//   PULLBACK_STARTING: 62–67
//   PULLBACK_ACTIVE:   67–73
//   READY_TO_ENTER:    75–85
function scoreConfidence({ spread_6h, spread_12h }, changes, state, bias) {
  if (bias === 'NONE' || state === 'NO_TRADE' || state === 'REVERSAL_RISK') return 0;

  const dir = bias === 'BUY' ? 1 : -1;
  let score = 20; // base: valid directional bias exists

  // Structural alignment: 12H + 6H both in bias direction
  if (spread_12h * dir > 0 && spread_6h * dir > 0) score += 20;

  // 6H spread magnitude
  if (Math.abs(spread_6h) >= STRONG_SPREAD) score += 12;
  else if (Math.abs(spread_6h) >= MIN_SPREAD) score += 7;

  // 6H trending in right direction (momentum)
  if (changes.c6h * dir > 0) score += 8;

  // State lifecycle bonus
  switch (state) {
    case 'TREND':             score += 0;  break;
    case 'PULLBACK_STARTING': score += 7;  break;
    case 'PULLBACK_ACTIVE':   score += 12; break;
    case 'READY_TO_ENTER':    score += 20; break;
  }

  return Math.min(score, 85);
}

// ─── Reason text ──────────────────────────────────────────────────────────────
function buildReason(bias, state, spread_3h, spread_6h, spread_12h, changes) {
  if (state === 'NO_TRADE') {
    if (bias === 'NONE') return '12H and 6H spreads disagree; no clear directional bias.';
    return `Spread too small (${Math.abs(spread_6h).toFixed(5)} < ${MIN_SPREAD}); no tradeable bias.`;
  }
  if (state === 'REVERSAL_RISK') {
    return `12H (${spread_12h >= 0 ? '+' : ''}${spread_12h.toFixed(5)}) conflicts with 6H (${spread_6h >= 0 ? '+' : ''}${spread_6h.toFixed(5)}). Possible reversal forming.`;
  }

  const dir    = bias === 'BUY' ? 'bullish' : 'bearish';
  const strong = Math.abs(spread_6h) >= STRONG_SPREAD ? ' (strong)' : '';
  const depth  = spread_3h * (bias === 'BUY' ? 1 : -1) > 0.001 ? 'Light' :
                 spread_3h * (bias === 'BUY' ? 1 : -1) > -0.001 ? 'Moderate' : 'Deep';

  switch (state) {
    case 'TREND':
      return `${bias} trend: 12H + 6H aligned${strong}. 3H momentum expanding. Watch for 3H to weaken (compression zone = upcoming pullback entry).`;

    case 'PULLBACK_STARTING':
      return `${bias} bias intact (6H + 12H). 3H just started compressing (${changes.c3h.toFixed(5)}). Pullback beginning — ${depth.toLowerCase()} so far. Wait for 3H to re-expand.`;

    case 'PULLBACK_ACTIVE':
      return `${bias} bias intact (6H + 12H). ${depth} pullback active: 3H compressing (${changes.c3h.toFixed(5)}). Wait for 3H re-expansion → entry trigger.`;

    case 'READY_TO_ENTER':
      return `${bias} continuation: pullback ended, 3H re-expanding (+${changes.c3h.toFixed(5)}). 6H + 12H remain aligned. Entry condition met.`;

    default:
      return '';
  }
}

// ─── Row classification ───────────────────────────────────────────────────────
function classifyRow(spread, prevSpread, prevState) {
  const { spread_3h, spread_6h, spread_12h } = spread;

  const c3h  = prevSpread ? spread_3h  - prevSpread.spread_3h  : 0;
  const c6h  = prevSpread ? spread_6h  - prevSpread.spread_6h  : 0;
  const c12h = prevSpread ? spread_12h - prevSpread.spread_12h : 0;
  const changes = { c3h, c6h, c12h };

  const bias       = detectBias(spread_6h, spread_12h);
  const state      = detectState({ spread_3h, spread_6h, spread_12h }, changes, prevState, bias);
  const confidence = scoreConfidence({ spread_6h, spread_12h }, changes, state, bias);
  const reason     = buildReason(bias, state, spread_3h, spread_6h, spread_12h, changes);

  return {
    time: spread.time,
    instrument: spread.instrument,
    bias,
    state,
    confidence,
    spread_3h,
    spread_6h,
    spread_12h,
    spread_change_3h:  prevSpread ? c3h  : null,
    spread_change_6h:  prevSpread ? c6h  : null,
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
    let prevState  = null;
    for (const row of rows) {
      const result = classifyRow(row, prevSpread, prevState);
      batch.push(result);
      prevSpread = row;
      prevState  = result.state;
      if (batch.length >= BATCH_SIZE) {
        await upsertStates(batch);
        total += batch.length;
        batch = [];
      }
    }
  }
  if (batch.length > 0) { await upsertStates(batch); total += batch.length; }
  console.log(`[STATE] Backfill done. ${total} rows.`);
  return { total };
}

// ─── Incremental ──────────────────────────────────────────────────────────────
async function calculateLatestStates() {
  const results = [];
  for (const instrument of config.instruments) {
    const { data: spreads, error } = await supabase
      .from('pair_strength_spreads')
      .select('time, instrument, spread_3h, spread_6h, spread_12h')
      .eq('instrument', instrument)
      .order('time', { ascending: false })
      .limit(2);
    if (error || !spreads || spreads.length === 0) continue;

    const current = spreads[0];
    const prev    = spreads[1] || null;
    let prevState = null;
    if (prev) {
      const { data: ps } = await supabase
        .from('market_states').select('state')
        .eq('instrument', instrument).eq('time', prev.time).single();
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
    console.log(`${r.instrument.padEnd(8)} ${r.bias.padEnd(5)} ${r.state.padEnd(20)} conf:${String(r.confidence).padStart(3)}`);
    if (r.reason) console.log(`         ${r.reason}`);
  }
}

module.exports = { backfillStates, calculateLatestStates, printLatestStates, classifyRow };
