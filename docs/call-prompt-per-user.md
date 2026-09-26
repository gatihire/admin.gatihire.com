# AI Call Prompt — Per-User Personalization (Paste-Ready)

Status: **already implemented + working.** The Ayush call prompt is ONE template
(`BOLNA_MASTER_PROMPT_HINGLISH` / `BOLNA_MASTER_PROMPT`, both in `lib/bolna.ts`).
It is NOT edited per candidate — the placeholders below are filled with that
candidate's own data at call-placement time.

> This file is safe to paste into prompts, tickets, or onboarding notes. Code
> references: `lib/bolna.ts`, `lib/call-orchestrator.ts`,
> `lib/prompt-user-data.ts`, `lib/scheduled-call.ts`, `lib/jd-questions.ts`.

---

## 1. How the prompt changes "for each user"

| What changes per user | Source | Where it's injected |
|----------------------|--------|---------------------|
| `{candidate_name}`, `{current_role}`, `{current_company}`, `{skills}`, `{origin}` | candidate row (origin: inbound/outbound) | `buildCallUserData` → `call_payload_json` |
| `{job_title}`, `{hiring_company_name}`, `{job_location}`, `{salary_range}`, `{job_category}`, `{must_have_skills}`, `{experience_min/max}` | job + client rows | same `userData` |
| `{already_collected_current_ctc}` … **07 fields** | **WhatsApp info_data** (form/text) or portal pre-seed | `buildAlreadyCollectedUserData` (`lib/prompt-user-data.ts`) |
| `{questions}` (3–5 NEW-signal questions) | Gemini `generateJDQuestions(job, candidate, infoData)` — auto-skips anything already captured | `lib/jd-questions.ts` |
| `{participant_id}` | enforcement / tracking | call-time overlay |

**Timing — the key part:**
1. At **message-send** time the payload is built (info may be empty/partial).
2. At **call-placement** time (`lib/scheduled-call.ts`, `procScheduledCall`) the
   row's current `info_data` is re-read and **overlaid**:
   `{ ...call_payload_json, ...buildAlreadyCollectedUserData(info_data), participant_id }`.
   So whatever the candidate typed into the WhatsApp **form** (or replied in text)
   is the exact truth the AI sees. Fresh data always wins.

---

## 2. The 07 already-collected fields — where each value comes from

Key contract: the field names in `info_data` MUST match the `{already_collected_*}`
tokens and the Flow form input names (they all do — `lib/prompt-user-data.ts`).

| Token in prompt | info_data key | Flow B/C (WhatsApp) | Flow A (portal pre-seed) |
|-----------------|--------------|---------------------|--------------------------|
| `already_collected_current_ctc` | `current_ctc` | WhatsApp form / text | apply form → `candidates.current_ctc` |
| `already_collected_expected_ctc` | `expected_ctc` | WhatsApp form / text | apply form → `candidates.expected_ctc` |
| `already_collected_notice_period` | `notice_period` | WhatsApp form / text | apply form → `candidates.notice_period` |
| `already_collected_total_experience` | `total_experience` | WhatsApp form / text | candidate profile → `candidates.total_experience` |
| `already_collected_location` | `location` | WhatsApp form / text | candidate profile → `candidates.location` |
| `already_collected_willing_to_relocate` | `willing_to_relocate` | WhatsApp form / text | **NOT collected** → stays "Not provided on WhatsApp" |
| `already_collected_reason_for_switching` | `reason_for_switching` | WhatsApp form / text | apply form → `candidates.reason_for_switching` |

**Portal seeding** (`seedAlreadyCollectedInfo`, `lib/call-orchestrator.ts`):
only fields we genuinely know are seeded. Anything unset renders as
**"Not provided on WhatsApp"** in the prompt — the AI treats it as a NEW signal
to probe on the call (e.g., relocation willingness). That is intended, not a bug.

Missing-but-known risk: **portal `willing_to_relocate` is never captured at apply
time.** If we add it to the ApplyStepper in the future, seeding it here is a 1-line
change (`info.willing_to_relocate = ...`).

---

## 3. Rule the prompt itself enforces (no code needed)

The prompt's "WHAT WE ALREADY KNOW" block says: treat the 07 fields as facts,
**DO NOT ask again**; only gently clarify once if the candidate contradicts one.
The "NEW-SIGNAL QUESTIONS" block only adds things NOT already captured. Goals per
call: confirm firm availability/joining date + 3–5 new signals + CTC-story consistency.

---

## 4. Verification

- Portal candidate → prompt shows seeded CTC/notice/total-xp/location/reason, and
  only reloc-willingness + availability are probed.
- External/outbound candidate → all 07 filled from the WhatsApp form; the AI never
  re-asks; schedule buttons follow pre-screen decision.
- Re-call (reschedule/retry) → `lib/scheduled-call.ts` re-reads `info_data`, so an
  updated form also updates the call prompt automatically.