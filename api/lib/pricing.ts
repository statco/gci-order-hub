// api/lib/pricing.ts
// ----------------------------------------------------------------
// LAYER 1 - Structural cost floor (the core permanent fix).
//
// No code path may ever push a Walmart price below the real landed-cost
// floor. This is enforced at the single moment of every price write so
// that - even if Shopify data is corrupt, a feed is stale, or a sync
// misfires - a below-cost price CANNOT physically reach Walmart.
//
// safeWalmartPrice() is the ONLY sanctioned way to compute a Walmart price.
// assertAboveCost() is the defense-in-depth backstop that runs immediately
// before the PUT.
//
// CHANGED 2026-08-22: previously floored at cost x 1.15 (a flat 15% margin
// over raw dealer cost only), with no accounting for CT freight, Walmart's
// 10% referral fee, or tax. That gap - together with gci-walmart-sync's
// separate, DIFFERENT safeWalmartPrice() implementation (cost x 1.05) - is
// the confirmed root cause of at least 4 historical below-cost orders (see
// GCI margin analysis, Aug 2026). Both implementations now share the same
// underlying formula (lib/pricing/landedCost.ts), though they remain two
// separate files pending a real shared package - see PR description.
//
// assertAboveCost() is intentionally kept as a SEPARATE, cruder check
// (raw cost only, no freight/fee/margin) - it's meant to catch catastrophic
// failures (e.g. accidentally pricing at $0), not to be the real floor.
// ----------------------------------------------------------------

import { computePriceFloor, type TireType } from './pricing/landedCost';

const WALMART_FEE = 0.10;   // Tires & Wheels contract category, Walmart Marketplace Canada
const TARGET_MARGIN = 0.20; // current target - tune with Patrick if needed

/** @deprecated kept only for any code still importing the old constant name;
 * no longer used by safeWalmartPrice(), which now computes a real landed-cost
 * floor instead of a flat multiplier. */
export const PRICE_FLOOR_MULTIPLIER = 1.15;

export interface SafeWalmartPriceOpts {
  shopifyPrice: number | null;
  cost: number | null;
  /** Eco fee charged by CT on this SKU, if known - omit to treat as $0. */
  ecoFee?: number;
  /** 'Passenger' | 'LT' - omit to fall back to the most conservative class,
   *  which guarantees the floor never UNDER-protects but may over-pad SKUs
   *  we don't have real tire specs for yet. */
  tireType?: TireType | null;
  /** Rim diameter in inches - omit to fall back to the most conservative class. */
  rimSize?: number | null;
  freightStrategy?: 'worst-case' | 'typical-zone';
}

/**
 * Computes the final Walmart price with a real landed-cost floor.
 *
 * Returns null if we cannot safely price the item (missing/invalid
 * cost) - the caller MUST skip the write, never guess.
 */
export function safeWalmartPrice(opts: SafeWalmartPriceOpts): number | null {
  const { shopifyPrice, cost } = opts;

  // If we don't know the cost, we cannot guarantee a safe price -> skip.
  if (cost == null || isNaN(cost) || cost <= 0) return null;

  const { floor } = computePriceFloor(
    {
      productCost: cost,
      ecoFee: opts.ecoFee,
      tireType: opts.tireType ?? 'LT',
      rimSize: opts.rimSize ?? 22,
    },
    WALMART_FEE,
    TARGET_MARGIN,
    opts.freightStrategy ?? 'typical-zone'
  );

  // If no valid Shopify price, fall back to the floor (never below floor).
  if (shopifyPrice == null || isNaN(shopifyPrice) || shopifyPrice <= 0) {
    return roundTo99(floor);
  }

  // Use the higher of (Shopify price) and (landed-cost floor). Never go below floor.
  return roundTo99(Math.max(shopifyPrice, floor));
}

/**
 * Match existing convention: round up to the nearest .99.
 */
export function roundTo99(n: number): number {
  return Math.ceil(n) - 0.01;
}

/**
 * Defense-in-depth backstop. Throws if a computed amount would land below
 * RAW cost (not the full landed-cost floor - this is a cruder, cheaper
 * catastrophic-failure check, not the real floor). Call this immediately
 * before any price PUT so that a below-cost write fails loudly rather than
 * silently succeeding.
 */
export function assertAboveCost(sku: string, amount: number, cost: number | null): void {
  if (cost != null && !isNaN(cost) && cost > 0 && amount < cost) {
    throw new Error(`BLOCKED: refusing to set ${sku} to ${amount} (below cost ${cost})`);
  }
}
