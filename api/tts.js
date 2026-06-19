// ============================================================
//  FERNFIT — OpenAI TTS proxy
//  POST /api/tts { text: string, voice?: string }
//  Returns audio/mpeg binary stream
// ============================================================
import { cors, getAuthUser } from './_db.js';

export default async function handler(req, res) {
  if (cors(req, res, 'POST, OPTIONS')) return;

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const text = (body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (text.length > 4096) return res.status(400).json({ error: 'text too long (max 4096 chars)' });

  const voice = body?.voice || 'fable';
  const speed = Math.min(Math.max(parseFloat(body?.speed) || 1.15, 0.25), 4.0);

  try {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + OPENAI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice,
        speed,
        response_format: 'mp3',
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: err });
    }

    const arrayBuffer = await r.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(Buffer.from(arrayBuffer));
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
