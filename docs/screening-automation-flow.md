# GatiHire AI Screening & Candidate Journey Automation — End-to-End Flow

The automated candidate pipeline for **GatiHire** (Truckinzy): source → AI fit-analysis → WhatsApp
context outreach → opt-in scheduled AI screening call → HR review → client-approved shortlist →
interviews → offer → hiring.

Design principle (from the founder): **"WhatsApp sets context, the call does the screening."**
AI calls are cut in seconds by candidates who have no idea who is calling — so every call is
preceded by WhatsApp that tells the candidate the role (title, location, salary budget, link) and
that an AI screening call is coming. **There is no blind auto-call** — a call happens only after the
candidate opts in (Interested → pick a time) or when HR hits Call Now.

---

## 1. Purpose & actors

| Actor | Role |
|---|---|
| **HR recruiter** | Drives sourcing, picks source tags, monitors the funnel, reviews AI calls, shares shortlist |
| **GatiHire app** | Parses resumes, computes DB matches, runs AI fit analysis, orchestrates WhatsApp + calls, stores everything in Supabase |
| **Gemini (LLM)** | CV↔JD fit analysis (score + pros + misses), JD questions, call-quality learning |
| **Aisensy** (WhatsApp) | Sends context outreach, schedule-options, reminder/missed/abandon nudges; receives button replies |
| **QStash** (Upstash) | Event-driven delayed execution: nudges, human escalation, scheduled AI calls (no crons) |
| **PeakAI** | LinkedIn contact enrichment (phone / work & personal email) for sourced profiles |
| **Bolna agent** ("Gati Hire Screening") | Places + runs the AI screening phone call, returns transcript + verdict |
| **Client** | Receives the shortlist email, opens the tokenized link, approves/passes each candidate |
| **Tzy recruiter + Account Manager** | CC'd on the shortlist email; the human fallback for unresponsive outbound candidates |

---

## 2. End-to-end map

```
 POST JOB → SOURCE → FIT-ANALYSE → WHATSAPP OUTREACH → OPT-IN SCHEDULE → AI CALL → HR REVIEW → SHORTLIST EMAIL → CLIENT APPROVE → INTERVIEW → OFFER → JOIN

 ┌─ 1. Post job (title, JD, category, salary, city, source default)───────────┐
 └───────────────────────────────┬────────────────────────────────────────────┘
                                 ▼
 ┌─ 2. Source candidates ─────────────────────────────────────────────────────┐
 │  a) Upload resumes   b) DB Matches   c) Juicebox/LinkedIn (+ PeakAI enrich)│
 │  ⚠ source tag is REQUIRED (portal / other) → feeds sourcing analytics      │
 └───────────────────────────────┬────────────────────────────────────────────┘
                                 ▼
 ┌─ 3. AI fit analysis (Gemini, on-demand + cached) ──────────────────────────┐
 │  CV vs JD → fit_score (0-100) + pros + misses + interview probes            │
 │  candidates RANKED by fit in the sourcing tab                               │
 └───────────────────────────────┬────────────────────────────────────────────┘
                                 ▼
 ┌─ 4. WhatsApp context outreach (Aisensy) ────────────────────────────────────┐
 │ 4.1 Outbound: title + location + salary budget + job link                  │
 │ 4.2 Inbound : "shortlisted — pick a time"                                  │
 │     + [ Interested ] [ Not interested ]  ← button replies via webhook      │
 └──────────────┬──────────────────────────────────────────────────────────────┘
                │
     Interested │ Not interested ─────────► status not_interested (done)
                ▼
 ┌─ 5. Schedule options msg: [ Call me now ] [ In 10 min ] [ Today evening ] ──┐
 │  choice sets scheduled_call_at → QStash fires the call at that time        │
 └──────────────┬──────────────────────────────────────────────────────────────┘
                ▼ (or HR "Call Now" / schedule route)
 ┌─ 6. AI screening call (Bolna) ─────────────────────────────────────────────┐
 │  verdict JSON: score/10 · pass/fail/reschedule/unreachable/not interested  │
 │  retries 15/60 min (max 4) · missed-call nudge · mid-call abandon nudge    │
 └──────────────┬──────────────────────────────────────────────────────────────┘
                ▼
 ┌─ 7. Pending HR Review (Approve → next stage / Reject) ─────────────────────┐
 └──────────────┬──────────────────────────────────────────────────────────────┘
                ▼
 ┌─ 8. Shortlist → EMAIL client (CC Tzy recruiter + AM) + tokenized link ─────┐
 └──────────────┬──────────────────────────────────────────────────────────────┘
                ▼
 ┌─ 9. Client approve/pass on public link (human, Phase 1) → interview/offer ─┐
 └────────────────────────────────────────────────────────────────────────────┘

 NON-RESPONDERS (outbound, no reply to outreach):
  t+4h  WhatsApp reminder nudge #1  (QStash)
  t+8h  → needs_manual_followup = true → human recruiter queue  (NO AI call)
```

---

## 3. Stage 1 — Post job

- `CreateJobDialog` → `POST /api/jobs`. Title, description, **category**, employment type, salary
  min/max/type, city, and — for the shortlist email — **recruiter email + account manager email**
  (CC recipients) and client contact email on the client.
- Source (job origin) and sourcing defaults recorded here.

---

## 4. Stage 2 — Source candidates (source tag REQUIRED)

- **Upload resumes** → parsed via `lib/resume-parser.ts`, `resume_text` stored on the candidate.
- **DB Matches** → `job_match_runs` / `job_matches`; header shows `X callable of Y total`
  (candidate has phone + hasn't applied/screened already). Numeric `relevance_score` (heuristic)
  + optional Gemini summary.
- **Juicebox / LinkedIn import** → `juicebox_profiles` → PeakAI enrichment (phone, emails) →
  generated resume (`lib/juicebox-resume.ts`).
- **Source tag is mandatory.** Every sourcing action (upload, manual add, assign to stage,
  DB-match add) requires a `source` value — portal options (`portal, apna, naukri, workindia,
  job_board, applied, external_outreach, database, recruiter_upload`, …) or `Other`. Persisted to
  `applications.source` and `candidates.source`, driving a sourcing-analytics view
  (source × job category → shortlist / interview / hired) used to learn which portals suit which
  roles.
- Origin is derived (`lib/origin.ts`): `inbound` (applied) vs `outbound` (we sourced) and
  denormalized onto `applications.origin` + `phone_screening_participants.origin`.

---

## 5. Stage 2b — AI CV↔JD fit analysis (Step 3)

On-demand per candidate (non-blocking, cached ~24h in Redis), reused across the funnel:

- `lib/candidate-fit.ts` → Gemini reads **candidate resume_text** (or Juicebox-generated resume)
  + **JD** and returns structured JSON:
  `{ fit_score: 0-100, pros: string[], misses: string[], interview_probes: string[], summary }`.
- Persisted in **`candidate_job_fit`** (`job_id`, `candidate_id`, `fit_score`, `fit_json`, cache key).
- Sourcing tab **ranks candidates by fit_score** and shows pros/misses on the cards; HR picks who
  to outreach first (or filters to fit ≥ N).
- **Phase 2/3 enhancement (scoped):** recruiter who did the sourcing adds *reasoning to justify a
  listed CV miss* → stored and fed to `ai_learning` so future fit analysis weights that gap.

> Cost note: this is an LLM call per (candidate × job) — run it lazily per candidate (button /
> on-select) and cache, not a blocking batch on every load.

---

## 6. Stage 3 — WhatsApp context outreach (Step 4)

Two Aisensy approved templates (Quick Replies + a URL CTA):

- **4.1 OUTBOUND** (`AISENSY_OUTREACH_TEMPLATE`): params `[candidateName, jobTitle, location,
  salaryBudget]` + **job link** (dynamic URL CTA to the public board page) + Quick Replies
  `[ Interested ] [ Not interested ]`. Body makes clear an **AI screening call** will follow.
- **4.2 INBOUND** (`AISENSY_SHORTLIST_TEMPLATE`): "Congratulations, you've been shortlisted for the
  first round" + prompt to pick a time + same replies.

Trigger: `POST /api/phone-screening/trigger` with `callMode: "whatsapp_first"` (outbound, default
for DB matches / juicebox) or `"call_now"` (legacy immediate call; not the new default).

On send success the participant is set to **`whatsapp_sent`** (`whatsapp_message_id`,
`whatsapp_sent_at`, `whatsapp_delivery_status`) and two QStash messages are published:
`outreach-followup {nudge}` at **+4h** and `outreach-followup {escalate}` at **+8h**.

### Button replies (Aisensy inbound webhook → `POST /api/whatsapp/webhook/aisensy`)

The webhook (today delivery-status only) is extended to parse **inbound button replies** and route
them by phone number → participant:

| Reply | Action |
|---|---|
| `interested` | status `interested`; send **schedule-options** message (next) |
| `not_interested` | status `not_interested`; stop, no further nudges/calls |
| `call_me_now` | `scheduled_call_at = now + 1 min` → QStash places the call |
| `in_10_min` | `scheduled_call_at = now + 10 min` → QStash |
| `today_evening` (or slot) | `scheduled_call_at` at the chosen slot → QStash |
| free text | ignored/logged (Phase 2: parse a time from text) |

### Schedule-options message

After `interested`, a second Aisensy template (`AISENSY_SCHEDULE_OPTIONS_TEMPLATE`) with Quick
Replies `[ Call me now ] [ In 10 minutes ] [ Today evening ]` — no HR interference.

### Nudge / escalation timeline (no blind calls)

| Elapsed | Event | Action |
|---|---|---|
| t = 0 | Outreach sent | status `whatsapp_sent`; schedule nudge @ +4h, escalate @ +8h |
| t ≈ reply | Interested | → schedule-options → call at chosen time |
| t = +4h | No reply | **Nudge #1** (reminder WhatsApp, same context) |
| t = +8h | Still no reply | **`needs_manual_followup = true`** → human recruiter queue (pipeline) — NO AI call |

Constants `OUTREACH_NUDGE_HOURS=4`, `OUTREACH_ESCALATE_HOURS=8` (env-overridable).

---

## 7. Stage 4 — Bolna AI call (Step 5)

- Fires only when due: `call/trigger` (QStash-verified) places the call for participants whose
  `scheduled_call_at` has passed (`call_scheduled`), or via the manual **Call Now** / `schedule`
  routes. **`whatsapp_sent` alone never auto-calls.**
- The agent (`lib/bolna.ts` prompts) self-identifies (Hinglish default), screens questions, handles
  objections / DND / wrong number, returns a **verdict JSON** on every end path.
- Webhooks update status + transcript + answers (`screening_answers`, `call_transcripts`).
- **Retries:** terminal failure → `failed` + `next_retry_at` 15/60 min, QStash re-schedules, max
  `MAX_CALL_ATTEMPTS` (4). 
- **Missed-call nudge** (one-time, on failure) and **mid-call abandon nudge** (on `aborted`:
  duration < 60s or < 1 candidate turn) sent via Aisensy.
- After retries exhausted / abandon → **`needs_manual_followup`** → human queue.

---

## 8. Stage 5 — Pending HR Review (Step 6)

- AI Screenings tab polls; results sheet shows score /10, recommendation, transcript, Q&A, verdict.
- HR reviews **Approve / Reject** → auto-move to next stage (Interview / Shortlist / Pending HR Review)
  or Rejected with reason. Nothing auto-advances past HR.

---

## 9. Stage 6 — Shortlist → email client (Step 7)

- **Shortlist** stage feeds the share. **Share Shortlist** now does two things:
  1. Snapshots shortlisted candidates into `shortlist_share_candidates` + returns a **tokenized,
     no-login link** (`/shortlist/<token>`, 30-day expiry) — existing behavior.
  2. **Emails the client** (`clients.primary_contact_email`) with the shortlist summary + link,
     **CC: Tzy recruiter + account manager** (`jobs.recruiter_email`, `jobs.account_manager_email`),
     via `sendClientShortlistEmail` (`lib/mailer.ts`, SMTP/Postmark). Sending is best-effort and
     logged; the link is always generated regardless.

---

## 10. Stage 7 — Client approval (human, Phase 1) + roadmap

- **Phase 1 (now): human-driven.** Client opens the link (no login), sees match %, AI verdict,
  score /10, and **Approves** (→ Interview) or **Passes** (→ Rejected + reason). Badges shown on
  pipeline cards. Candidate-journey automation is the primary target; client approval stays human.
- **Phase 2/3 roadmap (scoped, not built):**
  - Post client-approval → **auto-schedule 2nd interview round** (calendar/time options → candidate).
  - Post offer → **DOJ follow-up automation**: congratulations, joining confirmation, pre-joining
    reminders (X days before).
  - **20-day post-join feedback** message to the candidate.
  - Recruiter CV-miss justification loop (see §5).

---

## 11. Status lifecycles

**Participant (WhatsApp + call):**
`whatsapp_sent` → `interested` → `call_scheduled` → `calling` → `in_progress` → `completed`
· `not_interested` (any time) · `failed` (retry) · `unreachable` · `call_scheduled` (reschedule)
· `needs_manual_followup` (escalated to human; terminal for auto-funnel).

**Outreach tracking (participant):** `whatsapp_message_id`, `whatsapp_sent_at`,
`whatsapp_delivery_status`, `outreach_nudge_count`, `needs_manual_followup`.

**Pipeline (candidate):** Applied → AI Screen → Pending HR Review → Shortlist → Interview → Offer →
Hired / Rejected.

**Client decision (share):** pending → approved (→ Interview) / rejected (→ Rejected + reason).

**Fit (candidate × job):** cached Gemini analysis — `candidate_job_fit`.

---

## 12. Data model (Supabase)

| Table | Purpose |
|---|---|
| `jobs` | Job + JD, category, salary, **`recruiter_email`, `account_manager_email`** (email CCs) |
| `clients` | Client master incl. `primary_contact_email` (shortlist email recipient) |
| `applications` | Candidate × job; `status`, `origin`, `source` (REQUIRED), `trackable_link` |
| `candidates` | Candidate master; `source`, `resume_text`, salary fields from call |
| `candidate_job_fit` | Gemini CV↔JD fit: `fit_score`, `fit_json` (pros/misses/probes), cached |
| `phone_screening_campaigns` | One campaign = one launch per job |
| `phone_screening_participants` | Per-candidate: status, Bolna exec id, payload, score, review; WhatsApp fields (`whatsapp_message_id`, `whatsapp_sent_at`, `whatsapp_delivery_status`, `whatsapp_missed_nudge_sent`), outreach (`outreach_nudge_count`, `needs_manual_followup`), `scheduled_call_at` |
| `call_transcripts` / `screening_answers` | Call transcript segments / parsed Q&A |
| `juicebox_profiles`, `juicebox_contacts`, `juicebox_experience`, `juicebox_education` | Imported LinkedIn profiles + PeakAI contacts (cached) + experience/education |
| `shortlist_shares` / `shortlist_share_candidates` | Tokenized share + snapshot for the client link |
| `ai_learning_events`, `call_quality_metrics`, `ai_playbook_versions`, `ai_fine_tune_rows` | Continuous learning from calls |
| `sourcing_analytics` (function/view) | source × job category → stage counts (shortlist/interview/hired) |

---

## 13. Config (`.env.local`)

| Var | Used by |
|---|---|
| `BOLNA_API_KEY`, `BOLNA_AGENT_ID`, `BOLNA_FROM_NUMBER` | Bolna call placement |
| `PHONE_SCREENING_WEBHOOK_BASE` | Public base URL for QStash + Bolna webhooks (must be internet-visible) |
| `BOLNA_WEBHOOK_TOKEN` | Bolna webhook auth |
| `AISENSY_API_KEY`, `AISENSY_CAMPAIGN_NAME`, `AISENSY_SOURCE` | Aisensy delivery |
| `AISENSY_OUTREACH_TEMPLATE` | Outbound context outreach (4.1) |
| `AISENSY_SHORTLIST_TEMPLATE` | Inbound shortlist outreach (4.2) |
| `AISENSY_SCHEDULE_OPTIONS_TEMPLATE` | After-interested schedule options |
| `AISENSY_REMINDER_TEMPLATE` | Nudge #1 reminder |
| `AISENSY_CALL_NUDGE_TEMPLATE` | "We'll call you" (pre-call warm-up) |
| `AISENSY_MISSED_CALL_TEMPLATE` | Missed-call nudge |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | Delayed scheduling + webhook verification |
| `OUTREACH_NUDGE_HOURS` (=4), `OUTREACH_ESCALATE_HOURS` (=8) | Nudge / human-escalation cadence |
| `GEMINI_API_KEY` | Fit analysis, JD questions, ai-learning |
| `PEAKAI_EMAIL` + `PEAKAI_PASSWORD` (or `PEAKAI_ACCESS_TOKEN`) | PeakAI enrichment |
| `SMTP_HOST/PORT/SECURE/USER/PASS` (or `POSTMARK_SERVER_TOKEN` + `POSTMARK_MESSAGE_STREAM`), sender for shortlist email | Client/recruiter email |
| `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY` | Data layer |

**Scheduling — QStash, event-driven (no crons, no DB polling):**

| Event | Scheduled by | Fires at |
|---|---|---|
| Nudge #1 (no reply to outreach) | orchestrator @ outreach send | `OUTREACH_NUDGE_HOURS` (4h) |
| Human escalation (still no reply) | orchestrator @ outreach send | `OUTREACH_ESCALATE_HOURS` (8h) |
| AI call after schedule option / callback | schedule route / reply webhook / execution webhook | chosen `scheduled_call_at` |
| Call retry | execution webhook on failure | +15/60 min (max 4) |
| Missed / abandon nudge | execution webhook on terminal | immediately |

---

## 14. Key files

- **Orchestration:** `lib/call-orchestrator.ts`, `app/api/phone-screening/trigger/route.ts`
- **Fit analysis (Step 3):** `lib/candidate-fit.ts`, `app/api/jobs/[id]/fit/route.ts`
- **WhatsApp (Step 4):** `lib/aisensy.ts`, `app/api/whatsapp/webhook/aisensy/route.ts`,
  `app/api/phone-screening/outreach-followup/route.ts` (nudge/escalate),
  `app/api/phone-screening/call-now/route.ts`
- **Scheduling (QStash):** `lib/scheduled-call.ts`, `app/api/phone-screening/call/trigger/route.ts`,
  `app/api/phone-screening/schedule/route.ts`
- **Bolna:** `lib/bolna.ts`, `app/api/bolna/agent/route.ts`,
  `app/api/bolna/webhook/execution/route.ts`, `app/api/bolna/reconcile/route.ts`
- **Webhooks:** `app/api/phone-screening/webhook/*`
- **Review:** `app/api/phone-screening/participants/[id]/review/route.ts`
- **Email:** `lib/mailer.ts` (`sendClientShortlistEmail`), `app/api/jobs/[id]/shortlist-share/route.ts`
- **Sourcing analytics:** `app/api/super-admin/analytics/sourcing/route.ts`
- **Enrichment:** `lib/peakai.ts`, `app/api/jobs/[id]/juicebox/{import,enrich,call}` routes
- **UI:** `components/job-db-matches-tab.tsx`, `job-candidates-tab.tsx`, `job-upload-dialog.tsx`,
  `assign-job-dialog.tsx`, `phone-screening-*.tsx`, `shortlist-share-dialog.tsx`,
  `super-admin/SuperAdminAnalytics.tsx`
- **Migrations:** `20260729_phone_screening.sql` … `20260810_juicebox_pipeline.sql` (applied),
  `20260813_whatsapp_call_nudge.sql` (applied), **`20260814_outreach_fit_email.sql` (pending)**

---

## 15. Current blockers before this works end-to-end

1. **Push migrations** incl. `20260814_outreach_fit_email.sql` (`npx supabase link --project-ref
   dmnypjxbfbjegraylspt && npx supabase db push`).
2. **Aisensy templates** approved: `AISENSY_OUTREACH_TEMPLATE` (4.1), `AISENSY_SHORTLIST_TEMPLATE`
   (4.2), `AISENSY_SCHEDULE_OPTIONS_TEMPLATE`, `AISENSY_REMINDER_TEMPLATE` (+ existing call/missed).
   Enable the **inbound message webhook** in Aisensy → `/api/whatsapp/webhook/aisensy`.
3. **QStash** token + signing keys; `PHONE_SCREENING_WEBHOOK_BASE` = deployed URL.
4. **Bolna** env keys + agent provisioned.
5. **PeakAI** access enabled (`studio@thepeakai.com`).
6. **GEMINI_API_KEY** for fit analysis.
7. **SMTP/Postmark** + sender + job `recruiter_email` / `account_manager_email` for the shortlist email.
8. **Source tag** mandatory in UIs (part of the build).

---

## 16. Inbound calling (candidate dials us) — scoped, deferred

See `docs/inbound-call-scoping.md` (full scope + recommendation). Summary: inbound costs us money
per minute, risks DND/spam complaints, and needs caller-ID → candidate matching. **Phase 1
decision: no inbound number.** The WhatsApp schedule-options flow covers scheduling; if inbound is
later required, options are (a) AI answers inbound (Bolna inbound leg), (b) IVR press-to-continue →
outbound AI call, (c) forward to human. All rejected for now pending cost review.

---

## 17. What changed vs the previous flow

- **Removed** the unconditional 20-min auto-call after nudge (`NUDGE_CALL_TIMEOUT_*`).
- **Outreach message** now carries job title / location / salary budget / job link + Interested /
  Not-interested buttons (context-awareness only; screening stays on the call).
- **Calls happen only on opt-in**: schedule options (Call me now / In 10 min / slot) or HR Call Now.
- **Nudge cadence 4h → human escalation 8h** for silent outbound candidates (no AI call to them).
- **New Step 3** AI CV↔JD fit analysis (rank + pros + misses).
- **Shortlist email** to client with CC Tzy recruiter + AM.
- **Source tag mandatory** + sourcing analytics.
