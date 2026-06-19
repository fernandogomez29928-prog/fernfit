# FernFit

A personal health intelligence platform that connects live biometric data from a WHOOP wearable to an AI coaching layer.

**Live:** [fernfit.vercel.app](https://fernfit.vercel.app/health.html)

---

## What It Does

FernFit pulls real-time data from the WHOOP API and makes it actionable through an AI coach called Omni. Instead of just showing you numbers, Omni uses your actual recovery score, sleep data, supplement stack, and check-in history to give you specific, personalized guidance.

**Health Dashboard** — Live recovery score, sleep stage breakdown (REM/Deep/Light/Awake), HRV trends, and strain tracking pulled directly from the WHOOP API.

**Omni AI Coach** — Context-aware AI that knows your biometrics before it answers. Ask about today's training plan, nutrition, or why your recovery is low — it responds based on your data, not generic advice. Rate-limited to 30 messages/day by design.

**Nutrition Tracker** — Log meals by photo, text description, or barcode scan. AI estimates macros and tracks progress against your daily calorie and protein goals in real time.

**Daily Check-In** — Log weight, mood (1–5), and energy (1–5) alongside notes. Data feeds into Omni's context for more accurate coaching over time.

---

## Tech Stack

- **Frontend:** HTML, CSS, JavaScript
- **AI Layer:** Claude API (Anthropic) — streaming responses, context injection
- **Biometric Data:** WHOOP API with OAuth authentication
- **Database:** Supabase
- **Deployment:** Vercel (23 deployments, production live)
- **Backend:** Serverless API functions via Vercel

---

## Why I Built This

I wanted to understand what it actually takes to connect a live external API to an AI model and make the result genuinely useful — not a demo, but something I use every day. The hardest part wasn't the AI. It was handling OAuth, parsing WHOOP's response structure, and building context management so Omni could answer questions about *my* data rather than giving generic responses.

That problem — connecting an organization's existing data to an AI layer — is one I'm interested in solving in other contexts too.

---

## Project Structure
fernfit/

├── api/

│   ├── coach.js          # Omni AI coach — context injection + streaming

│   ├── meals.js          # Nutrition logging + macro estimation

│   ├── profile.js        # User profile + goals

│   ├── workouts.js       # Workout logging

│   ├── memory.js         # Omni context memory

│   ├── whoop-data.js     # WHOOP API data fetching

│   ├── whoop-refresh.js  # OAuth token refresh

│   ├── whoop-callback.js # OAuth callback handler

│   ├── log.js            # Daily check-in logging

│   ├── signup.js         # User auth

│   ├── config.js         # App configuration

│   └── _db.js            # Database client

├── health.html           # Main dashboard (WHOOP data + check-in)

├── supabase-schema.sql   # Database schema

├── package.json

└── vercel.json
---

## Status

Active development. Core features are live and functional. Currently working on HRV trend visualization and expanded Omni context memory.
