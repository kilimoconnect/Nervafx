# M15 Strategy Research — Stage 2 handoff (feature library)

Pure, deterministic, as-of-close feature functions in the isolated research
namespace (`research/m15/features.js`, `featureSnapshot.js`). Built on Stage 1's
verified no-lookahead contract. **Production `api/_m15/` is unchanged** (optional
descriptors are read-only). No strategies created. Nothing committed/pushed/deployed.

- Feature version: **`m15-feat-1.0.0`** · source hash **`featureHash(FEATURE_CONFIG)`**
- Tests: `node --test tests/research/*.test.js` → **19 pass / 0 fail** (9 loader + 10 feature); full repo **158/158**.

## Feature contract (per pair, as-of the frame close)
Log returns `r_t = ln(C_t/C_{t-1})`. For each horizon **N ∈ {4,6,8,10}**:

| Field | Formula | Kind |
|---|---|---|
| `R` | `ln(C_t / C_{t-N})` | **independent** |
| `U` / `D` | `Σ max(r,0)` / `Σ max(−r,0)` over last N | **independent** |
| `path` | `U + D` (total absolute movement) | **independent** |
| `z` | `R / scale_N` where `scale_N` = sample std of **earlier** overlapping N-bar returns (as-of; excludes current; needs ≥30 obs) | **independent** |
| `P` | `100·(U−D)/(path+ε) = 100·R/path` | **derived** |
| `efficiency` | `\|P\|/100 = \|R\|/path` | **derived — same information as \|P\|** |

**Explicit identities / overlap (never four confirmations):**
- `U − D ≡ R` and `U + D ≡ path` are surfaced (`identityHolds`), so the algebra is visible.
- `efficiency` **is** `|P|/100` — reported as derived, never as independent confirmation.
- The four horizons are **nested, overlapping** measurement windows. To see progression without recounting, use the **non-overlapping blocks**: `B1=R4` (4 bars), `B2=R6−R4`, `B3=R8−R6`, `B4=R10−R8` (2 bars each), compared by **per-candle rate**; they re-sum to `R10` (`reconstructsR10`).
- Zero movement is explicit: `path<ε ⇒ P=0, efficiency=0, NEUTRAL`.
- **Normalization uses the actual lagged N-bar scale**, not an assumed `σ₁·√N` — proven scale-invariant in tests. Optional prespecified session buckets are supported.
- `wickBody` (body/upper-wick/lower-wick fractions) is a **separate shape descriptor** — OHLC does not reveal order flow; OANDA volume is tick count, not trading volume.

## Currency network (basket-relative, comparable log units)
For horizon N, over the equal-weight 28-pair network:
`x_{c,N} = (1/8)·Σ_{p∋c} sign(c,p)·R_{p,N}` (base +, quote −). Verified: **zero-sum**
(`Σ_c x_c = 0`), and missing pairs are skipped (recorded in breadth participation).
- **Pair gap** = **raw** `x_base − x_quote` (comparable units, **before** any pair-vol
  normalization) — related network evidence, **not** an independent forecast of the pair.
- **Breadth** over each currency's 7 relationships uses a **prespecified deadband**
  (`0.0004` log units), recording pos/neg/net/participating.
- **Never** subtract individually normalized or tanh-transformed currency scores to
  infer pair direction.

## Acceptance criteria — met
- **Cross-pair signs correct:** a lone EUR/USD up move gives `x_EUR=+R/8`, `x_USD=−R/8`,
  `gap_EUR_USD>0`; inverting a pair's sign flips its contribution and gap (tested).
- **Time boundaries correct:** snapshots consume Stage 1's `syncAsOf`; the determinism
  test asserts no candle in the snapshot closes after T.
- **Overlap / algebraic duplication explicit:** `P`/`efficiency` labelled derived;
  identities surfaced; blocks reconstruct `R10`.
- **No standardization reversal:** `gap` is exactly raw `x_base − x_quote` for all pairs
  (tested to 1e-15); a separate test demonstrates that mismatched per-currency
  standardization *would* reverse a same-sign case (0.001 vs 0.002 with scales
  0.005/0.05 → raw −0.001 but normalized +0.16), which is precisely the pitfall the raw
  gap avoids.

## Independent vs derived (summary)
- **Independent:** `R, U, D, path, z`, block returns, `wickBody`, currency `x`, breadth.
- **Derived (not confirmation):** `P` (=100·R/path), `efficiency` (=|P|/100), pair `gap`.

## Optional read-only descriptors (`descriptors:true`)
Borrowed from production engines without changing their outputs: energy
(level/direction/acceleration), EMA state, equilibrium `distanceVol`, structure
direction + leg count, and a UTC-hour session label. Kept optional (adds ~355ms/snap).

## Performance (`docs/research/stage2_bench.json`, real data, 40-day window)
- Candles/pair ≈ 2,866. DB load 93.8s (network-bound, offline only).
- **One full 28-pair snapshot: 66.7 ms** (features), 421.8 ms with descriptors.
- **Replay slice: 200 closes in 5.7 s ≈ 28.6 ms/close.** Full-cadence over ~33k closes
  ≈ 16 min offline — never inside a Vercel request.
- Sample (close 2026-09-25 20:45 UTC / NEWYORK): EUR/USD R10=+8.8e-5, P10=6, z10=0.10,
  network zero-sum ✓, gap_EUR_USD_10=+9.4e-5, `inputHash=79f02b17…` (reproducible).

## Data exclusions / caveats (from Stage 1)
Mid-only (no spread in candle store — cost modelling deferred to a later stage); tick
volume ≠ trading volume; 533 range-outlier candles flagged (not removed); ~0.58%
intraday missing candles. Data snapshot hash `84405f31dc880be4`.

## Stage 3 readiness
Feature contract is fixed and versioned; snapshots are deterministic and
tolerance-reproducible; independent vs derived fields are explicit; the currency
network is sign-correct and standardization-safe. Ready to define candidate setups
(Stage 3) **on top of** these features — no new market-detection horizons hard-coded;
4/6/8/10 remain measurement horizons, and adaptive structure/equilibrium/energy remain
available as descriptors. **Stop after Stage 2.**
