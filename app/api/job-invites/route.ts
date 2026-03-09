import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { randomBytes } from "node:crypto"
import { sendInviteEmail } from "@/lib/mailer"
import { aisensyService } from "@/lib/aisensy"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { buildTemplateParams, loadMessageTemplates, renderTemplate } from "@/lib/message-templates"
import { getBoardAppBaseUrl } from "@/lib/utils"

export const runtime = "nodejs"

function nowIso() {
  return new Date().toISOString()
}

function createToken() {
  return randomBytes(24).toString("base64url")
}

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.view") && !hasPermission(ctx, "jobs.edit") && !hasPermission(ctx, "jobs.post")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const url = new URL(request.url)
  const jobId = url.searchParams.get("jobId")
  if (!jobId) return NextResponse.json({ error: "Missing jobId" }, { status: 400 })

  const page = parseInt(url.searchParams.get("page") || "1")
  const limit = parseInt(url.searchParams.get("limit") || "10")
  const offset = (page - 1) * limit

  // Filters
  const statusFilter = url.searchParams.get("status")
  const activityFilter = url.searchParams.get("activity")
  const profileFilter = url.searchParams.get("profile")

  let query = supabaseAdmin
    .from("job_invites")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId)

  // Apply filters to count query
  if (statusFilter && statusFilter !== "all") {
    query = query.eq("status", statusFilter)
  }
  if (profileFilter === "linked") {
    query = query.not("candidate_id", "is", null)
  } else if (profileFilter === "not_linked") {
    query = query.is("candidate_id", null)
  }
  if (activityFilter === "opened") {
    query = query.not("opened_at", "is", null)
  } else if (activityFilter === "not_opened") {
    query = query.is("opened_at", null)
  } else if (activityFilter === "applied") {
    query = query.not("applied_at", "is", null)
  } else if (activityFilter === "not_applied") {
    query = query.is("applied_at", null)
  }

  const { count, error: countError } = await query

  if (countError) {
    return NextResponse.json({ error: countError.message }, { status: 500 })
  }

  // Data query
  let dataQuery = supabaseAdmin
    .from("job_invites")
    .select("id, job_id, candidate_id, email, token, status, sent_at, opened_at, responded_at, applied_at, rejected_at, created_at, metadata")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  // Apply filters to data query
  if (statusFilter && statusFilter !== "all") {
    dataQuery = dataQuery.eq("status", statusFilter)
  }
  if (profileFilter === "linked") {
    dataQuery = dataQuery.not("candidate_id", "is", null)
  } else if (profileFilter === "not_linked") {
    dataQuery = dataQuery.is("candidate_id", null)
  }
  if (activityFilter === "opened") {
    dataQuery = dataQuery.not("opened_at", "is", null)
  } else if (activityFilter === "not_opened") {
    dataQuery = dataQuery.is("opened_at", null)
  } else if (activityFilter === "applied") {
    dataQuery = dataQuery.not("applied_at", "is", null)
  } else if (activityFilter === "not_applied") {
    dataQuery = dataQuery.is("applied_at", null)
  }

  const { data, error } = await dataQuery

  if (error) {
    console.error("Failed to load invites:", error)
    return NextResponse.json({ error: error.message || "Failed to load invites" }, { status: 500 })
  }
  return NextResponse.json({ 
    invites: data || [],
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit)
    }
  })
}

export async function POST(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.edit") && !hasPermission(ctx, "jobs.post")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = (await request.json().catch(() => null)) as any
  const jobId = typeof body?.jobId === "string" ? body.jobId : null
  const candidateId = typeof body?.candidateId === "string" ? body.candidateId : null
  const emailFromBody = typeof body?.email === "string" ? body.email.trim().toLowerCase() : null
  const phoneFromBody = typeof body?.phone === "string" ? body.phone.trim() : null
  const sendWhatsapp = body?.sendWhatsapp === true
  const sendEmail = body?.sendEmail !== false
  const resend = body?.resend === true
  if (!jobId) return NextResponse.json({ error: "Missing jobId" }, { status: 400 })
  if (!candidateId && !emailFromBody) return NextResponse.json({ error: "Missing candidateId/email" }, { status: 400 })

  let email = emailFromBody
  let phone = phoneFromBody
  let candidateName: string | null = null
  if (candidateId) {
    const { data } = await supabaseAdmin
      .from("candidates")
      .select("email,phone,name")
      .eq("id", candidateId)
      .maybeSingle()
    if (!email) email = (data?.email as string | undefined) || null
    if (!phone) phone = (data?.phone as string | undefined) || null
    candidateName = (data?.name as string | undefined) || null
  }
  if (!email) return NextResponse.json({ error: "Candidate email not found" }, { status: 400 })
  if (!/^\S+@\S+\.\S+$/.test(email)) return NextResponse.json({ error: "Invalid email" }, { status: 400 })

  const token = createToken()
  const now = nowIso()
  const from = process.env.INVITES_FROM || process.env.POSTMARK_FROM || process.env.SMTP_USER || ""
  const normalizedPhone = phone ? phone.replace(/\s+/g, "") : null
  phone = normalizedPhone || null
  const shouldSendWhatsapp = sendWhatsapp && Boolean(phone)
  if (sendEmail && !from && !shouldSendWhatsapp) return NextResponse.json({ error: "Email not configured" }, { status: 400 })

  const base = getBoardAppBaseUrl()
  const buildLink = (t: string) => `${base}/invite/${t}`
  const needsJobDetails = Boolean((sendEmail && from) || shouldSendWhatsapp)
  const { data: jobDetails } = needsJobDetails
    ? await supabaseAdmin.from("jobs").select("title,client_name").eq("id", jobId).maybeSingle()
    : { data: null }
  const jobTitle = (jobDetails?.title as string | undefined) || "a role"
  const companyName = (jobDetails?.client_name as string | undefined) || "Truckinzy"
  const templates = await loadMessageTemplates()
  const inviteEmailTemplate = templates.invite_email
  const inviteWhatsappTemplate = templates.invite_whatsapp

  let invite: any = null
  let error: any = null
  let tokenToUse = token
  for (let i = 0; i < 3; i++) {
    const attemptToken = i === 0 ? tokenToUse : createToken()
    const res = await supabaseAdmin
      .from("job_invites")
      .insert({
        job_id: jobId,
        candidate_id: candidateId,
        email,
        token: attemptToken,
        status: "sent",
        sent_at: now,
        created_at: now,
        updated_at: now,
        metadata: { source: "internal" }
      })
      .select("id, token")
      .single()
    invite = res.data
    error = res.error
    tokenToUse = attemptToken
    if (!error) break

    if (String(error?.message || "").toLowerCase().includes("job_invites_job_email_unique") || error?.code === "23505") {
      const { data: existing } = await supabaseAdmin
        .from("job_invites")
        .select("id, token, metadata")
        .eq("job_id", jobId)
        .eq("email", email)
        .maybeSingle()

      if (existing?.token) {
        const link = buildLink(existing.token)

        let emailSent = false
        let emailError: string | null = null
        let whatsappSent = false
        let whatsappError: string | null = null
        if (resend && sendEmail && from) {
          const subject = renderTemplate(
            inviteEmailTemplate.subject || `Truckinzy: Invitation to apply — {{job_title}}`,
            {
              candidate_name: candidateName || "there",
              job_title: jobTitle,
              company_name: companyName,
              invite_link: link
            },
            true
          )
          const html = renderTemplate(
            inviteEmailTemplate.body,
            {
              candidate_name: candidateName || "there",
              job_title: jobTitle,
              company_name: companyName,
              invite_link: link
            },
            true
          )

          try {
            await sendInviteEmail({
              to: email,
              from,
              subject,
              jobTitle,
              inviteLink: link,
              html
            })
            emailSent = true
            await supabaseAdmin
              .from("job_invites")
              .update({ status: "sent", sent_at: now, updated_at: now })
              .eq("id", existing.id)
          } catch (e: any) {
            emailError = e?.message || "Failed to send email"
          }
        }
        if (shouldSendWhatsapp) {
          const templateParams = buildTemplateParams(
            inviteWhatsappTemplate?.metadata?.paramOrder || undefined,
            {
              candidate_name: candidateName || "there",
              job_title: jobTitle,
              company_name: companyName,
              invite_link: link
            }
          )
          const result = await aisensyService.sendWhatsAppMessage({
            phoneNumber: phone as string,
            candidateName: candidateName || "there",
            jobTitle,
            companyName,
            uniqueLink: link
          }, {
            campaignName: inviteWhatsappTemplate?.metadata?.campaignName,
            templateParams
          })
          whatsappSent = result.success
          whatsappError = result.success ? null : result.error || "Failed to send WhatsApp"
          const metaBase = existing?.metadata && typeof existing.metadata === "object" ? existing.metadata : {}
          await supabaseAdmin
            .from("job_invites")
            .update({
              metadata: {
                ...metaBase,
                whatsapp: {
                  status: whatsappSent ? "sent" : "failed",
                  phone,
                  error: whatsappError,
                  sent_at: whatsappSent ? now : null
                }
              },
              updated_at: now
            })
            .eq("id", existing.id)
        } else if (sendWhatsapp && !phone) {
          whatsappError = "Missing phone number"
        }

        return NextResponse.json(
          { invite: existing, link, emailSent, emailError, whatsappSent, whatsappError, created: false },
          { status: 200 }
        )
      }
      return NextResponse.json({ error: "Invite already exists for this email" }, { status: 409 })
    }
  }

  if (error) {
    console.error("Invite create failed:", error)
    return NextResponse.json({ error: error.message || "Failed to create invite" }, { status: 500 })
  }

  const link = buildLink(tokenToUse)

  let emailSent = false
  let emailError: string | null = null
  let whatsappSent = false
  let whatsappError: string | null = null

  if (sendEmail && from) {
    const subject = renderTemplate(
      inviteEmailTemplate.subject || `Truckinzy: Invitation to apply — {{job_title}}`,
      {
        candidate_name: candidateName || "there",
        job_title: jobTitle,
        company_name: companyName,
        invite_link: link
      },
      true
    )
    const html = renderTemplate(
      inviteEmailTemplate.body,
      {
        candidate_name: candidateName || "there",
        job_title: jobTitle,
        company_name: companyName,
        invite_link: link
      },
      true
    )

    try {
      await sendInviteEmail({
        to: email,
        from,
        subject,
        jobTitle,
        inviteLink: link,
        html
      })
      emailSent = true
    } catch (e: any) {
      emailError = e?.message || "Failed to send email"
    }
  }
  if (shouldSendWhatsapp) {
    const templateParams = buildTemplateParams(
      inviteWhatsappTemplate?.metadata?.paramOrder || undefined,
      {
        candidate_name: candidateName || "there",
        job_title: jobTitle,
        company_name: companyName,
        invite_link: link
      }
    )
    const result = await aisensyService.sendWhatsAppMessage({
      phoneNumber: phone as string,
      candidateName: candidateName || "there",
      jobTitle,
      companyName,
      uniqueLink: link
    }, {
      campaignName: inviteWhatsappTemplate?.metadata?.campaignName,
      templateParams
    })
    whatsappSent = result.success
    whatsappError = result.success ? null : result.error || "Failed to send WhatsApp"
    const metaBase = { source: "internal" }
    await supabaseAdmin
      .from("job_invites")
      .update({
        metadata: {
          ...metaBase,
          whatsapp: {
            status: whatsappSent ? "sent" : "failed",
            phone,
            error: whatsappError,
            sent_at: whatsappSent ? now : null
          }
        },
        updated_at: now
      })
      .eq("id", invite.id)
  } else if (sendWhatsapp && !phone) {
    whatsappError = "Missing phone number"
  }

  return NextResponse.json({ invite, link, emailSent, emailError, whatsappSent, whatsappError, created: true })
}
