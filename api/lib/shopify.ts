// api/lib/shopify.ts
// ─────────────────────────────────────────────────────────────
// Shared Shopify Admin GraphQL access.
//
// The single source of truth for Shopify variant data used by the
// Walmart pricing layers. Uses GraphQL cursor pagination because the
// REST Link-header pagination is unreliable and caps at ~2,527 variants.
//
// `cost` lives on InventoryItem.unitCost.amount in GraphQL.
// ─────────────────────────────────────────────────────────────

import type { TireType } from './pricing/landedCost';

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN ?? '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN ?? '';
const API_VERSION   = '2024-01';

export interface ShopifyVariantData {
  sku: string;                       // UPPER-cased
  price: number | null;
  cost: number | null;              // InventoryItem.unitCost.amount — what the floor reads
  ctCost: number | null;            // canada_tire.cost metafield — raw CT dealer cost (for divergence checks)
  inventoryQuantity: number | null;
  tireType: TireType | null;        // parsed from product tags — real class for the freight floor
  rimSize: number | null;           // parsed from product tags — real rim size for the freight floor
}

/**
 * Parses a product's real tire class + rim size out of its Shopify tags, so
 * safeWalmartPrice() can use the actual freight class instead of silently
 * falling back to its most conservative default (LT, rim 22) — the gap that
 * caused SKU 300E3009 (Ovation W-686, Passenger 185/65R15) to sit at a
 * $261.99 Walmart floor when the correct floor is ~$176, nowhere near the
 * true $174.99 Shopify price. See tags like "vehicle_type:Passenger" /
 * "vehicle_type:Light Truck" and a size tag such as "185/65R15".
 */
export function parseTireSpecFromTags(tags: string[]): { tireType: TireType | null; rimSize: number | null } {
  let tireType: TireType | null = null;
  let rimSize: number | null = null;

  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (tireType == null) {
      if (lower === 'vehicle_type:light truck' || lower === 'light-truck') tireType = 'LT';
      else if (lower === 'vehicle_type:passenger' || lower === 'passenger') tireType = 'Passenger';
    }
    if (rimSize == null) {
      const m = tag.match(/^\d{3}\/\d{2}R(\d{2})$/i);
      if (m) rimSize = parseInt(m[1], 10);
    }
  }

  return { tireType, rimSize };
}

export interface ShopifyOrderLookup {
  id:        string;   // gid://shopify/Order/...
  name:      string;   // "#1044"
  email:     string | null;
  phone:     string | null;
  tags:      string[];
  customAttributes: { key: string; value: string }[];
  lineItems: { sku: string; quantity: number }[];
  shippingAddress: {
    name?:        string;
    address1?:    string;
    address2?:    string;
    city?:        string;
    province?:    string;
    postalCode?:  string;
    country?:     string;
    phone?:       string;
  } | null;
}

/**
 * Fetch a single order by its Shopify order name (e.g. "#1044" or "1044" —
 * both work, Shopify's search normalises the leading #). Returns null if no
 * matching order is found. Used by admin-canary-ct-order.ts to re-fetch a
 * real, already-existing order's current state before manually re-routing
 * it through routeOrderToCT() — see CT-INTEGRATION-CONTEXT.md §13.
 */
export async function fetchOrderByName(orderName: string): Promise<ShopifyOrderLookup | null> {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    throw new Error('Shopify credentials not configured (SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_API_TOKEN)');
  }

  // Strip characters that could break out of the query-string literal below.
  // This is an internal admin endpoint (not user input from the internet),
  // but defensive anyway since it's string-interpolated GraphQL.
  const cleanName = orderName.trim().replace(/["\\]/g, '');
  const query = `{
    orders(first: 1, query: "name:${cleanName}") {
      edges {
        node {
          id
          name
          email
          phone
          tags
          customAttributes { key value }
          lineItems(first: 100) {
            edges { node { sku quantity } }
          }
          shippingAddress {
            name
            address1
            address2
            city
            provinceCode
            zip
            countryCodeV2
            phone
          }
        }
      }
    }
  }`;

  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    },
  );

  if (!res.ok) throw new Error(`Shopify GraphQL error: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  if (data.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors).slice(0, 200)}`);

  const edge = data?.data?.orders?.edges?.[0];
  if (!edge) return null;
  const node = edge.node;

  return {
    id:    node.id,
    name:  node.name,
    email: node.email ?? null,
    phone: node.phone ?? null,
    tags:  (node.tags ?? []) as string[],
    customAttributes: (node.customAttributes ?? []).map((a: any) => ({ key: a.key, value: a.value })),
    lineItems: (node.lineItems?.edges ?? [])
      .map((e: any) => ({ sku: (e.node.sku ?? '').toUpperCase(), quantity: e.node.quantity }))
      .filter((i: any) => i.sku),
    shippingAddress: node.shippingAddress ? {
      name:       node.shippingAddress.name ?? undefined,
      address1:   node.shippingAddress.address1 ?? undefined,
      address2:   node.shippingAddress.address2 ?? undefined,
      city:       node.shippingAddress.city ?? undefined,
      province:   node.shippingAddress.provinceCode ?? undefined,
      postalCode: node.shippingAddress.zip ?? undefined,
      country:    node.shippingAddress.countryCodeV2 ?? undefined,
      phone:      node.shippingAddress.phone ?? undefined,
    } : null,
  };
}

/**
 * Fetch ALL Shopify variants (sku, price, cost, inventoryQuantity) via
 * GraphQL cursor pagination. Returns a Map keyed by UPPER-cased SKU.
 *
 * Keys are upper-cased to match how Walmart SKUs are normalised
 * elsewhere in the codebase.
 */
export async function fetchAllShopifyVariants(): Promise<Map<string, ShopifyVariantData>> {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    throw new Error('Shopify credentials not configured (SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_API_TOKEN)');
  }

  const map = new Map<string, ShopifyVariantData>();
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const query: string = `{
      productVariants(first: 250${cursor ? `, after: "${cursor}"` : ''}) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            sku
            price
            inventoryQuantity
            inventoryItem { unitCost { amount } }
            product {
              tags
              ctCost: metafield(namespace: "canada_tire", key: "cost") { value }
            }
          }
        }
      }
    }`;

    const res: Response = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      },
    );

    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 2_000));
      continue;
    }
    if (!res.ok) throw new Error(`Shopify GraphQL error: ${res.status} ${(await res.text()).slice(0, 200)}`);

    const data: any = await res.json();
    if (data.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors).slice(0, 200)}`);

    const variants: any = data?.data?.productVariants;
    if (!variants) throw new Error('Shopify GraphQL: unexpected response shape');

    for (const edge of variants.edges) {
      const node = edge.node;
      const sku = (node.sku ?? '').toUpperCase();
      if (!sku) continue;

      const rawCost = node.inventoryItem?.unitCost?.amount;
      const rawCt   = node.product?.ctCost?.value;
      const { tireType, rimSize } = parseTireSpecFromTags((node.product?.tags ?? []) as string[]);
      map.set(sku, {
        sku,
        price: node.price != null ? parseFloat(node.price) : null,
        cost: rawCost != null ? parseFloat(rawCost) : null,
        ctCost: rawCt != null ? parseFloat(rawCt) : null,
        inventoryQuantity: node.inventoryQuantity != null ? Number(node.inventoryQuantity) : null,
        tireType,
        rimSize,
      });
    }

    hasMore = variants.pageInfo.hasNextPage;
    cursor = variants.pageInfo.endCursor;
  }

  return map;
}

/**
 * Fetch ACTIVE ct-sync Shopify variants only, with inventory quantity, price,
 * and cost. Used by the mode=listed sync path as the authoritative quantity
 * source — only active products can sell, so only their quantities are safe
 * to push to Walmart.
 *
 * Filters via the `products` connection: status:active tag:ct-sync.
 * Using `products` (not `productVariants`) because the products connection's
 * `status` filter is authoritative — the productVariants connection does not
 * support product-level filter predicates and silently ignores them, meaning
 * archived/draft variants leak through.
 *
 * Returns a Map keyed by UPPER-cased bare SKU (no TIRE- prefix).
 */
export async function fetchActiveCtSyncVariants(): Promise<Map<string, ShopifyVariantData>> {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    throw new Error('Shopify credentials not configured (SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_API_TOKEN)');
  }

  const map = new Map<string, ShopifyVariantData>();
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const query: string = `{
      products(first: 250, query: "status:active tag:ct-sync"${cursor ? `, after: "${cursor}"` : ''}) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            tags
            variants(first: 100) {
              pageInfo { hasNextPage }
              edges {
                node {
                  sku
                  price
                  inventoryQuantity
                  inventoryItem { unitCost { amount } }
                }
              }
            }
            ctCost: metafield(namespace: "canada_tire", key: "cost") { value }
          }
        }
      }
    }`;

    const res: Response = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      },
    );

    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 2_000));
      continue;
    }
    if (!res.ok) throw new Error(`Shopify GraphQL error: ${res.status} ${(await res.text()).slice(0, 200)}`);

    const data: any = await res.json();
    if (data.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors).slice(0, 200)}`);

    const products: any = data?.data?.products;
    if (!products) throw new Error('Shopify GraphQL: unexpected response shape');

    for (const productEdge of products.edges) {
      const product = productEdge.node;
      const rawCt   = product.ctCost?.value;
      const { tireType, rimSize } = parseTireSpecFromTags((product.tags ?? []) as string[]);

      // Tire listings are one-variant-per-product; guard in case that changes.
      if (product.variants.pageInfo.hasNextPage) {
        console.warn(`[fetchActiveCtSyncVariants] product ${product.id} has >100 variants — trailing variants skipped`);
      }

      for (const variantEdge of product.variants.edges) {
        const node   = variantEdge.node;
        const rawSku = (node.sku ?? '').toUpperCase();
        if (!rawSku) continue;
        // Normalise to bare SKU — active products carry bare SKUs; strip any
        // accidental TIRE- prefix just in case.
        const sku = rawSku.startsWith('TIRE-') ? rawSku.slice(5) : rawSku;

        const rawCost = node.inventoryItem?.unitCost?.amount;
        map.set(sku, {
          sku,
          price:             node.price != null ? parseFloat(node.price) : null,
          cost:              rawCost != null ? parseFloat(rawCost) : null,
          ctCost:            rawCt   != null ? parseFloat(rawCt)   : null,
          inventoryQuantity: node.inventoryQuantity != null ? Number(node.inventoryQuantity) : null,
          tireType,
          rimSize,
        });
      }
    }

    hasMore = products.pageInfo.hasNextPage;
    cursor  = products.pageInfo.endCursor;
  }

  return map;
}

