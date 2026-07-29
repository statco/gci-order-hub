-- supabase/migrations/20260729_ct_po_number_seq.sql
--
-- Atomic sequence backing the canonical CT PO number format, GCI-<year>-<seq>
-- (e.g. GCI-2026-447267, GCI-2026-447269) — the only shape Canada Tire
-- recognises. buildPoNumber() in api/lib/ct-order-ledger.ts calls
-- ct_next_po_seq() via PostgREST to mint the <seq> portion.
--
-- WHY A SEQUENCE AND NOT A COUNTER ROW: a "select current value, increment,
-- write it back" counter is a race — two concurrent orders can both read the
-- same value before either writes. A Postgres sequence's nextval() is atomic
-- under concurrency by construction, which is the actual requirement here:
-- two concurrent orders must never be handed the same PO number.
--
-- SEEDED AT 447300: manual POs were at 447267 / 447269 as of 2026-07-29. The
-- gap to 447300 is deliberate headroom for manual POs issued the same week
-- this migration lands, so an automated PO can never collide with one a
-- human is issuing by hand in that window.
--
-- NO CYCLE, NO YEAR RESET: the year in the PO number is a label chosen at
-- generation time (see formatPoNumber()), not a partition of this sequence.
-- GCI-2027-447301 simply continues where GCI-2026-447300 left off — resetting
-- the sequence at year rollover would reintroduce exactly the collision risk
-- this migration exists to remove.
--
-- Applied to Supabase project enhbckomwdelktdhnuzq on 2026-07-29 (via MCP,
-- not a follow-up commit). Verified live: sequence exists, start value
-- 447300, NO CYCLE, last_value 447300 with is_called false — meaning
-- nextval() has never been drawn, so the first real call returns exactly
-- 447300, not 447301.

create sequence if not exists public.ct_po_number_seq
  as bigint
  increment by 1
  start with 447300
  minvalue 447300
  no cycle;

-- Exposed via PostgREST RPC rather than a direct Postgres connection: every
-- other Supabase access in this codebase already goes through the REST API
-- (see the rest() helper in api/lib/ct-order-ledger.ts), and Vercel
-- serverless functions have no standing Postgres connection to use instead.
create or replace function public.ct_next_po_seq()
returns bigint
language sql
security definer
set search_path = public
as $$
  select nextval('public.ct_po_number_seq');
$$;

-- Service-role only, matching ct_orders' own access model (see
-- supabase/migrations/20260727_ct_orders_ledger.sql) — nothing client-facing
-- should ever be able to mint a CT PO number.
revoke all on function public.ct_next_po_seq() from public;
revoke all on function public.ct_next_po_seq() from anon;
revoke all on function public.ct_next_po_seq() from authenticated;
grant execute on function public.ct_next_po_seq() to service_role;
