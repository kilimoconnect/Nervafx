const { getClient, getLatestTime, cors } = require('./_db');

function tfArrow(val, bias) {
  if (Math.abs(val) < 0.0003) return '→';
  return (bias === 'BUY' ? val > 0 : val < 0) ? '↑' : '↓';
}

function spreadBehavior(s3, s6, s12) {
  const a3 = Math.abs(s3), a6 = Math.abs(s6), a12 = Math.abs(s12);
  if (a3 > a6 * 0.9 && a6 > a12 * 0.9 && a3 > a12 * 1.05) return 'EXPANDING';
  if (a3 < a6 * 1.1 && a6 < a12 * 1.1 && a12 > a3 * 1.05) return 'COMPRESSING';
  return 'STABLE';
}

function entryStatus(state, confidence) {
  if (state === 'CONTINUATION' && confidence >= 75) return 'READY_TO_ENTER';
  if (state === 'PULLBACK') return 'WAIT_CONFIRMATION';
  if (state === 'TREND') return 'WAIT_PULLBACK';
  return 'NO_TRADE';
}

function phaseAction(state, confidence) {
  if (state === 'CONTINUATION' && confidence >= 75) return { phase: 'READY', action: 'ENTER' };
  if (state === 'CONTINUATION') return { phase: 'READY', action: 'WATCH' };
  if (state === 'PULLBACK') return { phase: 'PULLBACK', action: 'WAIT' };
  if (state === 'TREND') return { phase: 'TREND', action: 'WATCH' };
  if (state === 'REVERSAL') return { phase: 'REVERSAL', action: 'WATCH' };
  return { phase: 'NO TRADE', action: '—' };
}

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

function nextCondition(state, bias) {
  const pos = bias === 'BUY' ? 'positive' : 'negative';
  const neg = bias === 'BUY' ? 'negative' : 'positive';
  switch (state) {
    case 'TREND':        return `Wait: 3H must pull back (turn ${neg})`;
    case 'PULLBACK':     return `3H must turn ${pos} → triggers CONTINUATION`;
    case 'CONTINUATION': return 'Entry condition met';
    default:             return 'No setup forming';
  }
}

function invalidationWarning(state, bias) {
  if (!state || state === 'NO_TRADE' || !bias || bias === 'NONE') return null;
  const neg = bias === 'BUY' ? 'negative' : 'positive';
  const opp = bias === 'BUY' ? 'positive' : 'negative';
  if (state === 'CONTINUATION' || state === 'TREND') return `3H turns ${neg} → signal invalid`;
  if (state === 'PULLBACK') return `6H reverses to ${opp} → bias invalid`;
  return null;
}

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
      return {
        ...s,
        entry_status:          entryStatus(state, confidence),
        phase,
        action,
        tf_alignment:          { h12: tfArrow(s12, bias), h6: tfArrow(s6, bias), h3: tfArrow(s3, bias) },
        spread_behavior:       spreadBehavior(s3, s6, s12),
        confidence_breakdown:  confBreakdown(s3, s6, s12, bias, state),
        next_condition:        nextCondition(state, bias),
        invalidation:          invalidationWarning(state, bias),
      };
    });

    res.json({ time: t, states });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
