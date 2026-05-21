/**
 * tire-parser.ts
 * Parses tire size, season, and vehicle type from Shopify product data.
 * Used by walmart-item-feed.ts to build structured attributes for the Walmart item feed.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedTire {
  prefix: 'P' | 'LT' | null;    // Tire designation prefix
  sectionWidth: string;           // e.g. "215"
  aspectRatio: string;            // e.g. "55"
  constructionType: string;       // Always "R" (radial) for modern tires
  rimDiameter: string;            // e.g. "17"
  model: string;                  // e.g. "Quatrac" (title minus brand and size)
  fullSize: string;               // e.g. "215/55R17"
}

export type SeasonClassification =
  | 'ALL_SEASON'
  | 'ALL_WEATHER'
  | 'WINTER'
  | 'SUMMER'
  | 'ALL_TERRAIN';

export type VehicleType =
  | 'PASSENGER_CAR'
  | 'LIGHT_TRUCK'
  | 'SUV_CROSSOVER';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Matches standard tire sizes like: 215/55R17, LT265/70R17, P205/65R15
 * Groups: [1] prefix (LT/P optional), [2] section width, [3] aspect ratio, [4] rim diameter
 */
const TIRE_SIZE_REGEX = /\b(LT|P)?(\d{3})\/(\d{2,3})R(\d{2})\b/i;

/**
 * Shopify tag → Walmart season classification.
 * Tags are stored lowercase in Shopify (e.g. "all-weather", "winter").
 * Priority order determines winner when a product has multiple season tags.
 */
const SEASON_TAG_MAP: Record<string, SeasonClassification> = {
  'winter':      'WINTER',
  'all-weather': 'ALL_WEATHER',
  'summer':      'SUMMER',
  'all-terrain': 'ALL_TERRAIN',
  'all-season':  'ALL_SEASON',
};

const SEASON_PRIORITY: SeasonClassification[] = [
  'WINTER', 'ALL_WEATHER', 'SUMMER', 'ALL_TERRAIN', 'ALL_SEASON',
];

// ─── Parsers ──────────────────────────────────────────────────────────────────

/**
 * Parses a tire size string from a Shopify product title.
 *
 * Title format expected: "{Brand} {Model} {Size}"
 * Example: "Vredestein Quatrac 215/55R17" → model = "Quatrac", size = "215/55R17"
 *
 * @returns ParsedTire | null if no size found (non-tire product, bad title, etc.)
 */
export function parseTireSize(title: string): ParsedTire | null {
  const match = title.match(TIRE_SIZE_REGEX);
  if (!match) return null;

  const [fullMatch, rawPrefix, sectionWidth, aspectRatio, rimDiameter] = match;
  const prefix = rawPrefix
    ? (rawPrefix.toUpperCase() as 'P' | 'LT')
    : null;

  // Model = everything after the first word (brand) up to the size string
  const brandEnd = title.indexOf(' ') + 1;           // skip brand (first word)
  const sizeStart = title.indexOf(fullMatch);
  const model = title.slice(brandEnd, sizeStart).trim();

  return {
    prefix,
    sectionWidth,
    aspectRatio,
    constructionType: 'R',
    rimDiameter,
    model: model || 'Unknown',
    fullSize: fullMatch,
  };
}

/**
 * Derives Walmart season classification from Shopify tags.
 * Tags are expected as a comma-separated string (Shopify REST format).
 *
 * Highest-priority matching season wins (WINTER > ALL_WEATHER > SUMMER > ALL_TERRAIN > ALL_SEASON).
 * Defaults to ALL_SEASON if no matching tag found.
 */
export function getSeasonFromTags(tags: string): SeasonClassification {
  const tagList = tags.split(',').map(t => t.trim().toLowerCase());

  for (const season of SEASON_PRIORITY) {
    const tagKey = Object.entries(SEASON_TAG_MAP).find(([, v]) => v === season)?.[0];
    if (tagKey && tagList.includes(tagKey)) return season;
  }

  return 'ALL_SEASON'; // fallback
}

/**
 * Derives Walmart vehicle type from Shopify tags and the parsed tire prefix.
 *
 * Detection order:
 *   1. LT prefix in tire size (e.g. LT265/70R17) → LIGHT_TRUCK
 *   2. "light-truck" or "lt" tag → LIGHT_TRUCK
 *   3. "suv" or "crossover" tag → SUV_CROSSOVER
 *   4. Default → PASSENGER_CAR
 */
export function getVehicleTypeFromTags(
  tags: string,
  parsed: ParsedTire
): VehicleType {
  if (parsed.prefix === 'LT') return 'LIGHT_TRUCK';

  const tagList = tags.split(',').map(t => t.trim().toLowerCase());

  if (tagList.some(t => t === 'light-truck' || t === 'lt')) return 'LIGHT_TRUCK';
  if (tagList.some(t => t === 'suv' || t === 'crossover' || t === 'suv-crossover')) {
    return 'SUV_CROSSOVER';
  }

  return 'PASSENGER_CAR';
}

/**
 * Strips HTML tags from Shopify body_html and truncates for Walmart description field.
 */
export function sanitizeDescription(html: string, maxLength = 4000): string {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
