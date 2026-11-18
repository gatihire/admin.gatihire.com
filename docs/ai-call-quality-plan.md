# AI Screening Call Quality — Plan

*Plain-language plan for the team. Read time: about 20 minutes.*
*Status: **plan, nothing built yet**. Code changes start only after this is agreed.*

---

## 1. The short version

Our calls no longer drop. They are still short, shallow, and slightly random.

We fixed the plumbing (synthesizer errors 67% → 1%, mid-interview drops 26% → 2%, clean closes
64% → 80%). What is left is the *content* of the call: the agent reads five flat questions, gets
about eleven one-line answers, and closes at 2.5 minutes. The prompt says "4 se 6 minute", the
welcome message says "do minute", and the reason line says "teen-chaar minute". The candidate
believes the shortest number and the agent behaves like it too.

This plan changes four things, in this order:

| # | Change | Why |
|---|---|---|
| 1 | **Send a 3-topic interview plan instead of 5 flat questions** | One question per topic tells the agent nothing about how to dig or how to judge the answer. A topic with probes does. |
| 2 | **Enforce the question rules in code, not in the prompt** | The banned joining question still appears in 16% of calls because our own fallback generator adds it. A prompt alone cannot stop that. |
| 3 | **Score from topic evidence, not from a fixed 8/6/2 band** | Today every "advance" is 8 and every "further review" is 6, whatever was actually said. |
| 4 | **Fix the things outside the code**: silence settings, model, call windows, retries | Three recommended Bolna settings were never applied, and no automatic retries are running. |

### What changed after reviewing a live call (18 Nov)

The first live review (Appendix B) exposed three gaps in this plan. They are now part of it:

| Gap | Rule added |
|---|---|
| The agent did not know the job at all (`job_gist` was literally `"A full_time role"`) | **Role-family defaults.** A Manager/Head/Lead title gets a people-management topic even when the JD is empty. |
| An 87-second call is above the 60-second no-score gate, so it could still get a 6/10 | **Replace the minutes gate with evidence:** no score without 2 topics of evidence. |
| A retry went out with an empty payload — no questions, no job title | **Payload assertion before dialling.** If the stored payload has no plan, build one before dialling — wrapping the row's own questions when they exist, otherwise from the job template. |

### Decisions we need from you

| Question | Recommendation |
|---|---|
| Do we still want the 4–6 minute target? | **Yes, but for real conversations only, and phrased as 5 minutes everywhere.** Minutes are an *output* of covering 3 topics with follow-ups, not a target the agent should chase. Hard cap **6 minutes** (§7.2 tightened it from 7: three topics x three digs is 6.6 minutes of speech, so the old shape could not finish in five). A candidate who gives one-line answers gets a short call and a weak score — that is the correct outcome, not a failure. |
| How many topics? | **3**, as you specified: two from the JD's must-haves, one that verifies a claim from the resume. |
| Which model? | Keep `gemini-3.1-flash-lite-preview` on the main agent for now; **test a stronger model on a separate test agent** before switching. Latency already went 510 ms → 966 ms to first word. |
| Where do dealbreakers go? | **Confirm-only, at the end**, not as interview topics. "HMV licence hai na?" is a yes/no, not a conversation. |
| When do we call? | **10:00–19:00 IST, best window 11:00–13:00.** Outside that, WhatsApp instead. |
| When does the client see the report? | After the call is scored, same day. Not in this phase. |

---

## 2. What the calls look like today

Your comparison, kept as-is:

| Metric | Before (Oct 19–24) | After (Nov 11–16) |
|---|---|---|
| Calls placed | 155 | 181 |
| Connected | 84 (54%) | 82 (45%) |
| Average length, all connected | 1.84 min | 1.79 min |
| Average length, real conversations (45s+) | 2.38 min | 2.52 min |
| Median, real conversations | 2.13 min | 2.48 min |
| Real conversations reaching 4+ min | 8% | 5% |
| Longest real call | not checked | 4.3 min |
| Ended by `synthesizer_error` | 67% | 1% |
| Candidate spoke, agent never replied | 26% | 2% |
| Agent closed the call properly | 64% | 80% |
| Interruptions per call | 6.2 | 4.7 |
| Agent asked the banned joining/notice question | 61% | 16% |
| No-answer | 33 | 69 |
| Voicemail | — | 13 |
| Calls under 30s | 19% | 28% |
| …of those, no candidate speech at all | — | 16 of 23 |

**Caveats before anyone quotes these numbers:**

- Different weeks, different candidates. Oct had ~61 real conversations, Nov ~56. A few points of
  movement is noise.
- The drop and closing-line figures were recounted on both sides with the same parser, because the
  first pass dropped old messages that mixed the goodbye with the JSON.
- Bolna's list API now only returns calls from Nov 11 onward. The Oct baseline is our saved copy.
  Nothing between Oct 25 and Nov 10 is in either figure.

**What the numbers say, in one line each:**

- Drops: fixed. Do not spend more time here.
- Length: not fixed, and it will not be fixed by prompt wording alone — the agent has nothing to
  dig with.
- Banned question: 61% → 16% is real progress, but 16% is still one call in six, and we know the
  exact code path that causes it (§3, defect 4).
- Connect rate: this got *worse* while we were fixing drops, and it is the cheapest metric to move.
- Instant hangups: mostly silent pickups and screeners, not our bug. Treat them as a routing
  problem, not a conversation problem.

---

## 3. How a call is built today

### The pipeline

```
job + candidate + WhatsApp info
        │
        ▼
generateJDQuestions()            lib/jd-questions.ts
  Gemini, MODEL = gemini-3.1-flash-lite-preview
  returns 3–6 strings
        │
        ▼
dropAlreadyAnswered()            regex filter, NEVER_ASK list
        │
        ▼
buildCallUserData()              lib/call-orchestrator.ts:599
  questions.slice(0, 5)
  questions.map((q, i) => `${i+1}. ${q}`).join("\n")
        │
        ▼
userData.questions  ──────────►  stored in phone_screening_participants.call_payload_json
        │
        ▼
placeCallForParticipant()        lib/scheduled-call.ts:477
  { ...call_payload_json, ...alreadyCollected, participant_id }
        │
        ▼
POST https://api.bolna.ai/call   { agent_id, recipient_phone_number, user_data }
        │
        ▼
Bolna substitutes {questions} into BOLNA_MASTER_PROMPT and reads them in order
```

Two things matter here:

1. **The plan is rebuilt at placement time.** `call_payload_json` is the stored snapshot, and
   `placeCallForParticipant` merges the latest WhatsApp answers over it. So anything we add to the
   payload survives retries and late WhatsApp replies without a second Gemini call.
2. **The prompt is text, not JSON.** Bolna does simple placeholder substitution. It does not parse
   structured data. Whatever we send has to *read well as instructions*.

### Defects, in the order they hurt

| # | Defect | Where | Effect |
|---|---|---|---|
| 1 | Questions are a flat list of strings | `jd-questions.ts` → `call-orchestrator.ts:637` | No probes, no strong/weak, no evidence. The agent has one follow-up per call and no idea what a *good* answer sounds like. |
| 2 | Three different call lengths in one prompt | `bolna.ts` welcome (line 439: "do minute"), flow step 2 (line 397: "teen-chaar minute"), step 3 (line 402: "4 se 6 minute") | Candidate anchors to 2 minutes. Agent closes at 2.5. The prompt's own promise is unreachable. |
| 3 | "Only one follow-up" rule | `bolna.ts` line 401 | With 5 questions and 1 follow-up you get ~11 short answers. Exactly what we measure. |
| 4 | Fallback generator always adds a joining question | `jd-questions.ts:246`, and `NEVER_ASK` has no joining rule | This is the 16%. The generator prompt (line 194) *also* asks for a joining confirm, while the master prompt (line 412) forbids it. Two sources of truth, one of them wrong. |
| 5 | Questions are generated per candidate | `buildCallUserData` calls `generateJDQuestions(job, candidate, …)` | Two candidates for the same job get different questions, so their scores are not comparable. |
| 6 | Nothing verifies a resume claim | same | The call confirms what the CV says instead of testing it. |
| 7 | Score is a band constant | `bolna-execution.ts:1004` (`advance: 8, further_review: 6, not_a_fit: 2`), and `:389` for the fallback | Every advance is 8/10. Recruiters read that as a real judgement. |
| 8 | No timestamps in the transcript | `call_transcripts` stores `speaker` + `text` only | We cannot compute talk ratio, per-topic time, or interruptions per call from our own data. |
| 9 | No dealbreaker concept | nowhere | Licence, 3PL vendor experience, etc. are not modelled. The only licence check is a hardcoded fallback question. |
| 10 | The 15-word / jargon / no-client-name rules are not enforced | nowhere | They exist in your spec and in no code. |

> Defect 4 is worth calling out separately: it is the only one where the system actively
> contradicts itself. Fixing the prompt without fixing `buildFallbackQuestions` will leave the
> banned question in place forever, because the fallback runs whenever Gemini fails — and Gemini
> failures are exactly the calls where nobody is watching.

---

## 4. How the questions should be sent

This is the core of the change.

### 4.1 The shape

A **plan**, not a question list. Three topics. Each topic carries the ask, the digs, and the
judgement criteria, because those three things belong together and are useless apart.

```
TOPIC 1 — Stock reconciliation            (must-have from JD)
  Ask:    "Pichli job mein stock mismatch aaya tha — ek baar ka bataiye, aapne kya kiya?"
  Dig:    scale · system used · own role vs team · result
  Strong: names a system, gives numbers, describes own action
  Weak:   only theory, "team karti thi", no example

TOPIC 2 — <second must-have from JD>
TOPIC 3 — <one claim from the resume to verify>
          e.g. "Resume mein 40 drivers ki team — unka din kaise plan karte the?"

DEALBREAKERS (confirm only, at the end)
  - HMV licence required
  - Must have handled 3PL vendors        → note: this is a probe under a topic, not a yes/no
```

And at the end, one yes/no check per dealbreaker.

### 4.2 Schema

Stored inside the existing `call_payload_json` column, under a new key. No migration is needed for the
column itself (it is `jsonb`); `version` is what lets old and new plans run side by side during the
rollout.

```json
{
  "version": 1,
  "job_id": "…",
  "generated_at": "2026-11-18T09:00:00Z",
  "language": "hinglish",
  "call_shape": {
    "target_seconds": 300,
    "hard_cap_seconds": 360,
    "topics": 3,
    "max_digs_per_topic": 2
  },
  "topics": [
    {
      "id": "stock_reconciliation",
      "label": "Stock reconciliation",
      "source": "jd_must_have",
      "must_have": true,
      "order": 1,
      "ask": "Pichli job mein stock mismatch aaya tha — ek baar ka bataiye, aapne kya kiya?",
      "digs": [
        { "key": "scale",     "prompt": "Kitne SKU ya orders roz handle karte the?" },
        { "key": "system",    "prompt": "Kaun se system ya sheet pe kaam karte the?" },
        { "key": "ownership", "prompt": "Yeh aap khud karte the ya team karti thi?" },
        { "key": "result",    "prompt": "Us mismatch ka end result kya nikla?" }
      ],
      "strong": "Names a system, gives numbers, describes own action",
      "weak": "Only theory, says 'team karti thi', no example",
      "resume_hook": null
    },
    {
      "id": "dispatch_planning",
      "label": "Daily dispatch planning",
      "source": "jd_must_have",
      "must_have": true,
      "order": 2,
      "ask": "Roz ka dispatch kaise plan karte the — subah se truck nikalne tak kya karte the?",
      "digs": [
        { "key": "scale",     "prompt": "Ek din mein kitne truck nikalte the?" },
        { "key": "system",    "prompt": "Planning ke liye koi software use karte the?" },
        { "key": "ownership", "prompt": "Route aap decide karte the ya senior?" },
        { "key": "result",    "prompt": "Koi din late hua ho to kya kiya?" }
      ],
      "strong": "Walks through a real morning, names trucks/routes, own decisions",
      "weak": "Generic 'planning karte the', no numbers, no sequence",
      "resume_hook": null
    },
    {
      "id": "resume_team_size",
      "label": "Resume claim — 40 drivers",
      "source": "resume_claim",
      "must_have": false,
      "order": 3,
      "ask": "Resume mein 40 drivers ki team likha hai — unka din kaise plan karte the?",
      "digs": [
        { "key": "scale",     "prompt": "40 drivers mein se ek din mein kitne report karte the?" },
        { "key": "ownership", "prompt": "Attendance aur leave aap dekhte the?" },
        { "key": "result",    "prompt": "Koi driver absent ho to uska truck kaun chalata tha?" }
      ],
      "strong": "Speaks from memory, gives names/numbers/shift details, owns the roster",
      "weak": "Repeats the resume line, cannot describe a single day",
      "resume_hook": "40 drivers"
    }
  ],
  "dealbreakers": [
    {
      "id": "hmv_licence",
      "label": "HMV licence",
      "type": "confirm",
      "confirm": "Aapke paas HMV licence hai na?",
      "if_missing": "close_politely",
      "mandatory": true
    }
  ],
  "render": {
    "block": "…plain text, see 4.4…",
    "words": 214
  }
}
```

Notes on the schema:

- `digs` is an **array of objects**, not a single string, because the renderer needs to pick at most
  `max_digs_per_topic` and the scorer needs to key evidence to a `key`.
- `strong` / `weak` are **not spoken**. They go to the scorer, and from there to the client report.
  The renderer prints them in the agent block anyway, because seeing "Weak: only theory" makes the
  model dig on a thin answer — that is the cheapest way to get depth without a bigger prompt.
- `resume_hook` is the verbatim string from the resume we are testing. If it is empty, the third
  topic must come from the JD instead.
- `source` tells us later whether a topic came from the JD, the resume, or a recruiter's manual edit.
  That is how we learn which topics actually produce evidence.

### 4.3 Why JSON in the DB, text in the prompt

This is a deliberate split.

| Layer | Format | Reason |
|---|---|---|
| DB (`call_payload_json.interview_plan`) | JSON | Structured. Editable, scoreable, comparable across candidates, versionable. |
| Bolna `user_data` (`interview_plan`) | Plain text | The agent reads placeholders as **text**. JSON braces and quotes get spoken or confuse the model. |
| Legacy `user_data.questions` | Plain text, numbered list | Kept as a fallback for the current agent prompt until it is swapped. |

Two hard constraints drove this:

1. `buildCallUserData` logs any value containing `{` and `}` as an *unfilled placeholder*
   (`call-orchestrator.ts:642`). Sending raw JSON would produce a warning on every call and would
   eventually be "fixed" by someone who did not know why it was there.
2. `BOLNA_MASTER_PROMPT` ends with "Kabhi JSON, code, ya brackets nahi bolna". Sending JSON into a
   prompt that is explicitly told never to speak JSON is asking for trouble.

So: **store structured, render to prose, send prose.**

### 4.4 The rendered `{interview_plan}` block

This is what the agent actually receives. Roughly 200 words. Written the way a recruiter would brief
a colleague, not the way a database would dump a record.

```text
INTERVIEW PLAN — 3 topics, about 5 minutes (hard stop 7)

TOPIC 1 — Stock reconciliation  [must-have]
Ask: Pichli job mein stock mismatch aaya tha — ek baar ka bataiye, aapne kya kiya?
Dig if thin: kitne SKU ya orders · kaun sa system · aapne khud kiya ya team ne · result kya nikla
A strong answer: names a system, gives numbers, describes their own action.
A weak answer: only theory, "team karti thi", no example.

TOPIC 2 — Daily dispatch planning  [must-have]
Ask: Roz ka dispatch kaise plan karte the — subah se truck nikalne tak kya karte the?
Dig if thin: kitne truck · kaun sa software · route kaun decide karta tha · late hone pe kya kiya
A strong answer: walks through a real morning, own decisions, numbers.
A weak answer: generic "planning karte the", no sequence, no numbers.

TOPIC 3 — Resume claim: 40 drivers
Ask: Resume mein 40 drivers ki team likha hai — unka din kaise plan karte the?
Dig if thin: kitne report karte the · attendance aap dekhte the · absent driver ka truck kaun chalata
A strong answer: speaks from memory, shift and roster detail, owns the problem.
A weak answer: repeats the resume line, cannot describe one day.

BEFORE CLOSING — confirm only, do not interview on these
- HMV licence: "Aapke paas HMV licence hai na?" If no, close politely. Do not argue.

HOW TO RUN THIS
- One topic at a time, in this order. Easy first, hardest last.
- Ask the topic question once. Dig up to 3 times, only when the answer is thin.
- If the answer is already strong, move to the next topic. Do not pad.
- Never read this plan out loud. It is your notes, not your script.
```

Three things to notice:

- **`Dig if thin`** is the depth ladder that replaces "one follow-up". Two digs per topic × 3
  topics is 9 spoken questions, about 5 minutes — the budget the plan promises. Three digs per
  topic was the arithmetic bug behind 6.6-minute calls; see §7.2.
- **`If the answer is already strong, move on`** is what stops us padding to hit a minute target. A
  strong candidate should finish at 4 minutes and score high; a vague one should finish at 3 and
  score low.
- **`confirm only, do not interview on these`** keeps dealbreakers out of the topic flow. Nothing
  kills a good call faster than opening with "Aapke paas licence hai?".

### 4.5 Prompt edits

Seven edits in `lib/bolna.ts` (`BOLNA_MASTER_PROMPT` and `BOLNA_WELCOME_MESSAGE`), and the same
text mirrored into `docs/ai-screener-prompt.md`.

| Line (today) | Now | Change to |
|---|---|---|
| 400 | `{questions}` | `{interview_plan}` |
| 401 | "Jawab vague ho to sirf ek follow-up poochein" | "Jawab thin ho to us topic ke 'Dig if thin' points se **2 tak** follow-up poochein. Jawab strong ho to agla topic." (§7.2: 3 was too many for a 5-minute call) |
| 402 | "Poori call 4 se 6 minute mein khatam karein" | "Poori call **5 minute** ke aas paas rakhein, 6 minute se zyada nahi. Teeno topic cover karna minute se zyada zaroori hai." |
| 393 | "Kya abhi do minute baat ho sakti hai?" | Remove. The welcome message already asks. |
| 397 | "teen-chaar minute lagenge" | "paanch minute lagenge" |
| 412 | Joining question forbidden | Keep, and add "plan ke bahar koi sawaal nahi" |
| 439 | Welcome: "do minute" | "paanch minute" |

**One promise, everywhere.** Whichever number we pick, it appears once and only once in the spoken
flow. The current three-number drift is the single cheapest defect to fix and it explains a large
part of the 2.5-minute ceiling.

Recommended welcome (short, honest, still cheap to say yes to):

```text
Hello {candidate_first_name} ji, Ayush bol raha hu GatiHire se — Truckinzy ki logistics
hiring team se. Aapke {job_title} profile ke baare mein paanch minute baat karni thi.
Abhi theek hai?
```

### 4.6 Backend contract

Four code shapes, kept in one place so the renderer and the scorer cannot drift apart.

```ts
// lib/interview-plan.ts  (new)

export interface InterviewPlanTopic {
  id: string
  label: string
  source: "jd_must_have" | "resume_claim" | "manual"
  must_have: boolean
  order: number
  ask: string
  digs: { key: "scale" | "system" | "ownership" | "result" | string; prompt: string }[]
  strong: string
  weak: string
  resume_hook: string | null
}

export interface InterviewPlan {
  version: 1
  job_id: string
  generated_at: string
  language: "hinglish" | "english"
  call_shape: { target_seconds: number; hard_cap_seconds: number; topics: number; max_digs_per_topic: number }
  topics: InterviewPlanTopic[]
  dealbreakers: { id: string; label: string; type: "confirm"; confirm: string; if_missing: "close_politely" | "flag"; mandatory: boolean }[]
}

export function generateInterviewPlan(job: JobContext, candidate: CandidateContext, info: Record<string, unknown>): Promise<InterviewPlan>
export function validateInterviewPlan(plan: InterviewPlan, ctx: ValidationContext): { ok: boolean; errors: string[]; plan: InterviewPlan }
export function renderInterviewPlan(plan: InterviewPlan): string
export function renderLegacyQuestions(plan: InterviewPlan): string   // for the old {questions} placeholder
```

Wiring in `buildCallUserData` (`call-orchestrator.ts:599`):

```ts
const plan = await generateInterviewPlan(job, candidate, infoData ?? {})
const checked = validateInterviewPlan(plan.plan, { job, candidate })

const userData = {
  …existing keys…
  questions: renderLegacyQuestions(checked.plan),   // old prompt keeps working
  interview_plan: renderInterviewPlan(checked.plan), // new prompt reads this
  _interview_plan: checked.plan,                     // structured, stripped before sending
}
```

`_interview_plan` is removed by `toBolnaUserData()` on every send path, because Bolna must never
receive a nested object — the agent would either speak it or choke on it.

And store the plan itself next to the payload, so the results sheet and the scorer can read it:

```ts
await supabase.from("phone_screening_participants").update({
  call_payload_json: { ...userData, interview_plan_json: checked.plan },
})
```

Because `placeCallForParticipant` already merges fresh WhatsApp data over `call_payload_json`, and
because `interview_plan` is a plain string computed once, **retries do not regenerate the plan**.
That is deliberate: a retry must ask the same thing, otherwise the two attempts cannot be compared.

### 4.7 Fallback when generation fails

Today a Gemini failure silently produces a generic list that includes the banned joining question
(§3, defect 4). New behaviour:

1. Try Gemini.
2. Run `validateInterviewPlan`. If it fails, retry **once** with the validator errors appended to the
   prompt ("these questions broke the rules: …").
3. If it still fails, use a **deterministic template** built from the JD, never from free text:

```ts
buildTemplatePlan(job)  // 3 topics:
  // 1. must_have_skills[0] — "Is skill ka ek real example bataiye" + scale/system/ownership/result digs
  // 2. key_responsibilities[0] — same dig shape
  // 3. daily_work_summary or licence — resume hook if present, else JD
  // dealbreakers: licence_type from the job, if set
```

The template has no joining question, no "kya aapne kabhi", and no client name. That is the point:
the fallback must be **safe**, not clever.

### 4.7a Rows queued before the plan existed

The prompt will read `{interview_plan}`, but old rows only have `questions`. Dropping them would
either lose a recruiter's hand-edited wording or leave the placeholder unfilled. So placement checks
for a missing plan and builds one **before dialling**:

- questions exist → `buildPlanFromQuestions()` keeps the ones that pass today's rules verbatim
  (same wording, generic digs, generic strong/weak) and drops the rest — a queued row cannot smuggle
  the joining question, a `kya aapne kabhi`, a client name or an unlisted acronym past the new prompt;
- fewer than two questions survive, or nothing exists → `buildTemplatePlan()` from the job, with
  role-family defaults.

Either way the plan is persisted back to `call_payload_json`, and the legacy `questions` key is
re-rendered **from the plan**, so the two placeholders can never disagree. This is also why the
prompt can be swapped safely while 30+ old rows are still in the queue.

Worked example, using the three questions actually sent on the 87-second call: all three fail
(word limits, `kya aapne kabhi`, `CLRA`, `kar sakte hain`, joining), so that row now dials the safe
template instead. A hand-edited list of three where only the last asks about joining keeps the first
two and drops the third.

### 4.8 Manual editing

The profile sidebar already lets HR edit `generated_questions` and rewrites
`call_payload_json.questions` (`candidate-profile-sidebar.tsx:407`). In this plan that becomes a
two-tab editor:

| Tab | Writes | Used by |
|---|---|---|
| **Plan** (topics: ask, digs, strong, weak) | `call_payload_json.interview_plan_json` | New prompt, scorer, client report |
| **Text** (the rendered block) | `call_payload_json.interview_plan` | Anything that needs an override for one candidate |

Editing the Plan tab re-renders both strings. Editing the Text tab sets an `manual_override: true`
flag so a later regeneration does not silently overwrite a recruiter's wording. The existing
`generated_questions` column keeps being written (mirrored) so no list view breaks.

### 4.8a The question editor — fixed 18 Nov

The editor used to PATCH a route that had no handler:

```text
PATCH /api/phone-screening/participants/{id}  →  405   (before)
GET   /api/phone-screening/participants/{id}  →  401 (handler exists)
```

`candidate-profile-sidebar.tsx` called it anyway and showed **"Questions updated"**, because
`fetch` does not reject on a 405. A recruiter could rewrite a question, be told it was saved, and
then listen to a call that asked the old one. That is worse than having no editor.

`PATCH` now exists and is deliberately strict:

| Rule | Why |
|---|---|
| Requires `applications.manage` | Editing changes what a candidate is asked |
| Accepts only `generated_questions` | A client-supplied `call_payload_json` is ignored — the plan is rebuilt server-side |
| Rebuilds the plan from the edited text via `buildPlanFromQuestions` | The prompt reads `interview_plan`; writing only `questions` would change nothing the agent says |
| Writes `generated_questions`, `questions`, `interview_plan` and `_interview_plan` together | Card and call cannot disagree |
| Returns `questions`, `dropped[]`, `used_template`, `applies_to` | The UI shows what was saved, not what was typed |
| Edits during a live call return `applies_to: "next_call"` | A payload already sent to the provider cannot be changed |

`questionRuleErrors()` is exported from `lib/interview-plan.ts` and used by the generator, the
editor, and the legacy-row bridge, so all three apply the same rules.

The UI no longer toasts on a failed save: it checks `res.ok`, shows the server's error, and renders
the returned list. If the server replaced the edit (banned question, client name), the toast says
so and the box shows the replacement.

**Stacked-question detection was also too weak.** It counted `?` marks, so
*"Aapne dispatch kaise plan kiya aur kitni gaadiyan thi?"* passed with one mark and two asks. It now
requires two interrogatives joined by "aur". *"Aapne dispatch aur tracking kaise manage ki?"* is
still legal — one interrogative, two objects.

#### 4.8b The card now follows the call

A plan rebuilt at placement time (`§4.7a`) used to update `call_payload_json` only. The card kept
the old numbered list, so HR saw questions the agent would not ask. Both rebuild paths
(`lib/scheduled-call.ts`, `app/api/bolna/webhook/inbound/route.ts`) now write the rendered questions
back to `generated_questions` in the same update.

### 4.9 What this looks like for the Vehicle Tracking & MIS Executive role

A real worked example, because the abstract version is easy to nod at and hard to build.

```text
TOPIC 1 — Tracking / control tower        (must-have)
Ask:  Roz kitne vehicles track karte the — ek normal shift kaisa hota tha?
Dig:  kitne vehicles · kaun sa platform · aap khud ya team · ek exception ka kya kiya
Strong: names the platform, gives vehicle count, describes an escalation they owned
Weak: "tracking karte the", no number, no platform, no incident

TOPIC 2 — MIS reporting                   (must-have)
Ask:  Roz ki MIS report kaise banate the — data kahan se aata tha?
Dig:  kaun si reports · Excel ya SQL · kitne rows/sheets · kis ko bhejte the
Strong: names the report, the source, the frequency, and one thing they improved
Weak: "Excel mein banate the", cannot name a report

TOPIC 3 — Resume claim                    (verify)
Ask:  Resume mein likha hai aapne dashboard banaya — kaun sa dashboard, kya dikhata tha?
Dig:  kis tool mein · kaun use karta tha · kya decision badla
Strong: describes the audience and a decision it changed
Weak: repeats the resume line, cannot say who used it

DEALBREAKERS (confirm)
- HMV licence: not required for this role → omit
```

Note what is *not* in there: no client name, no "Sharepal mein hum…", no GRIR/P2P/FEFO acronym, no
joining question, no company claim. Every `Ask` is under 15 words. Every `Ask` is open.

---

## 5. Question rules — and how we enforce them

Your rules, turned into a validator that runs on every generated plan. The prompt asks nicely; the
validator is the guarantee.

| Rule | Check | On failure |
|---|---|---|
| Open questions only | `ask` must not match `/^(kya aapne kabhi\|kya aap .*comfortable\|idea hai\|aapko .*aata hai)/i` | reject + regenerate |
| Banned topics | no `joining`, `notice`, `kab tak join`, `salary`, `ctc`, `relocat`, `kitne saal` | reject |
| ≤ 15 words | `ask.trim().split(/\s+/).length <= 15` | reject |
| One ask per question | at most one `?`, and no ` aur … bhi ` stacking pattern | reject |
| No client names | none of `job.client_name`, `client.name`, or known client list appears in `ask` | strip + reject |
| No company claims | no `humare`, `hamare`, `hum … mein` inside `ask` | reject |
| No jargon unless in resume | acronym list (`GRIR`, `P2P`, `FEFO`, `WMS`, `TMS`, `SAP`, `3PL`, …) allowed only if present in `resume_text` | reject |
| Easy → hard | topic order must start with the highest `scale` clue, not the resume claim | reorder |
| Strong/weak present | both non-empty, and `weak` not a copy of `strong` | reject |
| Exactly 3 topics | 2 JD + 1 resume claim (or 3 JD if no claim) | reject |
| Dealbreakers confirm-only | `type === "confirm"`, ≤ 12 words, no "why" | reject |

Validator output is logged with the reason, so we can see which rule the model keeps breaking —
that is how we improve the prompt instead of guessing.

**Where the acronym list comes from:** a small constant, not an LLM judgement. `GRIR` in a question
is fine if the resume says GRIR; it is a dead end if it does not. The model cannot reliably tell.

---

## 6. Scoring on evidence

Today: `advance → 8`, `further_review → 6`, `not_a_fit → 2`, assigned from a band. The score says
nothing about what was said.

### 6.1 Where the fake 6/10s came from

Three separate code paths derive a score from a verdict band, and one of them had its condition
inverted:

```ts
// lib/bolna-execution.ts, before
const hasScore = typeof participant.ai_score === "number" || typeof participant.ai_recommendation === "string"
const shouldScore = hasScore || !isIncompleteCall
...
...(shouldScore ? {} : { ai_score: derivedScore, ai_recommendation: recommendation })
```

The spread writes the score when `shouldScore` is **false** — i.e. exactly when the call is
incomplete and has no score. The comment directly above it says the opposite ("never assign a
default score to an incomplete call"). So a failed, partial or cut-off call with a few lines of
transcript was labelled **6/10 · further review**, which is the card that makes HR open a
transcript of a conversation that never happened.

The same 6 could arrive from the legacy transcript webhook, which wrote `verdict.score` with no
evidence check at all.

Fixed on 18 Nov:

| Path | Before | After |
|---|---|---|
| Enrichment pass (`bolna-execution.ts`) | 6/10 on incomplete calls with no score | score only for a **completed** call with a real verdict band |
| Enrichment pass, summary | overwrote "Not enough conversation to assess" | leaves the honest line in place |
| Legacy transcript webhook | wrote any score the payload carried | skips the score below the evidence threshold, flags for review |
| Rule location | written three times, one inverted | `lib/call-scoring.ts`, one function, tested |

`deriveFallbackScore()` returns `null` for: an incomplete call, a call that already has a
score/band (never second-guess), and an unrecognised verdict. Only a completed call with a real
band gets a derived score.

### 6.2 The evidence gate

A score now requires **two substantive candidate answers (10+ words each) and 60+ candidate
words**. Below that: `ai_score = null`, `_insufficient_evidence: true`, `needs_manual_followup`,
and the transcript is kept for a human. The 87-second call in Appendix B has one substantive
answer, so it is now `not_screened` instead of a 6.

### 6.3 Production backfill, 18 Nov

The rule above was applied to existing rows, not only to new calls:

| Cards | Found | Action |
|---|---|---|
| 6/10 on thin evidence | 65 | score cleared |
| 2/10 on thin evidence | 91 | score cleared — mostly failed calls stamped "not a fit" |
| 8/10 on thin evidence | 8 | score cleared — worst of the set: shortlisted off a call that did not happen |
| 4/10 on thin evidence | 13 | score cleared |
| **Total** | **177** | `ai_score` and `ai_recommendation` → `null`, `verdict_json._insufficient_evidence: true` |

Left alone on purpose: `ai_summary` (a real note like "asked to be called back at 6 PM" is worth more
than a blank), `status`, and `needs_manual_followup`. Bands `0` and `7` were not produced by the
derivation code and are being investigated separately.

Questionnaires for rows that can still be dialled were rebuilt as well, so the card matches what the
agent will say: **616 rows** (15 active pre-call, 601 in retry states). The active ones were generated
fresh with Gemini; retry rows used the deterministic bridge/template, which is exactly what the
dialler would have built for them at call time.

Two rule bugs surfaced while generating those plans, and are now fixed:

- `"kya kya"` counted as two interrogatives, so a legitimate question (*"GST aur TDS ke liye kya kya
  tasks kiye?"*) was rejected as stacked. Detection now compares **distinct** interrogatives.
- One generated question contained a Devanagari word (`दौरान`) inside Hinglish. Non-Latin script is
  now a validation error: it changes TTS pronunciation and looks broken on the card.


New: the scorer receives the transcript **and the plan**, and returns per-topic evidence.

```json
{
  "topics": [
    {
      "id": "stock_reconciliation",
      "verdict": "strong",
      "evidence": "\"SAP mein GRN match karta tha, mahine mein 400 SKU, mismatch 2% se 0.5% pe laaya\"",
      "digs_used": ["scale", "system", "result"]
    },
    {
      "id": "dispatch_planning",
      "verdict": "mixed",
      "evidence": "\"Subah 7 baje list banate the\" — could not name a system or a late-truck decision",
      "digs_used": ["scale"]
    },
    {
      "id": "resume_team_size",
      "verdict": "weak",
      "evidence": "Repeated the resume line; could not describe one day",
      "digs_used": ["ownership"]
    }
  ],
  "dealbreakers": [{ "id": "hmv_licence", "confirmed": true, "evidence": "\"Haan, HMV hai\"" }],
  "overall": { "band": "further_review", "score": 6, "why": "One strong topic, one mixed, one unverified claim" },
  "client_report": {
    "headline": "Solid reconciliation experience, dispatch depth unproven",
    "strengths": ["Owned stock reconciliation end to end, with numbers"],
    "gaps": ["Could not describe daily dispatch planning in concrete terms"]
  }
}
```

Score mapping, derived from topic verdicts rather than a constant:

| Topic verdicts | Score | Band |
|---|---|---|
| 3 strong, dealbreakers pass | 9 | advance |
| 2 strong + 1 mixed | 8 | advance |
| 3 strong but a mandatory dealbreaker fails | 4 | not_a_fit |
| 1 strong + 2 mixed | 6 | further_review |
| 2 mixed + 1 weak | 5 | further_review |
| ≥ 2 weak | 3 | not_a_fit |
| < 2 topics with any evidence | null | further_review, `_insufficient_evidence: true` |

The last row already exists in code (`bolna-execution.ts:401`) and stays. A call where the candidate
said nothing still gets no score.

**The gate is now evidence, not duration.** Today it is 60 seconds and two candidate turns. An
87-second call with one real answer passed that gate (Appendix B). The replacement: if the
participant has a plan with 2+ topics, a score requires **two substantive candidate answers (10+
words each) and 60+ candidate words**. Anything less is `not_screened`, with the transcript kept for
a human. This is a proxy for "two topics with evidence" until the per-topic scorer lands, and it is
deliberately conservative: it can only remove scores, never invent them.

**Why evidence matters more than the number:** the client report is the product. "8/10" is our
opinion; "\"SAP mein 400 SKU reconcile karta tha, mismatch 2% se 0.5% pe laaya\"" is theirs to check.
When a client disputes a rejection, the evidence is the answer.

---

## 7. Bolna settings that were never applied

These are console changes, not code. They are the cheapest wins on the list.

| Setting | Before | Recommended | Why |
|---|---|---|---|
| `hangup_after_silence` | 12 s | **20 s** | 12 s cuts off a candidate who is thinking or in a noisy truck cabin. |
| "are you still there?" prompt | 7 s | **10 s** | Two sample calls show it firing right after the candidate started a thought. |
| Interruption backoff | 0 ms | **300 ms** | Agent talks over the candidate. 4.7 interruptions/call is still high. |
| `call_terminate` | 1200 s | **360 s** | A dead call could sit for 20 minutes. The plan promises 5, caps at 6 (§7.2). |
| Retry count | 0 on every call | **2** | See §9. No automatic retries are running at the provider level. |
| Model | `gemini-3.1-flash-lite-preview` | test a stronger model | Time to first word 510 → 966 ms. Cheapest quality lever we have not tried. |

**Applied on 18 Nov** (the first four, via `PUT /v2/agent/{id}` — the deprecated `PATCH`
silently ignores `tasks`, so verify with a `GET` after any change). The prompt and welcome
message were pushed from `lib/bolna.ts` in the same operation; the voice, transcriber,
voicemail detection and noise cancellation were left exactly as the dashboard had them.

Two notes for whoever touches this next:

- **`agent_config.composition_by_language` is now null.** It held the dashboard's block-editor
  copy of the prompt, which had drifted from the code prompt. `agent_prompts.task_1.system_prompt`
  is the source of truth for calls; clearing the block copy removes the chance of the two
  disagreeing. If someone edits the prompt in the dashboard again, expect that field to come back.
- **`BOLNA_MASTER_PROMPT` in code and the dashboard prompt must stay identical.** The dashboard
  wins at runtime until someone re-syncs with `POST /api/bolna/agent {force:true}`, or with the
  `PUT` above. `docs/ai-screener-prompt.md` is the human-readable copy — update all three together.

The model experiment is not applied; it needs an A/B, not a switch.

### 7.1 Prompt safeguards added after the first live call

The 11:39 call on 18 Nov (375 s, 569 candidate words, 3 of 3 topics) exposed the last
behavioural gaps. All were fixed in `lib/bolna.ts` and pushed to the agent the same day
(983 → 1153 words):

| Gap | What the call showed | Rule added |
|---|---|---|
| Closing repeated | "Dhanyavaad, goodbye" said three times, once per "thank you" | Closing line once; after it, stay silent — even for a thank-you |
| Bad line improvised | Candidate said the voice was breaking; the agent made up an apology line that happened to work | Scripted: repeat once slowly, then RESCHEDULE closing |
| Failed dealbreaker | Plan said confirm them, never said what happens on a fail | Do not argue; skip remaining topics, go to closing |
| Client name | Prompt gave `{hiring_company_name}` in context but only banned it *in questions* | Never speak it — not in a question, not in an answer; scripted reply for "kaunsi company?" |
| English closing | "If the candidate speaks English, switch" contradicted exact Hinglish closings | Closings keep the call's language |
| Name in closing | Instruction said use the name in closing; closings have no name | Name only in the welcome message |
| "kya?" / "repeat" | Agent re-asked a different question instead of the same one | Repeat the same question slowly, never a new one |

`docs/ai-screener-prompt.md`'s "Hinglish" block was a stale English prompt; it is now the
exact live text, generated from `lib/bolna.ts`. The English block got the same rules.

### 7.2 The 6-minute round: score bands, budget, and the question that should not be deferred

Four changes, all driven by the same card — Nikhil Gupta, *Sea Export Pricing Executive*.
The call ran 375 s, covered 3 of 3 topics, and came back **6/10, further review**, with
*"Schedule callback. He shows foundational knowledge relevant to the role, but the next
interviewer should verify if he can transition his procurement-focused mindset to a pure
sales/pricing-support environment."*

That sentence is the defect. HR's answer was blunt: *ask that in the call, not later.*

**a. The 6/10 was arithmetic, not judgement.** Gemini returned `good_fit`, and
`good_fit` mapped to 6. So did `possible_fit`. A completed, well-run call was
mathematically incapable of scoring 7 under that table — the verdict vocabulary has four
levels, the score had three.

| Verdict | Before | Now | Board band |
|---|---|---|---|
| `strong_fit` | 8 | **9** | advance |
| `good_fit` | 6 | **7** | further_review |
| `possible_fit` | 6 | **5** | further_review |
| `not_fit` | 2 | **2** | not_a_fit |
| bare band (`advance` / `further_review` / `not_a_fit`) | 8 / 6 / 2 | 8 / 6 / 2 | unchanged |

The table lives in `lib/call-scoring.ts` (`VERDICT_SCORES`, `scoreFromVerdict`,
`bandFromVerdict`) and is the only one: `normalizeVerdict` in `lib/bolna-execution.ts`
and the fallback summariser both call it. Before, the rule was written out three times
and the copies disagreed. Existing rows were not rewritten — a score already on a card
is a human judgement and is never second-guessed.

**b. The old budget could not fit in five minutes.** 3 topics x (1 ask + 3 digs) is
twelve questions. At the observed ~33 s per exchange that is 6.6 minutes — and the call
ran 6:15. The prompt promised five and was arithmetically unable to deliver it.

| | Before | Now |
|---|---|---|
| Target | 300 s | 300 s |
| Hard cap (`HARD_CAP_SECONDS`, `call_terminate`) | 420 s | **360 s** |
| Digs per topic | 3 | **2** (3 x 2 + 3 asks = 9 questions) |
| Prompt wording | "7 minute se zyada nahi" | "6 minute se zyada nahi" |

`renderInterviewPlan` **clamps** rather than trusts: 600+ plans already in the database
stored `hard_cap_seconds: 420` and `max_digs_per_topic: 3`, and the renderer is the one
place every plan passes through, so the current budget wins without a regeneration pass.

**c. The third topic now tests the shift, not a resume number.** `detectRoleShift(job,
candidate)` compares the domains in the JD against the domains in the candidate's current
role plus resume. When they do not overlap, the plan prompt switches topic 3 from
"verify a resume claim" to "ask for one real instance of the destination domain's work".
For this card that is procurement → freight pricing, which is exactly the verification
the enrichment had deferred.

**d. Procedure questions are rejected.** *"Ek baar export quotation se final shipment tak
ka process step-by-step bataiye"* invites a narrated walkthrough: the candidate reads out
a process, the clock runs, and no evidence of skill is produced. `checkAsk` now rejects
`step-by-step`, `end to end`, `pura/poora process`, and `process bataiye`. Plans must ask
for one real instance — what they did, at what volume, with what result. Topic 1 and 2
must test different must-haves; the old plan asked about rates twice.

**e. The deferred recommendation fields are gone.** `recommended_next_steps` and
`interview_focus_areas` were removed from the enrichment schema, the `EnrichedSummary`
type, and the results sheet. They are replaced by one honest block, **"Not confirmed on
this call"** (`not_confirmed: string[]`), whose prompt rule explicitly forbids
"next round should verify", "ask about", and "probe deeper". It is evidence of what the
call left open, not a to-do list for another interviewer. `next_round_ready` was never
displayed and is no longer produced by the prompt; the parser still accepts it because it
is part of Bolna's payload vocabulary, not ours.



---

## 8. Speed

The model changed and the agent got slower:

| Metric | Before | After |
|---|---|---|
| Median time to first word | 510 ms | 966 ms |
| Time to first audio | 262 ms | 388 ms |

Both are still acceptable for a phone call (sub-second gap reads as natural), but 966 ms plus a
300 ms interruption backoff could feel sluggish. Plan:

1. Keep the current model on the main agent for the first two weeks of the new plan, so the
   measurement is not confounded by two changes at once.
2. Stand up a **test agent** (same prompt, same plan) on a stronger model.
3. Run 30 real calls on each and compare: time to first word, interruptions, dig count per topic,
   topic coverage. Only switch if coverage improves without first-word regression past ~1.2 s.

---

## 9. Connect rate, calling windows, retries

Connect rate is the metric that moved the wrong way, and it is not a conversation-quality problem.

| Fact | Number |
|---|---|
| No-answer, before → after | 33 → 69 |
| Voicemail, after | 13 |
| Pickup 11:00–13:00 IST | 62% |
| Pickup 17:00–19:00 IST | 42% |
| Pickup outside normal hours | 35% |
| Provider `retry_count` | 0 on every call |
| Calls under 30 s | 28%, of which 16 of 23 had no candidate speech |

Rules to implement in `lib/scheduled-call.ts` / `lib/journey-watchdog.ts`:

1. **Calling window.** Place outbound calls only 10:00–19:00 IST, Monday–Saturday. Outside the
   window, set `scheduled_call_at` to the next window instead of dialling.
2. **Retry ladder.** Attempt 1 at the best window; attempt 2 same day +3 h; attempt 3 next day
   11:00–13:00. Max 3 (already enforced as `MAX_TOTAL_CALL_ATTEMPTS`).
3. **Voicemail → WhatsApp, not a third call.** If `answered_by_voice_mail` is true, send the
   WhatsApp nudge and stop dialling.
4. **Silent pickup → one retry, then WhatsApp.** Two consecutive calls with no candidate speech on
   a connected call means a screener or a dead line. A third dial is waste.
5. **Do not count provider refusals as attempts** (already true) and do not let them starve the
   queue (already fixed in `3a86fdb`).

Expected effect: connect rate back toward 55–60% without touching the agent, simply by not dialling
when people do not pick up.

---

## 10. How we will know it worked

Per call, stored (some of this needs new columns or a JSON blob):

| Metric | Source | Today |
|---|---|---|
| Topics covered (of 3) | plan + transcript | not measured |
| Digs used per topic | transcript | not measured |
| Banned question asked (Y/N) | validator regex on transcript | 16% |
| Dealbreaker confirmed | scorer | not measured |
| Real conversation length | existing | 2.52 min avg |
| Reach 4+ min | existing | 5% |
| Interruptions | provider | 4.7 |
| Time to first word | provider | 966 ms |
| Score, with evidence | new scorer | 8/6/2 constants |
| Connect rate | existing | 45% |

**Transcript timestamps are a gap.** `call_transcripts` stores `speaker` and `text` only, so talk
ratio and per-topic duration cannot be computed from our DB. If Bolna's raw transcript carries
timestamps, store the raw segment list as `jsonb` alongside the flattened text. If it does not, we
measure coverage and dig counts from the text and accept that timing stays provider-side.

**Success criteria for the first two weeks of the new plan:**

- Topics covered: median 3 of 3 (today: not measured; expect ~2 at first).
- Real conversations reaching 4+ min: 20%+ (from 5%).
- Banned question: under 3% (from 16%).
- Median real conversation: 3.5–5 min (from 2.48).
- No regression: `synthesizer_error` stays under 2%, clean close stays above 80%.

---

## 11. Rollout

| Phase | What ships | Status | Gate |
|---|---|---|---|
| **0 — Console** | 20 s silence, 10 s still-there, 300 ms backoff, 7-minute terminate | **done 18 Nov** | read back with `GET /v2/agent/{id}` |
| **1 — Plan** | `lib/interview-plan.ts`, renderer, validator, `{interview_plan}` in prompt, template fallback, payload assertion | **shipped 18 Nov**, no per-job flag | first 20 calls: topics covered, digs used, banned-question rate |
| **2 — Scoring** | evidence gate (shipped); per-topic verdicts and client report skeleton | gate shipped, evidence report pending | 20 scored calls reviewed by HR |
| **3 — Timing** | calling window, retry ladder, voicemail/silent-pickup rules | not started | one week of connect-rate data |
| **4 — Measure** | two-week comparison on the same rules | not started | success criteria above |

Phase 1 shipped without the per-job flag I first proposed. Two reasons: a template plan or a bridged
plan is now guaranteed before every dial (§4.7a), so there is no call shape that lacks a plan to fall
back to; and a flag would have left half the queue on the old five-question path, which is the thing
we are measuring away from.

Rollback is still a prompt edit, not a deploy: every payload carries both `interview_plan` and the
legacy numbered `questions`, so pasting the previous prompt back works immediately.

Manual question editing now saves: `PATCH /api/phone-screening/participants/{id}` rebuilds the plan from
the edited text and returns what it stored (§4.8a). Editing during a live call applies to the next
attempt, and a question that breaks the rules is refused with a reason rather than silently replaced.


---

## 12. Open decisions

| # | Decision | Recommendation | Owner |
|---|---|---|---|
| 1 | 4–6 min target? | Yes for real conversations; promise 5 min, hard cap 7 | You |
| 2 | Topic count | 3 (2 JD + 1 resume claim) | You |
| 3 | Dealbreaker placement | End, confirm-only | You |
| 4 | Client names in questions | Banned everywhere, including manual edits | You |
| 5 | Calling window | 10:00–19:00 IST, best 11:00–13:00 | Ops |
| 6 | Model switch | Test agent first, decide on coverage vs latency | You |
| 7 | Client report timing | Same day after scoring, phase 2 | You |
| 8 | Plan regeneration on retry | Never — reuse the stored plan | Engineering |

---

## 13. File map

| File | Role in this plan |
|---|---|
| `lib/jd-questions.ts` | Thin delegate: keeps `JobContext` / `CandidateContext`, `generateJDQuestions` now returns the plan, `NEVER_ASK` extended, fallback rebuilt from the template |
| `lib/interview-plan.ts` (new) | Types, generator (Gemini + retry + template), validator, renderer, template plan, bridge for old questions, `toBolnaUserData` |
| `lib/call-orchestrator.ts:599` | `buildCallUserData` — adds `interview_plan` + `_interview_plan`, keeps `questions`; `buildJobGist` no longer returns "A full_time role" |
| `lib/scheduled-call.ts:511` | Placement: merges `info_data`, asserts a plan exists (bridged or template), persists it, strips `_interview_plan` before sending |
| `app/api/bolna/webhook/inbound/route.ts:154` | Same assertion for inbound callbacks |
| `app/api/bolna/agent/route.ts:80` | `POST {force:true}` re-syncs prompt + welcome + tuning from code |
| `lib/bolna.ts:361` | `BOLNA_MASTER_PROMPT` — `{interview_plan}`, 2 digs, one timing number; `BOLNA_WELCOME_MESSAGE` — 5 minutes |
| `docs/ai-screener-prompt.md` | Mirror of the live prompt; must be updated in the same commit |
| `lib/bolna-execution.ts:960` | Evidence scorer; replace band constants at `:1004` and `:389` |
| `lib/journey-watchdog.ts` | Calling window + retry ladder |
| `components/candidate-profile-sidebar.tsx:407` | Plan / Text editor tabs, `manual_override` |
| `components/phone-screening-results-sheet.tsx:1620` | Show topics + evidence instead of a flat question list |
| `docs/job-intake-and-screening-criteria copy.md` | Source of the Screening Brief shape; the plan object should stay compatible with it |

---

## Appendix — what we are deliberately not doing

- **Not adding more questions.** Five flat questions became three topics with digs. The count went
  down; the depth went up.
- **Not chasing minutes.** A call that covers 3 topics in 3.5 minutes is a good call. A call padded
  to 6 minutes is a waste of the candidate's time and ours.
- **Not sending JSON to Bolna.** Structured in the DB, prose in the prompt.
- **Not trusting the prompt to enforce rules.** The validator enforces; the prompt asks.
- **Not regenerating the plan on retry.** Same candidate, same questions, comparable attempts.
- **Not asking the joining question.** Ever. Not in the plan, not in the fallback, not as a
  "confirm".

---

## Appendix B — live call review, 18 Nov 2026

The call that started this plan. Reviewed from the provider's transcript and recording metadata.

| | |
|---|---|
| Candidate | Yogendra Kumar — HR Manager, 13 yrs, Rareplanet |
| Role | HR Manager, Swift Road Link Pvt Ltd |
| Time | 18 Nov, 14:59 IST |
| Duration | 87 s (23 s ring → 64 s of talk) |
| Ended by | Candidate hung up |
| Questions asked | 3 · follow-ups: **0** |

### Transcript

```text
AI:   Hello Yogendra Kumar ji... Do minute baat ho sakti hai kya?
Cand: bill close hoti hai sir
AI:   ...HR Manager role ke liye apply kiya tha... teen-chaar minute lagenge.
      Labour laws aur statutory compliance aapke liye daily routine ka part raha hai,
      toh kya aapne PF, ESIC ya CLRA ke audits handle karte waqt kabhi koi
      critical issue face kiya hai?
Cand: Nahin, kabhi nahin kiya maine
Cand: Haan, jab compliance poore nahi hote... hum audit mein batate hain ki
      compliance poore karne hain
AI:   Achha. Payroll ke liye GreytHR ya Keka use kiya hai, kya aap end-to-end
      payroll calculate karke full & final settlement khud handle kar sakte hain?
Cand: Main khud handle karta hoon
AI:   Theek hai. Hamari shift day-time ki hai, toh kya aap full-time office-based
      role ke liye comfortable hain?
Cand: Yes bilkul comfortable hoon sir
AI:   [closing]
```

### What it established

| Competency the client asked about | Assessed? |
|---|---|
| PF / ESIC / labour law end to end | No — one yes/no, "never" accepted without a probe |
| Payroll + F&F ownership | Claim only — five words, no scale, no system, no example |
| Team handling | Never asked |
| Employee management / IR | Never asked |
| End-to-end HR management | Never asked |

### Rule violations in the sent questions

| Question as spoken | Words | Broken |
|---|---|---|
| "Labour laws… **toh kya aapne** PF, ESIC ya **CLRA**… **kabhi** koi critical issue face kiya hai?" | 27 | `kya aapne kabhi`, double ask, 15-word limit, acronym not in resume, closed yes/no |
| "…GreytHR ya Keka **use kiya hai**, kya aap end-to-end payroll… **kar sakte hain**?" | 22 | leading claim, two asks, capability question, word limit |
| "…**comfortable hain aur aap kab tak join kar sakte hain**?" | 19 | `comfortable hain`, **joining question**, two asks |

All three came from the generator, and the agent read them verbatim. The generator prompt
(`jd-questions.ts:194`) asks for the joining confirm, so the prompt cannot filter it — which is why
the validator exists.

### Why 87 seconds

Three questions, zero digs, and two answers that end conversations ("never faced an issue",
"main khud karta hoon"). The same three questions on the same role ran **204 s** with a candidate
who talked. Length is candidate-driven; depth is plan-driven.

### What the plan sends for this role

```text
TOPIC 1 — Statutory compliance, end to end          [must-have]
Ask:  PF aur ESIC ka pura kaam aap khud dekhte the — ek mahine ka process bataiye?
Dig:  kaun si filings (ECR, challan) · kitne employees · audit aaya to kya hua · consultant tha ya aap
Strong: names ECR/challan/returns, gives headcount, describes an inspection they handled
Weak:   "compliance team dekhti thi", no filing name, no count

TOPIC 2 — Team handling                             [must-have]
Ask:  Aapke under kitne log the — unka daily kaam kaise check karte the?
Dig:  kitne log aur kaun kaun · review kaise · ek underperformer ka case · attrition kitna
Strong: names team size and roles, a review rhythm, one person they fixed or exited
Weak:   "team handle karti thi", no size, no example

TOPIC 3 — Employee management / IR                  [resume claim]
Ask:  Resume mein end-to-end HR likha hai — ek employee dispute ka example bataiye jo aapne khud handle kiya?
Dig:  kya dispute · kaun involved · aapne kya kiya · result kya nikla
Strong: a real case, their own action, an outcome
Weak:   "sab handle karte the", no case
```

Estimated 3 asks + 6 digs + 9 answers ≈ 4.5–5.5 minutes.

The moment the call was lost — "*Nahin, kabhi nahin kiya maine*" — becomes three digs
("Kabhi audit hi nahi aaya?" → "Consultant karta tha ya aap?" → "Ek baar documents mange gaye honge
— kaun se?"), then a recorded weak signal if there is still nothing.

### Three side findings from the same day

1. **The agent did not know the job.** `job_gist` was `"A full_time  role"` — `buildJobGist()`
   falls back to employment type + work type when the job has no summary and no responsibilities.
   Fixed by role-family defaults in the template plan.
2. **A client name leaked into a question** on another HR call: *"Swift Road Link mein humein
   blue-collar workforce ko handle karna hota hai, toh aapne…"*. The validator now rejects any
   ask containing the client name.
3. **Retries went out without a payload.** Yogendra: 14:59 (87 s, had questions) then 15:16
   (165 s, no `questions`, greeting said "logistics role"). Sukhsohan: 15:16 then 15:27. Both
   second calls used the `scheduled-call.ts` empty-payload fallback. A payload assertion now
   rebuilds a template plan before dialling.
