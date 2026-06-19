// ============================================================
//  FERNFIT — AI Coach endpoint (Claude)
//  POST /api/coach
//  {
//    mode: 'briefing' | 'chat' | 'meal' | 'recipe' | 'workout' | 'week'
//        | 'grocery' | 'photo' | 'food_photo' | 'food_text' | 'digest',
//    message?: string,            // chat text, or food description
//    image?:   string,            // base64 data URL (food_photo)
//    whoop?: { recovery, hrv, rhr, strain, sleepPerf, sleepDuration, ... },
//    body?: { recent: [{pose, notes, storage_url}] },  // physique photo
//    history?: [{role, content}], // prior chat turns (chat mode)
//    save?: boolean               // persist meal/workout/grocery/recipe to plans
//  }
//  → { reply: "<markdown or json>" }
//
//  Pulls profile + today's log + meals + recent history + durable memories
//  from Supabase so Claude has full long-term context. WHOOP data is passed
//  from the client because the WHOOP tokens live in the browser.
//  All units presented to Claude (and required back) are AMERICAN.
// ============================================================
import { cors, parseBody, dbReady, dbSelect, dbInsert, getAuthUser, bumpUsage } from './_db.js';

const MODEL = process.env.COACH_MODEL || 'claude-sonnet-4-6';
const API_KEY = process.env.ANTHROPIC_API_KEY;

/* ── unit helpers (DB is metric; coach speaks imperial) ── */
const KG_TO_LB = 2.20462;
const lb = (kg) => (kg == null ? null : Math.round(kg * KG_TO_LB));
function ftIn(cm) {
  if (cm == null) return null;
  const total = cm / 2.54;
  const ft = Math.floor(total / 12);
  const inch = Math.round(total - ft * 12);
  return `${ft}'${inch}"`;
}
const cToF = (c) => (c == null ? null : Math.round((c * 9 / 5 + 32) * 10) / 10);

const BASE_SYSTEM = `You are FERNFIT — Fernando's personal AI fitness, nutrition and recovery coach.
You have his live WHOOP biometrics, his profile and goals, his logged food, his daily check-ins,
a long-term history summary, and a list of durable MEMORIES about him.

Tone: talk to him like a real person, not a bot. Be direct, casual, and real — like a coach
who actually knows him. Drop the corporate "Great question!" opener. No filler. No fluffy sign-offs.
Cut straight to the point. Use contractions. Match his energy — if he's casual, be casual.
Study how he talks in the chat history — his slang, phrasing, punctuation — and mirror it back so
you sound like him, not like a textbook. He's building a physique and performing at a high level —
treat him like someone who can handle straight talk.

Memory: you keep his whole history. Reference past trends, streaks, and pinned memories when they're
relevant so it's obvious you remember his journey. Don't dump everything — surface what matters now.

Units: ALWAYS American. Pounds (lbs), feet/inches, °F. Say "calories", never "kcal" or "kilojoules".

Use his actual numbers. Never invent data you weren't given. If something is missing, say so in
one word and move on. Bold the key numbers. Keep it scannable.
When recovered: push him. When run down: protect him. Always tie it back to his goal.

METRICS DISCIPLINE: Use recovery % as the headline signal — it's the only number you need to mention daily.
Do NOT recite HRV, resting heart rate, or strain in every reply. Bring them up only when:
(a) something is notably off-trend (e.g. HRV crashed 20+ ms), or
(b) Fernando asks directly, or
(c) you haven't mentioned them in 7+ messages.
In casual chat, just say "your recovery is [green/solid/low]" and move on.`;

const COACH_PERSONALITIES = {
  hype: `

COACH PERSONALITY — HYPE MODE:
You are his hype man. Match his gym energy × 2. Use exclamation points freely. Celebrate every win — "LET'S GO!", "That's elite!", "We're eating today!" Short punchy sentences. Never sound tired. Make him feel like a beast even on low-recovery days.`,

  drill: `

COACH PERSONALITY — DRILL SERGEANT:
Clipped. Direct. Commands only. No encouragement fluff. "You ate 80g protein — that's not enough. Fix it." No exclamation points unless earned. Military cadence. Every response ends with one clear order. Respect him enough not to sugarcoat anything. Never say "great job" for average effort.`,

  science: `

COACH PERSONALITY — THE ANALYST:
Data-first. Always explain the mechanism behind your advice — not just what to do, but why the physiology works that way. Cite specific numbers, % improvements, timeframes. Reference adaptations, hormonal responses, metabolic processes. The user is smart; treat him like it. Keep it readable but never dumb it down.`,

  chill: `

COACH PERSONALITY — CHILL TRAINER:
You're the coach who's also a friend. Zero pressure in your tone. "Yeah man", "honestly", "up to you but—" are natural. Never bark. If he's not hitting his goals, ask what's going on before pushing. Casual, warm, real. Like texting a friend who happens to know everything about fitness.`,
};

/* ── adaptive tone based on how the user writes ── */
function getAdaptiveTone(message) {
  if (!message) return '';
  const m = message.toLowerCase();
  const words = message.trim().split(/\s+/).length;
  const hints = [];
  if (/fuck|damn|ugh|wtf|pissed|frustrated|not working|doesn't work|nothing works/.test(m))
    hints.push('User seems frustrated — cut to the fix, no preamble.');
  else if (/let'?s go|yoo+|!{2,}|fire\b|sick bro|hyped/.test(m))
    hints.push('User is pumped — match the energy, keep it moving.');
  if (words <= 5)
    hints.push('Short message — keep reply short (2-3 sentences max unless detail was asked).');
  return hints.length ? '\n\n[TONE: ' + hints.join(' ') + ']' : '';
}

/* ── lightweight context routing — flags the topic so Claude focuses ── */
function getChatContextHint(message) {
  if (!message) return '';
  const m = message.toLowerCase();
  if (/\b(eat|meal|food|diet|recipe|calorie|protein|carb|macro)\b/.test(m))
    return '\n(Nutrition context — focus on food, macros, and meal choices.)';
  if (/\b(workout|lift|exercise|train|sets?|reps?|split|program|gym)\b/.test(m))
    return '\n(Training context — focus on session design, progressive overload, his program.)';
  if (/\b(recover|sleep|hrv|sore|tired|rest|hurt|pain|injury|peptide)\b/.test(m))
    return '\n(Recovery context — focus on rest, rehab, peptides, protecting his numbers.)';
  if (/\b(supplement|creatine|omega|vitamin|dose|timing|stack)\b/.test(m))
    return '\n(Supplement context — dosing, timing, interactions with his goal.)';
  return '';
}

const SUPP_INFO = {
  'creatine':     'improves power output and muscle ATP resynthesis; takes ~4 wks to saturate',
  'vitamin d':    'supports testosterone, bone density, immune function; best taken with fat',
  'omega-3':      'reduces inflammation, supports joint recovery and mood',
  'magnesium':    'improves sleep quality and reduces muscle cramps; take at night',
  'zinc':         'supports testosterone production and immune function',
  'ashwagandha':  'lowers cortisol; may improve HRV and sleep quality over 8+ weeks',
  'bpc-157':      'peptide — accelerates tendon/ligament healing and gut repair',
  'tb-500':       'peptide — systemic recovery, tissue repair, and flexibility',
  'melatonin':    'sleep onset aid; keep dose low (0.5–1mg) to avoid grogginess',
  'citrulline':   'pre-workout pump and endurance via nitric oxide; 6–8g effective dose',
  'beta-alanine': 'buffers muscle acidity for high-rep work; tingling is normal',
  'caffeine':     'alertness and performance; avoid within 6h of sleep',
};

function suppInfo(name) {
  if (!name) return null;
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(SUPP_INFO)) {
    if (key.includes(k)) return v;
  }
  return null;
}

// Given an active program [{day, focus, exercises}], return today's entry.
const DAY_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function programToday(program) {
  if (!Array.isArray(program) || !program.length) return null;
  const key = DAY_KEYS[new Date().getDay()];
  return program.find((d) => (d.day || '').slice(0, 3).toLowerCase() === key.toLowerCase()) || null;
}

// Build a per-exercise "last session" map from recent workout rows (newest first).
// Returns { 'bench press': '185×8, 185×8, 175×10 (Jun 12)', ... }
function lastLiftsByExercise(workouts) {
  const map = {};
  if (!Array.isArray(workouts)) return map;
  for (const w of workouts) { // newest first — first hit wins
    if (!Array.isArray(w.exercises)) continue;
    for (const ex of w.exercises) {
      const name = (ex?.name || '').trim();
      if (!name || map[name]) continue;
      const sets = Array.isArray(ex.sets) ? ex.sets.filter((s) => s && (s.weight != null || s.reps != null)) : [];
      if (!sets.length) continue;
      const setStr = sets.map((s) => `${s.weight ?? '?'}×${s.reps ?? '?'}`).join(', ');
      map[name] = `${setStr}${w.workout_date ? ` (${w.workout_date})` : ''}`;
    }
  }
  return map;
}

function fmtSubstances(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const parts = arr
    .filter((s) => s && s.amount && String(s.amount) !== '0' && s.amount !== 'none')
    .map((s) => `${s.type}: ${s.amount}`);
  return parts.length ? parts.join(', ') : null;
}

function fmt({ profile, log, whoop, recent, body, meals, memories, program, workouts }) {
  const lines = [];
  lines.push('## ATHLETE PROFILE');
  if (profile) {
    const p = profile;
    if (p.name) lines.push(`Name: ${p.name}`);
    if (p.age) lines.push(`Age: ${p.age}`);
    if (p.sex) lines.push(`Sex: ${p.sex}`);
    if (p.height_cm) lines.push(`Height: ${ftIn(p.height_cm)}`);
    if (p.weight_kg) lines.push(`Current weight: ${lb(p.weight_kg)} lbs`);
    if (p.goal_weight_kg) lines.push(`Goal weight: ${lb(p.goal_weight_kg)} lbs`);
    if (p.primary_goal) lines.push(`Primary goal: ${p.primary_goal}`);
    if (p.dietary_style) lines.push(`Dietary style: ${p.dietary_style}`);
    if (p.calorie_goal) lines.push(`Calorie goal: ${p.calorie_goal} calories/day`);
    if (p.protein_goal) lines.push(`Protein goal: ${p.protein_goal} g/day`);
    if (p.supplements) lines.push(`Supplement stack: ${p.supplements}`);
    if (p.peptides) lines.push(`Peptides: ${p.peptides}`);
    if (p.injuries) lines.push(`Injuries/limitations: ${p.injuries}`);
  } else {
    lines.push('(No profile set yet — encourage him to fill out the Profile tab.)');
  }

  lines.push("\n## TODAY'S WHOOP");
  if (whoop && Object.keys(whoop).length) {
    if (whoop.recovery != null)  lines.push(`Recovery: ${whoop.recovery}%`);
    if (whoop.hrv != null)       lines.push(`HRV: ${whoop.hrv} ms`);
    if (whoop.rhr != null)       lines.push(`Resting HR: ${whoop.rhr} bpm`);
    if (whoop.strain != null)    lines.push(`Strain: ${whoop.strain}`);
    if (whoop.sleepPerf != null) lines.push(`Sleep performance: ${whoop.sleepPerf}%`);
    if (whoop.sleepDuration)     lines.push(`Sleep duration: ${whoop.sleepDuration}`);
    if (whoop.calories != null)  lines.push(`Calories burned: ${whoop.calories} calories`);
    if (whoop.steps != null)     lines.push(`Steps: ${whoop.steps.toLocaleString()}`);
    if (whoop.avgHr != null)     lines.push(`Average HR: ${whoop.avgHr} bpm`);
    if (whoop.maxHr != null)     lines.push(`Max HR: ${whoop.maxHr} bpm`);
    if (whoop.spo2 != null)      lines.push(`Blood O₂: ${whoop.spo2}%`);
    if (whoop.skinTemp != null)  lines.push(`Skin temp: ${cToF(whoop.skinTemp)}°F`);
  } else {
    lines.push('(No WHOOP data passed — he may not be connected today.)');
  }

  // Today's food / nutrition
  lines.push("\n## TODAY'S NUTRITION (logged food)");
  if (Array.isArray(meals) && meals.length) {
    const t = meals.reduce((a, m) => ({
      cal: a.cal + (m.calories || 0), p: a.p + (m.protein || 0),
      c: a.c + (m.carbs || 0), f: a.f + (m.fat || 0),
    }), { cal: 0, p: 0, c: 0, f: 0 });
    const calGoal = profile?.calorie_goal;
    const protGoal = profile?.protein_goal;
    lines.push(`Consumed: ${t.cal} calories · ${t.p}g protein · ${t.c}g carbs · ${t.f}g fat`);
    if (calGoal) lines.push(`Calories left to goal: ${Math.max(0, calGoal - t.cal)} of ${calGoal}`);
    if (protGoal) lines.push(`Protein left to goal: ${Math.max(0, protGoal - t.p)}g of ${protGoal}g`);
    lines.push('Meals: ' + meals.slice(0, 8).map((m) => `${m.description} (${m.calories || 0}cal/${m.protein || 0}p)`).join('; '));
  } else {
    lines.push('(Nothing logged yet today.)');
  }

  lines.push("\n## TODAY'S CHECK-IN");
  if (log) {
    if (log.weight_kg != null) lines.push(`Logged weight: ${lb(log.weight_kg)} lbs`);
    if (log.mood != null)      lines.push(`Mood: ${log.mood}/5`);
    if (log.energy != null)    lines.push(`Energy: ${log.energy}/5`);
    if (Array.isArray(log.habits) && log.habits.length) {
      const done = log.habits.filter((h) => h.done).length;
      lines.push(`Habits: ${done}/${log.habits.length} done — ${log.habits.map((h) => `${h.name}${h.done ? ' ✓' : ''}`).join(', ')}`);
    }
    if (Array.isArray(log.supplements) && log.supplements.length) {
      const suppLines = log.supplements.map((s) => {
        let str = `${s.name}${s.dose ? ` ${s.dose}` : ''}${s.taken ? ' ✓' : ''}`;
        const info = suppInfo(s.name);
        if (info) str += ` (${info})`;
        return str;
      });
      lines.push(`Supplements: ${suppLines.join('; ')}`);
    }
    const subs = fmtSubstances(log.substances);
    if (subs) lines.push(`Recovery factors today: ${subs}`);
    if (log.notes) lines.push(`Notes: ${log.notes}`);
  } else {
    lines.push('(No check-in logged today yet.)');
  }

  // Active training program + today's focus
  lines.push('\n## TRAINING PROGRAM');
  const todayPlan = programToday(program);
  if (Array.isArray(program) && program.length) {
    if (todayPlan) {
      const f = todayPlan.focus || '—';
      const ex = todayPlan.exercises ? ` — ${todayPlan.exercises}` : '';
      lines.push(`Today (${todayPlan.day}) on his program: ${f}${ex}`);
    }
    lines.push('Week: ' + program.map((d) => `${d.day}: ${d.focus || 'rest'}`).join(' | '));
  } else {
    lines.push('(No active program saved — he can generate a weekly split in the Coach tab.)');
  }

  // Recent training / last lifts (for progressive overload)
  const lifts = lastLiftsByExercise(workouts);
  const liftNames = Object.keys(lifts);
  if (liftNames.length) {
    lines.push('\n## RECENT TRAINING (last logged set per lift — use for progressive overload)');
    for (const name of liftNames.slice(0, 20)) lines.push(`- ${name}: ${lifts[name]}`);
  }

  // Detailed last 14 days
  if (Array.isArray(recent) && recent.length > 1) {
    lines.push('\n## RECENT (last 14 days)');
    for (const r of recent.slice(0, 14)) {
      const bits = [r.log_date];
      if (r.recovery_score != null) bits.push(`rec ${r.recovery_score}%`);
      if (r.weight_kg != null) bits.push(`${lb(r.weight_kg)}lbs`);
      if (r.energy != null) bits.push(`energy ${r.energy}/5`);
      const subs = fmtSubstances(r.substances);
      if (subs) bits.push(`[${subs}]`);
      lines.push('- ' + bits.join(' · '));
    }
  }

  // All-time summary
  if (Array.isArray(recent) && recent.length >= 5) {
    lines.push('\n## LONG-TERM SUMMARY (so you remember his journey)');
    const withRec = recent.filter((r) => r.recovery_score != null);
    if (withRec.length) {
      const avg = Math.round(withRec.reduce((a, r) => a + r.recovery_score, 0) / withRec.length);
      lines.push(`Avg recovery over ${withRec.length} tracked days: ${avg}%`);
    }
    const withWt = recent.filter((r) => r.weight_kg != null);
    if (withWt.length >= 2) {
      const newest = lb(withWt[0].weight_kg);
      const oldest = lb(withWt[withWt.length - 1].weight_kg);
      const delta = newest - oldest;
      lines.push(`Weight: ${oldest} → ${newest} lbs (${delta >= 0 ? '+' : ''}${delta} lbs over ${withWt.length} weigh-ins)`);
    }
    lines.push(`Days logged total (recent window): ${recent.length}`);
    // substance frequency last 30
    const last30 = recent.slice(0, 30);
    const freq = {};
    for (const r of last30) {
      const s = fmtSubstances(r.substances);
      if (s) for (const part of s.split(', ')) { const t = part.split(':')[0]; freq[t] = (freq[t] || 0) + 1; }
    }
    const freqStr = Object.entries(freq).map(([k, v]) => `${k} ${v}d`).join(', ');
    if (freqStr) lines.push(`Recovery-factor frequency (last 30d): ${freqStr}`);

    // Supplement adherence from recent logs
    const suppAdherence = {};
    for (const r of recent) {
      if (!Array.isArray(r.supplements)) continue;
      for (const s of r.supplements) {
        if (!s.name) continue;
        const k = s.name;
        if (!suppAdherence[k]) suppAdherence[k] = { taken: 0, total: 0 };
        suppAdherence[k].total++;
        if (s.taken) suppAdherence[k].taken++;
      }
    }
    const adherenceLines = Object.entries(suppAdherence)
      .filter(([, v]) => v.total >= 3)
      .map(([k, v]) => `${k}: ${v.taken}/${v.total} days`);
    if (adherenceLines.length) lines.push(`Supplement adherence (logged window): ${adherenceLines.join(', ')}`);
  }

  // Durable memories
  if (Array.isArray(memories) && memories.length) {
    lines.push('\n## MEMORIES (durable facts about Fernando)');
    for (const m of memories.slice(0, 40)) lines.push(`- ${m.content}`);
  }

  lines.push('\n## BODY / PHOTO CONTEXT');
  if (Array.isArray(body?.recent) && body.recent.length) {
    for (const item of body.recent.slice(0, 3)) {
      const bits = [];
      if (item.pose) bits.push(`pose: ${item.pose}`);
      if (item.notes) bits.push(`notes: ${item.notes}`);
      lines.push(`- ${bits.join(' · ') || 'body snapshot logged'}`);
    }
  } else {
    lines.push('(No physique photo notes logged yet.)');
  }

  return lines.join('\n');
}

const MODE_INSTRUCTIONS = {
  briefing: `Give Fernando his DAILY BRIEFING. Format it EXACTLY like this — no prose paragraphs:

**Recovery X%** · HRV Xms · RHR Xbpm · Sleep X% · Strain X

**Fuel: ~X calories · Xg protein**
- Burned X calories (WHOOP) + [surplus or deficit] for [goal] = X daily target
- Protein: Xlbs × 1g = Xg — spread over 4+ meals
- [if food logged today: where he stands vs target. else: 1 specific high-protein meal idea]

**Train:** [one line verdict: push/moderate/recover + today's muscle group or focus]
- [specific workout type or exercise focus]
- [intensity cue tied to his recovery number]

**Watch:**
- [max 2 bullets: sleep, supplement timing, or a recovery-factor note if he logged alcohol/etc]

Bedtime tonight: ~[HH:MM AM/PM] (need Xh Xm)

Rules: Under 220 words. Use his actual numbers everywhere — never generic. American units. No filler opener. No sign-off.
If calories burned is missing, estimate from weight + light/moderate/hard activity based on strain score.`,

  meal: `Build Fernando a 1-day meal plan that hits his calorie and protein goals and fits his dietary style.
Format:
**Breakfast:** [foods] — X cal / Xg protein
**Lunch:** [foods] — X cal / Xg protein
**Dinner:** [foods] — X cal / Xg protein
**Snack:** [foods] — X cal / Xg protein
**Daily total:** X cal · Xg protein · Xg carbs · Xg fat

End with one line: how this supports his specific goal.
If calorie/protein goals are missing, calculate from his weight (≈1g protein per lb) and state what you assumed. American units only.`,

  recipe: `Create 2-3 practical recipes that match Fernando's goals, dietary style, and supplement/peptide stack.
For each recipe:
**[Recipe name]** — X cal / Xg protein per serving
Ingredients: [bullet list with American measures: cups, oz, tbsp]
Steps: [numbered, brief]
Why it helps: [one line tying to his goal]
Flag anything to meal prep in advance.`,

  workout: `Design Fernando's training for today. Match volume and intensity to his WHOOP recovery and strain.
Account for any injuries. Factor in peptides that accelerate recovery if listed.

IMPORTANT — build around his program and his actual numbers:
- If the TRAINING PROGRAM section gives today's focus, build the session around THAT focus (don't pick a different body part). If today is a REST day on his program, say so and give recovery work instead.
- If the RECENT TRAINING section shows last-logged numbers for an exercise you're programming, PRESCRIBE THE NEXT PROGRESSION and cite the prior set — e.g. "Bench: you hit 185×8 last time, go 190×6–8". Small jumps: ~5 lbs upper body / ~10 lbs lower, or +1–2 reps before adding load. If recovery is low, hold weight and focus on clean reps instead of pushing.

Format:
**Today: [muscle group/focus]** — [intensity: light/moderate/heavy]
- [Exercise 1]: X sets × X reps @ [target weight] — [progression note vs last time if known]
- [Exercise 2]: ...
- [Exercise 3-5]: ...
**Cardio:** [yes/no + type if yes]
**Rationale:** One sentence tying the intensity choice to his recovery score.`,

  week: `Design Fernando's 7-day training split for this week. Match volume to his recovery trend and account for injuries.
Output each day on its own line in EXACTLY this format:
MON: [Focus] | [Exercise 1, Sets×Reps], [Exercise 2, Sets×Reps], [Exercise 3-4, Sets×Reps]
TUE: [Focus] | [Exercise 1], [Exercise 2], [Exercise 3]
WED: REST | Recovery day — mobility, walk, or light cardio
THU: [Focus] | [exercises]
FRI: [Focus] | [exercises]
SAT: [Focus] | [exercises]
SUN: REST | Recovery

After the 7 lines, add one sentence about the overall weekly approach and key focus area.
Keep exercise descriptions tight: no paragraphs.`,

  grocery: `From the meal guidance, produce a SHOPPING LIST grouped by section.
Format:
**Produce:** - [ ] item
**Protein:** - [ ] item
**Dairy/Eggs:** - [ ] item
**Pantry:** - [ ] item
**Other:** - [ ] item

Include a "Copy and paste" section at the bottom with just the item names, no bullets, for easy clipboard use.
Keep quantities realistic for 7 days (American measures). Note which items support his supplement timing or goals.`,

  photo: `Analyze Fernando's physique photo carefully and directly.
Cover:
1. **Body composition** — muscle fullness, visible fat distribution, overall stage estimate
2. **Development** — which muscle groups are progressing well, which lag behind
3. **Posture & symmetry** — any imbalances or alignment notes
4. **Action items** — 2-3 specific things to train harder or smarter based on what you see

Then give him photo guidance for better tracking:
5. **For your next photo** — exact poses (front relaxed, front flexed, side, back), lighting setup (natural window light, no overhead), time of day (morning fasted or post-pump), what to wear (shorts or compression), and distance from camera.

Be direct. No medical disclaimers. Treat him like an athlete who wants honest feedback.`,

  progress: `You're shown TWO physique photos of Fernando: the FIRST image is the OLDER photo, the SECOND is the MORE RECENT one. Compare them and give him a real progress read.
Cover:
1. **What changed** — muscle gained, fat lost, conditioning, fullness. Be specific about which areas (shoulders, arms, chest, back, legs, midsection).
2. **Honest verdict** — is he heading the right direction for his goal? Don't blow smoke; if there's little visible change, say so and why that might be.
3. **What's working / what to push** — 2-3 specific training or nutrition adjustments based on what the comparison shows.
Account for lighting/pose/pump differences between the two shots — don't over-read those as real change.
Be direct, like a coach who's watched him train. No medical disclaimers. Keep it under 200 words.`,

  food_photo: `You are a precise sports dietitian estimating the nutrition of a meal photo.

Step 1 — List every food item visible before estimating anything.
Step 2 — For each item, estimate the portion using visual reference anchors:
  • 3 oz meat ≈ deck of cards | 6 oz ≈ two decks | 8 oz ≈ a paperback book
  • 1 cup rice/pasta ≈ a fist | ½ cup ≈ a cupcake wrapper | ¼ cup ≈ a golf ball
  • 1 tbsp oil/butter ≈ a poker chip | 1 oz nuts ≈ a shot glass
  • A restaurant plate is typically 1.5–2× a home-cooked portion
  • Large diner eggs are ~80 cal each; medium are ~65 cal
Step 3 — Sanity-check totals with these anchors:
  • Plain chicken breast: ~165 cal/6 oz | cooked white rice: ~200 cal/cup
  • Salad greens: ~20 cal/2 cups | 1 tbsp olive oil: 120 cal
  • If sauces, dressings, or oils are visible — add them as separate line items; they are the #1 source of under-counting
Step 4 — Hidden-fat rule (the #1 source of error): assume any sautéed, pan-fried, roasted, or restaurant-cooked savory item was cooked in oil or butter (~1 tbsp / 120 cal per portion) UNLESS it is clearly raw, steamed, boiled, grilled dry, or air-fried. Glossy/shiny surfaces, browning, or a sheen on the plate mean added fat — count it. Only skip added fat if the food is visibly dry or plainly raw.
Step 5 — Lean slightly conservative overall, but do NOT undercount fat. If the user added context about cooking method or extra items, factor that in.
If any context text is provided below the instruction, use it to correct or supplement your visual estimate.

Respond with ONLY a fenced json code block — nothing before or after it:
\`\`\`json
{"items":[{"name":"food","qty":"e.g. 4 large eggs","calories":000,"protein":00,"carbs":00,"fat":00}],"totals":{"calories":000,"protein":00,"carbs":00,"fat":00},"confidence":"high|medium|low","note":"one short honest caveat"}
\`\`\`
All numbers are integers (calories and grams). American portion units in qty.`,

  food_text: `Estimate the nutrition of the meal Fernando describes. Estimate portions like a careful
dietitian and be honest about uncertainty.
Respond with ONLY a fenced json code block — nothing before or after it:
\`\`\`json
{"items":[{"name":"food","qty":"e.g. 6 oz / 1 cup","calories":000,"protein":00,"carbs":00,"fat":00}],"totals":{"calories":000,"protein":00,"carbs":00,"fat":00},"confidence":"high|medium|low","note":"one short honest caveat"}
\`\`\`
All numbers are integers (calories and grams). American portion units in qty.`,

  digest: `Write Fernando a WEEKLY DIGEST from his long-term data. Keep it tight and motivating, like a
coach reviewing the week with him. Format:
**This week**
- Recovery: [avg + trend vs prior, one line]
- Training: [what he hit / missed]
- Nutrition: [calories/protein adherence]
- Recovery factors: [alcohol/nicotine/etc patterns worth flagging]
**Win of the week:** [one specific thing]
**Fix for next week:** [one specific, actionable thing]
Under 180 words. Use real numbers. American units. No filler.`,

  set_goals: `Set Fernando's optimal daily nutrition targets based on everything you know about him.

Use this reasoning process:
1. Start from his WHOOP daily calorie burn (if available) or estimate TDEE from his weight + activity level.
2. Apply his goal offset: muscle = +350–500 cal, fat loss = −400 to −500 cal, recomp = +100 cal, performance = maintenance.
3. Set protein at 0.85–1.0g per lb of bodyweight (higher end if cutting).
4. Set fat at 25–30% of total calories.
5. Fill remaining calories with carbs.
6. Round to clean numbers.

Write 3–5 sentences explaining your reasoning using his actual numbers (weight, WHOOP burn, goal). Be direct — tell him WHY these numbers, not just what they are.

Then on its own line at the very end, output this marker with no extra text around it:
###GOALS###{"calories":XXXX,"protein":XXX,"carbs":XXX,"fat":XXX}###GOALS###

Replace the X values with integers. Do not output the marker anywhere except the last line.`,

  one_liner: `Output ONE sentence — maximum 18 words, no markdown, no period at the end — stating the single most important thing about the user's body right now based on their WHOOP data and recent trends. Be specific about numbers. Examples: "HRV 14% above baseline — green light for intensity today", "Sleep debt stacking from two short nights — prioritize 8+ hours tonight", "Recovery dip after yesterday's high strain — moderate effort only". Just the sentence, nothing else.`,

  chat: `Answer Fernando's question as his coach, using his data above when relevant.
Keep it conversational — match his energy and the way he talks. If he's asking something quick, answer quick.
If he mentions supplements, sleep, body changes, food, or training, tie it to his actual numbers and history.
No filler, no long paragraphs unless he asks for depth.

MEMORY CAPTURE — when Fernando tells you a DURABLE fact about himself that's worth remembering long-term
(an injury or physical limitation, a lasting preference, a PR, his training schedule/availability, a goal,
his equipment, a dietary constraint), append EXACTLY ONE marker as the very last line of your reply:
###REMEMBER###{"fact":"<the fact in third person, one short sentence>"}###REMEMBER###
Rules:
- Only for lasting facts. NEVER for transient state ("I'm tired today", "good workout") or one-off questions.
- Do NOT emit the marker if the fact (or a close equivalent) is already in the MEMORIES list above.
- Put it on its own final line. Never mention the marker, "remember", or memory mechanics in your visible reply —
  just answer naturally; the app handles the confirmation.
- At most one marker per reply. When in doubt, leave it out.`,
};

const FOOD_MODES = ['food_photo', 'food_text'];

export default async function handler(req, res) {
  if (cors(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!API_KEY) return res.status(500).json({ error: 'Claude not configured. Add ANTHROPIC_API_KEY in Vercel.' });

  const b = parseBody(req);
  const mode = b.mode || 'chat';
  const isFood = FOOD_MODES.includes(mode);

  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  const uid = user.id;

  // Lightweight path: persist the parsed active program (JSON) for cross-device sync.
  // No Claude call needed — the frontend already parsed the weekly split.
  if (mode === 'save_program') {
    if (!dbReady()) return res.status(200).json({ ok: false, reason: 'db not configured' });
    if (!Array.isArray(b.program) || !b.program.length) return res.status(400).json({ error: 'program array required' });
    try {
      await dbInsert('plans', {
        user_id: uid, kind: 'program', title: 'Active training program',
        content: JSON.stringify(b.program),
      });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message || String(e) });
    }
  }

  // Per-user daily cap on Claude-backed coach calls (protects the owner's token bill).
  const DAILY_CAP = Number(process.env.COACH_DAILY_CAP) || 30;
  const usage = await bumpUsage(uid, DAILY_CAP);
  if (usage.over) {
    return res.status(429).json({ error: `You've reached today's coach limit (${DAILY_CAP} messages). It resets tomorrow.` });
  }

  // Pull DB context (best-effort). Food estimation doesn't need the full history.
  let profile = null, log = null, recent = [], meals = [], memories = [], workouts = [];
  // Program: localStorage copy (b.program) is source of truth; DB row is fallback.
  let program = Array.isArray(b.program) ? b.program : null;
  if (dbReady() && !isFood) {
    const date = new Date().toISOString().slice(0, 10);
    try {
      [profile] = await dbSelect('profiles', { filters: { id: `eq.${uid}` }, limit: 1 });
      [log] = await dbSelect('daily_logs', { filters: { user_id: `eq.${uid}`, log_date: `eq.${date}` }, limit: 1 });
      recent = await dbSelect('daily_logs', { filters: { user_id: `eq.${uid}` }, order: 'log_date.desc', limit: 90 });
      meals = await dbSelect('meals', { filters: { user_id: `eq.${uid}`, meal_date: `eq.${date}` }, order: 'created_at.desc' });
      memories = await dbSelect('memories', { filters: { user_id: `eq.${uid}` }, order: 'created_at.desc', limit: 50 });
      workouts = await dbSelect('workouts', { filters: { user_id: `eq.${uid}` }, order: 'workout_date.desc', limit: 30 });
      if (!program) {
        const [progRow] = await dbSelect('plans', { filters: { user_id: `eq.${uid}`, kind: 'eq.program' }, order: 'created_at.desc', limit: 1 });
        if (progRow && progRow.content) { try { program = JSON.parse(progRow.content); } catch { /* content was markdown, ignore */ } }
      }
    } catch (e) { /* run with whatever we have */ }
  }

  const instruction = MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.chat;

  // Resolve an image from either food (b.image) or physique (body.recent[0]).
  const photoItem = b.body?.recent?.[0];
  let imageDataUrl = null;
  if (typeof b.image === 'string' && b.image.startsWith('data:image/')) imageDataUrl = b.image;
  else if (photoItem?.storage_url?.startsWith('data:image/')) imageDataUrl = photoItem.storage_url;
  const hasImage = !!imageDataUrl;

  // Build the text content for this turn.
  let textContent;
  if (isFood) {
    const dietary = profile?.dietary_style ? `Dietary style: ${profile.dietary_style}\n\n` : '';
    const desc = b.message ? `\n\nWhat it is: ${b.message}` : '';
    textContent = `${dietary}${instruction}${desc}`;
  } else {
    const context = fmt({ profile, log, whoop: b.whoop, recent, body: b.body || null, meals, memories, program, workouts });
    const userTurn = mode === 'chat' ? (b.message || 'Give me a quick read on my day.') : instruction;
    const userName = profile?.name?.split(' ')[0] || 'Fernando';
    const chatExtra = mode === 'chat' ? getChatContextHint(b.message) + getAdaptiveTone(b.message) : '';
    textContent = `${context}\n\n---\n\n${mode === 'chat' ? instruction + chatExtra + '\n\n' + userName + ': ' + userTurn : userTurn}`;
  }

  // Build messages (chat history only matters for chat).
  const messages = [];
  if (mode === 'chat' && Array.isArray(b.history)) {
    for (const h of b.history.slice(-8)) {
      if (h && h.role && h.content) messages.push({ role: h.role, content: String(h.content) });
    }
  }

  const toImageBlock = (dataUrl) => {
    const [header, b64data] = dataUrl.split(',');
    const mediaType = (header.match(/data:(.*);base64/) || [])[1] || 'image/jpeg';
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64data } };
  };
  // progress mode compares two photos (older first, newer second)
  const progressImages = mode === 'progress' && Array.isArray(b.images)
    ? b.images.filter((s) => typeof s === 'string' && s.startsWith('data:image/'))
    : null;

  if (progressImages && progressImages.length === 2) {
    messages.push({
      role: 'user',
      content: [...progressImages.map(toImageBlock), { type: 'text', text: textContent }],
    });
  } else if (hasImage) {
    messages.push({
      role: 'user',
      content: [toImageBlock(imageDataUrl), { type: 'text', text: textContent }],
    });
  } else {
    messages.push({ role: 'user', content: textContent });
  }

  const maxTokens = mode === 'photo' ? 2000 : isFood ? 700 : mode === 'one_liner' ? 60 : 1500;
  const personalityBlock = !isFood && profile ? (COACH_PERSONALITIES[profile.coach_style] || '') : '';
  const systemPrompt = isFood ? 'You are a precise nutrition estimator. Output only what is asked.' : BASE_SYSTEM + personalityBlock;
  const wantsStream = b.stream === true && mode === 'chat';

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        stream: wantsStream,
        system: systemPrompt,
        messages,
      }),
    });

    // ── Streaming path (chat mode only) ────────────────────────────────
    if (wantsStream) {
      if (!r.ok) {
        const errText = await r.text().catch(() => r.status);
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ error: 'Claude error ' + r.status + ': ' + errText })}\n\n`);
        return res.end();
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const ev = JSON.parse(data);
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              res.write(`data: ${JSON.stringify({ text: ev.delta.text })}\n\n`);
            } else if (ev.type === 'message_stop') {
              res.write('data: [DONE]\n\n');
            }
          } catch {}
        }
      }
      return res.end();
    }

    // ── Non-streaming path ──────────────────────────────────────────────
    const j = await r.json();
    if (!r.ok) return res.status(500).json({ error: 'Claude: ' + JSON.stringify(j) });
    const reply = (j.content || []).map((c) => c.text || '').join('').trim();

    // Optionally persist generated plans.
    if (b.save && ['meal', 'recipe', 'workout', 'grocery'].includes(mode) && dbReady()) {
      try {
        await dbInsert('plans', {
          user_id: uid, kind: mode,
          title: mode[0].toUpperCase() + mode.slice(1) + ' plan',
          content: reply,
        });
      } catch (e) { /* non-fatal */ }
    }

    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
