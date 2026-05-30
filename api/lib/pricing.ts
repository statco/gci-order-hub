// api/lib/pricing.ts
// ─────────────────────────────────────────────────────────────
// LAYER 1 — Structural cost floor (the core permanent fix).
//
// No code path may ever push a Walmart price below
// `cost × PRICE_FLOOR_MULTIPLIER`. This is enforced at the single
// moment of every price write so that — even if Shopify data is
// corrupt, a feed is stale, or a sync misfires — a below-cost price
// CANNOT physically reach Walmart.
//
// `safeWalmartPrice()` is the ONLY sanctioned way to compute a
// Walmart price. `assertAboveCost()` is the defense-in-depth
// backstop that runs immediately before the PUT.
// ─────────────────────────────────────────────────────────────

/** The ONLY allowed multiplier floor. Tune with Patrick if needed. */
export const PRICE_FLOOR_MULTIPLIER = 1.15; // cost + 15% minimum margin

/**
 * Computes the final Walmart price with a hard cost floor.
 *
 * Returns null if we cannot safely price the item (missing/invalid
 * cost) — the caller MUST skip the write, never guess.
 */
export function safeWalmartPrice(opts: {
  shopifyPrice: number | null;
  cost: number | null;
}): number | null {
  const { shopifyPrice, cost } = opts;

  // If we don't know the cost, we cannot guarantee a safe price → skip.
  if (cost == null || isNaN(cost) || cost <= 0) return null;

  const floor = cost * PRICE_FLOOR_MULTIPLIER;

  // If no valid Shopify price, fall back to the floor (never below cost).
  if (shopifyPrice == null || isNaN(shopifyPrice) || shopifyPrice <= 0) {
    return roundTo99(floor);
  }

  // Use the higher of (Shopify price) and (cost floor). Never go below floor.
  return roundTo99(Math.max(shopifyPrice, floor));
}

/**
 * Match existing convention: round up to the nearest .99.
 */
export function roundTo99(n: number): number {
  return Math.ceil(n) - 0.01;
}

/**
 * Defense-in-depth backstop. Throws if a computed amount would land
 * below cost. Call this immediately before any price PUT so that a
 * below-cost write fails loudly rather than silently succeeding.
 */
export function assertAboveCost(sku: string, amount: number, cost: number | null): void {
  if (cost != null && !isNaN(cost) && cost > 0 && amount < cost) {
    throw new Error(`BLOCKED: refusing to set ${sku} to ${amount} (below cost ${cost})`);
  }
}
