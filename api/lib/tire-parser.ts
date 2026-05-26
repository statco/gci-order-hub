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
 * FORMAT 3: Standard metric tire sizes: 215/55R17, LT265/70R17, P205/65R15
 * The /i flag handles lowercase 'r' (e.g. 310/r15) — no separate regex needed.
 * Groups: [1] prefix (LT/P optional), [2] section width, [3] aspect ratio, [4] rim diameter
 */
const TIRE_SIZE_REGEX = /\b(LT|P)?(\d{3})\/(\d{2,3})R(\d{2})\b/i;

/**
 * FORMAT 1: Cross-section flotation sizes: 31X10.50R15, 33X12.50R15
 * Groups: [1] overall diameter (in), [2] section width (in, may have decimal), [3] rim diameter (in)
 */
const FLOTATION_REGEX = /\b(\d{2})X(\d{2}(?:\.\d+)?)R(\d{2})\b/i;

/**
 * FORMAT 2: Compact flotation sizes: 3513/R, 3313/R
 * Groups: [1] section width (in, 2 digits), [2] rim diameter (in, 2 digits)
 * Flotation sizes are always light truck — prefix is hardcoded LT.
 */
const COMPACT_FLOTATION_REGEX = /\b(\d{2})(\d{2})\/R\b/i;

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
 * Tries three formats in order:
 *   1. Cross-section flotation: 31X10.50R15
 *   2. Compact flotation: 3513/R
 *   3. Standard metric: 215/55R17 (also handles lowercase r via /i flag)
 *
 * @returns ParsedTire | null if no size found
 */
export function parseTireSize(title: string): ParsedTire | null {
  function extractModel(fullMatch: string): string {
    const brandEnd = title.indexOf(' ') + 1;  // skip first word (brand)
    const sizeStart = title.indexOf(fullMatch);
    return title.slice(brandEnd, sizeStart).trim() || 'Unknown';
  }

  // FORMAT 1: Cross-section flotation, e.g. 31X10.50R15
  const flotationMatch = title.match(FLOTATION_REGEX);
  if (flotationMatch) {
    const [fullMatch, overallDiameter, sectionWidthInches, rimDiameterStr] = flotationMatch;
    const sectionWidthFloat = parseFloat(sectionWidthInches);
    const rimDiameterInt    = parseInt(rimDiameterStr, 10);
    const width       = Math.round(sectionWidthFloat * 25.4);
    const aspectRatio = Math.round(
      ((parseInt(overallDiameter, 10) - rimDiameterInt) / 2 / sectionWidthFloat) * 100,
    );
    const matchIdx    = flotationMatch.index ?? 0;
    const prefix: 'LT' | null = title.slice(0, matchIdx).toUpperCase().includes('LT')
      ? 'LT'
      : null;

    return {
      prefix,
      sectionWidth:     String(width),
      aspectRatio:      String(aspectRatio),
      constructionType: 'R',
      rimDiameter:      String(rimDiameterInt),
      model:            extractModel(fullMatch),
      fullSize:         fullMatch,
    };
  }

  // FORMAT 2: Compact flotation, e.g. 3513/R, 3313/R
  const compactMatch = title.match(COMPACT_FLOTATION_REGEX);
  if (compactMatch) {
    const [fullMatch, widthInchesStr, rimDiameterStr] = compactMatch;
    const width       = Math.round(parseInt(widthInchesStr, 10) * 25.4);
    const rimDiameter = parseInt(rimDiameterStr, 10);

    return {
      prefix:           'LT',  // flotation sizes are always light truck
      sectionWidth:     String(width),
      aspectRatio:      '0',   // not applicable for flotation; Walmart accepts 0
      constructionType: 'R',
      rimDiameter:      String(rimDiameter),
      model:            extractModel(fullMatch),
      fullSize:         fullMatch,
    };
  }

  // FORMAT 3: Standard metric, e.g. 215/55R17, LT265/70R17, P205/65R15
  // The /i flag on TIRE_SIZE_REGEX already handles lowercase 'r' (e.g. 310/r15).
  const match = title.match(TIRE_SIZE_REGEX);
  if (!match) {
    console.warn(`[tire-parser] No size pattern matched: "${title}"`);
    return null;
  }

  const [fullMatch, rawPrefix, sectionWidth, aspectRatio, rimDiameter] = match;
  const prefix = rawPrefix ? (rawPrefix.toUpperCase() as 'P' | 'LT') : null;
  const brandEnd  = title.indexOf(' ') + 1;
  const sizeStart = title.indexOf(fullMatch);
  const model     = title.slice(brandEnd, sizeStart).trim();

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
