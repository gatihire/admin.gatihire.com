# Screening Automation — Ops Runbook (for you, the HR side)

What the system does and exactly what **you** do, step by step, on your side. Companion to
[`screening-automation-flow.md`](screening-automation-flow.md) which explains how it works end to end.

---

## Part A — One-time setup (do this once)

### A1. Push the database migration

```bash
cd admin.gatihire.com
npx supabase link --project-ref dmnypjxbfbjegraylspt
npx supabase db push
```

Restart your local dev server (`npm run dev`) afterward so the new WhatsApp columns load.

### A2. Add env vars

Create/edit `admin.gatihire.com/.env.local` and set:

| Var | Value / where to get it |
|---|---|
| `BOLNA_API_KEY` | Bolna dashboard (project API key) |
| `BOLNA_AGENT_ID` | Bolna "Gati Hire Screening" agent ID |
| `BOLNA_FROM_NUMBER` | Bolna outbound caller number (one you own/registered) |
| `PHONE_SCREENING_WEBHOOK_BASE` | Internet-visible base URL. Local: use a tunnel (e.g. `ngrok http 3000`). Deployed: `https://<your-vercel-domain>` |
| `BOLNA_WEBHOOK_TOKEN` | Your own secret; same value goes in the Bolna webhook config |
| `AISENSY_API_KEY` | Aisensy dashboard → API settings |
| `AISENSY_CAMPAIGN_NAME` | Fallback template name (e.g. `Job_Recruitment`) |
| `AISENSY_SOURCE` | Aisensy sender ID/number (optional) |
| `AISENSY_CALL_NUDGE_TEMPLATE` | "We'll call you" template name (see A4) |
| `AISENSY_MISSED_CALL_TEMPLATE` | "We missed you — reply 1 for callback" template name |
| `PEAKAI_EMAIL` + `PEAKAI_PASSWORD` | `build.thepeakai.com` credentials (or `PEAKAI_ACCESS_TOKEN`) |
| `QSTASH_TOKEN` | Upstash QStash → generate an API token (schedules the calls) |
| `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` | Upstash QStash → signature keys (verifies the scheduled-call webhook) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase project → Settings → API |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase project → Settings → API |

### A3. Create + provision the Bolna agent

1. In Bolna create an agent **"Gati Hire Screening"** — prompt is maintained in
   `lib/bolna.ts` (`BOLNA_AGENT_ID` must match).
2. Configure its **execution webhook** to:
   `{PHONE_SCREENING_WEBHOOK_BASE}/api/bolna/webhook/execution` with header
   `Authorization: Bearer {BOLNA_WEBHOOK_TOKEN}`.
3. **Inbound call webhook (optional):** if you want candidates to call back after missed calls,
   configure an inbound number on Bolna → webhook to:
   `{PHONE_SCREENING_WEBHOOK_BASE}/api/bolna/webhook/inbound`.
4. Confirm the outbound number (`BOLNA_FROM_NUMBER`) is active and voice-verified.

### A4. Create the Aisensy WhatsApp templates (2)

In Aisensy → Templates, create two **approved** (WhatsApp Business) templates:

**1. Call nudge** — name it exactly `AISENSY_CALL_NUDGE_TEMPLATE`'s value. Suggested body:
> Hi `{{1}}`, `{{2}}` is hiring for `{{3}}`. Our recruiter will call you shortly to take this forward.

Params order matters — the code sends `[candidateName, jobTitle, companyName]` → `{{1}}` name, `{{2}}`
job title, `{{3}}` company.

**2. Missed-call nudge** — value of `AISENSY_MISSED_CALL_TEMPLATE`. Suggested body:
> Hi `{{1}}`, we missed you. Reply 1 and our recruiter will call you back about the `{{2}}` role at `{{3}}`.

Same param order. Both must pass **template approval** before Aisensy will deliver them.

### A5. Webhook (optional but useful)

In Aisensy, if delivery webhooks are supported, point them at
`{PHONE_SCREENING_WEBHOOK_BASE}/api/whatsapp/webhook/aisensy` to record
`sent/delivered/read` against each participant. Best-effort — safe to skip.

### A6. Enable PeakAI

Contact `studio@thepeakai.com` to enable API access on your account, then put
credentials in env (A2). Without it, LinkedIn sourcing still works but phones/emails
won't be enriched.

### A7. Scheduling — QStash (no crons at all)

There are **no cron jobs** in this setup. Every delayed action is a **QStash message** that
Upstash delivers to your endpoint exactly when due, and the recipient webhook verifies the
signature with the two signing keys:

| Event | Who schedules it | Fires at |
|---|---|---|
| Nudge → call | `lib/scheduled-call.ts` right after the nudge succeeds | +20 min |
| Retry of a failed call | Bolna execution webhook (terminal failure) | +15 min (no-answer/busy), else +60 min |
| HR-scheduled / callback calls | `schedule` route or the callback path in the execution webhook | agreed time |
| Missed-call nudge | delivered immediately inside the execution webhook (not a delay) | on failure |

`PHONE_SCREENING_WEBHOOK_BASE` must be the **deployed, internet-visible** URL (e.g.
`https://<your-vercel-domain>`) because QStash calls `POST /api/phone-screening/call/trigger` on
it. On Vercel **Hobby** this works fine — there's no Pro requirement anymore. Free QStash tier is
plenty for these volumes (each candidate generates a handful of messages, some just a couple).

---

## Part B — Your normal daily workflow (what & how)

### B1. Post a job

- Dashboard → **Jobs → Create job** (`CreateJobDialog`).
- Fill title, description, **category**, employment type, salary. These feed the AI
  call script (job gist) and the matching engine.
- After creation, you'll see: **DB Matches**, **AI Screenings**, **Candidates**, etc. tabs.

### B2. Source candidates

Pick any combination:

- **Upload resumes** → candidates parsed automatically.
- **DB Matches** tab → shows `X callable of Y total` — candidates already in your
  DB with a phone who haven't applied or been screened for this job. Non-callable
  ones are tagged (No phone / Already in pipeline).
- **LinkedIn / Juicebox import** → import profiles; PeakAI enriches them with
  phone + work/personal email (used for WhatsApp + call). Enrichment status shows
  on the profiles tab.

### B3. Launch AI screening

- **From DB Matches:** select callable candidates → **Start AI Call**. This is the
  **outbound** flow. Choose **WhatsApp Nudge → Auto Call** (candidate gets WhatsApp first,
  then automated Bolna call when they opt in) or **Direct Call (Skip WhatsApp)** (Bolna calls
  immediately). Nudge failures auto-fall back to a direct call.
- **From Candidates tab:** **Start AI Calls** → pick applicants → calls them
  **directly** (`call_now`) since applicants expect the call. Same Direct / WhatsApp toggle.
- **Per-candidate nudge:** in the Candidates tab, each card has a **Nudge** dropdown with
  **WhatsApp Nudge → Auto Call** and **Direct Call (Skip WhatsApp)**.
- The trigger reports `nudgeSent / callsTriggered / callsFailed / skippedNoPhone`.

### B3b. Inbound calls (candidates calling back)

- If you configured the inbound number (A3 step 3), candidates who call back after a missed
  or unanswered call will trigger a new Bolna call automatically.
- The webhook finds the participant by phone, resets status to `calling`, increments
  attempts, and triggers Bolna with `inbound_resume: true` — the agent continues screening.
- No manual action needed; the participant row will show a new `calling` status.

### B4. Watch the funnel

- **Pipeline** (`job-candidates-tab.tsx`): statuses **WhatsApp Sent → Calling →
  Completed / Unreachable / Not Interested / Failed / Call Scheduled**. Rows in
  WhatsApp Sent have a **Call Now** button to skip the 20-min wait.
- **AI Screenings** tab polls every 5s; campaign cards show done/active/failed.
- Missed calls (no answer) get **one** WhatsApp missed-call nudge (sent by the execution webhook
  at the moment the call fails), then retries fire on QStash's 15/60-min schedule until
  `MAX_CALL_ATTEMPTS` (4) — then auto-stops.
- **Inbound calls:** if a candidate calls back, they'll appear as `calling` again with a new
  attempt count.

### B5. Review (human gate)

- Open the **results sheet** for a campaign: per candidate **score /10**,
  recommendation, full transcript, Q&A, verdict.
- Candidates land in **Pending HR Review** — nothing auto-advances past you.
- Card shows **AI: Advance / Further review / Not a fit** + score. You decide:
  **Approve** → auto-moved to the next stage (Interview / Shortlist / Pending HR Review);
  **Reject** → **Rejected with reason** (dropdown: Not qualified, Salary mismatch, Location
  mismatch, Experience mismatch, Skills mismatch, Culture fit, No response/ghosted,
  Candidate withdrew, Duplicate, Other).
- **Rejection emails:** sent **automatically only for inbound/board-app candidates** when you
  select Rejected with a reason. Outbound (sourced) candidates do not receive emails — they
  were cold-contacted and never "applied".

### B6. Shortlist + share with client

### B6. Shortlist + share with client

- Approved, reviewed candidates reach **Shortlist**. Header stat shows the count and
  the **Share Shortlist** button lights up.
- **Generate link** → get a no-login client URL (`/shortlist/<token>`, 30-day expiry).
  Client sees match %, AI verdict, score /10 and can **Approve** (→ Interview) or
  **Pass** (→ Rejected, with reason). Decisions show as **Client: Approved / Client: Passed**
  badges on your cards.

### B7. Continue normally

Interviews → Offer → Hired/Rejected, exactly as today.

---

## Part C — Verify / debug when something looks off

| Symptom | Check |
|---|---|
| No nudge sent | Is `AISENSY_API_KEY` set? Is the template **approved** in Aisensy? Does the candidate have a phone (enriched)? Look for `nudgeSent` in the trigger response / server logs. |
| Nudge sent, no call after 20 min | QStash: is `QSTASH_TOKEN` set and the publish logged in Upstash dash? Was `PHONE_SCREENING_WEBHOOK_BASE` a public URL at nudge time? Check the participant's `whatsapp_sent_at` + QStash dashboard for the delayed delivery. |
| Calls failing / retries looping | `BOLNA_*` env correct? Agent provisioned? Note max 4 attempts — confirm `call_attempts`/`bolna_status` on the participant. |
| Webhook not updating status | `PHONE_SCREENING_WEBHOOK_BASE` must be the exact public URL; `BOLNA_WEBHOOK_TOKEN` must match; `call/trigger` returns 401 if QStash signing keys mismatch. |
| Enrichment stuck "pending" | PeakAI creds/env set and API enabled (A6). |
| Client link broken/expired | Token expiry (default 30 days) passed → regenerate a new link from the Shortlist dialog. |

---

## Key endpoints (for manual pokes)

- `POST /api/phone-screening/trigger` — launch campaign (`{jobId, candidateIds, origin, createApplication, callMode: "whatsapp_first"|"call_now"}`)
- `POST /api/phone-screening/call/trigger` — **QStash-only** endpoint; places the delayed call (signature-verified, no auth needed otherwise)
- `POST /api/phone-screening/call-now` — `{participantId}` skip-the-wait call (up to a max of the onboarding retries)
- `POST /api/phone-screening/schedule` — `{participantId, scheduledAt, timezone}` HR-authored callback
- `POST /api/phone-screening/participants/[id]/review` — `{decision, stage, reason}`
- `POST /api/whatsapp/webhook/aisensy` — Aisensy delivery status (webhook target)
- `POST /api/bolna/webhook/execution` — Bolna execution lifecycle (webhook target)
- `POST /api/bolna/webhook/inbound` — **Inbound call handler** (finds participant by phone, re-triggers Bolna)
