// ============================================================
//  FERNFIT — Coach memory endpoint (durable facts, kept forever)
//  GET    /api/memory            → all pinned memories (newest first)
//  POST   /api/memory { content } → pin a new fact
//  DELETE /api/memory?id=UUID     → forget a fact
// ============================================================
import { cors, parseBody, dbReady, dbSelect, dbInsert, dbDelete, getAuthUser } from './_db.js';

export default async function handler(req, res) {
  if (cors(req, res, 'GET, POST, DELETE, OPTIONS')) return;
  if (!dbReady()) return res.status(500).json({ error: 'Supabase not configured. Add SUPABASE_URL and SUPABASE_SERVICE_KEY.' });

  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  const uid = user.id;

  try {
    if (req.method === 'GET') {
      const rows = await dbSelect('memories', {
        filters: { user_id: `eq.${uid}` },
        order: 'created_at.desc',
        limit: 100,
      });
      return res.status(200).json({ memories: rows });
    }

    if (req.method === 'POST') {
      const b = parseBody(req);
      const content = (b.content || '').trim();
      if (!content) return res.status(400).json({ error: 'content required' });
      const saved = await dbInsert('memories', { user_id: uid, content: content.slice(0, 500) });
      return res.status(200).json({ memory: saved });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id required' });
      await dbDelete('memories', { user_id: `eq.${uid}`, id: `eq.${id}` });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
