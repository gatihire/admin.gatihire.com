import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"
import {
  toConversationThread,
  countsByCategory,
  CONVERSATION_CATEGORIES,
  conversationStatusLabel,
  type ConversationCategory,
  type ConversationThread,
} from "@/lib/dispatch/conversations"
import { candidateReplyText, type DispatchParticipant } from "@/lib/dispatch/engine"

export const runtime = "nodejs"

// PostgREST caps a single response at the project's `max-rows` (1000 by default),
// so page every unbounded read.
const PAGE_SIZE = 1000
const MAX_PARTICIPANTS = 20000

// Page size for the inbox itself. Small on purpose: the list loads a page at a
// time ("Load more"), so the payload is bounded no matter how many threads exist.
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const VALID_CATEGORIES: ConversationCategory[] = ["needs_human", "needs_reply", "declined", "no_reply", "other"]

/**
 * Is this error "the view/function isn't there yet"?
 *
 * The scalable path (supabase/migrations/20261016_whatsapp_inbox.sql) needs a
 * view + functions. Until that migration is applied we must not 500 — fall back
 * to classifying in Node, which is what the inbox did before the view existed.
 */
function isMissingDbObject(error: any): boolean {
  const code = String(error?.code || "")
  const msg = String(error?.message || "").toLowerCase()
  return (
    code === "42P01" || // undefined_table
    code === "42883" || // undefined_function
    code === "PGRST205" || // table not in schema cache
    code === "PGRST202" || // function not in schema cache
    msg.includes("could not find the table") ||
    msg.includes("could not find the function") ||
    msg.includes("does not exist")
  )
}

async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
  max = MAX_PARTICIPANTS
): Promise<{ data: T[]; error: any }> {
  const out: T[] = []
  for (let from = 0; from < max; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) return { data: out, error }
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE_SIZE) break
  }
  return { data: out, error: null }
}

/** A thread only belongs in the inbox once something has actually happened on it. */
function hasWhatsappActivity(p: DispatchParticipant): boolean {
  return Boolean(
    p.whatsapp_sent_at ||
      p.whatsapp_reply_at ||
      candidateReplyText(p) ||
      (typeof p.whatsapp_response === "string" && p.whatsapp_response.trim())
  )
}

function previewOf(text: string | null | undefined): string | null {
  if (!text) return null
  const t = String(text)
  return t.length > 140 ? `${t.slice(0, 140)}…` : t
}

/**
 * Fallback classifier — the pre-view code path, kept so the inbox keeps working
 * (just less cheaply) before the 20261016 migration is applied. Reads every
 * participant and classifies in Node.
 */
async function loadAllThreadsJs(now: Date): Promise<{ threads: ConversationThread[]; error: any }> {
  const { data: participants, error } = await fetchAll<any>((from, to) =>
    supabaseAdmin
      .from("phone_screening_participants")
      .select(`
        id, job_id, candidate_id, status, updated_at,
        whatsapp_response, whatsapp_reply_text, whatsapp_reply_at, whatsapp_sent_at,
        outreach_nudge_count, needs_manual_followup,
        candidates:candidate_id (id, name),
        jobs:job_id (id, title, client_name)
      `)
      .order("id", { ascending: true })
      .range(from, to)
  )
  if (error) return { threads: [], error }

  const threads: ConversationThread[] = []
  for (const p of participants as any[]) {
    if (!hasWhatsappActivity(p as DispatchParticipant)) continue
    threads.push(toConversationThread(p as DispatchParticipant & { id: string }, p.jobs, p.candidates?.name, now))
  }
  return { threads, error: null }
}

function sortThreads(threads: ConversationThread[]): ConversationThread[] {
  return threads.sort((a, b) => {
    const at = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0
    const bt = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0
    if (bt !== at) return bt - at
    return a.candidateName.localeCompare(b.candidateName)
  })
}

function countsFromThreads(threads: ConversationThread[]) {
  const counts = countsByCategory(threads)
  return {
    total: threads.length,
    unread: threads.filter((t) => t.unread).length,
    needs_human: counts.needs_human || 0,
    needs_reply: counts.needs_reply || 0,
    declined: counts.declined || 0,
    no_reply: counts.no_reply || 0,
    other: counts.other || 0,
  }
}

/**
 * The badge + chips read. One aggregate in Postgres once the view exists; falls
 * back to the Node classifier otherwise.
 */
async function readCounts(now: Date): Promise<{ counts: Record<string, number>; source: "view" | "fallback" } | { error: string }> {
  const res = await supabaseAdmin.rpc("whatsapp_inbox_counts")
  if (!res.error) return { counts: (res.data as any) || {}, source: "view" }
  if (!isMissingDbObject(res.error)) return { error: res.error.message }

  const { threads, error } = await loadAllThreadsJs(now)
  if (error) return { error: error.message }
  return { counts: countsFromThreads(threads), source: "fallback" }
}

/** PostgREST `.or()` filter grammar chokes on these — strip, don't escape. */
function sanitizeSearch(q: string): string {
  return q.replace(/[,()%*\\]/g, " ").trim()
}

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const now = new Date()
  const countsOnly = searchParams.get("countsOnly") === "1"
  const rawCategory = searchParams.get("category") || "needs_human"
  const category: "all" | ConversationCategory =
    rawCategory === "all" || VALID_CATEGORIES.includes(rawCategory as ConversationCategory)
      ? (rawCategory as "all" | ConversationCategory)
      : "needs_human"
  const q = sanitizeSearch(searchParams.get("q") || "")
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const offset = Math.max(Number(searchParams.get("offset")) || 0, 0)

  // Badge: counts only.
  if (countsOnly) {
    const res = await readCounts(now)
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: 500 })
    return NextResponse.json({ counts: res.counts, total: Number(res.counts.total) || 0, source: res.source })
  }

  // ── Scalable path: filter/search/paginate in Postgres ───────────────────────
  let listQuery = supabaseAdmin
    .from("whatsapp_threads")
    .select(
      "participant_id, candidate_id, candidate_name, job_id, job_title, client_name, category, unread, reply_text, participant_status, nudge_count, last_activity_at, whatsapp_reply_at, whatsapp_sent_at",
      { count: "exact" }
    )
    .order("last_activity_at", { ascending: false })
    .order("participant_id", { ascending: true })
    .range(offset, offset + limit - 1)

  if (category !== "all") listQuery = listQuery.eq("category", category)
  if (q) listQuery = listQuery.or(`candidate_name.ilike.%${q}%,job_title.ilike.%${q}%,client_name.ilike.%${q}%`)

  const { data, error, count } = await listQuery

  if (!error) {
    const items: ConversationThread[] = (data ?? []).map((r: any) => ({
      participantId: String(r.participant_id),
      candidateId: r.candidate_id ? String(r.candidate_id) : null,
      candidateName: r.candidate_name || "Unnamed candidate",
      jobId: r.job_id ? String(r.job_id) : null,
      jobTitle: r.job_title || null,
      clientName: r.client_name || null,
      category: (r.category as ConversationCategory) || "other",
      unread: Boolean(r.unread),
      preview: previewOf(r.reply_text),
      statusLabel: conversationStatusLabel({ status: r.participant_status } as DispatchParticipant),
      participantStatus: r.participant_status || null,
      nudgeCount: Number(r.nudge_count) || 0,
      lastActivityAt: r.last_activity_at || null,
      lastInboundAt: r.whatsapp_reply_at || null,
      lastOutboundAt: r.whatsapp_sent_at || null,
    }))

    // Counts ride along only on the first page; "Load more" reuses what the
    // client already has, so an append is a single list query.
    let counts: Record<string, number> | null = null
    if (offset === 0) {
      const res = await readCounts(now)
      counts = "error" in res ? null : res.counts
    }

    return NextResponse.json({
      generatedAt: now.toISOString(),
      source: "view",
      counts,
      filteredTotal: count ?? items.length,
      offset,
      limit,
      categories: CONVERSATION_CATEGORIES,
      items,
    })
  }

  if (!isMissingDbObject(error)) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // ── Fallback: classify in Node (works before the migration is applied) ──────
  const { threads, error: jsError } = await loadAllThreadsJs(now)
  if (jsError) return NextResponse.json({ error: jsError.message }, { status: 500 })

  const needle = q.toLowerCase()
  const filtered = sortThreads(threads).filter((t) => {
    if (category !== "all" && t.category !== category) return false
    if (!needle) return true
    return (
      t.candidateName.toLowerCase().includes(needle) ||
      (t.jobTitle || "").toLowerCase().includes(needle) ||
      (t.clientName || "").toLowerCase().includes(needle) ||
      (t.preview || "").toLowerCase().includes(needle)
    )
  })

  return NextResponse.json({
    generatedAt: now.toISOString(),
    source: "fallback",
    counts: countsFromThreads(threads),
    filteredTotal: filtered.length,
    offset,
    limit,
    categories: CONVERSATION_CATEGORIES,
    items: filtered.slice(offset, offset + limit),
  })
}
