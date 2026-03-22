# GCI Order Hub

Serverless order automation for [gcitires.com](https://gcitires.com) — routes Shopify orders to the correct supplier, syncs inventory to Walmart Marketplace, and generates Walmart-ready SEO titles.

## Architecture

```
Shopify (orders/paid webhook)
        │
        ▼
POST /api/order-router
        │
        ├── SKU prefix TIRE-   → Canada Tire Purchase Order (manual, with installer metadata)
        └── SKU prefix NUPROZ- → CJ Dropshipping pending order (auto-created, NOT yet submitted)
                │
                └── Telegram + Email notification with HMAC-signed "Authorize Payment" link
                                │
                                ▼
                    GET /api/authorize-order?data=…&sig=…
                                │
                                ├── TIRE:   confirmation page (you place PO manually)
                                └── NUPROZ: auto-submits to CJ Dropshipping API
```

```
Vercel cron (0 9 * * *  =  4 AM EST)
        │
        ▼
GET /api/walmart-sync
        │
        ├── Fetches all TIRE- variants from Shopify
        ├── Safety switch: qty < 4 → Walmart qty = 0
        └── Pushes price + inventory to Walmart Marketplace in bulk feeds
```

## Files

| File | Purpose |
|------|---------|
| `api/order-router.ts` | Shopify webhook — split, route, notify |
| `api/authorize-order.ts` | Manual auth link handler |
| `api/walmart-sync.ts` | Walmart price + inventory push |
| `api/lib/notify.ts` | Telegram bot + Resend email notifications |
| `api/lib/cj-client.ts` | CJ Dropshipping API v2 client |
| `api/lib/walmart-client.ts` | Walmart Marketplace API client |
| `scripts/seo_title_generator.py` | One-time Walmart SEO title generator |
| `vercel.json` | Function timeouts + cron schedule |
| `.env.local.example` | All required env vars documented |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.local.example .env.local
# Fill in all values — see comments in .env.local.example
```

### 3. Register Shopify webhook

In **Shopify Admin → Settings → Notifications → Webhooks**:

- **Event**: Order payment
- **URL**: `https://<your-vercel-domain>/api/order-router`
- **Format**: JSON
- Copy the **Signing secret** → set as `SHOPIFY_WEBHOOK_SECRET`

### 4. Deploy to Vercel

```bash
vercel deploy --prod
```

### 5. Test the order router

```bash
# Send a test webhook (replace with real values)
curl -X POST https://<your-domain>/api/order-router \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Topic: orders/paid" \
  -d '{"id":1,"name":"#1001","email":"test@test.com","line_items":[{"sku":"TIRE-12345","title":"Cooper Discoverer 265/70R17","quantity":4,"price":"189.99"}],"shipping_address":{"first_name":"Jane","last_name":"Doe","city":"Montreal","province_code":"QC","country_code":"CA"},"note_attributes":[]}'
```

### 6. Test Walmart sync (dry run)

```bash
curl https://<your-domain>/api/walmart-sync?dry=true
```

### 7. Run SEO title generator

```bash
pip install pandas
python3 scripts/seo_title_generator.py \
  --input  data/tires.csv \
  --output data/tires_walmart.csv \
  --fitment-column Fitment \
  --dry-run
```

**Input CSV format:**

| Brand | Model | Size | Fitment |
|-------|-------|------|---------|
| Cooper | Discoverer AT3 4S | 265/70R17 | 2019-2023 Ford F-150, 2018-2022 Chevy Silverado, 2020-2024 RAM 1500 |

**Output title example:**
> `Cooper Discoverer AT3 4S 265/70R17 Tire - Fits 2019-2023 Ford F-150, 2018-2022 Chevy Silverado, 2020-2024 RAM 1500 - GCI AI Fitment Guaranteed`

## Installer metadata fields preserved

| Field | Type | Values |
|-------|------|--------|
| `gci_fulfillment_type` | string | `direct_to_customer` \| `ship_to_installer` |
| `gci_installer_id` | string | installer record ID |
| `gci_installer_name` | string | display name |
| `gci_appointment_date` | string | ISO date |
| `gci_fitment_verified` | boolean | `true` \| `false` |

## Cron schedule

| Job | Schedule | Time (EST) |
|-----|----------|------------|
| `/api/walmart-sync` | `0 9 * * *` | 4:00 AM |

## Security notes

- Shopify webhooks verified with HMAC-SHA256 before processing
- Authorize links HMAC-signed with `ORDER_ROUTER_SECRET`, expire in 24 hours
- Timing-safe comparison used on all HMAC checks
- No secrets stored in URL parameters (only signed opaque tokens)

## Nuproz SKU convention

When importing nuprozone.com products into Shopify, set the variant SKU to:

```
NUPROZ-<CJ_variant_id>
```

The order router strips the `NUPROZ-` prefix and passes the CJ variant ID directly to the CJ API.
