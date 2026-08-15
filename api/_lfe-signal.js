'use strict';

/**
 * NervaFX Liquidity Failure Engine — EMA context, scoring, risk & correlation.
 *
 * EMA and currency strength are CLASSIFICATION/confidence only — they never gate
 * or replace the mandatory H1 failure + M15 confirmation. Nothing here places a
 * broker order; risk numbers are analytical.
 */

const {
  M15_MS, CONFIG, MSS_STATUS, SIGNAL_CLASS, SIGNAL_GRADE, DIRECTION,
} = require('./_lfe-constants');
const { clamp } = require('./_lfe-math');

// ── D. EMA context (classification, never a trigger) ────────────────────────
function classifyEma(direction, ema20, ema50, failureClose) {
  const aligned = (direction === DIRECTION.BUY && ema20 > ema50)
    || (direction === DIRECTION.SELL && ema20 < ema50);
  let throughEma20 = false;
  if (!aligned && failureClose != null && ema20 != null) {
    throughEma20 = direction === DIRECTION.SELL ? failureClose < ema20 : failureClose > ema20;
  }
  return { classification: aligned ? SIGNAL_CLASS.TREND_ALIGNED : SIGNAL_CLASS.COUNTERTREND, throughEma20 };
}

// ── E. Currency rotation (confidence only) ──────────────────────────────────
function rotationScore(direction, rotation, cfg) {
  cfg = cfg || CONFIG;
  if (!rotation || rotation.baseDelta == null || rotation.quoteDelta == null) return { pairRotation: null, score: 0 };
  const pairRotation = rotation.baseDelta - rotation.quoteDelta;
  const favourable = direction === DIRECTION.BUY ? pairRotation > 0 : pairRotation < 0;
  const score = favourable ? clamp(Math.abs(pairRotation) / cfg.score.rotationScale, 0, 1) : 0;
  return { pairRotation, score };
}

// ── F. Score ────────────────────────────────────────────────────────────────
function scoreComponents(event, confirmation, emaInfo, rotation, ctx, cfg) {
  cfg = cfg || CONFIG;
  const w = cfg.score.weights;
  const level = w.level * clamp((event.levelScore || 0) / 15, 0, 1);
  const attack = w.attack; // mandatory gate already satisfied by the event's existence
  const failure = 0.6 * w.failure + 0.4 * w.failure * clamp((event.qualityPoints || 0) / 14, 0, 1);
  const m15 = confirmation && confirmation.status === MSS_STATUS.CONFIRMED ? w.m15 : 0;
  const ema = emaInfo.classification === SIGNAL_CLASS.TREND_ALIGNED
    ? w.ema
    : 4 + (emaInfo.throughEma20 ? 6 : 0);
  const rot = w.rotation * (rotation ? rotation.score : 0);
  const context = ctx && ctx.contextPoints != null ? ctx.contextPoints : 0;
  const total = level + attack + failure + m15 + ema + rot + context;
  return { level, attack, failure, m15, ema, rotation: rot, context, total: Math.round(total * 100) / 100 };
}

function gradeOf(total, classification, cfg) {
  cfg = cfg || CONFIG;
  if (classification === SIGNAL_CLASS.COUNTERTREND && total < cfg.signal.counterTrendThreshold) {
    return SIGNAL_GRADE.REJECTED;
  }
  if (total >= cfg.score.aplus) return SIGNAL_GRADE.APLUS;
  if (total >= cfg.score.confirmed) return SIGNAL_GRADE.CONFIRMED;
  if (total >= cfg.score.watch) return SIGNAL_GRADE.WATCH;
  return SIGNAL_GRADE.REJECTED;
}

// ── G. Risk calculation (analytical only) ───────────────────────────────────
function computeRisk(event, confirmation, ctx, cfg) {
  cfg = cfg || CONFIG;
  ctx = ctx || {};
  const spread = ctx.spread || 0;
  const H1ATR = event.h1Atr;
  const isSell = event.direction === DIRECTION.SELL;
  const entry = ctx.nextOpen != null ? ctx.nextOpen : (confirmation ? confirmation.confirmClose : null);
  if (entry == null) return { ok: false, reason: 'NO_ENTRY' };

  const pad = Math.max(cfg.risk.stopAtr * H1ATR, 2 * spread);
  const stop = isSell ? event.sweepExtreme + pad : event.sweepExtreme - pad;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return { ok: false, reason: 'ZERO_RISK' };

  const defaultTarget = isSell ? entry - cfg.targets.defaultR * risk : entry + cfg.targets.defaultR * risk;
  let target = defaultTarget;
  const opp = ctx.opposingLevel;
  if (opp != null) {
    const oppDist = isSell ? entry - opp : opp - entry;
    if (oppDist > 0) target = isSell ? Math.max(defaultTarget, opp) : Math.min(defaultTarget, opp); // cap at nearer opposing level
  }
  const rewardDist = Math.abs(entry - target);
  const rewardR = rewardDist / risk;
  const rewardOK = rewardR >= cfg.targets.minRewardR;

  let late = false;
  if (ctx.currentPrice != null) {
    const moved = isSell ? entry - ctx.currentPrice : ctx.currentPrice - entry;
    late = moved > cfg.risk.lateR * risk;
  }
  let entryExpired = false;
  if (ctx.evalMs != null && confirmation && confirmation.confirmAtMs != null) {
    entryExpired = ctx.evalMs > confirmation.confirmAtMs + cfg.risk.entryExpiryCandles * M15_MS;
  }

  return {
    ok: true, entry, stop, target, risk, rewardR: Math.round(rewardR * 100) / 100,
    rewardOK, late, entryExpired,
  };
}

// ── Signal assembly ─────────────────────────────────────────────────────────
function buildSignal(event, confirmation, ctx, cfg) {
  cfg = cfg || CONFIG;
  ctx = ctx || {};
  const emaInfo = classifyEma(event.direction, ctx.ema20, ctx.ema50, ctx.failureClose);
  const rot = rotationScore(event.direction, ctx.rotation, cfg);

  // Mandatory gates: a signal requires M15 confirmation. Otherwise the H1 event
  // stays visible as unconfirmed with no trade signal.
  if (!confirmation || confirmation.status !== MSS_STATUS.CONFIRMED) {
    return {
      isSignal: false,
      reason: confirmation ? confirmation.status : MSS_STATUS.UNCONFIRMED,
      eventKey: event.eventKey,
      pair: event.pair,
      direction: event.direction,
      classification: emaInfo.classification,
    };
  }

  const score = scoreComponents(event, confirmation, emaInfo, rot, ctx, cfg);
  const grade = gradeOf(score.total, emaInfo.classification, cfg);
  const risk = computeRisk(event, confirmation, ctx, cfg);
  const tradable = (grade === SIGNAL_GRADE.APLUS || grade === SIGNAL_GRADE.CONFIRMED) && risk.ok && risk.rewardOK;

  return {
    isSignal: tradable,
    eventKey: event.eventKey,
    signalKey: event.eventKey,
    pair: event.pair,
    direction: event.direction,
    failedSide: event.failedSide,
    setupType: event.setupType,
    classification: emaInfo.classification,
    throughEma20: emaInfo.throughEma20,
    pairRotation: rot.pairRotation,
    score,
    grade,
    risk,
    breakLevel: confirmation.breakLevel,
    confirmAtMs: confirmation.confirmAtMs,
    rejectReason: !risk.ok ? risk.reason : (!risk.rewardOK ? 'INSUFFICIENT_REWARD' : (!tradable ? grade : null)),
  };
}

// ── H. Correlation filter ───────────────────────────────────────────────────
function exposureTokens(pair, direction) {
  const [base, quote] = String(pair).split('_');
  const long = direction === DIRECTION.BUY;
  return [`${base}${long ? '+' : '-'}`, `${quote}${long ? '-' : '+'}`];
}

/**
 * Group signals that express substantially the same currency position (share a
 * signed currency exposure), rank each group by score, mark the top as preferred
 * and the rest correlated. Nothing is deleted.
 */
function applyCorrelationFilter(signals) {
  const parent = signals.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };

  const tokenOwner = new Map();
  signals.forEach((s, i) => {
    for (const tok of exposureTokens(s.pair, s.direction)) {
      if (tokenOwner.has(tok)) union(i, tokenOwner.get(tok));
      else tokenOwner.set(tok, i);
    }
  });

  const groups = new Map();
  signals.forEach((_, i) => {
    const g = find(i);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  });

  const out = signals.map((s) => Object.assign({}, s, { preferred: false, correlated: false, correlationGroup: null }));
  let gid = 0;
  for (const members of groups.values()) {
    const groupId = `corr-${gid++}`;
    let best = members[0];
    for (const i of members) {
      const a = out[i].score ? out[i].score.total : -Infinity;
      const b = out[best].score ? out[best].score.total : -Infinity;
      if (a > b) best = i;
    }
    for (const i of members) {
      out[i].correlationGroup = members.length > 1 ? groupId : null;
      out[i].preferred = i === best;
      out[i].correlated = members.length > 1 && i !== best;
    }
  }
  return out;
}

module.exports = {
  classifyEma, rotationScore, scoreComponents, gradeOf, computeRisk, buildSignal,
  exposureTokens, applyCorrelationFilter,
};
