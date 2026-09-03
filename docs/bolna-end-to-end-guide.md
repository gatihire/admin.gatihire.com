# Bolna — End-to-End Configuration Guide (Inbound + Outbound)

> **Purpose:** Exactly what to configure on your Bolna account so the AI screening agent
> handles **both** Inbound and Outbound candidates correctly, and whether you need the
> WhatsApp (Aisensy) flow alongside Bolna.

---

## 0. The 30-second answer

1. **Is the prompt you pasted enough to handle both cases?**
   **No, not fully.** Your prompt references `Origin: {origin}` in CANDIDATE CONTEXT, but it
   never tells the agent to *open differently* for inbound vs outbound. Section 3 below gives
   the exact lines to add so the agent does the right thing:
   - **Inbound** (applied) → open with "thanks for applying".
   - **Outbound** (sourced) → open with "we found your profile / informing them".

2. **Do you need the WhatsApp flow as well?**
   **It's optional — you now choose per batch.** The Start AI Calls dialogs (Candidates tab,
   DB Matches, New Screening) include a **Direct call / WhatsApp nudge** toggle:
   - **Direct call** (`call_now`) → pure Bolna, no WhatsApp needed.
   - **WhatsApp Nudge → Auto Call** (`whatsapp_first`) → Aisensy WhatsApp nudge → **automated** Bolna voice call when candidate responds. Requires the Aisensy configuration (Section 4.2).
   Bolna is always the voice provider, including scheduled call-backs and retries. Plivo is
   only used to buy the phone number — it is not a WhatsApp or voice provider in this system.

3. **Rejection emails:** Sent automatically **only for inbound/board-app candidates** when you move them to "Rejected" (with dropdown reason). Outbound (sourced) candidates do not receive rejection emails.

4. **Inbound calls:** When a candidate calls back after a missed/unanswered call, the `POST /api/bolna/webhook/inbound` webhook finds the participant by phone, resets status, and triggers a new Bolna call with `inbound_resume: true` — the agent continues the screening flow.

---

## 1. Two flows that exist in the code — know which you're running

```
FLOW A — WhatsApp Nudge → Auto Call (callMode: "whatsapp_first")
  Start AI Calls → "WhatsApp Nudge → Auto Call" toggle
    -> POST /api/phone-screening/trigger
    -> orchestrateScreening: send Aisensy WhatsApp nudge (candidate taps "Call me now")
    -> /api/whatsapp/webhook/aisensy (classifies reply)
    -> scheduleBolnaCall() -> QStash -> placeBolnaCall()  [Bolna voice]
    -> webhook /api/bolna/webhook/execution writes verdict + schedules call-backs

FLOW B — Bolna direct (callMode: "call_now")     <- default toggle selection
  Start AI Calls → "Direct Call (Skip WhatsApp)" toggle
    -> POST /api/phone-screening/trigger
    -> orchestrateScreening: placeBolnaCall() directly (no WhatsApp)
    -> Bolna agent runs the prompt (this guide's Section 3)
    -> webhook /api/bolna/webhook/execution writes verdict + schedules call-backs

FLOW C — Inbound call (candidate calls back)
  Candidate dials the Bolna inbound number
    -> POST /api/bolna/webhook/inbound (finds participant by phone)
    -> placeBolnaCall() with inbound_resume: true
    -> webhook /api/bolna/webhook/execution writes verdict + schedules call-backs
```

Every admin entry point sends a `callMode` — the per-click toggle decides which flow runs:
- `components/job-candidates-tab.tsx` → confirmation dialog toggle + per-candidate "Nudge" dropdown
- `components/job-db-matches-tab.tsx` → segmented toggle next to Start AI Call
- `components/phone-screening-candidate-selector.tsx` → footer toggle in the dialog

**Provider map:** Aisensy = WhatsApp only. Bolna = voice only (all flows). Plivo = number
purchase only (not in the live call/WhatsApp path).

Every admin entry point sends a `callMode` — the per-click toggle decides which flow runs:
- `components/job-candidates-tab.tsx` → confirmation dialog toggle
- `components/job-db-matches-tab.tsx` → segmented toggle next to Start AI Call
- `components/phone-screening-candidate-selector.tsx` → footer toggle in the dialog

**Provider map:** Aisensy = WhatsApp only. Bolna = voice only (both flows). Plivo = number
purchase only (not in the live call/WhatsApp path).

---

## 2. Bolna account setup (one-time)

1. Sign up at <https://platform.bolna.ai>.
2. Buy a phone number (Indian numbers → Plivo/Vobiz; US → Twilio). See
   [Buy Phone Numbers](https://www.bolna.ai/docs/guides/inbound/buying-phone-numbers.md).
3. Generate an **API key**: Dashboard → Account / API settings → create token.
4. Create the **agent** (dashboard *Auto Build*, or code-provision via `POST /api/bolna/agent`).
5. Configure the agent with the **master prompt** (Section 3), **welcome message**, voice, and webhook.
6. Set the agent's **webhook** ("Push all execution data") to:

   ```
   https://admin.gatihire.com/api/bolna/webhook/execution
   ```

7. Whitelist Bolna's source IP **`13.203.39.153`** on your edge (Vercel/Cloudflare/nginx).

> **Code-provisioning shortcut:** `POST /api/bolna/agent` **creates** the agent once with the
> **Bipul** prompt (with the origin-branch) baked into `lib/bolna.ts`. Once `BOLNA_AGENT_ID` is
> set the endpoint is create-only — it will **never overwrite** your dashboard edits. The
> **Bolna dashboard is the live editor** for prompt/voice/guardrails after creation; calls
> trigger the agent by `agent_id` and use whatever prompt is configured there. Pass
> `"force": true` only if you deliberately want to re-sync from code (wipes dashboard prompt edits).

---

## 3. The Bolna master prompt — with inbound/outbound branching

### What's missing in your pasted prompt

Your prompt is correct everywhere *except* the spoken opening. It must explicitly branch:

**ADD this to CALL FLOW step 3** (replace the current "Pitch the role..." line):

```
3. OPEN based on origin, THEN pitch:
   - origin = "inbound" (candidate applied):
       "Thank you for applying for the {job_title} role at {hiring_company_name}.
        I'm calling from the recruitment team for a quick first-round conversation."
   - origin = "outbound" (we sourced the profile):
       "We came across your profile and thought you'd be a great fit for the
        {job_title} role at {hiring_company_name}, so we wanted to tell you about it."
   Then pitch the role in 1-2 sentences using JOB CONTEXT and ask if they'd like to hear more.
```

**REPLACE the "Why are you calling" answer** in COMMON QUESTIONS with:

```
- Why are you calling / how did you get my number?
   - inbound: "You recently applied for the {job_title} position on GatiHire,
     so our recruitment team is reaching out for your first screening."
   - outbound: "We found your profile on a job portal and it matched a specific
     logistics role we're hiring for, so we wanted to check your interest."
```

> Keep everything else in your pasted prompt (SPEAKING STYLE, JOB CONTEXT, SCREENING
> QUESTIONS, OBJECTIONS, RULES, and the mandatory FINAL OUTPUT JSON). The JSON contract is
> exactly what the webhook expects (`score`, `recommendation`, `callback_requested`,
> `callback_time`, `callback_preference_text`, `key_answers`, etc.).

### Suggested voice / LLM settings

| Setting              | Value                                                  |
| -------------------- | ------------------------------------------------------ |
| LLM                  | `gpt-4.1-mini`, temperature 0.2, max_tokens 800        |
| Voice (synthesizer)  | ElevenLabs `Nila` (eleven_turbo_v2_5)                  |
| Transcriber          | Deepgram `nova-3` (hi for Hinglish / en for English)   |
| Language             | `hinglish` (default) / `english`                       |
| Calling guardrails   | 09:00 – 21:00 (recipient timezone)                     |
| Call terminate       | 420s (max 7 min, target 3–5 min)                       |
| Hangup after silence | 10s                                                    |

---

## 4. Do you need the WhatsApp flow too?

### If you want PURE Bolna direct calls

- **WhatsApp/Aisensy is NOT needed.** The whole call is handled by Bolna.
- Choose the **Direct Call (Skip WhatsApp)** toggle when starting AI calls.
- Retries and call-backs are already Bolna-native (QStash → `placeCallForParticipant` → `placeBolnaCall`).

### If you use the WhatsApp Nudge → Auto Call toggle

- Then **yes, you must configure Aisensy as well**:
  - **Aisensy** (WhatsApp nudge templates) — `AISENSY_API_KEY`, `AISENSY_SENDER_ID`, `AISENSY_*_TEMPLATE`
  - The reply webhook `{BASE}/api/whatsapp/webhook/aisensy` classifies the candidate's reply and
    schedules the Bolna call.
  - Plivo is **not** part of this flow — it is only the phone-number vendor (you buy the number
    there once and use it as `BOLNA_FROM_NUMBER`). `PLIVO_*` / `PLIVO_AGENT_ID` are legacy/dormant.
  - In this mode the actual voice call is still placed by **Bolna**, so you still need Bolna configured.

### If you want inbound call handling

- **Bolna inbound webhook** at `/api/bolna/webhook/inbound` handles candidates calling back.
- Configure a phone number on Bolna for inbound and point it to this webhook.
- The webhook finds the participant by phone, resets status, and triggers a new Bolna call.
- The agent receives `inbound_resume: true` in userData and continues the screening flow.

---

## 4.1 WhatsApp nudge copy — paste into Aisensy templates

These two templates drive Flow A. The code sends the candidate name, job title, location,
salary budget and job link as template params **in this exact order**:

```
[ {{1}} candidateName, {{2}} jobTitle, {{3}} location, {{4}} salaryBudget, {{5}} jobLink ]
```

### Template 1 — OUTBOUND (cold outreach) → `AISENSY_OUTREACH_TEMPLATE`

Bipul introduces the role; the candidate has not applied. Include Quick Replies
`[ Interested ] [ Not interested ]`.

> Hi `{{1}}`, this is **Bipul** from the recruitment team at **Gati**. We came across your
> profile for the **`{{2}}`** role (`{{3}}`, budget `{{4}}`). Would you be interested in a quick
> AI screening call to discuss it? You can see the full details here: `{{5}}`. Reply
> *Interested* or *Not interested*.

### Template 2 — INBOUND (shortlisted applicant) → `AISENSY_SHORTLIST_TEMPLATE`

The candidate applied; Bipul confirms shortlisting before the screening call.

> Hi `{{1}}`, this is **Bipul** from **Gati**. Congratulations — your application for the
> **`{{2}}`** role (`{{3}}`, budget `{{4}}`) has been shortlisted! We'd love to schedule your AI
> screening call. Details here: `{{5}}`. Reply *Interested* or *Not interested*.

### Nudge template must stay consistent with the voice prompt

The WhatsApp copy and the Bolna prompt (`lib/bolna.ts`) must agree on:
- **Who is calling** — always "Bipul from Gati".
- **The origin-branch** — outbound nudge = "we came across your profile"; inbound nudge =
  "you've been shortlisted". The Bolna CALL FLOW step 3 opens the same way so the candidate
  hears a consistent story from WhatsApp → voice.
- **Job facts** — the same title/location/budget that `user_data` carries into the prompt.

### Replies the webhook understands

`/api/whatsapp/webhook/aisensy` classifies the candidate's free-text or Quick Reply:

| Reply (approx) | Action |
|---|---|
| `interested` / `yes` | status `interested`; Aisensy sends the schedule-options template |
| `not interested` | status `not_interested`; stop, no calls/nudges |
| `call me now` | status `call_scheduled`; Bolna call in ~1 min |
| `in 10 minutes` | Bolna call in ~10 min |
| `today evening` | Bolna call at next 18:00 IST |

---

## 5. Environment variables (add to `.env.local`)

```env
# Bolna — REQUIRED for Flow B (direct calls)
BOLNA_API_KEY=your-bolna-api-key
BOLNA_AGENT_ID=your-bolna-agent-id

# Optional
BOLNA_FROM_NUMBER=+918035739222        # from-number for outbound calls
BOLNA_WEBHOOK_TOKEN=                   # extra webhook security (x-bolna-token header)

# Webhook base (your deployed app, or ngrok for local testing)
PHONE_SCREENING_WEBHOOK_BASE=https://admin.gatihire.com

# QStash — REQUIRED for call-backs / retries
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=

# Only for Flow A (WhatsApp-first): Aisensy
AISENSY_API_KEY=
AISENSY_SENDER_ID=
AISENSY_TEMPLATE_ID=
AISENSY_OUTREACH_TEMPLATE=          # outbound nudge (cold outreach)
AISENSY_SHORTLIST_TEMPLATE=         # inbound nudge (shortlisted applicant)
AISENSY_CALL_NUDGE_TEMPLATE=
AISENSY_MISSED_CALL_TEMPLATE=
AISENSY_SCHEDULE_OPTIONS_TEMPLATE=
AISENSY_REMINDER_TEMPLATE=
AISENSY_CAMPAIGN_NAME=Job_Recruitment
AISENSY_SOURCE=

# Plivo — NOT a runtime dependency. Used only to buy the phone number once.
# The purchased number becomes BOLNA_FROM_NUMBER. PLIVO_* are legacy/dormant code.
# PLIVO_AUTH_ID=
# PLIVO_AUTH_TOKEN=
# PLIVO_VOICE_NUMBER=
# PLIVO_WHATSAPP_NUMBER=
# PLIVO_AGENT_ID=

# Question generation (JD-specific screening questions)
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.1-flash-lite-preview
```

---

## 6. Verification checklist (console)

- [ ] Bolna account created, wallet funded, phone number purchased
- [ ] API key generated → `BOLNA_API_KEY`
- [ ] Agent created with the master prompt (Section 3) + welcome message
- [ ] Webhook set → `{BASE}/api/bolna/webhook/execution`
- [ ] **Inbound webhook set** → `{BASE}/api/bolna/webhook/inbound` (if using inbound calls)
- [ ] Source IP `13.203.39.153` whitelisted
- [ ] `.env.local` has `BOLNA_API_KEY`, `BOLNA_AGENT_ID`, `PHONE_SCREENING_WEBHOOK_BASE`
- [ ] `QSTASH_TOKEN` + signing keys set (call-backs/retries)
- [ ] Admin buttons offer the **Direct Call (Skip WhatsApp)** / **WhatsApp Nudge → Auto Call** toggle
- [ ] Per-candidate "Nudge" dropdown in Candidates tab shows both options
- [ ] Supabase migrations applied (see `docs/bolna-outbound-screening.md` Section 9)

---

## 7. Rejection emails (inbound/board-app only)

When a recruiter moves a candidate to **Rejected**, a confirmation dialog shows a dropdown with
10 standard reasons (Not qualified, Salary mismatch, Location mismatch, Experience mismatch,
Skills mismatch, Culture fit, No response/ghosted, Candidate withdrew, Duplicate, Other).
**Email is sent ONLY for:**
- `origin = "inbound"` (candidate applied)
- `source = "board-app"` (board application)

Outbound candidates (sourced by us via DB matches, recruiter uploads) do **not** receive
rejection emails — they were cold-sourced and never "applied".

---

## 8. Interview flow

When a candidate in the **Interviews** tab is moved to **"Move to Next Round"**, the UI
auto-switches to the next interview round after a short delay. Candidates properly flow
Round 1 → Round 2 → etc. without manual tab switching.

---

## 9. How the origin tag flows into the call (end-to-end)

```
Upload / re-tag (admin UI)
  -> applications.origin = "inbound" | "outbound"

Start AI Calls (mixed selection: confirmation shows "3 Inbound, 2 Outbound")
  -> choose Direct Call (call_now) or WhatsApp Nudge → Auto Call (whatsapp_first)
  -> POST /api/phone-screening/trigger  { jobId, candidateIds, callMode }
  -> trigger route reads each application's origin (applications.origin)
  -> orchestrateScreening -> placeBolnaCall(user_data)
  -> user_data.origin = per-candidate value   <-- injected into {origin} in the prompt
  -> Bolna agent reads {origin} and branches the intro (Section 3)
```

That's it — one configuration (your agent's prompt) controls both greeting styles, driven by
the origin tag you set at upload or when re-tagging.

> **Agent identity:** the master prompt now uses **Bipul** (English + Hinglish) with the
> origin-branch baked in — matching `lib/bolna.ts`. `POST /api/bolna/agent` provisions/syncs it.
>
> For the full combined WhatsApp + Bolna architecture and an honest assessment of the approach,
> see `docs/call-pipeline-architecture.md`.
