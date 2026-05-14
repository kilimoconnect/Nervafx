-- Cumulative pullback tracking columns on hourly_market_journal
--
-- tracked_pullback_pairs: JSONB array carrying the live set of pairs in a
--   pullback episode. Each entry: { instrument, bias, entered_at, latest_state,
--   latest_conf }. Grows when new pairs enter PULLBACK_STARTING/ACTIVE; entries
--   are only removed on REVERSAL_RISK, bias flip, NO_TRADE, or TREND (episode
--   complete). Pairs that progress to READY_TO_ENTER stay in the set.
--
-- new_pullback_pairs: count of pairs added to the tracked set this cycle
--   (not carried from the previous hour).

alter table hourly_market_journal
  add column if not exists tracked_pullback_pairs jsonb    not null default '[]'::jsonb,
  add column if not exists new_pullback_pairs     integer  not null default 0;
