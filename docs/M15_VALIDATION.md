# M15 Intelligence — historical validation (§33)

Read-only replay of the deterministic engine across real M15 history. No prod
writes, no orders. Harness: load all 28 pairs into memory, replay every 4th M15
close (hourly stride) with 240‑candle warm‑up, no look‑ahead.

## Run: 2026‑07‑01 → 2026‑09‑11 (config `m15-cfg-1.0.0`)

- Frames evaluated: **1,260 × 28 pairs = 35,280 pair‑evaluations**
- Per‑pair coverage in window: ~5,275 M15 candles (99.8% complete, no dupes)

### Market‑state distribution
| State | % |
|---|---|
| CHAOTIC | 34.9 |
| BULLISH_EXHAUSTION | 12.9 |
| BEARISH_PULLBACK / BULLISH_PULLBACK | 9.7 / 9.7 |
| BEARISH_EXHAUSTION | 7.7 |
| BULLISH_EXPANSION | 7.6 |
| COMPRESSION | 6.7 |
| BEARISH_EXPANSION | 6.1 |
| DEAD | 1.9 |
| BULLISH/BEARISH_MOVEMENT | 1.1 / 1.1 |
| TRANSITION / BALANCE | 0.3 / 0.2 |

### System‑decision distribution
| Decision | % |
|---|---|
| NO_TRADE_CHAOTIC | 34.9 |
| NO_TRADE_INSUFFICIENT_SPACE | 33.6 |
| NO_TRADE_LATE | 28.6 |
| NO_TRADE_DEAD | 1.9 |
| NO_TRADE_CONFLICTED | 0.8 |
| WATCH_PRESSURE / WATCH_COMPRESSION | 0.1 / 0.03 |
| ARMED_BEARISH / ARMED_BULLISH | 9 / 4 (counts) |

Agreement: NO_AGREEMENT 70.5%, LATE 28.6%, CONFLICTED 0.7%, graded < 0.3%.

### Armed setups & outcomes
- **13 armed setups** (9 EARLY_EXPANSION, 4 FIRST_CONTROLLED_PULLBACK); sessions
  spread Asia 4 / NY 3 / Late 3 / London‑NY 2 / London 1.
- Outcomes: T2 (2R) ×5, STOP ×4, T1+ ×1, no‑fill ×2, invalidated‑before‑fill ×1.
- Filled 10: **avg 0.70R pre‑spread, 0.62R post‑spread; 60% win (≥T1); avg MFE
  2.15R, avg MAE 0.68R.**

## Findings

1. **The engine is very conservative** — 13 armed setups in 2.5 months across 28
   pairs (~1 per 6 days). The gate stack is doing its job (rejecting late/chaotic/
   tight‑space) but is likely *too* strict to be practically useful as‑is.
2. **CHAOTIC at ~35% is over‑aggressive.** The energy chaos gate
   (`volatilityLevel > 0.45 AND efficiency < 0.35`) fires on a third of all
   evaluations; real FX M15 is not chaotic a third of the time. The efficiency
   cutoff (0.35) is the main lever.
3. **INSUFFICIENT_SPACE at ~34%.** `space.minSpaceVolMult = 1.5` with "nearest
   prior leg extreme ahead" as the barrier blocks most trending setups, because a
   recent swing often sits < 1.5 vol away.
4. **LATE at ~29%.** Equilibrium (half‑life 48) lags fast, so `distanceVol` grows
   quickly after escape and the freshness bands tip to LATE within a few candles.
5. The 13 that passed had a *sane* profile (MFE 2.15R, 60% win), so the signal
   logic is not inverted — the gates are simply throttling volume hard.

## Recommendation (not yet applied)

A **single principled calibration pass** on a development slice (NOT the test
period, NOT optimized for profit) targeting distribution realism:
- chaos efficiency cutoff and/or volatility‑level requirement,
- `space.minSpaceVolMult` and the barrier definition,
- freshness distance bands vs the equilibrium half‑life.

Per §33 this must keep dev / validation / final‑test periods separate and must not
tune to maximize historical return. The current numbers are the honest, untuned
baseline.
