import { NextRequest, NextResponse } from "next/server"
export const runtime = "nodejs"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.view") && !hasPermission(ctx, "applications.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id: jobId } = await params
  try {
    // Explicit candidate columns on purpose. `candidates (*)` used to pull
    // resume_text, the 768-dim embedding and search_vector for every applicant
    // on the job — tens of KB per row. On a busy job that single query could
    // serialise hundreds of MB and pin Postgres CPU. The profile sidebar fetches
    // the full record from /api/candidates/[id] when opened, so the pipeline only
    // needs the card fields.
    const [applicationsRes, participantsRes, fitScoresRes, sharesRes, activityRes] = await Promise.all([
      supabaseAdmin
        .from("applications")
        .select(`
          *,
          candidates:candidate_id (
            id, name, email, phone, phone_e164, current_role, current_company,
            total_experience, location, preferred_location, technical_skills,
            current_salary, expected_salary, notice_period, highest_qualification,
            degree, specialization, summary, tags, status, source, file_url,
            file_name, linkedin_profile
          ),
          jobs:job_id (title, industry, sub_category)
        `)
        .eq("job_id", jobId)
        .order("applied_at", { ascending: false }),

      // NOTE: the participant projection below is EXPLICIT, not `select(*)`.
      // `select(*)` pulled `transcript_raw`, `call_payload_json` and
      // `cost_breakdown` for every participant on the job — tens of KB per
      // row of transcript text that the card never shows and the results
      // sheet fetches separately anyway. On a busy job that was hundreds of
      // MB over the wire for a list view.
      //
      // It MUST match the `fields=pipeline` projection in
      // app/api/phone-screening/participants/route.ts. The pipeline page
      // polls that endpoint and replaces these rows with whatever comes
      // back, so a column missing from either list is a signal the page
      // loses a few seconds after it loads.
      supabaseAdmin
        .from("phone_screening_participants")
        .select(`
          id, campaign_id, job_id, candidate_id, status, origin, bolna_status,
          bolna_execution_id, retry_count, next_retry_at, scheduled_call_at,
          call_started_at, call_ended_at, call_attempts, max_call_attempts,
          call_duration_seconds, call_is_partial, call_voicemail,
          call_hangup_reason, call_disconnect_reason, hangup_by, last_attempt_at,
          carrier, ring_duration,
          recording_url, ai_score, ai_summary, ai_recommendation,
          ai_suggests_rejection, ai_suggests_rejection_at,
          classification_outcome, clarification_asked_at, clarification_answered_at,
          clarification_question, generated_questions, info_data, info_sources,
          info_request_sent_at, info_received_at, review_status, review_note,
          needs_manual_followup, prescreen_decision, prescreen_reason,
          callback_preference,
          verdict_json, screening_context, whatsapp_history,
          whatsapp_delivery_status, whatsapp_reply_text, whatsapp_response, whatsapp_sent_at,
          whatsapp_reply_at, whatsapp_message_id, info_step, info_confirmed,
          created_at, updated_at,
          candidates: candidate_id (id, name, email, phone, current_role, current_company, total_experience, location, technical_skills),
          jobs: job_id (id, title, client_name, city, location, salary_min, salary_max, salary_type, experience_min_years, experience_max_years, skills_must_have)
        `)
        .eq("job_id", jobId)
        .order("created_at", { ascending: false }),

      supabaseAdmin
        .from("candidate_job_fit")
        .select("candidate_id, fit_score, fit_json, summary")
        .eq("job_id", jobId),

      supabaseAdmin
        .from("shortlist_shares")
        .select("id, candidates:share_candidates(application_id, status)")
        .eq("job_id", jobId)
        .order("created_at", { ascending: false })
        .limit(1),

      // When did each candidate ENTER their current stage? The pipeline card
      // shows "how long has this person been sitting here", and without this
      // the only timestamp available was applied_at — which for a candidate
      // who moved three stages ago says nothing about how long they have
      // been stuck in the current one.
      supabaseAdmin
        .from("candidate_activity")
        .select("application_id, event_type, event_data, created_at")
        .eq("job_id", jobId)
        .eq("event_type", "stage_changed")
        .order("created_at", { ascending: false }),
    ])

    if (applicationsRes.error) {
      return NextResponse.json({ error: applicationsRes.error.message }, { status: 500 })
    }

    const applications = applicationsRes.data || []

    const participants: Record<string, any> = {}
    for (const p of participantsRes.data || []) {
      if (p?.candidate_id && !participants[p.candidate_id]) {
        participants[p.candidate_id] = p
      }
    }

    const fitScores: Record<string, number | null> = {}
    for (const row of fitScoresRes.data || []) {
      const parsed = row.fit_json as any
      fitScores[row.candidate_id] = row.fit_score ?? parsed?.fit_score ?? null
    }

    const clientDecisions: Record<string, string | null> = {}
    for (const share of sharesRes.data || []) {
      for (const c of share.candidates || []) {
        clientDecisions[c.application_id] = c.status || null
      }
    }

    applications.sort((a, b) => {
      const scoreA = fitScores[a.candidate_id] ?? -1
      const scoreB = fitScores[b.candidate_id] ?? -1
      return scoreB - scoreA
    })

    const missingFitCount = applications.filter(a => !(a.candidate_id in fitScores)).length

    // When each candidate entered their current stage.
    //
    // candidate_activity is ordered newest-first, so the first stage_changed
    // row for an application is the most recent one — which is when they
    // entered the stage they are in NOW. If we have no such event, fall
    // back to applied_at.
    const stageEnteredAt: Record<string, string> = {}
    // A Map, not applications.find() inside the loop. That was a nested
    // scan — O(applications x activity rows) on every pipeline load.
    const appById = new Map(applications.map((a) => [a.id as string, a]))
    for (const ev of activityRes.data || []) {
      const appId = (ev as any)?.application_id
      if (!appId) continue
      if (stageEnteredAt[appId]) continue
      // Ignore an event that moved them to a stage they are no longer in.
      const to = (ev as any)?.event_data?.to
      const app = appById.get(appId)
      if (to && app && app.status && to !== app.status) continue
      stageEnteredAt[appId] = (ev as any).created_at
    }

    return NextResponse.json({
      applications,
      participants,
      fitScores,
      clientDecisions,
      missingFitCount,
      stageEnteredAt,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 })
  }
}
