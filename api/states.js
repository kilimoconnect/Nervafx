const { getClient, getLatestTime, cors } = require('./_db');

// ─── TF arrow ─────────────────────────────────────────────────────────────────
function tfArrow(val, bias) {
  if (Math.abs(val) < 0.0003) return '→';
  return (bias === 'BUY' ? val > 0 : val < 0) ? '↑' : '↓';
}

// ─── Spread behavior ──────────────────────────────────────────────────────────
function spreadBehavior(s3, s6, s12) {
  const a3 = Math.abs(s3), a6 = Math.abs(s6), a12 = Math.abs(s12);
  if (a3 > a6 * 0.9 && a6 > a12 * 0.9 && a3 > a12 * 1.05) return 'EXPANDING';
  if (a3 < a6 * 1.1 && a6 < a12 * 1.1 && a12 > a3 * 1.05) return 'COMPRESSING';
  return 'STABLE';
}

// RE-EXPANDING = was compressing (pullback), now expanding again (entry trigger)
function spreadBehaviorDisplay(behavior, state) {
  if (behavior === 'EXPANDING' && state === 'CONTINUATION') return 'RE-EXPANDING';
  return behavior;
}

function spreadBehaviorInterpret(display) {
  switch (display) {
    case 'RE-EXPANDING':  return 'Re-expanding → Entry signal';
    case 'EXPANDING':     return 'Expanding → Trend strengthening';
    case 'COMPRESSING':   return 'Compressing → Pullback forming';
    default:              return 'Consolidating';
  }
}

// ─── Pipeline stage 0–4 ───────────────────────────────────────────────────────
// 0 = NO_TRADE  1 = TREND  2 = PULLBACK  3 = READY (low conf)  4 = ENTER
function pipelineStage(state, confidence) {
  if (state === 'CONTINUATION' && confidence >= 75) return 4;
  if (state === 'CONTINUATION') return 3;
  if (state === 'PULLBACK') return 2;
  if (state === 'TREND') return 1;
  return 0;
}

// ─── Entry status ─────────────────────────────────────────────────────────────
function entryStatus(state, confidence) {
  if (state === 'CONTINUATION' && confidence >= 75) return 'READY_TO_ENTER';
  if (state === 'PULLBACK') return 'WAIT_CONFIRMATION';
  if (state === 'TREND') return 'WAIT_PULLBACK';
  return 'NO_TRADE';
}

// ─── Phase / action ───────────────────────────────────────────────────────────
function phaseAction(state, confidence) {
  if (state === 'CONTINUATION' && confidence >= 75) return { phase: 'READY', action: 'ENTER' };
  if (state === 'CONTINUATION') return { phase: 'READY', action: 'WATCH' };
  if (state === 'PULLBACK') return { phase: 'PULLBACK', action: 'WAIT' };
  if (state === 'TREND') return { phase: 'TREND', action: 'WATCH' };
  if (state === 'REVERSAL') return { phase: 'REVERSAL', action: 'WATCH' };
  return { phase: 'NO TRADE', action: '—' };
}

// ─── Next action (what must happen next — positive instruction) ───────────────
function nextAction(state, bias, confidence) {
  const pos = bias === 'BUY' ? 'positive' : 'negative';
  const neg = bias === 'BUY' ? 'negative' : 'positive';
  if (state === 'CONTINUATION' && confidence >= 75) return 'ENTER NOW';
  if (state === 'CONTINUATION') return 'Confirm: confidence building';
  if (state === 'PULLBACK') return `3H must flip ${pos} → ENTER`;
  if (state === 'TREND') return `Wait: 3H pulls back (turns ${neg})`;
  return 'No setup forming';
}

// ─── Invalidation (what KILLS the setup — distinct from next step) ────────────
// For TREND: 3H turning negative is GOOD (pullback starting), NOT invalidation
// For PULLBACK: 3H turning positive is GOOD (entry trigger), NOT invalidation
// Real invalidation = 6H spread reversing direction (bias is broken)
// For CONTINUATION: 3H turning negative again CANCELS the entry
function invalidationWarning(state, bias) {
  if (!state || state === 'NO_TRADE' || !bias || bias === 'NONE') return null;
  const neg = bias === 'BUY' ? 'negative' : 'positive';
  if (state === 'CONTINUATION') return `3H turns ${neg} again → entry cancelled`;
  if (state === 'TREND' || state === 'PULLBACK') return `6H spread reverses direction → bias invalid`;
  return null;
}

// ─── Confidence breakdown ─────────────────────────────────────────────────────
function confBreakdown(s3, s6, s12, bias, state) {
  if (!bias || bias === 'NONE') return [];
  const dir = bias === 'BUY' ? 1 : -1;
  const out = [];
  if (s12 * dir > 0 && s6 * dir > 0) out.push('12H & 6H aligned');
  if (Math.abs(s6) >= 0.004) out.push('6H strong');
  else if (Math.abs(s6) >= 0.002) out.push('6H moderate');
  if (s3 * dir > 0) out.push('3H momentum positive');
  if (state === 'CONTINUATION') out.push('Pullback completed');
  if (Math.abs(s3) > Math.abs(s6)) out.push('Spread expanding');
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
      const sb      = spreadBehavior(s3, s6, s12);
      const sbDisp  = spreadBehaviorDisplay(sb, state);
      return {
        ...s,
        pipeline_stage:        pipelineStage(state, confidence),
        entry_status:          entryStatus(state, confidence),
        phase,
        action,
        tf_alignment:          { h12: tfArrow(s12, bias), h6: tfArrow(s6, bias), h3: tfArrow(s3, bias) },
        spread_behavior:       sbDisp,
        spread_behavior_text:  spreadBehaviorInterpret(sbDisp),
        confidence_breakdown:  confBreakdown(s3, s6, s12, bias, state),
        next_action:           nextAction(state, bias, confidence),
        invalidation:          invalidationWarning(state, bias),
      };
    });

    res.json({ time: t, states });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
