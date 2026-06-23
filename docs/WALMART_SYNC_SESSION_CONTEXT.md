# Walmart Sync — Session Context
> **Read this first at the start of every session touching Walmart synchronization.**
> Last updated: 2026-06-23 after PR #41 merge and live cursor verification.

---

## Current system state (as of 2026-06-23)

### What is live on production (main, dpl_B1p2id…)
| Component | State | Notes |
|---|---|---|
| `api/walmart-sync-cursor.ts` | ✅ LIVE | Single cursor cron, `*/2 * * * *` |
| `api/lib/listed-sync.ts` | ✅ LIVE | `runListedSyncChunk()` extracted from walmart-sync.ts |
| `api/lib/supabase.ts` | ✅ LIVE | Raw PostgREST client, service-role key |
| `supabase: walmart_sync_cursor` | ✅ LIVE | Singleton row id=1, RLS enabled, seeded |
| `api/walmart-oversell-monitor.ts` | ✅ LIVE | Read-only GET, no auth, chunked |
| `api/walmart-zero.ts` | ✅ LIVE | Server-side chunking, limit=50 default |
| `api/walmart-retire.ts` | ✅ LIVE | `getItemLifecycleStatus()` retire guard |
| Fix A (filter bug) | ✅ SHIPPED + VERIFIED | `fetchActiveCtSyncVariants()` uses `status:active tag:ct-sync` connection |
| 25 static listed crons | ❌ REMOVED (PR #41) | Replaced by cursor cron |
| walmart-reconcile cron | ❌ REMOVED (PR #39) | Never audited; do not re-enable without audit |

### Cursor state (live, self-advancing)
- Table: `walmart_sync_cursor` (Supabase project `enhbckomwdelktdhnuzq`, ca-central-1)
- Fires every 2 minutes on production only (crons don't fire on preview deployments)
- Full catalogue pass: ~49 chunks × 2 min ≈ 98 min
- Catalogue size: ~2,446 listed SKUs as of last wrap
- Verified live self-advance: `offset:50 → 250` with no human input post-merge

### Vercel projects
| App | Project ID | Team |
|---|---|---|
| gci-order-hub | `prj_anvgQttOhkbESYZImTMUvV4qB8Fk` | `team_R6Xs0ja1g8YT3dbWt3u0Dv2r` |
| gci-brain | `prj_0i20cZtvVhd2ZbDLW01gs0hRbgwe` | same team |

### Supabase
- Project: `gci-walmart-sync`, ref `enhbckomwdelktdhnuzq`, ca-central-1, Postgres 17
- Service-role key is in Vercel Production + Preview env vars (`SUPABASE_SERVICE_ROLE_KEY`)

---

## Architecture

### Cursor cron tick order (`api/walmart-sync-cursor.ts`)
```
1. Auth: check Authorization: Bearer ${CRON_SECRET}
2. Read cursor: GET /walmart_sync_cursor?id=eq.1
3. Poison-skip guard: if attempt_count >= 3 → skip chunk, advance offset, persist, return
4. Claim: increment attempt_count, persist BEFORE running chunk (survives crash)
5. Run chunk: runListedSyncChunk(offset, limit, dry) → inv_ok, inv_fail, zeroed, heldExposed
6. Advance/wrap: nextOffset = offset + limit; if nextOffset >= totalListed → wrap to 0
7. Persist: update cursor with nextOffset, reset attempt_count=0, last_status, inv counts
```
**Invariant:** cursor writes (steps 4 + 7) fire regardless of `dry`. Only the Walmart inventory push inside `runListedSyncChunk` is suppressed by `dry=true`.

### Fix A invariant (must never regress)
`fetchActiveCtSyncVariants()` in `api/lib/shopify.ts` uses the `products(query:"status:active tag:ct-sync")` connection. This was the root-cause fix for the June 2026 oversell incident. The old `productVariants` query with dotted `product.status`/`product.tag` tokens silently ignored the filter — leaked archived/draft quantities to Walmart. **Never revert this filter.**

Guarantee: Walmart qty is ONLY ever a real active-ct-sync `inventoryQuantity` or 0. No-match → push 0 (never dropped). held/skippedNoCost suppress PRICE only; inventory is always pushed.

### PostgREST client (`api/lib/supabase.ts`)
- Uses `Prefer: return=representation` (not `return=minimal`) — asserts the PATCH returned exactly 1 row
- Throws loudly on 0-row match — the "accepted ≠ applied" guard on cursor persistence
- Auth: `apikey: SERVICE_ROLE_KEY` + `Authorization: Bearer SERVICE_ROLE_KEY` on every request

---

## Operating procedures

### Read cursor state
```sql
-- Run via Supabase MCP on project enhbckomwdelktdhnuzq
select id, current_offset, total_listed, attempt_count, last_status,
       last_inv_ok, last_inv_fail, last_zeroed, consecutive_failures,
       last_run_at, updated_at, now() as db_now
from walmart_sync_cursor where id = 1;
```

Expected healthy state: `last_status: 'ok'` or `'wrapped'`, `consecutive_failures: 0`, `attempt_count: 0`, `last_run_at` advancing every ~2 min.

### Force-advance cursor (for testing or recovery)

```sql
-- Move to specific offset (e.g. tail test):
update walmart_sync_cursor set current_offset = 2400, updated_at = now() where id = 1
returning id, current_offset, attempt_count;

-- Reset to clean start:
update walmart_sync_cursor set current_offset = 0, attempt_count = 0, updated_at = now() where id = 1
returning id, current_offset, attempt_count;

-- Simulate poison-skip (force attempt_count=3):
update walmart_sync_cursor set attempt_count = 3, updated_at = now() where id = 1
returning id, current_offset, attempt_count;
```

### Run a dry tick against preview (verification pattern)

```bash
JAR=/tmp/cursor.jar
BASE='https://gci-order-hub-git-claude-cursor-3ea022-patrick-pierres-projects.vercel.app'

# 1. Mint fresh bypass (REQUIRED after every preview redeploy — cookie dies on redeploy)
#    Get _vercel_share token from Vercel MCP: Vercel:get_access_to_vercel_url
curl -s -c "$JAR" -L 'https://<preview-alias>/?_vercel_share=<token>' -o /dev/null

# 2. Fire dry tick
curl -s -b "$JAR" "$BASE/api/walmart-sync-cursor?dry=true" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -w '\n[HTTP %{http_code}] [%{time_total}s]\n'

# 3. Read the TABLE — the response proves nothing, the table is the verdict
#    (see Read cursor state above)
```

**Expected dry tick response (healthy):**

```json
{"ok":true,"dry":true,"offset":N,"processed":50,"nextOffset":N+50,
 "done":false,"wrapped":false,"totalListed":2446,
 "inv_ok":null,"inv_fail":null,"zeroed":Z,"heldExposed":H,
 "attempt_count":0,"status":"ok","durationMs":~13000}
```

Note: `inv_ok`/`inv_fail` are `null` on dry ticks — Walmart write is suppressed. They populate only on live ticks.

### Run the oversell monitor

```bash
# No auth required, read-only
curl -s 'https://gci-order-hub.vercel.app/api/walmart-oversell-monitor?offset=0&limit=50'
# Walk nextOffset until done:true
# oversellCount > 0 means Walmart qty > Shopify qty for those SKUs
# Self-corrects within ~98 min (next cursor pass)
```

### Run a manual heal walk (break-glass only)
Script: `scripts/walmart-heal.sh` in repo root.
- **Default is DRY=false (live) — read the script before running.**
- Change to `DRY=true` first, confirm chunk-0 output, then set `DRY=false` and re-run.
- `jq` and `curl` are available in Codespace. `vercel` CLI is NOT installed.
- The `dry` param (walmart-sync) ≠ `dryRun` param (walmart-zero/retire/reconcile). See gotchas.
- chunk-1 human gate is built in — do not skip it.

---

## Param split gotcha (critical)
Different endpoints use different query param names for dry-run mode:

| Endpoint | Dry param | Example |
|---|---|---|
| `walmart-sync` | `?dry=true` | `curl .../walmart-sync?dry=true` |
| `walmart-sync-cursor` | `?dry=true` | `curl .../walmart-sync-cursor?dry=true` |
| `walmart-zero` | `?dryRun=true` | `curl .../walmart-zero?dryRun=true` |
| `walmart-retire` | `?dryRun=true` | `curl .../walmart-retire?dryRun=true` |
| `walmart-reconcile` | `?dryRun=true` | (removed — audit before re-enable) |

Body flags are silently ignored on all endpoints. Always use query params.

---

## Known open items (as of 2026-06-23)

### P2 — fix when touching main next
- **`walmart-heal.sh` DRY=false footgun**: `scripts/walmart-heal.sh` defaults to `DRY=false` (live writes) via a committed "Change DRY mode from true to false" commit on main (SHA `51838b0`). Change default back to `DRY=true` or gate behind a `--live` CLI flag to prevent accidental live runs.

### P2 — cost correction pass
- **15 held SKUs** (MB…/M… dual-suffix cluster, e.g. `M1087L`, `MB551L`, `MB4016U`): stored cost is below true CT cost × floor. Consequence: PRICE write is held (Walmart shows stale/wrong price), but inventory is still pushed correctly. These SKUs need a manual cost correction in the CT/Shopify pipeline before prices can sync.

### P3 — verification backfill
- **PR #40 Task 3 (walmart-zero chunking)**: oversell monitor and retire lifecycle were integration-verified on preview. Zero chunking (Task 3) was only unit-tested (18 tests pass). Needs a prod no-op run against 2–3 known-already-zeroed SKUs to confirm `nextOffset`/`done` walk works end-to-end in production. Low risk — walmart-zero is manual-only, no cron invokes it.

### P3 — audit before any re-enable
- **`walmart-reconcile`**: was running on a daily cron on main before PR #39 removed it. Has never been audited for oversell risk. Do NOT re-enable without: `grep -niE "inventoryfeed|quantity|walmartQty|dryRun" api/walmart-reconcile.ts` and a full code review confirming Fix A invariant is respected.

### P3 — hygiene
- **`10987NXK` bare twin**: `TIRE-10987NXK` is the sole live Walmart listing for that tire; the bare twin is unpublished. Publish the bare twin, then retire `TIRE-10987NXK` via `walmart-retire`.
- **`TIRE-170122034`**: correctly resting at qty=0, no twin. No action needed.
- **~649 standing bare orphans**: Walmart listings with no matching active Shopify product. The orphan-sweep cron handles these; confirm it's running on schedule.

### Watch item (post-merge monitoring)
- **`consecutive_failures`**: the poison-skip path (attempt_count ≥ 3) was force-tested in dry mode. A real chunk failure in production hasn't been observed. If `consecutive_failures` climbs or `last_status` shows `skipped` repeatedly, investigate the specific offset — those ~50 SKUs stay stale until the chunk succeeds. The oversell monitor is the backstop.

---

## Key learnings (do not re-learn these)

1. **Accepted ≠ applied** — HTTP 200 / success count / unit-pass / CI-green does NOT mean the write took effect. Always verify ground truth: Seller Center for inventory quantities, the Supabase table for cursor state. This trap recurred on: the leaking filter (Fix A), the `dryRun` body-vs-query bug, the limit=300 crons, and the dry-gates-persistence bug (PR #41).

2. **Bypass cookie dies on every redeploy** — preview deployments are protected by Vercel deployment protection. Must mint a fresh `_vercel_share` token via `Vercel:get_access_to_vercel_url` after every redeploy and prime the cookie jar before curling. Stale cookie → 401 HTML page returned in 0.09s, code never runs.

3. **Vercel env vars apply at deploy time** — setting env vars in the dashboard does NOT affect already-running deployments. Must redeploy after setting. Set in BOTH Preview (to verify) and Production (for live crons).

4. **Crons only fire on production deployments** — preview builds do not run scheduled crons. Dry-tick verification must be triggered manually (curl) against preview.

5. **`limit=300` reliably 504s** — confirmed at exactly ~300s with FUNCTION_INVOCATION_TIMEOUT. Safe operating range: limit=50 (~60s live, ~13s dry). limit=100 is borderline (was used in PR #39 static crons; cursor cron uses 50).

6. **`dry` must not gate cursor persistence** — the dry-gates-persistence bug in PR #41 (all three `updateCursor()` calls wrapped in `if (!isDry)`) was caught by the verification loop: HTTP 200 + correct response body, but `current_offset` stayed at 0 in the table. The fix: remove `if (!isDry)` from cursor writes; keep `dry` only inside `runListedSyncChunk`.

7. **The param split is real** — `walmart-sync` and `walmart-sync-cursor` use `?dry=true`; everything else uses `?dryRun=true`. Body flags are silently ignored. Getting this wrong means you think you're running dry but you're live (or vice versa).
