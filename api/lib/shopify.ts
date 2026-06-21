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

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN ?? '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN ?? '';
const API_VERSION   = '2024-01';

export interface ShopifyVariantData {
  sku: string;                       // UPPER-cased
  price: number | null;
  cost: number | null;              // InventoryItem.unitCost.amount — what the floor reads
  ctCost: number | null;            // canada_tire.cost metafield — raw CT dealer cost (for divergence checks)
  inventoryQuantity: number | null;
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
      map.set(sku, {
        sku,
        price: node.price != null ? parseFloat(node.price) : null,
        cost: rawCost != null ? parseFloat(rawCost) : null,
        ctCost: rawCt != null ? parseFloat(rawCt) : null,
        inventoryQuantity: node.inventoryQuantity != null ? Number(node.inventoryQuantity) : null,
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
 * Filters: product.status = ACTIVE AND product.tags includes "ct-sync".
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
    // Filter to active ct-sync products only. Shopify GraphQL productVariants
    // supports query strings with product.status and product.tag filters.
    const queryFilter = 'product.status:active product.tag:ct-sync';
    const query: string = `{
      productVariants(first: 250, query: "${queryFilter}"${cursor ? `, after: "${cursor}"` : ''}) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            sku
            price
            inventoryQuantity
            inventoryItem { unitCost { amount } }
            product {
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
      const rawSku = (node.sku ?? '').toUpperCase();
      if (!rawSku) continue;
      // Normalise to bare SKU — TIRE- products are archived; active products
      // carry bare SKUs. Strip any accidental TIRE- prefix just in case.
      const sku = rawSku.startsWith('TIRE-') ? rawSku.slice(5) : rawSku;

      const rawCost = node.inventoryItem?.unitCost?.amount;
      const rawCt   = node.product?.ctCost?.value;
      map.set(sku, {
        sku,
        price: node.price != null ? parseFloat(node.price) : null,
        cost: rawCost != null ? parseFloat(rawCost) : null,
        ctCost: rawCt != null ? parseFloat(rawCt) : null,
        inventoryQuantity: node.inventoryQuantity != null ? Number(node.inventoryQuantity) : null,
      });
    }

    hasMore = variants.pageInfo.hasNextPage;
    cursor = variants.pageInfo.endCursor;
  }

  return map;
}

