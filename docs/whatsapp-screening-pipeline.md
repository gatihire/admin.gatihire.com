# WhatsApp Screening Pipeline — 3-Flow Architecture

Current source of truth for the WhatsApp-first AI screening flow (Truckinzy).
Supersedes parts of `whatsapp-journey-plan.md` / `whatsapp-meta-templates.md`
where noted. Reading time ~10 min — read this before touching anything in
`lib/call-orchestrator.ts`, `app/api/whatsapp/webhook/meta/route.ts`, or the
phone-screening trigger.

---

## 1. Objective

Deliver a single WhatsApp-first screening pipeline that:

1. Sends a **WhatsApp message** to every candidate (instead of instantly placing an AI call).
2. Lets the candidate **self-schedule** their AI screening call via quick replies.
3. Collects **7 compensation/detail fields** from candidates who don't already have them.
4. Lets the **system** decide the message type per candidate (HR's intent only matters for outbound).

The final nudge message for 7-field collection is a **WhatsApp Flows form**
(native in-chat form with individual input fields + placeholders), replacing the
older "reply all 7 values in one text message" template.

---

## 2. The Three Flows

Classified per candidate by `CandidateFlow` (`lib/origin.ts`):

| Flow | Source | Who arrives | What they get | Info collected |
|------|--------|-------------|---------------|----------------|
| **A — portal** | apply-form in the talent-portal / board-app (`board-app`, `applied`, `candidate_board`, …) | applied on our own board | `shortlist_call_schedule` template (no 7-field ask) | Already captured in the apply form (`current_ctc`, `expected_ctc`, `notice_period`) |
| **B — external** | external resume (`apna`, `naukri`, `workindia`, external resume upload, …) | inbound, resume-only | `collect_info_form` WhatsApp Flow (7 fields) | Pre-screened from the form, then candidate schedules |
| **C — outbound** | sourced profiles (`database`, `enhanced_match`, `recruiter_upload`) | outbound | initial `talent_outreach`; if interested → `collect_info_form` Flow | Same as B, after interest |

---

## 3. Who Decides the Nudge Type? — The SYSTEM

`systemDecidesMode(callMode, flow)` in `lib/call-orchestrator.ts`:

```ts
export function systemDecidesMode(
  callMode: ScreeningCallMode | undefined,
  flow: string
): ScreeningCallMode {
  if (flow === "portal") return "quick_screen"      // shortlist + schedule
  if (flow === "external") return "collect_info_first" // WhatsApp Flows 7-field
  return callMode || "call_now"                     // outbound only: HR's mode wins
}
```

Rules:
- **Flow A (portal)** → always `quick_screen` → `shortlist_call_schedule`. HR cannot force Call Now.
- **Flow B (external)** → always `collect_info_first` → form. HR cannot force Call Now.
- **Flow C (outbound)** → HR's chosen mode wins (`call_now` / `quick_screen` → outreach / `collect_info_first`).

This tells the UI to label the nudge button correctly:
- Inbound/portal/external → **"WhatsApp First"** (system auto-picks per flow; form or shortlist).
- Outbound only → **"Call Now"** is honored.

### Flow classification resilience (`flowForCandidate` in `orchestrateScreening`)

`candidate.source` is **frequently NULL** on the candidates row (the real source
lives on the `applications` row, e.g. `board-app`). Resolution order:

1. Application-derived source (`input.sourceByCandidate` map, from the applications table) — **preferred**.
2. Candidate's own `source` column.
3. Fallback heuristic: if `current_ctc || expected_ctc || notice_period` present on
   the candidate row → almost certainly a portal applicant → treat as **portal**.

The same precedence is used in the re-nudge path
(`renudgeExistingParticipant` in `app/api/phone-screening/trigger/route.ts`,
takes an explicit `source` param = application-derived).

---

## 4. WhatsApp Flows Form — `collect_info_form` (7-field)

### Why

The old `detailed_info_request` template required the candidate to reply with all
7 values in ONE text message (`"8 LPA, 12 LPA, 5 years, 30 days, Mumbai, yes, growth"`).
Fragile and annoying. WhatsApp Flows gives a native **form with individual input
fields and placeholder hints** inside the chat, opened by a FLOW button on a
template message.

### Flow (Meta side)

- **Flow name:** `truckinzy_candidate_screening`
- **Category:** `LEAD_GENERATION`
- **JSON version:** `7.3` (publishable range is `5.1 / 6.0–6.3 / 7.0–7.3`; `5.0` is send-only — **DO NOT use 5.0**, publishing will fail with `INVALID_FLOW_JSON_VERSION`)
- **Screens:**
  - `DETAILS_SCREEN` (entry, `terminal: false`) → `TextHeading` + `Form` (7 × `TextInput` with `helper-text` placeholders) + `Footer` "Submit" → `navigate` to `SUCCESS_SCREEN` with payload `${form.<field>}`
  - `SUCCESS_SCREEN` (`terminal: true`, `success: true`) → declares the 7 fields in its `data` model (each with `type: "string"` + `__example__`) → `Footer` "Done" → `complete` with payload `${data.<field>}`
- **Fields (names must match `buildCandidateInfoFromCollected` keys):**
  `current_ctc, expected_ctc, total_experience, notice_period, location, willing_to_relocate, reason_for_switching`

### v7 gotchas (learned the hard way)

- Every screen that receives data via `navigate` payload **must declare a `data`
  model** (schema per key) or publishing fails (`INVALID_NAVIGATE_ACTION_PAYLOAD` /
  `MISSING_REQUIRED_PROPERTY`).
- Each `data` model key **requires `__example__`**.
- Creating the flow with `publish: true` both creates AND publishes atomically.
  To iterate: `DELETE /{flow_id}` (draft only) then recreate.

### Template (Meta side)

- **Name:** `collect_info_form` — **category UTILITY**, language `en_US`
- **BODY:** `Hi {{1}}, thanks for your interest in the {{2}} position at {{3}}. Please share a few details in the form below so we can screen you for the role.`
- **BUTTONS:** single `FLOW` button, `text: "Share details"`, `flow_id`
- The FLOW button on send carries the participant correlation:
  - `flow_token` **= the `phone_screening_participants.id`** (this is how the
    webhook ties a form submission back to a participant)
  - `flow_action_data: { screen: "DETAILS_SCREEN" }`
- Requires Meta approval before it can be sent (status `PENDING` → `APPROVED`).

### Send (code)

`whatsapp.sendCollectInfoForm(...)` in `lib/whatsapp.ts`:
- template `process.env.WHATSAPP_TEMPLATE_COLLECT_INFO_FORM || "collect_info_form"`, language **`en_US`** (must match the created template's language)
- body params: candidate name, job title, company name
- button component: `{ type: "button", sub_type: "flow", index: "0", parameters: [{ type: "action", action: { flow_token, flow_action_data: {...} } }] }`

---

## 5. Code Path — Send

`lib/call-orchestrator.ts` → `orchestrateScreening(...)`:

1. Create `phone_screening_campaign` (status `in_progress`).
2. Insert one `phone_screening_participant` per candidate (pre-seeded):
   - portal → `status: whatsapp_sent`, `info_step: confirmed`, `info_data` seeded from apply form
   - collect → `status: info_requested`, `info_step: collect_all` (immediately overwritten below)
   - call_now (outbound only) → `status: calling` (no WhatsApp, directly `placeBolnaCall`)
3. Per candidate, per `systemDecidesMode`:
   - portal → `sendShortlistMessage` → `shortlist_call_schedule`, marks info `confirmed`
   - external / outbound-collect → `sendDetailedInfoMessage`
     (name kept for call-site stability; **internally sends the Flow form now**):
     - sends `collect_info_form` with `flow_token = participantId`
     - writes `info_step: "collect_form"`, `screening_context.infoViaForm: true`,
       `whatsapp_outbound_template: "collect_info_form"`
   - outbound-quick → `talent_outreach` (MARKETING reach-out); interested reply routes to 7-field form later

Re-nudge (`renudgeExistingParticipant`, trigger route) follows the same
classification and now also sends the **form** for extern/outbound-collect, resetting
`info_step: "collect_form"` and clearing `info_data`.

---

## 6. Code Path — Inbound Webhook

`app/api/whatsapp/webhook/meta/route.ts`

### Handshake
- `GET /api/whatsapp/webhook/meta?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`
  → 200 echo of challenge when token matches `WHATSAPP_VERIFY_TOKEN`, else 403.
- `POST`: HMAC-SHA256 body signature verified when `WHATSAPP_APP_SECRET` is set.

### Participant resolution (`handleIncomingMessage`)
- Normalize sender phone → match `candidates.phone_e164` (fast indexed path),
  fallback to full normalized scan (pagination in 1000-row chunks).
- NEVER filter `phone_screening_participants` by an embedded
  `candidates.phone = ` structured PostgREST filter — the LEFT JOIN silently
  returns `candidates: null` and nothing ever matches. Resolve candidate ids
  first in JS, then fetch the newest active participant.
- **Idempotency:** every processed message id is recorded in
  `screening_context.processedMessages`; redeliveries are skipped.

### Message dispatch
- `text` → step-by-step collector, or `collect_all` single-message parser
  (`handleCollectAllReply` → Gemini extraction via `extractAllFieldsFromReply`).
- `interactive.button_reply` → scheduling keys (`call_now`, `in_10_min`, `in_30_min`, …).
- `interactive.nfm_reply` → **Flow form submission** (`handleFlowFormReply`):
  - only acted on when `status === "info_requested" && info_step === "collect_form"`, else ignored
  - `JSON.parse(interactive.nfm_reply.response_json)` → fields
  - `willing_to_relocate` lowercased (`"Yes"` → `"yes"` — pre-screen checks for `yes`/`true`)
  - merges into `info_data`, then shared post-collect path

### Shared post-collect path (`finalizeCollectedInfo`)
Used by BOTH `collect_all` (text) and `collect_form` (Flow) — keeps behavior identical:

1. Runs `evaluatePreScreenWithAI(buildCandidateInfoFromCollected(info_data), jobRequirements, preScreenConfig)`.
2. Persists: `info_data`, `info_step: 'confirmed'` (sentinel; excludes from step-by-step re-ask),
   `info_confirmed: false`, `whatsapp_reply_text`, `info_received_at`,
   `screening_context.preScreenResult { decision, reasons, summary, evaluatedAt }`,
   `screening_context.infoReceivedVia` (`collect_all` | `collect_form`).
3. Branches by decision:
   - **proceed** → `status: info_received` → interactive buttons "Call Now / In 10 min / In 30 min"
   - **needs_review** → `status: needs_review` (HR reviews in parallel, candidate still schedules)
     → same buttons, body: *"Thanks for sharing your details! To take this forward, Ayush
     AIR needs a quick 5-10 minute call to understand your background. When should Ayush AIR call you?"*
   - **filtered_out** → `status: filtered_out` → friendly rejection message

Pre-screen config defaults (stored in `screening_context.preScreenConfig`):
`salaryTolerancePercent 40, experienceMinPercent 50, experienceMaxPercent 200, maxNoticePeriodDays 120`.

---

## 7. Environment — Meta / Vercel

| Env var | Value / notes |
|---------|---------------|
| `WHATSAPP_PHONE_NUMBER_ID` | `1431479740037671` (business phone WhatsApp number) |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | `1292918636194299` |
| `WHATSAPP_ACCESS_TOKEN` | Meta Graph token (**double-quoted in `.env.local` — strip quotes before curl**) |
| `WHATSAPP_VERIFY_TOKEN` | `gatihire_webhook_verify_2024` |
| `WHATSAPP_APP_SECRET` | app "GatiHire WP" (`1013084805107369`) secret — to detect a stale value, redeploy status shows 401 on signature mismatch |
| `WHATSAPP_TEMPLATE_SCREENING_INVITE` | **Stale in Vercel** — dashboard no longer exposes this; edit/remove via Vercel UI or CLI (`vercel env rm`). Code fallback is `screening_invite_v2` |
| `WHATSAPP_TEMPLATE_COLLECT_INFO_FORM` | optional override → `collect_info_form` |

**"A variable with the name X already exists for the target" error:** the same env
var is defined twice in Vercel (or set for both preview + production). Remove the
old value in the dashboard — deployed env vars override the code fallback.

**Deploys:** git push only. There is no CI; Vercel builds from `main`.

---

## 8. Templates Status (Meta-side)

| Template | Status | Used by |
|----------|--------|---------|
| `shortlist_call_schedule` | **APPROVED** | Flow A |
| `screening_invite_v2` | **APPROVED** | legacy / fallback only |
| `talent_outreach` | approved | Flow C first touch |
| `detailed_info_request` | legacy | **no longer sent**; kept for already-`collect_all` participants |
| `collect_info_form` | **PENDING review** | Flow B + Flow C interested (WhatsApp Flows) |

---

## 9. DB Columns That Matter

`phone_screening_participants`:
- `screening_mode`: effective nudge type (`collect_info_first`, `quick_screen`, `call_now`)
- `info_step`: `collect_all | collect_form | confirmed | <step>` (drives reply routing)
- `info_data`: JSONB of collected 7 fields
- `info_confirmed`: destructured from step-by-step; **do not confuse with portal pre-seed** (`info_confirmed: false`)
- `whatsapp_outbound_template`: last template sent
- `whatsapp_reply_text` / `whatsapp_reply_at` / `info_received_at`
- `screening_context`: JSONB — `processedMessages`, `preScreenResult`, `preScreenConfig`, `infoViaForm`, `infoReceivedVia`, `renudgedAt`
- `whatsapp_history`: JSONB array of `{ messageId, template, sentAt, status, kind? }`

---

## 10. Testing & Runbook

1. **Send path:** trigger from the admin UI (candidates tab) with the flow-aware
   nudge labels; verify participant `info_step` = `collect_form`, `whatsapp_outbound_template` = `collect_info_form`.
2. **Form reply:** candidate taps "Share details", fills the 7 fields, submits →
   webhook receives `interactive.nfm_reply` → participant status flips
   `info_received` / `needs_review` and schedule buttons arrive.
3. **Portal (Flow A):** candidate with apply-form CTC data gets
   `shortlist_call_schedule` only — never the 7-field form.
4. **Button replies:** `call_now` → immediate Bolna call; slot keys schedule.
5. **Duplicate message id** causes a silent skip — check `screening_context.processedMessages`.
6. **Raw inspection:** `curl -sS "https://graph.facebook.com/v21.0/{flow_id}?fields=status,validation_errors"`.

### Known pitfalls
- Never use flow JSON version `5.0` (send-only, publish fails).
- Never change `info_step` to `'confirm'` (typo of the sentinel **`confirmed`**)
  — it re-enters the step-by-step re-ask loop.
- Flow form data is trusted as-is; text `collect_all` still needs Gemini extraction.
- `willing_to_relocate` from the form is `"Yes"/"No"` → must be lowercased
  before the pre-screen (`"yes"`/`true` matches only).

---

## 11. Status / Next Steps

- Commits: `1b81eff` (3-flow routing), `2c8f00d` (system-decides),
  `5646d53` (screening-invite default), `f5e9d2d` (UI labels), `09768ea`
  (application-source classification fix), `4efe4c1` (needs_review wording),
  `1511e79` (Flow form send + webhook + shared finalize core).
- Flow `truckinzy_candidate_screening` **PUBLISHED** (id `3169363156607457`).
- Template `collect_info_form` (id `918009807775368`) **pending Meta approval** —
  blocking real send; after approval, test with a live candidate.
- Vercel env cleanup: remove stale `WHATSAPP_TEMPLATE_SCREENING_INVITE`.
- board-app: run `candidate_compensation_fields.sql` migration (CTC/notice/reason fields).
- Queue (pre-existing, not started): after-call modal redesign, re-call guard,
  regenerate-summary endpoint.