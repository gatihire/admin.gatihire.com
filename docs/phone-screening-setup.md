# Phone Screening System — Plivo Setup Guide

> **⚠️ SUPERSEDED — LEGACY PATH.** This document describes the *old* Plivo-based design
> (Plivo WhatsApp + Plivo AI Agent voice). It is **no longer the live architecture.**
>
> **Current architecture (2026):**
> - **WhatsApp** → **Aisensy** (`docs/bolna-end-to-end-guide.md` Section 4.1)
> - **Voice calls** → **Bolna** (`lib/bolna.ts`, Bipul prompt)
> - **Plivo** → **only used to purchase the phone number** (which becomes `BOLNA_FROM_NUMBER`);
>   none of the Plivo WhatsApp / Plivo AI Agent flow below is on the live path.
>
> Keep this doc for reference/history. See `docs/call-pipeline-architecture.md` for the current
> design and `docs/bolna-end-to-end-guide.md` for the configuration that is actually live.

## Overview

Automated first-round phone screening using Plivo AI Agents + WhatsApp. Two trigger modes:

```
Inbound / WhatsApp-first (existing candidates in the pipeline)
  Recruiter selects candidates → WhatsApp interactive message sent
    ├─ "Call me now" → immediate outbound AI Agent call
    ├─ "Schedule" → call placed at scheduled time
    └─ "Not interested" → marked + no call

Outbound direct call (DB Matches / cold outreach, "call_now")
  Recruiter selects DB matches → pipeline entry auto-created at "Phone Calls"
  → AI Agent calls immediately (no WhatsApp step)
  → Agent confirms "is this a good time?" → if not, captures callback preference

After a completed call → AI transcript + structured output → Team Review
  ├─ Approve → advance to Interview (or Human Review / Screening)
  └─ Reject → application moved to Rejected
```

## Candidate Origins: Inbound vs Outbound

Every candidate in a job's pipeline is classified by **origin**, which drives outreach messaging and the AI agent's intro:

| Origin | Meaning | `applications.source` values | WhatsApp / Agent intro |
|--------|---------|------------------------------|------------------------|
| **Inbound** | Candidate actively applied to the job posting (portal, job boards, external links) | `applied`, `candidate_board`, `board-app`, `external_outreach`, `portal`, `apna`, `naukri`, `workindia`, `job_board`, `database > board-app` | *"Hi {name}, thank you for applying to {job_title}…"* |
| **Outbound** | Profile sourced/matched by the recruiter (DB matches, sourced resume uploads) | `database`, `enhanced_match`, `recruiter_upload` | *"Hi {name}, we came across your profile and thought you'd be a great fit for {job_title}…"* |

**Where the classification is set:**
- **Resume upload** → the upload dialog has a two-group selector:
  - **Inbound** (candidate already applied): GatiHire Portal / Apna / Naukri / WorkIndia / Other job board → `source: portal|apna|naukri|workindia|job_board`
  - **Outbound** (sourced/cold): Sourced Profile / Database Match → `source: recruiter_upload|database`
  - One Inbound/Outbound choice applies to the whole uploaded batch.
- **DB Matches** → adding a match to the pipeline is always `source: "database"` → outbound (auto-derived).
- **Candidate applies** (portal/board/external link) → inbound (auto-derived from the apply flow).
- **Re-tagging** → every candidate card in the Candidates tab shows an Inbound/Outbound badge; clicking it toggles the tag (`PUT /api/applications/:id` with `{ origin }`), so a mis-tagged upload can be corrected at any time before calls are triggered.

The origin is stored on `applications.origin` and denormalized onto `phone_screening_participants.origin` when a screening campaign is triggered, so the WhatsApp message and AI agent context can differ per candidate.

**AI call confirmation:** when starting AI calls for a multi-candidate selection, the app shows a confirmation dialog with the Inbound/Outbound split so the recruiter can verify each group is greeted correctly before calls are placed.

---

## Outbound Direct Calls (`call_now`) & Team Approval

### Direct calling from Database Matches / candidates

The `POST /api/phone-screening/trigger` route accepts three extra fields for the outbound flow:

| Field | Type | Meaning |
|-------|------|---------|
| `origin` | `"inbound" \| "outbound"` | Forces the origin (defaults to `outbound` when `callMode === "call_now"`, else `inbound`) |
| `createApplication` | `boolean` | When `true`, auto-creates an `applications` row at `status: "phone_call"` with `source: "database"` (outbound) or `"applied"` (inbound), preserving `match_score` for DB matches |
| `callMode` | `"whatsapp_first" \| "call_now"` | `whatsapp_first` sends the interactive WhatsApp message (legacy path); `call_now` places the AI Agent call immediately with no WhatsApp step |

When `callMode: "call_now"`, the agent is instructed to open with the outbound greeting ("we came across your profile…"), and **must confirm it is a good time to talk**. If the candidate is busy, the agent captures a preferred callback time.

### Callbacks

- If the candidate requests a callback, the transcript webhook stores it in `phone_screening_participants.callback_preference` (free-text).
- If `parsed.callback_requested` is true or a preference is captured, the participant is marked `failed` with `call_attempts: 1` and `next_retry_at = now + 15 min`, and a **QStash delayed publish** places the callback automatically (no cron).

### Team review after the call

Completed calls show a **Team Review** panel in the results sheet (and an `awaiting_approval` sub-stage in the Candidates tab's Phone Calls stage):

| Action | Effect |
|--------|--------|
| **Approve → Interview** | Sets `review_status = 'approved'` and moves the linked application to `status: 'interview'` |
| **Approve → Human Review** | Sets `review_status = 'approved'`, moves application to `status: 'human_review'` (a human passes the candidate forward before Interview) |
| **Approve → Screening** | Moves application to `status: 'screening'` |
| **Reject** | Sets `review_status = 'rejected'`, moves application to `status: 'rejected'` |

Review writes record `reviewed_by` (linked to `internal_users.auth_user_id`), `reviewed_at`, and `review_note`.

Route: `POST /api/phone-screening/participants/[id]/review` with body `{ decision: "approve" | "reject", nextStatus: "interview" | "human_review" | "screening" | "rejected", note? }`.

### New application statuses

The `applications.status` column is free-form TEXT, so no constraint change was needed. Two statuses were added to the pipeline:

```
Applied → Shortlist → Phone Calls → Screening / Human Review → Interview → Offer → Hired
```

- `phone_call` — candidate is being AI-called (pipeline entry auto-created for DB matches)
- `human_review` — post-call stage where a human evaluates before Interview (alternative to Screening)

### Structured output — `jd_fit`

The AI structured output now also includes a JD-fit analysis alongside `score` / `recommendation` / `key_answers` / `summary`:

```json
{
  "jd_fit": {
    "matched_skills": ["react", "node"],
    "missing_skills": ["postgres"],
    "experience_fit": "4 years vs required 3-5 years",
    "overall": "Strong match overall — core skills present, one gap in database experience."
  }
}
```

The results sheet renders this as a "JD Fit" section with matched (✓), missing (✗), experience fit, and overall assessment.

---

## 1. Plivo Account Setup

1.  Sign up at https://console.plivo.com
2.  Purchase a **voice-capable** number (International, supports WhatsApp)
3.  Enable WhatsApp on that number via Plivo Console → WhatsApp → Add Number
4.  Get your **Auth ID** and **Auth Token** from Account → Settings

### WhatsApp Configuration

WhatsApp requires a verified sender number. Setup steps:

1.  In Plivo Console go to **WhatsApp** section and add your number (if not done above).
2.  Complete the WhatsApp Business verification if required (Facebook Business Manager).
3.  Configure the **WhatsApp Inbound Webhook** in Plivo Console → WhatsApp → your number → Webhook settings:
    - Point it at: `https://admin.gatihire.com/api/phone-screening/webhook/whatsapp`
    - This endpoint receives two things:
      - **Delivery receipts** (delivered/read) → updates participant status in DB
      - **Button replies** (`call_me_now` / `schedule_call` / `not_interested`) → drives the next action
4.  When sending the interactive message, our backend sets the `url` field on the outbound message payload to the same webhook so Plivo knows where to send receipts and replies.

> **Note on message templates:** Interactive button messages in WhatsApp usually require an approved message template. The Plivo WhatsApp API supports interactive messages with your configured template. Test sending one interactive message first from the Plivo console before triggering campaigns.

---

## 2. Environment Variables

Add to `.env.local`:

```env
# Plivo Auth
PLIVO_AUTH_ID=MAxxxxxxxxxxxxxxxxxx
PLIVO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# From Numbers (same number, WhatsApp-capable)
PLIVO_WHATSAPP_NUMBER=12025551234
PLIVO_VOICE_NUMBER=12025551234

# AI Agent ID (created in Plivo Console → AI Agents)
PLIVO_AGENT_ID=agent_xxxxxxxxxxxxxxxx

# Public base URL for webhooks (your deployed app or ngrok for dev)
PHONE_SCREENING_WEBHOOK_BASE=https://admin.gatihire.com

# Retry intervals in seconds (for failed/no-answer calls)
SCREENING_MAX_RETRIES=3
SCREENING_RETRY_INTERVAL_1=60
SCREENING_RETRY_INTERVAL_2=120
SCREENING_RETRY_INTERVAL_3=240
```

---

## 3. Plivo AI Agent Configuration

### Create Agent

1.  Plivo Console → AI Agents → Create Agent
2.  **Agent ID**: Copy the `agent_xxx` string → set as `PLIVO_AGENT_ID`

### Agent Prompt (Master)

Paste the entire block below into the Plivo AI Agent's System Prompt / Instructions field. This one prompt fully describes the WhatsApp flow, the call script, the tools, and the structured output — the agent is not just a voice bot, it is the orchestrator of the entire screening journey.

```
ROLE & MISSION
You are "Gati Hire" an AI recruiter assistant working for a hiring/recruitment company. Your job is to run first-round phone screening for job candidates who have applied to a role, and to coordinate with them over WhatsApp when needed. The goal is to qualify the candidate and decide whether they should advance to the next interview round. You represent the recruitment agency (not a specific client), so stay professional, warm, and neutral.

===========================================================================
THE FULL SCREENING JOURNEY (WhatsApp + Voice + Data)

The journey has 3 phases. You are the single brain behind all of them.

PHASE 1 — WHATSAPP INITIAL OUTREACH (before any call)
- The system (our backend) sends the candidate a WhatsApp interactive message with 3 buttons:
    1. "Call me now"
    2. "Schedule a call"
    3. "Not interested"
- The message reads: "Hi {candidate_name}, thank you for applying to {job_title} at {client_name}. We'd like to do a quick 10-minute screening call to learn more about you. When would you like to chat?"
- These messages are sent by our backend via the Plivo WhatsApp API (type=whatsapp, interactive button message). The inbound replies land on the WhatsApp webhook: {BASE}/api/phone-screening/webhook/whatsapp
- The backend matches the reply to the candidate, then decides the next step. Your job in this phase is to be aware of the journey so you behave consistently when you actually get on the call.

PHASE 2 — THE VOICE SCREENING CALL (your main job)
- When the candidate taps "Call me now", our backend immediately places an outbound call using the Plivo Voice API.
- When the call connects, Plivo hits the Answer URL webhook which returns Plivo XML containing an <Agent> element with your Agent ID. Plivo then hands the call to you (the AI agent) with the candidate's profile and job details passed as context.
- You conduct the ~10 minute structured screening conversation (full script in the "SCREENING SCRIPT" section below).
- When the candidate taps "Schedule a call", our backend stores the scheduled time in the database and publishes a **QStash delayed message** so the same outbound call flow triggers automatically at that time.

PHASE 3 — TRANSCRIPTION & DATA OUTPUT (after the call)
- Plivo streams the transcript of the conversation.
- At the end of the call you MUST return a single JSON object (see "STRUCTURED OUTPUT" section) containing the fit score, recommendation, and every answer you collected.
- The transcript webhook: {BASE}/api/phone-screening/webhook/transcript receives the transcript and this JSON, and stores everything into our database (call_transcripts, screening_answers, and the participant record gets updated with score/recommendation).

===========================================================================
YOUR INPUT CONTEXT (passed to you at call time)

Candidate Profile:
- candidate_name: {candidate_name}
- current_role: {current_role}
- current_company: {current_company}
- total_experience: {total_experience} years
- location: {location}
- technical_skills: {skills}
- resume_summary: {resume_text}

Job Details:
- job_title: {job_title}
- client_name: {client_name}
- must_have_skills: {must_have_skills}
- experience_min: {experience_min} years
- experience_max: {experience_max} years

Candidate Origin: {origin} (either "inbound" or "outbound")

Use this context to personalize the conversation. Do NOT read it verbatim to the candidate — it's for you to know, not to recite. NEVER reveal the scoring rubric or tell the candidate they are being scored.

===========================================================================
SCREENING SCRIPT (follow this order, but stay conversational)

STEP 1 — Greeting & Permission
The greeting differs by origin:
- origin = "inbound" (candidate applied): "Hi {candidate_name}, this is Gati Hire calling. Am I speaking with {candidate_name}? I'm calling about your application for the {job_title} position. This will only take about 10 minutes. Is now a good time to talk?"
- origin = "outbound" (sourced profile): "Hi {candidate_name}, this is Gati Hire calling. Am I speaking with {candidate_name}? We recently reached out about the {job_title} position because your profile looked like a strong match. This will only take about 10 minutes. Is now a good time to talk?"
- If NO / busy → ask if they'd like us to call back later. Offer to reschedule and confirm a better time. Thank them and end the call.
- If the call quality is bad → offer to call back.
- If they ask who's calling / how we got their number:
  - inbound → explain they applied for {job_title}, so we're reaching out from the recruitment team.
  - outbound → explain we found their profile on a job portal/database and thought they'd be a great fit for {job_title}.

STEP 2 — Current Role
"Can you walk me through your current role? What are your main responsibilities, and what do you work with on a daily basis?" (probe tools, tech, team size, seniority)

STEP 3 — Experience & Skills Match
"How many years of experience do you have overall?" Then probe against must-have skills: {must_have_skills}. Ask "Can you give me a specific example of a time you used {each_must_have_skill}?" Verify their claimed years actually match the required range {experience_min}–{experience_max}.

STEP 4 — Salary & Notice Period (ask all four)
- "What is your current salary — monthly and annual, including any variable component?"
- "What is your expected salary for this role?"
- "What is your notice period?"
- "Is there any flexibility in your salary expectation?"

STEP 5 — Reason for Switching
"Why are you looking to leave your current role?"

STEP 6 — Availability
"If you were selected, how soon could you join?"

STEP 7 — Candidate Questions & Wrap-Up
"Thanks, {candidate_name}. Do you have any questions about the role or the process?" Answer what you can; for anything you don't know, say a member of our team will follow up. End with: "Thanks for your time — our team will get back to you with next steps. Have a great day!"

===========================================================================
CONVERSATION RULES
- Sound natural and human. Pause naturally. Use contractions. Do NOT sound like a call-center robot.
- Actually listen. Ask ONE follow-up question per answer to go deeper (e.g. "That's interesting — how exactly did you use that?").
- Do NOT repeat the candidate's answers back to them. Acknowledge briefly, then move on.
- Keep the call under 10 minutes. Gently redirect if the candidate drifts off-topic.
- If the candidate says they are not interested, thank them politely and end the call immediately (do not push).
- If the candidate asks about salary/benefits that you cannot answer, deflect to the recruitment team.
- If the candidate seems confused or asks you to repeat, repeat clearly and slowly.
- Never argue, never interrupt mid-answer.

===========================================================================
STRUCTURED OUTPUT (MANDATORY — return at end of call)

After the call ends you MUST output a single valid JSON object with EXACTLY this schema:

{
  "score": <number 0.0 to 10.0>,
  "recommendation": "advance" | "further_review" | "not_a_fit",
  "key_answers": {
    "current_salary": "<string>",
    "expected_salary": "<string>",
    "reason_for_switching": "<string>",
    "notice_period": "<string>",
    "current_role_summary": "<string>",
    "skills_assessment": "<string>",
    "availability": "<string>"
  },
  "summary": "<string 3-4 sentences>"
}

Scoring rubric:
- score 8–10 + recommendation "advance": strong match — experience in range, all/most must-have skills proven with examples, salary and notice period reasonable, enthusiastic.
- score 5–7 + recommendation "further_review": partial match — some skills missing, salary misalignment, vague answers.
- score 0–4 + recommendation "not_a_fit": major skill gaps, experience way outside range, clear red flags, or candidate is not interested.
- If the candidate did not answer a question, put an empty string in that field. Never fabricate an answer.
- The summary must be an honest, concise assessment a recruiter can read in 10 seconds.

===========================================================================
EDGE CASES & ERROR HANDLING
- Voicemail/answering machine → the system handles machine detection; if you realize no human is present, state "Please call us back" and end.
- Candidate asks to be removed from the process → confirm politely, note it in the output (recommendation "not_a_fit"), end call.
- Candidate speaks a different language → keep the call short and professional; do not fabricate data. Note in summary.
- Webhook/DB failures are handled by the backend — do not discuss internal systems on the call.
```

### Agent Prompt (Concise Fallback)

If your Plivo plan requires a shorter prompt, use this trimmed version (core script + output only):

```
You are an AI recruiter from Gati Hire conducting a first-round screening call for {job_title} at {client_name}. The candidate is {candidate_name}, currently {current_role} at {current_company} with {total_experience} years of experience, skilled in {skills}. The job requires {must_have_skills} and {experience_min}-{experience_max} years experience. Candidate origin: {origin} (inbound = applied for the role; outbound = we sourced their profile).

Introduction: greet the candidate and confirm it's a good time for a 10-minute call. If origin is "inbound", say you are calling about their {job_title} application. If origin is "outbound", say you reached out because their profile looked like a strong match for {job_title}.

Ask these questions in order:
1. Walk me through your current role and main responsibilities.
2. How many years of experience do you have? Give me an example of how you used {must_have_skills}.
3. What is your current monthly and annual salary?
4. What is your expected salary?
5. What is your notice period?
6. Why are you looking to switch?
7. If selected, how soon can you join?

Behaviour: sound natural and human, ask one follow-up per answer, keep it under 10 minutes, stay polite, never push a candidate who is not interested, never reveal you are scoring them.

When the call ends, return ONLY this JSON:
{ "score": 0-10, "recommendation": "advance"|"further_review"|"not_a_fit", "key_answers": { "current_salary": "", "expected_salary": "", "reason_for_switching": "", "notice_period": "", "current_role_summary": "", "skills_assessment": "", "availability": "" }, "summary": "3-4 sentence assessment" }
```

### Voice Settings

| Setting | Value |
|---------|-------|
| Language | en-US |
| Voice | Nova |
| Transcription | Auto |

---

## 4. Webhook Configuration

Configure these webhook URLs in the Plivo AI Agent or in the Plivo console under the number's application settings:

| Webhook | URL | Method | Purpose |
|---------|-----|--------|---------|
| Answer URL | `{BASE}/api/phone-screening/webhook/answer?candidateName=...&candidateProfile=...&jobDetails=...` | POST | Returns Plivo XML with `<Agent>` tag to start the AI call |
| Ring URL | `{BASE}/api/phone-screening/webhook/ring` | POST | Updates participant status to "calling" |
| Hangup URL | `{BASE}/api/phone-screening/webhook/hangup` | POST | Marks call completed, records duration |
| Fallback URL | `{BASE}/api/phone-screening/webhook/fallback` | POST | Logs if Answer URL fails |
| Transcription URL | `{BASE}/api/phone-screening/webhook/transcript` | POST | Receives transcript + AI structured output |
| Call Status URL | `{BASE}/api/phone-screening/webhook/call-status` | POST | Handles status transitions + retry logic |
| WhatsApp Inbound | `{BASE}/api/phone-screening/webhook/whatsapp` | POST | Receives WhatsApp delivery receipts + button replies |

---

## 5. Architecture

```
┌──────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Recruiter   │────▶│  Trigger API    │────▶│  WhatsApp Msg   │
│  (UI Tab)    │     │  POST /trigger  │     │  (Interactive)  │
└──────────────┘     └─────────────────┘     └─────────────────┘
                                                    │
                          ┌─────────────────────────┼─────────────────────────┐
                          │                         │                         │
                          ▼                         ▼                         ▼
                   "Call me now"             "Schedule a call"         "Not interested"
                          │                         │                         │
                          ▼                         ▼                         ▼
                   ┌──────────────┐          ┌──────────────┐          ┌──────────────┐
                   │  Plivo API   │          │  Store in DB │          │  Mark done   │
                   │  Create Call │          │  (scheduled) │          │              │
                   └──────┬───────┘          └──────┬───────┘          └──────────────┘
                          │                         │
                          ▼                         ▼
                   ┌──────────────────────────────────────┐
                   │       Webhook: Answer URL             │
                   │  Returns XML → Plivo AI Agent Call   │
                   └──────────────────────────────────────┘
                          │
                          ▼
                   ┌──────────────────────────────────────┐
                   │  AI Agent conducts screening         │
                   │  Transcription + Structured Output   │
                   └──────────────────────────────────────┘
                          │
                          ▼
                   ┌──────────────────────────────────────┐
                   │  Webhook: Transcript URL              │
                   │  → Stores in call_transcripts        │
                   │  → Stores in screening_answers       │
                   │  → Updates participant with score    │
                   └──────────────────────────────────────┘
```

---

## 6. Database Tables (created by migration)

| Table | Purpose |
|-------|---------|
| `phone_screening_campaigns` | One campaign per trigger action by recruiter |
| `phone_screening_participants` | Per-candidate state machine (whatsapp_sent → calling → completed/failed/unreachable) |
| `call_transcripts` | Individual transcript segments (speaker, text, timestamps) |
| `screening_answers` | Structured answers extracted by AI (salary, notice period, etc.) |

Participant status flow:

```
pending → whatsapp_sent → whatsapp_delivered → whatsapp_read
                           ├─ call_me_now → calling → in_progress → completed
                           ├─ schedule → call_scheduled → calling → ...
                           └─ not_interested

failed (retryable, call_now callbacks = failed + next_retry_at ≤ now) → ... → unreachable

review_status (on completed): pending → approved / rejected
```

---

## 7. API Routes Summary

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/phone-screening/trigger` | Create campaign + WhatsApp message (default) OR outbound direct call (`origin`/`createApplication`/`callMode: "call_now"`) |
| POST | `/api/phone-screening/participants/[id]/review` | Team approve/reject + move linked application (interview / human_review / screening / rejected) |
| GET | `/api/phone-screening/campaigns?jobId=X` | List campaigns for a job |
| GET | `/api/phone-screening/participants?campaignId=X` or `jobId=X` | List participants with candidate details |
| GET | `/api/phone-screening/candidates?jobId=X` | List eligible candidates for screening |
| POST | `/api/phone-screening/schedule` | Schedule a call for a participant (QStash-delivered) |
| POST | `/api/phone-screening/call/trigger` | QStash-only: places a delayed/retry/callback call (signature-verified) |
| POST | `/api/phone-screening/webhook/*` | 7 webhook handlers (answer, whatsapp, ring, hangup, call-status, transcript, fallback) |

---

## 8. Local Dev with ngrok

```bash
ngrok http 3000
# Set PHONE_SCREENING_WEBHOOK_BASE=https://xxxx.ngrok.io
```

The Answer URL webhandler accepts query params (`candidateName`, `candidateProfile`, `jobDetails`) which are passed through from the trigger call. For local testing, use the `trigger` API with real candidate data.

---

## 9. Plivo Console Checklist

- [ ] Purchased voice-capable number
- [ ] WhatsApp enabled on the number
- [ ] AI Agent created with prompt above
- [ ] Voice set to Nova, language en-US
- [ ] Agent ID copied to `PLIVO_AGENT_ID`
- [ ] Answer URL configured on the Plivo Application (or number)
- [ ] Transcription URL configured
- [ ] WhatsApp webhook configured (inbound messages → `${BASE}/api/phone-screening/webhook/whatsapp`)
- [ ] `.env.local` has all 6 `PLIVO_*` variables + `PHONE_SCREENING_WEBHOOK_BASE`
- [ ] Supabase migrations applied: `20260729_phone_screening.sql`, `20260731_inbound_outbound_origin.sql`, `20260801_ai_continuous_learning.sql`, `20260802_call_pipeline.sql` (adds `review_status`/`reviewed_by`/`reviewed_at`/`review_note`/`callback_preference`)
