/**
 * api/walmart-item-feed.ts
 *
 * Creates Walmart Canada tire listings in bulk via the MP_ITEM_INTL feed.
 * Fetches all Shopify products tagged 'ct-sync', parses tire attributes,
 * and submits a single asynchronous feed to Walmart.
 *
 * POST /api/walmart-item-feed
 *
 * Returns:
 *   { success, feedId, submitted, skipped, skippedItems }
 *
 * Check feed processing status at: GET /api/walmart-feed-status?feedId=<feedId>
 *
 * Note: Walmart processes feeds asynchronously — a 200 response here means
 * the feed was *accepted*, not that all items were successfully listed.
 * Poll /api/walmart-feed-status until feedStatus === "PROCESSED".
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { v4 as uuidv4 } from 'uuid';
import { getWalmartToken } from './lib/walmart-client.js';
import {
  parseTireSize,
  getSeasonFromTags,
  getVehicleTypeFromTags,
  type SeasonClassification,
  type VehicleType,
} from './lib/tire-parser.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ShopifyVariant {
  id: number;
  sku: string;
  price: string;
  inventory_quantity: number;
}

interface ShopifyImage {
  src: string;
  position: number;
}

interface ShopifyProduct {
  id: number;
  title: string;
  vendor: string;
  tags: string;
  images: ShopifyImage[];
  variants: ShopifyVariant[];
}

interface WalmartFeedItem {
  Orderable: {
    sku: string;
    productIdentifiers: {
      productIdType: string;
      productId: string;
    };
    productName: { en: string };
    brand: { en: string };
    price: number;
    ShippingWeight: { measure: number; unit: 'lb' };
    productTaxCode: number;
    shortDescription: { en: string };
    mainImageUrl: string;
    countryOfOriginAssembly: string[];
  };
  Visible: {
    Tires: {
      tireSize: string;
      tireWidth?: number;
      tireAspectRatio?: number;
      wheelDiameter?: { measure: number; unit: 'in' };
      tireSeason?: { en: string };
      vehicleType?: { en: string };
      vehicleClassDesignator?: { en: string };
      constructionType?: { en: string };
    };
  };
}

interface SkippedItem {
  sku: string;
  reason: string;
}

// ─── Shopify ──────────────────────────────────────────────────────────────────

async function fetchShopifyProducts(): Promise<ShopifyProduct[]> {
  const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN!;
  const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN!;

  const products: ShopifyProduct[] = [];
  let nextUrl: string | null =
    `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/products.json` +
    `?limit=250&tag=ct-sync&fields=id,title,vendor,tags,images,variants`;

  while (nextUrl) {
    const res: Response = await fetch(nextUrl, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
    });

    if (!res.ok) {
      throw new Error(`Shopify fetch failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    products.push(...(data.products as ShopifyProduct[]));

    // Follow Shopify pagination Link header
    const linkHeader: string = res.headers.get('Link') ?? '';
    const nextMatch: RegExpMatchArray | null = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = nextMatch ? nextMatch[1] : null;
  }

  return products;
}

// ─── Feed Item Builder ────────────────────────────────────────────────────────

// Best-effort country-of-origin by brand; update as sourcing changes.
function countryOfOrigin(vendor: string): string {
  const v = vendor.toLowerCase();
  if (v === 'vredestein')  return 'NL - Netherlands';
  if (v === 'nexen')       return 'KR - Korea, South';
  if (v === 'cooper')      return 'US - United States';
  if (v === 'bridgestone') return 'JP - Japan';
  return 'CN - China';
}

function seasonLabel(s: SeasonClassification): string {
  const map: Record<SeasonClassification, string> = {
    ALL_SEASON:   'All-Season',
    ALL_WEATHER:  'All-Weather',
    WINTER:       'Winter',
    SUMMER:       'Summer',
    ALL_TERRAIN:  'All-Terrain',
  };
  return map[s];
}

function vehicleTypeLabel(v: VehicleType): string {
  const map: Record<VehicleType, string> = {
    PASSENGER_CAR: 'Car',
    LIGHT_TRUCK:   'Pickup Truck',
    SUV_CROSSOVER: 'SUV',
  };
  return map[v];
}

function estimateShippingWeightLb(vehicleType: VehicleType): number {
  switch (vehicleType) {
    case 'LIGHT_TRUCK':   return 40;
    case 'SUV_CROSSOVER': return 35;
    default:              return 25; // PASSENGER_CAR
  }
}

function buildFeedItem(
  product: ShopifyProduct,
  variant: ShopifyVariant
): { item: WalmartFeedItem | null; skipReason?: string } {
  const parsed = parseTireSize(product.title);
  if (!parsed) {
    return { item: null, skipReason: `Could not parse tire size from title: "${product.title}"` };
  }

  // Price guard — never push $0 items
  const price = parseFloat(variant.price);
  if (!price || price <= 0) {
    return { item: null, skipReason: `Invalid price: ${variant.price}` };
  }

  // Image is required for Walmart listings
  const imageUrl = product.images?.sort((a, b) => a.position - b.position)[0]?.src ?? '';
  if (!imageUrl) {
    return { item: null, skipReason: 'No product image available' };
  }

  const season = getSeasonFromTags(product.tags);
  const vehicleType = getVehicleTypeFromTags(product.tags, parsed);
  const description = `${product.vendor} ${parsed.model} ${parsed.fullSize} tire. Available at GCI Tires Canada.`;

  const item: WalmartFeedItem = {
    Orderable: {
      sku: variant.sku,
      productIdentifiers: {
        productIdType: 'GTIN',
        productId: 'CUSTOM',
      },
      productName: { en: product.title },
      brand:        { en: product.vendor },
      price,
      ShippingWeight: {
        measure: estimateShippingWeightLb(vehicleType),
        unit: 'lb',
      },
      // General merchandise tax code — fully taxable under CA HST/GST
      productTaxCode: 2038411,
      shortDescription: { en: description },
      mainImageUrl: imageUrl,
      countryOfOriginAssembly: [countryOfOrigin(product.vendor)],
    },
    Visible: {
      Tires: {
        tireSize:       parsed.fullSize,
        tireWidth:      parseInt(parsed.sectionWidth, 10),
        tireAspectRatio: parseInt(parsed.aspectRatio, 10),
        wheelDiameter:  { measure: parseInt(parsed.rimDiameter, 10), unit: 'in' },
        tireSeason:     { en: seasonLabel(season) },
        vehicleType:    { en: vehicleTypeLabel(vehicleType) },
        constructionType: { en: 'Radial' },
        ...(parsed.prefix ? { vehicleClassDesignator: { en: parsed.prefix } } : {}),
      },
    },
  };

  return { item };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Use GET or POST' });
  }

  try {
    // ── Step 1: Fetch Shopify products ──────────────────────────────────────
    console.log('[walmart-item-feed] Fetching Shopify products...');
    const allProducts = await fetchShopifyProducts();
    console.log(`[walmart-item-feed] Fetched ${allProducts.length} products`);

    // ── Step 2: Build feed items ────────────────────────────────────────────
    const feedItems: WalmartFeedItem[] = [];
    const skipped: SkippedItem[] = [];

    for (const product of allProducts) {
      for (const variant of product.variants) {
        if (!variant.sku?.startsWith('TIRE-')) continue;

        const { item, skipReason } = buildFeedItem(product, variant);

        if (!item || skipReason) {
          skipped.push({ sku: variant.sku, reason: skipReason ?? 'Unknown' });
          continue;
        }

        feedItems.push(item);
      }
    }

    console.log(
      `[walmart-item-feed] Built ${feedItems.length} feed items, skipped ${skipped.length}`
    );

    if (feedItems.length === 0) {
      return res.status(200).json({
        success: false,
        message: 'No valid feed items built — check skipped list for reasons',
        submitted: 0,
        skipped: skipped.length,
        skippedItems: skipped,
      });
    }

    // ── Step 3: Submit MP_ITEM_INTL feed to Walmart ─────────────────────────
    const token = await getWalmartToken();
    const correlationId = uuidv4();

    const feedPayload = {
      MPItemFeedHeader: {
        requestId:     correlationId,
        version:       '3.16',
        processMode:   'REPLACE',
        subset:        'EXTERNAL',
        mart:          'WALMART_CA',
        sellingChannel: 'marketplace',
        subCategory:   'tires',
        locale:        ['en', 'fr'],
      },
      MPItem: feedItems,
    };

    console.log(
      `[walmart-item-feed] Submitting MP_ITEM_INTL feed with ${feedItems.length} items...`
    );

    const walmartRes = await fetch(
      `${process.env.WALMART_BASE_URL}/v3/feeds?feedType=MP_ITEM_INTL`,
      {
        method: 'POST',
        headers: {
          'WM_SEC.ACCESS_TOKEN':   token,
          'WM_GLOBAL_VERSION':     '3.1',
          'WM_MARKET':             'ca',
          'WM_SVC.NAME':           'Walmart Marketplace',
          'WM_QOS.CORRELATION_ID': correlationId,
          Accept:                  'application/json',
          'Content-Type':          'application/json',
        },
        body: JSON.stringify(feedPayload),
      }
    );

    const walmartData = await walmartRes.json();

    if (!walmartRes.ok) {
      console.error('[walmart-item-feed] Walmart rejected feed:', walmartData);
      return res.status(walmartRes.status).json({
        success: false,
        error: 'Walmart feed submission failed',
        details: walmartData,
        submitted: 0,
        skipped: skipped.length,
      });
    }

    const feedId: string = walmartData.feedId;
    console.log(`[walmart-item-feed] Feed accepted. feedId: ${feedId}`);

    // ── Step 4: Return result ───────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      feedId,
      message: `Feed submitted successfully. Poll /api/walmart-feed-status?feedId=${feedId} to track progress.`,
      submitted: feedItems.length,
      skipped: skipped.length,
      skippedItems: skipped,
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[walmart-item-feed] Unhandled error:', message);
    return res.status(500).json({ error: message });
  }
}
