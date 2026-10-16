// WhatsApp / dispatch "conversations" view model.
//
// The Today queue answers "what needs a human right now" — one row per
// *application*, and only for applications that are still active. The inbox
// answers a different question: "what is happening on WhatsApp?" — one row per
// *thread* (a phone_screening_participant), because a candidate can be talking to
// us on a thread that has no live application at all, and a reply that lands at
// the client stage still deserves an answer.
//
// Deliberately PURE and built on the same helpers the engine uses
// (`candidateReplyText`, `hasUnansweredReply`, `wantsHuman`, `hasDeclined`), so
// the inbox can never disagree with Today about whether a reply is waiting. No
// Supabase, no clock reads — the caller passes `now`, exactly like the engine.

import {
  candidateReplyText,
  hasDeclined,
  hasUnansweredReply,
  wantsHuman,
  HOUR_MS,
  GHOSTED_STATUSES,
  GHOSTED_AFTER_HOURS,
  type DispatchParticipant,
} from "./engine"

export type ConversationCategory = "needs_human" | "needs_reply" | "declined" | "no_reply" | "other"

/** Display order for the filter chips — most urgent first. */
export const CONVERSATION_CATEGORIES: ConversationCategory[] = [
  "needs_human",
  "needs_reply",
  "declined",
  "no_reply",
  "other",
]

export const CATEGORY_LABELS: Record<ConversationCategory, string> = {
  needs_human: "Needs a human",
  needs_reply: "Needs reply",
  declined: "Declined",
  no_reply: "No reply",
  other: "Everything else",
}

/** Participant statuses that mean "the AI held this for a person". */
const MANUAL_FOLLOWUP_STATUSES = ["needs_review", "needs_manual_followup"]

function timeOf(v?: string | null): number {
  const t = v ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : 0
}

/** The most recent moment anything happened on the thread. */
export function conversationLastActivityAt(p: DispatchParticipant): number {
  return Math.max(
    timeOf(p.whatsapp_reply_at),
    timeOf(p.whatsapp_sent_at),
    timeOf(p.updated_at)
  )
}

/**
 * Does this thread need a *person* specifically?
 *
 * Either the candidate explicitly asked for one (a button intent) or the
 * screening held the row for a human. This is deliberately broader than the
 * engine's `human` kind, which is further gated on the application being active.
 */
export function needsHumanAttention(p: DispatchParticipant): boolean {
  if (wantsHuman(p)) return true
  if (p?.needs_manual_followup === true) return true
  return MANUAL_FOLLOWUP_STATUSES.includes(String(p?.status || "").toLowerCase())
}

/** We reached out, the message landed, and they have not written back (yet). */
export function isGhostedThread(p: DispatchParticipant, now: Date): boolean {
  if (candidateReplyText(p)) return false
  if (!p?.whatsapp_sent_at) return false
  if (!GHOSTED_STATUSES.includes(String(p?.status || "").toLowerCase())) return false
  const last = timeOf(p.whatsapp_sent_at) || timeOf(p.updated_at)
  if (!last) return false
  const nudges = Number(p?.outreach_nudge_count)
  if (Number.isFinite(nudges) && nudges >= 2) return true
  return now.getTime() - last >= GHOSTED_AFTER_HOURS * HOUR_MS
}

/** One category per thread — the first matching rule wins. */
export function classifyConversation(p: DispatchParticipant, now: Date): ConversationCategory {
  if (needsHumanAttention(p)) return "needs_human"
  if (hasUnansweredReply(p)) return "needs_reply"
  if (hasDeclined(p)) return "declined"
  if (isGhostedThread(p, now)) return "no_reply"
  return "other"
}

/** Unread == still waiting on us. There is no separate read flag to maintain. */
export function isUnread(p: DispatchParticipant): boolean {
  return hasUnansweredReply(p) || wantsHuman(p)
}

/** A short, human preview of the last thing the candidate said, if anything. */
export function conversationPreview(p: DispatchParticipant): string | null {
  const text = candidateReplyText(p)
  if (text) return text.length > 140 ? `${text.slice(0, 140)}…` : text
  return null
}

/**
 * What to show when the candidate has not typed anything themselves — a button
 * tap or a screen hold still needs a one-line description, otherwise the row
 * reads "No reply yet" even when the AI just escalated it to a person.
 */
const STATUS_LABELS: Record<string, string> = {
  whatsapp_sent: "Message sent — no reply yet",
  whatsapp_delivered: "Delivered — no reply yet",
  whatsapp_read: "Read — no reply yet",
  info_requested: "Info requested — no reply yet",
  needs_manual_followup: "Held for a human",
  needs_review: "Held for review",
  unreachable: "Unreachable by phone",
  interested: "Said they are interested",
  not_interested: "Not interested",
  completed: "Screening completed",
  in_progress: "Screening in progress",
  info_received: "Details received",
  call_scheduled: "Call scheduled",
  call_me_now: "Asked for a call",
  schedule: "Chose a call slot",
  calling: "Call in progress",
  filtered_out: "Filtered out by the screen",
  failed: "AI screen failed",
}

export function conversationStatusLabel(p: DispatchParticipant): string {
  return STATUS_LABELS[String(p?.status || "").toLowerCase()] || "No message text"
}

export interface ConversationThread {
  participantId: string
  candidateId: string | null
  candidateName: string
  jobId: string | null
  jobTitle: string | null
  clientName: string | null
  category: ConversationCategory
  unread: boolean
  preview: string | null
  statusLabel: string
  participantStatus: string | null
  nudgeCount: number
  lastActivityAt: string | null
  lastInboundAt: string | null
  lastOutboundAt: string | null
}

export function toConversationThread(
  p: DispatchParticipant & { id: string },
  job: { title?: string | null; client_name?: string | null } | null | undefined,
  candidateName: string | null | undefined,
  now: Date
): ConversationThread {
  const last = conversationLastActivityAt(p)
  return {
    participantId: String(p.id),
    candidateId: (p as any).candidate_id ? String((p as any).candidate_id) : null,
    candidateName: candidateName || "Unnamed candidate",
    jobId: (p as any).job_id ? String((p as any).job_id) : null,
    jobTitle: job?.title || null,
    clientName: job?.client_name || null,
    category: classifyConversation(p, now),
    unread: isUnread(p),
    preview: conversationPreview(p),
    statusLabel: conversationStatusLabel(p),
    participantStatus: p.status || null,
    nudgeCount: Number.isFinite(Number(p.outreach_nudge_count)) ? Number(p.outreach_nudge_count) : 0,
    lastActivityAt: last ? new Date(last).toISOString() : null,
    lastInboundAt: p.whatsapp_reply_at || null,
    lastOutboundAt: p.whatsapp_sent_at || null,
  }
}

export function countsByCategory(threads: ConversationThread[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of threads) out[t.category] = (out[t.category] || 0) + 1
  return out
}
