# AI Screening — Complete Flow Reference

Single source of truth for how a candidate moves from "a recruiter pressed a button" to
"an AI screening call happened". Every template name, status, and threshold below is read
from the code, not from memory.

- **Entry point:** `POST /api/phone-screening/trigger`
- **Orchestrator:** `lib/call-orchestrator.ts`
- **Classifier:** `lib/origin.ts` → `deriveOrigin`, `deriveCandidateFlow`
- **Mode decision:** `lib/call-orchestrator.ts` → `systemDecidesMode`
- **Inbound replies:** `app/api/whatsapp/webhook/meta/route.ts`
- **Question flow:** `lib/info-collector-v2/flow.ts`
- **Pre-screen rules:** `lib/pre-screen.ts`
- **Call placement:** `lib/scheduled-call.ts`
- **Templates:** `lib/whatsapp.ts`

---

## 1. The four conditions

A screening run is fully determined by two inputs: **where the candidate came from**
(*flow*) and **what the recruiter asked for** (*mode*). Four conditions exist in total.

### Condition A — Direct call nudge (`call_now`)

No WhatsApp conversation. The AI call is placed immediately.

| | |
|---|---|
| Trigger | Recruiter presses **Call Now** / **Start calls now** |
| WhatsApp messages | **None** |
| Candidate must supply info first? | No |
| Idempotent? | Yes — guarded, see §7 |

```ts
// lib/call-orchestrator.ts
export function systemDecidesMode(callMode, flow) {
  if (callMode === "call_now") return "call_now"   // recruiter's explicit choice always wins
  if (flow === "portal")   return "quick_screen"
  if (flow === "external") return "collect_info_first"
  return callMode || "call_now"
}
```

The `callMode === "call_now"` short-circuit is load-bearing. Before it existed, portal and
external candidates had their explicit choice overwritten, so pressing **Call Now** silently
ran a re-collect and the candidate was asked questions they had already answered.

Placement goes through the guarded path, never a direct Bolna call:

```ts
const result = await placeCallImmediately(participantId)   // app/api/phone-screening/trigger/route.ts
if (result.skipped) return { ok: false, error: "A call is already in progress" }
```

### Condition B — Outbound (`outbound`)

Sourced profiles who have **not** contacted us. They must opt in before we ask anything.

| | |
|---|---|
| Sources | `database`, `enhanced_match`, `recruiter_upload`, anything starting with `database` |
| First message | `talent_outreach_v2` + a separate job-link message |
| Buttons | On the Meta template itself: **Interested** / **Not Interested** |
| Info collection | Only *after* they tap Interested |
| Why not ask up front | Asking a stranger for their CTC before they agree to anything reads as a data grab |

### Condition C — Portal inbound (`portal`)

Applied through **our own** talent portal, so the apply form already captured the details.

| | |
|---|---|
| Sources | `board-app`, `board_app`, `boardapp`, `applied`, `candidate_board` |
| First message | `shortlist_call_schedule_v2` (shortlist + pick a slot) |
| Re-asks details? | **Never** |
| Info source | Seeded from the application into `info_data` + `info_sources: "application"` |

### Condition D — External inbound (`external`)

Resume pulled from a third-party job board. The candidate knows they applied somewhere, but
**we** have no CTC / notice / intent data.

| | |
|---|---|
| Sources | Everything inbound that is not portal — `naukri`, `apna`, `workindia`, `job_board`, `external_outreach`, unknown |
| First message | `collect_info_form` (WhatsApp Flow, 5 questions) |
| Then | Pre-screen → call / review |

### Selection matrix

| Flow | `call_now` | `quick_screen` | `collect_info_first` | not specified |
|---|---|---|---|---|
| **outbound** | `call_now` | `quick_screen` | `collect_info_first` | `call_now` |
| **portal** | **`call_now`** ← was `quick_screen` | `quick_screen` | `quick_screen` | `quick_screen` |
| **external** | **`call_now`** ← was `collect_info_first` | `collect_info_first` | `collect_info_first` | `collect_info_first` |

Bold cells are the fix in `49d7631`.

### Dispatch — which function actually sends

```ts
// lib/call-orchestrator.ts, orchestrateScreening()
if (isQuickScreen) {
  if (flow === "portal")   sendShortlistMessage(...)        // A: shortlist + slot
  if (flow === "external") sendDetailedInfoMessage(...)      // B: 7-field form
  sendOutboundWithJobLink(...)                              // C: outreach + job link
}
if (isCollectInfoFirst) {
  if (flow === "portal")   sendShortlistMessage(...)        // A
  if (flow === "outbound") sendOutboundWithJobLink(...)      // C — form waits for Interested
  sendDetailedInfoMessage(...)                              // B
}
// call_now → placeCallImmediately, no WhatsApp
```

---

## 2. Pre-screen — the four checks and three outcomes

Runs only for `collect_info_first` (Condition D), after the candidate submits the form.

```ts
// lib/pre-screen.ts
const DEFAULT_CONFIG = {
  salaryTolerancePercent: 40,     // expected CTC within job range ±40%
  experienceMinPercent: 50,       // min 50% of the job's min experience
  experienceMaxPercent: 200,      // max 200% of the job's min experience
  maxNoticePeriodDays: 120,
}
```

| Check | Reads | Passes when |
|---|---|---|
| **Salary** | `expectedCtcLpa` vs job range | Within range ±40% |
| **Experience** | `totalExperienceYears` vs job min/max | Between 50% and 200% of job min |
| **Location** | `preferredCity` / `willingToRelocate` | City matches, or candidate will relocate |
| **Notice** | `noticePeriodDays` | ≤ 120 days |

### Decision

```ts
if (hardFilterCount === 0)                                   decision = "proceed"
else if (hardFilterCount <= 2 && (salary || exp || loc))     decision = "needs_review"
else                                                          decision = "filtered_out"
```

| Decision | Meaning | What the candidate gets |
|---|---|---|
| `proceed` | All four checks pass | `proceedBody` + **Call Now / In 10 min / In 30 min** buttons → AI call |
| `needs_review` | 1–2 concerns, at least one core check passes | **Nothing.** Silent. Routed to the HR review queue |
| `filtered_out` | 3+ failures | Nothing automatic — it is a *recommendation*, never an instruction |

`needs_review` is deliberately silent: no acknowledgement message is sent while HR decides.
An internal `pre_screen_review_queued` event is written to the thread instead. On HR approval
the flow resumes with `info_received_confirm` + booking. `filtered_out` never messages the
candidate on its own — a human has to act on it.

Checks that could not run (missing/unparseable data) are reported in `skippedChecks` rather
than silently counted as passes.

---

## 3. Templates — every one, with parameters

All templates are overridable per environment via `WHATSAPP_TEMPLATE_*`. The value shown is
the code default.

### Outreach and invitations

| Template | Params | Used by |
|---|---|---|
| `talent_outreach_v2` | `candidateName`, `jobTitle`, `companyName`, `location`, `salary` | Condition B/C opener |
| `shortlist_call_schedule_v2` | `candidateName`, `jobTitle`, `companyName` | Condition A/C shortlist |
| `screening_invite_v2` | `candidateName`, `jobTitle`, `companyName` | Legacy screening invite |
| `inbound_screening_invite` | `candidateName`, `jobTitle`, `companyName` | Inbound invite |
| `outbound_info_request` | `candidateName`, `jobTitle`, `companyName` | Outbound info ask |
| `inbound_info_request` | `candidateName`, `jobTitle`, `companyName` | Inbound info ask |

> `talent_outreach_v2` has **five** required body params. Meta rejects the entire send with
> `#131008 Required parameter is missing` if any one is empty, so a job with no `city` and no
> salary used to kill the message. `jobLocation()` falls back `city → location →
> work_location → state`, and `templateParam()` substitutes `"Multiple locations"` /
> `"As per industry standards"` so the send always has five values.

### Scheduling

| Template | Params | Trigger |
|---|---|---|
| `schedule_options` | `candidateName`, `jobTitle`, **`callerNumber`** | Post-pre-screen `proceed`, and portal slot booking |
| `ai_call_reassurance` | `candidateName`, `jobTitle`, `companyName`, **`callerNumber`** | Candidate anxious about an AI call |

`schedule_options` is accompanied by interactive buttons:

```ts
// app/api/whatsapp/webhook/meta/route.ts
body:   "✅ Thanks for sharing your details! Your profile looks like a good fit.\n\n" +
        "When should our AI recruiter call you for the quick screening?\n\n" +
        `Expect the call on ${AI_CALLER_NUMBER}. Please keep your phone handy.`
footer: "Reply 'call now' or pick a slot"
buttons: [ { id: "call_now" }, { id: "in_10_min" }, { id: "in_30_min" } ]
```

### Call nudges and follow-ups

| Template | Params | Trigger |
|---|---|---|
| `call_nudge` | `candidateName`, `jobTitle`, `companyName`, **`callerNumber`** | No reply after `nudgeHours` (default from `outreachNudgeHours()`) |
| `reminder_nudge` | `candidateName`, `jobTitle`, `companyName`, `location` | Second follow-up |
| `second_reminder_nudge` | *(none)* | Final nudge before escalation at `escalateHours` |
| `tried_calling` | `candidateName`, `jobTitle`, `companyName`, **`callerNumber`** | After an attempted call |
| `missed_call_reschedule` | `candidateName`, `jobTitle`, `companyName`, **`callerNumber`** | Candidate didn't pick up |
| `call_completed` | `candidateName`, `jobTitle`, `companyName`, **`callerNumber`** | Screening call finished |

Default ladder: `nudgeHours` **4** → `escalateHours` **8**, `maxCallAttempts: 2`
(`outreachNudgeHours()` / `outreachEscalateHours()`, env-overridable and clamped to 1–24).

### The caller number (`+918031805503`)

Every message that announces or books an AI call names the number the call will
come from. Carrier unknown-number screening and caller-ID blocking make a large
share of candidates decline an unrecognised call, and an unrecognised screening
call is indistinguishable from a scam call — which loses the candidate and reads
against the sender's WhatsApp quality rating.

The number lives in one place, `AI_CALLER_NUMBER` in `lib/whatsapp.ts`
(env-overridable via `WHATSAPP_AI_CALLER_NUMBER`).

**No re-approval needed** — session messages inside the 24-hour customer service
window. These already name the number:

- `app/api/whatsapp/webhook/meta/route.ts` — the post-pre-screen slot offer
  (`proceedBody`), the exact moment the candidate commits to a call
- `app/api/phone-screening/participants/[id]/pre-screen-review/route.ts` — the
  "our AI recruiter will call you shortly" approval notice

> The Aisensy sender is not used (the fallback branch in `sendTemplateMessage`
> is unreachable — it guards on `this.aisensy`, which is only ever assigned
> inside `getAisensyService()`). Meta is the only live provider.

#### ⚠️ Meta re-approval required for 7 templates

These seven bodies must be edited in **WhatsApp Manager → Message Templates** to
add the caller-number placeholder, then resubmitted. Meta returns any edit to
`PENDING`, and sends are blocked until `APPROVED`.

The placeholder index is **the next one after the parameters the template already
has**, so it is not always `{{4}}` — `schedule_options` carries only a name and a
role, so its slot is `{{3}}`. Adding `{{4}}` there leaves the send permanently
rejected for a parameter-count mismatch.

| Template | Existing params | Add to body (suggested wording) |
|---|---|---|
| `schedule_options` | 2 | `Expect our AI recruiter's call on {{3}}.` |
| `call_nudge` | 3 | `Expect our AI recruiter's call on {{4}}.` |
| `tried_calling` | 3 | `Expect our AI recruiter's call on {{4}}.` |
| `missed_call_reschedule` | 3 | `Expect our AI recruiter's call on {{4}}.` |
| `shortlist_call_schedule_v2` | 3 | `Expect our AI recruiter's call on {{4}}.` |
| `ai_call_reassurance` | 3 | `Our AI recruiter will call you from {{4}}.` |
| `call_completed` | 3 | `Questions? Our AI recruiter can be reached on {{4}}.` |

Meta rejects the **entire send** when the supplied parameter count does not match
the approved body, so the code cannot simply send the extra value ahead of
approval. Two mechanisms keep this safe:

1. **Opt-in switch (default OFF)** — the slot is only ever sent when
   `WHATSAPP_INCLUDE_CALLER_NUMBER=true`. Anything else omits it, so a deploy can
   never break a send on its own. The number lives in
   `WHATSAPP_AI_CALLER_NUMBER` (defaults to `+918031805503`).
2. **Per-template gate** — `CALLER_NUMBER_TEMPLATES` in `lib/whatsapp.ts`. Only
   names in this set get the extra parameter; every other template is sent
   without it and still succeeds. The safe outcome is always "number omitted",
   never "message failed".

> Because approval is tracked per WABA and per environment, the switch is
> deliberately per-environment too. Do not enable it in production until **that
> environment's** seven bodies are back to `APPROVED`.

**Deployment order:** update and re-approve the seven Meta templates *first*, set
`WHATSAPP_INCLUDE_CALLER_NUMBER=true` in that environment, then deploy. To roll
back without a code change, unset the variable or set it to anything other than
`true`. `sendShortlistSchedule` degrades safely on its own — a parameter-count
rejection (`132000`) on `shortlist_call_schedule_v2` falls through to the legacy
`shortlist_call_schedule`, which sends without the number rather than dropping the
candidate.

### Confirmations and closures

| Template | Params | Trigger |
|---|---|---|
| `info_received_confirm` | `candidateName`, `currentCtc`, `expectedCtc`, `noticePeriod` | Answers parsed, or HR approves `needs_review` |
| `info_reminder` | `candidateName` | No form submission |
| `not_interested_reason` | `candidateName` | Candidate taps Not Interested |
| `screening_filtered_out` | `candidateName`, `reason` | Filtered, when a message is warranted |
| `info_review_pending` | `candidateName`, `jobTitle`, `companyName` | Reserved for the review hold |

### Interactive (non-template) session messages

Free-form, only valid inside the 24-hour customer-service window after a candidate replies:

| Message | Purpose |
|---|---|
| Job link | Sent **after** `talent_outreach_v2`, gated by `waitForDelivery` |
| `proceedBody` + slot buttons | Shown after a passing pre-screen |
| `provide_details` shortcut | Sent instead of the form when the candidate already supplied the screening set |

---

## 4. Condition B — Outbound, step by step

```
Recruiter triggers screening (origin=outbound)
  │
  ├─ systemDecidesMode → quick_screen or collect_info_first
  │    (both lead to the same opener)
  │
  └─ sendOutboundWithJobLink()
       ├─ talent_outreach_v2  (candidateName, jobTitle, companyName, location, salary)
       │    status → whatsapp_sent | info_step → awaiting_interest
       │    info_data = {}  ← nothing collected until they opt in
       │
       └─ waitForDelivery(12s) → job-link session message
            Meta gives NO ordering guarantee; the link arrived ~5s BEFORE the
            template on a live run, so the candidate saw a bare URL first.
            Fixed in 4debcbe.

Candidate replies / taps
  │
  ├─ "Interested" ────────► collect_info_form (7 fields)
  │                          info_step → collect_form
  │                            └─ submit → pre-screen → §2
  │
  ├─ "Not Interested" ────► not_interested_reason → status not_interested
  │
  ├─ salary/role/location ─► question intent → answered from job data.
  │                          NO invite to re-send details if enough is known.
  │
  └─ call_now / in_10_min ► scheduleOrPlaceCall → AI call

No reply → call_nudge at nudgeHours → reminder_nudge → second_reminder_nudge at escalateHours
```

---

## 5. Condition C — Portal inbound, step by step

```
Candidate applied via talent.gatihire.com → application.source = "board-app"
  │
  └─ deriveCandidateFlow → "portal"
       │
       └─ sendShortlistMessage()
            ├─ shortlist_call_schedule_v2  (name, title, company)
            │    "You're shortlisted for <title> at <client>. Pick a slot for a quick screening call."
            │
            └─ seedAlreadyCollectedInfo(candidate)
                 info_data    ← CTC / expected / notice / relocation / experience
                 info_sources ← every seeded key stamped "application"
                 info_step    → confirmed

Candidate taps a slot / "call now" → scheduleOrPlaceCall → AI call → call result
```

**No re-collection, ever.** Two guards enforce this:

```ts
// lib/info-collector-v2/flow.ts
hasEnoughToScreen(participant)   // current_ctc && expected_ctc && notice_period
knownScreeningFields(participant)
```

- The `provide_details` button checks `hasEnoughToScreen` first and jumps straight to slot
  booking if the data is already there.
- `initializeInfoCollection` preserves existing `info_data` instead of blanking it.
- A re-trigger through `/trigger` also refuses to clear `info_data` when
  `hasEnoughToScreen` is true (`49d7631`).

---

## 6. Condition D — External inbound, step by step

```
HR uploads an externally-sourced resume, picks the origin in the Inbound action
  │
  └─ deriveCandidateFlow → "external"
       │
       └─ sendDetailedInfoMessage()
            └─ collect_info_form — WhatsApp Flow
               5 questions: current_ctc, expected_ctc, notice_period,
                            willing_to_relocate, reason_for_switching
               total_experience and location are NOT asked — they already exist on
               the candidate record and are merged at call time.
               (Code comments call this the "7-field" flow: 5 asked + 2 inherited.)
               status → info_requested | info_step → collect_form

Candidate submits
  │
  ├─ extract + normalize   ("800000" / "8 LPA" / "8L" → "8 LPA")
  │
  └─ evaluatePreScreenWithAI()
       │
       ├─ proceed ────────► proceedBody + Call Now / In 10 min / In 30 min
       │                     → scheduleOrPlaceCall → AI call
       │
       ├─ needs_review ───► SILENT. status → needs_review
       │                     needs_manual_followup = true
       │                     screening_context.awaitingReviewApproval
       │                     internal thread event pre_screen_review_queued
       │                     │
       │                     └─ HR approves (/api/phone-screening/review)
       │                          clears the hold + awaitingReviewApproval
       │                          → info_received_confirm → booking
       │
       └─ filtered_out ───► recommendation only. No automatic candidate message.

Incomplete form → ask only the missing fields. Empty/malformed response →
needs_manual_followup, never a pre-screen.
```

### Malformed / partial submissions

- Empty `response_json` or unparseable → `needs_manual_followup`, no pre-screen.
- Partial → questions are generated for the missing fields only.
- `flow_token` must match the participant; a mismatch is rejected rather than merged.

---

## 7. Call placement and double-click safety

```ts
// lib/scheduled-call.ts
scheduleOrPlaceCall(participantId, delaySeconds)
  ├─ delay ≤ 60s (DIRECT_PLACE_WINDOW_SECONDS) → placeCallImmediately()
  │    ├─ provider status is live        → { skipped: true }   ← double-click lands here
  │    ├─ retry/slot already booked      → { skipped: true }
  │    └─ otherwise                      → placeCallForParticipant()
  └─ delay > 60s → persist due time AND enqueue a QStash callback
                   (CALLBACK_RETRY_DELAY_SECONDS = 5 min on direct-placement failure)
```

`placeCallForParticipant` merges the collected answers over the seeded payload:

```ts
const collected = buildAlreadyCollectedUserData(row.info_data, { ... })
const userData  = { ...payload, ...collected, participant_id: participantId }
```

This matters because `call_payload_json` is seeded with 29 keys at participant creation while
the CTC / notice fields stay **empty** — the candidate's real answers only exist in
`info_data`. The old direct `call_now` sent the raw payload, so the call would have had
nothing to screen against.

**Double-click is safe** because every path funnels through `placeCallImmediately`, which
returns `skipped` when the provider already has a live execution. The previous direct
`placeBolnaCall` call bypassed that guard *and* hardcoded `call_attempts: 1`, so two rapid
clicks produced two concurrent Bolna executions and a reset attempt counter.

---

## 8. Status reference

| Field | Values |
|---|---|
| `status` | `whatsapp_sent`, `info_requested`, `call_scheduled`, `calling`, `in_progress`, `completed`, `not_interested`, `unreachable`, `needs_review`, `needs_manual_followup`, `failed`, `max_retries` |
| `info_step` | `awaiting_interest`, `collect_all`, `collect_form`, `confirmed`, `clarify` |
| `bolna_status` | `queued`, `initiated`, `ringing`, `in_progress`, `answered`, `completed`, `busy`, `no-answer`, `voicemail`, `failed`, `scheduled`, `max_retries` |
| `screening_mode` | `call_now`, `quick_screen`, `collect_info_first` |
| `prescreen_decision` | `proceed`, `needs_review`, `filtered_out`, `null` |

Call truth (shown in the pipeline) is derived by `lib/call-truth.ts` from provider-confirmed
statuses — never from wall-clock guesses.

---

## 9. Known gaps

1. **Answered-but-never-pre-screened.** A participant can sit at `info_step: confirmed` with
   answers in `info_data` and `prescreen_decision: null`, `call_attempts: 0`. Nothing in the
   UI surfaces this as a failure, so it recurs silently. Live example:
   `f554ed96-be40-4ea5-ab7b-d8fd37795d0c`.
2. **`ai_screen` tab filter.** Requires both `status === "ai_screen"` *and* a call-status row,
   so a candidate in that stage with no participant row is invisible in the tab.
3. **Whole-history overwrite.** Several write paths still assign `whatsapp_history: [...]`
   rather than appending, which can drop earlier entries.
4. **Template name drift.** Some history rows record `talent_outreach` while the template
   actually sent is `talent_outreach_v2`.
5. **`flow_token` is frequently null** on historical rows, so form correlation falls back to
   phone matching.
