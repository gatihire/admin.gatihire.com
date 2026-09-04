# WhatsApp Journey — Complete Flow Plan

> WhatsApp-first screening flow for GatiHire AI Screening system.

---

## Core Principles

1. **No blind AI calls** — Never call without candidate consent
2. **WhatsApp-first** — Always send WhatsApp before calling
3. **Candidate controls timing** — Candidate picks when to take the call
4. **Max 2 call attempts** — Don't frustrate candidates with too many retries
5. **1 reminder + escalate** — If silent, remind once then hand to HR
6. **HR visibility** — Every status visible in pipeline for manual action

---

## Outbound Flow

> When admin triggers screening for database-matched or Juicebox-sourced candidates.

```
┌─────────────────────────────────────────────────────────────────┐
│  STEP 1: Admin triggers WhatsApp-first screening                │
│  POST /api/phone-screening/trigger { callMode: "whatsapp_first" } │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 2: WhatsApp Outreach Sent (via Aisensy)                   │
│  Template: AISENSY_OUTREACH_TEMPLATE                            │
│                                                                 │
│  "Hi {name},                                                   │
│   We found a role that matches your profile: {role} at {company}│
│   Match score: {score}                                          │
│   Relevant skills: {skills}                                     │
│                                                                 │
│   Apply here: {link}"                                           │
│                                                                 │
│  Quick Reply Buttons: [Interested] [Not Interested]             │
│  Status: whatsapp_sent                                          │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Candidate says  │ │  Candidate says  │ │  No response     │
│  "Interested"    │ │  "Not Interested"│ │  (silent)        │
└──────────────────┘ └──────────────────┘ └──────────────────┘
              │               │               │
              ▼               ▼               ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Status:         │ │  Status:         │ │  At +4h:         │
│  interested      │ │  not_interested  │ │  Send Reminder   │
│                  │ │                  │ │  Template        │
│  Send Schedule   │ │  STOP. No more   │ │                  │
│  Options:        │ │  messages.       │ │  At +8h:         │
│  [Call me now]   │ │                  │ │  Status:         │
│  [In 10 min]     │ │  HR sees:        │ │  needs_manual_   │
│  [Today evening] │ │  "Not Interested"│ │  followup        │
└──────────────────┘ │  in pipeline     │ │                  │
              │      └──────────────────┘ │  HR sees:        │
              ▼                           │  "Needs Follow-up"│
┌──────────────────┐                      │  in pipeline     │
│  Candidate picks │                      └──────────────────┘
│  a time option   │
└──────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 3: Call Scheduled via QStash                              │
│  Status: call_scheduled                                         │
│  scheduled_call_at: {picked time}                               │
│                                                                 │
│  At scheduled time:                                             │
│  - Bolna AI call placed                                         │
│  - Status: calling                                              │
└─────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 4: Call Result — MAX 2 ATTEMPTS                           │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │  Completed       │  │  No Answer      │  │  Busy           │ │
│  │  Status:         │  │  Status:        │  │  Status:        │ │
│  │  completed       │  │  failed         │  │  failed         │ │
│  │                  │  │  bolna_status:  │  │  bolna_status:  │ │
│  │  → View Results  │  │  no-answer      │  │  busy           │ │
│  └─────────────────┘  │                  │  │                  │ │
│                        │  Retry 1:        │  │  Retry 1:        │ │
│                        │  Wait 15 min     │  │  Wait 15 min     │ │
│                        │  Send WhatsApp:  │  │  Send WhatsApp:  │ │
│                        │  "Tried calling" │  │  "Tried calling" │ │
│                        │  [Call Now]      │  │  [Call Now]      │ │
│                        │  [In 10 min]     │  │  [In 10 min]     │ │
│                        │                  │  │                  │ │
│                        │  If no response  │  │  If no response  │ │
│                        │  to retry:       │  │  to retry:       │ │
│                        │                  │  │                  │ │
│                        │  Status:         │  │  Status:         │ │
│                        │  unreachable     │  │  unreachable     │ │
│                        │  HR sees:        │  │  HR sees:        │ │
│                        │  "Unreachable"   │  │  "Unreachable"   │ │
│                        │  → Manual action │  │  → Manual action │ │
│                        └─────────────────┘  └─────────────────┘ │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐                      │
│  │  Disconnected    │  │  Voicemail       │                      │
│  │  mid-call        │  │                  │                      │
│  │                  │  │  Status:         │                      │
│  │  Status:         │  │  completed       │                      │
│  │  failed          │  │  call_voicemail: │                      │
│  │  bolna_status:   │  │  true            │                      │
│  │  canceled/stopped│  │                  │                      │
│  │                  │  │  → View Results  │                      │
│  │  Partial         │  │  (voicemail =    │                      │
│  │  transcript      │  │   no useful data)│                      │
│  │  stored          │  │                  │                      │
│  │                  │  │  HR sees:        │                      │
│  │  → View Partial  │  │  "Voicemail"     │                      │
│  └─────────────────┘  └─────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Inbound Flow

> When candidate applies via board-app or external job boards.

```
┌─────────────────────────────────────────────────────────────────┐
│  STEP 1: Candidate applies via board-app / external             │
│  Application created with status: "applied"                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 2: Admin triggers WhatsApp-first screening                │
│  POST /api/phone-screening/trigger { callMode: "whatsapp_first" } │
│  Origin: inbound                                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 3: WhatsApp Outreach Sent (Casual Tone)                   │
│  Template: AISENSY_SHORTLIST_TEMPLATE                           │
│                                                                 │
│  "Hi {name}!                                                   │
│   Thanks for applying for {role}.                               │
│   Our AI assistant Bipul will call you for a quick screening.   │
│   When works for you?"                                          │
│                                                                 │
│  Quick Reply Buttons:                                           │
│  [Call Now] [In 10 min] [In 30 min] [In 1 hour] [Custom time]  │
│                                                                 │
│  Status: whatsapp_sent                                          │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Candidate picks │ │  Candidate says  │ │  No response     │
│  a time option   │ │  "Not Interested"│ │  (silent)        │
└──────────────────┘ └──────────────────┘ └──────────────────┘
              │               │               │
              ▼               ▼               ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Status:         │ │  Status:         │ │  At +4h:         │
│  call_scheduled  │ │  not_interested  │ │  Send Reminder   │
│                  │ │                  │ │  (Casual)        │
│  Bolna call at   │ │  STOP. No more   │ │                  │
│  scheduled time  │ │  messages.       │ │  At +8h:         │
│                  │ │                  │ │  Status:         │
│                  │ │  HR sees:        │ │  needs_manual_   │
│                  │ │  "Not Interested"│ │  followup        │
│                  │ └──────────────────┘ │                  │
│                  │                      │  HR sees:        │
│                  │                      │  "Needs Follow-up"│
└──────────────────┘                      └──────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 4: Call at Scheduled Time                                 │
│  Status: calling                                                │
│                                                                 │
│  AI Opening (Inbound):                                          │
│  "Hello {name}, this is Bipul calling from GatiHire.            │
│   Thank you for applying for {role}.                            │
│   Do you have two minutes to talk?"                             │
└─────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 5: Same as Outbound Step 4 (Call Result)                  │
│  - Completed → View Results                                     │
│  - No Answer → Retry 1 → Retry 2 → Unreachable                 │
│  - Busy → Retry 1 → Retry 2 → Unreachable                      │
│  - Disconnected → Partial transcript + View                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Direct Call Flow

> When admin clicks "Call Now" directly (bypasses WhatsApp).

```
┌─────────────────────────────────────────────────────────────────┐
│  STEP 1: Admin clicks "Call Now"                                │
│  POST /api/phone-screening/call-now                             │
│  callMode: "call_now"                                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 2: Pre-call WhatsApp Context Sent                         │
│  Template: AISENSY_OUTREACH_TEMPLATE                            │
│                                                                 │
│  "Hi {name},                                                    │
│   Quick update about {role}:                                    │
│   📍 Location: {location}                                       │
│   💰 Salary: {salary}                                           │
│   View details: {link}"                                         │
│                                                                 │
│  Status: calling                                                │
│  (Pre-call WhatsApp is informational, no reply expected)        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 3: Wait 60s (PRE_CALL_DELAY_MS) then place Bolna call    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 4: Call Result — MAX 2 ATTEMPTS                           │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │  Completed       │  │  No Answer      │  │  Busy           │ │
│  │  Status:         │  │  Status:        │  │  Status:        │ │
│  │  completed       │  │  failed         │  │  failed         │ │
│  │                  │  │  bolna_status:  │  │  bolna_status:  │ │
│  │  → View Results  │  │  no-answer      │  │  busy           │ │
│  └─────────────────┘  │                  │  │                  │ │
│                        │  Retry 1:        │  │  Retry 1:        │ │
│                        │  Wait 15 min     │  │  Wait 15 min     │ │
│                        │  Send WhatsApp:  │  │  Send WhatsApp:  │ │
│                        │  "Tried calling" │  │  "Tried calling" │ │
│                        │  [Call Now]      │  │  [Call Now]      │ │
│                        │  [In 10 min]     │  │  [In 10 min]     │ │
│                        │                  │  │                  │ │
│                        │  If no response  │  │  If no response  │ │
│                        │  to retry:       │  │  to retry:       │ │
│                        │                  │  │                  │ │
│                        │  Status:         │  │  Status:         │ │
│                        │  unreachable     │  │  unreachable     │ │
│                        │  HR sees:        │  │  HR sees:        │ │
│                        │  "Unreachable"   │  │  "Unreachable"   │ │
│                        │  → Manual action │  │  → Manual action │ │
│                        └─────────────────┘  └─────────────────┘ │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐                      │
│  │  Disconnected    │  │  Voicemail       │                      │
│  │  mid-call        │  │                  │                      │
│  │                  │  │  Status:         │                      │
│  │  Status:         │  │  completed       │                      │
│  │  failed          │  │  call_voicemail: │                      │
│  │  bolna_status:   │  │  true            │                      │
│  │  canceled/stopped│  │                  │                      │
│  │                  │  │  → View Results  │                      │
│  │  Partial         │  │  (voicemail =    │                      │
│  │  transcript      │  │   no useful data)│                      │
│  │  stored          │  │                  │                      │
│  │                  │  │  HR sees:        │                      │
│  │  → View Partial  │  │  "Voicemail"     │                      │
│  └─────────────────┘  └─────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Retry & Fallback Logic

### Direct Call (call_now) — Max 2 Attempts

| Attempt | Action | If No Answer | If Busy |
|---------|--------|--------------|---------|
| 1st | Place Bolna call | Send WhatsApp "Tried calling" + schedule retry 2 in 15 min | Same |
| 2nd | Place Bolna call | Status → unreachable, HR notified | Same |

**After 2 failed attempts:**
- Status: `unreachable`
- HR sees: "All retries exhausted — needs manual follow-up"
- CTA: "Manual Follow-up"

### WhatsApp-First — No Blind Retries

| Scenario | Action | Limit |
|----------|--------|-------|
| Candidate says "Not Interested" | STOP. No more messages. | — |
| Candidate says "Interested" | Send schedule options | — |
| Candidate picks time | Schedule call at that time | — |
| No response (silent) | 1 reminder at +4h | 1 reminder only |
| Still silent after +4h | Escalate to HR at +8h | — |
| Call completed | View results | — |
| Call failed (no-answer/busy) | Send "Tried calling" WhatsApp + schedule retry | Max 2 attempts |
| Call disconnected | Store partial transcript | — |

### Retry Status Flow

```
calling → failed (no-answer) → retrying (15 min wait) → calling → completed
                                                                   │
                                                                   ▼
                                                           failed (no-answer)
                                                                   │
                                                                   ▼
                                                           "Tried calling" WhatsApp
                                                                   │
                                                                   ▼
                                                           If no response to WhatsApp:
                                                           status → unreachable
                                                           HR sees: "Unreachable"
```

---

## Status Map for Pipeline

### AI Screen Sub-Filters

| Sub-Filter | Status | What HR Sees | HR Action |
|------------|--------|--------------|-----------|
| `pending` | `pending` | "Not yet contacted" | Start WhatsApp / Start Call |
| `whatsapp_sent` | `whatsapp_sent` | "Message sent — waiting" | Wait / Send Nudge |
| `replied` | `interested` | "Interested — ready to call" | Start Call / Schedule |
| `calling` | `calling` / `in_progress` / `call_scheduled` | "AI call in progress" | Wait |
| `no_answer` | `failed` + `bolna_status: no-answer` | "No answer — retry in {time}" | Retry Now / Send WhatsApp |
| `busy` | `failed` + `bolna_status: busy` | "Line busy — retry in {time}" | Retry Now / Send WhatsApp |
| `disconnected` | `failed` + `bolna_status: canceled/stopped` | "Call dropped — partial transcript" | View Partial / Retry |
| `retrying` | `failed` + `next_retry_at` | "Retrying — attempt {n}/2" | (disabled) |
| `call_done` | `completed` | "Screening complete — AI score {n}/10" | View Results / Shortlist / Reject |
| `unreachable` | `unreachable` | "All retries exhausted" | Manual Follow-up |
| `not_interested` | `not_interested` | "Not interested" | (none) |
| `needs_followup` | `needs_manual_followup` | "Needs manual follow-up" | Contact directly |

---

## HR Decision Matrix

| Status | Badge Color | What HR Sees | Available Actions |
|--------|-------------|--------------|-------------------|
| `pending` | Gray | "New candidate — not contacted" | Start WhatsApp, Start Call, Reject |
| `whatsapp_sent` | Teal | "Message sent — waiting {time}" | Wait, Send Nudge, Start Call |
| `replied` | Green | "Interested — ready to call" | Start Call, Schedule, Reject |
| `calling` | Amber | "AI call in progress — {duration}" | Wait, Cancel Call |
| `no_answer` | Orange | "No answer — auto-retry in {time} (attempt {n}/2)" | Retry Now, Send WhatsApp, Mark Unreachable |
| `busy` | Orange | "Line busy — auto-retry in {time}" | Retry Now, Send WhatsApp, Mark Unreachable |
| `disconnected` | Red | "Call dropped — partial transcript available" | View Partial, Retry Now, Send WhatsApp |
| `retrying` | Blue | "Retrying — attempt {n}/2 in {time}" | (disabled — system working) |
| `call_done` | Emerald | "Screening complete — AI score {n}/10" | View Results, Shortlist, Reject |
| `unreachable` | Red | "All retries exhausted" | Manual Follow-up, Mark Not Interested |
| `not_interested` | Red | "Not interested" | (none) |
| `needs_followup` | Orange | "Needs manual follow-up" | Contact directly |

---

## Implementation Plan

### Phase 1: Update Max Retry Constants
- `lib/scheduled-call.ts`: `MAX_CALL_ATTEMPTS = 2` (was 4)
- `app/api/bolna/webhook/execution/route.ts`: Check retry_count against MAX_CALL_ATTEMPTS

### Phase 2: Update Inbound WhatsApp Template
- `lib/aisensy.ts`: Add `sendInboundScreeningInvite()` with casual tone + 5 time options
- `app/api/whatsapp/webhook/aisensy/route.ts`: Add `in_30_min` action handler

### Phase 3: Update Pipeline Statuses (Already Done)
- `components/job-candidates-tab.tsx`: 10 sub-sections + context-aware buttons
- `components/phone-screening-tab.tsx`: New status badges

### Phase 4: Update Bolna Webhook (Already Done)
- Partial transcripts on disconnect
- retry_count tracking

### Phase 5: Update Reconcile (Already Done)
- 3 min threshold (was 30 min)

### Phase 6: WhatsApp Templates
- `lib/aisensy.ts`: Add `sendTriedCallingNudge()` method
- `docs/whatsapp-templates.md`: Complete template inventory

### Phase 7: DB Migration (Already Done)
- `supabase/migrations/20260903010000_call_flow_improvements.sql`

---

## Key Changes Summary

| Area | Before | After |
|------|--------|-------|
| Max retries (direct call) | 4 attempts | **2 attempts** |
| Inbound WhatsApp tone | Formal | **Casual** |
| Silent candidate fallback | 2 reminders + escalate | **1 reminder + escalate** |
| Pipeline sub-sections | 6 | **10 (+ no_answer, busy, disconnected, retrying, unreachable)** |
| Action buttons | Same CTA for all failures | **Context-aware** |
| Auto-timeout | 30 min reconcile | **3 min reconcile + client-side** |
| Partial transcripts | Only on completed | **On disconnect too** |

---

*Last updated: 2026-09-04*
