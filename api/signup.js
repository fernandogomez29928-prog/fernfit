// ============================================================
//  FERNFIT — Access-code-gated signup
//  POST /api/signup { email, password, code }
//  Verifies the shared access code, then creates a pre-confirmed
//  user via the Supabase Admin API (service key, server-side only).
//  The client then logs in normally with email/password.
// ============================================================
import { cors, parseBody, dbReady } from './_db.js';

const URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ACCESS_CODE = process.env.SIGNUP_ACCESS_CODE;

export default async function handler(req, res) {
  if (cors(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!dbReady()) return res.status(500).json({ error: 'Supabase not configured.' });
  if (!ACCESS_CODE) return res.status(500).json({ error: 'Signup is not configured. Add SIGNUP_ACCESS_CODE.' });

  const b = parseBody(req);
  const email = (b.email || '').trim().toLowerCase();
  const password = b.password || '';
  const code = (b.code || '').trim();

  if (code !== ACCESS_CODE) return res.status(403).json({ error: 'Invalid access code.' });
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  try {
    const r = await fetch(`${URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = j.msg || j.error_description || j.error || j.message || 'Could not create account.';
      // Surface a clean message for the common "already registered" case.
      return res.status(r.status === 422 ? 409 : 400).json({ error: msg });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
