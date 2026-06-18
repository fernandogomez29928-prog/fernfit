// ============================================================
//  FERNFIT — Supabase REST helper (dependency-free)
//  Talks to PostgREST directly with the SERVICE ROLE key.
//  Server-side only. Never import this in the browser.
// ============================================================

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Legacy single-user id — kept only for the one-time data migration reference.
// All endpoints now scope by the authenticated user's UUID via getAuthUser().
export const USER_ID = 'fern';

export function dbReady() {
  return Boolean(URL && KEY);
}

// Verify a Supabase auth JWT (from the Authorization: Bearer header) and return
// the user { id, email } or null. Uses the Supabase Auth REST endpoint directly.
export async function getAuthUser(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!token || !URL || !ANON_KEY) return null;
  try {
    const r = await fetch(`${URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? { id: u.id, email: u.email } : null;
  } catch {
    return null;
  }
}

// Increment today's coach-usage counter for a user and report whether they are
// now over the daily cap. Best-effort: if the usage table/DB misbehaves, returns
// { over: false } so a tracking hiccup never blocks the coach.
export async function bumpUsage(uid, cap) {
  if (!uid || !dbReady()) return { over: false, count: 0 };
  const day = new Date().toISOString().slice(0, 10);
  try {
    const rows = await dbSelect('coach_usage', {
      filters: { user_id: `eq.${uid}`, day: `eq.${day}` }, limit: 1,
    });
    const count = (rows[0]?.count || 0) + 1;
    await dbUpsert('coach_usage', { user_id: uid, day, count }, 'user_id,day');
    return { over: count > cap, count };
  } catch {
    return { over: false, count: 0 };
  }
}

function headers(extra = {}) {
  return {
    apikey: KEY,
    Authorization: 'Bearer ' + KEY,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// Generic SELECT. opts: { select, filters: {col: 'eq.val'}, order, limit }
export async function dbSelect(table, opts = {}) {
  const params = new URLSearchParams();
  params.set('select', opts.select || '*');
  if (opts.filters) for (const [k, v] of Object.entries(opts.filters)) params.set(k, v);
  if (opts.order) params.set('order', opts.order);
  if (opts.limit) params.set('limit', String(opts.limit));
  const r = await fetch(`${URL}/rest/v1/${table}?${params}`, { headers: headers() });
  if (!r.ok) throw new Error(`db select ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

// INSERT one row, return the created row.
export async function dbInsert(table, row) {
  const r = await fetch(`${URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`db insert ${table}: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return Array.isArray(j) ? j[0] : j;
}

// UPSERT (insert or update on conflict). onConflict = comma-separated columns.
export async function dbUpsert(table, row, onConflict) {
  const params = new URLSearchParams();
  if (onConflict) params.set('on_conflict', onConflict);
  const r = await fetch(`${URL}/rest/v1/${table}?${params}`, {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`db upsert ${table}: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return Array.isArray(j) ? j[0] : j;
}

// DELETE rows matching filters.
export async function dbDelete(table, filters) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) params.set(k, v);
  const r = await fetch(`${URL}/rest/v1/${table}?${params}`, {
    method: 'DELETE',
    headers: headers(),
  });
  if (!r.ok) throw new Error(`db delete ${table}: ${r.status} ${await r.text()}`);
  return true;
}

// Parse a JSON body that may arrive as a string.
export function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return body || {};
}

// Standard CORS + preflight. Returns true if the request was a preflight.
export function cors(req, res, methods = 'GET, POST, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}
