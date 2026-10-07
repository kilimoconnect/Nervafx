# Stage B — currency-strength NETWORK estimator (pure, zero-sum)

`research/m15/strengthnet.js` estimates eight **zero-sum currency effects** that best
explain the observed 28-pair M15 log-returns at a synchronized close `t`. It is a
**network description, not a trade indicator** — no signals, no profitability claims.
Isolated from `api/_m15` (imports only loader constants `M15`, `PAIRS`); never touches a DB.
**Version:** `m15-strengthnet-1.0.0`.

## Exact equations
For a window ending at the synchronized close `t`, each canonical pair `p=(b,q)` has a
log return over the observed interval:
```
r_p = ln( close_last / close_first )            # close_last is the candle closing at t
```
Model as a difference of per-currency effects + noise, with an identifiability constraint:
```
r_p ≈ x_b − x_q + ε_p ,     Σ_c x_c = 0
```
Weighted least squares `min_x Σ_p w_p (r_p − (x_b − x_q))²` ⇒ normal equations `L x = β`:
```
L = weighted graph Laplacian of the currency network
    L_cc = Σ_{p∋c} w_p ,   L_cd = −Σ_{p=(c,d)} w_p
β_c = Σ_{base=c} w_p r_p − Σ_{quote=c} w_p r_p        (Σ_c β_c = 0 identically)
```
`L` is singular (null space = **1**), so we solve the regularized sum-zero system
`(L + (1/k)·11ᵀ) x = β  ⇒  x = L⁺β`, which satisfies `1ᵀx = 0`. For the full complete
28-pair network with equal weights this is the closed form `x_c = β_c / 8` (`L = 8I − J`).
The general solver handles the leave-one-pair-out subnetworks (no longer complete).

**Weights** default to equal (1). Data-quality weights may be supplied via `opts.weights`
**only** when independently justified — never weighted by future profit.

**Relative vs absolute:** `x` is zero-sum ⇒ purely **relative** currency effects. The
absolute market drift is reported separately as `diagnostics.meanPairReturn` and is
orthogonal to `x`. The `effects.note` field states this on every result.

## API / schema
```js
const { estimateWindow, describeNetwork } = require('./research/m15/strengthnet');

estimateWindow(historiesByPair, { asOfCloseMs:t, windowHours:12|24|36|48, weights?, pairs?, minPairs=7, minDegree=1 })
  → { version, asOfCloseUtc, windowHours,
      available, reason?,                                 // DISCONNECTED_NETWORK | INSUFFICIENT_COVERAGE | TOO_FEW_CURRENCIES
      coverage:{ pairsExpected, pairsUsed, missingPairs[], unknownKeys[], equivalentDropped[], currenciesPresent[] },
      returnsByPair:{canon:r},
      effects:{ byCurrency:{c:x}, sumZeroCheck, ranked[], note },
      gaps:{ canon:{ baseMinusQuote, observedReturn, residual } },
      breadth:{ c:{ agree, degree, fraction } },
      diagnostics:{ connected, components, minDegree, rank, fullRank, conditionNumber, wellConditioned, rmse, residualsByPair, meanPairReturn, degree } }

describeNetwork(historiesByPair, { asOfCloseMs:t, ... })
  → { version, asOfCloseUtc, note,
      windows:{ h12, h24, h36, h48 },                     // each an estimateWindow result
      paths12h:{ latest, previous, leadershipChanges:{ previousLeader, latestLeader, changed, rankChanges[] } },
      leaveOnePairOut:{ window:'24h', confirmations:{ canon:{ full:{baseMinusQuote}, leaveOut:{baseMinusQuote,connected,minDegree,conditionNumber}, independentlyConfirmed, available } } } }
```
`historiesByPair` keys may be inverted (`USD_EUR`) — they are canonicalized and the
return sign flipped. Providing both `EUR_USD` and `USD_EUR` collapses to **one** edge
(the duplicate is listed in `equivalentDropped`) — mathematically equivalent pairs are
never counted as independent samples.

## Data rules (hard)
- **No forward-fill, no mixed closes.** A pair is used only if it has ≥2 window candles
  **and** its last eligible close equals the synchronized `t`. Otherwise it is listed in
  `missingPairs` and excluded — never interpolated.
- **Coverage is reported** per pair (`coveragePct` = observed/nominal where nominal = 4·H),
  so a window crossing closed-market time shows reduced coverage rather than fabricated bars.
- **Unavailable** when the remaining network is disconnected or under-covered
  (`available:false` + `reason`), instead of returning an unidentifiable estimate.
- **Inversion & zero returns** handled (zero return ⇒ `x` contribution 0, no NaN).

## Independent confirmation (leave-one-pair-out)
For each candidate pair, that **exact** pair's edge is removed and strength is re-estimated
on the remaining network. The excluded pair's return never enters the estimate, so a
shock confined to one pair cannot confirm itself. `independentlyConfirmed = true` only when
the remaining (connected, covered) network reproduces the **sign** of the full-network
`baseMinusQuote` gap. `full` and `leaveOut` figures are kept separately labelled.

## Sample (broad GBP-up / AUD-down truth, 24h window)
```
effects: GBP +0.006 > USD +0.002 > EUR +0.001 > CHF 0 > JPY 0 > CAD −0.001 > NZD −0.002 > AUD −0.006
sumZeroCheck 0 · rmse 0 · conditionNumber 1 · rank 7 (fullRank) · pairsUsed 28 · meanPairReturn 0.00064
breadth.GBP: 7/7 pairs agree (fraction 1)
gap GBP_AUD: baseMinusQuote 0.012 = observedReturn 0.012, residual 0
LOPO GBP_AUD: full 0.012 vs leaveOut 0.012 (connected, minDegree 6, cond 1.33) ⇒ independentlyConfirmed true
```
Contrast — a shock of +0.02 on GBP_AUD only: full gap reacts, but `leaveOut` = 0 ⇒
`independentlyConfirmed false` (the shock does not become its own confirmation).

## Tests
`node --test tests/research/strengthnet.test.js` → **12 pass / 0 fail**: known-effect
recovery; inverse orientation; equivalent-pair dedup; one contradictory pair (largest
residual isolated); missing coverage (reported, still available); disconnected network
(unavailable); pair-specific shock not self-confirming; genuine broad move confirmed;
breadth + leadership paths + relative/absolute labelling; no-forward-fill / zero-return;
determinism + version; production `evaluateCurrencyStrength` compared, unchanged.

## Limitations
- Single synchronized close required; laggard/missing pairs reduce coverage, not filled.
- Mid-only candles: returns are geometric, not net of spread/bid-ask.
- Equal weights by default; any data-quality weighting must be externally justified.
- Describes relative structure only — says nothing about absolute returns or tradability.
- LOPO runs on the 24h window by default (bounded cost); other windows available on request.
