// ============================================================
//  FERNFIT — Public client config
//  GET /api/config → { supabaseUrl, anonKey }
//  The anon key + project URL are SAFE to expose to the browser
//  (they only allow Auth; RLS protects table data). The service key
//  and Anthropic key are never sent here.
// ============================================================
import { cors } from './_db.js';

export default function handler(req, res) {
  if (cors(req, res, 'GET, OPTIONS')) return;
  return res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    anonKey: process.env.SUPABASE_ANON_KEY || null,
  });
}
