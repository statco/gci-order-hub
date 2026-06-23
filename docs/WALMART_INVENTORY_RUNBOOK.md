# Walmart Inventory Runbook
> Operational reference for GCI Tires Walmart inventory synchronization.
> See `docs/WALMART_SYNC_SESSION_CONTEXT.md` for architecture and history.

---

## Normal operations (automated, no intervention needed)

The cursor cron runs every 2 minutes on production, advancing one 50-SKU chunk per tick. Full catalogue pass ≈ 98 min. Drift window: any given SKU is at most ~98 min stale.

**Daily health check (30 seconds):**
```sql
-- Supabase project enhbckomwdelktdhnuzq
select current_offset, last_status, last_inv_ok, last_inv_fail,
       consecutive_failures, last_run_at, now() - last_run_at as age
from walmart_sync_cursor where id = 1;
```

**Healthy**: `last_status` = `ok` or `wrapped`, `consecutive_failures` = 0, `age` < 3 minutes.

**Unhealthy signals:**
| Signal | Likely cause | Action |
|---|---|---|
| `age` > 10 min | Cron stopped firing / Vercel issue | Check Vercel runtime logs for `/api/walmart-sync-cursor` |
| `consecutive_failures` > 0 | Walmart API errors or Supabase write failure | Check runtime logs, read cursor table for `last_status` detail |
| `last_inv_fail` > 0 | Walmart feed rejections on specific SKUs | Check which SKUs failed (add logging if needed) |
| `last_status: skipped` repeatedly at same offset | Poison chunk (attempt_count hit 3) | Inspect that offset's SKUs manually; reset attempt_count=0 after fix |

---

## Oversell monitoring

Run the oversell monitor after any inventory event (CT stock change, heal walk, incident):

```bash
curl -s 'https://gci-order-hub.vercel.app/api/walmart-oversell-monitor?offset=0&limit=50'
# Walk nextOffset until done:true
```

`oversellCount > 0` means Walmart qty > Shopify truth for those SKUs. Self-corrects within ~98 min. If delta is large (> 20) or growing, run a targeted heal walk for those SKUs or force the cursor to their offset.

---

## Heal walk (manual, break-glass)

Use only when: cursor cron is confirmed broken, or a specific band needs immediate correction outside the 98-min window.

```bash
# In Codespace /workspaces/gci-order-hub
# ALWAYS read the script first — default is DRY=false (live writes)
cat scripts/walmart-heal.sh | head -20

# Set DRY=true, run chunk 0, confirm output, then set DRY=false
bash scripts/walmart-heal.sh   # script has chunk-1 human gate
```

Heal walk fingerprints (confirmed from 2026-06-23 run):
- 49 chunks at limit=50, offsets 0–2400
- ~2,446 processed, ~497 zeroedNoMatch (graveyard tail, offsets ~1950+)
- 15 held SKUs (MB…/M… cluster, price only — inventory still pushed)
- chunk-0 includes `TIRE-10987NXK` → 277 (exception SKU, legitimate)

Verify applied: after walk, spot-check offset-0 SKUs in Seller Center (`10987NXK`=277, `15412NXK`=53, `MW970S`=5). HTTP 200 from the script is not sufficient — Seller Center is ground truth.

---

## Cursor recovery procedures

### Cron appears stuck (same offset, multiple intervals)

```sql
-- Check state
select current_offset, attempt_count, last_status, consecutive_failures, last_run_at
from walmart_sync_cursor where id = 1;

-- If attempt_count = 3 (poison): reset and skip that offset
update walmart_sync_cursor
set current_offset = current_offset + 50, attempt_count = 0, updated_at = now()
where id = 1 returning id, current_offset;

-- Or reset to beginning if offset is corrupted
update walmart_sync_cursor
set current_offset = 0, attempt_count = 0, updated_at = now()
where id = 1 returning id, current_offset;
```

### Force a specific offset next (e.g. to prioritize a known-drifted band)

```sql
update walmart_sync_cursor
set current_offset = <target_offset>, attempt_count = 0, updated_at = now()
where id = 1 returning id, current_offset;
-- Next cron tick will pick up from target_offset
```

### Verify a manual cursor write took (accepted ≠ applied)
Always follow a cursor SQL write with a SELECT to confirm the row reflects the change. Do not assume UPDATE succeeded.

---

## Retire a Walmart listing

Use `walmart-retire` to remove a listing from Walmart Marketplace:

```bash
# Dry run first — always
curl -X POST 'https://gci-order-hub.vercel.app/api/walmart-retire?dryRun=true' \
  -H 'Content-Type: application/json' \
  -H 'X-Retire-Secret: <secret>' \
  -d '{"sku":"<sku>"}'

# Live — only after dry confirms the right SKU
curl -X POST 'https://gci-order-hub.vercel.app/api/walmart-retire?dryRun=false' \
  -H 'Content-Type: application/json' \
  -H 'X-Retire-Secret: <secret>' \
  -d '{"sku":"<sku>"}'
```

Response includes `lifecycleStatus` (`confirmedRetired` vs `acceptedButPending`). Verify in Seller Center — API response is not ground truth.

---

## Zero out listings (bulk depublish)

Use `walmart-zero` to set qty=0 on a set of SKUs:

```bash
# Dry run first
curl -X POST 'https://gci-order-hub.vercel.app/api/walmart-zero?dryRun=true' \
  -H 'Content-Type: application/json' \
  -H 'X-Zero-Secret: <secret>' \
  -d '{"skus":["SKU1","SKU2"]}'

# Server chunks at limit=50 by default; walk nextOffset until done:true
# Verify applied quantities in Seller Center — do not trust response counts alone
```

---

## Environment variables (Production + Preview)

| Var | Purpose |
|---|---|
| `SUPABASE_URL` | PostgREST base URL (`https://enhbckomwdelktdhnuzq.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS for cursor read/write |
| `CRON_SECRET` | Auth for cursor cron endpoint (`Authorization: Bearer`) |
| `WALMART_RETIRE_SECRET` | Auth for walmart-retire POST |
| `WALMART_ZERO_SECRET` | Auth for walmart-zero POST |

All must be set in **both** Preview and Production environments. Env vars apply at deploy time — must redeploy after adding/changing.

---

## Incident reference

### June 2026 oversell incident
- **Root cause**: `productVariants` query with dotted `product.status`/`product.tag` filter tokens — silently ignored, leaked archived/draft variant quantities to Walmart. ~321 bare listings at qty=100.
- **Fix A**: `fetchActiveCtSyncVariants()` switched to `products(query:"status:active tag:ct-sync")` connection. Never revert.
- **Verified**: code audit (4 claims confirmed) + live Seller Center spot-check post-heal.
- **Handoff doc**: `docs/WALMART_OVERSELL_INCIDENT_2026-06-20_HANDOFF.md`

### Detected post-fix drift (+4 per SKU, June 2026)
- **Cause**: Shopify quantities dropped between the heal walk and monitor check (CT stock pull at 15:00 UTC). Not a bug — genuine stock change. Self-corrected on next cursor pass.
- **Uniform delta artefact**: monitor sorts by delta descending; top samples showing identical +4 is a sort artefact, not a systematic offset.
