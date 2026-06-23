-- Migration: walmart_sync_cursor
-- Purpose: persistent cursor for the cursor-driven walmart-sync-cursor cron.
-- Apply manually — NOT run automatically by the agent.
--
-- After applying, seed the single row:
--   insert into walmart_sync_cursor (id, current_offset) values (1, 0);
-- (the insert is included below)

create table if not exists walmart_sync_cursor (
  id                   int primary key default 1,
  current_offset       int not null default 0,
  total_listed         int,
  attempt_count        int not null default 0,    -- poison-chunk guard: incremented BEFORE each attempt
  last_run_at          timestamptz,
  last_status          text,                       -- 'ok' | 'wrapped' | 'error' | 'skipped'
  last_inv_ok          int,
  last_inv_fail        int,
  last_zeroed          int,
  consecutive_failures int not null default 0,
  updated_at           timestamptz default now()
);

-- Enforce single-row invariant: only id=1 is allowed.
alter table walmart_sync_cursor
  add constraint walmart_sync_cursor_single_row check (id = 1);

-- Seed the cursor row (idempotent).
insert into walmart_sync_cursor (id, current_offset)
  values (1, 0)
  on conflict (id) do nothing;
