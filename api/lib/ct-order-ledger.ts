// api/lib/ct-order-ledger.ts
//
// Idempotency ledger for Canada Tire order submission.
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// submitOrder() in ct-client.ts is deliberately NEVER auto-retried. A timeout
// or 5xx AFTER CT has already committed an order would, on retry, create a
// second real order against an active credit line. This ledger is what makes
// that state recoverable instead of a coin flip.
//
// It is a prerequisite for ever setting CT_DRY_RUN=false.
//
// ─── THE GUARD IS THE INSERT, NOT A LOOKUP ───────────────────────────────────
// claimOrder() does an INSERT and lets the database's unique constraint decide
// the winner. It is NOT a select-then-insert: two concurrent webhook deliveries
// for the same order would both pass a SELECT check and both submit. Under the
// INSERT, exactly one wins and the loser gets `claimed: false` — which means
// DO NOT SUBMIT, full stop.
//
// Two constraints can reject the insert, and either one means "someone already
// claimed this":
//   ct_orders_source_unique  (source_channel, source_order_id)
//   ct_orders_po_number_key  (po_number)
//
// ─── STATUS SEMANTICS ────────────────────────────────────────────────────────
//   claimed          Row inserted, submission not yet attempted.
//   submitted        CT returned success WITH an id. Terminal.
//   indeterminate    Timeout / 5xx / success-without-id. CT MAY have created
//                    the order. NEVER auto-retry. Human reconciliation only.
//   failed           Definitive rejection (CTValidationError / CTAuthError).
//                    Safe to fix and resubmit.
//   manual_required  CTInsufficientStockError, or unknown SKUs present.
//   cancelled        Manually voided.
//
// ─── NEVER STORE CREDENTIALS ─────────────────────────────────────────────────
// request_payload is passed through redactSecrets() before it is persisted.
// The CT customer token is a bearer credential; a database row is not a
// reasonable place for it, and this table has no RLS policies precisely
// because nothing but the service role should ever read it.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL     = process.env.SUPABASE_URL              ?? '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const TABLE = '/ct_orders';

// ─── Types ───────────────────────────────────────────────────────────────────

export type CTSourceChannel = 'shopify' | 'walmart' | 'manual';

export type CTOrderStatus =
  | 'claimed'
  | 'submitted'
  | 'indeterminate'
  | 'failed'
  | 'manual_required'
  | 'cancelled';

export interface CTOrderRow {
  id:                  string;
  source_channel:      CTSourceChannel;
  source_order_id:     string;
  source_order_number: string | null;
  po_number:           string;
  status:              CTOrderStatus;
  ct_internal_id:      string | null;
  ct_order_number:     string | null;
  ct_location:         string | null;
  dry_run:             boolean;
  attempt_count:       number;
  order_total:         string | null;
  sales_tax:           string | null;
  tire_tax:            string | null;
  shipping_cost:       string | null;
  request_payload:     unknown;
  response_payload:    unknown;
  error_name:          string | null;
  error_message:       string | null;
  created_at:          string;
  updated_at:          string;
  submitted_at:        string | null;
}

export class CTLedgerError extends Error {
  constructor(m: string) { super(m); this.name = 'CTLedgerError'; }
}

/** Thrown when the ledger cannot be reached. Callers must NOT submit blind. */
export class CTLedgerUnavailableError extends Error {
  constructor(m: string) { super(m); this.name = 'CTLedgerUnavailableError'; }
}

// ─── PO number construction ──────────────────────────────────────────────────
//
// CT recognises exactly one PO number shape: GCI-<year>-<seq>, e.g.
// GCI-2026-447267, GCI-2026-447269 — the same shape CT staff already use for
// manually-issued POs. That format is fixed by CT, not by us, so it is the
// only shape this codebase is allowed to emit, for any channel. Channel is
// deliberately NOT encoded in the PO number: it already lives in
// ct_orders.source_channel (the Walmart PO# rides along as ct_orders
// metadata per PR #48), and source_channel is the reconciliation join key.
//
// CANONICAL_PO_NUMBER_SHAPE is exported so ct-tracking-parser.ts — which has
// to parse this same shape back out of a CT invoice PDF — builds its regex
// from this single definition instead of an independently-typed copy that
// could quietly drift out of sync with what this function actually emits.

export const CANONICAL_PO_NUMBER_SHAPE = 'GCI-\\d{4}-\\d{4,8}';
export const CANONICAL_PO_NUMBER_PATTERN = new RegExp(`^${CANONICAL_PO_NUMBER_SHAPE}$`);

/**
 * Pure formatting for the canonical shape. Split out from buildPoNumber() so
 * the shape itself — the actual contract CT enforces — stays unit-testable
 * without a live sequence or a Supabase connection.
 */
export function formatPoNumber(seq: number, year: number = new Date().getFullYear()): string {
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new CTLedgerError(`formatPoNumber requires a positive integer sequence value, got ${seq}.`);
  }
  const po = `GCI-${year}-${seq}`;
  // Self-check: this producer must never emit something its own consumer
  // (ct-tracking-parser.ts) cannot parse back out of a CT invoice. Only ever
  // fires if a caller passes a seq outside 4-8 digits — ct_po_number_seq is
  // seeded at 447300 (6 digits) and only increments, so this is not expected
  // to trip in practice, but a silent producer/consumer mismatch here is
  // exactly the class of bug this whole PR exists to close.
  if (!CANONICAL_PO_NUMBER_PATTERN.test(po)) {
    throw new CTLedgerError(`Generated PO number '${po}' does not match the canonical CT shape.`);
  }
  return po;
}

/**
 * Atomically mint the next sequence value from the Postgres sequence
 * ct_po_number_seq (see supabase/migrations/20260729_ct_po_number_seq.sql),
 * via a PostgREST RPC call. nextval() is atomic under concurrency by
 * construction — a read-then-increment counter row could not make that
 * guarantee, which is the actual requirement: two concurrent orders must
 * never be handed the same PO number.
 */
async function nextPoSequence(): Promise<number> {
  const res = await rest('/rpc/ct_next_po_seq', {
    method:  'POST',
    headers: headers(),
    body:    '{}',
  });
  if (!res.ok) {
    throw new CTLedgerUnavailableError(
      `Supabase RPC ct_next_po_seq → ${res.status}: ${(await res.text()).slice(0, 200)}`
    );
  }
  const value = await res.json();
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CTLedgerUnavailableError(`ct_next_po_seq returned a non-numeric value: ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * Build the CT-facing PO number for a source order: GCI-<year>-<seq>, for
 * both 'shopify' and 'walmart'.
 *
 * This makes buildPoNumber() non-deterministic — calling it twice for the
 * same source order now returns two DIFFERENT PO numbers, unlike the old
 * GCI-S-/GCI-W- scheme. That is fine: the double-submission guard was never
 * determinism of the PO number, it is claimOrder()'s bare INSERT racing
 * against the ct_orders_source_unique constraint on
 * (source_channel, source_order_id). A replayed webhook still calls
 * buildPoNumber() and still burns a sequence slot, but its claimOrder()
 * INSERT is rejected by that constraint before the wasted number is ever
 * shown to CT — gaps in the sequence are expected and harmless.
 *
 * Deliberately throws for 'manual': manual PO numbers are assigned by a human
 * in this same GCI-<year>-<seq> shape, and minting a fresh one here would
 * both waste a sequence slot and risk overwriting a number already written
 * on a real PO. Pass the human-assigned number explicitly via
 * claimOrder({ poNumber }) instead.
 */
export async function buildPoNumber(channel: CTSourceChannel, sourceOrderNumber: string): Promise<string> {
  if (channel === 'manual') {
    throw new CTLedgerError(
      'buildPoNumber does not generate manual PO numbers — they are human-assigned ' +
      '(GCI-<year>-<seq>). Pass the existing number via claimOrder({ poNumber }).'
    );
  }

  const raw = (sourceOrderNumber ?? '').trim().replace(/^#+/, '').trim();
  if (!raw) {
    throw new CTLedgerError(`Cannot build a PO number for channel='${channel}': source order number is empty.`);
  }

  return formatPoNumber(await nextPoSequence());
}

// ─── Status transitions ──────────────────────────────────────────────────────

/** Statuses from which no further automated action is taken. */
export const TERMINAL_STATUSES: readonly CTOrderStatus[] = ['submitted', 'cancelled'];

/**
 * Allowed transitions. Everything not listed here is rejected.
 *
 * Note what leaves `indeterminate`: it can be resolved to submitted / failed /
 * cancelled, but ONLY by a human who has checked CT for the order. See
 * isAutoRetryable() — that is the machine-facing rule, and it says no.
 */
const ALLOWED_TRANSITIONS: Record<CTOrderStatus, readonly CTOrderStatus[]> = {
  claimed:         ['submitted', 'indeterminate', 'failed', 'manual_required', 'cancelled'],
  failed:          ['claimed', 'submitted', 'indeterminate', 'failed', 'manual_required', 'cancelled'],
  manual_required: ['claimed', 'submitted', 'indeterminate', 'failed', 'cancelled'],
  indeterminate:   ['submitted', 'failed', 'cancelled'],
  submitted:       ['cancelled'],
  cancelled:       [],
};

export function canTransition(from: CTOrderStatus, to: CTOrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(status: CTOrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * THE safety predicate. May an automated process submit this order to CT?
 *
 * `indeterminate` returns false and must stay false: CT may already hold the
 * order, and a retry would bill the credit line twice. Only a human who has
 * confirmed the order's absence at CT may move it back into play.
 */
export function isAutoRetryable(status: CTOrderStatus): boolean {
  return status === 'claimed' || status === 'failed';
}

/** Statuses a human must look at before anything else happens. */
export function requiresHumanReconciliation(status: CTOrderStatus): boolean {
  return status === 'indeterminate' || status === 'manual_required';
}

export function assertTransition(from: CTOrderStatus, to: CTOrderStatus): void {
  if (!canTransition(from, to)) {
    throw new CTLedgerError(`Illegal ct_orders status transition: '${from}' → '${to}'.`);
  }
}

// ─── Secret redaction ────────────────────────────────────────────────────────

const SECRET_KEYS = new Set([
  'customertoken', 'customersecret', 'consumersecret', 'consumerkey',
  'tokensecret', 'tokenid', 'authorization', 'apikey', 'password',
]);

const REDACTED = '***REDACTED***';

/**
 * Recursively strip credential-bearing keys. Applied to every payload before
 * it touches the database — the ledger is a reconciliation record, not a
 * credential store.
 */
export function redactSecrets<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return value; // cycle guard
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map(v => redactSecrets(v, seen)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k.toLowerCase()) ? REDACTED : redactSecrets(v, seen);
  }
  return out as unknown as T;
}

// ─── PostgREST transport ─────────────────────────────────────────────────────
// Kept local rather than added to lib/supabase.ts: that module's helpers are
// private and shaped around the single-row walmart_sync_cursor (its PATCH
// throws when zero rows match, which is wrong here).

function requireEnv(): void {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new CTLedgerUnavailableError(
      'Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. ' +
      'Refusing to proceed: without the ledger there is no double-submission guard.'
    );
  }
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey:          SERVICE_ROLE_KEY,
    Authorization:   `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type':  'application/json',
    Accept:          'application/json',
    ...extra,
  };
}

async function rest(path: string, init: RequestInit): Promise<Response> {
  requireEnv();
  try {
    return await fetch(`${SUPABASE_URL}/rest/v1${path}`, init);
  } catch (err: any) {
    throw new CTLedgerUnavailableError(`Supabase request failed (${path}): ${err?.message}`);
  }
}

async function selectRows(query: string): Promise<CTOrderRow[]> {
  const res = await rest(`${TABLE}?${query}`, { method: 'GET', headers: headers() });
  if (!res.ok) {
    throw new CTLedgerUnavailableError(`Supabase GET ${TABLE} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json() as Promise<CTOrderRow[]>;
}

async function patchRow(poNumber: string, patch: Record<string, unknown>): Promise<CTOrderRow> {
  const res = await rest(`${TABLE}?po_number=eq.${encodeURIComponent(poNumber)}`, {
    method:  'PATCH',
    headers: headers({ Prefer: 'return=representation' }),
    body:    JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new CTLedgerUnavailableError(`Supabase PATCH ${TABLE} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const rows = await res.json() as CTOrderRow[];
  if (!rows.length) {
    throw new CTLedgerError(`ct_orders row not found for po_number='${poNumber}' — nothing was updated.`);
  }
  return rows[0];
}

// ─── Claim ───────────────────────────────────────────────────────────────────

export interface ClaimOrderInput {
  channel:            CTSourceChannel;
  sourceOrderId:      string;
  sourceOrderNumber?: string;
  /** Required for channel 'manual'; otherwise derived via buildPoNumber(). */
  poNumber?:          string;
  dryRun?:            boolean;
  requestPayload?:    unknown;
}

export interface ClaimResult {
  row: CTOrderRow;
  /**
   * true  — this call created the row; the caller owns the submission.
   * false — a row already existed. DO NOT SUBMIT. Inspect row.status.
   */
  claimed: boolean;
}

/**
 * Claim the right to submit this order, exactly once.
 *
 * Implemented as a bare INSERT so the database decides the winner under
 * concurrency. A 409 from PostgREST means a unique constraint rejected us —
 * either the (channel, order id) pair or the PO number is already taken — and
 * the existing row is returned with claimed=false.
 *
 * Callers MUST check `claimed` before calling submitOrder(). A false here is
 * the difference between one order and two.
 */
export async function claimOrder(input: ClaimOrderInput): Promise<ClaimResult> {
  const { channel, sourceOrderId } = input;

  if (!sourceOrderId?.trim()) {
    throw new CTLedgerError('claimOrder requires a sourceOrderId.');
  }

  const poNumber = input.poNumber?.trim()
    || await buildPoNumber(channel, input.sourceOrderNumber ?? '');

  const insert = {
    source_channel:      channel,
    source_order_id:     sourceOrderId.trim(),
    source_order_number: input.sourceOrderNumber ?? null,
    po_number:           poNumber,
    status:              'claimed' as const,
    dry_run:             input.dryRun ?? true,
    attempt_count:       0,
    request_payload:     input.requestPayload === undefined ? null : redactSecrets(input.requestPayload),
  };

  const res = await rest(TABLE, {
    method:  'POST',
    headers: headers({ Prefer: 'return=representation' }),
    body:    JSON.stringify(insert),
  });

  if (res.status === 201 || res.status === 200) {
    const rows = await res.json() as CTOrderRow[];
    if (!rows.length) {
      throw new CTLedgerUnavailableError('Supabase INSERT returned no row — cannot confirm the claim, refusing to submit.');
    }
    return { row: rows[0], claimed: true };
  }

  // 409 = unique violation. Someone already claimed this order.
  if (res.status === 409) {
    const existing = await findExisting(channel, sourceOrderId, poNumber);
    if (!existing) {
      // Constraint fired but no row is visible — do not guess; refuse.
      throw new CTLedgerUnavailableError(
        `ct_orders rejected the insert for po_number='${poNumber}' as a duplicate, but no existing row ` +
        `could be read back. Refusing to submit while the ledger state is unknown.`
      );
    }
    return { row: existing, claimed: false };
  }

  throw new CTLedgerUnavailableError(
    `Supabase POST ${TABLE} → ${res.status}: ${(await res.text()).slice(0, 200)}`
  );
}

async function findExisting(
  channel: CTSourceChannel,
  sourceOrderId: string,
  poNumber: string,
): Promise<CTOrderRow | null> {
  const bySource = await getBySourceOrder(channel, sourceOrderId);
  if (bySource) return bySource;
  const byPo = await selectRows(`po_number=eq.${encodeURIComponent(poNumber)}&select=*&limit=1`);
  return byPo[0] ?? null;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function getBySourceOrder(
  channel: CTSourceChannel,
  sourceOrderId: string,
): Promise<CTOrderRow | null> {
  const rows = await selectRows(
    `source_channel=eq.${encodeURIComponent(channel)}` +
    `&source_order_id=eq.${encodeURIComponent(sourceOrderId)}` +
    `&select=*&limit=1`
  );
  return rows[0] ?? null;
}

export async function getByPoNumber(poNumber: string): Promise<CTOrderRow | null> {
  const rows = await selectRows(`po_number=eq.${encodeURIComponent(poNumber)}&select=*&limit=1`);
  return rows[0] ?? null;
}

/** Everything a human still needs to deal with. */
export async function listNeedingReconciliation(): Promise<CTOrderRow[]> {
  return selectRows('status=in.(indeterminate,manual_required)&select=*&order=created_at.desc');
}

// ─── Transitions ─────────────────────────────────────────────────────────────
//
// Each mark* helper re-reads the row to validate the transition and to carry
// attempt_count forward. The read-modify-write on attempt_count is not atomic;
// that is acceptable here because claimOrder() guarantees a single owner per
// row, so there is no second writer to race with.

async function transition(
  poNumber: string,
  to: CTOrderStatus,
  patch: Record<string, unknown>,
  countsAsAttempt: boolean,
): Promise<CTOrderRow> {
  const current = await getByPoNumber(poNumber);
  if (!current) {
    throw new CTLedgerError(`ct_orders row not found for po_number='${poNumber}'.`);
  }
  assertTransition(current.status, to);

  return patchRow(poNumber, {
    ...patch,
    status: to,
    ...(countsAsAttempt ? { attempt_count: current.attempt_count + 1 } : {}),
  });
}

export interface SubmittedFacts {
  ctInternalId:   string;
  ctOrderNumber:  string;
  ctLocation?:    string;
  dryRun:         boolean;
  orderTotal?:    string | number | null;
  salesTax?:      string | number | null;
  tireTax?:       string | number | null;
  shippingCost?:  string | number | null;
  responsePayload?: unknown;
}

/** CT returned success WITH an id. Terminal. */
export async function markSubmitted(poNumber: string, facts: SubmittedFacts): Promise<CTOrderRow> {
  if (!facts.ctInternalId?.trim()) {
    throw new CTLedgerError(
      'markSubmitted requires ctInternalId. A success response without an id is INDETERMINATE — use markIndeterminate().'
    );
  }
  return transition(poNumber, 'submitted', {
    ct_internal_id:   facts.ctInternalId,
    ct_order_number:  facts.ctOrderNumber,
    ct_location:      facts.ctLocation ?? null,
    dry_run:          facts.dryRun,
    order_total:      facts.orderTotal   ?? null,
    sales_tax:        facts.salesTax     ?? null,
    tire_tax:         facts.tireTax      ?? null,
    shipping_cost:    facts.shippingCost ?? null,
    response_payload: facts.responsePayload === undefined ? null : redactSecrets(facts.responsePayload),
    error_name:       null,
    error_message:    null,
    submitted_at:     new Date().toISOString(),
  }, true);
}

/**
 * Timeout, 5xx, or success-without-id. CT MAY hold the order.
 *
 * NEVER auto-retry from here. A human must check CT for the PO number before
 * this row moves anywhere.
 */
export async function markIndeterminate(
  poNumber: string,
  err: { name?: string; message?: string },
  responsePayload?: unknown,
): Promise<CTOrderRow> {
  return transition(poNumber, 'indeterminate', {
    error_name:       err?.name ?? 'Unknown',
    error_message:    err?.message ?? '(no message)',
    response_payload: responsePayload === undefined ? null : redactSecrets(responsePayload),
  }, true);
}

/** Definitive rejection (CTValidationError / CTAuthError). Safe to fix and resubmit. */
export async function markFailed(
  poNumber: string,
  err: { name?: string; message?: string },
  responsePayload?: unknown,
): Promise<CTOrderRow> {
  return transition(poNumber, 'failed', {
    error_name:       err?.name ?? 'Unknown',
    error_message:    err?.message ?? '(no message)',
    response_payload: responsePayload === undefined ? null : redactSecrets(responsePayload),
  }, true);
}

/** CTInsufficientStockError, or unknown SKUs present. Nothing was sent to CT. */
export async function markManualRequired(
  poNumber: string,
  reason: { name?: string; message?: string; detail?: string },
): Promise<CTOrderRow> {
  const message = [reason?.message, reason?.detail].filter(Boolean).join(' — ') || '(no message)';
  return transition(poNumber, 'manual_required', {
    error_name:    reason?.name ?? 'CTInsufficientStockError',
    error_message: message,
  }, false);
}

/** Manually voided. */
export async function markCancelled(poNumber: string, note?: string): Promise<CTOrderRow> {
  return transition(poNumber, 'cancelled', {
    error_name:    'Cancelled',
    error_message: note ?? 'Manually voided.',
  }, false);
}
