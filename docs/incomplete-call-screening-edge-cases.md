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
| `status` / `call_is_partial` | Our DB | `failed_partial` = disconnected mid-conversation; `failed` + incomplete classification = not screened |
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

## Operational safeguards
- **Webhook**: finalize when terminal evidence exists; keep idempotent processing.
- **Reconcile cron**: run `/api/bolna/reconcile` periodically to heal stuck `in_progress/calling/call-disconnected` rows.
- **Observability (recommended)**: log/metric counters for `not_screened`, `interrupted`, `auto_cut`, `audio_issue`, `stuck_reconciled`; alert on spikes.
- **Data migration (optional, recommended)**: add `classification_outcome`, `call_hangup_reason`/normalize fields if missing in some envs, backfill from `verdict_json._meta` and Bolna sync for historical rows.

## Files touched (this change set)
- `lib/bolna-execution.ts` — classification in verdict metadata, audio patterns, `needs_manual_followup`, hangup metadata persistence
- `lib/call-truth.ts` — incomplete screening detection, “1st screening incomplete” labels, `describeCallEnd()`
- `components/job-candidates-tab.tsx` — “View 1st uncompleted screening”, Send Call Again for actionable failed/incomplete cases
- `components/phone-screening-results-sheet.tsx` — incomplete banner, call-end (who/why) incl. end of transcript, Send Call Again + WhatsApp actions
- `lib/dispatch/engine.ts` — `/today` human items include “Send call again”
- `app/api/bolna/webhook/execution/route.ts` — (previous) finalize on disconnect/completion evidence
- `app/api/bolna/sync-execution/route.ts` — manual/force refresh from Bolna
- `app/api/bolna/reconcile/route.ts` — heals stuck executions
