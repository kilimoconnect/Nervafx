const { getClient, getLatestTime, cors } = require('./_db');

const MIN_SPREAD = 0.0020;

// ─── TF arrow ─────────────────────────────────────────────────────────────────
function tfArrow(val, bias) {
  if (Math.abs(val) < 0.0003) return '→';
  return (bias === 'BUY' ? val > 0 : val < 0) ? '↑' : '↓';
}

// ─── Spread lifecycle ─────────────────────────────────────────────────────────
// EXPANDING     — 3H > 6H, trend strengthening
// COMPRESSING   — 3H < 6H, pullback compressing
// BASE_FORMING  — deep pullback: 3H very flat near zero (coiling before re-expansion)
// RE-EXPANDING  — after compression: 3H re-growing (entry trigger)
// BREAKING      — 6H direction conflicts with 12H (structural breakdown)
// STABLE        — no strong directional behavior
function spreadLifecycle(state, s3, s6, s12) {
  const a3 = Math.abs(s3), a6 = Math.abs(s6), a12 = Math.abs(s12);

  // Structural breakdown: 6H and 12H disagree on direction
  if (s6 * s12 < 0 && a6 >= MIN_SPREAD) return 'BREAKING';

  // Re-expansion: pullback done, spread re-growing
  if (state === 'READY_TO_ENTER' && a3 > a6 * 0.9) return 'RE-EXPANDING';

  // Base forming: deeply compressed, spread at floor, about to re-expand
  if ((state === 'PULLBACK_ACTIVE') && a3 < a6 * 0.4) return 'BASE_FORMING';

  // Compressing: 3H notably smaller than 6H
  if (a3 < a6 * 0.85) return 'COMPRESSING';

  // Expanding: 3H larger than 6H
  if (a3 > a6 * 1.05) return 'EXPANDING';

  return 'STABLE';
}

const LIFECYCLE_TEXT = {
  'EXPANDING':    'Expanding → Trend strengthening',
  'COMPRESSING':  'Compressing → Pullback forming',
  'BASE_FORMING': 'Base forming → Entry approaching',
  'RE-EXPANDING': 'Re-expanding → Entry signal ✓',
  'BREAKING':     'Breaking → Reversal risk',
  'STABLE':       'Consolidating',
};

// ─── Pipeline stage 0–5 ───────────────────────────────────────────────────────
function pipelineStage(state, confidence) {
  if (state === 'READY_TO_ENTER' && confidence >= 75) return 5; // ENTRY_ACTIVE
  if (state === 'READY_TO_ENTER') return 4;
  if (state === 'PULLBACK_ACTIVE') return 3;
  if (state === 'PULLBACK_STARTING') return 2;
  if (state === 'TREND') return 1;
  return 0;
}

// ─── Phase / action ───────────────────────────────────────────────────────────
function phaseAction(state, confidence) {
  if (state === 'READY_TO_ENTER' && confidence >= 75) return { phase: 'ENTRY_ACTIVE', action: 'ENTER' };
  if (state === 'READY_TO_ENTER') return { phase: 'READY_TO_ENTER', action: 'WATCH' };
  if (state === 'PULLBACK_ACTIVE') return { phase: 'PULLBACK_ACTIVE', action: 'WAIT' };
  if (state === 'PULLBACK_STARTING') return { phase: 'PULLBACK_STARTING', action: 'WAIT' };
  if (state === 'TREND') return { phase: 'TREND', action: 'WATCH' };
  if (state === 'REVERSAL_RISK') return { phase: 'REVERSAL_RISK', action: 'AVOID' };
  return { phase: 'NO TRADE', action: '—' };
}

// ─── Entry status ─────────────────────────────────────────────────────────────
function entryStatus(state, confidence) {
  if (state === 'READY_TO_ENTER' && confidence >= 75) return 'READY_TO_ENTER';
  if (state === 'READY_TO_ENTER') return 'WAIT_CONFIRMATION';
  if (state === 'PULLBACK_ACTIVE') return 'WAIT_CONFIRMATION';
  if (state === 'PULLBACK_STARTING') return 'WAIT_PULLBACK';
  if (state === 'TREND') return 'WAIT_PULLBACK';
  return 'NO_TRADE';
}

// ─── Next action ─────────────────────────────────────────────────────────────
function nextAction(state, bias, confidence, lifecycle) {
  if (state === 'READY_TO_ENTER' && confidence >= 75) return 'ENTER NOW';
  if (state === 'READY_TO_ENTER') {
    if (lifecycle === 'BREAKING')    return 'Structural warning — re-expansion interrupted';
    if (lifecycle === 'COMPRESSING') return 'Wait: 3H stalling — re-expansion must confirm';
    return 'Watch: 3H re-expanding — confidence building';
  }
  if (state === 'PULLBACK_ACTIVE') {
    if (lifecycle === 'BREAKING')    return 'Structural breakdown risk — avoid entry';
    if (lifecycle === 'BASE_FORMING') return 'Base coiling — re-expansion entry approaching';
    return 'Watch: 3H must re-expand → ENTRY';
  }
  if (state === 'PULLBACK_STARTING') {
    if (lifecycle === 'BREAKING')    return 'Structural warning: 6H/12H conflict — wait';
    if (lifecycle === 'COMPRESSING') return '3H compressing — pullback deepening';
    return 'Watch: 3H momentum weakening (compression zone)';
  }
  if (state === 'TREND') {
    if (lifecycle === 'BREAKING')    return 'Structural warning: 6H/12H conflict — avoid';
    if (lifecycle === 'COMPRESSING') return 'Pullback beginning — watch for PULLBACK_STARTING';
    if (lifecycle === 'EXPANDING')   return 'Trend expanding — wait for 3H to start compressing';
    return 'Watch: 3H must start compressing (pullback forming)';
  }
  return 'No setup forming';
}

// ─── Invalidation ─────────────────────────────────────────────────────────────
// Structural failures only — not normal pullback compression
function invalidationWarning(state, bias) {
  if (!state || state === 'NO_TRADE' || !bias || bias === 'NONE') return null;
  if (state === 'READY_TO_ENTER') return '6H spread collapses → entry cancelled';
  if (state === 'PULLBACK_STARTING' || state === 'PULLBACK_ACTIVE') return '6H collapses OR 12H direction flips → reversal risk';
  if (state === 'TREND') return '6H collapses below MIN threshold → trend invalid';
  return null;
}

// ─── Pullback depth ───────────────────────────────────────────────────────────
function pullbackDepth(state, s3, bias) {
  if (state !== 'PULLBACK_STARTING' && state !== 'PULLBACK_ACTIVE') return null;
  const inDir = s3 * (bias === 'BUY' ? 1 : -1);
  if (inDir > 0.001)  return 'LIGHT';    // 3H still in trend direction, just slowing
  if (inDir > -0.001) return 'MODERATE'; // 3H near zero (compression floor)
  return 'DEEP';                          // 3H moved against trend (still valid)
}

// ─── Confidence breakdown ─────────────────────────────────────────────────────
function confBreakdown(s3, s6, s12, bias, state) {
  if (!bias || bias === 'NONE') return [];
  const dir = bias === 'BUY' ? 1 : -1;
  const out = [];
  if (s12 * dir > 0 && s6 * dir > 0) out.push('12H & 6H aligned');
  if (Math.abs(s6) >= 0.004) out.push('6H strong');
  else if (Math.abs(s6) >= 0.002) out.push('6H moderate');
  if (s3 * dir > 0 && (state === 'PULLBACK_STARTING' || state === 'PULLBACK_ACTIVE')) out.push('Light pullback (3H still in trend direction)');
  else if (s3 * dir > 0) out.push('3H aligned with trend');
  if (state === 'READY_TO_ENTER') out.push('Pullback completed');
  if (Math.abs(s3) < Math.abs(s6) && (state === 'PULLBACK_STARTING' || state === 'PULLBACK_ACTIVE')) out.push('3H compressing (pullback forming)');
  if (Math.abs(s3) > Math.abs(s6) && state === 'READY_TO_ENTER') out.push('Spread re-expanding');
  return out;
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  cors(res);
  try {
    const t = await getLatestTime('market_states');
    if (!t) return res.json({ states: [] });

    const { data, error } = await getClient()
      .from('market_states')
      .select('instrument, bias, state, confidence, spread_3h, spread_6h, spread_12h, reason')
      .eq('time', t)
      .order('confidence', { ascending: false });
    if (error) throw error;

    const states = (data || []).map(s => {
      const { bias, state, confidence } = s;
      const s3  = parseFloat(s.spread_3h)  || 0;
      const s6  = parseFloat(s.spread_6h)  || 0;
      const s12 = parseFloat(s.spread_12h) || 0;
      const { phase, action } = phaseAction(state, confidence);
      const lifecycle = spreadLifecycle(state, s3, s6, s12);
      return {
        ...s,
        pipeline_stage:       pipelineStage(state, confidence),
        entry_status:         entryStatus(state, confidence),
        phase,
        action,
        tf_alignment:         { h12: tfArrow(s12, bias), h6: tfArrow(s6, bias), h3: tfArrow(s3, bias) },
        spread_behavior:      lifecycle,
        spread_behavior_text: LIFECYCLE_TEXT[lifecycle] || '',
        confidence_breakdown: confBreakdown(s3, s6, s12, bias, state),
        next_action:          nextAction(state, bias, confidence, lifecycle),
        invalidation:         invalidationWarning(state, bias),
        pullback_depth:       pullbackDepth(state, s3, bias),
      };
    });

    res.json({ time: t, states });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
