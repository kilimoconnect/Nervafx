'use strict';

/**
 * H4 continuation state machine (steps 6 & 7). Long and short are the SAME code,
 * mirrored through a trend sign s (+1 bullish buy, −1 bearish sell) and a signed
 * comparator fav(a,b) = s·(a−b) > 0 ("a is further in the trend direction than b").
 *
 * States: UNAVAILABLE, NEUTRAL, WAITING_FOR_PULLBACK, PULLBACK_ACTIVE, FIRST_BREAK,
 *         WAITING_FOR_RETEST_STRUCTURE, ARMED, TRIGGERED, CANCELLED, EXPIRED.
 *
 * Deterministic, causal, one opportunity per pullback episode. The engine consumes
 * COMPLETED H4 candles in order and the weekly context (biasAt at each H4 close);
 * every decision uses only confirmed pivots knowable at that close, so appending
 * later candles never changes an already-emitted output.
 *
 * Roles by direction (buy / sell):
 *   break level   = latest pullback LOWER HIGH  / HIGHER LOW   (close must break it)
 *   pullback ext. = lowest low / highest high reached in the pullback (frozen @ break)
 *   trigger       = new swing HIGH / LOW after the break (continuation entry)
 *   stop ref      = new HIGHER LOW / LOWER HIGH after the trigger (above/below ext.)
 */

const { detectFractals } = require('./swings');

function runEngine(h4cands, weekly, cfg) {
  const EXPIRY = cfg.expiryH4Bars;
  const pivots = detectFractals(h4cands, cfg.swing).filter((p) => !p.bothSide);

  const opportunities = [];
  const log = [];                         // per-bar state snapshot (for replay/UI)

  let st = reset(null);
  function reset(eligibilityStartMs) {
    return {
      state: eligibilityStartMs == null ? 'UNAVAILABLE' : 'WAITING_FOR_PULLBACK',
      eligibilityStartMs,
      windowStart: eligibilityStartMs,     // pivots used for a fresh pullback must start after this
      s: 0, dir: null,
      breakLevel: null, pullbackExtreme: null, pullbackHigh: null, pullbackLow: null,
      firstBreakMs: null, firstBreakIdx: null,
      trigger: null, triggerExtremeMs: null, stopRef: null, armedAtMs: null, armedBarIdx: null,
      cancelReason: null,
    };
  }

  const roleType = (s, which) => {
    if (which === 'break') return s > 0 ? 'HIGH' : 'LOW';
    if (which === 'extreme') return s > 0 ? 'LOW' : 'HIGH';
    if (which === 'trigger') return s > 0 ? 'HIGH' : 'LOW';
    if (which === 'stop') return s > 0 ? 'LOW' : 'HIGH';
  };
  const candleAdverse = (s, c) => (s > 0 ? c.low : c.high);     // breaches against the trend
  const fav = (s, a, b) => s * (a - b) > 0;                      // a further in trend dir than b

  for (let j = 0; j < h4cands.length; j++) {
    const c = h4cands[j];
    const closeMs = c.closeMs;
    const wk = weekly.biasAt(closeMs);
    const directional = wk.bias === 'BULLISH' || wk.bias === 'BEARISH';
    const s = wk.bias === 'BULLISH' ? 1 : wk.bias === 'BEARISH' ? -1 : 0;

    // ── (0) Weekly eligibility gate ────────────────────────────────────────────
    if (!directional) {
      if (['PULLBACK_ACTIVE', 'FIRST_BREAK', 'WAITING_FOR_RETEST_STRUCTURE', 'ARMED'].includes(st.state)) {
        st.state = 'CANCELLED'; st.cancelReason = 'weekly_eligibility_lost'; log.push(snap(st, c));
      } else { st.state = wk.bias; log.push(snap(st, c)); }   // NEUTRAL or UNAVAILABLE
      st = reset(null);
      continue;
    }
    if (wk.eligibilityStartMs !== st.eligibilityStartMs) {
      // A new (or first) eligibility episode: any in-flight setup is cancelled.
      if (['PULLBACK_ACTIVE', 'FIRST_BREAK', 'WAITING_FOR_RETEST_STRUCTURE', 'ARMED'].includes(st.state)) {
        st.state = 'CANCELLED'; st.cancelReason = 'weekly_eligibility_changed'; log.push(snap(st, c));
      }
      st = reset(wk.eligibilityStartMs); st.s = s; st.dir = s > 0 ? 'BUY' : 'SELL';
    }
    st.s = s; st.dir = s > 0 ? 'BUY' : 'SELL';

    // confirmed pivots knowable at this close, in the current attempt window
    const conf = pivots.filter((p) => p.confirmedAtMs <= closeMs && p.extremeTimeMs > st.windowStart);
    const highs = conf.filter((p) => p.type === 'HIGH').sort((a, b) => a.extremeTimeMs - b.extremeTimeMs);
    const lows = conf.filter((p) => p.type === 'LOW').sort((a, b) => a.extremeTimeMs - b.extremeTimeMs);

    // ── (1) Cancellation (priority over trigger) ───────────────────────────────
    if (['FIRST_BREAK', 'WAITING_FOR_RETEST_STRUCTURE', 'ARMED'].includes(st.state)) {
      if (st.pullbackExtreme != null && !fav(s, candleAdverse(s, c), st.pullbackExtreme)) {
        // candle breaches the frozen pullback extreme (equal or beyond, against trend)
        if (s * (candleAdverse(s, c) - st.pullbackExtreme) < 0) {
          st.state = 'CANCELLED'; st.cancelReason = 'pullback_extreme_breached'; log.push(snap(st, c));
          st = reset(wk.eligibilityStartMs); st.windowStart = closeMs;
          continue;
        }
      }
    }
    if (st.state === 'ARMED' && st.stopRef != null && s * (candleAdverse(s, c) - st.stopRef) < 0) {
      st.state = 'CANCELLED'; st.cancelReason = 'stop_reference_breached'; log.push(snap(st, c));
      st = reset(wk.eligibilityStartMs); st.windowStart = closeMs;
      continue;
    }

    // ── (2) Expiry: 30 completed H4 bars after FIRST_BREAK ─────────────────────
    if (['FIRST_BREAK', 'WAITING_FOR_RETEST_STRUCTURE', 'ARMED'].includes(st.state) && st.firstBreakIdx != null && (j - st.firstBreakIdx) >= EXPIRY) {
      st.state = 'EXPIRED'; log.push(snap(st, c));
      st = reset(wk.eligibilityStartMs); st.windowStart = closeMs;
      continue;
    }

    // ── (3) Progression ────────────────────────────────────────────────────────
    if (st.state === 'WAITING_FOR_PULLBACK') {
      // Two against-trend "descending" highs AND lows (pullback). Newest two of each.
      if (highs.length >= 2 && lows.length >= 2) {
        const h = highs.slice(-2), l = lows.slice(-2);
        const descH = s * (h[1].price - h[0].price) < 0;   // newer high adverse vs older
        const descL = s * (l[1].price - l[0].price) < 0;
        if (descH && descL) {
          st.state = 'PULLBACK_ACTIVE';
          st.breakLevel = (roleType(s, 'break') === 'HIGH' ? h : l)[1].price;  // latest LH (buy) / HL (sell)
          // init pullback extreme = running adverse extreme since the pullback's first pivot
          const startMs = Math.min(h[0].extremeTimeMs, l[0].extremeTimeMs);
          st.pullbackStartMs = startMs;
          st.pullbackExtreme = extremeSince(h4cands, startMs, closeMs, s);
        }
      }
    }
    if (st.state === 'PULLBACK_ACTIVE') {
      // keep extending the pullback extreme with this completed candle (O(1))
      const v = candleAdverse(s, c);
      if (st.pullbackExtreme == null || s * (v - st.pullbackExtreme) < 0) st.pullbackExtreme = v;
      if (fav(s, c.close, st.breakLevel)) {               // completed close breaks the level
        st.state = 'FIRST_BREAK'; st.firstBreakMs = closeMs; st.firstBreakIdx = j;
        // freeze the pullback extreme at the break
      }
    }
    if (st.state === 'FIRST_BREAK' || st.state === 'WAITING_FOR_RETEST_STRUCTURE') {
      st.state = 'WAITING_FOR_RETEST_STRUCTURE';
      // trigger = first new swing of triggerType with extreme after FIRST_BREAK
      const tType = roleType(s, 'trigger'), stopType = roleType(s, 'stop');
      const trig = conf.filter((p) => p.type === tType && p.extremeTimeMs > st.firstBreakMs).sort((a, b) => a.extremeTimeMs - b.extremeTimeMs)[0];
      if (trig) {
        st.trigger = trig.price; st.triggerExtremeMs = trig.extremeTimeMs; st.triggerConfirmedMs = trig.confirmedAtMs;
        // stop = first swing of stopType after the trigger's extreme, beyond the pullback extreme
        const stopPiv = conf.filter((p) => p.type === stopType && p.extremeTimeMs > trig.extremeTimeMs && fav(s, p.price, st.pullbackExtreme)).sort((a, b) => a.extremeTimeMs - b.extremeTimeMs)[0];
        if (stopPiv) {
          st.stopRef = stopPiv.price; st.armedAtMs = stopPiv.confirmedAtMs; st.armedBarIdx = j;
          st.state = 'ARMED';
        }
      }
    }
    if (st.state === 'ARMED') {
      // subsequent close beyond the trigger, strictly AFTER the stop confirmed (no backdating)
      if (j > st.armedBarIdx && fav(s, c.close, st.trigger)) {
        const entryBar = h4cands[j + 1] || null;         // entry = next available H4 open
        const opp = {
          pair: cfg.pair || null, dir: st.dir, strategyId: cfg.strategyId, version: cfg.version,
          signalCloseMs: closeMs, signalBarIdx: j,
          eligibilityStartMs: st.eligibilityStartMs,
          breakLevel: st.breakLevel, pullbackExtreme: st.pullbackExtreme, firstBreakMs: st.firstBreakMs,
          trigger: st.trigger, stopRef: st.stopRef, armedAtMs: st.armedAtMs,
          entryBarIdx: entryBar ? j + 1 : null,
          entryOpenMs: entryBar ? entryBar.openMs : null,
          entryPrice: entryBar ? entryBar.open : null,    // mid open; costs applied in the sim
          pendingEntry: !entryBar,
        };
        opportunities.push(opp);
        st.state = 'TRIGGERED'; log.push(snap(st, c));
        // one opportunity per episode → require a fresh sequence within the same eligibility
        st = reset(wk.eligibilityStartMs); st.windowStart = closeMs; st.s = s; st.dir = s > 0 ? 'BUY' : 'SELL';
        continue;
      }
    }
    log.push(snap(st, c));
  }

  return { pivots, opportunities, log, finalState: st };
}

/** Running adverse extreme (min low for buy, max high for sell) over completed candles in (startMs, closeMs]. */
function extremeSince(cands, startMs, closeMs, s) {
  let ext = null;
  for (const c of cands) {
    if (c.openMs < startMs || c.closeMs > closeMs) continue;
    const v = s > 0 ? c.low : c.high;
    if (ext == null) ext = v;
    else if (s > 0 ? v < ext : v > ext) ext = v;
  }
  return ext;
}

function snap(st, c) {
  return {
    closeMs: c.closeMs, state: st.state, dir: st.dir,
    breakLevel: st.breakLevel, pullbackExtreme: st.pullbackExtreme,
    firstBreakMs: st.firstBreakMs, trigger: st.trigger, stopRef: st.stopRef,
    armedAtMs: st.armedAtMs, cancelReason: st.cancelReason, eligibilityStartMs: st.eligibilityStartMs,
  };
}
module.exports = { runEngine, extremeSince };
