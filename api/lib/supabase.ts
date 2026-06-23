// api/lib/supabase.ts
// ─────────────────────────────────────────────────────────────
// Minimal Supabase REST client (PostgREST) for the walmart_sync_cursor table.
// Uses the service-role key directly — server-side only, bypasses RLS.
//
// Required env vars:
//   SUPABASE_URL              — e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — service-role JWT (not the anon key)
// ─────────────────────────────────────────────────────────────

const SUPABASE_URL        = process.env.SUPABASE_URL             ?? '';
const SERVICE_ROLE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

function requireEnv(): void {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error(
      'Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    );
  }
}

async function restGet<T>(path: string): Promise<T> {
  requireEnv();
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      'apikey':        SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'Accept':        'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase GET ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function restPatch(path: string, body: Record<string, unknown>): Promise<void> {
  requireEnv();
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method:  'PATCH',
    headers: {
      'apikey':        SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Supabase PATCH ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

// ── Cursor row type ─────────────────────────────────────────────────────────

export interface SyncCursorRow {
  id:                   number;
  current_offset:       number;
  total_listed:         number | null;
  attempt_count:        number;
  last_run_at:          string | null;
  last_status:          string | null;  // 'ok' | 'wrapped' | 'error' | 'skipped'
  last_inv_ok:          number | null;
  last_inv_fail:        number | null;
  last_zeroed:          number | null;
  consecutive_failures: number;
  updated_at:           string | null;
}

export async function readCursor(): Promise<SyncCursorRow> {
  const rows = await restGet<SyncCursorRow[]>('/walmart_sync_cursor?id=eq.1&select=*');
  if (rows.length === 0) {
    throw new Error('walmart_sync_cursor row id=1 not found — run the migration and seed first');
  }
  return rows[0];
}

export async function updateCursor(patch: Partial<Omit<SyncCursorRow, 'id'>>): Promise<void> {
  await restPatch('/walmart_sync_cursor?id=eq.1', {
    ...patch,
    updated_at: new Date().toISOString(),
  });
}
