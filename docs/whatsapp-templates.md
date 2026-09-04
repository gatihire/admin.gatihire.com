# WhatsApp Templates — Complete Reference

> All WhatsApp message templates used across the GatiHire AI Screening system.

---

## Table of Contents

1. [Template Inventory](#template-inventory)
2. [Outbound Flow Templates](#outbound-flow-templates)
3. [Inbound Flow Templates](#inbound-flow-templates)
4. [Call Flow Templates](#call-flow-templates)
5. [Follow-up Templates](#follow-up-templates)
6. [Edge Case Templates](#edge-case-templates)
7. [Aisensy Environment Variables](#aisensy-environment-variables)
8. [Flow Diagrams](#flow-diagrams)
9. [HR Visibility](#hr-visibility)

---

## Template Inventory

| # | Template Name | Aisensy Campaign | When Sent | Parameters |
|---|---|---|---|---|
| 1 | Talent Outreach | `AISENSY_OUTREACH_TEMPLATE` | Outbound candidate matching role | candidate_name, job_title, company_name, match_score, skills, apply_link |
| 2 | Inbound Screening Invite | `AISENSY_SHORTLIST_TEMPLATE` | Inbound candidate (casual tone) | candidate_name, job_title |
| 3 | Outreach Context | `AISENSY_OUTREACH_TEMPLATE` | Pre-call context message | candidate_name, job_title, location, salary_budget, job_link |
| 4 | Shortlisted Congrats | `AISENSY_SHORTLIST_TEMPLATE` | Inbound shortlisted | candidate_name, job_title, location, salary_budget, job_link |
| 5 | Schedule Options | `AISENSY_SCHEDULE_OPTIONS_TEMPLATE` | After candidate says "Interested" | candidate_name |
| 6 | Call Nudge | `AISENSY_CALL_NUDGE_TEMPLATE` | After WhatsApp outreach, before call | candidate_name, job_title, company_name |
| 7 | Tried Calling Nudge | `AISENSY_MISSED_CALL_TEMPLATE` | After call fails (retry notification) | candidate_name, job_title, company_name |
| 8 | Missed Call Reschedule | `AISENSY_MISSED_CALL_RESCHEDULE_TEMPLATE` | After failed Bolna call | candidate_name, job_title, company_name |
| 9 | Reminder Nudge | `AISENSY_REMINDER_TEMPLATE` | 4h silence after outreach | candidate_name, job_title, location |

---

## Outbound Flow Templates

### 1. Talent Outreach (`AISENSY_OUTREACH_TEMPLATE`)

**Trigger:** Mass outreach to candidates matching a job role

**Message:**
```
Hi {{candidate_name}},

We found a role that matches your profile: {{job_title}} at {{company_name}}.

Match score: {{match_score}}
Relevant skills: {{skills}}

Apply here: {{apply_link}}
```

**Quick Reply Buttons:** `[Interested]` `[Not Interested]`

**Parameters:**
- `candidate_name` — Candidate's full name
- `job_title` — Job title
- `company_name` — Client company name
- `match_score` — AI match score (e.g., "8.5/10")
- `skills` — Comma-separated relevant skills
- `apply_link` — Unique application link

**Tags:** `["ai_outreach_context"]`

**Code:** `lib/aisensy.ts:261-279` (sendOutreachMessage)

---

### 2. Outreach Context (`AISENSY_OUTREACH_TEMPLATE`)

**Trigger:** Pre-call context message before AI screening call (direct call mode)

**Message:**
```
Hi {{candidate_name}},

Quick update about {{job_title}}:
📍 Location: {{location}}
💰 Salary: {{salary_budget}}

View details: {{job_link}}
```

**Parameters:**
- `candidate_name` — Candidate's full name
- `job_title` — Job title
- `location` — Job location
- `salary_budget` — Salary range
- `job_link` — Job details link

**Tags:** `["ai_outreach_context"]`

**Code:** `lib/aisensy.ts:261-279` (sendOutreachMessage)

---

## Inbound Flow Templates

### 3. Inbound Screening Invite (`AISENSY_SHORTLIST_TEMPLATE`)

**Trigger:** Inbound candidate (board-app/external) — casual tone

**Message:**
```
Hi {{candidate_name}}!

Thanks for applying for {{job_title}}.

Our AI assistant Bipul will call you for a quick screening.
When works for you?
```

**Quick Reply Buttons:** `[Call Now]` `[In 10 min]` `[In 30 min]` `[In 1 hour]` `[Custom time]`

**Parameters:**
- `candidate_name` — Candidate's full name
- `job_title` — Job title

**Tags:** `["ai_inbound_screening_invite"]`

**Code:** `lib/aisensy.ts:377-398` (sendInboundScreeningInvite)

**Button Handling:**
- `call_me_now` → Schedules Bolna call in 1 minute
- `in_10_min` → Schedules call in 10 minutes
- `in_30_min` → Schedules call in 30 minutes
- `today_evening` → Schedules call at next 18:00 IST
- `custom_time` → NLP parses time from free text

---

### 4. Shortlisted Congrats (`AISENSY_SHORTLIST_TEMPLATE`)

**Trigger:** Inbound candidate shortlisted for a role

**Message:**
```
Hi {{candidate_name}},

Congratulations! You've been shortlisted for {{job_title}}:
📍 Location: {{location}}
💰 Salary: {{salary_budget}}

View details: {{job_link}}
```

**Parameters:** Same as Outreach Context

**Tags:** `["ai_outreach_shortlisted"]`

**Code:** `lib/aisensy.ts:270-271` (sendOutreachMessage with shortlisted=true)

---

## Call Flow Templates

### 5. Schedule Options (`AISENSY_SCHEDULE_OPTIONS_TEMPLATE`)

**Trigger:** After candidate replies "Interested"

**Message:**
```
Hi {{candidate_name}}, great! When would you like to take the call?

[Call me now]
[In 10 minutes]
[In 30 minutes]
[Today evening]
```

**Parameters:**
- `candidate_name` — Candidate's full name

**Tags:** `["ai_outreach_schedule_options"]`

**Code:** `lib/aisensy.ts:286-299` (sendScheduleOptions)

**Button Handling:**
- `call_me_now` → Schedules Bolna call in 1 minute
- `in_10_min` → Schedules call in 10 minutes
- `in_30_min` → Schedules call in 30 minutes
- `today_evening` → Schedules call at next 18:00 IST

---

### 6. Call Nudge (`AISENSY_CALL_NUDGE_TEMPLATE`)

**Trigger:** After WhatsApp outreach, before AI call

**Message:**
```
Hi {{candidate_name}},

Our AI assistant Bipul will call you shortly about the {{job_title}} role at {{company_name}}.

Please pick up the call!
```

**Parameters:**
- `candidate_name` — Candidate's full name
- `job_title` — Job title
- `company_name` — Client company name

**Tags:** `["ai_call_nudge"]`

**Code:** `lib/aisensy.ts:135-201` (sendCallNudge)

---

### 7. Tried Calling Nudge (`AISENSY_MISSED_CALL_TEMPLATE`)

**Trigger:** After call fails — retry notification

**Message:**
```
Hi {{candidate_name}},

We tried calling you for {{job_title}} at {{company_name}}.

Please call us back or reply here with a good time!

[Call Now]
[In 10 min]
```

**Parameters:**
- `candidate_name` — Candidate's full name
- `job_title` — Job title
- `company_name` — Client company name

**Tags:** `["ai_tried_calling_nudge"]`

**Code:** `lib/aisensy.ts:404-425` (sendTriedCallingNudge)

**Button Handling:**
- `Call Now` → Schedules immediate Bolna call
- `In 10 min` → Schedules call in 10 minutes

---

### 8. Missed Call Reschedule (`AISENSY_MISSED_CALL_RESCHEDULE_TEMPLATE`)

**Trigger:** After Bolna call fails (no-answer/busy) — first retry

**Message:**
```
Hi {{candidate_name}},

We tried calling you for {{job_title}} at {{company_name}}.

Would you like to reschedule?

[Call Now]
[In 10 min]
[In 1 hour]
[Tomorrow morning]
```

**Parameters:**
- `candidate_name` — Candidate's full name
- `job_title` — Job title
- `company_name` — Client company name

**Tags:** `["ai_call_missed_reschedule"]`

**Code:** `lib/aisensy.ts:327-347` (sendMissedCallReschedule)

**Trigger Point:** `app/api/bolna/webhook/execution/route.ts:474-506`

**Button Handling:**
- `Call Now` → Schedules immediate Bolna call
- `In 10 min` → Schedules call in 10 minutes
- `In 1 hour` → Schedules call in 1 hour
- `Tomorrow morning` → Schedules call at next 09:00 IST

---

## Follow-up Templates

### 9. Reminder Nudge (`AISENSY_REMINDER_TEMPLATE`)

**Trigger:** 4 hours of silence after outreach

**Message:**
```
Hi {{candidate_name}},

Just following up about the {{job_title}} role in {{location}}.

Let us know if you're interested!
```

**Parameters:**
- `candidate_name` — Candidate's full name
- `job_title` — Job title
- `location` — Job location

**Tags:** `["ai_outreach_reminder"]`

**Code:** `lib/aisensy.ts:305-320` (sendReminderNudge)

**Trigger Point:** `app/api/phone-screening/outreach-followup/route.ts:58`

**Note:** Only 1 reminder sent. If no response after +8h, escalate to HR.

---

### 10. Escalation to Human (No Template — Manual)

**Trigger:** 8 hours of silence after outreach

**Action:** Sets status to `needs_manual_followup`

**Code:** `app/api/phone-screening/outreach-followup/route.ts:83`

**Message:** (No WhatsApp sent — HR takes over)

---

## Edge Case Templates

### 11. Voicemail Detected

**Trigger:** Bolna detects `answered_by_voice_mail: true`

**Current Behavior:** Call marked as `completed` (no special handling)

**Proposed:** Send voicemail follow-up template

**Suggested Message:**
```
Hi {{candidate_name}},

We tried reaching you for {{job_title}}. It seems we caught your voicemail.

Please call us back at {{company_number}} or reply here with a good time!
```

**Status:** Not implemented yet — needs new Aisensy template

---

### 12. Call Disconnected Mid-Conversation

**Trigger:** Call drops during active conversation

**Current Behavior:** Call marked as `failed`, partial transcript stored

**Proposed:** Send disconnected retry template

**Suggested Message:**
```
Hi {{candidate_name}},

Our call got disconnected while we were discussing {{job_title}}.

We'll try again shortly, or you can call us at {{company_number}}.
```

**Status:** Not implemented yet — needs new Aisensy template

---

### 13. Callback Confirmed

**Trigger:** Candidate requests callback via AI

**Current Behavior:** Call scheduled via QStash, status set to `call_scheduled`

**Proposed:** Send confirmation template

**Suggested Message:**
```
Hi {{candidate_name}}, confirmed!

We'll call you at {{callback_time}}. See you then!
```

**Status:** Not implemented yet — needs new Aisensy template

---

### 14. Final Attempt Warning

**Trigger:** Before last retry attempt (attempt 2/2)

**Current Behavior:** No special message

**Proposed:** Send warning template

**Suggested Message:**
```
Hi {{candidate_name}},

This is our last attempt to reach you for {{job_title}}.

Please reply or call {{company_number}} if you're interested.
```

**Status:** Not implemented yet — needs new Aisensy template

---

## Aisensy Environment Variables

| Variable | Used For | Default |
|---|---|---|
| `AISENSY_API_KEY` | API authentication | (required) |
| `AISENSY_CAMPAIGN_NAME` | Default campaign/template | `"Job_Recruitment"` |
| `AISENSY_TEMPLATE_ID` | Fallback for campaign name | — |
| `AISENSY_SOURCE` | Message source identifier | — |
| `AISENSY_SENDER_ID` | Fallback for source | — |
| `AISENSY_CALL_NUDGE_TEMPLATE` | Call nudge campaign | — |
| `AISENSY_MISSED_CALL_TEMPLATE` | Missed call / tried calling campaign | — |
| `AISENSY_MISSED_CALL_RESCHEDULE_TEMPLATE` | Missed call reschedule | — |
| `AISENSY_OUTREACH_TEMPLATE` | Outreach campaign | — |
| `AISENSY_SHORTLIST_TEMPLATE` | Shortlisted congrats / inbound invite | — |
| `AISENSY_SCHEDULE_OPTIONS_TEMPLATE` | Schedule options | — |
| `AISENSY_REMINDER_TEMPLATE` | Reminder nudge | — |

---

## Flow Diagrams

### Outbound Candidate Flow
```
1. outreach_whatsapp (Talent_Outreach) via Aisensy
   Quick Reply: [Interested] [Not Interested]
2. If "Interested" → Schedule Options template
   Quick Reply: [Call me now] [In 10 min] [In 30 min] [Today evening]
3. If candidate picks time → Schedule call via QStash
4. If "Call me now" → Bolna call placed in 1 min
5. If no response after 4h → 1 Reminder Nudge template
6. If no response after 8h → Escalate to HR (status: needs_manual_followup)
7. If call fails (no-answer/busy) → Missed Call Reschedule template
   Quick Reply: [Call Now] [In 10 min] [In 1 hour] [Tomorrow morning]
8. Max 2 call attempts → then status: unreachable
```

### Inbound (Board-App/External) Flow
```
1. Candidate applies → status: applied
2. Admin triggers WhatsApp-first screening
3. Inbound Screening Invite sent (casual tone)
   Quick Reply: [Call Now] [In 10 min] [In 30 min] [In 1 hour] [Custom time]
4. Candidate picks time → Schedule call via QStash
5. If no response after 4h → 1 Reminder Nudge
6. If no response after 8h → Escalate to HR
7. If call fails → same as outbound
8. Max 2 call attempts → then status: unreachable
```

### Direct Call Flow (call_now mode)
```
1. Admin clicks "Call Now"
2. Pre-call WhatsApp context sent (informational)
3. Wait 60s (PRE_CALL_DELAY_MS)
4. Bolna AI call placed
5. If fails → Missed Call Reschedule template
   Quick Reply: [Call Now] [In 10 min] [In 1 hour] [Tomorrow morning]
6. Max 2 attempts → then status: unreachable
```

### Call Failure Flow
```
1. Bolna call fails (no-answer/busy/disconnected)
2. Increment retry_count
3. Store partial transcript if available
4. If retry_count < 2:
   - Send Missed Call Reschedule template
   - Schedule retry via QStash (15min for no-answer/busy, 60min for other)
5. If retry_count >= 2:
   - Status → unreachable
   - No more WhatsApp messages
   - HR sees: "All retries exhausted — needs manual follow-up"
```

---

## HR Visibility

### Pipeline Sub-Filters (AI Screen Tab)

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

### Context-Aware Action Cards

| Status | Badge Color | CTA Button |
|--------|-------------|------------|
| `pending` | Gray | Start WhatsApp / Start Call |
| `whatsapp_sent` | Teal | Waiting (disabled) |
| `replied` | Green | Start Call |
| `calling` | Amber | Calling... (disabled) |
| `no_answer` | Orange | Retry Now |
| `busy` | Orange | Retry Now |
| `disconnected` | Red | View Partial |
| `retrying` | Blue | Retrying... (disabled) |
| `call_done` | Emerald | View Results |
| `unreachable` | Red | Manual Follow-up |
| `not_interested` | Red | (none) |
| `needs_followup` | Orange | Contact directly |

---

## Code References

| File | Purpose |
|---|---|
| `lib/aisensy.ts` | Aisensy WhatsApp API integration (10 send methods) |
| `lib/message-templates.ts` | Core WhatsApp/Email template definitions |
| `lib/plivo.ts` | Plivo WhatsApp interactive + voice call integration |
| `lib/bolna.ts` | Bolna AI voice call prompts (English + Hinglish) |
| `lib/call-orchestrator.ts` | Orchestrates screening campaigns |
| `lib/scheduled-call.ts` | QStash-based call scheduling (MAX_CALL_ATTEMPTS = 2) |
| `app/api/whatsapp/webhook/aisensy/route.ts` | Aisensy inbound webhook handler |
| `app/api/bolna/webhook/execution/route.ts` | Bolna call completion webhook |
| `app/api/phone-screening/outreach-followup/route.ts` | QStash nudge/escalation handler |
| `app/api/job-invites/route.ts` | Job invite API |
| `app/api/jobs/[id]/outreach/route.ts` | Mass outreach API |

---

*Last updated: 2026-09-04*
