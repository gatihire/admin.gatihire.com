import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import crypto from "crypto"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { sendClientShortlistEmail } from "@/lib/mailer"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

const DEFAULT_TTL_DAYS = 30
const MAX_TTL_DAYS = 90

type ShareCandidateRow = {
  id: string
  application_id: string
  candidate_id: string
  name: string | null
  current_role: string | null
  current_company: string | null
  location: string | null
  match_score: number | null
  screening_score: number | null
  screening_verdict: string | null
}

async function loadShortlistForJob(jobId: string): Promise<ShareCandidateRow[]> {
  const { data: apps, error } = (await supabaseAdmin
    .from("applications")
    .select(`
      id,
      candidate_id,
      match_score,
      candidates:candidate_id (name, current_role, current_company, location)
    `)
    .eq("job_id", jobId)
    .eq("status", "shortlist")) as any

  if (error) throw new Error(error.message)

  const rows = (apps || []).filter((a: any) => a.candidate_id)

  const candidateIds = rows.map((a: any) => String(a.candidate_id))
  const scores: Record<string, { score: number; rec: string | null }> = {}
  if (candidateIds.length > 0) {
    const { data: participants } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("candidate_id, ai_score, ai_recommendation")
      .in("candidate_id", candidateIds)

    for (const p of participants || []) {
      const cid = String(p?.candidate_id || "")
      if (!cid) continue
      const s = Number(p?.ai_score ?? 0)
      const cur = scores[cid]
      if (!cur || s > cur.score) {
        scores[cid] = { score: s, rec: p?.ai_recommendation ?? null }
      }
    }
  }

  return rows.map((a: any) => {
    const cand = Array.isArray(a.candidates) ? a.candidates?.[0] : a.candidates
    return {
      id: String(a.id),
      application_id: String(a.id),
      candidate_id: String(a.candidate_id),
      name: cand?.name ?? null,
      current_role: cand?.current_role ?? null,
      current_company: cand?.current_company ?? null,
      location: cand?.location ?? null,
      match_score: a.match_score ?? null,
      screening_score: scores[String(a.candidate_id)]?.score ?? null,
      screening_verdict: scores[String(a.candidate_id)]?.rec ?? null,
    }
  })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { id } = await params
    const body: any = await request.json().catch(() => ({}))
    const title = typeof body?.title === "string" ? body.title.trim() : undefined
    const ttlDays = Math.max(1, Math.min(MAX_TTL_DAYS, Number(body?.expiresInDays) || DEFAULT_TTL_DAYS))
    const resendShareId = typeof body?.resendShareId === "string" ? body.resendShareId.trim() : ""

    // Full-column select first; some deployments may not have run the migration
    // that adds recruiter/account-manager emails yet — degrade to core fields.
    const { data: jobFull, error: jobError } = await supabaseAdmin
      .from("jobs")
      .select("id, title, client_name, client_id, city, recruiter_email, account_manager_email")
      .eq("id", id)
      .maybeSingle()

    let job: any = jobFull
    if (jobError || !job) {
      const code = (jobError as any)?.code || ""
      if (!job && (code === "PGRST116" || !jobError)) {
        return NextResponse.json({ error: "Job not found" }, { status: 404 })
      }
      if (jobError) logger.warn("Shortlist share: full job select failed, falling back", jobError)
      const { data: jobCore, error: coreError } = await supabaseAdmin
        .from("jobs")
        .select("id, title, client_name, client_id, city")
        .eq("id", id)
        .maybeSingle()
      if (coreError || !jobCore) {
        if ((coreError as any)?.code === "PGRST116") {
          return NextResponse.json({ error: "Job not found" }, { status: 404 })
        }
        logger.error("Failed to load job for shortlist share", coreError || jobError)
        return NextResponse.json({ error: coreError?.message || jobError?.message || "Job not found" }, { status: 500 })
      }
      job = jobCore
    }

    const origin = request.nextUrl.origin
    const sendEmail = async (
      subject: string,
      candidates: Array<{ candidate_id: string; name: string | null; current_role: string | null; current_company: string | null }>,
      linkUrl: string,
      notes?: string
    ): Promise<{ sent: boolean; error: string | null }> => {
      let emailSent = false
      let emailError: string | null = null
      try {
        let client: any = null
        try {
          const { data, error: clientError } = await supabaseAdmin
            .from("clients")
            .select("name, primary_contact_email")
            .eq("id", job.client_id)
            .maybeSingle()
          if (clientError) {
            logger.warn("Shortlist share: client contact select failed", clientError)
          } else {
            client = data
          }
        } catch (clientErr) {
          logger.warn("Shortlist share: client lookup threw", clientErr)
        }

        const recipient = client?.primary_contact_email
        const cc = [job.recruiter_email, job.account_manager_email].filter(
          (e): e is string => typeof e === "string" && e.trim().length > 0 && e.trim() !== recipient
        )

        if (!recipient) return { sent: false, error: "Client has no primary contact email" }

        const candidateIds = candidates.map((r) => r.candidate_id)
        const fitScores: Record<string, number | null> = {}
        if (candidateIds.length > 0) {
          const { data: fits } = await supabaseAdmin
            .from("candidate_job_fit")
            .select("candidate_id, fit_score")
            .in("candidate_id", candidateIds)
          for (const f of fits || []) fitScores[String(f.candidate_id)] = f.fit_score
        }

        await sendClientShortlistEmail({
          to: recipient,
          cc,
          from: process.env.SHORTLIST_EMAIL_FROM || process.env.EMAIL_FROM || "Tzy Recruiting <recruiting@truckinzy.com>",
          subject,
          clientName: client?.name || job.client_name || "Client",
          jobTitle: job.title || "",
          location: job.city || null,
          candidates: candidates.map((r) => ({
            name: r.name,
            currentRole: r.current_role,
            currentCompany: r.current_company,
            fitScore: fitScores[String(r.candidate_id)] ?? null,
          })),
          notes: notes || `Shared shortlist: ${linkUrl}`,
        })
        emailSent = true
      } catch (err: any) {
        emailError = err?.message || "Email send failed"
        logger.warn("Shortlist email failed", { jobId: id, error: emailError })
      }
      return { sent: emailSent, error: emailError }
    }

    // ---- Resend path: re-email an existing share link ----
    if (resendShareId) {
      const { data: existing } = await supabaseAdmin
        .from("shortlist_shares")
        .select("id, token, title, expires_at")
        .eq("id", resendShareId)
        .eq("job_id", id)
        .maybeSingle()
      if (!existing) return NextResponse.json({ error: "Share not found" }, { status: 404 })
      if (existing.expires_at && new Date(existing.expires_at).getTime() < Date.now()) {
        return NextResponse.json({ error: "This link has expired — generate a fresh one instead." }, { status: 400 })
      }

      const { data: rows } = await supabaseAdmin
        .from("shortlist_share_candidates")
        .select("candidate_id, name, current_role, current_company")
        .eq("share_id", existing.id)

      const result = await sendEmail(
        `Shortlist — ${existing.title}`,
        rows || [],
        `${origin}/shortlist/${existing.token}`
      )
      if (!result.sent && result.error) {
        return NextResponse.json({ error: result.error }, { status: 400 })
      }
      return NextResponse.json({
        message: `Reminder email sent${rows?.length ? ` (${rows.length} candidates)` : ""}`,
        emailSent: result.sent,
      })
    }

    // ---- Create path ----
    const candidates = await loadShortlistForJob(id)
    if (candidates.length === 0) {
      return NextResponse.json(
        { error: "No shortlisted candidates yet. Move candidates to the Shortlist stage before sharing." },
        { status: 400 }
      )
    }

    const token = crypto.randomBytes(16).toString("base64url")
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString()

    const { data: share, error: shareError } = await supabaseAdmin
      .from("shortlist_shares")
      .insert({
        job_id: id,
        token,
        title: title || `${job.title || "Job"} — Shortlist`,
        created_by: ctx.authUser.id,
        expires_at: expiresAt,
      })
      .select()
      .single()
    if (shareError) {
      logger.error("Failed to create shortlist share", shareError)
      return NextResponse.json({ error: shareError.message }, { status: 500 })
    }

    const rows = candidates.map(c => ({
      share_id: share.id,
      application_id: c.application_id,
      candidate_id: c.candidate_id,
      name: c.name,
      current_role: c.current_role,
      current_company: c.current_company,
      location: c.location,
      match_score: c.match_score,
      screening_score: c.screening_score,
      screening_verdict: c.screening_verdict,
    }))

    const { error: rowsError } = await supabaseAdmin.from("shortlist_share_candidates").insert(rows)
    if (rowsError) {
      await supabaseAdmin.from("shortlist_shares").delete().eq("id", share.id)
      logger.error("Failed to insert shortlist share candidates", rowsError)
      return NextResponse.json({ error: rowsError.message }, { status: 500 })
    }

    const url = `${origin}/shortlist/${token}`
    // Best-effort: notify the client (primary contact) + CC the Tzy recruiter
    // and account manager. Never fails the share itself if the email bounces.
    const emailResult = await sendEmail(
      `Shortlist — ${job.title || "Job"}${job.client_name ? ` (${job.client_name})` : ""}`,
      rows,
      url
    )

    return NextResponse.json({
      share: { ...share, url, candidateCount: rows.length },
      message: `Shortlist shared with ${rows.length} candidate${rows.length === 1 ? "" : "s"}`,
      emailSent: emailResult.sent,
      emailError: emailResult.error,
    })
  } catch (error: any) {
    logger.error("Error creating shortlist share", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const { id } = await params
    const { data: shares, error } = await supabaseAdmin
      .from("shortlist_shares")
      .select(`
        id,
        job_id,
        title,
        token,
        created_by,
        created_at,
        expires_at,
        shortlist_share_candidates(id, name, application_id, candidate_id, status, decided_at, decision_note)
      `)
      .eq("job_id", id)
      .order("created_at", { ascending: false })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Candidates currently sitting in the Shortlist stage — previewed in the
    // share dialog so recruiters know exactly what a new link would contain.
    let currentShortlist: Array<{ candidateId: string; name: string | null; currentRole: string | null; matchScore: number | null }> = []
    try {
      currentShortlist = (await loadShortlistForJob(id)).map(c => ({
        candidateId: c.candidate_id,
        name: c.name,
        currentRole: c.current_role,
        matchScore: c.match_score,
      }))
    } catch (e) {
      logger.warn("Failed to load current shortlist preview", e)
    }

    const origin = request.nextUrl.origin
    const payload = (shares || []).map((s: any) => {
      const candidates = s.shortlist_share_candidates || []
      return {
        id: s.id,
        title: s.title,
        token: s.token,
        url: `${origin}/shortlist/${s.token}`,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
        expired: !!s.expires_at && new Date(s.expires_at).getTime() < Date.now(),
        candidateCount: candidates.length,
        decidedCount: candidates.filter((c: any) => c.status !== "pending").length,
        byStatus: {
          pending: candidates.filter((c: any) => c.status === "pending").length,
          approved: candidates.filter((c: any) => c.status === "approved").length,
          rejected: candidates.filter((c: any) => c.status === "rejected").length,
        },
        candidates: candidates.map((c: any) => ({
          id: c.id,
          name: c.name,
          applicationId: c.application_id,
          candidateId: c.candidate_id,
          status: c.status,
          decidedAt: c.decided_at,
          decisionNote: c.decision_note,
        })),
      }
    })

    return NextResponse.json({ shares: payload, currentShortlist })
  } catch (error: any) {
    logger.error("Error fetching shortlist shares", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { id } = await params
    const body: any = await request.json().catch(() => ({}))
    const shareId = String(body?.shareId || "")

    if (!shareId) return NextResponse.json({ error: "Missing shareId" }, { status: 400 })

    const { data: share } = await supabaseAdmin
      .from("shortlist_shares")
      .select("id, job_id")
      .eq("id", shareId)
      .eq("job_id", id)
      .maybeSingle()
    if (!share) return NextResponse.json({ error: "Share not found" }, { status: 404 })

    await supabaseAdmin.from("shortlist_share_candidates").delete().eq("share_id", shareId)
    const { error: deleteError } = await supabaseAdmin.from("shortlist_shares").delete().eq("id", shareId)
    if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 })

    return NextResponse.json({ message: "Share revoked" })
  } catch (error: any) {
    logger.error("Error revoking shortlist share", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
