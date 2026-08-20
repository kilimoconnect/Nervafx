'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { evaluateSessionSetup } = require('../../api/_h1cs-state');
const S = require('../../api/_h1cs-session');
const { sanitizeH1 } = require('../../api/_h1c-data');
const { zonedWallToUtcMs } = require('../../api/_h1c-time');
const { STATES, FAILURE_STATUS, PHASE, PAUSE_TYPE, MODE, INVALIDATION, REJECTIONS } = require('../../api/_h1cs-constants');

const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const cndl = (ms, o, h, l, c) => ({ ms, time: iso(ms), open: o, high: h, low: l, close: c });

const SESS_DATE = '2026-08-13'; // Thursday
const SS = S.sessionWindowUtc(SESS_DATE).startUtc; // 17:00 EAT = 14:00 UTC

function base(count) {
  const start = SS - count * H;
  const a = [];
  for (let i = 0; i < count; i++) a.push(cndl(start + i * H, 1.09990, 1.10040, 1.09940, 1.09990));
  return a;
}
const BUY_SESSION = [
  cndl(SS + 0 * H, 1.10000, 1.10120, 1.09990, 1.10100),
  cndl(SS + 1 * H, 1.10100, 1.10220, 1.10090, 1.10200),
  cndl(SS + 2 * H, 1.10200, 1.10320, 1.10190, 1.10300),
  cndl(SS + 3 * H, 1.10300, 1.10420, 1.10290, 1.10400),
  cndl(SS + 4 * H, 1.10400, 1.10520, 1.10390, 1.10500),
  cndl(SS + 5 * H, 1.10500, 1.10620, 1.10490, 1.10600),
]; // refOpen 1.10000, refHigh 1.10620, refLow 1.09990, refClose 1.10600
const SELL_SESSION = [
  cndl(SS + 0 * H, 1.10600, 1.10610, 1.10480, 1.10500),
  cndl(SS + 1 * H, 1.10500, 1.10510, 1.10380, 1.10400),
  cndl(SS + 2 * H, 1.10400, 1.10410, 1.10280, 1.10300),
  cndl(SS + 3 * H, 1.10300, 1.10310, 1.10180, 1.10200),
  cndl(SS + 4 * H, 1.10200, 1.10210, 1.10080, 1.10100),
  cndl(SS + 5 * H, 1.10100, 1.10110, 1.09980, 1.10000),
];
function build(session, post) { return base(25).concat(session).concat(post); }
const evalAfter = (post) => SS + 6 * H + post.length * H;

// golden BUY post: pullback → failure(01:00) → second push(02:00–03:00) → high break later
const GOLDEN_POST = [
  cndl(SS + 6 * H, 1.10600, 1.10610, 1.10520, 1.10540),  // 23:00 EAT pullback 1
  cndl(SS + 7 * H, 1.10540, 1.10550, 1.10500, 1.10520),  // 00:00 EAT pullback 2
  cndl(SS + 8 * H, 1.10520, 1.10560, 1.10505, 1.10555),  // 01:00 EAT failure → READY
  cndl(SS + 9 * H, 1.10555, 1.10615, 1.10550, 1.10600),  // 02:00–03:00 EAT second push STARTED
  cndl(SS + 10 * H, 1.10600, 1.10700, 1.10595, 1.10680), // 03:00 EAT breaks refHigh → CONFIRMED
];

// ── reference-session extraction & conversion (1,2,3) ───────────────────────
test('extracts the six 17:00–23:00 EAT candles and qualifies a BUY reference', () => {
  const r = evaluateSessionSetup(build(BUY_SESSION, GOLDEN_POST), { evalMs: evalAfter(GOLDEN_POST), instrument: 'EUR_USD' });
  assert.equal(r.reference.date, SESS_DATE);
  assert.equal(r.direction, 'BUY');
  assert.equal(r.reference.directionalCandleCount, 6);
  assert.ok(r.reference.sessionMoveATR >= 1.0 && r.reference.sessionEfficiency >= 0.6 && r.reference.sessionCloseQuality >= 0.7);
});
test('17:00 EAT converts to 14:00 UTC (fixed, no US DST)', () => {
  assert.equal(zonedWallToUtcMs(2026, 8, 13, 17, 0, 'Africa/Dar_es_Salaam'), Date.UTC(2026, 7, 13, 14, 0, 0));
  assert.equal(S.sessionWindowUtc('2026-08-13').endUtc, Date.UTC(2026, 7, 13, 20, 0, 0)); // 23:00 EAT
});
test('qualifies a SELL reference symmetrically', () => {
  const r = evaluateSessionSetup(build(SELL_SESSION, []), { evalMs: SS + 6 * H, instrument: 'EUR_USD' });
  assert.equal(r.direction, 'SELL');
  assert.ok(r.reference.sessionMoveATR >= 1.0);
});

// ── rejections (5,6,25) ─────────────────────────────────────────────────────
test('rejects weak session movement (diagnostics returned)', () => {
  const weak = [
    cndl(SS + 0 * H, 1.10000, 1.10020, 1.09990, 1.10005), cndl(SS + 1 * H, 1.10005, 1.10015, 1.09995, 1.10000),
    cndl(SS + 2 * H, 1.10000, 1.10010, 1.09990, 1.10002), cndl(SS + 3 * H, 1.10002, 1.10012, 1.09992, 1.09998),
    cndl(SS + 4 * H, 1.09998, 1.10010, 1.09990, 1.10003), cndl(SS + 5 * H, 1.10003, 1.10012, 1.09993, 1.10004),
  ];
  const r = evaluateSessionSetup(build(weak, []), { evalMs: SS + 6 * H });
  assert.equal(r.state, STATES.SEARCHING_REFERENCE_SESSION);
  assert.ok(r.reasonCodes.includes('MOVE_ATR') || r.reasonCodes.includes('CLOSE_QUALITY') || r.reasonCodes.includes('DIRECTIONAL_CANDLES'));
});
test('rejects a missing reference candle', () => {
  const missing = BUY_SESSION.filter((c) => c.ms !== SS + 3 * H); // drop the 20:00 EAT candle
  const r = evaluateSessionSetup(build(missing, []), { evalMs: SS + 6 * H });
  assert.equal(r.reasonCodes[0], REJECTIONS.MISSING_CANDLES);
});
test('rejects a Friday reference session (no next-day continuation)', () => {
  const FRI = '2026-08-14'; // Friday
  const fss = S.sessionWindowUtc(FRI).startUtc;
  const shift = fss - SS;
  const friBase = base(25).map((c) => Object.assign({}, c, { ms: c.ms + shift, time: iso(c.ms + shift) }));
  const friSess = BUY_SESSION.map((c) => Object.assign({}, c, { ms: c.ms + shift, time: iso(c.ms + shift) }));
  const r = evaluateSessionSetup(friBase.concat(friSess), { evalMs: fss + 6 * H });
  assert.ok(r.reasonCodes.includes(REJECTIONS.FRIDAY_NO_CONTINUATION));
});

// ── pause / pullback classification (7,8,9,10) ──────────────────────────────
function firstTwo(post) { return evaluateSessionSetup(build(BUY_SESSION, post), { evalMs: evalAfter(post) }); }
test('PAUSE below 20% retracement', () => {
  const r = firstTwo([cndl(SS + 6 * H, 1.10600, 1.10610, 1.10540, 1.10560), cndl(SS + 7 * H, 1.10560, 1.10570, 1.10520, 1.10540)]);
  assert.equal(r.pausePullbackType, PAUSE_TYPE.PAUSE);
});
test('CONTROLLED_PULLBACK 20–60% retracement', () => {
  const r = firstTwo([cndl(SS + 6 * H, 1.10600, 1.10610, 1.10450, 1.10480), cndl(SS + 7 * H, 1.10480, 1.10490, 1.10400, 1.10420)]);
  assert.equal(r.pausePullbackType, PAUSE_TYPE.CONTROLLED_PULLBACK);
  assert.equal(r.state, STATES.POST_SESSION_PULLBACK);
});
test('DEEP_PULLBACK above 60% is not eligible (INVALIDATED)', () => {
  const r = firstTwo([cndl(SS + 6 * H, 1.10600, 1.10610, 1.10300, 1.10350), cndl(SS + 7 * H, 1.10350, 1.10360, 1.10200, 1.10250)]);
  assert.equal(r.pausePullbackType, PAUSE_TYPE.DEEP_PULLBACK);
  assert.equal(r.state, STATES.INVALIDATED);
  assert.equal(r.invalidationCode, INVALIDATION.DEEP_PULLBACK);
});
test('structural invalidation on a close beyond the reference origin', () => {
  const r = firstTwo([cndl(SS + 6 * H, 1.10600, 1.10610, 1.10400, 1.10450), cndl(SS + 7 * H, 1.10450, 1.10460, 1.09950, 1.09980)]);
  assert.equal(r.state, STATES.INVALIDATED);
  assert.equal(r.invalidationCode, INVALIDATION.STRUCTURE_BREAK);
});

// ── second push (11,12,13,14,16,17,18,22,23) ────────────────────────────────
test('second push after only two completed post-session candles (same evaluation)', () => {
  const post = [
    cndl(SS + 6 * H, 1.10600, 1.10545, 1.10520, 1.10530),
    cndl(SS + 7 * H, 1.10530, 1.10545, 1.10515, 1.10540),  // failure confirms (pair p0,p1) → READY
    cndl(SS + 8 * H, 1.10535, 1.10580, 1.10530, 1.10575),  // 3rd candle breaks frozen level → STARTED
  ];
  const r = evaluateSessionSetup(build(BUY_SESSION, post), { evalMs: evalAfter(post) });
  assert.equal(r.state, STATES.SECOND_PUSH_STARTED);           // no stored FAILURE_CONFIRMED needed
  assert.equal(r.failureStatus, FAILURE_STATUS.CONFIRMED);
});
test('golden: failure inside pullback, push at 02:00–03:00, confirmed available at 03:00, no high break yet', () => {
  const partial = GOLDEN_POST.slice(0, 4); // through the 02:00–03:00 push candle
  const r = evaluateSessionSetup(build(BUY_SESSION, partial), { evalMs: evalAfter(partial) });
  assert.equal(r.state, STATES.SECOND_PUSH_STARTED);
  assert.equal(r.secondPushStartedAt, iso(SS + 9 * H));       // 02:00–03:00 EAT candle
  assert.equal(r.secondPushStartPhase, PHASE.ASIA);
  assert.equal(r.continuationConfirmedAt, null);              // reference high NOT yet broken
});
test('later confirmation once the reference-session high breaks; Asia→Asia', () => {
  const r = evaluateSessionSetup(build(BUY_SESSION, GOLDEN_POST), { evalMs: evalAfter(GOLDEN_POST) });
  assert.equal(r.state, STATES.SESSION_CONTINUATION_CONFIRMED);
  assert.equal(r.secondPushStartPhase, PHASE.ASIA);
  assert.equal(r.confirmationPhase, PHASE.ASIA);
  assert.ok(r.postSessionCandleCount < 6);                    // no 6-candle minimum needed
});

// ── phase combinations (19,20,21) ───────────────────────────────────────────
test('ASIA start → LONDON confirmation', () => {
  const post = GOLDEN_POST.slice(0, 4).concat([ // push in Asia (p3), hold, then break high in London
    cndl(SS + 11 * H, 1.10600, 1.10610, 1.10560, 1.10590),
    cndl(SS + 17 * H, 1.10590, 1.10700, 1.10580, 1.10680),   // 07:00 UTC 14 Aug = London → high break
  ]);
  const r = evaluateSessionSetup(build(BUY_SESSION, post), { evalMs: SS + 18 * H });
  assert.equal(r.secondPushStartPhase, PHASE.ASIA);
  assert.equal(r.confirmationPhase, PHASE.LONDON);
});
test('LONDON start → LONDON confirmation', () => {
  // pause through Asia (no push), failure+push during London
  const post = [
    cndl(SS + 6 * H, 1.10600, 1.10610, 1.10540, 1.10560),
    cndl(SS + 12 * H, 1.10560, 1.10570, 1.10520, 1.10540),
    cndl(SS + 16 * H, 1.10540, 1.10560, 1.10515, 1.10555),   // failure (London)
    cndl(SS + 17 * H, 1.10555, 1.10615, 1.10550, 1.10605),   // push (London)
    cndl(SS + 18 * H, 1.10605, 1.10700, 1.10600, 1.10680),   // high break (London)
  ];
  const r = evaluateSessionSetup(build(BUY_SESSION, post), { evalMs: SS + 19 * H });
  assert.equal(r.secondPushStartPhase, PHASE.LONDON);
  assert.equal(r.confirmationPhase, PHASE.LONDON);
});

// ── no window/expiry rules (14,15,24) ───────────────────────────────────────
test('no automatic 12-candle expiry — a long pause stays active', () => {
  const post = [];
  for (let i = 0; i < 14; i++) post.push(cndl(SS + (6 + i) * H, 1.10580, 1.10600, 1.10540, 1.10560)); // 14 pause candles
  const r = evaluateSessionSetup(build(BUY_SESSION, post), { evalMs: SS + (6 + 14) * H });
  assert.notEqual(r.state, STATES.EXPIRED);
  assert.ok([STATES.POST_SESSION_PAUSE, STATES.POST_SESSION_PULLBACK, STATES.SECOND_PUSH_READY].includes(r.state));
});
test('setup expires at 17:00 EAT the following day (a new session then forms)', () => {
  const r = evaluateSessionSetup(build(BUY_SESSION, GOLDEN_POST), { evalMs: evalAfter(GOLDEN_POST) });
  assert.equal(r.expiresAt, iso(SS + 24 * H)); // 17:00 EAT next day
  // at 18:00 EAT next day a new session is forming → old setup no longer active
  const later = evaluateSessionSetup(build(BUY_SESSION, GOLDEN_POST), { evalMs: SS + 25 * H });
  assert.equal(later.state, STATES.SEARCHING_REFERENCE_SESSION);
});

// ── closed-candle / no-lookahead (26,27) & determinism ──────────────────────
test('no candle after evalMs influences the result (closed-candle enforcement)', () => {
  const partial = GOLDEN_POST.slice(0, 4);
  const withFuture = build(BUY_SESSION, GOLDEN_POST); // includes the later high-break candle
  const evalMs = evalAfter(partial); // before the high break closes
  const a = evaluateSessionSetup(build(BUY_SESSION, partial), { evalMs });
  const b = evaluateSessionSetup(withFuture, { evalMs });        // future candle present but must be ignored
  assert.equal(a.state, b.state);
  assert.equal(b.state, STATES.SECOND_PUSH_STARTED);
  assert.equal(b.continuationConfirmedAt, null);
});
test('sanitizeH1 excludes the forming candle for a session evaluation', () => {
  const rows = build(BUY_SESSION, GOLDEN_POST).map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
  const evalMs = SS + 9 * H; // 02:00 EAT: the 02:00–03:00 candle (open SS+9H) is still forming
  const san = sanitizeH1(rows, evalMs, { minCandles: 20 });
  assert.ok(!san.candles.some((c) => c.ms === SS + 9 * H)); // forming candle excluded
});
test('deterministic: identical inputs give an identical result', () => {
  const args = [build(BUY_SESSION, GOLDEN_POST), { evalMs: evalAfter(GOLDEN_POST), instrument: 'EUR_USD' }];
  assert.deepEqual(evaluateSessionSetup(args[0], args[1]), evaluateSessionSetup(args[0], args[1]));
});

// ── isolation (28,29) ───────────────────────────────────────────────────────
test('session setup id is mode-prefixed and cannot collide with generic ids', () => {
  const r = evaluateSessionSetup(build(BUY_SESSION, GOLDEN_POST), { evalMs: evalAfter(GOLDEN_POST), instrument: 'EUR_USD' });
  assert.ok(r.setupId.startsWith(MODE + ':'));            // session_h1_continuation:EUR_USD:BUY:<end>
  assert.equal(r.mode, MODE);
  assert.ok(!/^EUR_USD:BUY:/.test(r.setupId));            // not the generic id shape
});
