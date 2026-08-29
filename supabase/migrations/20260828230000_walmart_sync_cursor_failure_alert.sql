-- Migration: walmart_sync_cursor failure-alert tracking
-- Apply manually — NOT run automatically by the agent (see 20260623_walmart_sync_cursor.sql).
--
-- Added after a ~42-hour total outage of walmart-sync-cursor (2026-08-26 to
-- 2026-08-28) went completely unalerted despite the cursor already tracking
-- consecutive_failures. Nothing watched that counter. This column lets the
-- cron send one actionable Telegram alert when failures cross a threshold,
-- then repeat only every N further failures (not every 2-minute tick), and
-- send a single recovery message when it clears.

alter table walmart_sync_cursor
  add column if not exists last_failure_alert_count int;
  -- NULL = no outage alert currently active.
  -- Set to the consecutive_failures value at which the last alert was sent;
  -- cleared back to NULL on the next successful run (recovery).
