const { config } = require('./config');
const { supabase } = require('./supabase');

const MIN_SPREAD   = 0.0020;
const STRONG_SPREAD = 0.0040;

// ─── States ───────────────────────────────────────────────────────────────────
// TREND               — 12H + 6H aligned, 3H expanding with trend
// PULLBACK_STARTING   — first candle of 3H weakening (compression begins)
// PULLBACK_ACTIVE     — sustained 3H compression, 6H + 12H still intact
// BASE_FORMING        — pullback at floor: compression slowing, counter-pressure
//                       stabilizing, 3H momentum no longer expanding
// READY_TO_ENTER      — after pullback: 3H re-expanding (continuation trigger)
// REVERSAL_RISK       — 6H spread near flat (< MIN_SPREAD): medium-term direction
//                       losing control; NOT a reversal yet — might recover
// REVERSAL_DEVELOPING — 6H has flipped against 12H (bias = NONE, 6H meaningful):
//                       medium-term trend control lost, wait for 12H confirmation
// REVERSAL_CONFIRMED  — 12H also flipped; 12H + 6H now agree in new direction:
//                       full trend reversal confirmed, treat as early-stage new TREND
// NO_TRADE            — spread too small, no tradeable bias

function detectBias(spread_6h, spread_12h) {
  if (spread_12h > 0 && spread_6h > 0) return 'BUY';
  if (spread_12h < 0 && spread_6h < 0) return 'SELL';
  return 'NONE';
}

function detectState({ spread_3h, spread_6h, spread_12h }, changes, prevState, bias) {
  const { c3h, c6h } = changes;

  // No valid directional bias (12H/6H disagree)
  if (bias === 'NONE') {
    if (Math.abs(spread_6h) < MIN_SPREAD) return 'REVERSAL_RISK';    // 6H going flat
    return 'REVERSAL_DEVELOPING';                                      // 6H clearly flipped
  }

  // Coming out of REVERSAL_DEVELOPING with a valid new bias → 12H aligned → confirmed
  if (prevState === 'REVERSAL_DEVELOPING') return 'REVERSAL_CONFIRMED';
  if (prevState === 'REVERSAL_CONFIRMED') {
    const dir = bias === 'BUY' ? 1 : -1;
    return c3h * dir > 0 ? 'TREND' : 'REVERSAL_CONFIRMED';
  }

  const inPullback = prevState === 'PULLBACK_STARTING' || prevState === 'PULLBACK_ACTIVE' || prevState === 'BASE_FORMING';
  const inReady    = prevState === 'READY_TO_ENTER';

  if (bias === 'BUY') {
    if (inPullback && c3h > 0) return 'READY_TO_ENTER';
    if (inReady && c3h > 0) return 'READY_TO_ENTER';
    if (c3h < 0) {
      if (prevState === 'TREND' || !prevState)
        // 3H already counter-trend (negative) → pullback already active; skip PB_STARTING
        return spread_3h < 0 ? 'PULLBACK_ACTIVE' : 'PULLBACK_STARTING';
      if (prevState === 'READY_TO_ENTER') return 'PULLBACK_STARTING';
      if ((prevState === 'PULLBACK_ACTIVE' || prevState === 'BASE_FORMING') &&
          Math.abs(spread_3h) < Math.abs(spread_6h) * 0.40)
        return 'BASE_FORMING';
      return 'PULLBACK_ACTIVE';
    }
    if (spread_6h > 0 && spread_12h > 0) return 'TREND';
  }

  if (bias === 'SELL') {
    if (inPullback && c3h < 0) return 'READY_TO_ENTER';
    if (inReady && c3h < 0) return 'READY_TO_ENTER';
    if (c3h > 0) {
      if (prevState === 'TREND' || !prevState)
        // 3H already counter-trend (positive) → pullback already active; skip PB_STARTING
        return spread_3h > 0 ? 'PULLBACK_ACTIVE' : 'PULLBACK_STARTING';
      if (prevState === 'READY_TO_ENTER') return 'PULLBACK_STARTING';
      if ((prevState === 'PULLBACK_ACTIVE' || prevState === 'BASE_FORMING') &&
          Math.abs(spread_3h) < Math.abs(spread_6h) * 0.40)
        return 'BASE_FORMING';
      return 'PULLBACK_ACTIVE';
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
  if (bias === 'NONE' || state === 'NO_TRADE' || state === 'REVERSAL_RISK' || state === 'REVERSAL_DEVELOPING') return 0;

  const dir = bias === 'BUY' ? 1 : -1;
  let score = 20;

  if (spread_12h * dir > 0 && spread_6h * dir > 0) score += 20;

  if (Math.abs(spread_6h) >= STRONG_SPREAD) score += 12;
  else if (Math.abs(spread_6h) >= MIN_SPREAD) score += 7;

  if (changes.c6h * dir > 0) score += 8;

  switch (state) {
    case 'TREND':              score += 0;  break;
    case 'PULLBACK_STARTING':  score += 7;  break;
    case 'PULLBACK_ACTIVE':    score += 12; break;
    case 'BASE_FORMING':       score += 15; break;
    case 'READY_TO_ENTER':     score += 20; break;
    case 'REVERSAL_CONFIRMED': return Math.min(score, 65); // early new trend — cautious cap
  }

  return Math.min(score, 85);
}

// ─── Reason text ──────────────────────────────────────────────────────────────
function buildReason(bias, state, spread_3h, spread_6h, spread_12h, changes) {
  if (state === 'NO_TRADE') {
    return '12H and 6H spreads disagree — no clear directional bias.';
  }
  if (state === 'REVERSAL_RISK') {
    return `6H losing direction (${Math.abs(spread_6h).toFixed(5)} < ${MIN_SPREAD} vs 12H ${spread_12h >= 0 ? '+' : ''}${spread_12h.toFixed(5)}). Structure weakening — not a reversal yet. Stand aside.`;
  }
  if (state === 'REVERSAL_DEVELOPING') {
    return `6H has flipped against 12H (${spread_6h >= 0 ? '+' : ''}${spread_6h.toFixed(5)} vs ${spread_12h >= 0 ? '+' : ''}${spread_12h.toFixed(5)}). Medium-term trend control lost. Avoid entries — await 12H confirmation.`;
  }
  if (state === 'REVERSAL_CONFIRMED') {
    return `Full reversal confirmed: 12H + 6H now agree ${bias} (${spread_12h >= 0 ? '+' : ''}${spread_12h.toFixed(5)}, ${spread_6h >= 0 ? '+' : ''}${spread_6h.toFixed(5)}). Treat as early-stage new ${bias} trend. Watch for 3H re-expansion.`;
  }

  const dir    = bias === 'BUY' ? 1 : -1;
  const strong = Math.abs(spread_6h) >= STRONG_SPREAD ? ' (strong)' : '';
  const depth  = spread_3h * dir > 0.001 ? 'Light' :
                 spread_3h * dir > -0.001 ? 'Moderate' : 'Deep';

  switch (state) {
    case 'TREND':
      return `${bias} trend: 12H + 6H aligned${strong}. 3H momentum expanding. Watch for 3H to weaken (compression zone = upcoming pullback entry).`;

    case 'PULLBACK_STARTING':
      return `${bias} bias intact (6H + 12H). 3H just started compressing (${changes.c3h.toFixed(5)}). Pullback beginning — ${depth.toLowerCase()} so far. Wait for 3H to re-expand.`;

    case 'PULLBACK_ACTIVE':
      return `${bias} bias intact (6H + 12H). ${depth} pullback active: 3H compressing (${changes.c3h.toFixed(5)}). Wait for 3H re-expansion → entry trigger.`;

    case 'BASE_FORMING':
      return `${bias} bias intact (6H + 12H). Deep pullback stabilizing: 3H compressed near floor (${Math.abs(spread_3h).toFixed(5)} vs 6H ${Math.abs(spread_6h).toFixed(5)}). Coiling — re-expansion entry approaching.`;

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
