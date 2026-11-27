# HR-authored exact-time screening scheduler

## What this is

A separate flow from all existing outbound paths:

| Flow | Who decides the time | Call placed |
|---|---|---|
| `call-now` / nudge | HR, immediately | Now |
| `retry` | HR, after a failed/partial screening | Now |
| `offer-schedule` | Candidate picks from a WhatsApp slot picker | When candidate picks |
| **This flow** | **HR types the exact date/time after a manual phone conversation** | **At that exact time** |

HR often speaks to a candidate herself: *“Hi, I’m from GatiHire — our AI will screen you now, are you free?”*
If the candidate says no and proposes a time, HR currently writes it in Excel and manually presses **Call Now** later. This replaces that spreadsheet with a scheduler next to the existing nudge action.

The booking itself is the HR action. Auto-dialling at the booked time is therefore not an unattended call — it is the execution of an explicit HR commitment already made to the candidate.

## Status: build behind a flag, keep paused

Quality verification is still pending, so both server and client are gated:

- `ENABLE_HR_EXACT_TIME_SCHEDULING` — server flag on the schedule/cancel routes.
- `NEXT_PUBLIC_ENABLE_HR_EXACT_TIME_SCHEDULING` — hides the UI until enabled.

Both default to **false**. Enable only after two clean consenting calls pass the quality gate (3/3 topics, real-instance answers, no early language switch, no invented duration, no score on a partial call).

### Credential audit (checked before planning)

Verified from `.env.local` without printing secret values:

| Variable | Status |
|---|---|
| `QSTASH_TOKEN` | set, len 128 — read-only `/v2/schedules` call returned **200**, so the token is live |
| `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` | set, len 32 each — trigger signature verification will work |
| `QSTASH_URL` | `qstash-eu-central-1.upstash.io` |
| `PHONE_SCREENING_WEBHOOK_BASE` | `admin.gatihire.com` — trigger URL resolves correctly |
| `CRON_SECRET` | set — watchdog/reconcile cron auth is intact |
| `CALL_WINDOW_*` overrides | not set — automatic paths keep 10:00–19:00 IST, Mon–Sat; HR exact slots explicitly bypass this |
| Feature flags | not set — correctly off until quality sign-off |

No new credential is needed. Production must get the two feature flags as Vercel env vars when we are ready to enable.

## Data model (no migration needed for v1)

Stored on the participant row, not a new table:

| Field | Value |
|---|---|
| `status` | `call_scheduled` |
| `scheduled_call_at` | ISO UTC instant HR picked |
| `timezone` | `Asia/Kolkata` for HR-authored slots |
| `next_retry_at` | `null` — this slot supersedes the retry ladder |
| `screening_context.hrScheduledSlot` | `{ scheduledAt, note, bookedBy, bookedAt, source: "hr_exact_time" }` |
| `screening_context.approvalGranted` | `true` (HR is the approver) |
| `screening_context.awaitingScheduleDecision` | `false` (no picker outstanding) |

The existing `call_attempts` / `MAX_TOTAL_CALL_ATTEMPTS` budget still applies. An attempt is spent **when the provider accepts the call**, not when the slot is booked.

## API contract

### `POST /api/phone-screening/participants/[id]/schedule-call`

```json
{
  "scheduledAt": "2026-11-28T15:30:00+05:30",
  "timezone": "Asia/Kolkata",
  "note": "Candidate said: after 3pm tomorrow",
  "reason": "HR spoke to candidate on phone"
}
```

Validation, in order:

1. Auth + `applications.manage` or `outreach.send`.
2. Feature flag enabled.
3. Participant and phone exist.
4. No in-flight provider call (`in-progress`, `queued`, `ringing`, `initiated`).
5. No other future `scheduled_call_at` / `next_retry_at` — booking twice must be a 409, not two calls.
6. `call_attempts < MAX_TOTAL_CALL_ATTEMPTS`.
7. Lead time ≥ 5 minutes, horizon ≤ 7 days (QStash free-plan ceiling; safe on paid plans too).
8. No calling-hours restriction. HR spoke to the candidate and has explicit consent, so the QStash message carries `bypassCallingHours: true`. Automatic retries/watchdog still obey the 10:00–19:00 IST window.
9. `note` and `reason` are trimmed and stored in the audit trail.

Response: `{ success: true, ok: true, participantId, scheduledAt, scheduledAtIst, messageId, attempts, nextAttempt }`.

### `POST /api/phone-screening/participants/[id]/cancel-schedule`

Cancellation is mandatory in practice — candidates change their mind. Clears `scheduled_call_at`, `next_retry_at`, sets `status` back to the prior waiting state (stored in `screening_context.hrScheduledSlot.previousStatus`), and writes an HR action record. It must never cancel a call already with the provider.

## Placement

QStash **does** provide exact-time delivery: publish with `notBefore` (the `Upstash-Not-Before` header), a Unix timestamp in seconds. Max delay is 7 days on the free plan and 1 year on pay-as-you-go; the installed `@upstash/qstash` SDK supports `notBefore`. So we use QStash directly — no custom polling worker.

- Publish one message to `/api/phone-screening/call/trigger` with `notBefore: floor(dueAt/1000)` and body `{ participantId, bypassCallingHours: true }`. HR already has the candidate's verbal consent for that exact time, so the automatic window must not move the call.
- The existing QStash-signature-verified trigger calls `placeCallForParticipant(..., { guard: true, bypassCallingHours: true })`, which still owns the attempt cap, live-call guard and sibling-row guard.
- Store the QStash message id in `screening_context.hrScheduledSlot.messageId`; cancellation calls QStash `messages.cancel(messageId)` first, and the row guard is the second layer if that ever fails.
- On provider acceptance: `status = calling`, `bolna_status = queued`, increment `call_attempts`, clear the booking, log HR action `scheduled_call_placed`.
- If provider rejects: do **not** silently drop the slot — clear the booking, record placement failure, fall back to the existing retry ladder, and surface it in Today as a failed placement.
- The watchdog remains only a backstop for a QStash message that was published but not delivered.

## Outcomes and Today board

| Outcome | Participant state | Today work item | WhatsApp |
|---|---|---|---|
| Slot booked, not yet due | `call_scheduled` | **Scheduled** — shows IST time and booked-by | Confirmation only if template exists; otherwise none |
| Connected, complete screening | normal completed path | existing review/decide item | existing post-call flow |
| Connected but partial/incomplete | existing incomplete handling, no score/fit | **Needs review — incomplete screening** | existing incomplete flow |
| No answer / busy | `failed` + `needs_manual_followup` | **No answer — re-slot needed** | Send `missed_call_reschedule` asking for a new slot |
| Provider rejected the placement | placement-failure state | **Call not placed — re-slot needed** | Same re-slot template |
| Candidate declines on the call | existing explicit decline handling | existing review item | none extra |
| Attempt cap reached | `needs_manual_followup` | **Manual follow-up** | no more auto re-slot |

No-answer re-slot is idempotent per execution, reuses the existing WhatsApp send helper, and records the sent text in the thread so the recruiter sees what the candidate saw.

## Edge cases

| Case | Handling |
|---|---|
| HR books two slots for same candidate | Second request 409; one active slot only |
| HR re-books after no answer | Allowed while budget remains; previous slot is closed first |
| Candidate proposes a time outside 10:00–19:00 IST | Allowed — HR has explicit consent; message carries `bypassCallingHours: true` |
| Slot beyond QStash plan limit | Cap the picker at 7 days (safe on free + paid); show a clear message for later dates |
| Slot time passes while provider is paused | Do not dial; move to `needs_manual_followup` and show Today alert |
| Webhook fires late / watchdog and QStash both fire | Provider execution ID is the idempotency key; guard refuses a second dial |
| HR cancels after call is already live | Refuse cancellation; never cut a live call |
| Timezone confusion | Store UTC instant + `Asia/Kolkata`; always render IST in UI |
| DST | IST has no DST; fixed `+05:30` |

## Implementation plan (approved before code)

### 1. Scheduling primitives — `lib/scheduled-call.ts`

- Export `isLiveProviderStatus()` so both routes use the same live-call definition (`queued`, `initiated`, `ringing`, `in-progress`).
- Add `scheduleBolnaCallAt(participantId, dueAt, opts?: { bypassCallingHours?: boolean })`:
  - builds the same QStash trigger URL and body as today,
  - publishes with `notBefore: Math.floor(dueAt.getTime() / 1000)` instead of a relative `delay`,
  - HR booking calls this with `bypassCallingHours: true` so the exact time is honoured,
  - returns `{ scheduled, messageId?, error? }` from the publish response.
- Add `cancelBolnaScheduledCall(messageId)`: calls `client.messages.cancel(messageId)`, logs and returns success without throwing.
- Keep the existing `scheduleBolnaCall(delay)` untouched for retries/nudges — this change is additive only.

### 2. Shared HR-slot helpers — new `lib/hr-exact-schedule.ts`

- `hrSchedulingEnabled()` — reads `ENABLE_HR_EXACT_TIME_SCHEDULING`; defaults false.
- `validateHrSlot(scheduledAt, timezone, now)` — returns a typed `{ ok, dueAt?, error?, code? }`:
  - `invalid_time`, `past_or_too_soon` (<5 min), `too_far` (>7 days).
  - No calling-hours check: HR has explicit candidate consent, so the slot is honoured at the exact time even outside 10:00–19:00 IST.
- `bookHrExactSlot({ participantId, scheduledAt, timezone, note, reason, actor, actorId })` — loads the participant with candidate/job/campaign, applies all guards, writes the row + context in **one update**, publishes the QStash message with `notBefore`, and records HR action + activity. On publish failure it fails closed: clears the booking, sets `provider_error`, flags `needs_manual_followup`, returns a typed error.
- `cancelHrExactSlot({ participantId, actor, actorId })` — refuses if the call is live or already due; cancels the QStash message, restores `previousStatus`, clears booking fields, records audit.

### 3. Routes

- `POST /api/phone-screening/participants/[id]/schedule-call` — auth/permissions + flag, body `{ scheduledAt, timezone?, note?, reason }`, `reason` ≥ 10 chars. Returns `{ ok, participantId, scheduledAt, messageId, attempt }` or typed 400/409/422/502 errors.
- `POST /api/phone-screening/participants/[id]/cancel-schedule` — auth/permissions + flag, no body. Returns `{ ok, restoredStatus }`.

Both follow the existing `retry/route.ts` pattern: `getInternalAuthContext`, `hasPermission`, `recordHrAction`, `logCandidateActivity`, and never throw secrets to the client.

### 4. Audit types

- `lib/hr-action-history.ts`: add `schedule` and `cancel_schedule` actions, and a `cancelled` status, so thread lines read *“HR exact slot booked at 28 Nov, 3:30 pm IST — booked for …”*.
- `lib/activity-logger.ts`: add `hr_schedule_booked`, `hr_schedule_cancelled`, `hr_schedule_placed` event types for the candidate timeline and Super Admin metrics.

### 5. Call truth / Today

- `lib/call-truth.ts`: teach the `call_scheduled` branch about `booking_source === "hr_exact_time"` and use the label **“HR-booked exact slot”** with detail `Call at <IST time> · booked by <name>`; keep the existing “Call missed — not placed” outcome if the slot passed with no execution.
- Existing `getCallTruth` already supplies `no_answer`, `busy`, `partial` and `needs_manual_followup` buckets; Today needs new *work-item labels*, not new states:
  - `call_scheduled` + HR source → **Scheduled** (show IST time + booked-by).
  - `failed`/`unreachable` + `needs_manual_followup` after an HR-booked call → **No answer — re-slot needed**.
  - partial/incomplete after an HR-booked call → **Needs review — incomplete screening** (no score/fit).
- No-answer WhatsApp re-ask already exists in `lib/bolna-execution.ts` (`sendMissedCallReschedule`, once per execution). It will now serve HR-booked calls too; only its thread label needs to say it is a re-slot request.

### 6. UI

- `components/job-candidates-tab.tsx`: add a `schedule_exact` next action beside nudge/Call Again; open a dialog with `datetime-local` (IST), min = now+5 min, max = +7 days, note field, reason field. Show the booked slot on the card and offer **Cancel slot** while it is future.
- `components/phone-screening-results-sheet.tsx`: same action + current booking line in the header context, so HR can book/cancel without leaving the results sheet.
- `components/phone-screening-tab.tsx`: show the HR slot badge/time in the screening list.
- All UI gated by `NEXT_PUBLIC_ENABLE_HR_EXACT_TIME_SCHEDULING`; when false, no button appears and no route call is made.
- `components/today/TodayView.tsx` / dispatch work-item builder: add the three labels above to the existing action groups; no new group is required.

### 7. Tests and verification

- New `__tests__/hr-exact-schedule.test.ts`: invalid/past/soon/far validation, Sunday/19:00 slots explicitly allowed, IST rendering, `notBefore` epoch conversion, attempt-cap guard, duplicate-booking guard, live-call guard, publish-failure fail-closed path.
- Reuse existing `npm test`, `npx tsc --noEmit`, `npm run build`.
- Dry verification before enabling flags:
  1. Call `validateHrSlot` against a set of IST times (including Sunday and 19:00 exactly).
  2. Book one test slot with a fake participant in a scratch environment and inspect the stored context + planned QStash `notBefore` (no real dial).
  3. After quality sign-off, set both flags in Vercel, then have Snehal book one real slot and watch it fire once.

### 8. Rollout

- Flags stay off through this change set; code is deployable and inert.
- Enable only after two clean consenting calls pass the quality gate agreed earlier.
- If QStash delivery fails, the watchdog's `booked_not_fired` bucket rescues the row exactly as it does for candidate-requested slots today.
