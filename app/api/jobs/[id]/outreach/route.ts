import { NextRequest, NextResponse } from "next/server"
import { supabase, supabaseAdmin } from "@/lib/supabase"
import { GoogleGenerativeAI } from "@google/generative-ai"
import { generateEmbedding } from "@/lib/embedding"
import { redis } from "@/lib/redis"
import { calculateCandidateScore, applySidebarFilters } from "@/lib/scoring"
import crypto from "crypto"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { buildTemplateParams, loadMessageTemplates, renderTemplate } from "@/lib/message-templates"
import { getBoardAppBaseUrl } from "@/lib/utils"
import { aisensyService } from "@/lib/aisensy"
import { logger } from "@/lib/logger"
import { sendOutreachEmail } from "@/lib/mailer"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

function buildWebsearchQuery(terms: string[], max = 15): string {
  return terms.slice(0, max).map(t => t.includes(" ") ? `"${t}"` : t).filter(Boolean).join(" OR ")
}

export const runtime = "nodejs"

interface OutreachRequest {
  jobId: string
  messagingPreference: "email" | "whatsapp" | "both"
  autoMatchmaking: boolean
}

interface OutreachCandidate {
  id: string
  name: string
  email: string
  phone?: string
  current_role: string
  match_score: number
  matched_skills: string[]
  explanation: string
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "outreach.send")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

    const { id } = await params
    const body: any = await request.json().catch(() => ({}))

    const messagingPreference: "email" | "whatsapp" | "both" =
      body?.messagingPreference === "email" || body?.messagingPreference === "whatsapp" || body?.messagingPreference === "both"
        ? body.messagingPreference
        : "both"
    const autoMatchmaking = body?.autoMatchmaking !== false
    const mode: "send" | "resend" = body?.mode === "resend" ? "resend" : "send"
    const candidateIds: string[] = Array.isArray(body?.candidateIds)
      ? body.candidateIds.map((x: any) => String(x || "")).filter(Boolean)
      : []

    // Get job details
    const { data: job, error: jobError } = await supabaseAdmin
      .from("jobs")
      .select("*")
      .eq("id", id)
      .single()

    if (jobError || !job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 })
    }

    // Skip matchmaking for external link jobs
    if (job.is_external_link) {
      return NextResponse.json({ 
        message: "External link jobs do not support automatic matchmaking",
        candidates: [],
        messages_sent: 0
      })
    }

    if (mode === "send" && !autoMatchmaking) {
      return NextResponse.json({ 
        message: "Matchmaking disabled for this job",
        candidates: [],
        messages_sent: 0
      })
    }

    let outreachCandidates: OutreachCandidate[] = []
    let existingLinkByCandidateId = new Map<string, string>()

    if (mode === "resend") {
      if (candidateIds.length === 0) return NextResponse.json({ error: "Missing candidateIds" }, { status: 400 })
      const { data: rows, error: candidatesError } = await supabaseAdmin
        .from("candidates")
        .select("id,name,email,phone,current_role")
        .in("id", candidateIds)

      if (candidatesError) return NextResponse.json({ error: candidatesError.message }, { status: 500 })

      outreachCandidates = (rows || []).map((c: any) => ({
        id: String(c.id),
        name: c.name || "Unknown",
        email: c.email || "",
        phone: c.phone || "",
        current_role: c.current_role || "",
        match_score: 0,
        matched_skills: [],
        explanation: ""
      }))

      const { data: linkRows } = await supabaseAdmin
        .from("outreach_messages")
        .select("candidate_id,unique_link,created_at")
        .eq("job_id", id)
        .in("candidate_id", candidateIds)
        .order("created_at", { ascending: false })

      for (const r of linkRows || []) {
        const cid = String((r as any)?.candidate_id || "")
        const link = String((r as any)?.unique_link || "")
        if (cid && link && !existingLinkByCandidateId.has(cid)) existingLinkByCandidateId.set(cid, link)
      }
    } else {
      // Run enhanced matchmaking to get top 500 candidates
      const jdHash = crypto.createHash('md5').update((job.description || "").trim().toLowerCase()).digest('hex')
      const cacheKey = `jd_search_criteria:${jdHash}`
      let criteriaResult: any = null
      let embedding: number[] = []

      if (redis) {
        const cachedData = await redis.get<{ criteria: any, embedding: number[] }>(cacheKey)
        if (cachedData) {
          criteriaResult = cachedData.criteria
          embedding = cachedData.embedding
        }
      }

      if (!criteriaResult) {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" })
        const prompt = `Analyze this job description and extract key hiring criteria for candidate matching.
JD: """${(job.description || "").slice(0, 3000)}"""
Return ONLY valid JSON:
{"title": string, "required_skills": string[], "preferred_skills": string[], "min_experience_years": number|null, "location": string|null, "key_keywords": string[]}`

        const [extracted, emb] = await Promise.all([
          model.generateContent(prompt).then(r => {
            const text = r.response.text().replace(/```json\n?|\n?```/g, "").trim()
            return JSON.parse(text)
          }).catch(() => ({ title: "", required_skills: [], preferred_skills: [], key_keywords: [] })),
          generateEmbedding((job.description || "").slice(0, 7000)).catch(() => [] as number[]),
        ])
        
        criteriaResult = extracted
        embedding = emb

        if (redis && embedding.length > 0) {
          await redis.set(cacheKey, { criteria: criteriaResult, embedding }, { ex: 3600 * 24 }) // Cache 24h
        }
      }

      const criteria = criteriaResult

      // Step 2: Build websearch query
      const allKeyTerms = [...(criteria.required_skills || []), ...(criteria.key_keywords || []), criteria.title || ""].filter(Boolean)
      const websearchQ = buildWebsearchQuery(allKeyTerms, 15).replace(/[()]/g, " ").trim()

      // Step 3: Build RPC filters
      const rpcFilters: any = {}
      if (criteria.location) rpcFilters.currentCity = [criteria.location]
      if (criteria.min_experience_years) rpcFilters.exp_min = criteria.min_experience_years.toString()
      if (allKeyTerms.length > 0) rpcFilters.must_kw = allKeyTerms

      // Step 4: Run RPC search
      const { data, error } = await supabaseAdmin.rpc("search_candidates_hybrid", {
        p_query_text: websearchQ,
        p_query_embedding: embedding.length ? embedding : null,
        p_match_threshold: 0.15,
        p_filters: rpcFilters,
        p_limit: 500,
        p_offset: 0
      })

      if (error) {
        console.error("Matchmaking RPC error:", error)
        return NextResponse.json({ 
          message: "Failed to run matchmaking",
          candidates: [],
          messages_sent: 0
        })
      }

      // Step 5: Score and sort candidates
      const mappedCriteria = {
        role: criteria.title,
        location: criteria.location,
        min_experience_years: criteria.min_experience_years,
        skills: [...(criteria.required_skills || []), ...(criteria.preferred_skills || [])]
      }

      let results = (data || [])
        .map((row: any) => {
          const rawCandidate = row.candidate_data
          const calculatedScore = calculateCandidateScore(mappedCriteria, rawCandidate)
          const finalScore = Math.max(calculatedScore, row.match_score * 100)
          return { ...rawCandidate, match_score: Math.round(finalScore) }
        })
        .filter((c: any) => c.match_score >= 12)

      results.sort((a: any, b: any) => (b.match_score || 0) - (a.match_score || 0))
      results = results.map((c: any) => ({ ...c, match_score: Math.min(100, c.match_score) }))
      results = applySidebarFilters(results, {})

      // Store matches in job_matches for future use
      if (results.length > 0) {
        const matchInserts = results.map((c: any) => ({
          job_id: id,
          candidate_id: c.id,
          relevance_score: c.match_score / 100,
          source: 'enhanced_match',
          created_at: new Date().toISOString()
        }))

        await supabaseAdmin.from("job_matches").upsert(matchInserts, { onConflict: 'job_id, candidate_id' })
      }

      // Update job_match_runs
      await supabaseAdmin.from("job_match_runs").upsert({
        job_id: id,
        total_matches: results.length,
        cached_matches: results.length,
        per_page: 25,
        max_pages: 5,
        candidate_ids: results.map((c: any) => c.id),
        last_matched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'job_id' })

      if (results.length === 0) {
        return NextResponse.json({ 
          message: "No suitable candidates found for outreach",
          candidates: [],
          messages_sent: 0
        })
      }

      // Take top 150 candidates for outreach
      outreachCandidates = results.slice(0, 150).map(candidate => ({
        id: candidate.id,
        name: candidate.name,
        email: candidate.email,
        phone: candidate.phone,
        current_role: candidate.current_role,
        match_score: candidate.match_score / 100,
        matched_skills: [...(candidate.technical_skills || []), ...(candidate.soft_skills || [])],
        explanation: ""
      }))
    }

    // Generate unique links and send messages
    const outreachRecords: any[] = []
    let messagesSent = 0
    let emailSentCount = 0
    let whatsappSentCount = 0

    const emailFrom = process.env.OUTREACH_FROM || process.env.INVITES_FROM || process.env.POSTMARK_FROM || process.env.SMTP_USER || ""
    const templates = await loadMessageTemplates()
    const outreachEmailTemplate = templates.outreach_email
    const outreachWhatsappTemplate = templates.outreach_whatsapp

    // Helper to process a single candidate
    const processCandidate = async (candidate: any) => {
      const candidateRecords: any[] = []
      let candidateMessagesSent = 0
      
      try {
        // Generate unique application link
        const uniqueToken = crypto.randomBytes(16).toString("hex")
        const base = getBoardAppBaseUrl()
        const generatedLink = `${base}/apply/${id}?token=${uniqueToken}`
        const uniqueLink = mode === "resend" ? (existingLinkByCandidateId.get(String(candidate.id)) || generatedLink) : generatedLink

        const variables = {
          candidate_name: candidate.name || "there",
          job_title: job.title,
          company_name: job.client_name || "Truckinzy",
          apply_link: uniqueLink,
          match_score: `${Math.round(candidate.match_score * 100)}%`,
          skills: candidate.matched_skills.slice(0, 6).join(", ")
        }
        const whatsappMessageContent = renderTemplate(outreachWhatsappTemplate.body, variables, false)
        const emailHtml = renderTemplate(outreachEmailTemplate.body, variables, true)
        const emailSubject = renderTemplate(
          outreachEmailTemplate.subject || "Truckinzy: Apply for {{job_title}}",
          variables,
          true
        )

        // Send WhatsApp message if enabled
        if (messagingPreference === "whatsapp" || messagingPreference === "both") {
          if (candidate.phone) {
            try {
              const templateParams = buildTemplateParams(outreachWhatsappTemplate?.metadata?.paramOrder || undefined, variables)
              const whatsappResult = await aisensyService.sendWhatsAppMessage(
                {
                  phoneNumber: candidate.phone,
                  candidateName: candidate.name,
                  jobTitle: job.title,
                  companyName: job.client_name || "Truckinzy",
                  uniqueLink
                },
                {
                  campaignName: outreachWhatsappTemplate?.metadata?.campaignName,
                  templateParams
                }
              )

              logger.info(`WhatsApp attempt for ${candidate.phone}: success=${whatsappResult.success} error=${whatsappResult.error}`, { 
                candidateId: candidate.id, 
                phone: candidate.phone 
              })

              if (whatsappResult.success) {
                candidateMessagesSent++
                candidateRecords.push({
                  job_id: id,
                  candidate_id: candidate.id,
                  message_type: "whatsapp",
                  recipient_contact: candidate.phone,
                  message_content: whatsappMessageContent,
                  unique_link: uniqueLink,
                  status: "sent",
                  sent_at: new Date().toISOString(),
                  created_by: ctx.authUser.id
                })
              } else {
                candidateRecords.push({
                  job_id: id,
                  candidate_id: candidate.id,
                  message_type: "whatsapp",
                  recipient_contact: candidate.phone,
                  message_content: whatsappMessageContent,
                  unique_link: uniqueLink,
                  status: "failed",
                  error_message: whatsappResult.error,
                  created_at: new Date().toISOString(),
                  created_by: ctx.authUser.id
                })
              }
            } catch (e: any) {
              logger.error(`Error sending WhatsApp to ${candidate.phone}`, e)
              candidateRecords.push({
                job_id: id,
                candidate_id: candidate.id,
                message_type: "whatsapp",
                recipient_contact: candidate.phone,
                unique_link: generatedLink,
                status: "failed",
                error_message: e?.message || "Failed to send WhatsApp",
                created_at: new Date().toISOString(),
                created_by: ctx.authUser.id
              })
            }
          }
        }

        // Send email if enabled
        if (messagingPreference === "email" || messagingPreference === "both") {
          if (!emailFrom) {
            candidateRecords.push({
              job_id: id,
              candidate_id: candidate.id,
              message_type: "email",
              recipient_contact: candidate.email,
              message_content: emailHtml,
              unique_link: generatedLink,
              status: "failed",
              error_message: "Missing OUTREACH_FROM/POSTMARK_FROM",
              created_at: new Date().toISOString(),
              created_by: ctx.authUser.id
            })
          } else {
            try {
              await sendOutreachEmail({
                to: candidate.email,
                from: emailFrom,
                subject: emailSubject,
                jobTitle: job.title,
                applyLink: uniqueLink,
                candidateName: candidate.name,
                matchScorePercent: Math.round(candidate.match_score * 100),
                matchedSkills: candidate.matched_skills,
                html: emailHtml
              })

              candidateMessagesSent++
              candidateRecords.push({
                job_id: id,
                candidate_id: candidate.id,
                message_type: "email",
                recipient_contact: candidate.email,
                message_content: emailHtml,
                unique_link: uniqueLink,
                status: "sent",
                sent_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
                created_by: ctx.authUser.id
              })
            } catch (e: any) {
              logger.error(`Error sending email to ${candidate.email}`, e)
              candidateRecords.push({
                job_id: id,
                candidate_id: candidate.id,
                message_type: "email",
                recipient_contact: candidate.email,
                message_content: emailHtml,
                unique_link: generatedLink,
                status: "failed",
                error_message: e?.message || "Failed to send email",
                created_at: new Date().toISOString(),
                created_by: ctx.authUser.id
              })
            }
          }
        }
      } catch (e: any) {
        logger.error(`Error processing candidate ${candidate.id}`, e)
      }

      return { records: candidateRecords, messagesSent: candidateMessagesSent }
    }

    // Process candidates with concurrency control (5 at a time)
    const concurrencyLimit = 5
    const results: Array<{ records: any[], messagesSent: number }> = []
    
    for (let i = 0; i < outreachCandidates.length; i += concurrencyLimit) {
      const batch = outreachCandidates.slice(i, i + concurrencyLimit)
      const batchResults = await Promise.all(batch.map(processCandidate))
      results.push(...batchResults)
    }

    // Aggregate results
    for (const result of results) {
      outreachRecords.push(...result.records)
      messagesSent += result.messagesSent
      // Count email vs whatsapp sent
      for (const record of result.records) {
        if (record.status === "sent") {
          if (record.message_type === "email") emailSentCount++
          if (record.message_type === "whatsapp") whatsappSentCount++
        }
      }
    }

    // Save outreach records
    if (outreachRecords.length > 0) {
      const { error: outreachError } = await supabaseAdmin
        .from("outreach_messages")
        .insert(outreachRecords)

      if (outreachError) {
        logger.error("Error saving outreach records", outreachError)
      }

      // Also save job_invites records for consistency with client-app
      const jobInviteRecords = []
      for (const candidate of outreachCandidates) {
        const matchingRecord = outreachRecords.find(r => r.candidate_id === candidate.id)
        if (matchingRecord) {
          jobInviteRecords.push({
            job_id: id,
            candidate_id: candidate.id,
            email: candidate.email,
            token: matchingRecord.unique_link.split("token=")[1],
            status: matchingRecord.status,
            sent_at: matchingRecord.sent_at,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            metadata: { source: 'admin_outreach' }
          })
        }
      }

      if (jobInviteRecords.length > 0) {
        const { error: inviteError } = await supabaseAdmin
          .from("job_invites")
          .insert(jobInviteRecords)
        if (inviteError) {
          logger.error("Error saving job_invites records", inviteError)
        }
      }

      // Update job outreach counts
      await supabaseAdmin
        .from("jobs")
        .update({
          outreach_sent_count: job.outreach_sent_count + messagesSent,
          updated_at: new Date().toISOString()
        })
        .eq("id", id)
    }

    logger.info(`Job outreach completed`, { 
      jobId: id, 
      candidatesFound: outreachCandidates.length, 
      messagesSent,
      emailSentCount,
      whatsappSentCount,
      messagingPreference 
    })

    supabaseAdmin
      .from("analytics_events")
      .insert({
        actor_auth_user_id: ctx.authUser.id,
        event_name: "outreach.sent",
        entity_type: "jobs",
        entity_id: id,
        metadata: {
          candidates_found: outreachCandidates.length,
          messages_sent: messagesSent,
          sent_by_channel: { email: emailSentCount, whatsapp: whatsappSentCount },
          messaging_preference: messagingPreference,
        },
      })
      .then(() => {})

    return NextResponse.json({
      message: `Found ${outreachCandidates.length} candidates, sent ${messagesSent} messages`,
      candidates: outreachCandidates,
      messages_sent: messagesSent,
      sent_by_channel: {
        email: emailSentCount,
        whatsapp: whatsappSentCount,
      },
      messaging_preference: messagingPreference
    })

  } catch (error: any) {
    logger.error("Error in job outreach", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "outreach.view") && !hasPermission(ctx, "outreach.send")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { id } = await params
    const { searchParams } = new URL(request.url)
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1)
    const perPage = Math.max(1, Math.min(100, parseInt(searchParams.get("perPage") || "20", 10) || 20))

    const listLimit = Math.max(200, Math.min(10_000, perPage * page * 20))
    const { data: idRows, error: idErr } = await supabaseAdmin
      .from("outreach_messages")
      .select("candidate_id,created_at")
      .eq("job_id", id)
      .order("created_at", { ascending: false })
      .limit(listLimit)

    if (idErr) return NextResponse.json({ error: idErr.message }, { status: 500 })

    const orderedCandidateIds: string[] = []
    const seen = new Set<string>()
    for (const r of idRows || []) {
      const cid = String((r as any)?.candidate_id || "")
      if (!cid || seen.has(cid)) continue
      seen.add(cid)
      orderedCandidateIds.push(cid)
    }

    const totalCandidates = orderedCandidateIds.length
    const start = (page - 1) * perPage
    const end = Math.min(start + perPage, totalCandidates)
    const pageCandidateIds = orderedCandidateIds.slice(start, end)

    const { data: applications } = await supabaseAdmin
      .from("applications")
      .select("candidate_id")
      .eq("job_id", id)
      .in("candidate_id", pageCandidateIds)

    const appliedCandidateIds = new Set(
      Array.isArray(applications) ? applications.map((a: any) => String(a?.candidate_id || "")).filter(Boolean) : []
    )

    const { data: outreachMessages, error } = pageCandidateIds.length
      ? await supabaseAdmin
          .from("outreach_messages")
          .select(
            `
            id,
            candidate_id,
            message_type,
            status,
            sent_at,
            delivered_at,
            opened_at,
            unique_link,
            created_at,
            candidates:candidate_id (name, email, phone, current_role)
          `
          )
          .eq("job_id", id)
          .in("candidate_id", pageCandidateIds)
          .order("created_at", { ascending: false })
      : { data: [], error: null }

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const statusRank: Record<string, number> = {
      opened: 5,
      delivered: 4,
      sent: 3,
      pending: 2,
      failed: 1,
    }

    const messageTime = (m: any) => {
      const raw = m?.opened_at || m?.delivered_at || m?.sent_at || m?.created_at || 0
      const t = new Date(raw).getTime()
      return Number.isFinite(t) ? t : 0
    }

    const isBetter = (a: any, b: any) => {
      const ra = statusRank[String(a?.status || "")] || 0
      const rb = statusRank[String(b?.status || "")] || 0
      if (ra !== rb) return ra > rb
      return messageTime(a) > messageTime(b)
    }

    // Group by candidate, but keep latest/best message per type (email/whatsapp) to avoid duplicates
    const candidateMap = new Map<string, any>()
    outreachMessages?.forEach((message: any) => {
      const candidateId = String(message?.candidate_id || "")
      if (!candidateId) return

      if (!candidateMap.has(candidateId)) {
        candidateMap.set(candidateId, {
          id: candidateId,
          name: message.candidates?.name || "Unknown",
          email: message.candidates?.email || "",
          phone: message.candidates?.phone || "",
          current_role: message.candidates?.current_role || "",
          responded: false,
          latestByType: {} as Record<string, any>,
        })
      }

      const candidate = candidateMap.get(candidateId)
      const k = String(message?.message_type || "")
      if (k) {
        const prev = candidate.latestByType[k]
        if (!prev || isBetter(message, prev)) candidate.latestByType[k] = message
      }

      if (message.opened_at || message.status === "opened") candidate.responded = true
    })

    for (const c of candidateMap.values()) {
      if (appliedCandidateIds.has(String(c.id))) c.responded = true
    }

    const candidates = Array.from(candidateMap.values())
      .sort((a: any, b: any) => orderedCandidateIds.indexOf(String(a.id)) - orderedCandidateIds.indexOf(String(b.id)))
      .map((c: any) => {
      const messages = Object.values(c.latestByType || {})
        .map((m: any) => ({
          id: m.id,
          type: m.message_type,
          status: m.status,
          sent_at: m.sent_at,
          delivered_at: m.delivered_at,
          opened_at: m.opened_at,
          unique_link: m.unique_link,
        }))
        .sort((a: any, b: any) => messageTime(b) - messageTime(a))
      return {
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        current_role: c.current_role,
        responded: c.responded,
        messages,
      }
    })

    const countByStatus = async (status: string) => {
      const { count } = await supabaseAdmin
        .from("outreach_messages")
        .select("id", { count: "exact", head: true })
        .eq("job_id", id)
        .eq("status", status)
      return count || 0
    }

    const [pendingCount, sentCount, deliveredCount, openedCount, failedCount] = await Promise.all([
      countByStatus("pending"),
      countByStatus("sent"),
      countByStatus("delivered"),
      countByStatus("opened"),
      countByStatus("failed"),
    ])

    const { count: messagesSentCount } = await supabaseAdmin
      .from("outreach_messages")
      .select("id", { count: "exact", head: true })
      .eq("job_id", id)

    const respondedIdRowsLimit = Math.max(500, Math.min(10_000, totalCandidates * 5))
    const { data: openedIdRows } = await supabaseAdmin
      .from("outreach_messages")
      .select("candidate_id")
      .eq("job_id", id)
      .or("status.eq.opened,opened_at.not.is.null")
      .limit(respondedIdRowsLimit)

    const respondedCandidateIds = new Set<string>()
    for (const r of openedIdRows || []) respondedCandidateIds.add(String((r as any)?.candidate_id || ""))

    const { data: appliedAllRows } = await supabaseAdmin
      .from("applications")
      .select("candidate_id")
      .eq("job_id", id)
      .limit(10_000)
    for (const r of appliedAllRows || []) respondedCandidateIds.add(String((r as any)?.candidate_id || ""))

    respondedCandidateIds.delete("")

    const stats = {
      total_outreached: totalCandidates,
      responded: respondedCandidateIds.size,
      messages_sent: messagesSentCount || 0,
      by_status: {
        pending: pendingCount,
        sent: sentCount,
        delivered: deliveredCount,
        opened: openedCount,
        failed: failedCount
      }
    }

    return NextResponse.json({
      candidates,
      stats,
      page,
      perPage,
      totalCandidates
    })

  } catch (error: any) {
    logger.error("Error fetching outreach data", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
