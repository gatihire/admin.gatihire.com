import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"
import {
  toConversationThread,
  countsByCategory,
  CONVERSATION_CATEGORIES,
  type ConversationThread,
} from "@/lib/dispatch/conversations"
import { candidateReplyText, type DispatchParticipant } from "@/lib/dispatch/engine"

export const runtime = "nodejs"

// PostgREST caps a single response at the project's `max-rows` (1000 by default),
// so a bare `.limit(N)` silently truncates — page every read.
const PAGE_SIZE = 1000
const MAX_PARTICIPANTS = 20000

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

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const now = new Date()

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

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const threads: ConversationThread[] = []
  for (const p of participants as any[]) {
    if (!hasWhatsappActivity(p as DispatchParticipant)) continue
    threads.push(
      toConversationThread(p as DispatchParticipant & { id: string }, p.jobs, p.candidates?.name, now)
    )
  }

  // Newest activity first — the thread that just pinged you is at the top.
  threads.sort((a, b) => {
    const at = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0
    const bt = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0
    if (bt !== at) return bt - at
    return a.candidateName.localeCompare(b.candidateName)
  })

  const counts = countsByCategory(threads)
  const unread = threads.filter((t) => t.unread).length

  // Sidebar badge: the counts are all it needs, so skip serialising every row.
  if (new URL(request.url).searchParams.get("countsOnly") === "1") {
    return NextResponse.json({ counts: { ...counts, unread }, total: threads.length })
  }

  const { data: profile } = await supabaseAdmin
    .from("internal_users")
    .select("name, email")
    .eq("auth_user_id", ctx.authUser.id)
    .maybeSingle()

  return NextResponse.json({
    generatedAt: now.toISOString(),
    viewer: {
      id: ctx.authUser.id,
      name: profile?.name || null,
      email: profile?.email || ctx.authUser.email || null,
    },
    categories: CONVERSATION_CATEGORIES,
    counts,
    unread,
    total: threads.length,
    items: threads,
  })
}
