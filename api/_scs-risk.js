'use strict';

/**
 * SCS — Section 7a: risk controls (pure, paper/forward-test only).
 *
 * Position sizing is expressed in risk % (no live order routing). Enforces max
 * simultaneous positions, max combined open risk, correlated same-currency-
 * direction exposure, abnormal spread, and a pluggable high-impact-news filter.
 * With no news provider the filter is unavailable (NEWS_FILTER_UNAVAILABLE) and
 * never fabricates news — it reports the gap and does not block.
 */

const { REJECTION, CONFIG } = require('./_scs-config');

/** News-filter abstraction. `provider.check(pair, ms) → {blocked:boolean}`. */
function makeNewsFilter(provider) {
  return {
    available: !!provider,
    check(pair, ms) {
      if (!provider) return { blocked: false, available: false, reason: REJECTION.NEWS_FILTER_UNAVAILABLE };
      const r = provider.check(pair, ms) || {};
      return { blocked: !!r.blocked, available: true, reason: r.blocked ? REJECTION.HIGH_IMPACT_NEWS : REJECTION.NONE };
    },
  };
}

/** Signed currency exposure of a trade (BUY EUR_USD ⇒ EUR +, USD −). */
function currencyExposure(pair, direction) {
  const [b, q] = pair.split('_');
  const s = direction === 'BUY' ? 1 : -1;
  return [{ ccy: b, sign: s }, { ccy: q, sign: -s }];
}
/** Correlated = shares any (currency, same direction) with an open position. */
function isCorrelated(pair, direction, openPositions) {
  const exp = currencyExposure(pair, direction);
  for (const p of openPositions || []) {
    for (const oe of currencyExposure(p.pair, p.direction)) {
      for (const e of exp) if (e.ccy === oe.ccy && e.sign === oe.sign) return true;
    }
  }
  return false;
}
function spreadOk(spread, normalSpread, cfg = CONFIG) {
  if (!(normalSpread > 0) || !(spread > 0)) return true;   // unknown spread → not rejected here
  return spread <= cfg.spreadWideMult * normalSpread;
}
function positionSizePct(requested, cfg = CONFIG) {
  const r = requested != null ? requested : cfg.riskDefaultPct;
  return Math.max(0, Math.min(r, cfg.riskMaxPct));
}

/** Admit a fresh candidate. ctx: {pair, direction, openPositions, spread, normalSpread, riskPct, newsFilter, ms}. */
function admit(candidate, ctx, cfg = CONFIG) {
  const reject = (rejection, extra) => ({ admit: false, rejection, ...(extra || {}) });
  const nf = ctx.newsFilter || makeNewsFilter(null);
  const news = nf.check(ctx.pair, ctx.ms);
  if (news.blocked) return reject(REJECTION.HIGH_IMPACT_NEWS, { news });

  const open = ctx.openPositions || [];
  if (open.length >= cfg.maxOpenPositions) return reject(REJECTION.MAX_POSITIONS);

  const riskPct = positionSizePct(ctx.riskPct, cfg);
  const combined = open.reduce((s, p) => s + (p.riskPct || 0), 0) + riskPct;
  if (combined > cfg.maxCombinedOpenRiskPct + 1e-9) return reject(REJECTION.MAX_OPEN_RISK);

  if (isCorrelated(ctx.pair, candidate.direction, open)) return reject(REJECTION.CORRELATED_EXPOSURE);
  if (!spreadOk(ctx.spread, ctx.normalSpread, cfg)) return reject(REJECTION.SPREAD_TOO_WIDE);

  return { admit: true, rejection: REJECTION.NONE, riskPct, combinedRiskPct: combined, newsAvailable: news.available !== false, newsUnavailable: news.available === false };
}

module.exports = { makeNewsFilter, currencyExposure, isCorrelated, spreadOk, positionSizePct, admit };
