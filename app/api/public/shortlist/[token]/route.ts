import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean)
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed.map((v) => String(v)).filter(Boolean)
    } catch {
      // plain comma-separated string
    }
    return value.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)
  }
  return []
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const { data: share, error } = (await supabaseAdmin
      .from("shortlist_shares")
      .select(`
        id,
        job_id,
        title,
        created_at,
        expires_at,
        jobs:job_id (id, title, client_name, city, experience_min_years, experience_max_years)
      `)
      .eq("token", token)
      .maybeSingle()) as any

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!share) return NextResponse.json({ error: "This shortlist link is invalid." }, { status: 404 })

    if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
      return NextResponse.json({ error: "This shortlist link has expired." }, { status: 410 })
    }

    const { data: rows } = (await supabaseAdmin
      .from("shortlist_share_candidates")
      .select(`
        id,
        application_id,
        candidate_id,
        name,
        current_role,
        current_company,
        location,
        match_score,
        screening_score,
        screening_verdict,
        status,
        decided_at,
        decision_note,
        created_at
      `)
      .eq("share_id", share.id)
      .order("match_score", { ascending: false })
      .order("created_at", { ascending: true })) as { data: any[] | null }

    const shareRows = rows || []
    const candidateIds = Array.from(new Set(shareRows.map((r) => String(r.candidate_id)).filter(Boolean)))

    // Live profile enrichment — falls back to the share snapshot for anything missing.
    const candById = new Map<string, any>()
    if (candidateIds.length > 0) {
      const { data: cands } = await supabaseAdmin
        .from("candidates")
        .select(`
          id, name, email, phone, current_role, current_company, location, current_city,
          total_experience, summary, technical_skills, soft_skills, job_titles, desired_role,
          resume_text, file_url, file_name
        `)
        .in("id", candidateIds)
      for (const c of cands || []) candById.set(String(c.id), c)

      // AI fit analysis (generated when recruiters view DB Matches) — surfaced as
      // "Why this candidate" for the client.
      const { data: fits } = await supabaseAdmin
        .from("candidate_job_fit")
        .select("candidate_id, fit_score, pros, misses, interview_probes, summary")
        .in("candidate_id", candidateIds)
        .eq("job_id", share.job_id)
      for (const f of fits || []) {
        const c = candById.get(String(f.candidate_id))
        if (c) c.__fit = f
      }
    }

    const job = Array.isArray(share.jobs) ? share.jobs?.[0] : share.jobs

    return NextResponse.json({
      share: {
        title: share.title,
        jobId: share.job_id,
        jobTitle: job?.title ?? "Job",
        clientName: job?.client_name ?? null,
        jobLocation: job?.city ?? null,
        experienceRange:
          job?.experience_min_years != null || job?.experience_max_years != null
            ? { min: job.experience_min_years, max: job.experience_max_years }
            : null,
        createdAt: share.created_at,
        expiresAt: share.expires_at,
      },
      candidates: shareRows.map((r) => {
        const c = candById.get(String(r.candidate_id))
        const fit = c?.__fit
        return {
          id: r.id,
          applicationId: r.application_id,
          candidateId: r.candidate_id,
          // Snapshot first so the shortlist stays stable even if a profile changes.
          name: r.name || c?.name || "Candidate",
          currentRole: c?.current_role || r.current_role || null,
          currentCompany: c?.current_company || r.current_company || null,
          location: c?.location || c?.current_city || r.location || null,

          // Contact — shown to the client (resumes contain it anyway).
          email: c?.email || null,
          phone: c?.phone || null,

          // Profile detail
          totalExperience: c?.total_experience ?? null,
          summary: c?.summary || null,
          technicalSkills: parseList(c?.technical_skills),
          softSkills: parseList(c?.soft_skills),
          jobTitles: parseList(c?.job_titles),
          desiredRole: c?.desired_role || null,
          resumeText: typeof c?.resume_text === "string" ? c.resume_text.slice(0, 20000) : "",
          hasResumeFile: Boolean(c?.file_url || c?.file_name),
          fileName: c?.file_name || null,

          matchScore: r.match_score,
          screeningScore: r.screening_score,
          screeningVerdict: r.screening_verdict,

          aiFit: fit
            ? {
                score: fit.fit_score ?? null,
                summary: fit.summary || null,
                pros: parseList(fit.pros).slice(0, 5),
                misses: parseList(fit.misses).slice(0, 5),
                interviewProbes: parseList(fit.interview_probes).slice(0, 4),
              }
            : null,

          status: r.status,
          decidedAt: r.decided_at,
          decisionNote: r.decision_note,
        }
      }),
    })
  } catch (error: any) {
    logger.error("Error loading public shortlist", error)
    return NextResponse.json({ error: "Something went wrong loading this shortlist." }, { status: 500 })
  }
}

const VALID_DECISIONS = ["approved", "rejected"]

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const body: any = await request.json().catch(() => ({}))
    const candidateId = String(body?.candidateId || "")
    const decision = String(body?.decision || "").toLowerCase()
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) || null : null

    if (!candidateId) return NextResponse.json({ error: "Missing candidateId" }, { status: 400 })
    if (!VALID_DECISIONS.includes(decision)) {
      return NextResponse.json({ error: "Decision must be approved or rejected" }, { status: 400 })
    }

    const { data: share, error: shareError } = await supabaseAdmin
      .from("shortlist_shares")
      .select("id, expires_at")
      .eq("token", token)
      .maybeSingle()
    if (shareError) return NextResponse.json({ error: shareError.message }, { status: 500 })
    if (!share) return NextResponse.json({ error: "This shortlist link is invalid." }, { status: 404 })
    if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
      return NextResponse.json({ error: "This shortlist link has expired." }, { status: 410 })
    }

    const { data: row, error: rowError } = await supabaseAdmin
      .from("shortlist_share_candidates")
      .update({
        status: decision,
        decided_at: new Date().toISOString(),
        decision_note: note,
      })
      .eq("id", candidateId)
      .eq("share_id", share.id)
      .select("id, application_id, status, decided_at, decision_note")
      .maybeSingle()

    if (rowError) return NextResponse.json({ error: rowError.message }, { status: 500 })
    if (!row) return NextResponse.json({ error: "Candidate not found in this shortlist" }, { status: 404 })

    // Auto-advance the pipeline stage: approve → Interview, reject → Rejected.
    // Guarded to only move candidates that are still sitting in Shortlist.
    if (row.application_id) {
      const { error: appError } = await supabaseAdmin
        .from("applications")
        .update({ status: decision === "approved" ? "interview" : "rejected" })
        .eq("id", row.application_id)
        .eq("status", "shortlist")
      if (appError) logger.error("Failed to auto-advance application after client decision", appError)
    }

    return NextResponse.json({
      message: `Candidate ${decision}`,
      candidate: {
        id: row.id,
        status: row.status,
        decidedAt: row.decided_at,
        decisionNote: row.decision_note,
      },
    })
  } catch (error: any) {
    logger.error("Error recording client decision", error)
    return NextResponse.json({ error: "Something went wrong recording your decision." }, { status: 500 })
  }
}
