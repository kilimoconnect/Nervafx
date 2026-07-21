'use strict';

// Shared 3H/6H/12H currency-strength gate for the continuation engines.
//
// A break where neither currency is committed is the kind that fades, so one
// leg of the pair must carry conviction in the trade's direction on at least
// one horizon — the base bid up, or the quote sold off.
//
// Note the horizons are not equally selective at a flat threshold: on a recent
// 400-row sample, 10% of smooth_3h readings clear 0.00100 against 26% of
// smooth_6h and 44% of smooth_12h. Accepting any of the three is therefore a
// good deal looser than 3H alone, and is dominated by the 12H leg.
const STRENGTH_MIN = 0.00100;
const HORIZONS = ['smooth_3h', 'smooth_6h', 'smooth_12h'];
const HOUR_MS = 3600000;

// currency_strength trails the candle feed; accept the most recent published
// reading rather than failing a pair over pipeline timing.
const STALE_HOURS = 3;

async function loadStrength(sb, sinceISO, untilISO) {
  const since = new Date(
    new Date(sinceISO).getTime() - (STALE_HOURS + 1) * HOUR_MS
  ).toISOString();
  const { data, error } = await sb
    .from('currency_strength')
    .select('time, currency, ' + HORIZONS.join(', '))
    .gte('time', since).lte('time', untilISO)
    .order('time', { ascending: true })
    .limit(20000);
  if (error) throw error;

  const byHour = {};
  for (const r of (data || [])) {
    const hk = r.time.slice(0, 13);
    (byHour[hk] = byHour[hk] || {})[r.currency] =
      HORIZONS.map(col => parseFloat(r[col]) || 0);
  }
  return byHour;
}

// A row stamped at hour H derives from the H1 candle opening at H, so it only
// exists once that candle closes at H+1h. Given a trigger that itself confirms
// at closeMs, the newest row a trader could actually have seen is the last one
// whose own close falls at or before that moment. For an H1 trigger that is the
// candle's own hour; for an M15 trigger it is the previous hour — which is why
// the trigger timeframe has to be passed in rather than assumed.
function readingsAt(byHour, closeMs, ccy) {
  const latest = Math.floor((closeMs - HOUR_MS) / HOUR_MS) * HOUR_MS;
  for (let b = 0; b <= STALE_HOURS; b++) {
    const hk = new Date(latest - b * HOUR_MS).toISOString().slice(0, 13);
    const v = byHour[hk]?.[ccy];
    if (v !== undefined) return v;
  }
  return null;
}

// Returns { ok, currency, value, horizon } — or { ok: false } when neither leg
// carries conviction on any horizon. `nodata` marks a pair passed unjudged.
function strengthGate(byHour, inst, direction, triggerMs, tfMs) {
  const closeMs = triggerMs + tfMs;
  const [base, quote] = inst.split('_');
  const b = readingsAt(byHour, closeMs, base);
  const q = readingsAt(byHour, closeMs, quote);
  // A strength outage must not blank the board; pass unjudged and say so.
  if (!b || !q) return { ok: true, nodata: true };

  // Credit whichever leg and horizon is doing the most work.
  let best = null;
  const consider = (currency, value, horizon) => {
    if (!best || Math.abs(value) > Math.abs(best.value)) {
      best = { currency, value, horizon };
    }
  };

  for (let i = 0; i < HORIZONS.length; i++) {
    const label = HORIZONS[i].replace('smooth_', '').toUpperCase();
    const bv = b[i], qv = q[i];
    const baseOk  = direction === 'BUY' ? bv >=  STRENGTH_MIN : bv <= -STRENGTH_MIN;
    const quoteOk = direction === 'BUY' ? qv <= -STRENGTH_MIN : qv >=  STRENGTH_MIN;
    if (baseOk)  consider(base,  bv, label);
    if (quoteOk) consider(quote, qv, label);
  }

  return best ? { ok: true, ...best } : { ok: false };
}

module.exports = { loadStrength, strengthGate, STRENGTH_MIN, STALE_HOURS };
