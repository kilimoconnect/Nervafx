# Stage D — isolated historical replay / research view

A local, **non-served** research view that replays the Stage-C classifier close-by-close.
It does **not** modify production signals, does **not** add a Vercel route or `api/*`
handler, and is **not** a scheduled job. It is the same isolation pattern as the existing
`research/ui/strategy-research.html`.

## Isolated-route decision (as instructed)
Wiring this into the live app would mean editing `vercel.json` rewrites and/or adding an
`api/` handler — a **production change**. Per the instruction I **stopped and did not do
that**. Instead the deliverable is fully isolated:
- `scripts/research/build-replay.js` — offline generator (run by hand); writes a frozen
  dataset. Touches nothing under `api/`, `sql/`, or `vercel.json`.
- `research/ui/replay.html` — standalone static viewer; loads the frozen dataset via a
  sibling `<script>` (no fetch, no DB, no server needed in principle).
- `research/ui/replay-data.js` + `docs/research/replay/replay-data.json` — the generated,
  immutable payload.
- `.claude/launch.json` — a **local dev-only** static-server entry used purely to preview
  the page in a browser (Vercel ignores `.claude/`). Not a production route.

**Proposed future isolated route (NOT implemented):** if this is ever served, add a
single auth-gated static route (e.g. `/research-replay → /research/ui/replay.html`) behind
the same login as the app, read-only, with no `api/` write path — to be decided by the
owner, not in this stage.

## How to run / access
```bash
node scripts/research/build-replay.js          # regenerate the frozen dataset
# then view locally (dev-only static server):
npx --yes serve -l 4599 .                       # or any static server at repo root
# open:  http://localhost:4599/research/ui/replay.html
```
The viewer has: left/right dataset selectors, ⏮ first / ◀ step back / step forward ▶ /
last ⏭, and a scrubber. Stepping forward advances exactly one completed candle.

## What each frame shows (only evidence available at that close)
- latest completed **UTC and EAT** close + **freshness** (FRESH / STALE·GAP) and 28-pair sync;
- **12/24/36/48h** price stories (coverage, efficiency, direction, range);
- **latest-12h vs preceding-12h** comparison;
- the **eight-currency strength board** (24h network, relative/zero-sum, ranked, breadth);
- **full-network vs leave-one-pair-out** confirmation (base−quote gap + confirmed Y/N);
- the **event sequence** (balance/departure/test/continuation/rejection/reversal) as-of t;
- **primary state + previous state + transition** (kind);
- **supporting and conflicting reasons** (evidence codes with text) + plain-English explanation;
- **UNAVAILABLE with a reason** on incomplete, stale, or unsynchronized data.

## Side-by-side (the required distinction is visible)
- **Left — Persistent descent (EUR/GBP-like)** with an EUR-weak/GBP-strong network:
  progresses to **ACCEPTED_TREND_DOWN** (independently confirmed YES, breadth 1) only after
  holding lower prices.
- **Right — Shock then recovery (GBP/AUD-like)** with a flat GBP/AUD network: the initial
  fall is **rejected (REVERSAL_UP)**, a late fall is only **EMERGING_MOVE_DOWN**
  (independently confirmed **NO**), and it is **never accepted**.

Verified render (final frames): left `ACCEPTED_TREND_DOWN` / right `EMERGING_MOVE_DOWN`,
both FRESH, 28/28 synced; the data-quality dataset shows `UNAVAILABLE` with
`INSUFFICIENT_DATA`, `INCOMPLETE_COVERAGE (27/28)`, and `STALE_DATA`.

## Labelling / safety
Banner reads **"research classification — not a trade signal"**; pills: READ-ONLY, NO ORDER
PATH, OFFLINE REPLAY. There is **no buy/sell button, no broker path, no alert, no
production route mutation, and no implied live performance**. The footer restates the
no-lookahead and no-live guarantees.

## QA report
`node --test tests/research/replay.test.js` → **7 pass / 0 fail**. Full research suite →
**92 pass / 0 fail**. Production files unchanged (`git status`: only `research/`,
`scripts/research/`, `tests/research/`, `docs/research/`, `.claude/launch.json`).

| Guarantee | How verified | Result |
|---|---|---|
| Cannot display later candles | every event's timestamp ≤ frame close (`events ≤ t`) | PASS |
| Cannot display later swing confirmations | provisional leg `confirmed=false`; pivots' `confirmedAtMs ≤ t` (classifier C4) | PASS |
| No future-adjusted thresholds | `calibrationVersion` constant (`cal-v1`) across all frames | PASS |
| Immutable as-of close | frame at t is byte-identical whether or not later candles exist (truncation test) | PASS |
| UNAVAILABLE reasons | insufficient / incomplete / stale all demonstrated | PASS |
| Fixtures behave | descent → accepted bearish; shock → rejected + emerging, never accepted | PASS |
| Research-only labelling | `meta.disclaimer` + banner + no order path | PASS |

## Limitations
- Fixtures are synthetic; a real-data replay would load `backtest_candles` offline (read-only) — not wired here.
- Mid-only candles ⇒ geometric descriptors, not economic.
- The view is not authenticated/served (by design this stage).
- No strategy/economic evaluation here (stopped before it, per instruction).
