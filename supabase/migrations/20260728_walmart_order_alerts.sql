-- supabase/migrations/20260728_walmart_order_alerts.sql
--
-- Per-PO claim table gating the Telegram "new Walmart order" alert.
--
-- Applied to project enhbckomwdelktdhnuzq (ca-central-1) on 2026-07-28 as
-- migration `walmart_order_alerts`. This file is the checked-in copy.
--
-- WHY: api/walmart-order-sync.ts has no per-order tracking today — it uses a
-- time cursor (api/lib/sync-state.ts, Vercel KV) to decide what window of
-- Walmart orders to fetch, plus a separate Google Sheet dedup for logging
-- that is check-then-act (read once, append at the end of the run) and does
-- not guarantee exactly-once behavior across overlapping 15-min cron runs.
-- The unique constraint below is what makes the alert step safe under that
-- overlap: the claim is an INSERT that fails (23505 / 0 rows via
-- ON CONFLICT DO NOTHING), not a SELECT that races.
--
-- Do NOT reuse ct_orders (CT submissions only) or walmart_orders
-- (multi-tenant, owned by the separate gci-walmart-sync app). This table is
-- narrowly scoped to alert-send dedup only — it is not a general order
-- ledger and does not replace the Google Sheet log.

create table if not exists public.walmart_order_alerts (
  walmart_po  text primary key,
  alerted_at  timestamptz not null default now()
);

alter table public.walmart_order_alerts enable row level security;
-- No policies: service-role access only, same pattern as ct_orders.
