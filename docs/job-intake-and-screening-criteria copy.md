# Job Intake & Client Screening Criteria — What We're Building

*Plain-language plan for the team. Read time: about 12 minutes.*
*Sits on top of the Employer / Partners Portal (employer.gatihire.com). Status: **plan, not built**.*

---

## 1. The short version

Today a client tells us about an opening (call, email, WhatsApp), we type it into admin, and the AI
screening call asks **questions we guessed** from the JD. The client never told us what actually
matters to them, so the call often checks the wrong things, and the client sees a screening that
doesn't sound like *their* interview.

We're adding three things to the employer portal:

1. **Clients request openings in the portal.** A request does **not** go live. It lands in an
   **admin review queue**, shown next to everything that client has opened before.
2. **We generate the JD with them.** After we approve the request, we build the JD with our AI JD
   generator, using **the client's own input**, and the client confirms it.
3. **The client tells us what matters most.** From the JD we suggest **screening pointers**; the client
   **ranks** them, marks dealbreakers and adds their own. This becomes one **Screening Brief** per job.

The Screening Brief is the **only** thing the AI call uses to decide what to ask. Every call is then
run from the client's point of view, and the client's report is organised by **their** criteria.

```
Client request ─► Admin review ─► AI JD (client input) ─► Client confirms JD
                                                              │
                                                              ▼
                     Screening Brief ◄── Client ranks "what matters most"
                           │
          ┌────────────────┼──────────────────────┐
          ▼                ▼                      ▼
   AI call topics    Scoring rubric      Client report, by criterion
```

---

## 2. Why we're doing this

What one month of real calls showed (Oct 10 – Nov 12, 629 calls, 248 real conversations, 3,132
generated questions; full analysis in our call review):

| What we found | Why it hurts with clients |
|---|---|
| 40% of generated questions are yes/no ("kya aapne kabhi…", "comfortable hain?") or joining-date questions | The client hears an interview that sounds like a form |
| Yes/no questions got a median **8 words** back; open "kaise / ek example" questions got **22** | Too little evidence to judge anyone |
| In 79% of completed calls the agent asked only the planned list, with **no follow-ups** | Nothing is verified; anyone can say "haan" |
| Completed calls average **2.8 minutes and about 32 seconds per question** | Too shallow for a client to rely on |
| 133 of 147 verdicts had **empty strengths and concerns**; scores are only 8, 6 or 2 | The report a client would see is blank |
| Questions are generated from the JD alone; **no client input at all** | We screen for *our* guess of the role, not the client's |

The fix is not only a better prompt. The call needs to know **what this client cares about for this
opening**, and that only comes from the client.

---

## 3. Who does what

| Who | Where | What they do in this flow |
|---|---|---|
| **Client contact** (hiring manager / HR) | employer.gatihire.com | Requests an opening, gives input for the JD, confirms the JD, ranks screening priorities |
| **Account manager / Admin** | admin.gatihire.com | Reviews requests, sees client history, approves/edits/merges, runs the JD generator, checks the brief |
| **AI screening call** (Bolna) | automatic | Asks about the client's top priorities, probes, checks dealbreakers |
| **HR / Recruiter** | admin.gatihire.com | Sources and shortlists against the same criteria, then shares to the portal (existing Partners flow) |

---

## 4. The journey, step by step

### Step 1 — Client requests an opening (employer portal)

A short form, mobile-friendly, about 2 minutes. Only the basics; we do the heavy lifting.

| Field | Required | Notes |
|---|---|---|
| Role title | ✅ | Free text, with suggestions ("Fleet Manager", "Warehouse Supervisor"…) |
| Location(s) | ✅ | City, or multiple cities |
| Number of positions | ✅ | |
| Experience range | ✅ | Min to max years |
| Budget / CTC range | ✅ | Shown to the AI call only as a range; never as the client's exact budget |
| Urgency | ✅ | Immediate / within 30 days / within 60 days |
| **"Describe the role in your words"** | ✅ | Free text or **voice note**. This is the most important input |
| Existing JD | optional | Upload a PDF/DOCX or paste text |
| Reporting to / team size | optional | |
| Why is this role open? | optional | New role, replacement, expansion. Helps us pitch the job |
| Anything that must NOT be compromised | optional | Seeds the dealbreakers in Step 5 |

On submit the client sees: *"Thanks. Our team will review this and come back with a draft job
description within 1 working day."* The request appears in their portal as **Under review**.

> **The request does not create a live job.** It never reaches the talent board, matching, outreach
> or calling until an admin approves it.

### Step 2 — Admin review queue (admin.gatihire.com)

A new **Job Requests** inbox. Each request opens next to **that client's full hiring history**,
so the admin decides with context.

```
 ┌─ Job request · Acme Logistics · Fleet Manager · Delhi · 2 positions ───────┐
 │  Requested by Sunil (Ops Head) · 12 Nov, 10:42 · Urgency: Immediate         │
 │  "Need someone who can run 50+ trucks, handle drivers directly, GPS data…" │
 │                                                                             │
 │  THIS CLIENT'S POSITIONS (all time)                                         │
 │  Fleet Manager · Delhi      Closed  · filled 3 Sep  · 4 shared, 1 hired     │
 │  Fleet Manager · Gurgaon    Open    · 6 shared · 2 interview  ⚠ similar     │
 │  Warehouse Supervisor · Pune Open   · 3 shared · 0 decided                  │
 │  Top client reject reasons: salary expectation (5), experience gap (3)      │
 │                                                                             │
 │  [ Approve & build JD ]  [ Merge into existing opening ]  [ Ask client ]    │
 │  [ Decline (with reason) ]                                                  │
 └─────────────────────────────────────────────────────────────────────────────┘
```

What the admin checks:

- **Duplicate or overlap.** Is this the same as an open role (same title and city)? Then *merge*, or
  add positions to the existing job.
- **Feasibility.** Budget vs experience vs market. If the budget is clearly low, *ask client*
  before building the JD (the past reject reasons help here).
- **Fit for us.** Can we deliver this role? If not, *decline* with a reason the client sees.
- **Commercials.** Is the client agreement active for this kind of role (if applicable)?

Request statuses: `submitted → in_review → (needs_client_info) → approved → jd_draft →
jd_confirmed → criteria_set → live` and side exits `merged`, `declined`, `withdrawn`.

Target turnaround: review within **1 working day**. Unreviewed requests over 1 day show in the
admin's **Today** list.

### Step 3 — AI JD generation with the client's own input

On *Approve & build JD*, the admin opens our existing JD generator (`/api/generate-jd`), pre-filled
with:

- the client's request form and their "in your words" text or voice-note transcript,
- their uploaded JD (if any),
- the **client's previous JDs** for similar roles (style and wording carry over),
- our own role templates for logistics and supply chain.

The generator produces a JD **and** structured fields we already use downstream:
`skills_must_have`, `skills_good_to_have`, `key_responsibilities`, `daily_work_summary`,
`experience_min/max`, `salary range`, `license_type`, `shift_type`, `languages_required`.

The admin edits it, then **sends it to the client for confirmation** in the portal:

```
 ┌─ Draft JD · Fleet Manager · Delhi ─────────────────── v1 ─┐
 │  [ full JD, editable section by section ]                  │
 │                                                            │
 │  ✎ Suggest change on any section                           │
 │  [ Request changes ]                    [ Looks good ✔ ]   │
 └────────────────────────────────────────────────────────────┘
```

- The client can approve, or comment section by section. Each round is a new version (v1, v2…).
- **Silence rule.** If the client doesn't respond in 2 working days, we remind them once. After 3
  days the admin can mark it *confirmed on client's behalf (by phone)*, and we log who did it.

### Step 4 — "What matters most to you?" (the screening pointers)

Straight after the JD is confirmed, the client sees a single screen. We **suggest** 6–10 pointers
generated from the confirmed JD, and the client shapes them.

```
 ┌─ For this opening, what matters most? ─────────────────────────────┐
 │  Drag to rank. We'll focus the screening call on your top 3.        │
 │                                                                     │
 │  ≡ 1  Has run a fleet of 50+ trucks day to day         ★ Top        │
 │  ≡ 2  Handles drivers directly (hiring, discipline)    ★ Top        │
 │  ≡ 3  Uses GPS / fleet tracking data to cut downtime   ★ Top        │
 │  ≡ 4  Vendor and workshop coordination for breakdowns               │
 │  ≡ 5  MIS reporting in Excel                                        │
 │  ≡ 6  Fuel cost control                                             │
 │                                                                     │
 │  MUST-HAVE (dealbreakers) — candidate is not shared if missing      │
 │  ☑ Hindi speaking   ☑ Can be in Delhi NCR   ☐ Own two-wheeler        │
 │                                                                     │
 │  + Add your own pointer                                             │
 │  "What would make you say NO to a candidate?" [ free text ]         │
 │                                                                     │
 │                                        [ Save screening priorities ]│
 └─────────────────────────────────────────────────────────────────────┘
```

Rules for the pointers we suggest:

- Each pointer is a **thing a person has done**, not a trait ("has run 50+ trucks", not
  "good leader"). Only things that can be checked by asking about real work.
- The client may rank up to 3 as **Top**; 4 or more top priorities can't be covered well in one call.
- Dealbreakers are **yes/no facts** (license, language, location, shift). They are checked on
  WhatsApp or by a quick confirm, **not** used as interview topics.
- **Blocked pointers.** We never accept criteria on age, gender, religion, caste, marital status,
  pregnancy, or similar. If a client types one, the portal shows: *"We can't screen on this. Please
  tell us about the skills or experience instead."*

If the client skips this screen, the admin sets the priorities from the JD (marked
**"set by GatiHire"** in the portal), and the client can change them any time.

### Step 5 — The Screening Brief (one object per job)

Everything from Steps 3–4 is saved as a single **Screening Brief** on the job. This is "the one
topic" the calling system reads. Nothing else decides what the AI asks.

```json
{
  "job_id": "…",
  "version": 3,
  "set_by": "client",                // client | admin
  "role_context": "Acme runs 120 trucks on Delhi–Jaipur–Ahmedabad lanes; this person reports to Ops Head and manages 2 supervisors.",
  "priorities": [
    {
      "rank": 1,
      "pointer": "Has run a fleet of 50+ trucks day to day",
      "why_it_matters": "Client's own words: 'needs to run 50+ trucks without me chasing'",
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
    { "label": "Hindi speaking", "source": "call_language" },
    { "label": "Can be in Delhi NCR", "source": "whatsapp_info.location" }
  ],
  "never_ask": ["CTC", "notice period", "joining date", "anything already collected on WhatsApp"],
  "client_no_text": "Candidates who only managed contract fleets and never handled drivers"
}
```

- **Versioned.** If the client changes priorities after calls have started, new calls use the new
  version. Old reports show which version they were scored against.
- **Generated once per job, not per candidate.** Per-candidate personalisation (one line from the
  resume to verify) is added at call time, inside the same topics.

### Step 6 — How the AI call uses the brief

Today `lib/jd-questions.ts` asks Gemini for "3–6 questions" from the JD for each candidate, and
the agent reads them out. With a brief:

| Today | With the Screening Brief |
|---|---|
| 5 flat questions guessed from the JD | **3 topics = client's Top 3 priorities**, in their rank order |
| Questions written fresh for every candidate | Opening question and probes fixed per job (consistent, comparable) plus **one resume line** per candidate to probe |
| 40% yes/no or joining questions | Open questions only; joining/CTC/notice never asked (they come from WhatsApp) |
| No follow-ups | 1–2 probes per topic: scale → own role → real example → outcome |
| About 2.8 minutes | **5–7 minutes, hard stop at 8**; stop opening new topics at 6:30 |
| First question is the hardest | Warm-up first: "Abhi aapka din bhar ka kaam kya rehta hai?" |
| Dealbreakers mixed into the interview | Dealbreakers checked before the call (WhatsApp) or with one quick confirm at the end |

**Call shape (about 6 minutes):**

```
0:00–0:30  Greeting, permission, why we're calling (client named only if allowed)
0:30–1:15  Warm-up: current day-to-day work
1:15–5:15  Priority 1 → 2 → 3   (each: opening question + 1–2 probes, ~80 s)
5:15–6:00  Any question from the candidate? → close
           Clear mismatch (e.g. fresher for a lead role) → polite close at 2–3 min
```

The call prompt gets one block, built from the brief:

```
CLIENT KI PRIORITIES (isi order mein, har ek pe ek real example nikaalna hai)
1. <pointer> — shuru karein: "<opening_question>". Probe: <probes>
2. ...
3. ...
CANDIDATE KE RESUME SE EK BAAT VERIFY KAREIN: "<resume claim>"
```

### Step 7 — The client's report, by their own criteria

The AI screening card in the Partners Portal (Step 4 of that doc) is organised by **the client's
priorities**, not by our generic strengths/concerns:

```
 ┌─ AI screening · scored against YOUR priorities (v3) ────────┐
 │  1. Runs 50+ trucks          ●●●○  Strong                    │
 │     "Abhi 64 gaadiyan, Jaipur aur Ahmedabad lane…" ▶ 01:42   │
 │  2. Handles drivers directly ●●○○  Partial                   │
 │     Hires via contractor; handles discipline himself ▶ 03:10 │
 │  3. GPS data for downtime    ●○○○  Weak                      │
 │     Uses Fleetx only for location, not reports     ▶ 04:25   │
 │  Dealbreakers: Hindi ✔  Delhi NCR ✔                          │
 │  [ ▶ Full recording ]  [ Transcript ]                        │
 └──────────────────────────────────────────────────────────────┘
```

- Every rating has **a quote and a timestamp** from the call. No quote, no rating; the card shows
  "Not covered in call".
- This replaces today's 8/6/2 score. The overall recommendation comes from the per-priority ratings
  plus dealbreakers.
- **Feedback loop.** When the client rejects a candidate with a reason (Partners Portal Step 5),
  we compare it to the priorities. "Rejected for skill gap on #3 although we rated #3 Strong" tells
  us the brief or the scoring needs adjusting. Admin sees this per job.

---

## 5. What changes for each side

**Client**
- Requests openings in the portal instead of calling or emailing.
- Gets a JD drafted for them, approves it in one tap.
- Spends about 1 minute ranking "what matters most". Every candidate they then see is scored on it.

**Admin / Account manager**
- New **Job Requests** inbox with client history alongside. Nothing goes live without approval.
- JD generator pre-filled from client input.
- Checks the Screening Brief before the job goes live.

**HR / Recruiter**
- Sources and shortlists against the same Top 3 and dealbreakers.
- The mandatory "why this candidate" remark (Partners doc) refers to the client's priorities.

**Jobs created directly by admin** (phone or email clients, existing jobs) follow the same rule: no
calling until the job has a Screening Brief. For the jobs already live, admin creates the brief
from the JD, and it's marked "set by GatiHire" until the client reviews it.

---

## 6. What we'll build (tech outline)

| Piece | What | Builds on |
|---|---|---|
| `job_requests` table | Client request form data, status, `client_id`, `requested_by`, history of status changes | New |
| Admin **Job Requests** inbox | Queue, client history panel, approve / merge / ask client / decline | `jobs`, `clients`, Partners decisions data |
| JD versions | `job_jd_versions` (text + structured fields + who and when), client comments | `/api/generate-jd`, `components/jd-generator.tsx` |
| Pointer suggestion | LLM call: confirmed JD + client input → 6–10 checkable pointers, with opening question, probes and signals for each | New prompt |
| `screening_brief` | JSON on `jobs` (or `job_screening_briefs` with versions) — shape as in Step 5 | New |
| Call payload | Replace `{questions}` with `{client_priorities}` block plus `{resume_claim}`; stop per-candidate question generation | `lib/jd-questions.ts`, `lib/call-orchestrator.ts`, `lib/bolna.ts` prompt |
| Guard | No call is placed if the job has no Screening Brief | `lib/call-orchestrator.ts` |
| Scoring | After the call: per-priority rating plus quote plus timestamp, using the brief's strong/weak signals | `lib/bolna-execution.ts` verdict |
| Portal report | Priority-wise screening card | Partners Portal review screen |
| Blocked-criteria filter | Reject age/gender/religion/caste/marital-status pointers | New |

---

## 7. Edge cases

| Situation | What happens |
|---|---|
| Client requests the same role twice | Admin sees the overlap and merges, or adds positions to the open job |
| Client never ranks priorities | Admin sets them from the JD; the portal shows "set by GatiHire, review?" |
| Client changes priorities mid-hiring | New brief version; earlier candidates keep their old scores, labelled with the version. Admin can re-call the strongest ones |
| Bulk / blue-collar roles (drivers, loaders) | Shorter brief: 2 priorities and dealbreakers (license, route, shift); about a 4-minute call |
| Confidential role (client name hidden) | Brief has `client_visible: false`; the call says "ek logistics company" |
| Client gives a discriminatory criterion | Blocked in the UI; admin is alerted if they try to add it by email |
| Client is slow to confirm the JD | One reminder after 2 days; after 3 days admin confirms on phone and logs it |
| Candidate speaks only English | Same brief; the opening questions are kept in both Hinglish and English |

---

## 8. Rollout

| Phase | What | Visible result |
|---|---|---|
| **0. Call fixes (no client changes)** | Re-sync the Bolna agent (hangup lines, welcome first name), stronger LLM for live calls, open-only question rules, remove the joining question, follow-up rules | Better calls on current jobs |
| **1. Screening Brief in admin** | Admin creates a brief for every live job; the call uses the brief; per-priority scoring | Calls and reports organised by priorities |
| **2. Job requests in the portal** | Client request form, admin review queue with client history | No job goes live unreviewed |
| **3. JD with the client** | Pre-filled JD generation, client confirm/comment, versions | Client-approved JDs |
| **4. "What matters most" screen** | Client ranks pointers and sets dealbreakers | Briefs set by the client |
| **5. Priority-wise report and feedback loop** | Portal card with quotes and timestamps; reject reasons vs priorities | Client sees calls in their own terms |

Phases 0–1 don't need the portal, and they fix most of what the call analysis found. Start there.

---

## 9. How we'll know it's working

- Every live job has a Screening Brief; **0 calls** placed without one.
- At least 70% of briefs are **set or reviewed by the client** (not only by us).
- Median candidate answer at **20+ words**; at least 1 follow-up per topic in most calls.
- Completed calls at **5–7 minutes**, with mid-interview hang-ups not rising.
- Every rating in a report has a quote; **0 blank** strengths/concerns.
- Client "interview" rate on shared candidates goes up; rejects for "skill gap" go down.

---

## 10. Open questions

1. **Portal domain.** The Partners doc names both `employer.gatihire.com` and `partners.gatihire.com`.
   Which is final?
2. **Can clients create jobs directly**, or always via a request? (This plan: always a request.)
3. **How many Top priorities**: is 3 the right cap for every role, or 2 for blue-collar roles?
4. **Client name on calls**: do we name the hiring company to candidates by default?
5. **Does a client see the brief's probes and signals**, or only the pointers they ranked?
6. **Voice-note input**: do we want it in v1 (needs transcription), or text only?
