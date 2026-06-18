-- ============================================================
--  FERNFIT — Supabase schema
--  Run this once in the Supabase SQL editor (Dashboard → SQL → New query).
--  Multi-user (V6): every row is keyed to the user's Supabase auth UUID
--  (user_id text / profiles.id text). Pre-auth data used the literal 'fern';
--  a one-time UPDATE migrates it to the owner's UUID after signup.
--  All access goes through Vercel serverless functions using the
--  SERVICE ROLE key, which bypasses Row Level Security. RLS is left
--  ON with no policies so the public anon key can NEVER read your data.
-- ============================================================

-- ---------- profiles (one row) ----------
create table if not exists profiles (
  id             text primary key default 'fern',
  name           text,
  age            int,
  sex            text,                 -- 'male' | 'female' | other
  height_cm      numeric,
  weight_kg      numeric,
  goal_weight_kg numeric,
  primary_goal   text,                 -- 'muscle' | 'fatloss' | 'recomp' | 'performance'
  dietary_style  text,                 -- 'none' | 'vegetarian' | 'vegan' | 'keto' | 'pescatarian'
  peptides       text,                 -- free text, e.g. "BPC-157 250mcg AM"
  supplements    text,                 -- free text current stack
  injuries       text,                 -- free text limitations
  calorie_goal   int,
  protein_goal   int,
  updated_at     timestamptz default now()
);

-- ---------- daily_logs (one row per day) ----------
create table if not exists daily_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null default 'fern',
  log_date    date not null default current_date,
  habits      jsonb default '[]'::jsonb,   -- [{name, done}]
  supplements jsonb default '[]'::jsonb,   -- [{name, dose, taken}]
  weight_kg   numeric,
  mood        int,                          -- 1..5
  energy      int,                          -- 1..5
  notes       text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  unique (user_id, log_date)
);

-- ---------- daily_logs: additive columns (Phase 2 — safe to re-run) ----------
--  Recovery factors (substances) + a daily WHOOP snapshot so the coach can
--  build long-term trends and substance↔recovery correlations.
alter table daily_logs add column if not exists substances     jsonb default '[]'::jsonb;
alter table daily_logs add column if not exists recovery_score int;
alter table daily_logs add column if not exists hrv            int;
alter table daily_logs add column if not exists rhr            int;
alter table daily_logs add column if not exists strain         numeric;
alter table daily_logs add column if not exists sleep_perf     int;
alter table daily_logs add column if not exists calories_burned int;
alter table daily_logs add column if not exists steps_count   int;

-- ---------- coach_usage (per-user daily message cap — V6 multi-user) ----------
--  One row per user per day; coach.js increments count and enforces the cap so
--  no single user can run up the owner's Anthropic bill. user_id holds the
--  Supabase auth UUID once login is live.
create table if not exists coach_usage (
  user_id text not null,
  day     date not null default current_date,
  count   int  not null default 0,
  unique (user_id, day)
);

-- ---------- memories (durable facts the coach should remember forever) ----------
create table if not exists memories (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null default 'fern',
  content    text not null,
  created_at timestamptz default now()
);

-- ---------- meals ----------
create table if not exists meals (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null default 'fern',
  meal_date   date not null default current_date,
  description text,
  calories    int,
  protein     int,
  carbs       int,
  fat         int,
  created_at  timestamptz default now()
);

-- ---------- workouts ----------
create table if not exists workouts (
  id           uuid primary key default gen_random_uuid(),
  user_id      text not null default 'fern',
  workout_date date not null default current_date,
  type         text,
  notes        text,
  strain       numeric,
  created_at   timestamptz default now()
);

-- ---------- workouts: additive columns (V5 lift logging — safe to re-run) ----------
--  Per-day training log with structured sets so the coach can prescribe
--  progressive overload. exercises = [{name, sets:[{weight, reps}]}].
alter table workouts add column if not exists focus     text;
alter table workouts add column if not exists exercises jsonb default '[]'::jsonb;
-- one workout row per day so we can upsert (insert-or-update) on save
create unique index if not exists uniq_workout_day on workouts (user_id, workout_date);

-- ---------- physique_photos ----------
create table if not exists physique_photos (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null default 'fern',
  photo_date  date not null default current_date,
  storage_url text,
  pose        text,                  -- 'front' | 'back' | 'side'
  notes       text,
  ai_feedback text,
  created_at  timestamptz default now()
);

-- ---------- plans (saved meal/workout plans from the coach) ----------
create table if not exists plans (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null default 'fern',
  kind       text,                   -- 'meal' | 'workout' | 'grocery' | 'program'
  title      text,
  content    text,                   -- markdown from Claude
  created_at timestamptz default now()
);

-- ---------- indexes ----------
create index if not exists idx_daily_logs_date on daily_logs (user_id, log_date desc);
create index if not exists idx_meals_date      on meals (user_id, meal_date desc);
create index if not exists idx_workouts_date   on workouts (user_id, workout_date desc);
create index if not exists idx_photos_date     on physique_photos (user_id, photo_date desc);
create index if not exists idx_plans_kind      on plans (user_id, kind, created_at desc);
create index if not exists idx_memories_user    on memories (user_id, created_at desc);

-- ---------- lock everything down (service key bypasses RLS) ----------
alter table profiles        enable row level security;
alter table daily_logs      enable row level security;
alter table meals           enable row level security;
alter table workouts        enable row level security;
alter table physique_photos enable row level security;
alter table plans           enable row level security;
alter table memories        enable row level security;

-- ---------- seed your profile row ----------
insert into profiles (id) values ('fern')
on conflict (id) do nothing;

-- ============================================================
--  STORAGE (for physique photos — Phase 7)
--  After running this, go to Storage → Create bucket named
--  "physique" and keep it PRIVATE. The upload function uses the
--  service key, so no extra policies are required.
-- ============================================================
