import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { deriveOrigin, deriveCandidateFlow, type CandidateOrigin } from "@/lib/origin"
import { orchestrateScreening, systemDecidesMode, getPublicJobUrl, formatSalaryRange, jobLocation } from "@/lib/call-orchestrator"
import { getWhatsAppService, talentOutreachTemplateName } from "@/lib/whatsapp"
import { placeCallImmediately } from "@/lib/scheduled-call"
import { logger } from "@/lib/logger"
import { sendSessionMessage, hasEnoughToScreen } from "@/lib/info-collector-v2"
import { logCandidateActivityBatch } from "@/lib/activity-logger"

export const runtime = "nodejs"

interface TriggerRequest {
  jobId: string
  candidateIds: string[]
  origin?: CandidateOrigin
  createApplication?: boolean
  callMode?: "call_now" | "quick_screen" | "collect_info_first"
  /** Per-job campaign config */
  campaignConfig?: {
    nudgeHours?: number
    escalateHours?: number
    maxCallAttempts?: number
  }
}

// Re-nudge an already-active participant (the HR clicked Nudge again).
// Previously dedup made this a silent no-op that returned nudgeSent: 0 without
// sending anything, so an HR who re-nudged got silence. Now we actually send
// the appropriate follow-up for the current call mode:
//  - collect_info_first -> re-ask the info request (reset any half-parsed state)
//  - quick_screen       -> re-send the outreach / screening invite
//  - call_now           -> re-place the AI call using the stored call payload
async function renudgeExistingParticipant(opts: {
  participantId: string
  candidate: { id: string; name?: string | null; phone?: string | null; source?: string | null }
  job: any
  client: any
  origin: CandidateOrigin
  /** Application-derived source (preferred for flow classification — the candidate row often has source=null). */
  source?: string | null
  callMode?: TriggerRequest["callMode"]
  now: string
}): Promise<{ ok: boolean; kind: "nudge" | "call"; error?: string }> {
  const { participantId, candidate, job, client, origin, source, callMode, now } = opts
  const whatsapp = getWhatsAppService()
  // The SYSTEM decides the nudge type (see systemDecidesMode): portal -> shortlist,
  // external -> 7-field, and only outbound candidates honor HR's call_now.
  // Prefer the application-derived source — candidate.source is often null.
  const flow = deriveCandidateFlow(source ?? candidate.source, origin)
  const effMode = systemDecidesMode(callMode, flow)

  try {
    if (effMode === "call_now") {
      const { data: participant } = await supabaseAdmin
        .from("phone_screening_participants")
        .select("call_payload_json, info_data")
        .eq("id", participantId)
        .maybeSingle()

      const userData = (participant as any)?.call_payload_json
      if (!userData || !candidate.phone) {
        return { ok: false, kind: "call", error: "No stored call payload or phone for re-nudge" }
      }

      // Route through the guarded placement rather than calling Bolna directly.
      // Two bugs lived in the old direct call:
      //  - it bypassed placeCallImmediately's "already with the provider" check,
      //    so HR double-clicking "Call Now" fired two Bolna executions;
      //  - it sent call_payload_json raw. That payload is seeded with 29 keys at
      //    creation but the CTC/notice fields are empty — the candidate's real
      //    answers live in info_data — so the AI had nothing to screen against.
      //    placeCallForParticipant already merges info_data over the payload, and
      //    it also owns the attempt counter that the old hardcoded
      //    `call_attempts: 1` used to reset.
      const result = await placeCallImmediately(participantId)
      if (result.skipped) {
        return { ok: false, kind: "call", error: result.error || "A call is already in progress" }
      }
      if (!result.success) {
        return { ok: false, kind: "call", error: result.error || "Failed to re-place call" }
      }
      return { ok: true, kind: "call" }
    }

    let msgResult: { success: boolean; messageId?: string; error?: string }
    let template: string
    let status: string
    let outboundLink: string | null = null
    // Hoisted so the thread records exactly what the template was sent with.
    let outboundLocation = ""
    let outboundSalary = ""
    let outboundCompany = ""
    const portalShortlist = flow === "portal"

    // Outbound re-nudges always re-run the full outbound opener — outreach plus
    // job link — and stop there, regardless of the mode HR picked.
    //
    // Two bugs lived here. Re-nudging with quick_screen sent the outreach but no
    // job link and never set awaitingInterest, so the candidate's later "Interested"
    // tap found no gate and was answered with call-slot buttons instead of the
    // details form. And re-nudging with collect_info_first fell through to the
    // generic branch and sent collect_info_form directly — asking a stranger for
    // their CTC before they had agreed to anything.
    if (flow === "outbound") {
      // Must match the name the send actually uses. Hardcoding "talent_outreach"
      // recorded a template the candidate never received, making a correct
      // re-nudge look like the wrong message had gone out.
      template = talentOutreachTemplateName()
      outboundLocation = jobLocation(job) || "Multiple locations"
      outboundSalary = formatSalaryRange(job) || "As per industry standards"
      outboundCompany = job.client_name || client?.name || "our client"
      msgResult = await whatsapp.sendTalentOutreach({
        phoneNumber: candidate.phone as string,
        candidateName: candidate.name || "",
        jobTitle: job.title || "",
        companyName: outboundCompany,
        // Empty parameters make Meta reject the entire send with #131008, so
        // both fallbacks here are load-bearing, not cosmetic.
        location: outboundLocation,
        // Shared with the orchestrator. The inline `${min} - ${max}` this
        // replaced printed raw rupees ("Rs 500000 - 600000") to candidates and
        // "?" whenever either bound was unset.
        salary: outboundSalary,
      })
      status = "whatsapp_sent"
      outboundLink = getPublicJobUrl(job.id)
    } else if (portalShortlist) {
      // Flow A portal: shortlist + schedule (info already in apply form)
      template = "shortlist_call_schedule"
      msgResult = await whatsapp.sendShortlistSchedule({
        phoneNumber: candidate.phone as string,
        candidateName: candidate.name || "",
        jobTitle: job.title || "",
        companyName: job.client_name || client?.name || "",
      })
      status = "whatsapp_sent"
    } else {
      // Flow B external + Flow C outbound (after interest): WhatsApp Flows form ask
      template = "collect_info_form"
      msgResult = await whatsapp.sendCollectInfoForm({
        phoneNumber: candidate.phone as string,
        candidateName: candidate.name || "",
        jobTitle: job.title || "",
        companyName: job.client_name || client?.name || "",
        flowToken: participantId,
      })
      status = "info_requested"
    }

    if (!msgResult.success) return { ok: false, kind: "nudge", error: msgResult.error || "Failed to send message" }

    // Fire-and-forget: a failed link must not fail the re-nudge itself.
    if (outboundLink && candidate.phone) {
      const linkText = `Here's the full role details if you'd like to review it first:\n${outboundLink}`
      // Gate the link on the template's delivery. Meta delivered the re-nudge
      // template ~9s AFTER the link on a live run, so the candidate got a bare
      // URL first and the message explaining it second.
      whatsapp
        .waitForDelivery(msgResult.messageId || "", 12_000)
        .catch(() => false)
        .then(() => sendSessionMessage(candidate.phone as string, linkText))
        .then(async (r: any) => {
          if (!r?.success) return
          const { appendThreadEntry } = await import("@/lib/whatsapp-thread")
          await appendThreadEntry(participantId, {
            direction: "out",
            text: linkText,
            status: "sent",
            kind: "job_link",
            messageId: r.messageId ?? null,
          })
        })
        .catch(() => {})
    }

    const { data: current } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("whatsapp_history, screening_context, info_data, info_confirmed, info_step")
      .eq("id", participantId)
      .maybeSingle()

    // Has this candidate already given us the screening answers? Re-triggering
    // must never restart that collection — they get asked for the same fields
    // again otherwise.
    const alreadyCollected = hasEnoughToScreen(current)

    const history = Array.isArray((current as any)?.whatsapp_history)
      ? [...(current as any).whatsapp_history]
      : []
    history.push({
      messageId: msgResult.messageId || null,
      template,
      direction: "out",
      // Record the parameters actually sent rather than an invented sentence.
      // The rendered body lives in Meta and cannot be read back; the previous
      // hand-written "following up ... Would you be interested?" matched nothing
      // the candidate received, so the recruiter card could not be trusted when
      // a candidate disputed what they were told.
      text:
        flow === "outbound"
          ? [
              `${candidate.name || "there"} — ${job.title || "an open role"} at ${outboundCompany}`,
              `Location: ${outboundLocation}`,
              `Salary: ${outboundSalary}`,
            ].join("\n")
          : `Following up on your screening for ${job.title || "the role"}.`,
      sentAt: now,
      status: "sent",
      kind: "re-nudge",
    })

    const update: Record<string, unknown> = {
      status,
      whatsapp_message_id: msgResult.messageId || null,
      whatsapp_sent_at: now,
      whatsapp_delivery_status: "sent",
      whatsapp_outbound_template: template,
      whatsapp_history: history,
      updated_at: now,
    }

    if (flow === "outbound") {
      // Back to the top of the outbound journey: ask for interest, collect nothing.
      update.screening_mode = "collect_info_first"
      update.info_step = "awaiting_interest"
      update.screening_context = {
        ...((current as any)?.screening_context || {}),
        awaitingInterest: true,
        jobUrl: outboundLink,
        renudgedAt: now,
      }
      // info_data is deliberately NOT cleared. Blanking it deleted answers the
      // candidate had already given, and the next form submission then asked for
      // the same fields again. A candidate who already opted in and submitted is
      // past this point in the journey.
      if (!alreadyCollected) update.info_data = {}
      if (!alreadyCollected) update.info_confirmed = false
    } else if (portalShortlist) {
      // Flow A portal: keep the previously seeded info; just re-send the invite.
      update.screening_mode = "collect_info_first"
      update.info_step = "confirmed"
      update.screening_context = {
        ...((current as any)?.screening_context || {}),
        renudgedAt: now,
      }
    } else if (effMode === "collect_info_first") {
      // Re-send the questions, but never delete what the candidate already
      // answered. The previous `info_data = {}` here was the direct cause of
      // "I already filled the form, why is it asking me again?" — the submitted
      // CTC/notice were wiped and the form started from blank.
      update.screening_mode = "collect_info_first"
      update.screening_context = {
        ...((current as any)?.screening_context || {}),
        renudgedAt: now,
      }
      if (alreadyCollected) {
        // Already has the full screening set, so there is nothing left to ask.
        update.info_step = "confirmed"
      } else {
        update.info_step = "collect_form"
        update.info_data = {}
        update.info_confirmed = false
      }
    }

    await supabaseAdmin.from("phone_screening_participants").update(update).eq("id", participantId)

    // Ensure the candidate's application is in ai_screen status
    const { data: app } = await supabaseAdmin
      .from("applications")
      .select("id")
      .eq("job_id", job.id)
      .eq("candidate_id", candidate.id)
      .maybeSingle()
    if (app?.id) {
      await supabaseAdmin
        .from("applications")
        .update({ status: "ai_screen", updated_at: now })
        .eq("id", app.id)
    }

    return { ok: true, kind: "nudge" }
  } catch (err: any) {
    return { ok: false, kind: effMode === "call_now" ? "call" : "nudge", error: err?.message || "Re-nudge failed" }
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const body: TriggerRequest = await request.json().catch(() => ({}))
    const { jobId, candidateIds, createApplication, callMode } = body

    if (!jobId || !Array.isArray(candidateIds) || candidateIds.length === 0) {
      return NextResponse.json({ error: "jobId and candidateIds are required" }, { status: 400 })
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from("jobs")
      .select(`
        id, title, client_name, client_id, industry, skills_must_have, skills_good_to_have,
        experience_min_years, experience_max_years, salary_min, salary_max,
        salary_type, city, location, education_min, languages_required, english_level, license_type, role_category,
        department_category, shift_type, employment_type, description
      `)
      .eq("id", jobId)
      .single()

    if (jobError || !job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 })
    }

    let client: any = null
    if (job.client_id) {
      const { data: clientData } = await supabaseAdmin
        .from("clients")
        .select("name, company_subtype, industry")
        .eq("id", job.client_id)
        .maybeSingle()
      client = clientData
    }

    const { data: candidates, error: candError } = await supabaseAdmin
      .from("candidates")
      .select("id,name,phone,current_role,current_company,total_experience,location,technical_skills,resume_text,source,current_ctc,expected_ctc,notice_period,willing_to_relocate,reason_for_switching")
      .in("id", candidateIds)

    if (candError) {
      return NextResponse.json({ error: candError.message }, { status: 500 })
    }

    // Direct outbound AI voice call — cold outreach for sourced profiles,
    // application follow-up for inbound applicants. Agent confirms it's a good
    // time, otherwise captures a callback preference.
    const fallbackOrigin: CandidateOrigin = body.origin || "outbound"

    const { data: applications } = await supabaseAdmin
      .from("applications")
      .select("id, candidate_id, source, origin, match_score")
      .eq("job_id", jobId)
      .in("candidate_id", candidateIds)

    const originByCandidate = new Map<string, CandidateOrigin>()
    const appByCandidate = new Map<string, any>()
    const sourceByCandidate = new Map<string, string>()
    for (const app of applications || []) {
      const a = app as any
      // Respect the application's own origin (inbound applicants stay inbound).
      if (!originByCandidate.has(a.candidate_id)) {
        originByCandidate.set(a.candidate_id, (a.origin as CandidateOrigin) || deriveOrigin(a.source))
      }
      if (!appByCandidate.has(a.candidate_id)) {
        appByCandidate.set(a.candidate_id, a)
      }
      if (!sourceByCandidate.has(a.candidate_id)) {
        sourceByCandidate.set(a.candidate_id, a.source || "applied")
      }
    }
    // Fall back to the candidate's own source column for candidates without an application row.
    for (const candidate of candidates || []) {
      if (!sourceByCandidate.has(candidate.id)) {
        const origin = originByCandidate.get(candidate.id) || deriveOrigin(candidate.source)
        sourceByCandidate.set(candidate.id, (candidate as any).source || (origin === "outbound" ? "database" : "applied"))
      }
    }

    // Sync application status to "ai_screen" for all candidates being screened.
    // This ensures the pipeline counts correctly while calls are active.
    // Always create an application if one doesn't exist — every screened candidate
    // must have a pipeline row so stage counts stay accurate.
    const now = new Date().toISOString()
    const appIds: string[] = []
    for (const candidate of candidates || []) {
      const existing = appByCandidate.get(candidate.id)
      if (existing) {
        appIds.push(existing.id)
      } else {
        // Auto-create pipeline entry for candidates without an application.
        const origin = fallbackOrigin || deriveOrigin((candidate as any).source)
        const { data: newApp, error: insErr } = await supabaseAdmin
          .from("applications")
          .insert({
            job_id: jobId,
            candidate_id: candidate.id,
            status: "ai_screen",
            source: origin === "outbound" ? "database" : "applied",
            origin,
            applied_at: now,
            updated_at: now,
          })
          .select("id")
          .single()
        if (insErr) {
          logger.warn("Auto-create application failed", { candidateId: candidate.id, error: insErr.message })
        } else if (newApp?.id) {
          appIds.push(newApp.id)
        }
      }
    }

    // Batch-update existing applications to ai_screen (idempotent — safe to run even if already set)
    if (appIds.length > 0) {
      const { error: updateErr } = await supabaseAdmin
        .from("applications")
        .update({ status: "ai_screen", updated_at: now })
        .in("id", appIds)
      if (updateErr) {
        logger.error("Failed to sync application status to ai_screen", { error: updateErr.message, appIds })
        throw new Error(`Failed to update application status: ${updateErr.message}`)
      }
      logger.info("Synced application status to ai_screen", { count: appIds.length })
    }

    // Candidate dedup: check if any candidates already have active participants for this job
    // If so, update their screening_context and log the update (showcase it was refreshed)
    const { data: existingParticipants } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("id, candidate_id, status, screening_context")
      .eq("job_id", jobId)
      .in("candidate_id", candidateIds)
      .in("status", ["pending", "whatsapp_sent", "whatsapp_delivered", "whatsapp_read",
                      "info_requested", "info_received", "interested", "call_scheduled",
                      "scheduled", "calling", "in_progress"])

    console.log("[TRIGGER] existingParticipants:", existingParticipants?.map(p => ({ candidate_id: p.candidate_id, status: p.status })))

    const dedupedCandidateIds = new Set<string>()
    const dedupUpdates: Array<{ candidateId: string; participantId: string }> = []
    for (const ep of existingParticipants || []) {
      dedupedCandidateIds.add(ep.candidate_id)
      dedupUpdates.push({ candidateId: ep.candidate_id, participantId: ep.id })
    }

    // Log dedup updates (showcase they were refreshed)
    if (dedupUpdates.length > 0) {
      logger.info("Candidate dedup: found existing active participants", {
        jobId,
        dedupedCount: dedupUpdates.length,
        candidateIds: dedupUpdates.map(d => d.candidateId),
      })
      // Update their screening_context with fresh job data
      for (const du of dedupUpdates) {
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({
            screening_context: {
              jobTitle: job.title,
              clientName: job.client_name || client?.name || "",
              origin: fallbackOrigin,
              salaryRange: formatSalaryRange(job),
              mustHaveSkills: Array.isArray(job.skills_must_have) ? job.skills_must_have.join(", ") : job.skills_must_have || "",
              experienceRange: `${job.experience_min_years ?? 0}-${job.experience_max_years ?? "any"}`,
              location: jobLocation(job),
              dedupedAt: now,
            },
            updated_at: now,
          })
          .eq("id", du.participantId)
      }
    }

    // ==================== RE-NUDGE (DEDUP THAT ACTUALLY SENDS) ====================
    // Previously dedup refreshed the context and returned nudgeSent: 0 without
    // sending anything. An HR who clicked "Nudge" again got silence. Instead,
    // re-send the correct follow-up to every already-active participant.
    let renudgedCandidates = 0
    let recalledCandidates = 0
    const renudgeFailures: string[] = []
    for (const du of dedupUpdates) {
      const candidate = (candidates || []).find((c) => c.id === du.candidateId)
      if (!candidate) continue
      const result = await renudgeExistingParticipant({
        participantId: du.participantId,
        candidate,
        job,
        client,
        origin: originByCandidate.get(du.candidateId) || fallbackOrigin,
        source: sourceByCandidate.get(du.candidateId) || (candidate as any).source,
        callMode,
        now,
      })
      if (!result.ok) {
        renudgeFailures.push(`${candidate.name || du.candidateId}: ${result.error}`)
        continue
      }
      if (result.kind === "call") recalledCandidates++
      else renudgedCandidates++
    }

    // Filter out deduped candidates from triggering new calls (they already have active participants)
    const freshCandidateIds = candidateIds.filter(id => !dedupedCandidateIds.has(id))
    const freshCandidates = (candidates || []).filter(c => freshCandidateIds.includes(c.id))

    console.log("[TRIGGER] freshCandidateIds:", freshCandidateIds)
    console.log("[TRIGGER] freshCandidates:", freshCandidates?.map(c => ({ id: c.id, name: c.name, phone: c.phone })))

    if (freshCandidateIds.length === 0) {
      // All candidates already have active participants — report the re-nudge
      return NextResponse.json({
        campaignId: null,
        totalCandidates: candidateIds.length,
        callsTriggered: recalledCandidates,
        callsFailed: 0,
        nudgeSent: renudgedCandidates,
        dedupedCount: dedupUpdates.length,
        dedupedCandidateIds: dedupUpdates.map(d => d.candidateId),
        message: renudgedCandidates + recalledCandidates > 0
          ? `Re-nudged ${renudgedCandidates} candidate(s) and re-queued ${recalledCandidates} call(s)`
          : "All candidates already have active screening participants (re-nudge failed)",
        errors: renudgeFailures.length > 0 ? renudgeFailures : undefined,
      })
    }

    console.log("[TRIGGER] Calling orchestrateScreening with:", {
      jobId: job.id,
      callMode,
      freshCandidateCount: freshCandidates.length,
      campaignConfig: body.campaignConfig
    })

    const result = await orchestrateScreening({
      job,
      client,
      candidates: freshCandidates as any[],
      originByCandidate,
      sourceByCandidate,
      fallbackOrigin,
      createdBy: ctx.authUser.id,
      callMode,
      campaignConfig: body.campaignConfig,
    })

    console.log("[TRIGGER] orchestrateScreening result:", result)

    // Log ai_screen_started for all candidates that were triggered
    logCandidateActivityBatch(
      (candidates || []).map((c) => ({
        jobId,
        candidateId: c.id,
        applicationId: appByCandidate.get(c.id)?.id || null,
        eventType: "ai_screen_started" as const,
        eventData: { call_mode: callMode || "call_now" },
        actor: ctx.authUser.id,
      }))
    )

    return NextResponse.json({
      campaignId: result.campaignId,
      totalCandidates: result.totalCandidates,
      callsTriggered: (result.callsTriggered || 0) + recalledCandidates,
      callsFailed: result.callsFailed,
      nudgeSent: (result.nudgeSent || 0) + renudgedCandidates,
      skippedNoPhone: result.skippedNoPhone.length > 0 ? result.skippedNoPhone : undefined,
      errors: result.errors,
      renudgedCount: renudgedCandidates,
      renudgeErrors: renudgeFailures.length > 0 ? renudgeFailures : undefined,
    })
  } catch (error: any) {
    if (error?.message === "No candidates with phone numbers found") {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    console.error("[TRIGGER] Error:", error)
    logger.error("Trigger screening failed", { error: error?.message, stack: error?.stack })
    return NextResponse.json({ error: "Internal Server Error", details: error?.message }, { status: 500 })
  }
}
