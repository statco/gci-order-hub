// landedCost.ts
// ─────────────────────────────────────────────────────────────────────────
// THE FIX: replaces the two divergent, under-protective safeWalmartPrice()
// implementations (gci-walmart-sync: cost×1.05, gci-order-hub: cost×1.15 —
// neither accounting for freight, channel fee, or tax) with a single correct
// landed-cost price floor:
//
//   Price Floor = True Landed Cost ÷ (1 − Channel Fee% − Target Margin%)
//   True Landed Cost = Product Cost + Eco Fee + Freight + Non-recoverable Tax
//
// KEY CONSTRAINT: Walmart/Shopify listing prices are per-SKU, not per-order —
// there is no way to know the buyer's destination at listing time. So freight
// here uses the WORST-CASE zone (zone 16) for the tire's type/rim-size class,
// not an order-specific zone. This protects margin on every possible
// destination, at the cost of some padding on nearby/cheap-zone sales. If real
// order-geography data later shows worst-case is overly conservative for a
// given SKU, a weighted-average zone could replace this — flagged as a
// follow-up, not implemented here.
// ─────────────────────────────────────────────────────────────────────────

import { RATE_MATRIX, type TireType } from './freightRates';

export type { TireType } from './freightRates';

// ─── Freight ────────────────────────────────────────────────────────────

/**
 * Worst-case freight for a single tire of the given type/rim size, using the
 * most expensive zone (16) in CT's published rate table. Falls back to the
 * single most expensive class in the whole table (LT, rim 19-22) if the
 * type/rim combo is unrecognized — fails safe rather than under-floors.
 */
export function worstCaseFreightPerTire(tireType: TireType, rimSize: number): number {
  const clampedRim = Math.min(Math.max(rimSize, 13), 22); // CT's table only covers rim 13-22
  const key = `${tireType}_${clampedRim}`;
  const entry = RATE_MATRIX[key];
  if (!entry) {
    // Unrecognized tireType entirely — fail safe using the single worst class in the table.
    const fallback = RATE_MATRIX['LT_22'];
    return fallback.min4ByZone[fallback.min4ByZone.length - 1];
  }
  // min4ByZone covers 1-4 tires as a flat charge — for a single-unit floor,
  // that flat charge IS the per-tire freight (no averaging across a bundle).
  return entry.min4ByZone[entry.min4ByZone.length - 1];
}

/**
 * TYPICAL_ZONE_CUTOFF = 13. Chosen by inspecting the FSA→zone distribution
 * across all 7 CT warehouses (see fsa_zone_map.json / freightRates.ts):
 * zone 13 is consistently where each warehouse's "normal" shipping footprint
 * tops out, before the truly remote north/rural pockets (zones 14-16) begin.
 * This is a commercial judgment call, not a hard fact — it means an order to
 * one of the most remote ~15-20% of Canadian postal regions could still cost
 * more in real freight than this floor assumes. Re-derive if CT's zone
 * definitions change, or if GCI's actual order-geography data (once enough
 * volume accumulates) suggests a different cutoff.
 */
export const TYPICAL_ZONE_CUTOFF = 13;

/** More commercially realistic than worstCaseFreightPerTire — covers the
 * large majority of destinations, not the single most remote possible one. */
export function typicalZoneFreightPerTire(tireType: TireType, rimSize: number): number {
  const clampedRim = Math.min(Math.max(rimSize, 13), 22);
  const key = `${tireType}_${clampedRim}`;
  const entry = RATE_MATRIX[key];
  if (!entry) {
    const fallback = RATE_MATRIX['LT_22'];
    return fallback.min4ByZone[TYPICAL_ZONE_CUTOFF - 1];
  }
  return entry.min4ByZone[TYPICAL_ZONE_CUTOFF - 1];
}

/**
 * Exact freight for a known shipment (destination zone known, e.g. auditing
 * a real historical order) — NOT used for listing-price floors, only for
 * post-hoc margin verification where the actual destination is known.
 */
export function freightForKnownShipment(
  tireType: TireType,
  rimSize: number,
  zone: number, // 1-16
  qty: number
): number {
  const key = `${tireType}_${rimSize}`;
  const entry = RATE_MATRIX[key];
  if (!entry) throw new Error(`No rate entry for ${key}`);
  const zoneIdx = Math.min(Math.max(zone, 1), 16) - 1;
  const min4 = entry.min4ByZone[zoneIdx];
  if (qty <= 4) return min4;
  const perAdditional = entry.perAdditionalByZone[zoneIdx];
  return min4 + (qty - 4) * perAdditional;
}

// ─── Non-recoverable tax ───────────────────────────────────────────────
//
// OPEN QUESTION FOR PAT: is GCI registered for GST/HST and actively claiming
// Input Tax Credits? The prior code (gci-brain/api/bulkPriceUpdate.ts) assumed
// NOT registered ("non-recoverable below $30k GST threshold") and applied a
// flat 12% tax markup to every order regardless of destination. That flat 12%
// happens to match BC's actual GST+PST combined rate (5%+7%) almost exactly,
// but is WRONG for HST provinces (ON/NS/NB/PEI/NL) if GCI is a registrant —
// HST is fully recoverable via ITC in that case, and this 12% markup would be
// needlessly inflating the price floor (and therefore prices) on those orders.
//
// Until confirmed, this module keeps the conservative assumption (tax is
// non-recoverable) but makes it a single named, easily-flipped constant
// instead of being silently baked into the formula.

export const ASSUME_TAX_RECOVERABLE = false; // ← flip to `true` once confirmed with Pat/accountant

/** Blended non-recoverable tax rate, applied to product+eco cost only (not freight, which CT bills with its own tax treatment already reflected in invoices). */
export const NON_RECOVERABLE_TAX_RATE = ASSUME_TAX_RECOVERABLE ? 0 : 0.12;

// ─── Price floor ────────────────────────────────────────────────────────

export interface LandedCostInput {
  productCost: number;
  ecoFee?: number;
  tireType: TireType;
  rimSize: number;
}

export interface PriceFloorResult {
  landedCost: number;
  freight: number;
  floor: number;
  channelFeePct: number;
  targetMarginPct: number;
}

/**
 * The one and only landed-cost price floor calculation. Both gci-walmart-sync
 * and gci-order-hub's safeWalmartPrice() should call this — see the patched
 * versions of each in this same drop.
 */
export function computePriceFloor(
  input: LandedCostInput,
  channelFeePct: number, // e.g. 0.10 for Walmart, 0.0299 for Shopify
  targetMarginPct: number = 0.20,
  freightStrategy: 'worst-case' | 'typical-zone' = 'typical-zone'
): PriceFloorResult {
  const ecoFee = input.ecoFee ?? 0;
  const freight =
    freightStrategy === 'worst-case'
      ? worstCaseFreightPerTire(input.tireType, input.rimSize)
      : typicalZoneFreightPerTire(input.tireType, input.rimSize);
  const taxedProductCost = input.productCost * (1 + NON_RECOVERABLE_TAX_RATE);
  const landedCost = taxedProductCost + ecoFee + freight;
  const floor = landedCost / (1 - channelFeePct - targetMarginPct);

  return { landedCost, freight, floor, channelFeePct, targetMarginPct };
}

/** Round up to the nearest .99, matching existing repo convention. */
export function roundTo99(n: number): number {
  return Math.ceil(n) - 0.01;
}
