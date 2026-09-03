# Bolna Outbound AI Screening — Direct Call Setup Guide

## Overview

Automated first-round phone screening using **Bolna Voice AI** for direct outbound calls. No WhatsApp. The recruiter selects candidates and the AI agent calls each one immediately. If a candidate is unavailable, the agent captures a preferred call-back time and the app schedules an automatic re-dial at that time. Results and call status are reflected live in the web app (admin.gatihire.com).

```
Recruiter selects candidates (Candidates tab / DB Matches / New Screening)
  → POST /api/phone-screening/trigger
  1. Per candidate: JD-specific questions generated from JD + resume
  2. POST api.bolna.ai/call (agent_id + E.164 number + user_data)
     → execution_id stored on participant
  3. Agent runs the screening using injected {variables}
  4. Bolna POSTs the execution payload to our webhook on completion
     → transcript + verdict written to DB, participant status updated
  5. If busy/unavailable → status "Call Scheduled" + scheduled time in web app
     → QStash delayed publish re-dials at that time
  6. Reconciliation endpoint resolves any calls stuck in calling/in_progress
```

## Candidate Origins

| Origin       | Meaning                                                                | Agent intro (Bipul, branches on origin)                                  |
| ------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Inbound**  | Candidate actively applied to the job posting                          | *"Thank you for applying for the {job_title} role at {hiring_company_name}…"* |
| **Outbound** | Profile sourced/matched by the recruiter (DB matches, sourced uploads) | *"We came across your profile and thought you'd be a great fit for the {job_title} role…"* |

The origin is read from `applications.origin` (denormalized onto `phone_screening_participants.origin`) and injected into `user_data.origin`. The master prompt's CALL FLOW step 3 branches the spoken opening on it — see the prompts below. The "how did you get my number" answer also branches (applied vs found-on-portal).

### Call Mode Toggle (per batch / per candidate)

| Mode (code value)        | UI Label                     | Flow                                                                   |
| ------------------------ | ---------------------------- | ---------------------------------------------------------------------- |
| `call_now`               | **Direct Call (Skip WhatsApp)** | Pure Bolna direct call — no WhatsApp                                   |
| `whatsapp_first`         | **WhatsApp Nudge → Auto Call** | Aisensy WhatsApp nudge → **automated** Bolna call when candidate opts in |

**Key clarification:** "WhatsApp Nudge → Auto Call" means the WhatsApp message is sent first; when the candidate responds (taps "Interested", "Call me now", etc.), an **automated Bolna voice call is placed**. The UI now explicitly shows this with "WhatsApp Nudge → Auto Call" vs "Direct Call (Skip WhatsApp)".

***

## 1. Bolna Account Setup

1. Sign up at <https://platform.bolna.ai>
2. **Buy a phone number** (US numbers use Twilio, Indian numbers use Plivo/Vobiz — see [Buy Phone Numbers](https://www.bolna.ai/docs/guides/inbound/buying-phone-numbers.md)).
3. Generate an **API key**: Dashboard → Account / API settings → create a token.
4. Copy the API key into `BOLNA_API_KEY`.

### Agent creation (two options)

**Option A — Dashboard (recommended first time):**

1. Dashboard → Agents → Create Agent → Auto Build.
2. Configure the system prompt (paste the **Hinglish Master Prompt** below — the default; or the **English Master Prompt**), welcome message, webhook URL, and voice.
3. Copy the agent ID → set as `BOLNA_AGENT_ID`.

**Option B — API (programmatic):**
`POST /api/bolna/agent` (requires `settings.manage` permission) creates the agent with the master prompt + welcome message baked in, returning the `agent_id`. Once `BOLNA_AGENT_ID` is set the endpoint is **create-only** — it does nothing (`"overwritten": false`) and never overwrites dashboard edits. Pass `force: true` to deliberately re-sync the prompt from `lib/bolna.ts` (this wipes dashboard prompt edits).

**Language:** defaults to **Hinglish** (`hinglish`). Pass `"language": "english"` in the JSON body to use the English prompt + English welcome message + `en` transcriber instead. To change the language of an existing agent, pass `"force": true` (this re-syncs the agent prompt from code).

```bash
curl -X POST https://admin.gatihire.com/api/bolna/agent \
  -H "Authorization: Bearer <internal_session_cookie>" \
  -H "Content-Type: application/json" \
  -d '{}'
# → { "agent_id": "123e4567-...", "state": "created" }
```

Set the returned `agent_id` as `BOLNA_AGENT_ID`.

### Webhook configuration

In the agent's Extractions tab, set **"Push all execution data to webhook"** to:

```
https://admin.gatihire.com/api/bolna/webhook/execution
```

Bolna POSTs the full execution payload (same shape as `GET /executions/{execution_id}`) on status changes and again on completion. **Whitelist source IP** **`13.203.39.153`** on your server / edge firewall.

***

## 2. Environment Variables

Add to `.env.local`:

```env
# Bolna Auth
BOLNA_API_KEY=your-bolna-api-key
BOLNA_AGENT_ID=123e4567-e89b-12d3-a456-426655440000

# Optional: from-number used for outbound calls (omitted → account default)
BOLNA_FROM_NUMBER=+918035739222

# Optional: shared secret verified on webhooks (in addition to IP whitelist)
BOLNA_WEBHOOK_TOKEN=

# Public base URL for webhooks (your deployed app or ngrok for dev)
PHONE_SCREENING_WEBHOOK_BASE=https://admin.gatihire.com
```

### LLM (question generation)

The JD-specific screening questions are generated per candidate by Gemini (reuses existing AI infra):

```env
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-2.5-flash        # optional, defaults to gemini-2.5-flash
```

If `GEMINI_API_KEY` is not set, a rule-based fallback question set is used.

***

## 3. The Agent Prompts

### Welcome message

**Hinglish (default):**

```
Hello {candidate_name} ji, Bipul bol raha hu GatiHire se — Truckinzy ki logistics hiring team se. Do minute baat ho sakti hai kya?
```

**English (opt-in):**

```
Hello {candidate_name}, this is Bipul calling from GatiHire — Truckinzy's logistics hiring team. Do you have two minutes to talk?
```

`{candidate_name}` and `{job_title}` are filled from the `user_data` we pass on every call.

### Master prompt (system\_prompt)x 22

Paste one of the blocks below into the agent's system prompt. Every `{variable}` is substituted per call from the `user_data` object:

> `user_data` carries the candidate profile (`candidate_name`, `current_role`, `current_company`, `total_experience`, `location`, `skills`, `resume_text`), the job context (`job_title`, `client_name`, `hiring_company_name`, `business_type_context`, `job_gist`, `salary_range`, `job_category`, `must_have_skills`, `experience_min`, `experience_max`, `job_location`), plus `origin`, `questions`, `timezone`, and `participant_id`. `hiring_company_name` = `client_name`; `business_type_context` comes from `industry`/client `company_subtype` (fallback: "a growing logistics and supply chain company"); `job_gist` from `daily_work_summary`/`key_responsibilities`; `salary_range` from `salary_min`/`salary_max` + `salary_type`; `job_category` is mapped from `role_category`/`department_category` (fallback: title keywords).

> The same prompts live in code (`BOLNA_MASTER_PROMPT_HINGLISH` / `BOLNA_MASTER_PROMPT` in `lib/bolna.ts`) so the `/api/bolna/agent` route can provision them programmatically — keep both in sync if you edit here.

#### Hinglish (default)

```
ROLE
You are Bipul, a Senior Talent Acquisition Specialist at Truckinzy Infotech Private Limited — the team behind GatiHire, India's dedicated logistics and supply chain job platform. You are making a first-round screening call for an open role. You sound warm but efficient, a recruiter who genuinely knows the logistics world (shifts, routes, CTC structures, career ladders), calling because there is a real, specific match — not a cold blast.

SPEAKING STYLE
- Speak in natural, respectful Hinglish (Hindi + English mix). Switch to full English only if the candidate explicitly asks.
- Speak in complete, professional sentences — a senior recruiter: warm, courteous, never casual or robotic, never slangy.
- Max 2 sentences per turn and never more than one question per turn.
- This is a voice call: no bullet points, lists, or markdown in spoken replies. Speak all numbers in words (e.g. "pandhra se bees lakh"), and spell acronyms (CTC, TMS, SAP, LMV, HMV, WMS, GPS, HR, EPF, PF, ESIC, BGV, LOI, DOJ, COD, ETA, POD) letter by letter.
- Keep the entire call to 3–5 minutes.

CANDIDATE CONTEXT
- Name: {candidate_name}
- Current role: {current_role} at {current_company}
- Total experience: {total_experience} years
- Location: {location}
- Skills: {skills}
- Origin: {origin} (inbound = candidate applied for the role; outbound = we sourced the profile)

JOB CONTEXT
- Role: {job_title} at {hiring_company_name}, in {job_location}
- About the company: {business_type_context} (read as given)
- Role summary: {job_gist} (read as given)
- Salary range: {salary_range} — never quote beyond this
- Job category: {job_category}
- Must-have skills: {must_have_skills}
- Required experience: {experience_min} to {experience_max} years

SCREENING QUESTIONS (ask one at a time, in order, woven naturally into the conversation):
{questions}

CALL FLOW
1. Confirm the candidate is free to talk. If busy, agree a specific callback day and time, note it, thank them, and end the call.
2. If it is a wrong number, apologize and end the call.
3. OPEN based on origin, THEN pitch:
   - origin = "inbound" (candidate applied):
       "Thank you for applying for the {job_title} role at {hiring_company_name}. I'm calling from the recruitment team for a quick first-round conversation."
   - origin = "outbound" (we sourced the profile):
       "We came across your profile and thought you'd be a great fit for the {job_title} role at {hiring_company_name}, so we wanted to tell you about it."
   Then pitch the role in 1–2 sentences using JOB CONTEXT, and ask if they would like to hear more.
4. If not interested, ask once for the reason, note it, thank them, and end politely. Never push.
5. If interested, screen one question at a time:
   - Current employer and role
   - Total logistics experience
   - Current CTC and expected CTC (if refused, acknowledge once and move on — never push)
   - Notice period and how soon they could join
   - Current location and willingness to relocate or commute to {job_location}
   If they want to reschedule mid-call, agree a callback day and time and end the call.
6. Ask any SCREENING QUESTIONS not already covered, prioritizing the ones tied to {must_have_skills}. Then, if the job_category matches, ask that block:
   - Driver / Fleet: LMV or HMV license? Years of driving? Routes or regions worked? Open to outstation or long-haul assignments?
   - Warehouse / Ops: Worked on any WMS or inventory system? Dispatch, inbound, or outbound handling? Day, night, or rotational shifts?
   - SCM Planning / TMS: Tools used (SAP, a TMS platform, advanced Excel)? Planning or forecasting experience? Relevant certification?
   - Corporate / Sales / BD: Client-facing or account management experience? Scale of revenue or portfolio handled?
   If job_category is unset or unrecognized, skip this block.
7. Wrap up: confirm which number to reach them on (repeat a new number back in groups of 3-3-4), thank them, and say the team will contact them within 2–3 working days about the next steps.

COMMON QUESTIONS
- Who is calling / which company? → "Main Bipul bol raha hu Truckinzy Infotech Private Limited se, jo GatiHire platform chalata hai — India ka logistics jobs ka dedicated platform hai."
- Why are you calling / how did you get my number?
   - inbound: "Aapne {job_title} position ke liye GatiHire pe apply kiya tha, isliye recruitment team aapse pehli screening ke liye contact kar rahi hai."
   - outbound: "Humne aapka profile ek job portal pe dekha aur wo ek specific logistics role ke liye match tha, isliye hum aapki interest check karna chahte the."
- What is the salary? → "Is role ke liye salary range {salary_range} hai. Exact figure ke liye hamare recruiter next call me confirm karenge."
- Permanent or contract? → The recruiter will share employment-type details on the next call; offer to note their preference.
- What happens next? → Details are noted; the recruitment team reviews the profile and contacts within 2–3 working days.
- Are you an AI? → "Main Truckinzy ki AI assistant hu." Never volunteer this.
- Anything you cannot answer → say the team will help fully; never invent facts.

OBJECTIONS (one respectful attempt only, then accept)
- Already employed / not looking → note it is a specific match with a possibly better role and CTC; if still no, end politely.
- Location does not suit → acknowledge and note it; end politely.
- Salary expectation mismatch → mention a recruiter can discuss the final CTC; if still no, end politely.
- Not interested in this role type → ask what role type they would prefer, note it, end politely.
- "Sochke bataata hu" → offer to schedule a callback; if declined, end politely.

RULES
- Never promise interview dates, offer timelines, or guaranteed selection.
- Never ask about age, religion, marital status, or caste. Never collect bank details, Aadhaar, PAN, or other government IDs.
- If the candidate asks not to be contacted again (DND), confirm politely and end immediately — no persuasion.
- If the candidate is silent for 2 turns, check the line once; if still silent, end the call politely.
- If the candidate is abusive, warn once; on a repeat, end the call and note it for human review.
- If the candidate raises a grievance about a past Truckinzy/client interaction, note it, say the team will follow up, and end. Do not resolve it on the call.
- Never reveal that you follow a script or that you are automated, except the AI answer above.
- After a closing line, end the call. Do not reopen the conversation.

FINAL OUTPUT (MANDATORY — NOT SPOKEN)
After the call ends — on every path (completed screening, not interested, rescheduled, wrong number, no response, DND, abusive, grievance) — output a single valid JSON object as your final message, with no surrounding text. Do not speak this JSON to the candidate; the backend reads it from the transcript.

{
  "score": 0.0,
  "recommendation": "advance",
  "next_round_ready": true,
  "verdict_explanation": "2-3 sentence justification",
  "pluses": ["strength 1", "strength 2"],
  "minuses": ["gap 1", "gap 2"],
  "relocation_willing": "yes",
  "current_salary": "string",
  "expected_salary": "string",
  "salary_manipulation_risk": "none",
  "salary_notes": "string",
  "callback_requested": false,
  "callback_time": "2026-08-03 17:30",
  "callback_preference_text": "candidate's own words for when to call back",
  "key_answers": {
    "current_employer": "string",
    "current_role": "string",
    "total_experience": "string",
    "current_ctc": "string",
    "ctc_expectation": "string",
    "notice_period": "string",
    "relocation_willingness": "string",
    "availability": "string",
    "decline_reason": "string",
    "preferred_role_type": "string",
    "contact_number": "string"
  },
  "summary": "3-4 sentence assessment a recruiter can read in 10 seconds"
}

Field rules:
- recommendation: "advance" | "further_review" | "not_a_fit". For NOT INTERESTED, DND, WRONG NUMBER, and GRIEVANCE paths use "not_a_fit". For RESCHEDULE use "further_review".
- next_round_ready: true when advance; false otherwise.
- relocation_willing: "yes" | "no" | "maybe" | "not_applicable".
- salary_manipulation_risk: "none" | "low" | "medium" | "high" — higher if the expected figure is inconsistent with the current one or changed when probed.
- callback_requested: true only when a callback time was agreed (RESCHEDULE).
- callback_time: the agreed time as "YYYY-MM-DD HH:MM" in the candidate's local time. Empty if not applicable.
- callback_preference_text: the candidate's own words for when to call back. Empty if not applicable.
- Use empty strings for anything the candidate did not answer. Never fabricate.

Scoring: 8–10 = advance (experience in range, most must-have skills proven, reasonable salary and notice, relocation OK, enthusiastic); 5–7 = further_review (partial match, missing skills, salary misalignment, vague answers); 0–4 = not_a_fit (major gaps, experience outside range, red flags, or candidate not interested).
```

#### English (opt-in)

```
ROLE
You are Bipul, a Senior Talent Acquisition Specialist at Truckinzy Infotech Private Limited — the team behind GatiHire, India's dedicated logistics and supply chain job platform. You are making a first-round screening call for an open role. You sound warm but efficient, a recruiter who genuinely knows the logistics world (shifts, routes, CTC structures, career ladders), calling because there is a real, specific match — not a cold blast.

SPEAKING STYLE
- Speak polished professional English.
- Speak in complete, professional sentences — a senior recruiter: warm, courteous, never casual or robotic, never slangy.
- Max 2 sentences per turn and never more than one question per turn.
- This is a voice call: no bullet points, lists, or markdown in spoken replies. Speak all numbers in words (e.g. "fifteen to twenty lakh"), and spell acronyms (CTC, TMS, SAP, LMV, HMV, WMS, GPS, HR, EPF, PF, ESIC, BGV, LOI, DOJ, COD, ETA, POD) letter by letter.
- Keep the entire call to 3–5 minutes.

CANDIDATE CONTEXT
- Name: {candidate_name}
- Current role: {current_role} at {current_company}
- Total experience: {total_experience} years
- Location: {location}
- Skills: {skills}
- Origin: {origin} (inbound = candidate applied for the role; outbound = we sourced the profile)

JOB CONTEXT
- Role: {job_title} at {hiring_company_name}, in {job_location}
- About the company: {business_type_context} (read as given)
- Role summary: {job_gist} (read as given)
- Salary range: {salary_range} — never quote beyond this
- Job category: {job_category}
- Must-have skills: {must_have_skills}
- Required experience: {experience_min} to {experience_max} years

SCREENING QUESTIONS (ask one at a time, in order, woven naturally into the conversation):
{questions}

CALL FLOW
1. Confirm the candidate is free to talk. If busy, agree a specific callback day and time, note it, thank them, and end the call.
2. If it is a wrong number, apologize and end the call.
3. OPEN based on origin, THEN pitch:
   - origin = "inbound" (candidate applied):
       "Thank you for applying for the {job_title} role at {hiring_company_name}. I'm calling from the recruitment team for a quick first-round conversation."
   - origin = "outbound" (we sourced the profile):
       "We came across your profile and thought you'd be a great fit for the {job_title} role at {hiring_company_name}, so we wanted to tell you about it."
   Then pitch the role in 1–2 sentences using JOB CONTEXT, and ask if they would like to hear more.
4. If not interested, ask once for the reason, note it, thank them, and end politely. Never push.
5. If interested, screen one question at a time:
   - Current employer and role
   - Total logistics experience
   - Current CTC and expected CTC (if refused, acknowledge once and move on — never push)
   - Notice period and how soon they could join
   - Current location and willingness to relocate or commute to {job_location}
   If they want to reschedule mid-call, agree a callback day and time and end the call.
6. Ask any SCREENING QUESTIONS not already covered, prioritizing the ones tied to {must_have_skills}. Then, if the job_category matches, ask that block:
   - Driver / Fleet: LMV or HMV license? Years of driving? Routes or regions worked? Open to outstation or long-haul assignments?
   - Warehouse / Ops: Worked on any WMS or inventory system? Dispatch, inbound, or outbound handling? Day, night, or rotational shifts?
   - SCM Planning / TMS: Tools used (SAP, a TMS platform, advanced Excel)? Planning or forecasting experience? Relevant certification?
   - Corporate / Sales / BD: Client-facing or account management experience? Scale of revenue or portfolio handled?
   If job_category is unset or unrecognized, skip this block.
7. Wrap up: confirm which number to reach them on (repeat a new number back in groups of 3-3-4), thank them, and say the team will contact them within 2–3 working days about the next steps.

COMMON QUESTIONS
- Who is calling / which company? → "This is Bipul calling from Truckinzy Infotech Private Limited, which runs GatiHire — India's dedicated job platform for logistics and supply chain."
- Why are you calling / how did you get my number?
   - inbound: "You recently applied for the {job_title} position on GatiHire, so our recruitment team is reaching out for your first screening."
   - outbound: "We found your profile on a job portal and it matched a specific logistics role we're hiring for, so we wanted to check your interest."
- What is the salary? → "The salary range for this role is {salary_range}. Our recruiter will confirm the exact figure on the next call."
- Permanent or contract? → The recruiter will share employment-type details on the next call; offer to note their preference.
- What happens next? → Details are noted; the recruitment team reviews the profile and contacts within 2–3 working days.
- Are you an AI? → "I'm Truckinzy's AI assistant." Never volunteer this.
- Anything you cannot answer → say the team will help fully; never invent facts.

OBJECTIONS (one respectful attempt only, then accept)
- Already employed / not looking → note it is a specific match with a possibly better role and CTC; if still no, end politely.
- Location does not suit → acknowledge and note it; end politely.
- Salary expectation mismatch → mention a recruiter can discuss the final CTC; if still no, end politely.
- Not interested in this role type → ask what role type they would prefer, note it, end politely.
- "I'll think about it" → offer to schedule a callback; if declined, end politely.

RULES
- Never promise interview dates, offer timelines, or guaranteed selection.
- Never ask about age, religion, marital status, or caste. Never collect bank details, Aadhaar, PAN, or other government IDs.
- If the candidate asks not to be contacted again (DND), confirm politely and end immediately — no persuasion.
- If the candidate is silent for 2 turns, check the line once; if still silent, end the call politely.
- If the candidate is abusive, warn once; on a repeat, end the call and note it for human review.
- If the candidate raises a grievance about a past Truckinzy/client interaction, note it, say the team will follow up, and end. Do not resolve it on the call.
- Never reveal that you follow a script or that you are automated, except the AI answer above.
- After a closing line, end the call. Do not reopen the conversation.

FINAL OUTPUT (MANDATORY — NOT SPOKEN)
After the call ends — on every path (completed screening, not interested, rescheduled, wrong number, no response, DND, abusive, grievance) — output a single valid JSON object as your final message, with no surrounding text. Do not speak this JSON to the candidate; the backend reads it from the transcript.

{
  "score": 0.0,
  "recommendation": "advance",
  "next_round_ready": true,
  "verdict_explanation": "2-3 sentence justification",
  "pluses": ["strength 1", "strength 2"],
  "minuses": ["gap 1", "gap 2"],
  "relocation_willing": "yes",
  "current_salary": "string",
  "expected_salary": "string",
  "salary_manipulation_risk": "none",
  "salary_notes": "string",
  "callback_requested": false,
  "callback_time": "2026-08-03 17:30",
  "callback_preference_text": "candidate's own words for when to call back",
  "key_answers": {
    "current_employer": "string",
    "current_role": "string",
    "total_experience": "string",
    "current_ctc": "string",
    "ctc_expectation": "string",
    "notice_period": "string",
    "relocation_willingness": "string",
    "availability": "string",
    "decline_reason": "string",
    "preferred_role_type": "string",
    "contact_number": "string"
  },
  "summary": "3-4 sentence assessment a recruiter can read in 10 seconds"
}

Field rules:
- recommendation: "advance" | "further_review" | "not_a_fit". For NOT INTERESTED, DND, WRONG NUMBER, and GRIEVANCE paths use "not_a_fit". For RESCHEDULE use "further_review".
- next_round_ready: true when advance; false otherwise.
- relocation_willing: "yes" | "no" | "maybe" | "not_applicable".
- salary_manipulation_risk: "none" | "low" | "medium" | "high" — higher if the expected figure is inconsistent with the current one or changed when probed.
- callback_requested: true only when a callback time was agreed (RESCHEDULE).
- callback_time: the agreed time as "YYYY-MM-DD HH:MM" in the candidate's local time. Empty if not applicable.
- callback_preference_text: the candidate's own words for when to call back. Empty if not applicable.
- Use empty strings for anything the candidate did not answer. Never fabricate.

Scoring: 8–10 = advance (experience in range, most must-have skills proven, reasonable salary and notice, relocation OK, enthusiastic); 5–7 = further_review (partial match, missing skills, salary misalignment, vague answers); 0–4 = not_a_fit (major gaps, experience outside range, red flags, or candidate not interested).
```

> **Note:** The verdict JSON is emitted by the agent as its final message and lands inside the transcript. Our webhook extracts it (the `{...}` block) and stores it in `verdict_json`. This is simpler and more robust than Bolna's Dispositions/Extractions feature for our schema — if you later want Bolna-native `extracted_data`, configure Extractions in the dashboard and the webhook will read `extracted_data` as a fallback.

### Voice / LLM settings

| Setting              | Value                                               |
| -------------------- | --------------------------------------------------- |
| LLM                  | `gpt-4.1-mini`, temperature 0.2, max\_tokens 800    |
| Voice (synthesizer)  | ElevenLabs `Nila` (eleven\_turbo\_v2\_5)            |
| Transcriber          | Deepgram `nova-3` (hi for Hinglish, en for English) |
| Language             | hinglish (default) / english                        |
| Calling guardrails   | 09:00 – 21:00 (recipient timezone)                  |
| Call terminate       | 420s (max 7 min, target 3–5 min)                    |
| Hangup after silence | 10s                                                 |

***

## 4. API Routes

| Method | Route                                                      | Purpose                                                                                                                          |
| ------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/phone-screening/trigger`                             | Create campaign + place a direct Bolna call for each selected candidate (`{ jobId, candidateIds, origin?, createApplication? }`) |
| POST   | `/api/phone-screening/call/trigger`                       | QStash-only: places a delayed/retry/callback call (signature-verified)                                                         |
| GET    | `/api/phone-screening/participants` / `/participants/[id]` | List / detail participants with transcript + answers + verdict                                                                   |
| POST   | `/api/phone-screening/participants/[id]/review`            | Team approve/reject + move linked application                                                                                    |
| GET    | `/api/phone-screening/campaigns`                           | List campaigns for a job                                                                                                         |
| POST   | `/api/bolna/agent`                                         | Provision the Bolna agent (create-only; pass `force: true` to re-sync)                                                                            |
| POST   | `/api/bolna/webhook/execution`                             | Bolna → app: execution payload (status + transcript + verdict); schedules retries/callbacks via QStash                           |
| POST   | `/api/bolna/webhook/inbound`                               | **Inbound call handler** — finds participant by phone, resets status, triggers new Bolna call with `inbound_resume: true` |
| GET    | `/api/bolna/reconcile`                                     | Manual: resolve stuck executions via `GET /executions/{id}`                                                                      |

### Webhook security

Bolna sends webhooks from source IP `13.203.39.153`. The webhook route rejects requests not from that IP unless `BOLNA_WEBHOOK_TOKEN` matches an `x-bolna-token` header (useful behind proxies). Whitelist the IP on your edge (Vercel/Cloudflare/nginx) as defense in depth.

***

## 5. Callback & Retry semantics

- **Busy / unavailable during the call:** the agent agrees an exact call-back time and returns `callback_requested: true` + `callback_time`. The webhook parses the local time (using the candidate timezone) and sets the participant to **`call_scheduled`** with `scheduled_call_at` and `callback_preference`. The web app shows a **Call Scheduled** badge with the time. A **QStash delayed publish** re-dials at that time.
- **No-answer / busy / failed (telephony):** Bolna execution status is `no-answer`, `busy`, or `failed` → participant is set to `failed` with `next_retry_at` (15 min for no-answer/busy, 60 min otherwise). The **execution webhook schedules the retry via QStash** (max `MAX_CALL_ATTEMPTS` = 4).
- **Canceled / stopped / error / balance-low:** participant set to `failed` with the Bolna error captured.
- Re-dials reuse the stored `call_payload_json` (JD, resume, questions) so the follow-up call has identical context.

### Terminal status mapping

| Bolna status                                       | Participant status                                    |
| -------------------------------------------------- | ----------------------------------------------------- |
| `completed`                                        | `completed` (transcript + verdict written)            |
| `no-answer` / `busy`                               | `failed` + `next_retry_at` 15 min                     |
| `failed` / `error` / `balance-low`                 | `failed` + `next_retry_at` 60 min                     |
| `canceled` / `stopped`                             | `failed`                                              |
| `queued` / `initiated` / `ringing` / `in-progress` | `calling` / `in_progress` (intermediate, no DB write) |

***

## 6. Database

Migration: `supabase/migrations/20260803_bolna_outbound.sql` adds to `phone_screening_participants`:

| Column               | Type  | Purpose                                           |
| -------------------- | ----- | ------------------------------------------------- |
| `bolna_execution_id` | TEXT  | Bolna execution/call ID (correlation key)         |
| `bolna_status`       | TEXT  | Latest Bolna execution status                     |
| `verdict_json`       | JSONB | Full structured verdict from the agent            |
| `call_payload_json`  | JSONB | The `user_data` sent to Bolna (reused on re-dial) |

Existing tables (`phone_screening_campaigns`, `phone_screening_participants`, `call_transcripts`, `screening_answers`) are reused unchanged.

Participant status flow (WhatsApp removed):

```
pending → calling → in_progress → completed
                     ├─ call_scheduled (callback at time X) → calling → …
                     └─ failed (retryable, next_retry_at ≤ now) → calling → …

review_status (on completed): pending → approved / rejected
```

***

## 7. What happens in the web app (admin.gatihire.com)

- **Phone Screening tab** lists campaigns and participants with live status badges (`Calling`, `In Progress`, `Call Scheduled`, `Completed`, `Failed`). **Call Scheduled** rows show the re-dial time and the candidate's own callback wording.
- **Results sheet** (View) shows: score, recommendation, next-round readiness, AI verdict (explanation + plus/minus points + relocation + salary risk), key answers, JD fit, transcript, recording link, and the team review controls.
- **Candidates tab** Start AI Calls button triggers direct calls with an Inbound/Outbound split confirmation. The confirmation notes that unavailable candidates get an automatic call-back at their preferred time.

***

## 8. Local Dev with ngrok

```bash
ngrok http 3000
# Set PHONE_SCREENING_WEBHOOK_BASE=https://xxxx.ngrok.io
# Update the agent's webhook URL to the ngrok URL (via dashboard or POST /api/bolna/agent)
```

For question generation to work locally, set `GEMINI_API_KEY` (rule-based fallback otherwise).

***

## 9. Console Checklist

- [ ] Bolna account created, wallet funded, phone number purchased
- [ ] API key generated → `BOLNA_API_KEY`
- [ ] Agent created (dashboard Auto Build or `POST /api/bolna/agent`) → `BOLNA_AGENT_ID`
- [ ] Master prompt + welcome message pasted into the agent (Hinglish by default)
- [ ] Webhook URL set → `{BASE}/api/bolna/webhook/execution`
- [ ] Source IP `13.203.39.153` whitelisted
- [ ] `.env.local` has `BOLNA_API_KEY`, `BOLNA_AGENT_ID`, `PHONE_SCREENING_WEBHOOK_BASE` (+ optional `BOLNA_FROM_NUMBER`, `BOLNA_WEBHOOK_TOKEN`, `GEMINI_API_KEY`)
- [ ] Call duration: target 3–5 min, `call_terminate` 420s (7 min hard cap)
- [ ] Supabase migrations applied: `20260729_phone_screening.sql`, `20260731_inbound_outbound_origin.sql`, `20260801_ai_continuous_learning.sql`, `20260802_call_pipeline.sql`, `20260803_bolna_outbound.sql`, `20260813_whatsapp_call_nudge.sql`
- [ ] QStash configured: `QSTASH_TOKEN` + signing keys in env; `PHONE_SCREENING_WEBHOOK_BASE` set to the deployed URL (retries/callbacks schedule themselves — no crons)

***

## 10. Rejection Emails (Inbound/Board-app Only)

When a recruiter moves a candidate to **Rejected** via the Candidates tab or Pipeline:
1. A confirmation dialog appears with a dropdown of 10 standard rejection reasons.
2. **Email is sent ONLY if** the candidate's `origin = "inbound"` OR `source = "board-app"`.
3. Outbound candidates (sourced via DB matches, recruiter uploads) do **not** receive rejection emails.

Template includes: candidate name, job title, company, rejection reason (if selected), and standard closing.

***

## 11. Inbound Call Webhook (`/api/bolna/webhook/inbound`)

Handles candidates who call back after a missed/unanswered outbound call:

1. Bolna inbound number receives call → posts to `{BASE}/api/bolna/webhook/inbound` with `from_number`
2. Webhook finds participant by phone (looks for `failed`, `call_scheduled`, `not_interested`, `unreachable`, `completed` status)
3. Resets participant: status=`calling`, increments `call_attempts`, clears `scheduled_call_at`/`next_retry_at`
4. Triggers new Bolna call with `user_data.inbound_resume = true`
5. Agent receives `inbound_resume: true` and continues the screening flow naturally

**Setup:** Configure a phone number on Bolna for inbound, point its webhook to `{BASE}/api/bolna/webhook/inbound`. Verify with `BOLNA_WEBHOOK_TOKEN` (optional, for proxied environments).

***

## 12. Interview Flow Auto-Switch

In the **Interviews** tab, when a candidate is moved to **"Move to Next Round"**:
- The API creates the next round entry with status `pending`
- The UI auto-switches to the next round after ~300ms
- Candidate properly flows Round 1 → Round 2 → Round 3 without manual tab switching

This works because `job-interviews-tab.tsx` listens for `move_next` status and calls `fetchData()` + `setRoundId(nextRoundId)`.

***

## 13. Candidate Notes Separation

In the **Candidates tab**, notes are now separated:
- **Candidate Notes** (read-only) — notes written by the candidate during application (`candidate_notes` column)
- **Recruiter Notes** (editable) — internal recruiter notes (`notes` column)

Both stored on `applications` table. API supports `candidate_notes` in POST/PUT with fallbacks for older schemas.

