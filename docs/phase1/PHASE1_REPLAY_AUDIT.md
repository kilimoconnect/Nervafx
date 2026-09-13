# Phase 1 — Replay correctness & baseline diagnosis (M15-only)

Read-only diagnosis. **No** `sql/020`, no cron, no prod writes, no deploy, no push,
no legacy-route retirement, no gate calibration. All numbers below come from the
unchanged engine replayed over real OANDA M15 history in `backtest_candles`.

- Revision frozen: `ff67138` · config `m15-cfg-1.0.0` (hash `be69b3c4af041e9d`)
- Window: **2026-07-01 → 2026-09-11**, every completed M15 close (stride 1)
- First eligible frame (260-candle warm-up): **2026-06-30 23:45 UTC**
- Coverage: **196,224 pair-evaluations** over **7,008 closes** × 28 pairs; ~5,752–5,759 M15/pair loaded
- Tests: **`node --test tests/m15/*.test.js` → 110 pass / 0 fail** (97 pre-existing + 13 added)
- Machine-readable outputs: `docs/phase1/*.json` (manifest, cadence_summary, gate_waterfall, episodes, outcomes, snapshot)

Reproduce:
```bash
node --test tests/m15/*.test.js
NODE_PATH=<dir-with-@supabase> GIT_REV=$(git rev-parse HEAD) \
  node scripts/m15/replay-cadence.js --from 2026-07-01 --to 2026-09-11 --stride 1 --warmup 260 --snapshot 2026-09-10T12:00:00Z
```

---

## 1. Baseline freeze (verified against code + DB)

| Item | Verified value |
|---|---|
| Candle `time` | **START** of the candle (OANDA convention). Ingested verbatim in `src/oanda.js` / `api/cron-backtest-sync.js` (`time: c.time`). |
| `complete` column | **Always `true`** — ingestion filters `c.complete===true` and writes `complete:true`, so the column cannot distinguish "known at T". The real replay guard is the time condition. |
| Price type | **MID** (`price:'M'`, OHLC from `c.mid`). No bid/ask stored. |
| Timeframes stored | M5, M15, H1. The analytical engine reads **M15 only** (`data.fetchM15` pins `timeframe='M15'`, `complete=true`). |
| Replay filter (pre-fix) | `evalTarget = floor(atMs/15m)*15m`, then `time ≤ evalTarget`. |
| Outcome sim | post-hoc; assumptions in §7. |

Config values were edited in a prior session **without bumping `CONFIG_VERSION`**
(still `m15-cfg-1.0.0`, but hash `be69b3c4af041e9d`). See Finding F4.

---

## 2. Lookahead audit — a real defect existed in REPLAY (not live)

**Convention:** a candle with `time = t` covers `[t, t+15m)` and **closes at t+15m**.
At an evaluation instant `T`, only candles with `close ≤ T` (i.e. `open ≤ T−15m`)
existed.

**Defect (replay only):** `loadSynchronized` computed the replay frame as
`floor(atMs/15m)*15m` and fetched `time ≤` that value. For a request on an M15
boundary `T` (e.g. **2026-09-10 12:00 UTC = 15:00 EAT**) this **included the candle
opening at 12:00**, which closes at **12:15 (15:15 EAT)** — information that did not
exist at 15:00. The spec's boundary test (14:45 candle may be included; 15:00 must
not) was **failing**.

**Live path was correct** — `latestCompletedM15Ms(now)` returns the open of the
last *closed*, grace-cleared candle, so the live dashboard never had lookahead.
No genuine recorded live snapshot exists, so this is asserted from the code path,
**not** claimed from two historical recomputations.

**Fix (`api/_m15/load.js`, replay branch only):**
`frameOpen = floor(T/15m)*15m − 15m` = open of the last candle whose close ≤ T.
Off-grid `T` snaps **down** to the last completed close. Live branch untouched.
A `legacyFrame` flag reproduces the old behaviour for impact measurement.

**Measured impact — the lookahead was real but decision-inert in this window:**

| Metric (correct vs legacy, same 7,008 closes) | Value |
|---|---|
| Differing **decisions** | **0 / 196,224 (0.00%)** |
| Armed only under legacy (phantom signals) | 0 |
| Armed only under correct | 0 |
| Intermediate **state labels** that shift | Demonstrated (see §6) |

Interpretation: because every engine reads adaptive EWMA baselines over ~260
candles, one extra future candle almost never flips a **decision**; it can shift a
displayed **market-state label** at the boundary (e.g. COMPRESSION↔EXPANSION), but
the terminal gate outcome (here INSUFFICIENT_SPACE) is unchanged. The fix is still
correct and required; its practical effect on decisions in 2026-07→09 was nil.

Boundary tests added: `tests/m15/lookahead.test.js` (14:45 in / 15:00 out at
T=12:00 UTC, off-grid snap, EAT→UTC, incomplete excluded, missing-pair sync,
determinism). Off-grid **policy**: a request not on an M15 close is evaluated at
the **last completed close ≤ request** (snap down); nothing closing after the
request is ever included.

---

## 3. Full-cadence vs sampled — the "13" was a sampling artifact

| Cadence (corrected engine) | Closes | Pair-evals | Armed frames | Unique episodes |
|---|---|---|---|---|
| Prior doc (hourly, every 4th) | 1,260 | 35,280 | 13* | — (not deduped) |
| This run, hourly (stride 4) | 1,752 | 49,056 | 7 | 7 |
| **This run, full cadence (stride 1)** | **7,008** | **196,224** | **40** | **36** |

Armed states are **transient** — episode age is median **1** M15 candle (max 3),
so hourly sampling skips ¾ of closes and misses most armed frames. The 13→40 gap
is **entirely sampling cadence**: the timing fix changed 0 decisions (§2), so it
contributes nothing to the difference. *(\*The doc's 13 vs our hourly 7 differ
because of stride offset and the un-versioned config edit, F4 — not the fix.)*

**Episodes (full cadence, deduped, correct frame):** 36 total — 19 EARLY_EXPANSION,
17 FIRST_CONTROLLED_PULLBACK; 22 bullish / 14 bearish. End reasons: **20
invalidated by INSUFFICIENT_SPACE on the next candle**, 7 CONFLICTED, 4 LATE, 4
cooled to WATCH, 1 DEAD. i.e. most setups that arm are killed by the space gate
one candle later.

**Decision distribution (denominator = 196,224 evaluations):** NO_TRADE_CHAOTIC
35.2% · NO_TRADE_INSUFFICIENT_SPACE 33.8% · NO_TRADE_LATE 28.2% · NO_TRADE_DEAD
1.9% · NO_TRADE_CONFLICTED 0.8% · WATCH 0.08% · ARMED 40 frames (0.02%). This
matches the prior doc's shape, so the distribution is stable; only the armed
**count** was mis-stated by sampling.

---

## 4. Gate waterfall — independent failure vs displayed primary

Each gate scored **independently** (ignoring priority) across all 196,224
evaluations, alongside the single **displayed** primary (priority order:
DEAD > CHAOTIC > CONFLICTED > LATE > OVEREXTENDED > INSUFFICIENT_SPACE > SPREAD >
agreement).

| Gate | Independent FAIL | as % of evals | Displayed as primary |
|---|---|---|---|
| **INSUFFICIENT_SPACE** | 177,672 | **90.5%** | 33.8% |
| NO_AGREEMENT (terminal) | 139,368 | 71.0% | (folds into CONFLICTED/CHAOTIC/etc.) |
| LATE | 86,243 | 44.0% | 28.2% |
| CHAOTIC | 69,068 | 35.2% | 35.2% |
| OVEREXTENDED | 61,491 | 31.3% | (rarely primary; usually LATE first) |
| DEAD | 3,771 | 1.9% | 1.9% |
| CONFLICTED | 1,453 | 0.7% | 0.7% |

**The binding constraint is INSUFFICIENT_SPACE (fails 90.5% of the time)** but it is
only the *displayed* reason 33.8% of the time because CHAOTIC/LATE/OVEREXTENDED
usually fire earlier in priority. It is the true gate on almost everything.

**Overlap matrix (four spec gates; counts of evaluations where both fail):**

| Pair | Count |
|---|---|
| INSUFFICIENT_SPACE ∩ NO_AGREEMENT | 133,099 |
| CHAOTIC ∩ NO_AGREEMENT | 69,068 (= **all** CHAOTIC ⊆ NO_AGREEMENT) |
| INSUFFICIENT_SPACE ∩ LATE | 68,447 |
| CHAOTIC ∩ INSUFFICIENT_SPACE | 63,276 (92% of CHAOTIC) |
| LATE ∩ NO_AGREEMENT | 30,991 |
| CHAOTIC ∩ LATE | 29,761 |

**INSUFFICIENT_SPACE trace (F1).** The gate is measured **price → nearest prior
structural leg extreme in the travel direction**, in volatility units, with
threshold `spaceVol ≥ 1.5` (`space.js`). It is computed **for every pair at every
close, independent of any candidate entry/stop/R**, and the direction is
`sign(distanceFromEquilibrium)` — not a trade direction. When **no setup exists**
the diagnostics mark it `naForTrade:true`: reporting "insufficient space" for a
pair that has no entry or stop is not a true trade-space measurement. This is a
design observation (not a timing/leak defect), deferred to Phase 2.

---

## 5. Conflicting-label investigation (legitimate vs defect)

- **currency power `BUILDING` with structure `EXHAUSTED`** (e.g. GBP live): these
  are **separate measurements** by design — `power` = capacity to produce
  efficient/broad/accelerating progress; `currencyStructure` = aggregate of the
  member pairs' *states*. A currency can be gaining power while most of its pairs
  are late/exhausted. **Legitimate**, not a defect.
- **freshness `TRADEABLE` with agreement `NO_AGREEMENT`**: `freshness` is a
  per-pair *position-in-move* measure; `agreement` is the multi-evidence *vote*. A
  pair can be positionally early yet have unaligned evidence. **Legitimate**, not a
  defect. UI clarity (surfacing that these are orthogonal) is a Phase 2 concern.

No label defect found; both are the intended "separate measurements, no single
unexplained score" design (§21).

---

## 6. Screenshot case study — 2026-09-10 15:00 EAT (12:00 UTC), all 28 pairs

Correct frame's last candle = **11:45 UTC (14:45 EAT)**, closing exactly at 15:00.
Full per-pair waterfall in `snapshot_2026-09-10T120000Z.json`.

| Pair | Correct (frame 11:45) | Legacy (frame 12:00, lookahead) |
|---|---|---|
| **EUR/GBP** | `NO_TRADE_INSUFFICIENT_SPACE` · state **COMPRESSION** · agree NO_AGREEMENT · fails **SPACE, NO_AGREEMENT** | same decision · state **BULLISH_EXPANSION** |
| **AUD/CHF** | `NO_TRADE_INSUFFICIENT_SPACE` · state **BEARISH_EXPANSION** · fails SPACE, NO_AGREEMENT | same decision · state **BEARISH_PULLBACK** |
| **EUR/CAD** | `NO_TRADE_INSUFFICIENT_SPACE` · state **BEARISH_PULLBACK** · fails SPACE, NO_AGREEMENT | same decision · state **BEARISH_EXPANSION** |

All three: **primary = INSUFFICIENT_SPACE** (space < 1.5 vol to the nearest prior
leg extreme), with NO_AGREEMENT also failing. The **decision is identical** before
and after the timing fix; the lookahead only perturbs the **market-state label**
(the extra 12:00 candle moves distance/expansion enough to reclassify the state,
not enough to change the gate outcome). This is the visible face of §2: fix
required, decision impact nil, label impact real.

---

## 7. Outcome estimates — LABELLED, do not extrapolate

Post-hoc, `outcomes.json`. **Assumptions:** MID prices (no bid/ask; post-spread not
computed); fill only from the candle **after** arm (manual delay); a candle
touching **both** stop and 2R target is **AMBIGUOUS** (M15 can't order intrabar);
2R target; no partials.

36 episodes → T2 ×10, STOP ×13, NO_FILL ×6, OPEN-at-window-end ×5, AMBIGUOUS ×2.
Of resolved (T2+STOP = 23): 10 win / 13 loss. **This is a small, pre-spread,
mid-price estimate — it is NOT a validated win rate and must not be extrapolated.**
It notably does **not** reproduce the prior doc's "60% win" (that was n=10 from the
sampled 13 under slightly different fill assumptions); the fuller sample is less
favourable. Treat both as indicative only.

---

## Findings (severity order)

- **F1 — INSUFFICIENT_SPACE is the de-facto master gate (High, design not leak).**
  Fails 90.5% of evaluations; measured from current price to nearest prior leg
  extreme, independent of any entry/stop/R, and applied even when no setup exists.
  It also kills 20/36 armed episodes one candle after arming. **No calibration in
  Phase 1** — flagged for Phase 2.
- **F2 — Replay lookahead existed; decision impact = 0 in this window (High cause,
  Low effect).** Fixed in `load.js`; live path was already correct. Impact: 0 /
  196,224 decisions; label-only shifts demonstrated.
- **F3 — Prior "13 armed setups" was a sampling artifact (Medium).** Full cadence =
  40 armed frames / 36 episodes; armed states last a median of 1 candle. Not caused
  by the timing fix.
- **F4 — Config edited without bumping `CONFIG_VERSION` (Medium, reproducibility).**
  Values changed but version stayed `m15-cfg-1.0.0` (hash now `be69b3c4af041e9d`).
  This breaks the §27/§31 "same version ⇒ same result" contract and explains small
  drift from the prior doc. Recommend versioning before any Phase 2 change.
- **F5 — `complete` column is uninformative for replay (Low, documented).** Always
  true; only the `open ≤ T−15m` condition prevents leakage. Current code relies on
  the time condition, which is correct after F2.
- **F6 — Coordinator hardcodes `synchronized:true` in the agreement gate (Low).**
  Even when `sync.reason==='MISALIGNED'`, the agreement gate sees `synchronized:true`.
  Not triggered in this window (data is aligned) but should consume the real sync
  state. No decision impact measured; noted for Phase 2.

---

## Unresolved ambiguities

- **No genuine live snapshot** was recorded, so live↔replay parity is asserted from
  the code path only (live uses the correct `latestCompletedM15Ms`), never claimed
  from two historical recomputations.
- **Outcome realism** is bounded by MID-only data: no spread, no bid/ask trigger,
  and intrabar stop-vs-target ordering is unknowable at M15 (labelled AMBIGUOUS).
- **Space semantics**: whether INSUFFICIENT_SPACE *should* be a market filter or a
  per-trade (entry→target) check is a design decision, not resolved here.

---

## Phase 2 recommendations (evidence-ranked; not executed here)

1. **Re-scope INSUFFICIENT_SPACE (strongest evidence, F1).** Make it a *per-trade*
   check (entry→first-target room vs the chosen barrier) and mark it N/A when no
   candidate exists; only then consider the `minSpaceVolMult`. 90.5% independent
   failure + 20/36 episode kills is the single biggest lever.
2. **Version-lock the config (F4)** before any threshold change so dev/validation/
   test periods are reproducible; keep `sql/020` + a persistence cron for durable
   per-run records.
3. **Then, and only then, calibrate on a dev slice** (CHAOTIC efficiency cutoff,
   space multiple, freshness bands) with a held-out validation and an untouched
   final test period — for distribution realism, never to maximize the small-sample
   win rate.
4. **Feed real sync state into the agreement gate (F6).**
5. **Outcome realism**: add bid/ask (or a spread model) before trusting any win-rate
   number; keep intrabar ties labelled ambiguous.

## Files changed / added

- `api/_m15/load.js` — **fix**: replay frame excludes the candle closing after T
  (`replayFrameOpen`), off-grid snap-down, `legacyFrame` flag; live path unchanged.
- `api/_m15/coordinator.js` — **additive** `diagnostics` flag (attaches raw engine
  objects; proven to leave decisions byte-identical).
- `api/_m15/diagnostics.js` — **new**, read-only gate waterfall + primary re-derive
  + episode dedup.
- `scripts/m15/replay-cadence.js` — **new**, read-only offline full-cadence runner.
- `tests/m15/lookahead.test.js`, `tests/m15/diagnostics.test.js` — **new** (13 tests).
- `docs/phase1/*.json` — machine-readable baseline + results.
