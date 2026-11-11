# Incomplete / Failed AI Call Screening — Architecture & Edge-Case Plan

## Goal
When an AI screening call is attempted but **not completed as a valid screening** (candidate couldn’t hear, audio issue, hung up early, auto-cut/system drop, synthesizer/provider error, no meaningful transcript), the system must:
1. **Not** present it as a successful “View results” screening.
2. Show **“1st screening incomplete” / “View 1st uncompleted screening”** with clear context: *who ended the call* (candidate / AI agent / system/auto) and *reason* (from Bolna `hangup_by`, `hangup_reason`, disconnect reason, transcript signals).
3. Give HR explicit next actions: **Send call again** (primary) and **WhatsApp** (open conversation / reschedule flow). **Inbound calling is disabled** on current numbers, so UI/copy must not imply inbound call-back unless that changes.
4. **Flag the profile** in `/jobs` (AI screen/pipeline) and `/today` (dispatch) as needing follow-up.

## Signals (source of truth = Bolna + our derived state)

| Signal | Source | Meaning |
|---|---|---|
| `bolna_status` | Bolna execution | Provider-confirmed terminal/transport state (`completed`, `stopped`, `canceled`, `failed`, `no-answer`, `busy`, `in-progress` during call) |
| `hangup_by` | Bolna/telephony | Who ended: candidate/user, agent, system/provider/platform |
| `call_hangup_reason` / `call_disconnect_reason` | Bolna telephony | Why ended (audio, synthesizer, timeout, network, etc.) |
| `call_duration_seconds`, transcript/turn count | Execution | Too short / no engagement → not a valid screening |
| Transcript patterns | Derived | “cannot hear / not able to listen / audio issue / inaudible”, immediate hangup, unavailable |
| `status` / `call_is_partial` | Our DB | `failed` + `call_is_partial=true` = disconnected mid-conversation; `failed` + incomplete classification = not screened. (`failed_partial` is **not** an allowed status in the DB check constraint and must never be written.) |
| `classification_outcome` (logical) | Persisted in `verdict_json._classification_outcome` (and future-proof field if column added) | `screened` \| `not_screened` \| `interrupted` \| `retry` \| `voicemail` |
| `needs_manual_followup` | Participant flag | Surfaces in dispatch/today and ops views |

> Note: `classification_outcome` DB column may not exist in all environments; code stores classification in `verdict_json` metadata to avoid schema coupling.

## State model / classification rules

### `handleCompletedExecution` (Bolna reports completed-ish payload with data)
- Classify as **`not_screened`** when: very short duration, <2 candidate turns, candidate hung up very early, or transcript indicates audio/unavailable/can’t-hear patterns; or verdict unreliable.
- Classify as **`interrupted`** when mid-conversation ended without proper closing/recommendation (maps to `failed_partial`).
- For `not_screened`/`interrupted`: set `needs_manual_followup=true`, do not trust scores, store transcript/recording when available, persist classification + hangup metadata in `verdict_json`, and write a clear HR-facing summary (“1st screening incomplete…”).

### `handleFailedExecution`
- Terminal failures (`no-answer`, `busy`, `failed`, `stopped`/partial): store hangup metadata, set `needs_manual_followup` when HR action is needed, preserve partial transcript/verdict when present, schedule retry per existing ladder (bounded by `MAX_CALL_ATTEMPTS`).
- Partial calls (`failed_partial`, `call_is_partial`) are **incomplete screenings**, not silent failures.

### Webhook finalization (existing)
- Webhook finalizes non-terminal-looking statuses when completion data/disconnect is evident; prevents stuck `in_progress`/`call-disconnected` rows. Reconcile (`GET /api/bolna/reconcile`) remains the safety net (schedule via cron in deployment).

## UI behavior

### Call truth (`lib/call-truth.ts`)
- If provider says `completed` but classification is `not_screened`/`interrupted` or call is partial → state **`partial`**, bucket **`review`**, label **“1st screening incomplete”**, detail includes **who ended + reason** and “review transcript and retry call”.
- `stopped/canceled`/`failed_partial` → **“1st screening incomplete”** with end reason.
- Exposes `describeCallEnd()` for consistent “candidate ended / AI agent ended / auto-cut/system ended + reason”.

### `/jobs` AI screen (pipeline cards)
- Incomplete screening → CTA **“View 1st uncompleted screening”** (opens results), not “View results” as a completed success.
- Failed-but-has-call-data cases → review + **Send Call Again** (where appropriate) instead of dead-end “Manual Follow-up” only.
- Results sheet: incomplete banner, **call ended** summary (who/why) in header context and **end of transcript**, recording refresh, actions **Send Call Again** + **WhatsApp** tab (reschedule/schedule flow only; inbound disabled).

### `/today` (dispatch)
- Incomplete screenings are flagged via call-truth bucket `review`/`failed`/partial + `needs_manual_followup` → routed as **human/needs attention** items (not “completed call to review” as success).
- “human” items include **Send call again** action (uses call-now) alongside review/decide. Results sheet provides full context and WhatsApp.

### HR next actions (policy)
- **Send call again**: primary recovery for incomplete screenings / couldn’t hear / cut early (respect attempt caps and audit/reason where required by endpoint).
- **WhatsApp**: open thread; send reschedule/schedule messages as supported. Do not promise inbound call-back while inbound is disabled.
- Optional: reject/advance only after review when evidence is sufficient; incomplete screening alone is not a valid completed assessment.

## Edge cases & handling

| Case | Detection | UX/state |
|---|---|---|
| Candidate couldn’t hear / audio issue | Transcript/hangup reason patterns, short/failed engagement | 1st screening incomplete, show audio reason, needs follow-up, send call again |
| Candidate hung up early | `hangup_by` candidate/user, short duration/turns | 1st screening incomplete, “Candidate ended call…” |
| Auto-cut / provider/system error | `hangup_by` system/provider or synthesizer/timeout/network errors | 1st screening incomplete, “Auto-cut/system…” |
| Dropped mid-conversation | `failed_partial`, `stopped/canceled`, `call_is_partial` | 1st screening incomplete, partial transcript preserved |
| Voicemail/IVR | provider status/classification | Voicemail (not a completed human screening) |
| No answer / busy (no conversation) | provider status | Failed/no-answer with retry/follow-up; not “completed screening” |
| Duplicate/stuck webhooks or missed terminal sync | webhook idempotency gaps / ordering | Webhook finalize + `reconcile` heals; `sync-execution?force=1` refreshes signed recording URLs |
| Signed recording URL expired | playback/403/expiry | UI “Refresh from Bolna” (`sync-execution?participantId=&force=1`) |

## Root causes found on 2026-11-11 (calls "stuck on the call now" + missing summaries)

1. **Unknown column rejected the whole terminal write (PGRST204).**
   `buildFallbackVerdictPatch` and `storeFallbackSummary` included `fallback_summary_used`, which is not a column. PostgREST rejects the entire `UPDATE` when one key is unknown, so status, transcript, recording, verdict and summary were all discarded. The provider call was finished, the webhook fired, but the row stayed `in_progress` — "On the call now" for hours.
   - Fixed by storing the flag inside `verdict_json._fallback_summary_used` and adding `updateParticipantSafely()` (`lib/participant-update.ts`), which drops a reported unknown column and retries, logging every drop.

2. **A fallback patch overwrote the terminal status with `undefined`.**
   `buildFallbackVerdictPatch` returned `{ status: undefined }` for normal-length calls and callers merged it with `Object.assign`, erasing the `status: "completed"` set moments earlier. Even after (1) was fixed, the row could not leave `in_progress`.
   - Fixed by only including `status` when it must change, and by merging fallback keys with undefined values skipped.

3. **`failed_partial` violates the status CHECK constraint.**
   Interrupted/partial calls tried to write `failed_partial`, which is not allowed, so the entire patch was rejected — partial calls never persisted at all. The status column allows `failed`; `call_is_partial` already carries the distinction.
   - Fixed: write `failed` + `call_is_partial=true`; never write `failed_partial`.

Also fixed while here: transcript segments and screening answers are replaced (not appended) on re-handling so webhook retries/reconcile do not duplicate rows; post-call WhatsApp is idempotent per execution; `call_ended_at` uses the provider's terminal timestamp instead of repair time.

## Operational safeguards
- **Webhook**: finalize when terminal evidence exists; keep idempotent processing.
- **Reconcile cron**: `vercel.json` now schedules `GET /api/bolna/reconcile` every 5 minutes. The route accepts `Authorization: Bearer $CRON_SECRET` (or `x-cron-secret`) so Vercel Cron can run without a user session — **`CRON_SECRET` must be set in the deployment environment**, otherwise the schedule gets a 401 (logged in Vercel).
  - Heals `calling`, `in_progress`, `in-progress`, `initiated`, `queued`, `ringing`, `call-disconnected` older than 3 minutes.
  - After 90 minutes with the provider still reporting in-progress, marks the call `failed` + follow-up instead of showing it as live forever.
  - After 60 minutes with no provider record of the execution, marks it `failed` + follow-up with an explicit "outcome could not be confirmed" summary.
- **On-view healing**: opening a participant sheet (`GET /api/phone-screening/participants/[id]`) re-checks Bolna when the row is non-terminal and older than 2 minutes, so HR sees the truth even if cron is not configured.
- **Manual refresh**: results sheet **Refresh from Bolna** / **Generate summary** (`sync-execution?participantId=&sync=1&force=1`).
- **Observability (recommended)**: log/metric counters for `not_screened`, `interrupted`, `auto_cut`, `audio_issue`, `stuck_reconciled`, `participant_update_dropped_columns`; alert on spikes.
- **Data migration (optional, recommended)**: add `classification_outcome`; keep `fallback_summary_used` inside `verdict_json` unless a real column is added.

## Files touched (this change set)
- `lib/bolna-execution.ts` — classification in verdict metadata, audio patterns, `needs_manual_followup`, hangup metadata persistence
- `lib/call-truth.ts` — incomplete screening detection, “1st screening incomplete” labels, `describeCallEnd()`
- `components/job-candidates-tab.tsx` — “View 1st uncompleted screening”, Send Call Again for actionable failed/incomplete cases
- `components/phone-screening-results-sheet.tsx` — incomplete banner, call-end (who/why) incl. end of transcript, Send Call Again + WhatsApp actions
- `lib/dispatch/engine.ts` — `/today` human items include “Send call again”
- `app/api/bolna/webhook/execution/route.ts` — (previous) finalize on disconnect/completion evidence
- `app/api/bolna/sync-execution/route.ts` — manual/force refresh from Bolna
- `app/api/bolna/reconcile/route.ts` — heals stuck executions
