import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"
import { getCallTruth } from "@/lib/call-truth"
import {
  deriveWorkItems,
  countsByKind,
  groupOverdue,
  INTERVIEW_LIVE_STATUSES,
  type WorkItemInput,
  type DispatchParticipant,
  type DispatchShortlist,
  type DispatchInterview,
  type DispatchWorkState,
  type DispatchStats,
  type RailInterview,
  type RailReady,
  type RailLiveCall,
} from "@/lib/dispatch/engine"

export const runtime = "nodejs"

// Statuses that can still have work waiting on a human. `hired` / `rejected` are
// done, and `applied` is handled automatically by the AI screen.
const ACTIVE_STATUSES = ["ai_screen", "hr_review", "shortlist", "client_review", "interview", "offer"]
const SHORTLISTED_OR_LATER = ["shortlist", "client_review", "interview", "offer", "hired"]

const MAX_APPLICATIONS = 20000
const INTERVIEW_LOOKAHEAD_DAYS = 7
// PostgREST caps a single response at the project's `max-rows` (1000 by default),
// so a bare `.limit(N)` silently truncates. Every unbounded read must page.
const PAGE_SIZE = 1000

async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
  max = MAX_APPLICATIONS
): Promise<{ data: T[]; error: any }> {
  const out: T[] = []
  for (let from = 0; from < max; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) return { data: out, error }
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE_SIZE) break
  }
  return { data: out.slice(0, max), error: null }
}

// An `.in(col, [ids])` filter with hundreds of UUIDs builds a URL that trips the
// server's header limit (414) and still caps at `max-rows`. Split the id list
// into chunks AND page within each chunk.
async function fetchInChunks(opts: {
  table: string
  select: string
  column: string
  ids: string[]
  order?: Array<{ col: string; asc: boolean }>
  chunkSize?: number
}): Promise<{ data: any[]; error: any }> {
  const { table, select, column, ids } = opts
  const chunkSize = opts.chunkSize ?? 150
  const out: any[] = []
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    for (let from = 0; ; from += PAGE_SIZE) {
      let q = (supabaseAdmin as any).from(table).select(select).in(column, chunk)
      for (const o of opts.order ?? []) q = q.order(o.col, { ascending: o.asc })
      const { data, error } = await q.range(from, from + PAGE_SIZE - 1)
      if (error) return { data: out, error }
      const rows = data ?? []
      out.push(...rows)
      if (rows.length < PAGE_SIZE) break
    }
  }
  return { data: out, error: null }
}

/**
 * Read work_item_states, tolerating a database that predates the "done" column
 * (20261017_work_item_done.sql). Selecting a column PostgREST does not know
 * about fails the whole query — which would take the Today page down — so fall
 * back to the older column set (no done_at) and treat every row as not-done.
 */
async function fetchWorkStates(ids: string[]): Promise<{ data: any[]; error: any }> {
  const columns =
    "application_id, snoozed_until, snooze_reason, last_manual_call_at, last_manual_call_outcome, last_manual_call_note, assigned_auth_user_id"
  const withDone = await fetchInChunks({
    table: "work_item_states",
    select: `${columns}, done_at`,
    column: "application_id",
    ids,
  })
  if (!withDone.error) return withDone

  const code = String((withDone.error as any)?.code || "")
  const msg = String((withDone.error as any)?.message || "").toLowerCase()
  const missingColumn =
    code === "42703" || code === "PGRST204" || msg.includes("done_at") || msg.includes("does not exist")
  if (!missingColumn) return withDone

  return fetchInChunks({ table: "work_item_states", select: columns, column: "application_id", ids })
}

function isMissingDbObject(err: any): boolean {
  const code = String(err?.code || "")
  const msg = String(err?.message || "").toLowerCase()
  return (
    code === "42P01" ||
    code === "PGRST106" ||
    code === "42703" ||
    code === "PGRST204" ||
    msg.includes("does not exist") ||
    (msg.includes("relation") && msg.includes("does not exist")) ||
    (msg.includes("function") && msg.includes("does not exist"))
  )
}

type Scope = "mine" | "team"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const canViewOwn = hasPermission(ctx, "dispatch.view") || hasPermission(ctx, "applications.view")
  const canViewTeam = hasPermission(ctx, "dispatch.view.team")
  if (!canViewOwn && !canViewTeam) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const requestedScope = searchParams.get("scope")
  const includeSnoozed = searchParams.get("includeSnoozed") === "true"
  const includeDone = searchParams.get("includeDone") === "true"
  const scope: Scope =
    requestedScope === "team" && canViewTeam ? "team" : requestedScope === "mine" ? "mine" : canViewTeam ? "team" : "mine"

  const me = ctx.authUser.id
  const now = new Date()

  // Collaborations for this user, plus the full job list (needed so header stats
  // count jobs whose only applicants are already hired, which the active-only
  // application query below cannot see).
  const [assignmentsRes, jobsPaged, appsPaged] = await Promise.all([
    supabaseAdmin.from("job_assignees").select("job_id").eq("auth_user_id", me),
    fetchAll<any>((from, to) =>
      supabaseAdmin
        .from("jobs")
        .select("id, title, status, owner_auth_user_id")
        .order("id", { ascending: true })
        .range(from, to)
    ),
    fetchAll<any>((from, to) =>
      supabaseAdmin
        .from("applications")
        .select(`
          id, job_id, candidate_id, status, origin, source, match_score, created_by, applied_at, updated_at,
          jobs:job_id (id, title, client_name, status, owner_auth_user_id, city, location),
          candidates:candidate_id (id, name, current_role, current_company, location, total_experience, expected_salary, notice_period)
        `)
        .order("id", { ascending: true })
        .range(from, to)
    ),
  ])

  if (appsPaged.error) {
    return NextResponse.json({ error: appsPaged.error.message }, { status: 500 })
  }

  const assignedJobIds = new Set((assignmentsRes.data ?? []).map((r: any) => String(r.job_id)))
  const allJobs = (jobsPaged.data ?? []) as any[]
  const allApps = (appsPaged.data ?? []) as any[]

  // Soft scope: everything is visible, but "mine" narrows to work this user
  // owns, collaborates on, or that nobody owns yet (an unassigned opening hidden
  // from everyone is work that silently dies).
  const inScope = (jobId: string, owner: string | null): boolean => {
    if (scope === "team") return true
    if (!owner) return true
    if (owner === me) return true
    return assignedJobIds.has(jobId)
  }

  const scopedJobs = allJobs.filter((j) => inScope(String(j.id), j.owner_auth_user_id || null))
  const scopedApps = allApps.filter((a) => a.jobs && inScope(String(a.job_id), a.jobs.owner_auth_user_id || null))
  const activeApps = scopedApps.filter((a) => ACTIVE_STATUSES.includes(String(a.status)))

  const appIds = activeApps.map((a) => String(a.id))
  const jobIds = Array.from(new Set(scopedApps.map((a) => String(a.job_id))))
  const candidateIds = Array.from(new Set(scopedApps.map((a) => String(a.candidate_id))))

  const [participantsPaged, statesPaged, sharesPaged, interviewsPaged] = await Promise.all([
    jobIds.length
      ? fetchInChunks({
          table: "phone_screening_participants",
          select: [
            "id",
            "job_id",
            "candidate_id",
            "status",
            "review_status",
            "bolna_execution_id",
            "bolna_status",
            "call_attempts",
            "next_retry_at",
            "scheduled_call_at",
            "call_duration_seconds",
            "call_voicemail",
            "call_hangup_reason",
            "call_disconnect_reason",
            "carrier",
            "callback_preference",
            "whatsapp_response",
            "whatsapp_reply_text",
            "whatsapp_reply_at",
            "whatsapp_sent_at",
            "outreach_nudge_count",
            "ai_score",
            "ai_summary",
            "ai_recommendation",
            "verdict_json",
            "ai_suggests_rejection",
            "needs_manual_followup",
            "updated_at",
          ].join(", "),
          column: "job_id",
          ids: jobIds,
          order: [
            { col: "updated_at", asc: false },
            { col: "id", asc: true },
          ],
        })
      : Promise.resolve({ data: [] as any[], error: null }),
    appIds.length
      ? fetchWorkStates(appIds)
      : Promise.resolve({ data: [] as any[], error: null }),
    appIds.length
      ? fetchInChunks({
          table: "shortlist_share_candidates",
          select: "application_id, status, decided_at, shortlist_shares:share_id (id, created_at)",
          column: "application_id",
          ids: appIds,
        })
      : Promise.resolve({ data: [] as any[], error: null }),
    appIds.length
      ? fetchInChunks({
          table: "job_interviews",
          select: "id, application_id, status, scheduled_at",
          column: "application_id",
          ids: appIds,
        })
      : Promise.resolve({ data: [] as any[], error: null }),
  ])

  // These four all drive classification, so a failure must not be swallowed into
  // an empty (and therefore wrong) queue — fail loudly instead.
  const readError =
    (participantsPaged as any).error ||
    (statesPaged as any).error ||
    (sharesPaged as any).error ||
    (interviewsPaged as any).error
  if (readError) {
    return NextResponse.json({ error: readError.message || String(readError) }, { status: 500 })
  }

  const participants = (participantsPaged as any).data ?? []
  const states = (statesPaged as any).data ?? []
  const shares = (sharesPaged as any).data ?? []
  const interviews = (interviewsPaged as any).data ?? []

  const participantByKey = new Map<string, DispatchParticipant>()
  for (const p of participants) {
    const key = `${p.job_id}:${p.candidate_id}`
    // Participants are ordered newest-first; keep the newest per job+candidate.
    if (!participantByKey.has(key)) participantByKey.set(key, p as DispatchParticipant)
  }

  const stateByApp = new Map<string, DispatchWorkState>()
  for (const s of states) stateByApp.set(String(s.application_id), s as DispatchWorkState)

  const shareByApp = new Map<string, DispatchShortlist>()
  for (const s of shares) {
    const appId = String(s.application_id)
    const entry: DispatchShortlist = {
      id: s.shortlist_shares?.id,
      status: s.status,
      decided_at: s.decided_at,
      created_at: s.shortlist_shares?.created_at || null,
    }
    const existing = shareByApp.get(appId)
    // A pending share is what still needs the client — let it win over a decided one.
    if (!existing || (entry.status === "pending" && existing.status !== "pending")) {
      shareByApp.set(appId, entry)
    }
  }

  const interviewByApp = new Map<string, DispatchInterview>()
  for (const iv of interviews) {
    const existing = interviewByApp.get(String(iv.application_id))
    // Prefer a rescheduled / not-yet-completed interview when several exist.
    if (!existing || iv.status === "rescheduled") {
      interviewByApp.set(String(iv.application_id), iv as DispatchInterview)
    }
  }

  const inputs: WorkItemInput[] = activeApps
    .filter((a) => a.jobs && a.candidates)
    .map((a) => ({
      application: {
        id: a.id,
        job_id: a.job_id,
        candidate_id: a.candidate_id,
        status: a.status,
        origin: a.origin,
        source: a.source,
        match_score: a.match_score,
        created_by: a.created_by,
        applied_at: a.applied_at,
        updated_at: a.updated_at,
      },
      job: a.jobs,
      candidate: a.candidates,
      participant: participantByKey.get(`${a.job_id}:${a.candidate_id}`) ?? null,
      shortlist: shareByApp.get(String(a.id)) ?? null,
      interview: interviewByApp.get(String(a.id)) ?? null,
      state: stateByApp.get(String(a.id)) ?? null,
    }))

  // Try DB-backed path first (view + counts) with safe fallback
  let items = groupOverdue(deriveWorkItems(inputs, { now, includeSnoozed, includeDone }))
  try {
    const countsRes = await (supabaseAdmin as any)
      .rpc("today_inbox_counts", { include_snoozed: includeSnoozed, include_done: includeDone, now_t: now.toISOString() })
    if (countsRes?.error && !isMissingDbObject(countsRes.error)) throw countsRes.error
    if (!countsRes?.error && countsRes?.data) {
      const vw = await (supabaseAdmin as any)
        .from("today_work_items")
        .select("*")
        .limit(5000)
      if (vw?.error && !isMissingDbObject(vw.error)) throw vw?.error
      if (!vw?.error && Array.isArray(vw.data)) {
        const mapped = vw.data
          .map((r: any) => {
            const app = activeApps.find((a) => String(a.id) === String(r.application_id))
            if (!app || !app.jobs || !app.candidates) return null
            const p = participantByKey.get(`${app.job_id}:${app.candidate_id}`)
            return {
              application: app,
              job: app.jobs,
              candidate: app.candidates,
              participant: p ?? null,
              shortlist: shareByApp.get(String(app.id)) ?? null,
              interview: interviewByApp.get(String(app.id)) ?? null,
              state: stateByApp.get(String(app.id)) ?? null,
            }
          })
          .filter(Boolean) as WorkItemInput[]
        items = groupOverdue(deriveWorkItems(mapped, { now, includeSnoozed, includeDone }))
      }
    }
  } catch (e) {
    // fall back to full Node path
  }


  // ── Header stats ───────────────────────────────────────────────────────────
  const stats: DispatchStats = {
    open_jobs: scopedJobs.filter((j) => String(j.status || "").toLowerCase() === "open").length,
    candidates: candidateIds.length,
    shortlisted_or_later: scopedApps.filter((a) => SHORTLISTED_OR_LATER.includes(String(a.status))).length,
    hired: scopedApps.filter((a) => String(a.status) === "hired").length,
    waiting: items.length,
    with_client: scopedApps.filter((a) => String(a.status) === "client_review").length,
  }

  // ── Right rail ─────────────────────────────────────────────────────────────
  const appById = new Map<string, any>(activeApps.map((a) => [String(a.id), a]))
  const appByJobCandidate = new Map<string, any>(
    activeApps.map((a) => [`${a.job_id}:${a.candidate_id}`, a])
  )

  const horizon = new Date(now.getTime() + INTERVIEW_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000)
  const railInterviews: RailInterview[] = (interviews as any[])
    .filter((iv) => {
      if (!iv.scheduled_at) return false
      const t = new Date(iv.scheduled_at).getTime()
      if (!Number.isFinite(t)) return false
      if (t < now.getTime() || t > horizon.getTime()) return false
      const st = String(iv.status || "")
      return INTERVIEW_LIVE_STATUSES.includes(st) || st === ""
    })
    .map((iv) => {
      const app = appById.get(String(iv.application_id))
      if (!app) return null
      const participant = participantByKey.get(`${app.job_id}:${app.candidate_id}`)
      return {
        applicationId: String(app.id),
        participantId: participant?.id ? String(participant.id) : null,
        candidateId: String(app.candidate_id),
        candidateName: app.candidates?.name || "Unnamed candidate",
        jobId: String(app.job_id),
        jobTitle: app.jobs?.title || "Untitled role",
        clientName: app.jobs?.client_name || null,
        status: iv.status || null,
        scheduledAt: iv.scheduled_at,
      } as RailInterview
    })
    .filter((x): x is RailInterview => !!x)
    .sort((a, b) => new Date(a.scheduledAt || 0).getTime() - new Date(b.scheduledAt || 0).getTime())

  const readyByJob = new Map<string, RailReady>()
  for (const item of items) {
    if (item.kind !== "shortlist") continue
    const entry = readyByJob.get(item.jobId)
    if (entry) entry.count += item.groupCount ?? 1
    else
      readyByJob.set(item.jobId, {
        jobId: item.jobId,
        jobTitle: item.jobTitle,
        clientName: item.clientName,
        count: item.groupCount ?? 1,
      })
  }
  const railReady = Array.from(readyByJob.values()).sort((a, b) => a.jobTitle.localeCompare(b.jobTitle))

  const railLiveCalls: RailLiveCall[] = (participants as any[])
    .map((p) => {
      const truth = getCallTruth(p)
      if (truth.bucket !== "calling") return null
      const app = appByJobCandidate.get(`${p.job_id}:${p.candidate_id}`)
      if (!app) return null
      return {
        applicationId: String(app.id),
        participantId: p.id ? String(p.id) : null,
        candidateId: String(app.candidate_id),
        candidateName: app.candidates?.name || "Unnamed candidate",
        jobId: String(app.job_id),
        jobTitle: app.jobs?.title || "Untitled role",
        callLabel: truth.label,
        since: p.scheduled_call_at || p.updated_at || null,
      } as RailLiveCall
    })
    .filter((x): x is RailLiveCall => !!x)

  // Viewer identity for the greeting.
  const { data: profile } = await supabaseAdmin
    .from("internal_users")
    .select("name, email")
    .eq("auth_user_id", me)
    .maybeSingle()

  return NextResponse.json({
    scope,
    canViewTeam,
    viewer: {
      id: me,
      name: profile?.name || null,
      email: profile?.email || ctx.authUser.email || null,
    },
    generatedAt: now.toISOString(),
    stats,
    counts: countsByKind(items),
    items,
    rail: {
      interviews: railInterviews,
      ready: railReady,
      live_calls: railLiveCalls,
    },
  })
}
