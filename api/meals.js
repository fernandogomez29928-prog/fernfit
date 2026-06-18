// ============================================================
//  FERNFIT — Meals / food log endpoint
//  GET    /api/meals?date=YYYY-MM-DD  → that day's meals (newest first)
//  GET    /api/meals?recent=N         → last N meals across all days
//  POST   /api/meals { date, description, calories, protein, carbs, fat }
//         → inserts one meal, returns it
//  DELETE /api/meals?id=UUID          → removes a meal
// ============================================================
import { cors, parseBody, dbReady, dbSelect, dbInsert, dbDelete, getAuthUser } from './_db.js';

function today() {
  return new Date().toISOString().slice(0, 10);
}

const num = (v) => (v == null || v === '' ? null : Math.round(Number(v)) || 0);

export default async function handler(req, res) {
  if (cors(req, res, 'GET, POST, DELETE, OPTIONS')) return;
  if (!dbReady()) return res.status(500).json({ error: 'Supabase not configured. Add SUPABASE_URL and SUPABASE_SERVICE_KEY.' });

  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  const uid = user.id;

  try {
    if (req.method === 'GET') {
      if (req.query.recent) {
        const n = Math.min(parseInt(req.query.recent, 10) || 20, 200);
        const rows = await dbSelect('meals', {
          filters: { user_id: `eq.${uid}` },
          order: 'created_at.desc',
          limit: n,
        });
        return res.status(200).json({ meals: rows });
      }
      const date = req.query.date || today();
      const rows = await dbSelect('meals', {
        filters: { user_id: `eq.${uid}`, meal_date: `eq.${date}` },
        order: 'created_at.desc',
      });
      return res.status(200).json({ meals: rows });
    }

    if (req.method === 'POST') {
      const b = parseBody(req);
      const row = {
        user_id:     uid,
        meal_date:   b.date || today(),
        description: (b.description || '').trim() || 'Meal',
        calories:    num(b.calories),
        protein:     num(b.protein),
        carbs:       num(b.carbs),
        fat:         num(b.fat),
      };
      const saved = await dbInsert('meals', row);
      return res.status(200).json({ meal: saved });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id required' });
      await dbDelete('meals', { user_id: `eq.${uid}`, id: `eq.${id}` });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
