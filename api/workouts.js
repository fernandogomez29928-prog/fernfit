// ============================================================
//  FERNFIT — Workouts / lift-logging endpoint
//  GET    /api/workouts?date=YYYY-MM-DD  → that day's workout row (or null)
//  GET    /api/workouts?recent=N         → last N workouts (newest first)
//  POST   /api/workouts { date, focus, exercises, notes }
//         → upserts one row per day, returns it
//         exercises = [{ name, sets: [{ weight, reps }] }]
//  DELETE /api/workouts?id=UUID          → removes a workout
// ============================================================
import { cors, parseBody, dbReady, dbSelect, dbUpsert, dbDelete, getAuthUser } from './_db.js';

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Normalize exercises into [{name, sets:[{weight, reps}]}] with numeric sets.
function cleanExercises(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((ex) => ({
      name: String(ex?.name || '').trim(),
      sets: Array.isArray(ex?.sets)
        ? ex.sets.map((s) => ({
            weight: s?.weight == null || s.weight === '' ? null : Number(s.weight),
            reps:   s?.reps   == null || s.reps   === '' ? null : Number(s.reps),
          }))
        : [],
    }))
    .filter((ex) => ex.name);
}

export default async function handler(req, res) {
  if (cors(req, res, 'GET, POST, DELETE, OPTIONS')) return;
  if (!dbReady()) return res.status(500).json({ error: 'Supabase not configured. Add SUPABASE_URL and SUPABASE_SERVICE_KEY.' });

  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  const uid = user.id;

  try {
    if (req.method === 'GET') {
      if (req.query.recent) {
        const n = Math.min(parseInt(req.query.recent, 10) || 30, 200);
        const rows = await dbSelect('workouts', {
          filters: { user_id: `eq.${USER_ID}` },
          order: 'workout_date.desc',
          limit: n,
        });
        return res.status(200).json({ workouts: rows });
      }
      const date = req.query.date || today();
      const rows = await dbSelect('workouts', {
        filters: { user_id: `eq.${USER_ID}`, workout_date: `eq.${date}` },
        limit: 1,
      });
      return res.status(200).json({ workout: rows[0] || null });
    }

    if (req.method === 'POST') {
      const b = parseBody(req);
      const row = {
        user_id:      USER_ID,
        workout_date: b.date || today(),
        focus:        (b.focus || '').trim() || null,
        exercises:    cleanExercises(b.exercises),
        notes:        (b.notes || '').trim() || null,
      };
      const saved = await dbUpsert('workouts', row, 'user_id,workout_date');
      return res.status(200).json({ workout: saved });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id required' });
      await dbDelete('workouts', { user_id: `eq.${USER_ID}`, id: `eq.${id}` });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
