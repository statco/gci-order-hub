-- supabase/migrations/20260727_ct_orders_ledger.sql
--
-- Idempotency ledger for Canada Tire order submission.
--
-- Applied to project enhbckomwdelktdhnuzq (ca-central-1) on 2026-07-27 as
-- migration `create_ct_orders_ledger`. This file is the checked-in copy.
--
-- WHY: submitOrder() in api/lib/ct-client.ts is deliberately never
-- auto-retried. A timeout or 5xx after CT has already committed an order
-- would, on retry, create a second real order against an active credit line.
-- The unique constraints below are what make that recoverable: the claim is
-- an INSERT that fails, not a SELECT that races.
--
-- STATUS SEMANTICS
--   claimed          Row inserted, submission not yet attempted.
--   submitted        CT returned success WITH an id. Terminal.
--   indeterminate    Timeout / 5xx / success-without-id. CT MAY have created
--                    the order. NEVER auto-retry. Human reconciliation only.
--   failed           Definitive rejection. Safe to fix and resubmit.
--   manual_required  Insufficient stock, or unknown SKUs present.
--   cancelled        Manually voided.

create table if not exists public.ct_orders (
  id                  uuid primary key default gen_random_uuid(),
  source_channel      text not null check (source_channel in ('shopify','walmart','manual')),
  source_order_id     text not null,
  source_order_number text,
  po_number           text not null unique,
  status              text not null default 'claimed'
                      check (status in ('claimed','submitted','indeterminate','failed','manual_required','cancelled')),
  ct_internal_id      text,
  ct_order_number     text,
  ct_location         text,
  dry_run             boolean not null default true,
  attempt_count       integer not null default 0,
  order_total         numeric(12,2),
  sales_tax           numeric(12,2),
  tire_tax            numeric(12,2),
  shipping_cost       numeric(12,2),
  request_payload     jsonb,
  response_payload    jsonb,
  error_name          text,
  error_message       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  submitted_at        timestamptz,
  constraint ct_orders_source_unique unique (source_channel, source_order_id)
);

create index if not exists ct_orders_status_idx on public.ct_orders (status);
create index if not exists ct_orders_created_idx on public.ct_orders (created_at desc);

alter table public.ct_orders enable row level security;
-- No policies: service-role access only. This table is never client-readable.
-- request_payload / response_payload are redacted of credentials before they
-- are written (see redactSecrets in api/lib/ct-order-ledger.ts), but the
-- absence of policies is the actual containment.

create or replace function public.ct_orders_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger ct_orders_set_updated_at
  before update on public.ct_orders
  for each row execute function public.ct_orders_touch_updated_at();
