# GCI Tires — Cross-Repo Workflow Context

> **Read this first**, before starting any new work in any GCI Tires repo — whether
> you're a human or an AI assistant picking up a session. This file is duplicated
> identically across all 6 repos below so it's available no matter which one you
> land in first. If you update it, update all 6 copies.
>
> **2026-08-08**: gcitires-chatbot chat-timeout fix + first-ever monitoring build-out — see "Session update — 2026-08-08" at the end of this doc.
>
> **2026-08-11**: SEO drift protection (gci-brain) + Walmart listing content sync built (gci-walmart-sync, dormant — app still not installed on any real store, see §2). See "Session update — 2026-08-11" at the end of this doc.
>
> **2026-08-13**: `inventory-reconcile` (gci-brain) fixed a real oversell gap — was reporting national-summed CT stock instead of the max any single CT warehouse holds, since CT can't split-ship. Closes the bug behind a real customer oversell (Ovation Vi-682 155/80R12, SKU 200E2108). See "Session update — 2026-08-13" at the end of this doc, and the correction added to `gci-order-hub/CT-INTEGRATION-CONTEXT.md` § 5a.
>
> Last written: 2026-07-01, last updated: 2026-07-29 end-of-session (after
> the Walmart order-capture root-cause fix + canonical CT PO number format
> pass — gci-order-hub#50/#51/#52/#54/#55 — and a same-night audit of
> gci-walmart-sync that led to shadow-mode order capture, now LIVE — see
> §2's gci-walmart-sync row and §6 item 13). Synced to 3 of 6 copies that
> session (gci-order-hub, gci-brain, gci-walmart-sync); the 2026-08-08 and
> 2026-08-11 updates above have each only reached the repo(s) noted in their
> own bullet — gci-command-center, gcitires-chatbot, and gci-price-monitor
> have not seen any update since 2026-07-29. Status markers:
> ✅ verified working · 🟡 built but not fully live-verified · ⛔ known broken/blocked ·
> 🔲 not yet built.

---

## 1. What this system is

GCI Tires runs an tire e-commerce + wholesale operation (gcitires.ca /
gcitirescanada.com) across **Shopify** (storefront) and **Walmart Canada
Marketplace**, sourced from supplier **Canada Tire (CT)**, with a small network
of independent **installers** dispatched via Airtable. The intent is a largely
autonomous system spanning Operations, Sales & Marketing, Finance, and
Reporting/Monitoring — six repos, one Vercel team (`GCI_Tires projects`), plus
Shopify, Walmart, Airtable, Xero, and Google Analytics 4 as external systems.

**This is not one app.** It's six independently-deployed repos that talk to
each other over HTTP (webhooks + REST calls) and shared external services, not
shared code or a shared database. Before changing anything, know which repo
owns which piece — see the map below — and don't assume a name matches its
actual current purpose (some don't; see §4).

---

## 2. Repo map

| Repo | Role | Deploys to | Status |
|---|---|---|---|
| **gci-brain** | Shopify catalog/SEO/marketing engine. Owns: CT→Shopify catalog sync (`shopifySync.ts`), GMC/Microsoft Merchant feeds, SEO backfill, social media scheduler, blog publisher, installer booking UI (AI Match), `/api/airtable` + `/api/send-email` proxies used by other repos. | `gci-brain.vercel.app`, custom domain `match.gcitires.com` | ✅ core catalog/SEO pipeline working. ⛔ GMC account suspended (business action needed, not code). See §5. |
| **gci-order-hub** | Order automation for GCI's own Shopify store: Shopify `orders/paid` webhook → routes to CT (TIRE- SKUs) → installer dispatch → Walmart price/inventory cron sync (`/api/walmart-sync`, `/api/walmart-sync-cursor`, `/api/walmart-ship`, etc.) → separately, `/api/walmart-order-sync` (Walmart *order capture*, not price/inventory — every 15 min, mirrors new Walmart orders into a Google Sheet, acknowledges them on Walmart, Telegram-alerts the team) — more routes live than the README documents, check the actual `api/` folder. CJ Dropshipping (NUPROZ- SKU) routing removed 2026-07 — see §3/§4. | `gci-order-hub.vercel.app` | ✅ core routing working. ✅ Walmart order capture fixed 2026-07-29 after being silently broken (§6.12) — verify this stays fixed, it has failed silently before. 🟡 CT auto-PO switch built, dormant (§6). |
| **gci-command-center** | Internal ops dashboard — Sales/Marketing/Finance/IT/Content, one React app. Pulls Shopify + GA4 + Xero into one place. Also runs the Walmart discount-rotation system (`/promotions`). | `gci-command-center-ofzf` (custom domain `ops.gcitires.com`). The old duplicate plain-`.vercel.app` project was **deleted 2026-07-02** — there is now only one. | ✅ Fully verified 2026-07-02: all 4 dashboard widgets confirmed against real source data (Shopify orders/revenue, GA4 sessions, Xero invoices). Xero re-authed + root-cause fixed (§6.10), GA4 re-authed with a new service account (§5). |
| **gcitires-chatbot** | Customer-facing AI chat widget embedded on the storefront. Memory/conversation history migrated 2026-07 from Airtable to Supabase (`chatbot_customers`/`chatbot_conversations` tables in the shared `gci-walmart-sync` Supabase project) — fixes the old `/api/memory` timeout problem. | `gcitires-chatbot.vercel.app` | ✅ Migration COMPLETE 2026-07-02. ✅ 2026-08-08: fixed `/api/chat` 30s timeouts caused by unbounded parallel `search_catalog` fan-out (PR #29) and added its first-ever monitoring — `api/health-check.ts` cron (every 30min) + Telegram alerting via new `lib/telegram.ts`. See "Session update — 2026-08-08" at the end of this doc for full detail. |
| **gci-walmart-sync** | **Standalone commercial Shopify app** (Remix, Shopify App Store template) for Walmart CA Marketplace sync — listings, price, inventory, orders, returns. Built first for GCI, intended to be **published commercially** once ready. **Still not installed on any real Shopify store**, GCI's included. | `app.gcitires.ca` (+ `gci-walmart-sync.vercel.app`) | 🟡 CC-1 through CC-12 built and compiling, feature-complete on paper, no real Shopify merchant has ever installed it. ✅ **2026-07-29**: its order-ingestion cron is now LIVE-capturing GCI's real Walmart orders in **shadow mode** (`docs/SHADOW-MODE.md`) for comparison against gci-order-hub — read that file AND `docs/SCOPE-NOTE.md` before assuming either "just a test app" or "the real pipeline now": both are wrong on their own, see §6 item 13. 🟡 **2026-08-11**: reactive listing content sync (Title/SEO Title/Description/SEO Description → Walmart productName/shortDescription) built and deployed (gci-walmart-sync#25), fires off the same `PRODUCTS_UPDATE` webhook as price sync — but dormant like everything else here, since the app still isn't installed on a real store; never run against real data. See its own `docs/SESSION-CONTEXT.md` for full build history. |
| **gci-price-monitor** | Daily competitor tire-price scraper (Python/Playwright), **runs via GitHub Actions, not Vercel** — despite having a `vercel.json`, that file is an unused stub. Reports via Telegram. Persistence migrated 2026-07 from local SQLite to Supabase (`price_monitor_snapshots` table, same shared project) — real day-over-day trend data now possible for the first time. | GitHub Actions cron (`.github/workflows/price_monitor.yml`, daily 8AM EST) | ✅ Merged (gci-price-monitor#4) and verified end-to-end via a real `workflow_dispatch` production run (real scrape, real Supabase insert, confirmed via direct SQL). `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` secrets set on the repo. First real historical trend data started accruing 2026-07-01. |

**Explicitly not part of this system**, despite living in the same Vercel team:
`nuprozone`, `gci-finance-website`, `gci-corporate-website` — unrelated projects,
don't touch without separately confirming scope.

---

## 3. External systems and where their credentials live

| System | Used by | Auth pattern | Notes |
|---|---|---|---|
| **Shopify** (`gcitires-ca.myshopify.com`, plan: Basic) | All 6 repos, in different ways | Admin API token (`SHOPIFY_ADMIN_API_TOKEN` — watch for the older `SHOPIFY_ADMIN_TOKEN` name still lurking in some scripts, see gci-brain's project file) | **Basic plan** — no checkout extensibility / arbitrary custom-priced cart lines. Anything needing dynamic pricing (e.g. installation fees) has to use fixed-price product tiers, not true custom amounts. |
| **Canada Tire (CT)** | gci-brain (catalog read), gci-order-hub (PO submission, dormant) | OAuth 1.0a (NetSuite RESTlet pattern) — Consumer Key/Secret, Token ID/Secret, Realm `8031691` | **Currently READ-ONLY** (`customscript_item_search_rl` — catalog/price search only). No order-creation endpoint exists yet. Credit line + API access reportedly coming — ask before assuming it's ready. |
| **Walmart Canada Marketplace** | gci-order-hub (live), gci-command-center (live, discount rotation), gci-walmart-sync (built, not activated) | OAuth2 client_credentials, `WM_MARKET: ca` header, `WM_SEC.ACCESS_TOKEN` (not Bearer) | Multiple independent Walmart clients exist across repos — `gci-order-hub/api/lib/walmart-client.ts` is the oldest/most battle-tested; port patterns from there, don't reinvent. |
| **Airtable** (`GCI Installer Portal` base) | gci-brain (owns `/api/nearby-installers` + `/api/submit-installer-application`, both narrow/safe; `/api/airtable` itself is now server-to-server only), gci-order-hub (calls `/api/airtable` with the shared secret). **gcitires-chatbot no longer uses Airtable at all as of 2026-07** — migrated to Supabase, see §2. | Server-side API key, held by gci-brain only | ✅ Fixed 2026-07 (gci-brain#129, gci-order-hub#44, merged). `/api/airtable` now requires `X-Internal-Secret` (env var `INTERNAL_API_SECRET`, must match across gci-brain + gci-order-hub) and is unreachable from any browser. The two browser-facing use cases (installer search, application submission) moved to purpose-built endpoints that never expose PII fields. |
| **Xero** | gci-command-center (Finance page + dashboard widget) | OAuth2, **rotating** refresh token, persisted in Supabase (`xero_tokens` singleton table) | ✅ Fixed 2026-07-02 at the ROOT CAUSE (gci-command-center#23): Xero rotates refresh tokens on every use; the old code discarded the new token each time, so the integration broke after every single successful call — this is why it kept "expiring" for months. `getAccessToken()` now reads/writes the token via Supabase; the env var `XERO_REFRESH_TOKEN` is bootstrap-only. Re-auth flow (`/api/xero?resource=auth-url` → callback) now saves straight to Supabase, no env-var copy-paste. Verified with two consecutive live calls (the old bug always failed the second one). |
| **GA4** | gci-command-center (Marketing page + dashboard widget) | Service account (static private key, signs a JWT per request — NO rotating token, structurally immune to the Xero bug class, explicitly confirmed) | ✅ Fixed 2026-07-02: the original service account key was unrecoverable (Vercel "sensitive" env vars can't be read back, even via CLI). Created a NEW dedicated service account `gci-command-center-ga4@gci-price-monitor.iam.gserviceaccount.com`, granted Viewer on property `526079137`, full JSON key in `GA4_SERVICE_ACCOUNT_KEY`. Verified live with real session data. |
| **Microsoft Merchant Center** (store 50034512 "GCI Tires Canada") | gci-brain (feed endpoint `api/feed/microsoft` — live TSV, ~1,963 active products) | Feed pulled by Microsoft from a public URL, no auth; Ads managed in the Microsoft Advertising UI | ✅ Connected 2026-07-02. Feed live + validated (1,963 active, 0 rejected). A minimal Standard Shopping campaign ("GCI - Shopping - Starter", $5 CAD/day, Enhanced CPC $1, Canada-only, all products) exists because Microsoft requires ≥1 active campaign even for FREE listings. 🟡 Watch item: "not targeted products" store warning attributed to ~12h sync lag — confirm it cleared. |
| **Make.com** (team 2205971, zone us2) | gci-brain's social-scheduler posts to its webhook; the Make scenario (id 4867071) is what ACTUALLY publishes to Instagram/Facebook/Pinterest — no repo calls those platforms directly | Webhook URL in `MAKE_WEBHOOK_URL` (gci-brain); API token in `MAKE_API_TOKEN` (gci-order-hub, for the health check) | ⚠️ READ §4 — this was the biggest blind spot found in the whole audit. The scenario was OFF from creation (Apr 26) to Jul 2 with zero error signal anywhere, because Vercel only sees "webhook accepted". Now monitored by a daily health check (gci-order-hub#46, `/api/health-check-make`, cron 10:00 UTC) that alerts via Telegram if the scenario is paused OR hasn't executed in 3 days. |
| **Telegram + Resend** | gci-order-hub, gci-command-center, gci-price-monitor, gci-brain (as of 2026-07-02), **and gcitires-chatbot as of 2026-08-08** (health-check alerts — `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID_ACTIONABLE`/`TELEGRAM_CHAT_ID_INFO` added to gcitires-chatbot's Vercel env vars; `TELEGRAM_CHAT_ID_ACTIONABLE`=`901641030` set, `TELEGRAM_CHAT_ID_INFO` still needs setting — see session update at end of doc) | Bot token / API key per repo | Straightforward. Note: env vars do NOT propagate across Vercel projects — a repo "having Telegram" means ITS project has the vars set. |
| **Supabase** (project `gci-walmart-sync`, ref `enhbckomwdelktdhnuzq`, region `ca-central-1`) | gci-walmart-sync (original owner — `shops`/`products`/`walmart_orders`/`sync_logs`/`sessions`/`walmart_sync_cursor` tables), gcitires-chatbot (`chatbot_customers`/`chatbot_conversations`, added 2026-07), gci-price-monitor (`price_monitor_snapshots`, added 2026-07), **and gci-order-hub** (`ct_orders`, `walmart_order_alerts`, added 2026-07-27/28 — despite `gci-order-hub`'s own env-var naming, its data actually lives in the `gci-walmart-sync`-named project) | Service role key, held server-side only per repo | Reused deliberately across all four rather than provisioning separate paid projects. RLS enabled on every table, no permissive policies for anon/authenticated — service_role-only access pattern, consistent across all tenants of this project. If you add a new table here for a new use case, follow the same pattern. ⚠️ **Found 2026-07-29**: a SECOND, separate, entirely empty Supabase project literally named `gci-order-hub` (ref `gqaylwkfiokwsccibvxg`, created 2026-07-29) also exists in this org — a real trap for "apply the migration to the gci-order-hub project" without checking which one actually has the tables first. Always verify with `list_tables` before applying a migration by project *name* alone. |
| **CJ Dropshipping** | none — removed 2026-07 | — | **Was dead code (`NUPROZ-` SKU path in gci-order-hub), now fully removed** (gci-order-hub#45). nuprozone.com was discontinued due to brand conflicts; confirmed permanent, not paused. |

---

## 4. Things that look like one thing but are another (read before assuming)

- **`gci-order-hub` vs `gci-walmart-sync`**: both touch Walmart, but they are not
  duplicates. `gci-order-hub` is GCI's live production Walmart price/inventory
  cron. `gci-walmart-sync` is a separate, not-yet-activated commercial Shopify
  app being built for eventual Shopify App Store publication. Don't consolidate
  them without explicit instruction — they serve different purposes and have
  different audiences (GCI-only vs. multi-tenant).
- **`gci-command-center` Vercel project**: only ONE exists now — `-ofzf`
  (`ops.gcitires.com`). The old duplicate plain-`.vercel.app` project was
  deleted 2026-07-02. If an old doc/memory references two, it's stale.
- **Social posting does NOT go from code to the platforms.** gci-brain's
  social-scheduler only POSTs a payload to a Make.com webhook; a Make.com
  scenario is what actually publishes to Instagram/Facebook/Pinterest.
  Consequence: a "success" in Vercel logs only means "webhook accepted" —
  it says NOTHING about whether anything was published. This scenario sat
  OFF for 2+ months (Apr 26 → Jul 2) with every Vercel log showing success,
  while ~19 posts silently queued. When investigating "did X actually post",
  check Make.com's scenario status + execution history (or the daily health
  check's Telegram alerts, live since 2026-07-02), never Vercel logs alone.
- **`gci-price-monitor`'s `vercel.json`**: present but unused. The real
  execution engine is GitHub Actions. Don't spend time debugging Vercel
  deployments for this repo — there's nothing meaningfully deployed there.
- **The AI Match checkout** (gci-brain, `CheckoutModal.tsx`): as of 2026-06-30
  this **did not create real Shopify orders or collect payment at all** — it
  simulated success locally. Fixed 2026-07-01 (PRs gci-brain#125, #126,
  gci-order-hub#42) to use Shopify's real Cart API + a post-payment webhook
  for installer dispatch. A second, separate bug surfaced immediately after
  via a real manual test: the redirect to real checkout used
  `window.location.href`, which only navigates the iframe AI Match actually
  runs inside on the real storefront (`templates/page.gci-ai-match-landing.liquid`
  on the Dawn theme) — Shopify's checkout refuses to load inside any iframe
  whose top-level page isn't a Shopify domain, so it silently failed. Fixed
  2026-07-02 (gci-brain#128, `window.top!.location.href`), verified working
  via a real completed checkout page (screenshot). If you're reading an old
  summary/memory of this system, distrust anything about checkout that
  predates 2026-07-02, not just 2026-07-01.

- **TIRE- SKU prefix**: legacy. Most live Shopify products use native/mixed
  SKU formats now, not the `TIRE-` prefix. Filter by `status:ACTIVE AND
  productType:Tire`, not by SKU prefix, when querying the live catalog (see
  gci-command-center's CONTEXT.md §2 for the full reasoning — this was a
  hard-won lesson from real bugs).

---

## 5. Known issues open as of 2026-07-29 (business/config, not code)

These need a human action outside any repo's code — don't try to "fix" them
with a code change:

1. **GMC (Google Merchant Center) account suspended** — reinstatement blocked
   on a commercial-name update requirement. Deliberately PARKED by owner
   choice 2026-07-02 (Microsoft Merchant Center pursued instead). See
   gci-brain's project file.
2. **CT order-creation API** — ⚠️ **This entry was materially stale and was
   corrected 2026-07-27.** The API *does* exist. As of 2026-07-27: the credit
   line is **active**, blind drop-ship is **configured account-level**, OAuth
   1.0a HMAC-SHA256 is **verified working** against production realm 8031691,
   and `api/lib/ct-client.ts` was rewritten (gci-order-hub#47) to the real
   V1.4 contract — **the payload shape is no longer a guess**. An idempotency
   ledger (`ct_orders`) was added in gci-order-hub#48. The PO number format
   was corrected 2026-07-29 (gci-order-hub#51): `buildPoNumber()` previously
   emitted `GCI-S-<shopifyOrderNumber>` / `GCI-W-<walmartPO>`, a shape CT has
   never recognized — it now emits CT's actual `GCI-<year>-<seq>` format
   (matching CT's own manual POs, e.g. `GCI-2026-447267`) via a new atomic
   Postgres sequence. ✅ That sequence's migration
   (`supabase/migrations/20260729_ct_po_number_seq.sql`) **has been applied**
   to the live Supabase project (2026-07-29, `ct_po_number_seq` seeded at
   447300, verified `is_called: false` so the first real PO will be exactly
   447300) — note the tables/sequence for `gci-order-hub` actually live in
   the Supabase project *named* `gci-walmart-sync` (ref
   `enhbckomwdelktdhnuzq`), not a same-named `gci-order-hub` project (a
   separate, empty, likely-stray project with that name also exists — see
   §3's Supabase entry, which needs a similar correction).
   Still blocked on: **CT sandbox credentials** (requested from the rep,
   pending), and the Submit Order endpoint has **never been called** in any
   environment. All three safety gates remain closed
   (`CT_AUTO_PO_ENABLED` unset, `CT_DRY_RUN` defaults true,
   `CT_ENVIRONMENT` defaults sandbox) — no real order can be placed today.
   ⛔ Do not enable anything CT-related without first reading
   **`gci-order-hub/CT-INTEGRATION-CONTEXT.md`**, which is the
   authoritative record and lists several verified-by-inspection-only gaps.
3. **15 outreach prospects have no email on file** — real Ontario/Quebec
   shops stuck at "New" in Airtable's `Outreach Prospects` since ~Apr 25,
   never contacted. The weekly outreach run now Telegram-alerts this list
   (see §6.9), but filling in the emails is manual research/data entry.
   One record has an email typo'd into the *Shop Name* field
   (`gar.rheault@gmail.com` where "Garage Rheault" should be) — quick
   manual Airtable fix.
4. **27 stale `TIRE-` SKU listings on Walmart** — orphaned Seller-Center-side
   (zero ACTIVE Shopify products carry that prefix anymore); needs a manual
   Walmart Seller Center lookup/rename. Not enumerable from Shopify data.
5. **Microsoft Shopping campaign is brand new** — monitor first serves,
   confirm the "not targeted products" store issue cleared after sync
   (~12h window from 2026-07-02), and revisit the $5/day budget / $1 CPC
   once real click data exists.

RESOLVED (formerly here): Xero token expiration (root-caused + fixed in
code, §6.10 — it was never really a "config" issue) and GA4 service-account
access (new dedicated service account, §3).

## 6. Known issues (code) — status as of 2026-07-29

**Fixed and merged:**
1. **`gci-brain`'s `/api/airtable` proxy** — was unauthenticated + open CORS, exposing installer PII (bank info) to any customer's browser during normal AI Match use. Fixed (gci-brain#129, gci-order-hub#44, both merged) — see §3 credential map.
2. **`gcitires-chatbot`'s `/api/memory` timeouts** — migrated Airtable → Supabase. COMPLETE: code merged (#27), env vars set, historical migration run against production 2026-07-02 — 19,275 customers verified in Supabase (all unique, 0 nulls). A batch-dedup bug found during the real run was fixed in #28 (Airtable had duplicate customer_ids that broke Postgres multi-row upsert).
3. **`gci-price-monitor`'s SQLite persistence** — migrated to Supabase, merged (#4), verified via a real production `workflow_dispatch` run + direct SQL.
4. **Deprecated Claude model references** (`blog-publisher.ts`,
   `social-scheduler.ts`, `generateSeoDescriptions.ts` in gci-brain) —
   ⚠️ CAUTIONARY TALE: the original audit *documented this as fixed without
   the code change ever shipping*. It kept failing for ~6 weeks total
   (confirmed via Vercel runtime errors) until 2026-07-02, when the gap was
   caught by re-verifying against the actual code instead of trusting this
   doc. Actually fixed in gci-brain#130 (`claude-sonnet-4-20250514` →
   `claude-sonnet-4-6`), then live-verified by triggering a real
   blog-publisher run. LESSON: "documented as fixed" ≠ "deployed" — always
   verify claims in this file against `git log` / live behavior.
5. **27 Walmart listings still carry a stale `TIRE-` SKU prefix** in Seller
   Center, causing silent no-ops on price sync for those specific listings.
   Confirmed 2026-07: **zero currently-ACTIVE Shopify products have a
   `TIRE-` SKU anymore** (all archived/draft) — these are orphaned
   Walmart-side listings referencing SKUs that no longer exist in the live
   catalog at all. Can't be enumerated from Shopify data; needs a direct
   Walmart Seller Center lookup (no Walmart connector was available to
   pull this automatically). Fix: rename/relist in Seller Center, no code
   change needed.
6. **Installer application form was silently dropping submissions
   entirely** — two separate bugs, both fixed: (a) it posted to a
   nonexistent Airtable table ('Installer Applications') — every real
   application ever submitted had failed; fixed in gci-brain#129, now
   writes to the real `Installers` table (`Status: Pending Review`).
   (b) Found via a real live test POST 2026-07-02: values not in
   Airtable's configured select options (e.g. NT province — in the form's
   dropdown but not in Airtable) rejected the whole submission with
   INVALID_MULTIPLE_CHOICE_OPTIONS; fixed with `typecast: true`
   (gci-brain#133). Airtable's real Payment Method options are
   'E-transfer' (lowercase t) / 'Bank Transfer' / 'Cheque'.
7. **`gci-order-hub`'s dead NUPROZ- (nuprozone.com) routing code** —
   removed (gci-order-hub#45). Confirmed permanently discontinued.
8. **Blog-publisher JSON parsing failures (2/4 posts failing)** — found by
   live-triggering the model fix's verification run. Two causes, both
   fixed in gci-brain#131: `max_tokens` 2000→4000 (French posts routinely
   exceeded it, truncating mid-string), and a string-literal-aware
   `sanitizeJsonControlChars()` for raw newlines the model sometimes emits
   inside JSON string values. 🟡 Not yet re-verified 4/4 live (would
   publish more real posts); next natural cron is Monday 12:00 UTC.
9. **Social-scheduler published AI preamble text as captions** — found by
   live-triggering Instagram: got caption "Here's a bilingual Instagram
   caption for GCI Tires:" + hashtags "---". Fixed in gci-brain#132 with
   3 layers: explicit no-preamble instruction in the shared CTX() prompt,
   defensive preamble-stripping in parsePost(), and — the real safety
   net — `validatePayload()` which refuses to forward anything
   preamble-shaped/empty to the Make.com posting webhook. The broken test
   item was deleted from Make's queue before it could publish. Also: the
   weekly installer-outreach run now Telegram-alerts prospects skipped
   for missing email + send failures (gci-brain#134, verified end-to-end
   with a real received Telegram message); silent on clean runs.
10. **Xero integration broke after every single successful call** — THE
    root cause of months of recurring "token expired": Xero rotates
    refresh tokens on every use, and the old `api/xero.ts` discarded the
    new token from each response. Fixed in gci-command-center#23:
    `xero_tokens` Supabase singleton table, read before each refresh,
    rotated token saved back after; OAuth callback saves directly to
    Supabase (no more env-var copy-paste, which was itself the fragile
    step). Verified with two consecutive live calls — the old bug always
    failed call #2. GA4 explicitly confirmed NOT vulnerable (static
    service-account key, no rotation).
11. **Make.com scenario health check** (gci-order-hub#46,
    `/api/health-check-make`, daily cron 10:00 UTC) — added after the §4
    incident. Checks isPaused + last-execution recency (3-day threshold)
    + last execution status; Telegram-alerts on problems, silent when
    healthy. Verified live against the real Make.com API. Gotcha for
    future work: Make's logs endpoint requires URL-encoded pagination
    params (`pg%5Blimit%5D`, not `pg[limit]`).
12. **Walmart order capture was silently broken end-to-end** — a real
    order (`600000102653105` / PO `309121065891123`, confirmed present in
    Walmart Seller Center) never appeared in any log, with zero cron
    errors, `walmart_order_alerts` empty. Two independent bugs stacked, and
    a per-order Telegram alert (gci-order-hub#49, merged 2026-07-27) had
    never actually fired because of them:
    - `fetchCreatedOrders()` filtered client-side for order-line
      `status === 'Created'`. Live-queried directly against Walmart: this
      account's CA marketplace orders arrive already `status: 'Acknowledged'`
      — Walmart never sends `'Created'` here. The filter matched nothing,
      ever, on every single run. Fixed in gci-order-hub#50 (filter removed
      entirely; dedup already handled downstream, see next bullet).
    - Even after that fix, `createdStartDate` was still bounded by the KV
      sync cursor — a ~15-minute window on a healthy cron. Two live
      unshipped orders had already aged out of every window the cursor
      ever produced. Fixed in gci-order-hub#52: `createdStartDate` now
      comes from a fixed rolling 48h lookback from "now"
      (`ORDER_SYNC_FETCH_LOOKBACK_HOURS`), decoupled from the cursor (which
      is kept for heartbeat/observability only). Safe to re-fetch the same
      window every run because `walmart_order_alerts` (unique constraint on
      `walmart_po`, claim-before-send) and the Google Sheet dedup both gate
      on identity, not on the fetch window.
    - Also in #52: seller-cancelled orders (2 of 6 in this account) are now
      excluded from alerting (still acknowledged/logged, just not alerted).
    - **One historical order remains suppressed by design**: PO
      `309120965612142`'s order date predates the alert backfill cutoff
      (`getOrInitAlertCutoffMs()`, bootstrapped ~2026-07-28T02:00 UTC on
      first run after #49 deployed) by about 24h, so the guard will never
      alert on it automatically — that's the guard working as intended, not
      a bug. See item 17.
    LESSON — same shape as §6.4/§4: a per-order alert can be merged, "on"
    according to every log, and still have never fired once, because the
    thing feeding it was broken upstream. Verify by finding a real known
    order and confirming it actually shows up, not by confirming the alert
    code compiles and the cron has no errors.
13. **Shadow-mode order capture built AND live** (gci-walmart-sync#23,
    merged 2026-07-29) — evidence-gathering for a question raised the same
    night: gci-walmart-sync's own `docs/SCOPE-NOTE.md` (2026-07-27, written
    directly by the account owner) established it as a separate commercial
    app deliberately in test mode, explicitly NOT GCI's order pipeline; a
    later same-night session considered activating it as a replacement for
    gci-order-hub's Walmart plumbing instead. Rather than decide blind, one
    Shop row (`shopifyDomain: 'shadow-mode.internal'`, `shadowMode: true`)
    was given real GCI Walmart CA credentials — registered live
    2026-07-29T05:25 UTC via the new `POST /api/admin/shadow-shop`
    — but no real Shopify install. `order-ingestion` captures real orders
    for it into `walmart_orders` exactly like any other shop, then
    deliberately stops: never creates a Shopify order, never acknowledges
    on Walmart. Every other cron there (`price-reconcile`, `returns-poll` —
    which issues real refunds — `feed-status-poll`) stays billing-gated
    and silently skips it.
    **This is data collection, not a decision.** `docs/SCOPE-NOTE.md` still
    stands; gci-order-hub remains the live pipeline until someone actively
    decides otherwise.
    Also rotated that night: gci-walmart-sync's `CRON_SECRET` (Vercel
    marks it "Sensitive" — write-only, unrecoverable — so the old value
    couldn't be read back to make the registration call; regenerated
    instead). Gates all 4 crons in that project; Vercel's own cron
    dispatcher picks up the new value automatically.
    **Next step, not yet done:** once real orders have accumulated,
    compare `walmart_orders` (`shop.shadowMode = true`) against
    gci-order-hub's Sheet log for the same `walmartOrderId`s, then decide
    on a cutover — which would mean a real Shopify install, disabling
    gci-order-hub's Walmart order-sync cron, and adding Telegram alerting
    to gci-walmart-sync (it currently has none; failures just log).

**Still open (code-adjacent):**
14. **`gci-brain/api/send-email.js`** — CORS-restricted but no server-side
    auth; same class of issue as the old Airtable proxy, lesser severity.
    Flagged, not yet fixed.
15. **Xero auth-url/callback endpoints have no caller auth** — lower risk
    (completing the flow still requires a real Xero login), but worth a
    shared-secret lockdown eventually.
16. **Blog-publisher 4/4 re-verification** — see item 8; check the Monday
    cron's output or trigger deliberately (publishes real posts).
17. **Manual one-time alert for PO `309120965612142`** — see item 12's last
    bullet. The endpoint now exists (gci-order-hub#55, merged:
    `POST /api/admin-alert-order?po=<id>`, `Bearer CRON_SECRET`) but has
    never been invoked — the order is still unalerted. Not yet done.

---

## 7. Working conventions across these repos

- **Port from confirmed-working implementations, don't reconstruct from
  memory or docs.** Several of these integrations (Walmart auth headers, CT
  OAuth signing) were hard-won through real debugging. If you need a Walmart
  or CT client and one already exists in another repo, copy its exact
  headers/URLs/error-handling rather than re-deriving them.
- **Feature branches + PRs, not direct pushes to `main`**, for anything
  beyond a trivial fix. Branch naming varies slightly by repo (`claude/*` is
  most common) — check each repo's existing branches before naming a new one.
- **Run `npx tsc --noEmit` (and `npm run build` / `vite build` where
  applicable) before merging, in a real environment with `node_modules`
  installed.** Don't trust a sandbox that couldn't install dependencies —
  verify for real. (This audit caught a real bug this way that a
  dependency-less sandbox review missed.)
- **Don't dispatch anything (installer, supplier PO, customer email) before
  payment is confirmed.** The 2026-07-01 checkout fix exists specifically
  because this rule was violated — client-side code created real-world
  side effects (installer jobs, emails) before any payment had happened.
  Anything with a real-world consequence belongs in a webhook handler that
  fires after Shopify (or Walmart) confirms the transaction, not before.
- **When in doubt about a repo's actual current state, read its code, not
  just its README/docs.** Several docs across this system were found
  meaningfully out of date during the audit that produced this file —
  including, ironically, this file will eventually become outdated too.
  Trust `git log` and the actual source over prose descriptions when they
  conflict. The deprecated-model incident (§6.4) is the canonical example:
  this very file claimed a fix was done that had never shipped.
- **Verify fixes by triggering the real thing and checking the real data
  store, not by reading code or logs alone.** Every significant bug found
  on 2026-07-02 (fake checkout, Make.com dead scenario, blog JSON
  failures, social preamble bug, installer typecast bug, Xero rotation)
  was found or confirmed by a live trigger + a direct query against the
  source of truth (Shopify GraphQL, Supabase SQL, Airtable schema, a real
  Telegram message). Ask before triggering anything with real-world side
  effects (emails, social posts, payments).
- **A "success" log only proves the hop you can see.** If a workflow
  crosses into a second system (Make.com, Walmart, Airtable), verify in
  THAT system. gci-brain logged success for months while Make.com
  published nothing (§4). When adding a new cross-system dependency, add
  a health check for the far side at the same time (pattern:
  gci-order-hub's `/api/health-check-make`).

---

## 8. Where to go for more detail

Each repo has its own deeper docs — read the relevant one(s) before starting
work in that repo specifically:

- `gci-brain`: `GCI_Tires_Project_File.md`, `CLAUDE.md`
- `gci-order-hub`: `README.md` (partially stale — check actual `api/` folder
  contents against it); **`CT-INTEGRATION-CONTEXT.md`** — authoritative
  Canada Tire + Walmart-order-routing record, read before any CT work;
  `CT-SESSION-PROMPTS.md` — ready-to-run implementation prompts
- `gci-command-center`: `CONTEXT.md` (detailed, mostly current as of
  2026-06-15)
- `gci-walmart-sync`: `docs/SESSION-CONTEXT.md` (detailed build history,
  written for exactly this "prime a new session" purpose)
- `gcitires-chatbot`, `gci-price-monitor`: `README.md`, `SETUP_GUIDE.md`,
  `WORKFLOW.md` (price-monitor)

---

## 9. Shopify Dawn theme (gcitires-ca) — live edits, 2026-07-05 (no git tracking)

**Important context for future sessions:** the Shopify theme itself is edited
directly through Shopify's own code editor — it is NOT in any of the 6 repos
above and has no git history. This section is the only record of what
changed. If a future session needs to know "what does the live theme look
like right now," trust this over assumption, and verify live before further
edits (the theme editor has per-file version history / undo, but no commit
log — check that first if something looks off before re-deriving a fix).

**Editor quirk, worth knowing before touching theme files:** pasting
multi-line code (especially anything with lines starting `<`, like HTML
tags) into Shopify's code editor can silently strip leading characters on a
normal paste. **Use Ctrl+Shift+V (paste as plain text)** for every paste into
this editor — this fully resolved every "my paste didn't work / rendered
broken" issue hit this session.

### 9.1 Empty/out-of-stock brand nav suppression + mega-menu restructure
- New snippet `snippets/gci-is-empty-brand.liquid`: shared helper, returns
  `"true"`/`"false"` string. Suppresses nav links to collections with 0
  products, plus a hardcoded fallback list (`falken-tires, gt-radial-tires,
  maxtrek-tires, starfire-tires`) for known-empty brands. **Important
  bugfix baked in:** only evaluates product count when `collections[link.handle]`
  resolves to a real collection — earlier version wrongly suppressed
  non-collection links (Home, Shop/all-collections) because a missing
  collection defaulted product_count to 0 via `| default: 0`.
- `snippets/gci-nav-brand-link.liquid`, `snippets/header-dropdown-menu.liquid`,
  `snippets/header-mega-menu.liquid`: wired to call the helper at every nav
  level (top-level, dropdown child/grandchild, mega-menu child/grandchild).
- **Main Menu restructured via direct Shopify Admin GraphQL mutation**
  (`menuUpdate`), not the theme editor — went from 13 flat top-level links to:
  Home page, Shop, **Shop by Type ▾** (8 season/vehicle-type collections),
  **Shop by Brand ▾** (8 brand collections), Featured Tires. Menu ID
  `gid://shopify/Menu/214459187248`.
- **Mega-menu dropdown clipping bug (homepage only, not collection pages):**
  root cause was `.header { position: relative; z-index: 3; }` acting as the
  containing block for the absolutely-positioned `.mega-menu__content` —
  the header is only ~129px tall, so the dropdown clipped there instead of
  overflowing into the page. Fix (in `assets/base.css`): `.header { position:
  static !important; }`, with `position: relative; z-index: 3;` moved to
  `#shopify-section-header` instead. Several earlier attempts targeting
  `.mega-menu__content`/`.mega-menu__list--condensed` directly did nothing —
  the constraint was on an ancestor the whole time. If this regresses, check
  `.header`'s position property first, not the dropdown's own CSS.

### 9.2 Product page — warranty badge
- New snippet `snippets/gci-warranty-badge.liquid` + CSS added directly in
  `sections/main-product.liquid`'s own `<style>` block (not the snippet —
  GCI convention is CSS lives in the calling section, snippets are markup
  only). Rendered in the `buy_buttons` block, right after
  `product-shipping-badge`.
- Copy confirms **GCI is an authorized Canada Tire (CT) dealer**, so CT's
  Limited Warranty (30-day trial, workmanship, limited mileage treadwear,
  road hazard) legitimately passes through to customers. Full content drafted
  for `/pages/tire-warranty` (handle: `tire-warranty`), sourced from CT's
  actual published warranty PDF, not invented. Claim contact:
  `info@gcitires.ca`.

### 9.3 Search — un-carried brand banner
- `sections/main-search.liquid`: detects searches for brands CT doesn't
  carry (Michelin, Continental, Pirelli, Bridgestone, Goodyear, Firestone,
  Toyo, Hankook — confirmed by business owner, not guessed) and shows a
  banner recommending a comparable in-stock brand instead of silently
  returning irrelevant results. Mapping (owner-approved): Michelin/
  Continental/Pirelli → Vredestein; Bridgestone/Goodyear/Firestone → Cooper;
  Toyo/Hankook → Nexen.

### 9.4 AI Match page (`templates/page.gci-ai-match-2-0-landing.liquid`)
Note the actual live filename is `page.gci-ai-match-2-0-landing.liquid` —
§4 above references `page.gci-ai-match-landing.liquid` (no "2-0"); if these
turn out to be two different files rather than a naming drift, that's worth
resolving, but as of 2026-07-05 all live edits went into the "2-0" file.

- **`{% layout none %}` added as line 1.** Without it, Shopify wrapped this
  page's own full `<!DOCTYPE html>` document inside `theme.liquid`'s layout
  too — double `<html>/<head>/<body>`, duplicate script registration
  (`sticky-header` custom element, Trustpilot, a Google Merchant widget
  script), which threw real console errors. Confirmed fixed.
- **Reliability fix:** removed `loading="lazy"` from the `<iframe>` (was
  deferring load with zero visual feedback — very likely the literal cause
  of the original SimGym "AI Match feels unresponsive" finding). Added a
  loading overlay + a 10s-timeout fallback message (links to season
  collections) if the iframe never signals ready. Primary ready-signal is
  the iframe's native `load` event (reliable regardless of the embedded
  app's own behavior), with the app's optional `postMessage({height})` as a
  bonus for auto-resize only, not a requirement.
- **Three hotlinked third-party images replaced**: two now point to GCI's
  own Shopify CDN (uploaded to Files), one kept on Unsplash (free/commercial
  license) since no GCI-owned image matched that card's AI/tech theme. The
  original images were live hotlinks to unrelated businesses' own sites
  (tirewarehouse.ca, colorwhistle.com, olimpwarehousing.com) — real
  reliability + minor IP-exposure risk, now resolved.
- **Back-to-store link added** (`{{ routes.root_url }}`, locale-aware) —
  this page has no header/nav at all (raw standalone template), so there
  was previously no way back to the main site from here.
- **TireBot launcher added** — see §9.5. Sits as a `<p>` right after
  `app-container` closes (NOT inside the loader/fallback divs — an earlier
  attempt placed it inside `app-container` by mistake and it needed moving).

### 9.5 TireBot (`gcitires-chatbot` repo — see §2 for repo details)
- **Icon fix, merged to `main`, confirmed live**: the FAB button's SVG was
  intended as a wheel icon (circle + spokes) but rendered as a
  crosshair/targeting-reticle at 30px with thin strokes — replaced with a
  standard chat-bubble glyph. Branch `claude/tirebot-icon-and-open-api`,
  merged via direct push (repo has a branch-protection rule requiring PRs;
  the token used had bypass permission — flagged to the owner).
- **Public API added**: `window.GCITiresWidget.open()/close()/toggle()`,
  dispatched as custom events (`gci-tirebot:open` etc.) consumed by
  `ChatWidget.tsx` via `useEffect`. Previously only `init()` was exposed, so
  opening the widget from elsewhere on the site required simulating a click
  on internal DOM (`.gci-fab`) — fragile. Confirmed live in the deployed
  bundle (`gcitires-chatbot.vercel.app/tirebot-widget.iife.js`) as of
  2026-07-05.
- New theme snippet `snippets/gci-tirebot-launcher.liquid` (a "Chat with
  TireBot" button, reusable via `{% render 'gci-tirebot-launcher', label:
  '...' %}`) + CSS in `theme.liquid`'s global `<style>` block. Currently
  used once, on the AI Match page (§9.4).

### 9.6 AI Match verification — investigated, NOT a bug (clarifying a
past-session artifact)
An extended Google AI Studio chat log (pre-dating this repo's current code)
showed an early build of AI Match with a **fake** "DriveRightData" fitment
check (hardcoded `fitmentVerified: true`, no real API call — `DRD_CREDENTIALS
.baseUrl` pointed at a Swagger docs page, not a callable endpoint) and a
**mock inventory fallback** that included brands GCI doesn't carry (Michelin,
Bridgestone, Continental, Goodyear). **Both are already resolved in the
current, live `gci-brain` code** — verified directly against
`src/services/shopifyProductService.ts` (no mock fallback exists anymore,
returns `[]` on failure; uses the real `tag:ai-match` Shopify query,
confirmed working via a live "1819 products fetched" console log) and
`api/fitmentCheck.ts` (a genuine, different third-party service — the
**Wheel-Size.com API** — with honest pass/fail logic; the "GCI Verified"
badge in `TireCard.tsx` only renders when `fitmentVerified === true` is a
real computed result, never hardcoded). **If a future session encounters
that old AI Studio log again, don't re-treat it as a live bug** — it
describes a historical build, not current production. Owner's own
explanation: DriveRightData was the original plan but too expensive for a
startup at the time; Wheel-Size was substituted; may revisit DriveRightData
later if budget allows.

---

## 10. Credentials shared in-session, 2026-07-05 — rotate when convenient

A GitHub PAT (scoped to `statco/gcitires-chatbot` and reused for
`statco/gci-brain`) was shared directly in chat to enable cloning/pushing
during this session. Also, a historical AI Studio chat log pasted for
context contained plaintext Shopify Storefront and DriveRightData
credentials (pre-dating current code, likely already superseded, but not
confirmed rotated). None of this is an active exploit path, but standard
hygiene: rotate the GitHub token and confirm the old Storefront/DRD
credentials are dead, next time you're in each respective settings page.

---

## Session update — 2026-08-08: gcitires-chatbot chat-timeout fix + monitoring build-out

Triggered by a real user report ("chat-bot seems down") with no Telegram
alert. Audit found three things, all now resolved — full detail below;
`gcitires-chatbot`'s repo-map row (§2) and the Telegram credential row
(§3) have been updated to match.

**1. `/api/chat` 30s timeouts (fixed, PR #29, merged).** A broad/ambiguous
customer message let Claude fire off a burst of parallel `search_catalog`
calls in one turn — production logs showed it sweeping every vehicle size
listed in the system prompt (RAV4 + Camry + Civic + F-150 sizes all in one
request). `streamChat()`'s tool loop awaited each sequentially, and a
brand-only `search_catalog` call could itself paginate up to 4 sequential
Shopify round-trips (1000 products) just to return 5 deduped results.
Combined, this blew past `api/chat.ts`'s 30s `maxDuration` and the SSE
stream died mid-response with nothing surfaced to the widget — looked
exactly like the bot was down, but Vercel logged every request as a plain
200 (the timeout was a separate, truncated invocation whose buffered
console output leaked into the next request's log — don't trust a "200"
alone when investigating this class of bug, check for an actual response
body). Fixed with four coordinated changes in `lib/anthropic.ts` (parallel
tool execution via `Promise.all`, capped to 4 calls/round), `lib/shopify.ts`
(pagination cap lowered 1000→300 products, added an 8s per-request abort
timeout), and `lib/prompts.ts` (EN+FR — hard 2-calls-per-turn limit,
explicit ban on sweeping the example vehicle-size table).

**2. Supabase `service_role` key silently broken 2026-08-04 to 2026-08-08
(resolved, not via this session's code).** Confirmed via direct DB query
against `chatbot_customers`: writes were steady (5–14/hour) right up to
2026-08-04 16:37 UTC, then hard-stopped — a clean cutover, consistent with
the key being rotated on the Supabase side without Vercel's copy of
`SUPABASE_SERVICE_ROLE_KEY` (in the `gcitires-chatbot` project) being
updated. Root cause of *why nobody noticed* was #3 below, not this bug
itself. By the time this was checked again same-day, writes had resumed
and the new health check (see #3) confirmed `supabase: ok` — so this was
fixed (key rotated back, or a fresh key set) but not by an AI session; if
a future session needs to touch this again, the project is
`gci-walmart-sync` (ref `enhbckomwdelktdhnuzq`), Settings → API →
`service_role` key, pasted into `gcitires-chatbot`'s Vercel env. **Worth
checking `gci-price-monitor` isn't silently broken by the same rotation**
— it shares this Supabase project and was never specifically re-verified
in this session.

**3. `gcitires-chatbot` had zero monitoring (fixed, PR #29, merged).**
Confirmed: no `crons` in `vercel.json`, no Telegram code at all, and (per
the credential map in §3, pre-this-update) this repo was never added to
the list of projects with `TELEGRAM_BOT_TOKEN`/`CHAT_ID` configured. That's
the real reason #1 and #2 both went unnoticed — there was no code path
that could have alerted anyone. Added:
- `lib/telegram.ts` — same dual actionable/info channel pattern as
  `gci-order-hub`'s `api/lib/telegram.ts`, newly wired into this project
  (env vars are per-Vercel-project, don't propagate — see §3).
- `api/health-check.ts` — cron every 30 min, directly exercises a real
  Supabase query (same table/client as production `findCustomer`) and a
  real `searchCatalog()` call for a common tire size, plus an Anthropic
  reachability check. Alerts debounced via a new `chatbot_health_checks`
  table (2h cooldown while a check stays failing, one-time recovery
  notice when it goes green again).
- Telegram env vars set this session: `TELEGRAM_CHAT_ID_ACTIONABLE` =
  `901641030`. `TELEGRAM_CHAT_ID_INFO` was **not** set separately — it
  currently falls back to nothing configured, so recovery notices won't
  send until that's added too (can reuse the same `901641030` chat, or
  point it elsewhere).

**Live-verified end to end same day**: all three health-check components
(`supabase`, `shopify_catalog`, `anthropic`) confirmed `ok` via direct
Supabase SQL against `chatbot_health_checks`, cron confirmed firing on
schedule via Vercel runtime logs (30-min cadence), zero alerts fired
(`last_alert_at` null on all three) since nothing has failed since deploy.

**Session credential note** (same convention as §10 above): a GitHub PAT
scoped to the `statco` org was shared directly in chat this session to
push PR #29's branch and merge-adjacent doc updates. Standard hygiene:
rotate it next time you're in GitHub token settings.

---

## Session update — 2026-08-11: SEO drift protection (gci-brain) + Walmart listing content sync (gci-walmart-sync)

**Trigger**: Pat reported recurring loss of manually-edited SEO titles,
meta descriptions, and product descriptions — suspected they were being
silently overwritten by automation.

**Root cause, confirmed by reading the actual code**: `api/updateSeo.ts`
and `api/fixTireSize.ts` (gci-brain) both regenerated `title_tag`,
`description_tag`, and `body_html` from templates/AI on every run, with
**no way to distinguish a human edit (Pat or the SEO agency, made
directly in Shopify admin) from a value the automation last wrote
itself.** `updateSeo.ts` is manual-trigger-only (not in any cron), so
loss was tied to whenever it got run, not a fixed schedule.
`fixTireSize.ts` runs daily at 2am ET but only touches products whose
title still contains a malformed CT size code — so it doesn't recur
indefinitely per product, but did unconditionally overwrite `title_tag`
whenever it did fire.

**Fix (PR gci-brain#137, #138, merged and deployed)**: new
`lib/seoDrift.ts` — before writing any of the three fields, compares the
field's **current live value** against a **baseline hash** stored in a
`seo_sync` namespace metafield (same convention as the existing
`canada_tire.cost_synced_at` freshness stamp — no new DB/infra):
- No baseline yet → unknown provenance, protect by default, seed
  baseline, skip write. (This means the very first run after deploy
  protects *everything currently in place* — nothing was touched by the
  deploy itself.)
- Baseline matches live value → nobody's touched it since our last
  write, safe to regenerate.
- Baseline differs → a human changed it since, skip write, adopt their
  value as the new baseline (self-healing — no tagging/process required
  from Pat or the agency).

PR #138 was a same-session follow-up fix: the first pass nested the
drift-check/metafield-fetch inside `if (!dryRun)`, so `dry=true` never
actually previewed anything — `skippedFields` came back empty
regardless of a product's real state. Fixed so dry-run genuinely reads
and compares (via a `{ preview: true }` option on `checkDrift()` that
skips the baseline-seeding write) without writing anything.

**Live-verified**, not just code-reviewed: ran `/api/updateSeo` against
a real product (Cooper Zeon RS3-G1 215/50R17, id 7957868544048) both
dry and for real. Confirmed via a separate `Shopify:get-product` read
(not trusting the endpoint's own response) that `descriptionHtml` was
genuinely untouched after the real run — matches the original text, not
the AI-generated replacement the dry run showed it would have produced
absent this protection.

**Walmart side (PR gci-walmart-sync#25, merged and deployed, but
currently inert)**: `lib/sync/listing.ts` already had
`buildWalmartItemPayload()`/`submitItemFeed()` built but dormant (only
ever exercised by `scripts/test-listing-payload.ts`). Now:
- `productName`/`shortDescription` prefer the SEO `title_tag`/
  `description_tag` metafields (falling back to plain title/`body_html`)
  — Walmart has no separate "SEO field" concept of its own;
  productName/shortDescription directly drive its search ranking, the
  same role title_tag/description_tag play for Shopify/Google.
- New `syncListingForVariant()` fires reactively off the existing
  `PRODUCTS_UPDATE` webhook handler (same pattern as the existing
  `syncPriceForVariant()`), with a new `Product.contentHash` column
  (migration applied directly via Supabase's `execute_sql` — see below)
  to skip the Walmart feed submission when nothing content-relevant
  actually changed.

**Attempted a live smoke test of the Walmart side — blocked by scope,
not a bug.** Queried the `shops` table in gci-walmart-sync's Supabase
project (`enhbckomwdelktdhnuzq`): it only contains
`gci-walmart-test.myshopify.com` and `shadow-mode.internal`. **This app
is still not installed on `gcitirescanada.com`** (confirmed already true
per §2's gci-walmart-sync row — this session didn't change that, just
ran into it directly). Made a small reversible test edit to a real
product's description via the connected Shopify tool to see if the
webhook would fire; confirmed via Vercel runtime logs that **zero**
requests hit `/api/webhooks` in the following 15 minutes — expected,
since Shopify only delivers webhooks to apps actually installed on that
shop. Reverted the test edit immediately after (`descriptionHtml`
confirmed back to the exact original text). Pat confirmed this is
deliberate/expected, not news.

**Practical implication for whenever gci-walmart-sync does go live for
GCI**: this content-sync code has never run against real data end to
end. Before trusting it, it should get the same live smoke test done
here — but pointed at `gci-walmart-test.myshopify.com`, the store this
app can actually see.

**Database note**: gci-walmart-sync's Supabase project has **no Prisma
migration history** (`_prisma_migrations` table doesn't exist — schema
has only ever been tracked via Supabase-native migrations,
`supabase_migrations.schema_migrations`, 11 entries). Running
`prisma migrate dev` against it cold is a known footgun (detects the
live schema as unbaselined drift, can prompt a full reset) — this
database has real rows (`chatbot_customers` ~32k,
`price_monitor_snapshots` ~2.8k, etc.). Added the two new columns via
hand-written SQL through Supabase's migration tool instead, with a
matching `prisma/migrations/.../migration.sql` file committed so the
repo's migration history at least *shows* what was applied, even though
`_prisma_migrations` itself is still unbaselined. **This gap is
pre-existing, not new** — deferred by design pending an environment with
real Postgres wire-protocol access (this session's sandbox could only
reach Postgres via Supabase's HTTPS-based tools, not raw
`postgresql://` on 5432/6543).

**Outstanding after this session**:
- Rotate the Supabase DB password for `enhbckomwdelktdhnuzq` — it went
  through a Claude Code session transcript when env vars were set for
  the migration attempt.
- `_prisma_migrations` baseline gap on gci-walmart-sync — deferred, see
  above.
- A GitHub PAT scoped to the `statco` org was shared directly in chat
  this session (used across gci-brain and gci-walmart-sync for the PRs
  above). Standard hygiene: rotate it.
- This doc was only updated in **gci-brain and gci-walmart-sync** this
  session — the other 4 copies do not yet reflect this update.

---

## Session update — 2026-08-13: inventory-reconcile single-warehouse stock fix (gci-brain)

**Trigger**: Pat reported a real customer oversell — Ovation Vi-682
155/80R12 (SKU `200E2108`), order for 2x accepted by Shopify at checkout,
then had to be cancelled because Canada Tire only had 1x actually
fulfillable. Customer accepted 1x and re-ordered; Pat asked for a permanent
fix, not just a one-off correction.

**Root cause, confirmed by reading the actual code**: `gci-brain`'s hourly
`inventory-reconcile` cron (`api/shopifySync.ts`, § 3/§ 6 of
`gci-order-hub/CT-INTEGRATION-CONTEXT.md` previously described this as
authoritative — see the correction added there) wrote Shopify's stock
quantity as `getTotalQty(ct)`, the **sum of CT stock across all 7
warehouses**. But CT's Submit Order API accepts only **one** warehouse per
order — no split shipments — which `gci-order-hub/api/lib/ct-client.ts`'s
`resolveLocation()` already enforces when actually placing a PO (it
explicitly picks a single location that can fill every line, throwing
`CTInsufficientStockError` if none can).

Consequence: a SKU with 1 unit in Toronto and 1 in Montreal read as "2 in
stock" in Shopify. `inventory_policy: 'deny'` never caught this — Shopify
genuinely (if wrongly) believed 2 units existed, so the deny-policy
backstop never triggered. `resolveLocation()` would correctly reject a
real 2-unit order downstream, but only after the customer had already
checked out — a real oversell path, not the "routine, not an error"
`CTInsufficientStockError` → manual-required outcome the system was
designed to expect (see `CT-INTEGRATION-CONTEXT.md` § 8's error mapping).
This gap was not previously documented anywhere in either repo's context
docs.

**Fix (gci-brain#139, merged)**: new `getMaxLocationQty()` — max quantity
at any single CT warehouse, not the sum — swapped in as the `in_stock`
target in `inventory-reconcile`. This is the true fulfillable ceiling: the
largest single-location order `resolveLocation()` could ever successfully
route, for any province (every `PROVINCE_ROUTING` list in
`gci-order-hub/api/lib/ct-client.ts` falls back across all 7 locations, so
max-across-all-7 is the correct ceiling regardless of destination). Same
hourly cron, same `setInventory` write path, same `inventory_policy:
'deny'` backstop — only the target-qty formula changed. `tsc --noEmit`
passes clean.

**Not yet live-verified against real data.** The fix is merged and will
apply starting the next hourly cron run. Recommended before fully trusting
it: a `dryRun=true` run (`?action=inventory-reconcile&dryRun=true`) to
review `pendingSample` for SKUs whose displayed quantity will drop (any
SKU with stock spread thin across multiple warehouses rather than
concentrated in one) — this is expected, correct behavior, not a
regression, but worth eyeballing once before a live run applies it.

**Cross-reference**: `gci-order-hub/CT-INTEGRATION-CONTEXT.md` § 5a
("Both merge-gate decisions resolved") has a matching correction appended
directly under its original "Option C" decision, since that decision's
reasoning relied on the now-fixed assumption.

**Tradeoff, intentional**: Shopify's displayed stock will now be
conservative relative to true national CT stock whenever inventory is
genuinely spread across warehouses — correct today since CT can't
split-ship; would need revisiting if CT ever adds that capability.

**Session credential note** (same convention as earlier session entries
in this doc): a GitHub PAT scoped to the `statco` org was shared directly
in chat this session (used for gci-brain's clone/branch/commit/PR and this
doc-sync commit). Standard hygiene: rotate it, alongside the other
rotations already queued (Supabase DB password, `SHOPIFY_ADMIN_API_TOKEN`,
`CRON_SECRET`).

- This doc was updated in **all 6 repos** this session.
