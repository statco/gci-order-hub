-- supabase/migrations/20260731_walmart_shopify_mirror.sql
--
-- Idempotency ledger for the Walmart-order -> Shopify-order mirror.
--
-- Checked in, NOT YET applied to project enhbckomwdelktdhnuzq (ca-central-1)
-- as of this PR. Apply via the Supabase dashboard / MCP before flipping any
-- code that depends on this table live. Same "checked in first, applied
-- separately" pattern as supabase/migrations/20260729_ct_po_number_seq.sql
-- (see CT-INTEGRATION-CONTEXT.md §5) -- deliberate, not an oversight.
--
-- NAME COLLISION CHECK (done 2026-07-31 against the live project): this
-- table name does not exist today alongside shops, products, walmart_orders,
-- sync_logs, sessions (gci-walmart-sync's Prisma schema), chatbot_customers,
-- chatbot_conversations (gcitires-chatbot), xero_tokens,
-- price_monitor_snapshots (gci-command-center), or this repo's own
-- ct_orders, walmart_order_alerts, walmart_sync_cursor. All of those tables
-- live in the SAME Supabase project as this one (enhbckomwdelktdhnuzq is
-- shared infrastructure, not gci-order-hub's private database -- see
-- CT-INTEGRATION-CONTEXT.md §10). No query anywhere in this PR touches any
-- of those other tables.
--
-- WHY THIS EXISTS: this is deliberately NOT the same guard as ct_orders.
-- ct_orders answers "has this order already been submitted to Canada Tire."
-- This table answers a narrower, upstream question: "has this Walmart PO
-- already produced a Shopify order." The two are independent -- a mirror can
-- succeed while CT routing separately fails/retries/goes manual, and
-- walmart-order-sync's 48h rolling lookback (PR #52) means the same Walmart
-- PO can be fetched and reach this code path across multiple cron runs.
-- Without a guard scoped to the mirror step specifically, that would risk
-- creating a second real Shopify order (and, downstream, a second CT
-- submission attempt) for the same Walmart sale.
--
-- STATUS SEMANTICS (mirrors ct_orders' philosophy for the same reason: a
-- POST to Shopify's Admin API can time out or 5xx AFTER Shopify has already
-- created the order -- retrying blind on that outcome risks a duplicate
-- mirrored order exactly the way a blind CT retry risks a duplicate PO):
--   claimed        Row inserted, Shopify order-creation not yet attempted.
--   mirrored       Shopify order created successfully. Terminal.
--   failed         Definitive rejection (4xx from Shopify -- e.g. malformed
--                  payload). Safe to fix and resubmit; next cron run retries.
--   indeterminate  Timeout / 5xx / network failure. Shopify MAY have already
--                  created the order. NEVER auto-retried by this repo's own
--                  code -- see api/lib/walmart-shopify-mirror.ts. Requires a
--                  human to check Shopify for a matching order (search by
--                  the "gci-walmart-mirror" tag + Walmart PO# in the order
--                  note) before this row is manually moved forward.
--
-- Primary key is walmart_po itself (not a synthetic id) -- the guarantee
-- this table exists to provide IS "one row per Walmart PO," so the natural
-- key is also the right primary key; no secondary unique constraint needed
-- the way ct_orders needs two (it keys on Shopify order id but also has a
-- separately-generated po_number to protect).

create table if not exists public.walmart_shopify_mirror (
  walmart_po            text primary key,
  walmart_order_number  text,                  -- Walmart customerOrderId, when present -- see module header in
                                                 -- api/lib/walmart-shopify-mirror.ts for why this is unverified/optional
  status                text not null default 'claimed'
                        check (status in ('claimed','mirrored','failed','indeterminate')),
  shopify_order_id      text,                   -- numeric Shopify order id, set only on a confirmed 'mirrored' outcome
  shopify_order_number  text,                   -- e.g. "#1043", set only on a confirmed 'mirrored' outcome
  attempt_count         integer not null default 0,
  request_payload       jsonb,                  -- the Shopify order-creation payload actually sent (no credentials in it)
  response_payload      jsonb,                  -- Shopify's response on success
  error_name            text,
  error_message         text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  mirrored_at             timestamptz
);

create index if not exists walmart_shopify_mirror_status_idx on public.walmart_shopify_mirror (status);

alter table public.walmart_shopify_mirror enable row level security;
-- No policies: service-role access only, same pattern as ct_orders and
-- walmart_order_alerts. This table is never client-readable.

create or replace function public.walmart_shopify_mirror_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger walmart_shopify_mirror_set_updated_at
  before update on public.walmart_shopify_mirror
  for each row execute function public.walmart_shopify_mirror_touch_updated_at();
