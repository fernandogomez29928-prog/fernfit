// ============================================================
//  FERNFIT — Profile endpoint
//  GET  /api/profile  → the single profile row
//  POST /api/profile  { ...fields } → upserts the profile
// ============================================================
import { cors, parseBody, dbReady, dbSelect, dbUpsert, getAuthUser } from './_db.js';

const FIELDS = [
  'name', 'age', 'sex', 'height_cm', 'weight_kg', 'goal_weight_kg',
  'primary_goal', 'dietary_style', 'peptides', 'supplements',
  'injuries', 'calorie_goal', 'protein_goal', 'coach_style',
];

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!dbReady()) return res.status(500).json({ error: 'Supabase not configured. Add SUPABASE_URL and SUPABASE_SERVICE_KEY.' });

  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  const uid = user.id;

  try {
    if (req.method === 'GET') {
      const rows = await dbSelect('profiles', { filters: { id: `eq.${uid}` }, limit: 1 });
      return res.status(200).json({ profile: rows[0] || null });
    }

    if (req.method === 'POST') {
      const b = parseBody(req);
      const row = { id: uid, updated_at: new Date().toISOString() };
      for (const f of FIELDS) if (b[f] !== undefined) row[f] = b[f] === '' ? null : b[f];
      const saved = await dbUpsert('profiles', row, 'id');
      return res.status(200).json({ profile: saved });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
