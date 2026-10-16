# Today Dispatch + Job Assignment + Super Admin Attribution — Plan

Status: **Phase 0 + 1 + 2 + 3 implemented** (decisions locked, code shipped) · Source design: `~/Downloads/GatiHire Dispatch.html` (prototype)
Goal: a recruiter opens the app and sees **"Candidates waiting on you"** — every application that needs a human decision right now, scoped to the jobs they own — and Super Admin can **assign jobs to people** and **see who did what** for today or any date range.

## Decisions locked (2026-10-14)

1. **Decision engine** = a server-side, deterministic rules module that inspects each application and decides the one action needed, its urgency/SLA and owner. Not an LLM router. → `lib/dispatch/engine.ts`.
2. **Ownership** = per job, with optional collaborators. `jobs.owner_auth_user_id` + `job_assignees`.
3. **Scoping** = soft. Everything stays visible; the Today queue defaults to "mine" and unassigned work is included so it is never invisible.
4. **Build order** = Phase 0 + 1 first. Phases 2 (assignment UI) and 3 (super-admin action metrics) follow.

## Shipped in Phase 0 + 1

- `supabase/migrations/20261014_dispatch_foundations.sql` — `jobs.owner_auth_user_id`, `job_assignees`, `work_item_states`, `candidate_activity.actor_auth_user_id`, new permission keys (`dispatch.view`, `dispatch.view.team`, `jobs.assign`, `jobs.claim`) + role grants, owner backfill, RLS.
- `lib/activity-logger.ts` — `actorAuthUserId` on activity writes; new `queue_snoozed` / `queue_unsnoozed` / `manual_call_logged` / `job_reassigned` / `job_claimed` event types.
- Actor id threaded through the human-action routes: AI-screening review, pre-screen review, bulk review, manual WhatsApp send/nudge, manual call retry, application stage change, and shortlist share (which previously logged nothing).
- `lib/dispatch/engine.ts` — the pure decision engine (rules, SLA, priority, actions).
- `lib/dispatch/work-item-states.ts` — shared snooze / log-call mutation.
- `app/api/dispatch/today/route.ts` — the queue (`scope=mine|team`), with stats and per-kind counts.
- `app/api/dispatch/work-items/route.ts` + `.../[applicationId]/route.ts` — snooze / unsnooze / log a call (bulk + single).
- `app/(internal)/today/page.tsx` + `components/today/TodayView.tsx` — the Today queue UI (chips, SLA pills, row actions, bulk snooze, log-call dialog, Mine/Everyone toggle).
- `components/sidebar.tsx` — **Today** nav entry; `app/(internal)/dashboard/page.tsx` redirects to `/today`.

**Not yet shipped:** Phase 4 (the design's client/billing chips). The migration must be applied to the database before the feature works.

---

## Production hardening (found while making it prod-safe)

Applying the feature against the real database surfaced several things that would have silently broken in production:

| # | Problem | Impact | Fix |
|---|---------|--------|-----|
| P1 | `.limit(5000)` on `applications` was capped at PostgREST's `max-rows` (1000) | The board only ever saw the newest ~38% of **2,625** applications — **~60% of work items invisible** (queue read 59 items; correct is 152) | Real `Range`-header pagination (`fetchAll` / `fetchInChunks`); verified all 2,626 rows now load |
| P2 | `.in("job_id"/"application_id", [hundreds of UUIDs])` | URL grows past the server header limit (414) and still caps at 1000 rows as data grows | Chunked `in` + paging (`fetchInChunks`, 150 ids/chunk) |
| P3 | Secondary reads (`participants`, `states`, `shares`, `interviews`) ignored `.error` | A failed read silently produced a **wrong** queue (e.g. every shortlist looked unshared) | Fail loudly with 500 |
| P4 | `PUT /api/applications/[id]` had **no auth at all** | Any caller could rewrite an application's status and fire a rejection email | Require signed-in staff + `applications.manage` |
| P5 | Dispatch write routes accepted `dispatch.view` | A view-only user could snooze/log calls (mutate state) | Require `applications.manage` |
| P6 | Analytics "To" date was midnight + routes use `created_at < to` | The selected end day was silently excluded; a "Today" range was empty | Push `to` to the next midnight (inclusive) |

Verified: `npx tsc --noEmit` clean, ESLint clean on changed files, `npm run build` succeeds, and the attribution path was validated end-to-end against the live DB (a synthetic attributed `stage_changed → shortlist` row counted correctly, then deleted).

---

## Shipped since (Phase 1 — full candidate board · Phase 2 — assignment)

### Today board is now data-driven, not the prototype's demo numbers
The prototype's chip counts (`All 11 / Needs a human 2 / Replied 1 / AI flagged 3 / Calls to review 2 / Client approved 1 / Client overdue 1 / Offers 1`) are **sample data**. Our board builds its chips from live pipeline state, so the counts reflect the real queue. Verified against the live DB:

| chip (kind) | live count | source |
|---|---|---|
| Needs a human (`human`) | 4 | participant `needs_manual_followup` / `needs_review` / call bucket review·failed |
| **No reply** (`ghosted`) | 2 | participant `whatsapp_sent` / `info_requested`, no reply, ≥ 12h since we messaged |
| Replied (`reply`) | 2 | free-text `whatsapp_reply_text` on an `ai_screen` app |
| AI flagged (`hold`) | 10 | `hr_review` app with no completed screening to read (parked on a human decision) |
| Calls to review (`call`) | 1 | `ai_screen`/`hr_review` with a completed screening |
| Client approved (`client`) | 1 | `interview` app with no interview scheduled |
| Ready to send (`shortlist`) | 35 | `shortlist` app not yet shared with the client |
| Offers (`offer`) | 4 | `offer` app open ≥ 48h |
| Reschedule (`resched`) | 0 | interview round cancelled / rescheduled / past-due |

`Client overdue` (`overdue`) is 0 because no app is in `client_review` yet; `hr_review` is **not** a UI pipeline column and nothing in the app sets it, so its rows are mapped to `hold` (a human decision) rather than the old "Calls to review", which was wrong for rows with no call.

### New: `ghosted` ("No reply") work item
Directly answers *"what we send and we didn't get a reply — they ghosted us"*. A candidate who has gone quiet surfaces as a **No reply** row (CTA **Nudge on WhatsApp**, plus Call manually / Log a call / Snooze), aged from `whatsapp_sent_at`. Fresh sends (< 12h) are treated as normal waiting, not ghosting. Candidates whose application is already `rejected` are **not** surfaced — the work is done even though the participant row still says `whatsapp_sent`.

### Hybrid actions (execute inline where an API exists, deep-link for full-screen work)
- **Inline API calls:** Nudge on WhatsApp (`participants/[id]/send-message`), Drop (`PUT /api/applications/[id]`, gated on `applications.manage`), Snooze / Log a call (`dispatch/work-items`), Call manually (`phone-screening/call-now`), Remind the client (`jobs/[id]/shortlist-share` with `resendShareId`), and Take over / Review / Questions (`PhoneScreeningResultsSheet`) and Open conversation (`WhatsAppConversationModal`) as embedded modals.
- **Deep-links** for anything full-screen: `/jobs/{jobId}?tab=pipeline&stage={stage}`, with `stage` suppressed unless it is a real pipeline column.

### Everything else on the board
Header (greeting, scope, refresh), stat strip (Open jobs / Candidates / Shortlisted or later / Hired / Waiting / With clients), per-kind chips from present kinds, bulk bar (Nudge on WhatsApp / Snooze 1 day / Drop / Clear) with per-row pending spinners, rich rows (kind icon, title, job·client·meta, detail, quote, pills), `RowMenu` (I called them / Not now / callback), log-call + callback-time dialogs, right rail (Interviews this week, Ready to send to the client, On the line / live calls), and the "N with clients" footer note.

### Phase 2 — assignment (shipped)
- `jobs.owner_auth_user_id` + `job_assignees`, `lib/jobs/assignments.ts`.
- APIs: `PUT /api/jobs/[id]/assignees`, `POST /api/jobs/[id]/claim`, `GET /api/jobs/assignable-users`.
- UI: `components/job-assignment-card.tsx` (`JobAssignmentCard` + `AssignOwnerDialog`), **Owner** column + owner filter on the jobs list, owner/Unassigned row action, assignment card on job detail.
- **Deferred within Phase 2:** multi-select **bulk assign** from the jobs table (per-job assign is shipped).

---

## 1. The three things being asked for

1. **Today queue ("Candidates waiting on you")** — the recruiter action list from the design. Not the whole prototype: the queue, its filters, and its actions.
2. **Job assignment + collaboration** — Super Admin assigns a particular job opening to a user (or several), and the assigned job is "handled by the concerned person". Others can collaborate if granted.
3. **Super Admin metrics** — who did what, for **today** and **any date range**, built on the work items and existing activity tables.

Plus the design's framing: the queue is not a hard-coded list, it is produced by a **decision engine** that inspects each application/participant and decides "does this need a human, what action, how urgent, who owns it".

---

## 2. What we already have (reuse, don't rebuild)

### Auth & identity
- Supabase Auth (`auth.users`) is the identity source. `internal_users(auth_user_id, email, name, disabled, created_at, last_active_at)` is the staff profile.
- `lib/internal-auth.ts` → `getInternalAuthContext()` returns `{ authUser, isSuperAdmin, permissionKeys, fieldRules }`; `hasPermission(ctx, key)`.
- `lib/server-internal-permissions.ts` → server components.
- `components/sidebar.tsx` → nav; `app/(internal)/layout.tsx` → shell; `app/(internal)/dashboard/page.tsx` → role-based redirect only.

### RBAC (already strong)
- Tables: `roles`, `permissions`, `role_permissions`, `user_roles`, `user_permissions` (per-user overrides), `permission_field_rules`, `user_permission_field_rules`.
- SQL helpers: `is_super_admin()`, `has_permission(key)`, `current_user_permission_keys()`, `current_user_field_rules()`, `grant_role_to_user()`.
- Permission keys in use: `candidates.view|edit|search|search-only|pii.view|salary.view`, `jobs.view|post|edit`, `applications.view|manage`, `outreach.view|send`, `analytics.view`, `export.data`, `users.manage`, `roles.manage`.
- Roles seeded: `super_admin`, `admin`, `recruiter`, `viewer`, `hr_executive`, `intern`, `candidate_viewer`.
- Super Admin UI: `components/super-admin/SuperAdminHub.tsx` → tabs **Analytics** (`SuperAdminAnalytics.tsx`) and **Team & Access** (`SuperAdminAccess.tsx`: create user, set role, per-user permission overrides, field rules).
- Super Admin APIs under `app/api/super-admin/…`: `me`, `metrics`, `overview`, `roles`, `permissions`, `users`, `users/[id]/{roles,permissions,field-rules,stats,activity}`, `analytics/{overview,growth,jobs,candidates,outreach,team,events,sourcing}`.

### Pipeline / domain data
- `jobs` — has `created_by`, `status`, `last_activity_at`, plus rich structured fields. **No owner / assigned recruiter column.**
- `applications` — `job_id`, `candidate_id`, `status`, `origin` (inbound/outbound), `source`, `match_score`, `created_by`, `applied_at`.
  Stage set: `applied → ai_screen → hr_review → shortlist → client_review → interview → offer → hired / rejected`.
- `candidates` — has `uploaded_by_auth_user_id`.
- Phone screening: `phone_screening_participants` + `lib/call-truth.ts` (single source of truth for call state), `lib/pre-screen.ts`, WhatsApp threads, `review_status`, `verdict_json`, `ai_score`, `ai_recommendation`.
- Shortlist sharing: `shortlist_shares`, `shortlist_share_candidates` (`pending|approved|rejected`, `decided_at`) — the client-review decision loop.

### Activity / attribution (partial)
- `candidate_activity` — `job_id, candidate_id, application_id, participant_id, event_type, event_data JSONB, actor TEXT, created_at`. Written by `lib/activity-logger.ts` (`logCandidateActivity`, `logCandidateActivityBatch`) with event types: `applied, ai_screen_started, whatsapp_sent|delivered|read|replied, call_attempted|in_progress|completed|failed|missed, callback_scheduled, screening_reviewed, screening_clarification_*, stage_changed, notes_updated, interview_*, shortlist_shared, client_decision`.
  ⚠️ `actor` is a free-text string, **not** an `auth_user_id` — so it cannot be attributed reliably today.
- `analytics_events` — `actor_auth_user_id, event_name, entity_type, entity_id, metadata, created_at` (properly attributed) + `POST /api/analytics/track`.
- Existing per-user metrics are **creation counts only**: `jobs_created`, `candidates_uploaded`, `outreach_messages`, `applications_created` (`super-admin/analytics/team`, `users/[id]/stats`, `overview`). No "actions taken" metrics.

### Shortlist sharing
`shortlist_shares` + `shortlist_share_candidates` — client approve/reject writes back to the pipeline (`app/api/public/shortlist/[token]`, `app/api/jobs/[id]/shortlist-share`).

---

## 3. Gaps this feature must fill

| # | Gap | Why it blocks the goal |
|---|-----|------------------------|
| G1 | No job ownership / assignment (`jobs` has no `owner`, no assignment table) | "assigned jobs handled by the concerned person" and scoping the queue |
| G2 | No collaboration / multi-assignee model | "or they can collaboratively do certain things" |
| G3 | No Today queue / action-item aggregation | "Candidates waiting on you" |
| G4 | No "decision engine" that classifies an application into a needed action | the queue has to be computed, not hand-maintained |
| G5 | `candidate_activity.actor` is text → not attributable | Super Admin "who did what" per user/date |
| G6 | Metrics are creation-counts only | need action metrics: reviews cleared, replies handled, calls placed, shortlists shared, decisions, hires |
| G7 | No snooze / "I called them" state on work items | the design's snooze/log-call menu |
| G8 | No scope filtering by owner across jobs/candidates/clients | every list shows everything to everyone |

---

## 4. Concept model

### 4.1 Ownership
Introduce a single **job assignment** concept, deliberately kept simple and additive:

- `jobs.owner_auth_user_id` — the **primary assignee** ("the concerned person"). Nullable; null = unassigned / team-owned.
- `job_assignees` (many-to-many) — optional collaborators per job, with a `role` (`owner | collaborator | viewer`) and `assigned_by`, `assigned_at`.

Rules:
- **Owner** sees the job and all its applications in their Today queue and lists.
- **Collaborator** sees the job but the queue marks items as "shared" rather than "yours" (still actionable if they have `applications.manage`).
- **Super Admin / admin** see everything; can assign/reassign.
- **Unassigned** jobs fall into an "Unassigned" pool visible to Super Admin/admin and to anyone with a new `jobs.claim` permission.
- Reassignment is audited (see §8) and the previous owner stops seeing it.

### 4.2 Work items (queue entries) are derived, not stored — except for operator state
The queue itself is **computed** from live pipeline state by the decision engine. The only thing stored is operator metadata that the engine cannot infer:
- `work_item_states` (new): `application_id` (PK), `snoozed_until`, `snooze_reason`, `last_manual_call_at`, `last_manual_call_outcome`, `assigned_auth_user_id` (nullable override), `updated_by`, `updated_at`.
- Keeps the engine stateless and the operator's snooze/hide choices durable.

### 4.3 The "decision engine" (§6)
`lib/dispatch/engine.ts` — pure functions: given a job + application + participant (+ shortlist share + owner), return zero or one `WorkItem`:
`{ kind, applicationId, jobId, candidateId, ownerId, priority, slaHours, waitingSince, title, detail, quote?, cta, actions[] }`.

This is the direct port of the prototype's `queueItems()` and its `QT` map, adapted to real data. It is the reusable core for Today, the rail badge, Team metrics and the AI/overrun reporting.

---

## 5. Data model changes (migrations)

New migration, e.g. `supabase/migrations/20261015_job_assignment_and_work_items.sql`:

```sql
-- G1/G2: ownership + collaboration
alter table public.jobs
  add column if not exists owner_auth_user_id uuid references auth.users(id) on delete set null;
create index if not exists idx_jobs_owner on public.jobs(owner_auth_user_id);

create table if not exists public.job_assignees (
  job_id uuid not null references public.jobs(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'collaborator' check (role in ('owner','collaborator','viewer')),
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (job_id, auth_user_id)
);

-- G7: operator state on the derived queue
create table if not exists public.work_item_states (
  application_id uuid primary key references public.applications(id) on delete cascade,
  snoozed_until timestamptz,
  snooze_reason text,
  last_manual_call_at timestamptz,
  last_manual_call_outcome text,
  assigned_auth_user_id uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- G5: make activity attributable (keep actor text for back-compat, add the id)
alter table public.candidate_activity
  add column if not exists actor_auth_user_id uuid references auth.users(id) on delete set null;
create index if not exists idx_candidate_activity_actor on public.candidate_activity(actor_auth_user_id, created_at desc);

-- G6: fast action metrics without scanning JSON
--   (optional) denormalised action log; or query candidate_activity + analytics_events directly.
```

Notes:
- RLS: keep the existing "authenticated can read/manage" pattern for now; ownership **visibility** is enforced in the API/query layer (like today), since the app reads via the service-role client in most routes.
- Backfill: `jobs.owner_auth_user_id = jobs.created_by` for existing jobs, then Super Admin adjusts.

---

## 6. The decision engine

`lib/dispatch/engine.ts` (+ `lib/dispatch/rules.ts`).

**Input** per application: `{ application, job, candidate, participant?, shortlistShare?, workItemState?, now }`.
**Output**: `WorkItem | null`.

Rule set (Phase 1 — port the prototype's queue, mapped to real columns). Order matters; first match wins:

| kind | Trigger (real data) | CTA | SLA / urgency |
|------|--------------------|-----|----------------|
| `human` | `status = ai_screen` and call truth bucket `failed`/`review`, or participant `needs_manual_followup`/`needs_review`, or a WhatsApp reply that wants a human (`call_me_now`/`schedule`) | Take over / Call manually | high |
| `ghosted` | `status = ai_screen`, participant `whatsapp_sent`/`info_requested`, no `whatsapp_reply_text`, ≥ 12h since we messaged | Nudge on WhatsApp | medium |
| `reply` | `status = ai_screen` and latest WhatsApp thread message is inbound and unanswered | Open conversation | high |
| `call` | `status = ai_screen` or `hr_review` with a **completed** screening and no rejection flag | Review the call | medium |
| `hold` | `status = hr_review` with no completed screening to read (parked on a human decision), or `aiSuggestsRejection` | Review and decide | medium |
| `client` | `status = interview` and no interview scheduled | Schedule interview | medium |
| `resched` | interview round cancelled / rescheduled / past-due | Pick a new time | high |
| `overdue` | `status = client_review` and shortlist share `pending` > 48h | Remind the client | medium |
| `offer` | `status = offer` open ≥ 48h | Confirm joining | medium |
| `shortlist` | `status = shortlist` (ready to send) — surfaces in the side panel | Share shortlist | low |
| *(phase 4)* `agr`, `renew`, `inv`, `guar`, `cred`, `join` | client/billing-driven (design's other chip types) | — | — |

Also returns `waitingSince` (age) → the UI's `waiting 3h` / SLA colour, and a **priority** = `f(age, kind, job urgency)`.

**Ownership filter** applied after the engine: a user sees items where `job.owner_auth_user_id = me OR job_assignees(me) OR work_item_states.assigned_auth_user_id = me`; Super Admin sees all.

Endpoint: `GET /api/dispatch/today?scope=mine|team&range=...` → `{ items, countsByKind, jobs, stats }`.
Realtime: reuse `phone_screening_participants` realtime channel pattern and subscribe to `applications` changes for the owned jobs.

---

## 7. Permissions / RBAC additions

New permission keys (seeded, assigned to sensible roles):
- `jobs.assign` — assign/reassign a job to a user, manage `job_assignees` (Super Admin / admin by default; optionally a team lead).
- `jobs.claim` — claim an unassigned job.
- `applications.manage` (exists) — authority to action queue items.
- `dispatch.view.team` — see the whole team's queue, not just your own.

Role defaults:
- `recruiter`: `jobs.view/post/edit`, `applications.view/manage`, `outreach.*`, `dispatch.view` (own). New: scoped to owned jobs.
- `admin` / `super_admin`: `jobs.assign`, `dispatch.view.team`.
- Add a **"Recruiter (scoped)"** behaviour: when a non-admin has no `dispatch.view.team`, all job/application/candidate queries are filtered by ownership (G8).

UI: extend `SuperAdminAccess.tsx` with the new permission keys (they appear automatically once seeded) and add **assignment** controls on the job page/list (§9.2).

---

## 8. Attribution — "who did what"

To answer "who did what, today and any date range" we need every action to carry the actor id.

1. **Extend `logCandidateActivity`** to accept `actorAuthUserId` and write `actor_auth_user_id`. Update the call sites that represent human actions:
   - `screening_reviewed` (approve/reject/review) — `app/api/phone-screening/participants/[id]/review`, `pre-screen-review`, `.../review`.
   - `stage_changed` — `app/api/applications/[id]` PUT.
   - `shortlist_shared` — `app/api/jobs/[id]/shortlist-share`.
   - `interview_scheduled` / `interview_status_changed` — interviews routes.
   - `notes_updated`.
   - New events: `queue_snoozed`, `manual_call_logged`, `job_reassigned`, `job_claimed`.
   Pass `ctx.authUser.id` from the route (already available in every route).
2. **Keep `actor` text** for display/back-compat; `actor_auth_user_id` is the join key.
3. **`analytics_events`** already has `actor_auth_user_id` — keep using it for cross-cutting actions (login, upload, job create).

Metric definitions (`lib/dispatch/metrics.ts`), per user, per date range:

| Metric | Source |
|--------|--------|
| Screenings reviewed (cleared) | `candidate_activity` `screening_reviewed` where `actor_auth_user_id=me` |
| Candidates shortlisted | `stage_changed → shortlist` by actor |
| Candidates approved/rejected | `stage_changed → hired/rejected` + review events by actor |
| Calls placed (manual) | `manual_call_logged` / `call_*` with actor |
| Replies handled | `whatsapp_replied` followed by actor action |
| Shortlists shared | `shortlist_shared` by actor |
| Interviews scheduled | `interview_scheduled` by actor |
| Jobs assigned / claimed | `job_reassigned` / `job_claimed` |
| Hires | `stage_changed → hired` by actor |
| Queue SLA | items still open past `slaHours` (from engine) |

API: extend `GET /api/super-admin/analytics/team` (already has `from`/`to`) to return these; add `GET /api/super-admin/analytics/actions?userId=&from=&to=` for a per-user drilldown and `GET /api/dispatch/metrics?range=today|7d|custom`.
UI: Super Admin → Analytics → **Team** tab gets the action columns + a per-user drawer; add a **Today** preset.

---

## 9. UI work

### 9.1 Today view (new)
- New route `app/(internal)/today/page.tsx` + `components/today/*`:
  - Header: greeting, scope pill ("Your N jobs" / "Whole company"), scope toggle (mine / team).
  - Stat strip: Open jobs, Candidates, Shortlisted or later, Hired.
  - **Candidates waiting on you** card: filter chips (`All`, `Needs a human`, `Replied`, `AI flagged`, `Calls to review`, `Client approved`, `Reschedule`, `Overdue`, `Offers`…), the `qrow` list with `waiting Xh` SLA pill, quote, meta, and per-row actions.
  - Bulk bar (nudge / snooze / drop) when rows are selected.
  - Side panel: Interviews this week, Ready to send to client, On the line.
- Nav: add **Today** to `components/sidebar.tsx`; make `/dashboard` redirect here; rail badge = open item count.
- Reuse `getCallTruth` (`lib/call-truth.ts`) for call states — do **not** invent new call status logic.

### 9.2 Assignment UI
- Job list (`app/(internal)/jobs`): an **Owner** column + a filter; row action "Assign".
- Job detail (`app/(internal)/jobs/[id]`): an **Assignment** card — primary owner dropdown (internal users), collaborator list, "Reassign" and "Claim" (if unassigned).
- Bulk assign from the jobs table (Super Admin), matching the prototype's `reassign` modal ("They see these jobs and their queues immediately. The previous owner no longer does.").
- API: `PUT /api/jobs/[id]/assignees` (owner/collaborators), `POST /api/jobs/[id]/claim`, and respect `jobs.assign` / `jobs.claim`.

### 9.3 Super Admin
- Analytics → **Team**: add action metrics + date range (today / 7d / 30d / custom), per-user row click → drawer with the drilldown.
- Access tab: new permission keys appear automatically; add a short helper text for `jobs.assign` / `dispatch.view.team`.

---

## 10. Phased delivery

**Phase 0 — foundations (no UI risk)** ✅
1. Migration: `jobs.owner_auth_user_id`, `job_assignees`, `work_item_states`, `candidate_activity.actor_auth_user_id`.
2. Seed new permissions; backfill `owner = created_by`.
3. Extend `logCandidateActivity` with `actorAuthUserId`; thread it through the human-action routes.

**Phase 1 — decision engine + Today (the ask: "Candidates waiting on you")** ✅
4. `lib/dispatch/engine.ts` + rules.
5. `GET /api/dispatch/today` with ownership scoping.
6. `/today` page: full candidate board — chips, rich rows, hybrid per-row actions, bulk bar, log-call/callback dialogs, right rail, "N with clients" note. Includes the `ghosted` ("No reply") kind.
7. Sidebar entry + badge; `/dashboard` redirect → `/today`.

**Phase 2 — assignment** ✅ (bulk assign still open)
8. Assignment API + job list owner column/filter + job-detail assignment card + per-job assign. **Open:** multi-select bulk assign from the jobs table.
9. Ownership scoping across jobs/candidates/applications lists for non-team viewers.

**Phase 3 — Super Admin attribution** ✅
10. `lib/dispatch/metrics.ts` (pure activity → per-action counts), `GET /api/super-admin/analytics/actions` (per-user, date range), Team tab gets an **Actions taken** leaderboard with click-to-expand per-user breakdown + **Today / 7 days / 30 days** quick ranges. Fixed a long-standing range off-by-one (the "To" day was excluded).
    Attribution gaps closed: `interview_scheduled` / `interview_status_changed` were never logged at all; `ai_screen_started` (trigger) and `screening_reviewed` (reconcile) logged the actor only in the display `actor` field — all now write `actor_auth_user_id`.

**Phase 4 — the rest of the design's chips** ⏳
11. Client/billing items (`agr`, `renew`, `inv`, `guar`, `cred`, `join`) — needs client ownership + agreements data, which don't exist yet. Also deferred: the design's route card and week card.

**Phase 5 — WhatsApp replies at every stage + inbox** ✅
12. **Reply detection was stage-blind.** The `reply` / `human` / `ghosted` checks lived *inside* the `ai_screen` branch, so a candidate who replied while at `shortlist` / `interview` / `offer` surfaced nowhere in Today. `declined` (`not_interested`) produced no row at all. Both now evaluate at the top of `deriveKind`, for every active stage.
13. **"Replied" now means *unanswered*.** `whatsapp_reply_text` is never cleared, so its mere presence said nothing about whether a human had already answered — a replied-and-answered candidate stayed "Replied" until the stage moved. `hasUnansweredReply()` compares the last inbound (`whatsapp_reply_at`) against the last outbound (`whatsapp_sent_at`), so the row clears the moment we reply.
14. **Manual sends now stamp `whatsapp_sent_at`.** Only automated senders set it; manual messages and call nudges left no trace of having replied. `appendWhatsappHistory` now stamps it on any `direction: "out"` entry, covering every manual path in one place.
15. **New `declined` work-item kind** ("Candidate declined") — surfaces a `not_interested` reply with Open conversation / Call / Log a call / Snooze, across stages.
16. **New `/whatsapp` inbox** — one row per *thread* (a `phone_screening_participant`), not per application, because a candidate can be talking to us on a thread with no live application. Chips: Needs a human / Needs reply / Declined / No reply / All, computed from the same pure helpers the engine uses (`lib/dispatch/conversations.ts`) so the two surfaces can never disagree. Reuses `WhatsAppConversationModal` (live thread + Supabase Realtime), supports nudge / call now / open job, and adds a sidebar unread badge via `GET /api/whatsapp/inbox?countsOnly=1`.
    - No new schema: "unread" is derived (still waiting on us) and self-clears, avoiding a migration that can't be applied from here.

---

## 11. Open questions / decisions needed

1. **"Decision engine"** — I'm reading this as *the server-side rules module that classifies each application into the one action a human must take* (§6). Is that the intent, or do you mean an external/LLM-driven engine that also ranks and routes (e.g. auto-assign to the best-fit recruiter, auto-snooze, LLM summaries in the row)?
2. **Ownership granularity** — one owner per job (+ collaborators), or also per-application ownership (some candidates on a job handled by different people)? The prototype is per-job; per-application is more flexible but more UI.
3. **Who can assign?** Super Admin only, or also admin / team leads?
4. **Scoping enforcement** — should a recruiter be *unable* to see jobs they don't own (hard scope), or just see them with an "not yours" marker (soft scope)? Hard scope changes many existing list queries.
5. **Collaboration meaning** — shared visibility + action, or an approval/claim workflow on individual candidates?
6. **Date range = action date or pipeline state?** e.g. "hired today" = the application moved to hired today (action date) vs was hired and remains hired. I propose **action date** (from the activity log).
7. **Client/billing chips** (agreements, renewals, invoices, credits) — in scope now or Phase 4? They need client ownership + billing tables that don't exist yet.

---

## 12. Immediate recommendation

Start with **Phase 0 + Phase 1**: the data foundations, the actor attribution, and the `/today` "Candidates waiting on you" queue. That delivers the visible ask and is the prerequisite for meaningful Super Admin metrics. Phase 2 (assignment) can land in parallel since it's additive (`jobs.owner_auth_user_id` + assignees), and Phase 3 metrics depend on Phase 0's attribution.
