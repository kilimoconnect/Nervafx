# Stage A — single-pair price-action descriptor (pure, causal)

`research/m15/priceaction.js` reads CLOSED M15 OHLC candles for **one pair** and emits
a strictly-causal **description** of price behaviour as-of an evaluation close `T`. It
creates **no trade entries, no signals, no profitability claims** — observations only.
Isolated from `api/_m15` (imports nothing from it) and never touches a database.

**Version:** `m15-pa-1.0.0`. **Threshold version (swing/zone calibration):**
`swing-k1.5-medabs-v1` — versioned separately so sensitivity is inspectable and the
threshold is never re-chosen from downstream profit (there is none).

## Causality rules (enforced in code)
- **C1** No candle with `close > T` is read (`open + 15m <= T`, `complete !== false`).
- **C2** No label at bar *i* uses any candle after *i*.
- **C3** Intrabar order is never inferred — we never assume the high or low came first; wick facts use only `close` vs the bar extreme.
- **C4** A swing pivot enters the known state at its **confirmation** close, never backdated to the extreme; both `pivotTimeMs` and `confirmedAtMs` are reported.
- **C5** Weekend/holiday gaps are reported as missing coverage, never fabricated.

## API
```js
const { describePriceAction, detectSwings, swingSensitivity } = require('./research/m15/priceaction');
describePriceAction(candles, { pair, asOfCloseMs /*T, required*/, k=1.5, calibLookback=48, zoneTolK=1.0, minTouches=3, acceptN=2 })
```
`candles`: ascending research-shape candles for ONE pair (`{openMs,open,high,low,close,volume?,complete?,source?}`); may include ineligible/future rows — they are filtered.

## Equations / definitions (per window)
Windows are the candles whose **close** lies in `(T − H·1h, T]` for `H ∈ {12,24,36,48}`.
Coverage is reported, never filled: `nominalCandles = 4H`, `coveragePct = 100·actual/nominal`.
- **Close displacement** `Δ = closeₙ − close₁`; **open→close** `= closeₙ − open₁` (descriptive).
- **Path length** `L = Σ|closeᵢ − closeᵢ₋₁|` (consecutive closes only, C3).
- **Directional efficiency** `η = Δ / L` if `L>0` else `0` ⇒ `η ∈ [−1,1]` (safe zero handling).
- **Range** `[min(low), max(high)]`; **position** `(closeₙ − low)/range` if `range>0` else `0.5`.
- **Alternation** = fraction of close-to-close sign flips; **overlapFraction** = fraction of consecutive bars whose `[low,high]` overlap (balance texture).
- **Counter-move** = deepest pullback from the running favourable peak; **impulseRetracedProportion** = that counter / the peak favourable excursion (safe 0).
- **Comparison**: `latest12` vs `previous12` (band `(T−24h, T−12h]`) with `deltaEfficiency`, plus the nested-window efficiency trail `h12/h24/h36/h48`.

## Swings (causal zig-zag)
Running max/min since the last confirmed pivot; a reversal confirms once price
retraces from the extreme by `≥ θ`, with `θ = k · scale`, `scale = median(|Δclose|)` over
the trailing `calibLookback` closes (past+present only). First side to cross `θ`
establishes the first pivot. The open leg after the last pivot is reported as
`provisional { direction, extremeTimeMs, confirmed:false }`. `swingSensitivity` reports
pivot counts for `k ∈ {1,1.5,2,3}` — descriptive only.

## Balance zone lifecycle
Zone = the most-interacted price band (center = close with most neighbours within
`tol = zoneTolK·scale`; `tol=0` ⇒ no zone). Walked forward, emitting a causal log:
`BALANCE_FORMED` → `DEPARTURE_PROVISIONAL` → (`TEST` retest | `RETURN` fail) →
`DEPARTURE_ACCEPTED` (either `acceptN` consecutive closes beyond, or a retest that holds)
→ `CONTINUATION` (sustained hold, summarized once) ; `REJECTION` = wick beyond but close
back inside. Merged chronological `events[]` also carries `REVERSAL` (confirmed pivots in
the last 48h). **Provisional vs accepted departure are explicitly distinct; acceptance is
asserted only at the later bar that proves it — never backdated.**

## States (explicit)
`NO_DATA` (0 eligible), `INSUFFICIENT_DATA` (<4 candles in 12h), `AMBIGUOUS` (zero range),
`DIRECTIONAL_UP`/`DIRECTIONAL_DOWN` (|η₂₄|≥0.5), `BALANCED` (overlap≥0.7 & |η|<0.25),
`ROTATIONAL` (otherwise). Each carries `reasons[]` + `evidence`.

## Sample (persistent descent fixture, EUR/GBP-like, 96 candles)
```
state: DIRECTIONAL_DOWN (|efficiency|=1.00 over 24h)
h12:  actual 48/48 (100%),  η=-1.00, range 0.0272, positionInRange 0.015
h48:  actual 96/192,         η=-1.00, counterMove 0, impulseRetraced 0
comparison: latest12 η=-1.00 vs previous12 η=-1.00, Δη=0
swings: 1 confirmed HIGH (pivot @00:15, confirmed @00:45, lag 2, θ=0.0009); provisional DOWN leg open
balance: zone [0.8531,0.8543] FORMED → DEPARTURE_PROVISIONAL → DEPARTURE_ACCEPTED → CONTINUATION (held 80 closes)
```

## Tests
`node --test tests/research/priceaction.test.js` → **12 pass / 0 fail**. Fixtures:
persistent descent w/ shallow recoveries; sharp fall + full recovery (V, two-way swings);
late new decline in a broader range; weekend gap; duplicate/missing candle; unchanged
price; an un-confirmed (provisional) swing at T; a pivot known only at confirmation
(no backdating); NO_DATA; determinism + no-lookahead; balance lifecycle; versioning.

## Limitations
- Path length uses close-to-close only (C3) — it **understates** true intrabar path.
- Mid-only candles: no spread/bid-ask; descriptors are geometric, not economic.
- `scale`/zones are calibrated from recent movement, not tuned — intentionally.
- Single pair only. No currency-network and no UI here (next stages).
