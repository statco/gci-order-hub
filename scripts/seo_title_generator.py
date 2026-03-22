#!/usr/bin/env python3
"""
seo_title_generator.py
═══════════════════════════════════════════════════════════════
One-time script: generate Walmart-ready SEO titles and
product descriptions for GCI tire listings.

INPUT CSV columns (required):
  Brand    — e.g. "Cooper"
  Model    — e.g. "Discoverer AT3 4S"
  Size     — e.g. "265/70R17"

INPUT CSV fitment columns (any of the following layouts):
  A) Single column:  "Fitment" or "Vehicles" — comma-separated vehicle names
  B) Multi-column:   Fits_1, Fits_2, Fits_3, …
  C) Multi-column:   Vehicle_1, Vehicle_2, Vehicle_3, …

OUTPUT CSV adds two new columns:
  Product Name — Walmart-ready title (≤200 chars)
  Description  — Walmart product description

TITLE FORMULA:
  [Brand] [Model] [Size] Tire - Fits [Top 3 Vehicles] - GCI AI Fitment Guaranteed

USAGE:
  pip install pandas
  python3 scripts/seo_title_generator.py -i tires.csv -o walmart_tires.csv
  python3 scripts/seo_title_generator.py -i tires.csv --fitment-column Fitment --dry-run
"""

import argparse
import re
import sys
import textwrap
from pathlib import Path

import pandas as pd

# ─── CONSTANTS ────────────────────────────────────────────────

TITLE_MAX    = 200
SUFFIX       = " - GCI AI Fitment Guaranteed"
CANADA_NOTE  = (
    "Ships from our Canadian warehouse — fast delivery across Canada. "
    "Every tire includes the GCI AI Fitment Guarantee: our AI verifies "
    "compatibility with your specific vehicle before purchase so you can "
    "buy with complete confidence. Questions about fitment? Contact us anytime."
)

# Auto-detected single-column fitment headers (checked in order)
FITMENT_COLS = ["Fitment", "Vehicles", "Vehicle Fitment", "fits", "Fits"]


# ─── HELPERS ──────────────────────────────────────────────────

def _clean(v: str) -> str:
    return re.sub(r"\s+", " ", str(v).strip())


def parse_vehicles(row: "pd.Series[str]", fitment_col: str | None, max_v: int) -> list[str]:
    """Return up to max_v vehicle strings from the row."""
    vehicles: list[str] = []

    # Option 1 — caller-supplied column
    if fitment_col and fitment_col in row.index:
        vehicles = [_clean(v) for v in str(row[fitment_col]).split(",") if v.strip()]

    # Option 2 — auto-detect single column
    if not vehicles:
        for col in FITMENT_COLS:
            if col in row.index and str(row[col]).strip():
                vehicles = [_clean(v) for v in str(row[col]).split(",") if v.strip()]
                break

    # Option 3 — Fits_1, Fits_2, …
    if not vehicles:
        for i in range(1, 25):
            col = f"Fits_{i}"
            if col in row.index and _clean(str(row[col])):
                vehicles.append(_clean(str(row[col])))

    # Option 4 — Vehicle_1, Vehicle_2, …
    if not vehicles:
        for i in range(1, 25):
            col = f"Vehicle_{i}"
            if col in row.index and _clean(str(row[col])):
                vehicles.append(_clean(str(row[col])))

    # Deduplicate, preserve order
    seen: set[str] = set()
    out:  list[str] = []
    for v in vehicles:
        if v and v not in seen:
            seen.add(v)
            out.append(v)

    return out[:max_v]


def build_title(brand: str, model: str, size: str, vehicles: list[str]) -> str:
    """
    Assemble title, trimming vehicles one-by-one if over 200 chars.
    Hard-truncates with ellipsis as last resort (should never happen
    with normal tire data).
    """
    base = f"{brand} {model} {size} Tire"

    def assemble(vlist: list[str]) -> str:
        if vlist:
            return f"{base} - Fits {', '.join(vlist)}{SUFFIX}"
        return f"{base}{SUFFIX}"

    title = assemble(vehicles)
    v     = list(vehicles)
    while len(title) > TITLE_MAX and v:
        v.pop()
        title = assemble(v)

    if len(title) > TITLE_MAX:
        title = title[:TITLE_MAX - 1] + "…"

    return title


def build_description(brand: str, model: str, size: str, vehicles: list[str]) -> str:
    fitment = (
        f"Compatible with: {', '.join(vehicles)}. "
        if vehicles else ""
    )
    return (
        f"The {brand} {model} ({size}) is a premium tire "
        f"available through GCI Tire. "
        f"{fitment}{CANADA_NOTE}"
    )


# ─── MAIN ─────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate Walmart-ready SEO titles and descriptions for tire products.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            Examples:
              python3 scripts/seo_title_generator.py -i tires.csv -o walmart.csv
              python3 scripts/seo_title_generator.py -i tires.csv --fitment-column Fitment --dry-run
              python3 scripts/seo_title_generator.py -i tires.csv --max-vehicles 2
        """),
    )
    parser.add_argument("-i", "--input",          required=True,         help="Input CSV path")
    parser.add_argument("-o", "--output",         default=None,          help="Output CSV path (default: <input>_walmart.csv)")
    parser.add_argument("--fitment-column",       default=None,          help="Single column with comma-separated vehicles")
    parser.add_argument("--max-vehicles",         default=3, type=int,   help="Max vehicles in title (default: 3)")
    parser.add_argument("--dry-run",              action="store_true",   help="Print first 5 rows, don't write file")
    args = parser.parse_args()

    src = Path(args.input)
    if not src.exists():
        print(f"❌ File not found: {src}", file=sys.stderr)
        sys.exit(1)

    dst = Path(args.output) if args.output else src.with_stem(src.stem + "_walmart")

    try:
        df = pd.read_csv(src, dtype=str).fillna("")
    except Exception as e:
        print(f"❌ Could not read CSV: {e}", file=sys.stderr)
        sys.exit(1)

    for col in ("Brand", "Model", "Size"):
        if col not in df.columns:
            print(f"❌ Missing required column: '{col}'", file=sys.stderr)
            print(f"   Found: {list(df.columns)}", file=sys.stderr)
            sys.exit(1)

    print(f"📂 {len(df)} rows loaded from {src}")

    titles:  list[str] = []
    descs:   list[str] = []
    lengths: list[int] = []
    truncated = 0

    for _, row in df.iterrows():
        brand    = _clean(row["Brand"])
        model    = _clean(row["Model"])
        size     = _clean(row["Size"])
        vehicles = parse_vehicles(row, args.fitment_column, args.max_vehicles)

        title = build_title(brand, model, size, vehicles)
        desc  = build_description(brand, model, size, vehicles)

        titles.append(title)
        descs.append(desc)
        lengths.append(len(title))
        if title.endswith("…") or len(title) == TITLE_MAX:
            truncated += 1

    df["Product Name"] = titles
    df["Description"]  = descs

    avg = sum(lengths) / len(lengths) if lengths else 0
    over = sum(1 for l in lengths if l > TITLE_MAX)
    print(f"✅ Titles generated:  {len(df)}")
    print(f"   Avg length:        {avg:.0f} chars  (max allowed: {TITLE_MAX})")
    print(f"   Max length seen:   {max(lengths, default=0)} chars")
    print(f"   Truncated:         {truncated}")
    print(f"   Over {TITLE_MAX} chars: {over}  (should be 0)")

    if args.dry_run:
        print("\n── DRY RUN: first 5 rows ─────────────────────────────")
        for idx, row in df[["Brand", "Model", "Size", "Product Name", "Description"]].head(5).iterrows():
            title = row["Product Name"]
            desc  = row["Description"]
            print(f"\nRow {int(idx) + 1}:  [{len(title)} chars]")
            print(f"  TITLE: {title}")
            print(f"  DESC:  {desc[:120]}…")
        print("\nNo file written (--dry-run).")
        return

    try:
        df.to_csv(dst, index=False, encoding="utf-8-sig")  # BOM for Excel compat
        print(f"💾 Output written to: {dst}")
    except Exception as e:
        print(f"❌ Write failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
