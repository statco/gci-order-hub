# GCI Tires — Walmart Canada Integration
## Project Context Document
**Last updated:** June 30, 2026
**Prepared by:** Claude (Anthropic) for Patrick B. Pierre, GCI Inc.

---

## 1. Business Context

**Company:** Groupe de Commerce Intercontinental Inc. (GCI Inc.)
**Division:** GCI Tires — gcitires.com
**Walmart Seller ID:** 10002930522
**Walmart Store Name:** GC Tires
**Walmart Support Contact:** Amar (Walmart MP Support Team)

**Goal:** Automate daily price and inventory sync from Shopify (gcitires.com) to Walmart Canada Marketplace for Cooper, Nexen, and Vredestein tire SKUs. Full order routing from Walmart → Canada Tire → customer now operational with persistent cursor-based catch-up (no orders can be missed regardless of cron gaps).

**Focus:** Tires only (Cooper, Nexen, Vredestein, Minerva, Ovation and others now active in catalog — see Section 7). Nuproz/CJ Dropshipping discontinued. Wheels may be added eventually.

---

## 2. Technology Stack

### Repositories
| Repo | Purpose | Deployed at |
|---|---|---|
| `statco/gci-order-hub` | Walmart sync backend, order routing | gci-order-hub.vercel.app |
| `statco/gci-brain` | Shopify sync, fitment app, internal tools | gci-brain.vercel.app |
| GCI Tires
