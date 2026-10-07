# Manual Decision Workspace — isolated research frontend (DEMO/SYNTHETIC)

A usable, isolated, **local-only** manual decision workspace built on the approved M15
classifier / currency-strength contracts. **DEMO/SYNTHETIC**: designed fixtures are run
through the real research modules (`priceaction`, `strengthnet`, `classifier`) by an
offline engine; the frontend reads only that output. **No backend wiring, no DB, no
orders/broker, no deployment, no push.** Research stays isolated from production signals;
Stage 5/5A **NONE PASSED** artifacts are preserved and surfaced, never overturned.

## Files
- `scripts/research/build-workspace-fixtures.js` — fixture ENGINE (separate from the UI).
- `research/ui/workspace/fixtures.js` — generated `window.NFX_FIXTURES` (+ `docs/research/workspace/fixtures.json`).
- `research/ui/workspace/adapters.js` — typed adapter (throws on failure; **no synthetic fallback**; documents the real-API swap point).
- `research/ui/workspace/styles.css` — design tokens mirror `public/style.css` (Inter, dark theme).
- `research/ui/workspace/app.js` — vanilla SPA: canvas candlesticks, 6 views, replay, journal, keyboard.
- `research/ui/workspace/index.html` — shell.
- `tests/research/workspace.test.js` — contract + causality + state-coverage tests.

## Local preview
```bash
node scripts/research/build-workspace-fixtures.js      # (re)generate fixtures
npx --yes serve -l 4599 .                              # any static server at repo root
# open:  http://localhost:4599/research/ui/workspace/
```
Keyboard: `← →` step close · `↑ ↓` change pair · `1–6` switch views.

## Flows (all implemented locally, fixture-driven)
1. **Market review** — data header (close UTC/EAT, freshness, 28/28 coverage); watchlist with
   state/strength/other-pair; selected M15 candlestick chart; **four-window price/strength
   matrix** (12/24/36/48); other-pair currency context (8-ccy board + breadth); supporting /
   opposing evidence; next condition + invalidation reference (with ref level); decision recording.
2. **Pair detail** — causal price-event chronology; latest-vs-preceding-12h comparison. The
   four-window matrix is always shown and **chart lookback is visual only** (does not hide window readings).
3. **Replay** — step one completed candle at a time; all views synchronized to the selected close;
   **future events and swing confirmations hidden** (frames are immutable as-of close).
4. **Journal** — records a **pre-outcome** snapshot (close timestamp, classifier version, state,
   evidence, next condition, invalidation) to `localStorage`; persistence status shown honestly
   ("this browser only, not synced to any server"). No outcome/P&L tracked.
5. **Model & data health** — explicit `UNVALIDATED`; Stage 5/5A `NONE PASSED` + info-content
   `INSUFFICIENT_EVIDENCE` + economics `ESTIMATED` + pre-registration hash; per-pair data health.
   **No profitability, win-rate, or confidence probability anywhere.**
6. **Plan & risk** — honest **UNAVAILABLE** (no account/instrument/cost/position contract); states
   that structure clarity is not entry eligibility; shared-currency exposure only with real inputs.

## States implemented
loading, **unavailable** (+ reason), **stale**, **closed-market** (weekend), **conflict**,
**extended-move**, **error** (explicit, no fabricated fallback — "Simulate error" toggle), and a
persistent **unvalidated-model** badge. Excluding a pair from strength is labelled **other-pair
confirmation**, explicitly *not* statistical independence.

## Checks passed
- `node --test tests/research/workspace.test.js` → **8 pass / 0 fail**.
- Full research suite `node --test tests/research/*.test.js` → **110 pass / 0 fail**.
- Browser-verified (screenshots): desktop market review (chart + matrix + next-condition),
  Model & Health, error state, and mobile (375px) stacked layout; keyboard stepping works.

## Implemented vs Fixture vs Unavailable
- **Implemented (real logic):** all UI, the classifier/strength/price-action computations behind the
  fixtures (real modules), causality guarantees, journal persistence, every state.
- **Fixture (SYNTHETIC):** the market data itself — designed candle paths, not live; labelled on every screen.
- **Unavailable (by honest design):** live/backend data feed, actual bid/ask economics, plan/risk
  sizing & costs, shared-currency exposure from real positions, and model validation (no edge exists).

## Missing adapter requirements (to wire the real backend later)
Replace `adapters.getWorkspace()` with: (a) the latest synchronized snapshot from
`/api/m15-intelligence` (already live), and (b) a **per-pair replay endpoint** returning the frame
sequence + candles in this exact contract. Plan/risk needs an **account + instrument + live cost +
position** contract before it can leave the UNAVAILABLE state. Do **not** fall back to fixtures on error.

## Known integration gap (pre-existing, not from this task)
`tests/m15/*` and the `npm run test:m15` script still reference the retired `api/_m15` engine
(removed in the earlier "replace old M15 system" change), so that script now fails. It is unrelated
to this workspace; flagging for cleanup.

## Not done (per instruction)
No deployment, push, DB migration, live notification, scheduler, broker/order path, or production
signal change. This is a design prototype and is **not** a profitable trading system.
