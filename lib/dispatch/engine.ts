// The dispatch "decision engine".
//
// Given a live snapshot of the pipeline (applications with their job, candidate,
// screening participant, shortlist share, interview and any operator overrides),
// decide — for every application — whether a *human* has to do something right
// now, what that action is, how urgent it is, and who owns it.
//
// This module is deliberately PURE. It never touches Supabase, never reads the
// clock implicitly (callers pass `now`), and never mutates its inputs. That is
// what makes the Today queue testable and keeps the "why is this row here?"
// question answerable: the rule that fired is on the returned WorkItem.
//
// It is a port of the prototype's `queueItems()` / `QT` map, mapped onto the
// real column names in this codebase. Beyond choosing a kind it also carries the
// *context* each row's actions need (participant id, share id, interview id,
// AI score, attempt counts) so the Today UI can act on a row without another
// round-trip to discover what it is looking at.

import { getCallTruth, type CallTruth } from "@/lib/call-truth"

export const HOUR_MS = 60 * 60 * 1000

export type WorkItemKind =
  | "human" // AI needs a person to take over (manual follow-up / dead end)
  | "ghosted" // we messaged/called and got no reply — the candidate has gone quiet
  | "reply" // candidate replied, nobody has answered yet
  | "declined" // candidate told us they are not interested — a human should see it
  | "hold" // AI flagged a likely rejection — a human must decide, not the AI
  | "call" // screening finished, a human must review the call
  | "resched" // an interview time no longer works
  | "client" // waiting on the client to decide on a shortlist
  | "overdue" // the client has gone quiet for too long (grouped per job)
  | "offer" // an open offer needs confirming
  | "shortlist" // ready to send to the client

export type SlaState = "ok" | "warn" | "late"

export interface DispatchApplication {
  id: string
  job_id: string
  candidate_id: string
  status: string | null
  origin?: string | null
  source?: string | null
  match_score?: number | null
  created_by?: string | null
  applied_at?: string | null
  updated_at?: string | null
}

export interface DispatchJob {
  id: string
  title?: string | null
  client_name?: string | null
  status?: string | null
  owner_auth_user_id?: string | null
  city?: string | null
  location?: string | null
}

export interface DispatchCandidate {
  id: string
  name?: string | null
  current_role?: string | null
  current_company?: string | null
  location?: string | null
  total_experience?: string | null
  expected_salary?: string | null
  notice_period?: string | null
}

/** The subset of `phone_screening_participants` the engine reads. */
export interface DispatchParticipant {
  id?: string
  status?: string | null
  review_status?: string | null
  bolna_execution_id?: string | null
  bolna_status?: string | null
  call_attempts?: number | null
  next_retry_at?: string | null
  scheduled_call_at?: string | null
  call_duration_seconds?: number | null
  conversation_duration?: number | null
  call_voicemail?: boolean | null
  call_hangup_reason?: string | null
  call_disconnect_reason?: string | null
  carrier?: string | null
  callback_preference?: string | null
  whatsapp_response?: string | null
  whatsapp_reply_text?: string | null
  whatsapp_reply_at?: string | null
  whatsapp_sent_at?: string | null
  /** How many times we've chased them on WhatsApp — drives the "No reply" pill. */
  outreach_nudge_count?: number | null
  ai_score?: number | null
  ai_summary?: string | null
  ai_recommendation?: string | null
  verdict_json?: any
  ai_suggests_rejection?: boolean | null
  needs_manual_followup?: boolean | null
  updated_at?: string | null
}

export interface DispatchShortlist {
  id?: string
  status?: string | null
  created_at?: string | null
  decided_at?: string | null
}

export interface DispatchInterview {
  id?: string
  status?: string | null
  scheduled_at?: string | null
}

export interface DispatchWorkState {
  snoozed_until?: string | null
  snooze_reason?: string | null
  last_manual_call_at?: string | null
  last_manual_call_outcome?: string | null
  last_manual_call_note?: string | null
  assigned_auth_user_id?: string | null
  /**
   * When an operator marked this row done. The row is hidden while the mark is
   * newer than the row's `waitingSince`; a later activity moves `waitingSince`
   * forward, so the row comes back on its own. This is "archive until it
   * changes", not "delete".
   */
  done_at?: string | null
}

export interface WorkItemInput {
  application: DispatchApplication
  job: DispatchJob
  candidate: DispatchCandidate
  participant?: DispatchParticipant | null
  shortlist?: DispatchShortlist | null
  interview?: DispatchInterview | null
  state?: DispatchWorkState | null
}

export type WorkItemActionId =
  | "review" // open the screening result / questions
  | "reply" // open the WhatsApp conversation
  | "call" // place a manual call now
  | "decide" // review the verdict and approve/reject
  | "schedule" // book an interview
  | "resched" // pick a new interview time
  | "remind" // remind the client
  | "share" // send the shortlist to the client
  | "offer" // open the offer
  | "nudge" // nudge the candidate on WhatsApp
  | "log_call" // log a manual call
  | "snooze" // hide for a while
  | "done" // mark handled — hide until the item changes
  | "drop" // reject the application

export interface WorkItemAction {
  id: WorkItemActionId
  label: string
  variant: "primary" | "default" | "danger"
}

export interface WorkItemPill {
  label: string
  tone?: "default" | "hot" | "info" | "good"
}

export interface WorkItem {
  /** Stable key: application + kind, so a row that changes reason is a new row. */
  key: string
  kind: WorkItemKind
  kindLabel: string
  applicationId: string
  jobId: string
  candidateId: string
  /** The application status, so a deep link can land on the right pipeline stage. */
  stage: string
  jobTitle: string
  clientName: string | null
  candidateName: string
  candidateMeta: string
  ownerAuthUserId: string | null
  /** When this item started waiting for a human. */
  waitingSince: string
  ageHours: number
  slaHours: number
  slaState: SlaState
  /** Higher = more urgent. */
  priority: number
  title: string
  detail: string
  /** A short quote/summary from the screening, when there is one. */
  quote: string | null
  /** The primary action's label (the row's main button). */
  cta: string
  /** The primary action's id. */
  primaryAction: WorkItemActionId
  actions: WorkItemAction[]
  /** Context the actions need. */
  participantId: string | null
  shareId: string | null
  interviewId: string | null
  interviewStatus: string | null
  interviewScheduledAt: string | null
  aiScore: number | null
  aiRecommendation: string | null
  whatsappSentAt: string | null
  callAttempts: number | null
  /** Whether this row can be bulk-selected (submitted to bulk actions). */
  selectable: boolean
  /** Small chips shown on the row (WhatsApp nudges, calls, AI score…). */
  pills: WorkItemPill[]
  aiFlagged: boolean
  callState: CallTruth["state"] | null
  callLabel: string | null
  snoozed: boolean
  snoozedUntil: string | null
  /** Marked handled by an operator — hidden until the item changes again. */
  done: boolean
  doneAt: string | null
  /** Set only on the merged "client overdue" row: how many candidates it covers. */
  groupCount?: number
  groupApplicationIds?: string[]
}

interface KindConfig {
  label: string
  slaHours: number
  basePriority: number
  /** `cta` is the primary action's label; `actions[0]` must be the primary. */
  cta: string
  actions: WorkItemAction[]
  selectable: boolean
}

const KIND_CONFIG: Record<WorkItemKind, KindConfig> = {
  resched: {
    label: "Reschedule",
    slaHours: 6,
    basePriority: 88,
    cta: "Pick a new time",
    selectable: false,
    actions: [
      { id: "resched", label: "Pick a new time", variant: "primary" },
      { id: "log_call", label: "Log a call", variant: "default" },
      { id: "snooze", label: "Snooze", variant: "default" },
    ],
  },
  human: {
    label: "Needs a human",
    slaHours: 6,
    basePriority: 86,
    cta: "Take over",
    selectable: true,
    actions: [
      { id: "review", label: "Take over", variant: "primary" },
      { id: "call", label: "Call manually", variant: "default" },
      { id: "log_call", label: "Log a call", variant: "default" },
      { id: "snooze", label: "Snooze", variant: "default" },
    ],
  },
  ghosted: {
    label: "No reply",
    slaHours: 24,
    basePriority: 78,
    cta: "Nudge on WhatsApp",
    selectable: true,
    actions: [
      { id: "nudge", label: "Nudge on WhatsApp", variant: "primary" },
      { id: "call", label: "Call manually", variant: "default" },
      { id: "log_call", label: "Log a call", variant: "default" },
      { id: "snooze", label: "Snooze", variant: "default" },
    ],
  },
  reply: {
    label: "Replied",
    slaHours: 4,
    basePriority: 82,
    cta: "Open conversation",
    selectable: true,
    actions: [
      { id: "reply", label: "Open conversation", variant: "primary" },
      { id: "review", label: "Questions", variant: "default" },
      { id: "log_call", label: "Log a call", variant: "default" },
      { id: "snooze", label: "Snooze", variant: "default" },
    ],
  },
  declined: {
    label: "Declined",
    slaHours: 8,
    basePriority: 80,
    cta: "Open conversation",
    selectable: true,
    actions: [
      { id: "reply", label: "Open conversation", variant: "primary" },
      { id: "call", label: "Call manually", variant: "default" },
      { id: "log_call", label: "Log a call", variant: "default" },
      { id: "snooze", label: "Snooze", variant: "default" },
    ],
  },
  overdue: {
    label: "Client overdue",
    slaHours: 24,
    basePriority: 74,
    cta: "Remind the client",
    selectable: false,
    actions: [
      { id: "remind", label: "Remind the client", variant: "primary" },
      { id: "snooze", label: "Snooze", variant: "default" },
    ],
  },
  hold: {
    label: "AI flagged",
    slaHours: 8,
    basePriority: 68,
    cta: "Review and decide",
    selectable: true,
    actions: [
      { id: "decide", label: "Review and decide", variant: "primary" },
      { id: "review", label: "Questions", variant: "default" },
      { id: "log_call", label: "Log a call", variant: "default" },
      { id: "snooze", label: "Snooze", variant: "default" },
    ],
  },
  call: {
    label: "Calls to review",
    slaHours: 8,
    basePriority: 62,
    cta: "Review the call",
    selectable: false,
    actions: [
      { id: "review", label: "Review the call", variant: "primary" },
      { id: "log_call", label: "Log a call", variant: "default" },
      { id: "snooze", label: "Snooze", variant: "default" },
    ],
  },
  client: {
    label: "Client approved",
    slaHours: 48,
    basePriority: 54,
    cta: "Schedule interview",
    selectable: false,
    actions: [
      { id: "schedule", label: "Schedule interview", variant: "primary" },
      { id: "log_call", label: "Log a call", variant: "default" },
      { id: "snooze", label: "Snooze", variant: "default" },
    ],
  },
  offer: {
    label: "Offers",
    slaHours: 48,
    basePriority: 50,
    cta: "Open offer",
    selectable: false,
    actions: [
      { id: "offer", label: "Open offer", variant: "primary" },
      { id: "log_call", label: "Log a call", variant: "default" },
      { id: "snooze", label: "Snooze", variant: "default" },
    ],
  },
  shortlist: {
    label: "Ready to send",
    slaHours: 48,
    basePriority: 42,
    cta: "Send to the client",
    selectable: false,
    actions: [
      { id: "share", label: "Send to the client", variant: "primary" },
      { id: "snooze", label: "Snooze", variant: "default" },
    ],
  },
}

const OVERDUE_AFTER_HOURS = 48
const OFFER_CONFIRM_AFTER_HOURS = 48
/**
 * Participant statuses meaning "we reached out into the void". `whatsapp_sent`
 * covers delivered/read too (all set before the reply arrives); `info_requested`
 * is the details ask that never came back. A candidate who has ghosted us sits
 * in one of these with no `whatsapp_reply_text`.
 */
export const GHOSTED_STATUSES = ["whatsapp_sent", "whatsapp_delivered", "whatsapp_read", "info_requested"]
/** A send younger than this is normal waiting, not ghosting. */
export const GHOSTED_AFTER_HOURS = 12

function hoursBetween(from: string, now: Date): number {
  const t = new Date(from).getTime()
  if (!Number.isFinite(t)) return 0
  return Math.max(0, (now.getTime() - t) / HOUR_MS)
}

function slaStateFor(ageHours: number): SlaState {
  // Matches the design prototype: anything past a day is late, past six hours is
  // a warning. Per-kind `slaHours` is still returned for tooltips/future use.
  if (ageHours >= 24) return "late"
  if (ageHours >= 6) return "warn"
  return "ok"
}

function priorityFor(kind: WorkItemKind, ageHours: number): number {
  const base = KIND_CONFIG[kind].basePriority
  const ageBonus = Math.min(20, Math.floor(ageHours / 6))
  return base + ageBonus
}

function firstIso(candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    if (c && Number.isFinite(new Date(c).getTime())) return c
  }
  return new Date(0).toISOString()
}

function candidateMeta(c: DispatchCandidate): string {
  const bits = [c.current_role, c.current_company].filter(Boolean)
  if (bits.length) return bits.join(" · ")
  if (c.total_experience) return `${c.total_experience} experience`
  return c.location || ""
}

function quoteFrom(p?: DispatchParticipant | null): string | null {
  if (!p) return null
  const reply = candidateReplyText(p)
  if (reply) return reply.slice(0, 240)
  const v = p.verdict_json
  if (v && typeof v === "object") {
    const q = v.quote || v.summary || v.recommendation_reason
    if (typeof q === "string" && q.trim()) return q.trim().slice(0, 240)
  }
  if (typeof p.ai_summary === "string" && p.ai_summary.trim()) return p.ai_summary.trim().slice(0, 240)
  return null
}

function recommendationLabel(p?: DispatchParticipant | null): string | null {
  const raw = p?.ai_recommendation || p?.verdict_json?.recommendation || p?.verdict_json?.rec
  if (typeof raw !== "string" || !raw.trim()) return null
  const v = raw.trim().toLowerCase()
  if (v.includes("advance")) return "Advance"
  if (v.includes("reject")) return "Reject"
  if (v.includes("hold")) return "Hold"
  if (v.includes("interview")) return "Interview"
  return raw.trim().slice(0, 24)
}

function pillsFor(kind: WorkItemKind, p?: DispatchParticipant | null, extra?: { groupCount?: number }): WorkItemPill[] {
  const pills: WorkItemPill[] = []
  const score = Number(p?.ai_score)
  const attempts = Number(p?.call_attempts)
  switch (kind) {
    case "human": {
      if (attempts > 0) pills.push({ label: `Calls ${attempts}`, tone: attempts > 1 ? "hot" : "default" })
      if (p?.whatsapp_sent_at) pills.push({ label: "Nudged on WhatsApp", tone: "default" })
      break
    }
    case "ghosted": {
      const nudges = Number(p?.outreach_nudge_count)
      if (Number.isFinite(nudges) && nudges > 0) {
        pills.push({ label: nudges > 1 ? `Nudged ${nudges}×` : "Nudged", tone: nudges > 1 ? "hot" : "default" })
      } else if (p?.whatsapp_sent_at) {
        pills.push({ label: "Messaged", tone: "default" })
      }
      if (attempts > 0) pills.push({ label: `Calls ${attempts}`, tone: attempts > 1 ? "hot" : "default" })
      break
    }
    case "hold": {
      if (Number.isFinite(score) && score > 0) pills.push({ label: `AI ${score}/10`, tone: "info" })
      const rec = recommendationLabel(p)
      if (rec) pills.push({ label: rec, tone: rec === "Reject" ? "hot" : "default" })
      break
    }
    case "declined": {
      pills.push({ label: "Not interested", tone: "hot" })
      const nudges = Number(p?.outreach_nudge_count)
      if (Number.isFinite(nudges) && nudges > 0) pills.push({ label: nudges > 1 ? `Nudged ${nudges}×` : "Nudged", tone: "default" })
      if (attempts > 0) pills.push({ label: `Calls ${attempts}`, tone: "default" })
      break
    }
    case "call": {
      if (Number.isFinite(score) && score > 0) pills.push({ label: `AI ${score}/10`, tone: "info" })
      const rec = recommendationLabel(p)
      if (rec) pills.push({ label: rec, tone: rec === "Reject" ? "hot" : "good" })
      break
    }
    case "overdue":
      if (extra?.groupCount && extra.groupCount > 1) pills.push({ label: `${extra.groupCount} profiles`, tone: "default" })
      break
    default:
      break
  }
  return pills
}

/**
 * `whatsapp_reply_text` holds EITHER a free-text reply OR the JSON payload of a
 * WhatsApp flow form (the normal screening answers). Only the former is a
 * candidate "waiting for a human" — a flow submission is the machine working.
 */
function isFlowFormJson(raw: string): boolean {
  const t = raw.trim()
  if (!t.startsWith("{")) return false
  try {
    const v = JSON.parse(t)
    return !!v && typeof v === "object"
  } catch {
    return false
  }
}

/** WhatsApp intents that mean a candidate explicitly asked for a person. */
const HUMAN_INTENTS = ["call_me_now", "schedule", "call", "callback"]

/** The candidate's free-text reply, when they actually typed one. */
export function candidateReplyText(p?: DispatchParticipant | null): string | null {
  if (!p) return null
  const raw = typeof p.whatsapp_reply_text === "string" ? p.whatsapp_reply_text.trim() : ""
  if (raw && !isFlowFormJson(raw)) return raw
  const intent = typeof p.whatsapp_response === "string" ? p.whatsapp_response.trim() : ""
  if (intent && !HUMAN_INTENTS.includes(intent.toLowerCase()) && !["not_interested"].includes(intent.toLowerCase()) && !isFlowFormJson(intent)) {
    return intent
  }
  return null
}

export function wantsHuman(p?: DispatchParticipant | null): boolean {
  const intent = String(p?.whatsapp_response || "").toLowerCase()
  return HUMAN_INTENTS.includes(intent)
}

/** The candidate has told us they are not interested. */
export function hasDeclined(p?: DispatchParticipant | null): boolean {
  const status = String(p?.status || "").toLowerCase()
  const intent = String(p?.whatsapp_response || "").toLowerCase()
  return status === "not_interested" || intent === "not_interested"
}

/**
 * Did the candidate send us something that is still unanswered?
 *
 * `whatsapp_reply_text` is never cleared, so the raw presence of a reply says
 * nothing about whether a human already dealt with it — a candidate who replied
 * and was answered a week ago still carries their text. Comparing the last
 * inbound (`whatsapp_reply_at`) against the last outbound (`whatsapp_sent_at`,
 * stamped by every send path including manual ones) is what makes "Replied"
 * mean "waiting on you" instead of "once replied, ever".
 */
export function hasUnansweredReply(p?: DispatchParticipant | null): boolean {
  if (!p || !candidateReplyText(p)) return false
  const inbound = p.whatsapp_reply_at ? Date.parse(p.whatsapp_reply_at) : NaN
  const outbound = p.whatsapp_sent_at ? Date.parse(p.whatsapp_sent_at) : NaN
  if (!Number.isFinite(inbound)) return true // text with no timestamp: assume waiting
  if (!Number.isFinite(outbound)) return true // we never sent: nothing answered it
  return inbound > outbound
}

/**
 * Decide the single action this application needs, or `null` when nothing is
 * waiting on a human. First matching rule wins.
 */
function deriveKind(input: WorkItemInput, now: Date): { kind: WorkItemKind; truth: CallTruth | null } | null {
  const { application: app, participant: p } = input
  const status = String(app.status || "")
  const truth = getCallTruth(p ?? null)
  const live = truth.bucket === "calling" || truth.bucket === "engaged"

  // Conversation signals outrank the pipeline stage.
  //
  // Whether the AI screen is still running or the candidate is already sitting
  // with a client, a person who told us they are out, or who typed something
  // nobody has answered, is waiting on a human right now. Both signals clear
  // themselves — `declined` is a terminal status, and a reply stops counting the
  // moment we send one back — so this cannot manufacture rows that never go away.
  // A live call still wins: whoever is on the line is already being handled.
  if (!live) {
    if (hasDeclined(p)) return { kind: "declined", truth }
    if (hasUnansweredReply(p)) return { kind: "reply", truth }
  }

  if (status === "ai_screen") {
    const declined = hasDeclined(p)

    // An explicit button intent ("Call me now") only exists while the screening
    // is live, so it stays scoped here.
    if (!live && !declined && wantsHuman(p)) return { kind: "human", truth }

    const flagged =
      !declined &&
      (truth.bucket === "review" ||
        truth.bucket === "failed" ||
        p?.needs_manual_followup === true ||
        String(p?.status || "") === "needs_review" ||
        String(p?.status || "") === "needs_manual_followup" ||
        String(p?.status || "") === "unreachable")
    // A human takeover is only a work item when the AI has actually stopped.
    if (flagged && truth.bucket !== "calling") return { kind: "human", truth }

    // We messaged them and heard nothing back — the candidate has gone quiet.
    // Fresh sends are normal waiting (the machine is still on it); only a send
    // that has gone cold becomes work a human must chase. An answered reply is
    // not "no reply", so a thread we have spoken to is excluded.
    if (!declined && GHOSTED_STATUSES.includes(String(p?.status || "")) && !candidateReplyText(p)) {
      const nudges = Number(p?.outreach_nudge_count)
      const lastContact = firstIso([p?.whatsapp_sent_at, p?.updated_at, app.updated_at, app.applied_at])
      const cold = hoursBetween(lastContact, now) >= GHOSTED_AFTER_HOURS
      // Repeated nudges are a stronger "they're ignoring us" signal than a
      // single recent send, so they qualify even inside the freshness window.
      if (cold || (Number.isFinite(nudges) && nudges >= 2)) return { kind: "ghosted", truth }
    }

    // A completed screening that has not advanced yet still needs a human.
    if (truth.state === "completed" || truth.bucket === "done") return { kind: "call", truth }

    return null
  }

  if (status === "hr_review") {
    const truth = getCallTruth(p ?? null)
    const completed = truth.state === "completed" || truth.bucket === "done"
    // A real screening exists to read → "Calls to review". Otherwise the row is
    // just parked on a human decision, so it belongs in "AI flagged / decide"
    // rather than pretending there is a call to listen to.
    if (completed && p?.ai_suggests_rejection !== true) return { kind: "call", truth }
    return { kind: "hold", truth }
  }

  if (status === "shortlist") {
    // Not yet shared with the client — the recruiter is holding the ball.
    if (!input.shortlist) return { kind: "shortlist", truth: null }
    return null
  }

  if (status === "client_review") {
    if (!input.shortlist || input.shortlist.status === "pending") {
      const since = firstIso([input.shortlist?.created_at, app.updated_at, app.applied_at])
      const age = hoursBetween(since, now)
      return { kind: age >= OVERDUE_AFTER_HOURS ? "overdue" : "client", truth: null }
    }
    return null
  }

  if (status === "interview") {
    const iv = input.interview
    // Client approved but no interview booked yet — schedule it.
    if (!iv) return { kind: "client", truth: null }
    const ivStatus = String(iv.status || "")
    const scheduledPast =
      !!iv.scheduled_at && new Date(iv.scheduled_at).getTime() < now.getTime() && ivStatus !== "completed"
    if (ivStatus === "rescheduled" || ivStatus === "cancelled" || scheduledPast) return { kind: "resched", truth: null }
    return null
  }

  if (status === "offer") {
    const since = firstIso([app.updated_at, app.applied_at])
    if (hoursBetween(since, now) >= OFFER_CONFIRM_AFTER_HOURS) return { kind: "offer", truth: null }
    return null
  }

  return null
}

function waitingSinceFor(input: WorkItemInput, kind: WorkItemKind): string {
  const { application: app, participant: p, shortlist, interview } = input
  switch (kind) {
    case "ghosted":
      // Age the row from the moment we messaged them — that is what "no reply"
      // means, and it puts a real waiting time behind the urgency.
      return firstIso([p?.whatsapp_sent_at, p?.updated_at, app.updated_at, app.applied_at])
    case "reply":
    case "human":
      return firstIso([p?.updated_at, app.updated_at, app.applied_at])
    case "declined":
      return firstIso([p?.updated_at, app.updated_at, app.applied_at])
    case "call":
    case "hold":
      return firstIso([p?.updated_at, app.updated_at, app.applied_at])
    case "shortlist":
    case "client":
    case "overdue":
      return firstIso([shortlist?.created_at, app.updated_at, app.applied_at])
    case "resched":
      return firstIso([interview?.scheduled_at, app.updated_at, app.applied_at])
    case "offer":
      return firstIso([app.updated_at, app.applied_at])
    default:
      return firstIso([app.updated_at, app.applied_at])
  }
}

function titlesFor(
  input: WorkItemInput,
  kind: WorkItemKind,
  truth: CallTruth | null
): { title: string; detail: string } {
  const { job, participant: p } = input
  const jobTitle = job.title || "this role"

  switch (kind) {
    case "ghosted":
      return {
        title: `No reply from ${jobTitle}`,
        detail: truth?.detail || "We messaged them and heard nothing back — decide whether to chase or drop.",
      }
    case "reply":
      return { title: `Replied about ${jobTitle}`, detail: "The candidate responded on WhatsApp and is waiting for you." }
    case "declined":
      return {
        title: `Declined ${jobTitle}`,
        detail: "The candidate said they are not interested — review it, or close the application.",
      }
    case "human":
      return {
        title: `Needs you on ${jobTitle}`,
        detail: truth?.detail || "The AI screening was flagged for a human — take it from here.",
      }
    case "call":
      return { title: `Screen to review · ${jobTitle}`, detail: "The screening call finished — review it and decide the next step." }
    case "hold":
      return {
        title: `Decide on ${jobTitle}`,
        detail: p?.ai_summary?.trim()
          ? p.ai_summary.trim().slice(0, 240)
          : "The AI suggests this may not be a fit — that is advice, not a decision. You decide.",
      }
    case "resched":
      return { title: `Reschedule · ${jobTitle}`, detail: "The booked interview time no longer works." }
    case "shortlist":
      return { title: `Ready to send · ${jobTitle}`, detail: "This candidate is ready to go to the client." }
    case "client":
      return { title: `Client approved · ${jobTitle}`, detail: "The client approved — set up the interview." }
    case "overdue":
      return { title: `Client has gone quiet · ${jobTitle}`, detail: "The shortlist has been with the client for a while with no decision." }
    case "offer":
      return { title: `Offer open · ${jobTitle}`, detail: "The offer is out — confirm whether the candidate is joining." }
    default:
      return { title: jobTitle, detail: "" }
  }
}

function deriveOne(input: WorkItemInput, now: Date): WorkItem | null {
  const decision = deriveKind(input, now)
  if (!decision) return null

  const { kind, truth } = decision
  const cfg = KIND_CONFIG[kind]
  const waitingSince = waitingSinceFor(input, kind)
  const ageHours = hoursBetween(waitingSince, now)
  const { title, detail } = titlesFor(input, kind, truth)
  const snoozedUntil = input.state?.snoozed_until || null
  const snoozed = !!snoozedUntil && new Date(snoozedUntil).getTime() > now.getTime()
  const doneAt = input.state?.done_at || null
  // "Done" hides the row until the item changes again: any later activity moves
  // `waitingSince` past the mark, so the row returns on its own. Without that,
  // a row completed today would stay buried even after the candidate replies.
  const done = !!doneAt && new Date(doneAt).getTime() >= new Date(waitingSince).getTime()
  const p = input.participant

  return {
    key: `${input.application.id}:${kind}`,
    kind,
    kindLabel: cfg.label,
    applicationId: input.application.id,
    jobId: input.job.id,
    candidateId: input.candidate.id,
    stage: String(input.application.status || ""),
    jobTitle: input.job.title || "Untitled role",
    clientName: input.job.client_name || null,
    candidateName: input.candidate.name || "Unnamed candidate",
    candidateMeta: candidateMeta(input.candidate),
    ownerAuthUserId: input.job.owner_auth_user_id || input.state?.assigned_auth_user_id || null,
    waitingSince,
    ageHours: Math.round(ageHours),
    slaHours: cfg.slaHours,
    slaState: slaStateFor(ageHours),
    priority: priorityFor(kind, ageHours),
    title,
    detail,
    quote: quoteFrom(p),
    cta: cfg.cta,
    primaryAction: cfg.actions[0].id,
    // Every kind gets the same "Done" escape hatch — the operator has handled
    // it, so take it off the board until something changes.
    actions: [...cfg.actions, { id: "done", label: "Done", variant: "default" }],
    participantId: p?.id ? String(p.id) : null,
    shareId: input.shortlist?.id ? String(input.shortlist.id) : null,
    interviewId: input.interview?.id ? String(input.interview.id) : null,
    interviewStatus: input.interview?.status ? String(input.interview.status) : null,
    interviewScheduledAt: input.interview?.scheduled_at || null,
    aiScore: Number.isFinite(Number(p?.ai_score)) && Number(p?.ai_score) > 0 ? Number(p?.ai_score) : null,
    aiRecommendation: recommendationLabel(p),
    whatsappSentAt: p?.whatsapp_sent_at || null,
    callAttempts: Number.isFinite(Number(p?.call_attempts)) ? Number(p?.call_attempts) : null,
    selectable: cfg.selectable,
    pills: pillsFor(kind, p),
    aiFlagged: p?.ai_suggests_rejection === true,
    callState: truth?.state ?? null,
    callLabel: truth?.label ?? null,
    snoozed,
    snoozedUntil,
    done,
    doneAt,
  }
}

export interface DeriveOptions {
  now?: Date
  /** Include items the operator has snoozed. Default false. */
  includeSnoozed?: boolean
  /** Include items the operator has marked done. Default false. */
  includeDone?: boolean
}

export function deriveWorkItems(inputs: WorkItemInput[], opts: DeriveOptions = {}): WorkItem[] {
  const now = opts.now ?? new Date()
  const includeSnoozed = opts.includeSnoozed ?? false
  const includeDone = opts.includeDone ?? false
  const items: WorkItem[] = []
  for (const input of inputs) {
    const item = deriveOne(input, now)
    if (!item) continue
    if (!includeSnoozed && item.snoozed) continue
    if (!includeDone && item.done) continue
    items.push(item)
  }
  return sortWorkItems(items)
}

export function sortWorkItems(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    if (b.ageHours !== a.ageHours) return b.ageHours - a.ageHours
    return a.candidateName.localeCompare(b.candidateName)
  })
}

/**
 * Merge the per-application "client overdue" rows into one row per job, the way
 * the prototype does — a job with nine candidates stuck with a client is one
 * thing to chase, not nine. Every other kind is left untouched.
 */
export function groupOverdue(items: WorkItem[]): WorkItem[] {
  const out: WorkItem[] = []
  const groups = new Map<string, WorkItem[]>()
  for (const item of items) {
    if (item.kind === "overdue") {
      const arr = groups.get(item.jobId) || []
      arr.push(item)
      groups.set(item.jobId, arr)
    } else {
      out.push(item)
    }
  }
  for (const [jobId, arr] of groups) {
    const sorted = [...arr].sort((a, b) => b.ageHours - a.ageHours)
    const lead = sorted[0]
    out.push({
      ...lead,
      key: `${jobId}:overdue-group`,
      groupCount: sorted.length,
      groupApplicationIds: sorted.map((x) => x.applicationId),
      ageHours: lead.ageHours,
      waitingSince: lead.waitingSince,
      pills: pillsFor("overdue", null, { groupCount: sorted.length }),
      title: sorted.length > 1 ? `${sorted.length} profiles with the client` : lead.title,
      detail:
        sorted.length > 1
          ? `No decision from ${lead.clientName || "the client"} since the shortlist went over.`
          : lead.detail,
    })
  }
  return sortWorkItems(out)
}

export function countsByKind(items: WorkItem[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of items) out[item.kind] = (out[item.kind] || 0) + 1
  return out
}

/** Human-readable age, e.g. "3h", "2d", "45m". */
export function formatAge(hours: number): string {
  if (hours < 1) return "<1h"
  if (hours < 48) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
}

export const WORK_ITEM_KINDS: WorkItemKind[] = [
  "human",
  "ghosted",
  "reply",
  "declined",
  "hold",
  "call",
  "resched",
  "client",
  "overdue",
  "offer",
  "shortlist",
]

export function kindLabel(kind: WorkItemKind): string {
  return KIND_CONFIG[kind]?.label ?? kind
}

// ── Right-rail + header projections ──────────────────────────────────────────
// These are computed by the route from the same snapshot, so the rail never
// disagrees with the queue it sits beside.

export interface RailInterview {
  applicationId: string
  participantId: string | null
  candidateId: string
  candidateName: string
  jobId: string
  jobTitle: string
  clientName: string | null
  status: string | null
  scheduledAt: string | null
}

export interface RailReady {
  jobId: string
  jobTitle: string
  clientName: string | null
  count: number
}

export interface RailLiveCall {
  applicationId: string
  participantId: string | null
  candidateId: string
  candidateName: string
  jobId: string
  jobTitle: string
  callLabel: string
  since: string | null
}

export interface DispatchStats {
  open_jobs: number
  candidates: number
  shortlisted_or_later: number
  hired: number
  waiting: number
  with_client: number
}

export const INTERVIEW_LIVE_STATUSES = ["pending", "scheduled", "invite_sent", "confirmed", "rescheduled", "move_next", "waitlist", "on_hold"]
