// ============================================================
//  FERNFIT — Daily log endpoint
//  GET  /api/log?date=YYYY-MM-DD   → that day's log (or null)
//  GET  /api/log?recent=N          → last N logs (default 7, max 180)
//  POST /api/log  { date, habits, supplements, substances, weight_kg, mood,
//                   energy, notes, recovery_score, hrv, rhr, strain,
//                   sleep_perf, calories_burned }
//       → upserts the day's log. Only the fields present in the body are
//         written, so a WHOOP-snapshot save and a check-in save can each
//         update the same day's row without clobbering the other's columns.
// ============================================================
import { cors, parseBody, dbReady, dbSelect, dbUpsert, getAuthUser } from './_db.js';

function today() {
  return new Date().toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!dbReady()) return res.status(500).json({ error: 'Supabase not configured. Add SUPABASE_URL and SUPABASE_SERVICE_KEY.' });

  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  const uid = user.id;

  try {
    if (req.method === 'GET') {
      if (req.query.recent) {
        const n = Math.min(parseInt(req.query.recent, 10) || 7, 180);
        const rows = await dbSelect('daily_logs', {
          filters: { user_id: `eq.${uid}` },
          order: 'log_date.desc',
          limit: n,
        });
        return res.status(200).json({ logs: rows });
      }
      const date = req.query.date || today();
      const rows = await dbSelect('daily_logs', {
        filters: { user_id: `eq.${uid}`, log_date: `eq.${date}` },
        limit: 1,
      });
      return res.status(200).json({ log: rows[0] || null });
    }

    if (req.method === 'POST') {
      const b = parseBody(req);
      // Only write fields that were actually sent, so partial saves (e.g. a
      // WHOOP snapshot) don't overwrite the check-in with nulls.
      const row = {
        user_id:    uid,
        log_date:   b.date || today(),
        updated_at: new Date().toISOString(),
      };
      const OPTIONAL = [
        'habits', 'supplements', 'substances', 'weight_kg', 'mood', 'energy',
        'notes', 'recovery_score', 'hrv', 'rhr', 'strain', 'sleep_perf',
        'calories_burned',
      ];
      for (const k of OPTIONAL) if (b[k] !== undefined) row[k] = b[k];
      const saved = await dbUpsert('daily_logs', row, 'user_id,log_date');
      return res.status(200).json({ log: saved });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
