# Stage C — interpretable M15 state classifier (pure, explained)

`research/m15/classifier.js` composes the single-pair price-action descriptor (Stage A)
with the independent currency-strength network (Stage B) into an **explained** state
label for one pair, as-of a synchronized M15 close `t`. **No entry/exit rules; no
unexplained weighted score** — every label comes from a transparent rule ladder over
named evidence codes, with the raw evidence emitted alongside. Isolated from `api/_m15`.
**Version:** `m15-classifier-1.0.0`.

## Window roles — overlapping windows are NOT four independent votes
| Window | Role | Used for |
|---|---|---|
| 48h + 36h | **established context** (counted together as ONE backdrop fact) | is there a persistent directional backdrop? |
| 24h | **transition** | is a move underway? (enter/exit hysteresis band) |
| latest-12h vs preceding-12h | **present behaviour** | momentum, acceleration/deceleration |

Agreement across these overlapping windows is treated as evidence of **persistence**, not
as independent samples. The **only genuinely independent confirmation** is the currency
network's leave-one-pair-out test (the other 27 pairs, with this pair excluded).

## States
`BALANCED_RANGE`, `EMERGING_MOVE_UP/DOWN`, `ACCEPTED_TREND_UP/DOWN`,
`ACCELERATING_TREND_UP/DOWN`, `EXHAUSTION_RISK_UP/DOWN`, `REVERSAL_UP/DOWN`, `CONFLICT`,
`UNAVAILABLE`.
- A **strong single candle** (one bar ≥ 60% of the 12h close-path) can only trigger a
  provisional **EMERGING** state — never accepted.
- **ACCEPTED_TREND** requires all three: (1) sustained net progress (48h+36h context and
  24h transition agree, not single-candle), (2) a defensible holding/structure event
  (accepted balance departure or a confirmed swing in direction), (3) **broad independent
  currency confirmation** (strength gap same direction, LOPO-confirmed, leading-currency
  breadth ≥ 0.60).
- **CONFLICT** fires when price direction and the independently-confirmed strength
  direction disagree.
- **EXHAUSTION_RISK** is a risk description layered on an accepted trend (keeps the trend's
  UP/DOWN); it is **not** an automatic countertrend signal.

## Rule ladder (first match wins)
```
UNAVAILABLE   ← price-action NO_DATA / INSUFFICIENT_DATA
CONFLICT      ← pDir and sDir opposite AND strength independently confirmed
REVERSAL_x    ← confirmed pivot opposing established context + present momentum that way
ACCELERATING  ← accepted gate met AND present |eff| rising (> accelMargin)
EXHAUSTION    ← accepted gate met AND present |eff| falling (< −decelMargin) / counter-move
ACCEPTED      ← accepted gate met (sustained + hold + broad independent strength)
EMERGING_x    ← a move is underway but the accepted gate is not (yet) met
BALANCED_RANGE← no directional transition
```
`pDir` = transition (24h) direction, else present (12h). `sDir` = sign of base−quote gap
when `|gap| ≥ gapMin`.

## State-transition table
| From \ Trigger | sustained+hold+broad-strength | move underway, gate unmet | pivot vs context | price⊥confirmed-strength | momentum rising | momentum fading | no transition |
|---|---|---|---|---|---|---|---|
| **BALANCED_RANGE** | ACCEPTED_TREND | EMERGING_MOVE | REVERSAL | CONFLICT | — | — | BALANCED_RANGE |
| **EMERGING_MOVE_x** | ACCEPTED_TREND (kind=ACCEPTANCE) | EMERGING_MOVE | REVERSAL | CONFLICT | — | — | BALANCED or EMERGING (hysteresis) |
| **ACCEPTED_TREND_x** | ACCEPTED_TREND | EMERGING (kind=BREAKDOWN) | REVERSAL | CONFLICT | ACCELERATING | EXHAUSTION_RISK | ACCEPTED_TREND |
| **ACCELERATING_x** | ACCEPTED/ACCELERATING | EMERGING (BREAKDOWN) | REVERSAL | CONFLICT | ACCELERATING | EXHAUSTION_RISK | ACCEPTED_TREND |
| **EXHAUSTION_RISK_x** | ACCEPTED_TREND | EMERGING (BREAKDOWN) | REVERSAL | CONFLICT | ACCELERATING | EXHAUSTION_RISK | ACCEPTED_TREND |
| **REVERSAL_x** | ACCEPTED_TREND (new dir) | EMERGING (new dir) | REVERSAL | CONFLICT | — | — | BALANCED or EMERGING |
| **CONFLICT** | ACCEPTED (once price & strength realign) | EMERGING | REVERSAL | CONFLICT | — | — | BALANCED |
| **UNAVAILABLE** | — | EMERGING (once data sufficient) | — | — | — | — | BALANCED / UNAVAILABLE |

**Transition `kind`**: `ACCEPTANCE`, `EXHAUSTION_ONSET`, `REVERSAL`, `CONFLICT_ONSET`,
`BREAKDOWN`, `CHANGE`, `NONE`.

## Hysteresis
Enter a directional state at `|eff24| ≥ 0.30`; fall back to `BALANCED_RANGE` only when
`|eff24| < 0.20`. In the `[0.20, 0.30)` band a previously-directional label is held as
`EMERGING_MOVE_x` (flagged `HYSTERESIS_HOLD`) rather than flipping to balanced — this
damps noisy label flicker. The accepted→weaker transition requires the gate to genuinely
fail (context no longer directional, hold lost, or strength no longer confirmed).

## Calibration (declared, versioned, NOT profit-fit)
`CALIBRATION.version = 'cal-v1'`, `effectivePeriod 2025-05-19 → 2026-05-19`,
`basis = descriptor distribution & label-stability within the declared period; NOT trade
profitability`. Thresholds (`ctxEff 0.25`, `transEnterEff 0.30`, `transExitEff 0.20`,
`nowEff 0.30`, `accelMargin 0.05`, `decelMargin 0.10`, `gapMin 0.0003`, `breadthMin 0.60`,
`singleCandleDominance 0.60`) are interpretable placeholders pending a formal
distribution-fit pass over the stated period. **They are not reverse-engineered from any
chart/screenshot and never tuned to trade profit.** The version + effective period are
emitted on every output so a refit is traceable.

## Evidence codes
`CTX_UP/DOWN`, `CTX_MIXED`, `TRANS_UP/DOWN`, `NOW_UP/DOWN`, `SINGLE_CANDLE`,
`STR_GAP_UP/DOWN`, `STR_CONFIRM`, `STR_ABSENT`, `CONFLICT_PRICE_STRENGTH`,
`REVERSAL_UP/DOWN`, `PRIOR_MOVE_REJECTED`, `SUSTAINED_PROGRESS`, `ACCEPTED_HOLD_UP/DOWN`,
`BROAD_INDEPENDENT_STRENGTH`, `DECELERATION`, `NOT_INDEPENDENTLY_CONFIRMED`,
`NO_ACCEPTED_HOLD`, `BALANCED`. Each carries plain-English text.

## API / emission
```js
const { classify } = require('./research/m15/classifier');
classify(pair, historiesByPair, { asOfCloseMs:t, prevState?, calibration?, network? })
```
Emits: `version`, `calibration{version,effectivePeriod,basis}`, `pair`, `asOfCloseUtc`,
`asOfCloseEat`, `primaryState`, `previousState`, `transition{from,to,changed,kind}`,
`windows{context_48_36h, transition_24h, present_12h}` (coverage/eff/direction/gap/breadth),
`structure{acceptedHold, confirmedPivots, lastPivot, provisionalLeg, rejection}`,
`progress`, `acceptance`, `strength`, `evidenceFor[]`, `evidenceAgainst[]`,
`qualityFlags[]` (`STRENGTH_ABSENT`, `NETWORK_ILL_CONDITIONED`, `PRICE_COVERAGE_PARTIAL`,
`NETWORK_COVERAGE_PARTIAL`, `DUPLICATE_CANDLES`, `HYSTERESIS_HOLD`), and an `explanation`.
**Each historical output is immutable as of its candle close** (both sub-modules read only
candles with close ≤ t).

## Sample (EUR/GBP descent + EUR-weak/GBP-strong network, transition from EMERGING)
```
primaryState ACCEPTED_TREND_DOWN · previous EMERGING_MOVE_DOWN · transition kind ACCEPTANCE
context 48h/36h DOWN (eff -1/-1) · 24h DOWN (eff -1, gap -0.0391, breadth 1) · present DOWN (accel 0)
structure: acceptedHold DOWN, 1 confirmed pivot · acceptance: priceHold=true, strengthConfirmed=true
evidenceFor: CTX_DOWN, TRANS_DOWN, NOW_DOWN, STR_GAP_DOWN, STR_CONFIRM, SUSTAINED_PROGRESS, ACCEPTED_HOLD_DOWN, BROAD_INDEPENDENT_STRENGTH
explanation: "A downtrend is accepted: sustained lower prices held, with broad independent strength. …"
```

## Tests
`node --test tests/research/classifier.test.js` → **9 pass / 0 fail**:
- EUR/GBP descent **+ EUR-weak/GBP-strong network ⇒ reaches ACCEPTED_TREND_DOWN**;
- **same descent without a network ⇒ never accepted, stays EMERGING_MOVE_DOWN** (STRENGTH_ABSENT);
- GBP/AUD three-leg: initial fall **REVERSAL_UP** (rejected), late fall **EMERGING_MOVE_DOWN**, **never accepted**;
- price-vs-confirmed-strength disagreement ⇒ **CONFLICT**;
- single-candle move ⇒ **EMERGING**, not accepted (even with confirming strength);
- absent coverage ⇒ **STRENGTH_ABSENT**, capped below accepted;
- **immutability** (truncating to ≤ t reproduces the output) + determinism;
- emission shape (UTC+EAT, windows, evidence, explanation, transition);
- hysteresis holds a weakening directional.

## Limitations
- Calibration thresholds are declared placeholders, not yet distribution-fit over the period.
- Mid-only candles: strength & descriptors are geometric, not economic.
- LOPO confirmation uses the 24h network window (bounded cost).
- REVERSAL is detected against the 48h context sign; very symmetric V's can delay it to the point a confirmed pivot exists.
- No UI and no economic/outcome evaluation here (stopped before both, per instruction).
