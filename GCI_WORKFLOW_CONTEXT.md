# GCI Tires — Cross-Repo Workflow Context

> **Read this first**, before starting any new work in any GCI Tires repo — whether
> you're a human or an AI assistant picking up a session. This file is duplicated
> identically across all 6 repos below so it's available no matter which one you
> land in first. If you update it, update all 6 copies.
>
> Last written: 2026-07-01, last updated: 2026-07-02 (end of day, after the
> full remediation + third-party re-auth pass). Status markers:
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
| **gci-order-hub** | Order automation for GCI's own Shopify store: Shopify `orders/paid` webhook → routes to CT (TIRE- SKUs) → installer dispatch → Walmart price/inventory cron sync (`/api/walmart-sync`, `/api/walmart-sync-cursor`, `/api/walmart-ship`, etc. — more routes live than the README documents, check the actual `api/` folder). CJ Dropshipping (NUPROZ- SKU) routing removed 2026-07 — see §3/§4. | `gci-order-hub.vercel.app` | ✅ core routing working. 🟡 CT auto-PO switch built, dormant (§6). |
| **gci-command-center** | Internal ops dashboard — Sales/Marketing/Finance/IT/Content, one React app. Pulls Shopify + GA4 + Xero into one place. Also runs the Walmart discount-rotation system (`/promotions`). | `gci-command-center-ofzf` (custom domain `ops.gcitires.com`). The old duplicate plain-`.vercel.app` project was **deleted 2026-07-02** — there is now only one. | ✅ Fully verified 2026-07-02: all 4 dashboard widgets confirmed against real source data (Shopify orders/revenue, GA4 sessions, Xero invoices). Xero re-authed + root-cause fixed (§6.10), GA4 re-authed with a new service account (§5). |
| **gcitires-chatbot** | Customer-facing AI chat widget embedded on the storefront. Memory/conversation history migrated 2026-07 from Airtable to Supabase (`chatbot_customers`/`chatbot_conversations` tables in the shared `gci-walmart-sync` Supabase project) — fixes the old `/api/memory` timeout problem. | `gcitires-chatbot.vercel.app` | ✅ Migration COMPLETE 2026-07-02: code merged (#27, #28), env vars set, and the historical-data migration script actually run against production — 19,275 customer records verified in Supabase (all unique, 0 nulls). The re-run script (`scripts/migrate-airtable-to-supabase.ts`) is upsert-keyed and safe to re-run. |
| **gci-walmart-sync** | **Standalone commercial Shopify app** (Remix, Shopify App Store template) for Walmart CA Marketplace sync — listings, price, inventory, orders, returns. Built first for GCI, intended to be **published commercially** once ready. **Not activated for GCI's own operations yet** — pre-launch. | `app.gcitires.ca` (+ `gci-walmart-sync.vercel.app`) | 🟡 CC-1 through CC-12 built and compiling, feature-complete on paper, genuinely NOT live-tested with a real merchant yet (including GCI itself). See its own `docs/SESSION-CONTEXT.md` for full build history. |
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
| **Telegram + Resend** | gci-order-hub, gci-command-center, gci-price-monitor, **and gci-brain as of 2026-07-02** (outreach missing-email alerts — `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` had to be added to gci-brain's Vercel env vars; they are per-project, not shared) | Bot token / API key per repo | Straightforward. Note: env vars do NOT propagate across Vercel projects — a repo "having Telegram" means ITS project has the vars set. |
| **Supabase** (project `gci-walmart-sync`, ref `enhbckomwdelktdhnuzq`, region `ca-central-1`) | gci-walmart-sync (original owner — `shops`/`products`/`walmart_orders`/`sync_logs`/`sessions`/`walmart_sync_cursor` tables), gcitires-chatbot (`chatbot_customers`/`chatbot_conversations`, added 2026-07), gci-price-monitor (`price_monitor_snapshots`, added 2026-07) | Service role key, held server-side only per repo | Reused deliberately across all three rather than provisioning separate paid projects. RLS enabled on every table, no permissive policies for anon/authenticated — service_role-only access pattern, consistent across all tenants of this project. If you add a new table here for a new use case, follow the same pattern. |
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

## 5. Known issues open as of 2026-07-02 (business/config, not code)

These need a human action outside any repo's code — don't try to "fix" them
with a code change:

1. **GMC (Google Merchant Center) account suspended** — reinstatement blocked
   on a commercial-name update requirement. Deliberately PARKED by owner
   choice 2026-07-02 (Microsoft Merchant Center pursued instead). See
   gci-brain's project file.
2. **CT order-creation API** — doesn't exist yet; GCI's rep is working with CT
   on credit line + API access. The auto-PO switch (gci-order-hub) is built
   and dormant, ready to activate once CT delivers their side — see
   `api/lib/ct-client.ts` for exactly what's needed (note the payload shape
   there is an educated guess; verify against CT's real contract before
   enabling).
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

## 6. Known issues (code) — status as of 2026-07-02

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

**Still open (code-adjacent):**
12. **`gci-brain/api/send-email.js`** — CORS-restricted but no server-side
    auth; same class of issue as the old Airtable proxy, lesser severity.
    Flagged, not yet fixed.
13. **Xero auth-url/callback endpoints have no caller auth** — lower risk
    (completing the flow still requires a real Xero login), but worth a
    shared-secret lockdown eventually.
14. **Blog-publisher 4/4 re-verification** — see item 8; check the Monday
    cron's output or trigger deliberately (publishes real posts).

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
  contents against it)
- `gci-command-center`: `CONTEXT.md` (detailed, mostly current as of
  2026-06-15)
- `gci-walmart-sync`: `docs/SESSION-CONTEXT.md` (detailed build history,
  written for exactly this "prime a new session" purpose)
- `gcitires-chatbot`, `gci-price-monitor`: `README.md`, `SETUP_GUIDE.md`,
  `WORKFLOW.md` (price-monitor)
