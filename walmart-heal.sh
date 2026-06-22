#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Walmart mode=listed HEAL WALK — gci-order-hub
# Re-pushes real active-Shopify quantities (or 0 for archived/draft) to every
# listed Walmart SKU, walking offsets at the proven-safe limit=50 (~78s/chunk).
#
# SAFE BY CONSTRUCTION: Fix A guarantees each push is a real active-Shopify
# quantity or 0 — never a Walmart listing-view default. Worst case is under-sell.
#
# This script will NOT advance past a chunk that returns non-200 or non-JSON
# (e.g. a 504 timeout) — it aborts and tells you where to resume.
#
# ── PRE-FLIGHT (do these once) ───────────────────────────────────────────────
#  1. DRY param name: this script uses `&dry=true`. CONFIRM that's what
#     api/walmart-sync.ts checks — the handoff says `dry`, an earlier debug note
#     said `dryRun`. If the code expects `dryRun`, then DRY=true is SILENTLY
#     IGNORED and the run is LIVE. Verify before trusting dry mode.
#  2. Start with DRY=true. Inspect the chunk-1 sample. Only then set DRY=false.
#  3. The script pauses for confirmation after chunk 1 regardless of DRY.
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

BASE="https://gci-order-hub.vercel.app/api/walmart-sync"
MODE="listed"
LIMIT=50            # proven: 78s/HTTP200. Do NOT raise without a sub-120s probe.
SLEEP=5             # seconds between chunks (Walmart rate-pressure margin)
DRY=false            # START HERE. Flip to false only after a clean chunk-1 sample.
DRY_PARAM="dry"     # change to "dryRun" if that's what the handler reads
START_OFFSET=0      # set to a chunk's offset to RESUME after an abort
MAX_OFFSET=4000     # safety cap: abort if nextOffset ever exceeds this
LOGDIR="/tmp/walmart-heal-$(date +%Y%m%d-%H%M%S)"

mkdir -p "$LOGDIR"
echo "Heal walk → mode=$MODE limit=$LIMIT dry=$DRY  start_offset=$START_OFFSET"
echo "Logs: $LOGDIR"
echo "------------------------------------------------------------------------"

offset="$START_OFFSET"
chunk=0

while :; do
  chunk=$((chunk + 1))
  url="${BASE}?mode=${MODE}&offset=${offset}&limit=${LIMIT}"
  [ "$DRY" = "true" ] && url="${url}&${DRY_PARAM}=true"

  body="${LOGDIR}/chunk_${offset}.json"
  meta=$(curl -s "$url" -w "%{http_code} %{time_total}" -o "$body")
  code="${meta%% *}"
  secs="${meta##* }"

  # ── Guard 1: any non-200 → abort, do NOT advance ──────────────────────────
  if [ "$code" != "200" ]; then
    echo "[chunk $chunk] offset=$offset  HTTP $code  ${secs}s  → ABORT (non-200)"
    echo "  raw head: $(head -c 300 "$body")"
    echo "  A 504 here may have PARTIALLY applied this chunk (accepted != applied)."
    echo "  Resume after verifying: set START_OFFSET=$offset and re-run."
    exit 1
  fi

  # ── Guard 2: 200 but not valid JSON (HTML error page) → abort ─────────────
  if ! jq -e . "$body" >/dev/null 2>&1; then
    echo "[chunk $chunk] offset=$offset  HTTP 200 but NON-JSON  ${secs}s  → ABORT"
    echo "  raw head: $(head -c 300 "$body")"
    exit 1
  fi

  # ── Guard 3: ok:false → abort and dump ────────────────────────────────────
  ok=$(jq -r '.ok // false' "$body")
  if [ "$ok" != "true" ]; then
    echo "[chunk $chunk] offset=$offset  ok=$ok  ${secs}s  → ABORT"
    jq '.' "$body"
    exit 1
  fi

  # ── Per-chunk summary (real fields, not success counts) ───────────────────
  jq -r --arg c "$chunk" --arg s "$secs" '
    "[chunk \($c)] offset=\(.offset)  \($s)s  processed=\(.processed)  " +
    "inv_ok=\(.inventoryResult.success // 0)  inv_fail=\(.inventoryResult.failed // 0)  " +
    "zeroedNoMatch=\(.zeroedNoActiveMatch // 0)  held=\(.heldExposedCount // 0)  " +
    "noCost=\(.skippedNoCostCount // 0)  next=\(.nextOffset)  done=\(.done)"
  ' "$body"
  # Surface any held / no-cost SKUs (rare; worth eyeballing)
  jq -r 'if (.heldExposedCount // 0) > 0 then "    held:   " + (.heldExposed   | join(", ")) else empty end' "$body"
  jq -r 'if (.skippedNoCostCount // 0) > 0 then "    noCost: " + (.skippedNoCost | join(", ")) else empty end' "$body"

  done_flag=$(jq -r '.done' "$body")
  next=$(jq -r '.nextOffset' "$body")

  # ── Completed the walk ────────────────────────────────────────────────────
  if [ "$done_flag" = "true" ]; then
    echo "------------------------------------------------------------------------"
    echo "DONE after $chunk chunks."
    break
  fi

  # ── Guard 4: nextOffset must be numeric, advancing, under cap ─────────────
  case "$next" in
    ''|*[!0-9]*) echo "ABORT: nextOffset not numeric: '$next'"; exit 1 ;;
  esac
  if [ "$next" -le "$offset" ] || [ "$next" -gt "$MAX_OFFSET" ]; then
    echo "ABORT: nextOffset=$next out of range (offset=$offset cap=$MAX_OFFSET)"
    exit 1
  fi

  # ── Human gate after chunk 1 ──────────────────────────────────────────────
  if [ "$chunk" -eq 1 ]; then
    echo
    echo ">>> Chunk 1 is your sample. Review inv/held/zeroed/noCost above."
    echo ">>> dry=$DRY. If this looks right, continue the full walk."
    printf ">>> Continue from offset=%s ? [yes/no] " "$next"
    read -r ans
    if [ "$ans" != "yes" ]; then
      echo "Stopped after chunk 1 by user. Logs: $LOGDIR"
      exit 0
    fi
  fi

  offset="$next"
  sleep "$SLEEP"
done

# ── Rollup across all saved chunks ──────────────────────────────────────────
echo "Totals:"
jq -s '{
  chunks:        length,
  processed:     (map(.processed)                     | add),
  inv_ok:        (map(.inventoryResult.success // 0)  | add),
  inv_fail:      (map(.inventoryResult.failed  // 0)  | add),
  zeroedNoMatch: (map(.zeroedNoActiveMatch     // 0)  | add),
  held:          (map(.heldExposedCount        // 0)  | add),
  noCost:        (map(.skippedNoCostCount      // 0)  | add)
}' "$LOGDIR"/chunk_*.json

echo
echo "Logs: $LOGDIR"
echo "REMINDER: accepted != applied. Live-verify a 3-4 SKU sample in Seller"
echo "Center after feed propagation — and spot-check offset 0 specifically"
echo "(it was partially written across the limit=300 timeouts)."
