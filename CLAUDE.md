# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Deployment

There is no build step. The app is deployed by pushing to `main`, which auto-deploys to Vercel.

```bash
git push origin main          # auto-deploys to production
npx vercel --prod             # manual deploy
```

To test locally with real API calls, pull env vars first:
```bash
npx vercel env pull .env.local
npx vercel dev
```

## Architecture Overview

**Single-file frontend + Vercel serverless backend.**

- `health.html` — the entire frontend (~4700+ lines). No framework, no bundler, no build. All CSS, HTML, and JS in one file. Deployed as a static asset; Vercel rewrites `/` to it via `vercel.json`.
- `api/*.js` — Vercel serverless functions (ES modules). Each file = one endpoint.
- `api/_db.js` — shared Supabase REST helper (never imported in the browser).

### Two-IIFE Script Architecture (Critical)

`health.html` has **two separate `<script>` blocks**, each wrapped in an IIFE. They do **not** share scope. Functions that must cross the boundary are bridged via `window.*`:

- Script 1 (WHOOP + animations): exposes `window.enterScreen`, calls `window.refreshCoachSuggestions`
- Script 2 (tabs, coach, food, profile): exposes `window.refreshCoachSuggestions`, `window._restartMicIfHandsFree`

When adding a function that needs to be called from the other IIFE, expose it on `window` at the end of the defining script block.

### Auth Pattern

Supabase auth JWT is stored in `_authToken` (closure variable in script 2). All API calls use `authHeaders()` which injects `Authorization: Bearer <token>`. Server-side, every endpoint calls `getAuthUser(req)` from `_db.js` to verify the JWT and get `{ id, email }`.

`SUPABASE_ANON_KEY` is served to the browser only via `/api/config` — never hardcoded in the HTML. The `SUPABASE_SERVICE_KEY` is server-side only.

### WHOOP OAuth

WHOOP tokens (`access`, `refresh`, `expires`) live in `localStorage['whoop_tokens_v1']` in the browser. The flow:
1. Browser redirects to WHOOP OAuth (`response_type=code`)
2. `/api/whoop-callback` exchanges the code for tokens server-side (needs `WHOOP_CLIENT_SECRET`)
3. Callback redirects to `health.html#whoop_access=...&whoop_refresh=...`
4. Script 1 absorbs the hash, saves to localStorage

WHOOP API calls are proxied through `/api/whoop-data` (which forwards with the user's WHOOP bearer token). `/cycle` and `/heart_rate` route to WHOOP API v1; `/activity/*`, `/recovery`, `/sleep` route to v2; `/body/*` and `/profile` route to v1.

### AI Coach (Streaming)

`api/coach.js` builds a full context payload (profile + WHOOP biometrics + today's log + meals + 14-day history + durable memories), then calls Claude. In `chat` mode with `stream: true`, it returns `text/event-stream`. The frontend reads it with `ReadableStream` + a decoder loop.

The AI embeds two hidden markers in its stream that the frontend strips out of the visible text:
- `###REMEMBER###{"fact":"..."}###REMEMBER###` — triggers saving a memory to Supabase
- `###GOALS###{"calories":N,...}###GOALS###` — triggers updating calorie/macro targets in localStorage

TTS (OpenAI) runs in parallel with streaming: each time 2 sentences accumulate, `ttsEnqueue()` fires a request to `/api/tts`. Audio plays via WebAudio `GainNode` (2.8× gain). Text appears as "subtitles" synchronized to each audio chunk's `onReveal` callback.

### Units Convention

**DB stores metric. UI displays imperial.** `api/coach.js` has `lb()`, `ftIn()`, `cToF()` helpers that convert before building the AI context. The Claude system prompt enforces American units in all responses.

## Environment Variables

| Variable | Where | Purpose |
|---|---|---|
| `SUPABASE_URL` | Server only | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Server only | Admin DB access |
| `SUPABASE_ANON_KEY` | Server only, served via `/api/config` | Client-side Supabase auth |
| `ANTHROPIC_API_KEY` | Server only | Claude API |
| `OPENAI_API_KEY` | Server only | TTS via `/api/tts` |
| `WHOOP_CLIENT_SECRET` | Server only | WHOOP OAuth token exchange |
| `WHOOP_CLIENT_ID` | Hardcoded in `health.html` | Public — safe in frontend |
| `WHOOP_REDIRECT_URI` | Server only | Must match Vercel domain exactly |
| `COACH_MODEL` | Server only | Optional Claude model override |

## Key Files

- `api/_db.js` — `getAuthUser()`, `dbSelect/Insert/Upsert/Delete()`, `cors()`, `parseBody()`
- `api/coach.js` — all AI modes (`briefing`, `chat`, `meal`, `recipe`, `workout`, `week`, `grocery`, `photo`, `food_photo`, `food_text`, `digest`, `one_liner`)
- `api/whoop-callback.js` — WHOOP OAuth code→token exchange
- `api/whoop-refresh.js` — WHOOP token refresh
- `api/tts.js` — OpenAI TTS proxy (voice: `echo`, speed: `1.1`)
- `supabase-schema.sql` — full DB schema (safe to re-run; uses `IF NOT EXISTS`)

## Supabase Tables

`profiles`, `daily_logs`, `meals`, `workouts`, `memories`, `coach_usage`

All rows are scoped by `user_id` (Supabase auth UUID). The legacy constant `USER_ID = 'fern'` in `_db.js` is kept only for migration reference — no endpoint uses it anymore.
