# Job Intake, AI JD & Client Screening Criteria — What We're Building

*Plain-language plan for the team. Read time: about 12 minutes.*
*Sits on top of the Employer / Partners Portal (employer.gatihire.com). Status: **plan, not built**.*

---

## 1. The short version

Today a client tells us about an opening by call, email or WhatsApp, we type it into admin, and the
AI screening call asks **questions we guessed** from the JD. The client never told us what actually
matters to them, so the call often checks the wrong things.

The new flow, all inside the employer portal, works like this.

1. **The client creates the job themselves with AI.** They enter the basics, and they can paste or
   upload their **existing JD as reference**. Our AI (Gemini with Google Search) writes a **strong,
   market-aware JD**. The client edits it until they are happy.
2. **The AI suggests screening pointers** from that JD: "what matters most for this opening". The
   client **ranks, edits or adds** pointers and marks dealbreakers.
3. **The client submits to us.** Our team reviews it with that client's full hiring history alongside,
   then puts it live as a job opening and **starts sourcing on exactly these requirements**.
4. **The client follows it on their portal**: status, sourcing progress, screened and shared
   candidates.

The JD plus pointers become one **Screening Brief** per job. It drives sourcing and filtering, the
AI screening call, and the report the client sees. So every call is run from the client's point of
view.

```
CLIENT (employer portal)                                  GATIHIRE (admin)
───────────────────────────────────────────────           ───────────────────────────
Basics + existing JD (optional reference)
        │
        ▼
AI writes JD  (Gemini + Google Search)  ◄─ edit / regenerate
        │
        ▼
AI suggests pointers ─► client ranks / edits / adds
        │
        ▼
[ Submit to GatiHire ] ───────────────────────────────►  Review (with client history)
                                                          approve / ask client / merge / decline
                                                                  │
Portal shows: Under review → Live → Sourcing  ◄────────── Job opening live → sourcing,
              → Screening → Candidates shared                     calling, shortlisting
```

---

## 2. Why we're doing this

What one month of real calls showed (Oct 10 – Nov 12, 629 calls, 248 real conversations, 3,132
generated questions):

| What we found | Why it hurts with clients |
|---|---|
| 40% of generated questions are yes/no ("kya aapne kabhi…", "comfortable hain?") or joining-date questions | The client hears an interview that sounds like a form |
| Yes/no questions got a median **8 words** back; open "kaise / ek example" questions got **22** | Too little evidence to judge anyone |
| In 79% of completed calls the agent asked only the planned list, with **no follow-ups** | Nothing is verified; anyone can say "haan" |
| Completed calls average **2.8 minutes, about 32 seconds per question** | Too shallow for a client to rely on |
| 133 of 147 verdicts had **empty strengths and concerns**; scores are only 8, 6 or 2 | The report a client would see is blank |
| Questions come from the JD alone, **with no client input** | We screen for *our* guess of the role, not the client's |

A better JD also means **better filtering**. Sharper must-haves and pointers make matching, sourcing
searches and shortlisting more precise before any call is placed.

---

## 3. Who does what

| Who | Where | What they do in this flow |
|---|---|---|
| **Client contact** (hiring manager / HR) | employer.gatihire.com | Creates the job with AI, edits the JD, sets screening pointers, submits, follows progress |
| **Account manager / Admin** | admin.gatihire.com | Reviews submissions with client history, approves / asks / merges / declines, puts the job live |
| **Sourcing team / HR** | admin.gatihire.com | Sources and shortlists against the client's pointers and dealbreakers |
| **AI screening call** (Bolna) | automatic | Asks about the client's top priorities, probes, checks dealbreakers |

---

## 4. The journey, step by step

### Step 1 — Client starts a new opening (employer portal)

**[ + New opening ]** opens a short, mobile-friendly form, about 2 minutes.

| Field | Required | Notes |
|---|---|---|
| Role title | ✅ | Free text with suggestions ("Fleet Manager", "Warehouse Supervisor"…) |
| Location(s) | ✅ | One or more cities; on-site / hybrid |
| Number of positions | ✅ | |
| Experience range | ✅ | Min to max years |
| Budget / CTC range | ✅ | Never shown to candidates as the client's exact budget |
| Urgency | ✅ | Immediate / within 30 days / within 60 days |
| **"Describe the role in your words"** | ✅ | What this person will do, team size, what a good hire looks like. The richest input |
| **Existing JD** | optional | Paste text or upload PDF/DOCX. Used as **reference** to produce a better, optimised JD |
| Reporting to / team they manage | optional | |
| Why is this role open? | optional | New role, replacement, expansion |
| Anything that must NOT be compromised | optional | Seeds the dealbreakers in Step 3 |

Two ways in:

- **"I have a JD."** The client pastes or uploads it. The AI uses it as the base and improves it
  (structure, clarity, missing must-haves, realistic experience vs budget). It never drops the
  client's real requirements.
- **"Write one for me."** The AI writes from the form and their "in your words" text.

Drafts auto-save, so the client can leave and come back.

### Step 2 — AI writes the JD (on the portal itself)

On **[ Generate JD ]**, the AI produces a full JD in about 20–40 seconds, with a progress state
("Researching the role in your market… Writing…").

**Model:** our best Gemini model (Pro class, configurable via env) with **Google Search grounding**
switched on. Web search is used for:

| Searched for | Used to |
|---|---|
| The client's own website / public company info | Write an accurate "About the company" section in their voice |
| Comparable JDs for this title in this city and industry | Get real responsibilities, tools and terms right (e.g. TMS/WMS names, licence classes) |
| Market salary and experience norms for the role and city | **Warn** the client if budget and experience don't match ("Most Fleet Managers with 8+ years in Delhi expect ₹9–14L; your budget is ₹6L") |
| Current titles candidates actually search for | Suggest a clearer title if needed ("Fleet Operations Manager" vs "Transport In-charge") |

**What makes the JD "very good"** (the generator must meet all of these; enforced in the prompt and
checked before showing):

- **Specific, not generic.** Responsibilities with scale ("manage 50+ trucks across 3 lanes"), not
  "manage fleet efficiently". No filler ("dynamic, fast-paced, go-getter").
- **Clear must-have vs good-to-have**, kept short: at most 5 must-haves.
- **Realistic.** Experience, budget and must-haves are consistent with each other, or flagged.
- **A day in the role** (`daily_work_summary`). Candidates and our calls both use it.
- **Candidate-friendly.** Short sections, bullets, no internal jargon. Written so the right people
  apply and the wrong people self-filter.
- **Nothing discriminatory.** No age, gender, religion, caste, marital status or "only from X
  region" requirements. Removed with a note to the client.
- **Grounded.** Company facts come from the client's input or cited search results. The AI does not
  invent benefits, client names, numbers or perks; it leaves a `[confirm]` marker instead.

**The output is a readable JD plus structured fields** that our system already uses downstream:
`skills_must_have`, `skills_good_to_have`, `key_responsibilities`, `daily_work_summary`,
`experience_min/max`, `salary range`, `education_min`, `license_type`, `shift_type`,
`languages_required`, `employment_type`, `work_type`.

```
 ┌─ Fleet Operations Manager · Delhi NCR · 2 positions ───────────────┐
 │  ⚠ Budget ₹6–8L is below market for 8+ yrs (₹9–14L). [Adjust] [Keep]│
 │                                                                    │
 │  About Acme Logistics          [ ✎ Edit ] [ ↻ Rewrite this section ]│
 │  The role                      [ ✎ Edit ] [ ↻ ]                     │
 │  What you'll do (6)            [ ✎ Edit ] [ ↻ ]                     │
 │  Must-have (4)  · Good-to-have (3)                                  │
 │  A day in this role                                                 │
 │  What we offer   [confirm: PF? insurance?]                          │
 │                                                                    │
 │  Tone: [ Standard ▾ ]  Language: [ English ▾ ]                      │
 │  [ ↻ Regenerate all ]                       [ Next: screening → ]   │
 └────────────────────────────────────────────────────────────────────┘
```

- The client can edit any section inline, **rewrite one section** with an instruction ("make it
  shorter", "add SAP experience"), or regenerate everything.
- Market warnings are advisory. The client can keep their numbers, and we see that they did.
- **Limits:** a maximum number of generations per opening per day, to control cost and abuse.

### Step 3 — Screening pointers: "What matters most for this opening?"

Right after the JD, the AI suggests **6–10 pointers** from the JD and the client's "in your words"
text. The client shapes them.

```
 ┌─ What matters most for this opening? ─────────────────────────────┐
 │  Drag to rank. Your top 3 decide what we check on every call.      │
 │                                                                    │
 │  ≡ 1  Has run a fleet of 50+ trucks day to day     ★ Top   [✎] [🗑] │
 │  ≡ 2  Handles drivers directly (hiring, discipline) ★ Top  [✎] [🗑] │
 │  ≡ 3  Uses GPS / tracking data to cut downtime      ★ Top  [✎] [🗑] │
 │  ≡ 4  Vendor and workshop coordination for breakdowns       [✎] [🗑] │
 │  ≡ 5  MIS reporting in Excel                                [✎] [🗑] │
 │  ≡ 6  Fuel cost control                                     [✎] [🗑] │
 │  + Add your own pointer                                             │
 │                                                                    │
 │  MUST-HAVE (dealbreakers) — we won't share a candidate without these│
 │  ☑ Hindi speaking   ☑ Based in / can move to Delhi NCR   + Add      │
 │                                                                    │
 │  "What would make you say NO to a candidate?"  [ free text ]        │
 │                                                                    │
 │  [ ← Back to JD ]                      [ Review & submit → ]        │
 └────────────────────────────────────────────────────────────────────┘
```

Rules for pointers (suggested or typed by the client):

- Each pointer is **something a person has done**, checkable by asking about real work ("has run
  50+ trucks"), never a trait ("good leader"). If a client types a trait, the AI offers a checkable
  rewrite.
- A **maximum of 3 Top** priorities. One call can cover 3 topics properly, not more.
- **Dealbreakers** are yes/no facts (licence, language, location, shift, minimum experience). They
  are used for **filtering** and WhatsApp checks, not as interview topics.
- **Blocked:** age, gender, religion, caste, marital status, pregnancy and similar. The portal says:
  *"We can't screen on this. Tell us about the skills or experience you need instead."*

### Step 4 — Review & submit

One summary screen: JD, Top 3, other pointers, dealbreakers, budget, positions, urgency.
**[ Submit to GatiHire ]**.

The client sees: *"Submitted. Our team will review it and confirm, usually within 1 working day."*
The opening shows as **Under review** on their portal home. The client can still **withdraw** it, or
**edit** it until we start the review.

> A submitted opening is **not live yet**. It doesn't reach the talent board, matching, outreach or
> calling until our team approves it.

### Step 5 — Our team reviews (admin.gatihire.com)

A **Job Requests** inbox. Each submission opens next to **that client's full hiring history**.

```
 ┌─ Acme Logistics · Fleet Operations Manager · Delhi NCR · 2 positions ───────┐
 │  Submitted by Sunil (Ops Head) · 12 Nov 10:42 · Urgency: Immediate            │
 │  JD: AI-generated from client's JD (v3) · Kept budget despite market warning ⚠│
 │  Top 3: 50+ trucks · drivers directly · GPS data   Dealbreakers: Hindi, NCR   │
 │                                                                               │
 │  THIS CLIENT'S POSITIONS (all time)                                           │
 │  Fleet Manager · Delhi        Closed · filled 3 Sep · 4 shared, 1 hired       │
 │  Fleet Manager · Gurgaon      Open   · 6 shared · 2 interview   ⚠ similar     │
 │  Warehouse Supervisor · Pune  Open   · 3 shared · 0 decided                   │
 │  Top client reject reasons: salary expectation (5), experience gap (3)        │
 │                                                                               │
 │  [ Approve & go live ]  [ Edit, then approve ]  [ Ask client ]                │
 │  [ Merge into existing opening ]  [ Decline (with reason) ]                   │
 └───────────────────────────────────────────────────────────────────────────────┘
```

What the reviewer checks:

- **Duplicate or overlap** with an open role → merge, or add positions to it.
- **Feasibility.** Budget vs experience vs market (especially if the client kept a warned budget),
  and past reject reasons for this client.
- **JD and pointer quality.** Pointers are checkable, Top 3 make sense, dealbreakers aren't too
  narrow to source against.
- **Fit for us and commercials.** Can we deliver this role? Is the agreement active?

If the reviewer edits the JD or pointers, the client sees exactly what changed ("GatiHire updated:
experience 8+ → 6+, reason: …").

Statuses: `draft → submitted → in_review → (needs_client_info) → approved → live → sourcing →
screening → shortlist_shared → closed`, plus side exits `merged`, `declined`, `withdrawn`.
Unreviewed submissions older than 1 working day show in the admin **Today** list.

### Step 6 — Live, and sourcing starts on the client's requirements

On approve, the job opening is created in our system with the JD, structured fields and the
**Screening Brief** (below). Sourcing uses them directly:

| Our process | What it uses from the client's input |
|---|---|
| Matching / filtering our database | Must-haves, dealbreakers, experience, location |
| Outbound sourcing searches (job portals, Juicebox, etc.) | Title variants, must-have skills, Top 3 pointers as keywords |
| WhatsApp info collection | Dealbreakers (licence, location, shift) checked before any call |
| AI screening call | Top 3 priorities as call topics (Step 7) |
| HR shortlist remark ("why this candidate") | Refers to the client's priorities |

**The client sees progress on their portal** for each opening:

```
 Fleet Operations Manager · Delhi NCR                         Live since 13 Nov
 ──────────────────────────────────────────────────────────────────────────
 Sourced 120 → Matched 46 → Screened by call 18 → Shortlisted 5 → Shared 3
 Last update: 2 new candidates shared today            [ Review candidates ]
```

These are counts only, no profiles, until candidates are shared (Partners Portal flow).

### Step 7 — The Screening Brief and how the AI call uses it

Everything from Steps 2–5 is saved as one **Screening Brief** per job: the single source the calling
system reads.

```json
{
  "job_id": "…",
  "version": 2,
  "set_by": "client",                 // client | admin
  "role_context": "Acme runs 120 trucks on Delhi–Jaipur–Ahmedabad lanes; reports to Ops Head; manages 2 supervisors.",
  "priorities": [
    {
      "rank": 1,
      "pointer": "Has run a fleet of 50+ trucks day to day",
      "client_words": "needs to run 50+ trucks without me chasing",
      "opening_question": "Abhi aapke under kitni gaadiyan chalti hain, aur ek normal din kaise plan karte ho?",
      "probes": ["scale: kitne trucks / routes?", "own role vs team?", "ek bura din — kya hua, kya kiya?"],
      "strong_signal": "Gives fleet size, names routes, describes own daily decisions",
      "weak_signal": "Only general talk, or 'supervisor karta tha'"
    },
    { "rank": 2, "...": "..." },
    { "rank": 3, "...": "..." }
  ],
  "also_check": ["Vendor coordination for breakdowns", "MIS in Excel"],
  "dealbreakers": [
    { "label": "Hindi speaking", "check": "call_language" },
    { "label": "Based in / can move to Delhi NCR", "check": "whatsapp_info.location" }
  ],
  "client_no_text": "Candidates who only managed contract fleets and never handled drivers",
  "never_ask": ["CTC", "notice period", "joining date", "anything already collected on WhatsApp"]
}
```

The opening questions, probes and signals are **generated by us when the job is approved** (not
shown to the client by default). They are fixed per job, so every candidate is asked the same core
questions and can be compared. At call time we add **one line from the candidate's resume** to
verify inside the relevant topic.

| Today | With the Screening Brief |
|---|---|
| 5 flat questions guessed from the JD, regenerated per candidate | **3 topics = the client's Top 3**, in their order, same for every candidate |
| 40% yes/no or joining questions | Open questions only; CTC, notice and joining never asked (they come from WhatsApp) |
| No follow-ups | 1–2 probes per topic: scale → own role → real example → outcome |
| About 2.8 minutes | **5–7 minutes, hard stop at 8**; no new topic after 6:30 |
| First question is the hardest | Warm-up first: "Abhi aapka din bhar ka kaam kya rehta hai?" |

**Call shape (about 6 minutes):**

```
0:00–0:30  Greeting, permission, why we're calling (client named only if allowed)
0:30–1:15  Warm-up: current day-to-day work
1:15–5:15  Priority 1 → 2 → 3   (opening question + 1–2 probes each, ~80 s)
5:15–6:00  Candidate's questions → close
           Clear mismatch (e.g. fresher for a lead role) → polite close at 2–3 min
```

### Step 8 — The client's report, by their own priorities

On the Partners Portal review screen, the AI screening card is organised by **the client's Top 3**:

```
 ┌─ AI screening · against YOUR priorities ─────────────────────┐
 │  1. Runs 50+ trucks          ●●●○  Strong                     │
 │     "Abhi 64 gaadiyan, Jaipur aur Ahmedabad lane…"  ▶ 01:42   │
 │  2. Handles drivers directly ●●○○  Partial                    │
 │     Hires via contractor; handles discipline himself ▶ 03:10  │
 │  3. GPS data for downtime    ●○○○  Weak                       │
 │     Uses Fleetx only for location, not reports      ▶ 04:25   │
 │  Dealbreakers: Hindi ✔  Delhi NCR ✔                           │
 │  [ ▶ Full recording ]  [ Transcript ]                         │
 └───────────────────────────────────────────────────────────────┘
```

- Every rating has **a quote and a timestamp**. If a topic wasn't covered, the card says
  "Not covered in call", never a guess.
- This replaces today's 8/6/2 score.
- **Feedback loop:** client reject reasons are compared with the priority ratings. A candidate
  "rejected for skill gap on #3 while we rated #3 Strong" tells us to tighten the brief or the
  scoring.

---

## 5. Existing jobs and admin-created jobs

- Jobs created by our team (clients who don't use the portal) follow the same rule: **no screening
  calls until the job has a Screening Brief**. Admin can use the same AI JD and pointer screens in
  admin. The brief is marked "set by GatiHire", and the client can review it on the portal.
- For jobs already live, admin creates the brief from the current JD before the next call batch.

---

## 6. What we'll build (tech outline)

| Piece | What | Builds on |
|---|---|---|
| Portal: New opening flow | Form → JD editor → pointers → review & submit, autosave drafts | Employer portal |
| JD generation API (portal) | Gemini (Pro class, env-configurable) with **Google Search grounding**; existing JD as reference; returns JD + structured fields + market warnings + sources | Refactor of `/api/generate-jd` / `components/jd-generator.tsx` into a shared service |
| JD quality checks | Generic-phrase filter, must-have cap, consistency check (experience × budget), discriminatory-term filter, `[confirm]` markers | New |
| Pointer suggestion API | Confirmed JD + client words → 6–10 checkable pointers; trait-to-checkable rewrite; blocked-criteria filter | New |
| `job_requests` | Submission, status history, `client_id`, `submitted_by`, JD versions, reviewer edits with reasons | New table |
| Admin **Job Requests** inbox | Queue, client history panel, approve / edit / ask / merge / decline | `jobs`, `clients`, Partners decisions data |
| `screening_brief` | Versioned JSON per job (shape above); opening questions, probes and signals generated on approval | New |
| Sourcing hookup | Must-haves and dealbreakers into matching filters and sourcing keywords | Matching, Juicebox flow, WhatsApp info steps |
| Call payload | Replace `{questions}` with `{client_priorities}` + `{resume_claim}`; stop per-candidate question generation | `lib/jd-questions.ts`, `lib/call-orchestrator.ts`, `lib/bolna.ts` |
| Guard | No call placed if the job has no Screening Brief | `lib/call-orchestrator.ts` |
| Scoring | Per-priority rating + quote + timestamp using the brief's strong/weak signals | `lib/bolna-execution.ts` |
| Portal progress + report | Funnel counts per opening; priority-wise screening card | Partners Portal |
| Limits & logs | Generations per opening/day; log prompts, sources and outputs per version | New |

---

## 7. Edge cases

| Situation | What happens |
|---|---|
| Client pastes a poor or very long JD | AI keeps the real requirements, restructures, and lists what it changed |
| Client keeps an unrealistic budget after the warning | Allowed. Flagged to the reviewer, who may *ask client* before going live |
| Client submits the same role twice | Reviewer sees the overlap and merges, or adds positions |
| Client skips pointers | Can't submit without a Top 3. The AI pre-ranks them, so one tap accepts |
| Client edits after submit | Allowed until the review starts; after that through *ask client* / a new version |
| Client changes priorities while live | New brief version; earlier candidates keep their scores labelled with the old version; admin can re-call the strongest |
| Bulk / blue-collar roles (drivers, loaders) | Shorter flow: 2 Top priorities, dealbreakers (licence, route, shift), about a 4-minute call |
| Confidential role | `client_visible: false`; the JD and call say "a leading logistics company" |
| Discriminatory requirement | Blocked in the JD and pointers, with an explanation; repeated attempts alert the account manager |
| Search grounding fails or times out | JD is generated without search; market warnings are hidden, never guessed |

---

## 8. Rollout

| Phase | What | Visible result |
|---|---|---|
| **0. Call fixes (no client change)** | Re-sync the Bolna agent (hangup lines, first-name welcome), stronger LLM for live calls, open-only question rules, remove the joining question, follow-up rules | Better calls on current jobs |
| **1. Screening Brief in admin** | Brief for every live job; call uses the brief; per-priority scoring | Calls and reports organised by priorities |
| **2. AI JD in the portal** | New opening flow: form, existing-JD reference, Gemini + search JD, editor, quality checks | Clients create strong JDs themselves |
| **3. Pointers + submit + review queue** | Pointer screen, submit, admin Job Requests inbox with client history | Nothing live without review; briefs come from the client |
| **4. Live progress on the portal** | Funnel counts per opening, status updates by email and WhatsApp | Client sees sourcing happening |
| **5. Priority-wise report + feedback loop** | Screening card with quotes and timestamps; reject reasons vs priorities | Client sees calls in their own terms |

Phases 0–1 fix most of what the call analysis found and don't need the portal. Pilot phases 2–5
with the same two Partners pilot clients.

---

## 9. How we'll know it's working

- At least 80% of new openings are **created by clients in the portal** with an AI JD.
- Every live job has a Screening Brief; **0 calls** placed without one.
- Review turnaround **≤ 1 working day**.
- Median candidate answer at **20+ words**; at least 1 follow-up per topic in most calls.
- Completed calls at **5–7 minutes**, with mid-interview hang-ups not rising.
- Every rating in a report has a quote; **0 blank** strengths/concerns.
- Client "interview" rate on shared candidates goes up; rejects for "skill gap" go down.

---

## 10. Open questions

1. **Portal domain:** the Partners doc names both `employer.gatihire.com` and `partners.gatihire.com`.
   Which is final?
2. **Which Gemini model** for JD generation (cost per JD vs quality), and the daily generation limit
   per client?
3. **Top priorities cap:** 3 for all roles, 2 for blue-collar?
4. **Client name on calls and JDs:** named by default, or confidential by default?
5. **Funnel visibility:** do clients see "Sourced / Matched" counts, or only from "Screened"
   onwards?
6. **Should the client see the call questions and probes** generated from their pointers, or only the
   pointers?
7. **Voice-note input** for "describe the role in your words": v1 or later?
