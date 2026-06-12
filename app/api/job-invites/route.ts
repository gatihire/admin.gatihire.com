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

async function processSingleInvite({
  jobId,
  candidateId,
  email,
  phone,
  sendEmail,
  sendWhatsapp,
  resend,
  from,
  jobTitle,
  companyName,
  inviteEmailTemplate,
  inviteWhatsappTemplate,
  now,
  buildLink,
}: {
  jobId: string
  candidateId?: string | null
  email?: string | null
  phone?: string | null
  sendEmail: boolean
  sendWhatsapp: boolean
  resend: boolean
  from: string
  jobTitle: string
  companyName: string
  inviteEmailTemplate: any
  inviteWhatsappTemplate: any
  now: string
  buildLink: (t: string) => string
}) {
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
  if (!email) return { success: false, error: "Candidate email not found" }
  if (!/^\S+@\S+\.\S+$/.test(email)) return { success: false, error: "Invalid email" }

  const normalizedPhone = phone ? phone.replace(/\s+/g, "") : null
  phone = normalizedPhone || null
  const shouldSendWhatsapp = sendWhatsapp && Boolean(phone)

  let invite: any = null
  let error: any = null
  let tokenToUse = createToken()
  for (let i = 0; i < 3; i++) {
    const attemptToken = i === 0 ? tokenToUse : createToken()
    const res = await supabaseAdmin
      .from("job_invites")
      .insert({
        job_id: jobId,
        candidate_id: candidateId || null,
        email,
        token: attemptToken,
        status: "pending",
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

    if (
      String(error?.message || "").toLowerCase().includes("job_invites_job_email_unique") ||
      error?.code === "23505"
    ) {
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
          } catch (e: any) {
            emailError = e?.message || "Failed to send email"
            console.error("sendInviteEmail error:", e)
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
        }

        const metaBase = existing?.metadata && typeof existing.metadata === "object" ? existing.metadata : {}
        const updateData: any = { updated_at: now, metadata: { ...metaBase } }
        if (sendEmail) {
          updateData.metadata.email = { sent: emailSent, error: emailError, sent_at: emailSent ? now : null }
        }
        if (shouldSendWhatsapp || sendWhatsapp) {
          updateData.metadata.whatsapp = {
            status: whatsappSent ? "sent" : "failed",
            phone,
            error: whatsappError,
            sent_at: whatsappSent ? now : null
          }
        }
        if (emailSent || whatsappSent) {
          updateData.sent_at = now
          updateData.status = "sent"
        } else if (emailError || whatsappError) {
          updateData.status = "failed"
        }
        await supabaseAdmin.from("job_invites").update(updateData).eq("id", existing.id)

        return {
          success: true,
          invite: existing,
          link,
          emailSent,
          emailError,
          whatsappSent,
          whatsappError,
          created: false
        }
      }
      return { success: false, error: "Invite already exists for this email" }
    }
  }

  if (error) {
    console.error("Invite create failed:", error)
    return { success: false, error: error.message || "Failed to create invite" }
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
      await sendInviteEmail({ to: email, from, subject, jobTitle, inviteLink: link, html })
      emailSent = true
    } catch (e: any) {
      emailError = e?.message || "Failed to send email"
      console.error("sendInviteEmail error:", e)
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
  }

  const updateData: any = { updated_at: now, metadata: { source: "internal" } }
  if (sendEmail) {
    updateData.metadata.email = { sent: emailSent, error: emailError, sent_at: emailSent ? now : null }
  }
  if (shouldSendWhatsapp || sendWhatsapp) {
    updateData.metadata.whatsapp = {
      status: whatsappSent ? "sent" : "failed",
      phone,
      error: whatsappError,
      sent_at: whatsappSent ? now : null
    }
  }
  if (emailSent || whatsappSent) {
    updateData.sent_at = now
    updateData.status = "sent"
  } else if (emailError || whatsappError) {
    updateData.status = "failed"
  }
  await supabaseAdmin.from("job_invites").update(updateData).eq("id", invite.id)

  return {
    success: true,
    invite,
    link,
    emailSent,
    emailError,
    whatsappSent,
    whatsappError,
    created: true
  }
}

export async function POST(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.edit") && !hasPermission(ctx, "jobs.post")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = (await request.json().catch(() => null)) as any
  const jobId = typeof body?.jobId === "string" ? body.jobId : null
  const candidateIds = Array.isArray(body?.candidateIds)
    ? body.candidateIds.map((x: any) => String(x || "").trim()).filter(Boolean)
    : []
  const candidateId = typeof body?.candidateId === "string" ? body.candidateId : null
  const emailFromBody = typeof body?.email === "string" ? body.email.trim().toLowerCase() : null
  const phoneFromBody = typeof body?.phone === "string" ? body.phone.trim() : null
  const sendWhatsapp = body?.sendWhatsapp === true
  const sendEmail = body?.sendEmail !== false
  const resend = body?.resend === true

  if (!jobId) return NextResponse.json({ error: "Missing jobId" }, { status: 400 })
  if (candidateIds.length === 0 && !candidateId && !emailFromBody) {
    return NextResponse.json({ error: "Missing candidateIds/candidateId/email" }, { status: 400 })
  }

  const now = nowIso()
  const from = process.env.INVITES_FROM || process.env.POSTMARK_FROM || process.env.SMTP_USER || ""
  const base = getBoardAppBaseUrl()
  const buildLink = (t: string) => `${base}/invite/${t}`
  const { data: jobDetails } = await supabaseAdmin
    .from("jobs")
    .select("title,client_name,description,location,salary_min,salary_max,experience_min_years,experience_max_years")
    .eq("id", jobId)
    .maybeSingle()
  const jobTitle = (jobDetails?.title as string | undefined) || "a role"
  const companyName = (jobDetails?.client_name as string | undefined) || "Truckinzy"
  const jobDescription = (jobDetails?.description as string | undefined) || null
  const location = (jobDetails?.location as string | undefined) || null
  
  // Build experience string
  let experience: string | null = null
  if (jobDetails?.experience_min_years && jobDetails?.experience_max_years) {
    experience = `${jobDetails.experience_min_years}–${jobDetails.experience_max_years} years`
  } else if (jobDetails?.experience_min_years) {
    experience = `${jobDetails.experience_min_years}+ years`
  }
  
  // Build compensation string
  let compensation: string | null = null
  if (jobDetails?.salary_min && jobDetails?.salary_max) {
    compensation = `₹${jobDetails.salary_min}–${jobDetails.salary_max} LPA`
  } else if (jobDetails?.salary_min) {
    compensation = `₹${jobDetails.salary_min}+ LPA`
  }
  
  const templates = await loadMessageTemplates()
  const inviteEmailTemplate = templates.invite_email
  const inviteWhatsappTemplate = templates.invite_whatsapp

  // Update processSingleInvite to accept new fields
  const enhancedProcessSingleInvite = async (params: any) => {
    const { jobId, candidateId, email: initialEmail, phone: initialPhone, sendEmail, sendWhatsapp, resend } = params
    let email = initialEmail
    let phone = initialPhone
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
    if (!email) return { success: false, error: "Candidate email not found" }
    if (!/^\S+@\S+\.\S+$/.test(email)) return { success: false, error: "Invalid email" }

    const normalizedPhone = phone ? phone.replace(/\s+/g, "") : null
    phone = normalizedPhone || null
    const shouldSendWhatsapp = sendWhatsapp && Boolean(phone)

    let invite: any = null
    let error: any = null
    let tokenToUse = createToken()
    for (let i = 0; i < 3; i++) {
      const attemptToken = i === 0 ? tokenToUse : createToken()
      const res = await supabaseAdmin
        .from("job_invites")
        .insert({
          job_id: jobId,
          candidate_id: candidateId || null,
          email,
          token: attemptToken,
          status: "pending",
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

      if (
        String(error?.message || "").toLowerCase().includes("job_invites_job_email_unique") ||
        error?.code === "23505"
      ) {
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
            try {
              await sendInviteEmail({
                to: email,
                from,
                subject: `${companyName}: Invitation to apply — ${jobTitle}`,
                jobTitle,
                candidateName,
                inviteLink: link,
                companyName,
                jobDescription,
                location,
                experience,
                compensation,
                clientName: companyName
              })
              emailSent = true
            } catch (e: any) {
              emailError = e?.message || "Failed to send email"
              console.error("sendInviteEmail error:", e)
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
          }

          const metaBase = existing?.metadata && typeof existing.metadata === "object" ? existing.metadata : {}
          const updateData: any = { updated_at: now, metadata: { ...metaBase } }
          if (sendEmail) {
            updateData.metadata.email = { sent: emailSent, error: emailError, sent_at: emailSent ? now : null }
          }
          if (shouldSendWhatsapp || sendWhatsapp) {
            updateData.metadata.whatsapp = {
              status: whatsappSent ? "sent" : "failed",
              phone,
              error: whatsappError,
              sent_at: whatsappSent ? now : null
            }
          }
          if (emailSent || whatsappSent) {
            updateData.sent_at = now
            updateData.status = "sent"
          } else if (emailError || whatsappError) {
            updateData.status = "failed"
          }
          await supabaseAdmin.from("job_invites").update(updateData).eq("id", existing.id)

          return {
            success: true,
            invite: existing,
            link,
            emailSent,
            emailError,
            whatsappSent,
            whatsappError,
            created: false
          }
        }
        return { success: false, error: "Invite already exists for this email" }
      }
    }

    if (error) {
      console.error("Invite create failed:", error)
      return { success: false, error: error.message || "Failed to create invite" }
    }

    const link = buildLink(tokenToUse)
    let emailSent = false
    let emailError: string | null = null
    let whatsappSent = false
    let whatsappError: string | null = null

    if (sendEmail && from) {
      try {
        await sendInviteEmail({
          to: email,
          from,
          subject: `${companyName}: Invitation to apply — ${jobTitle}`,
          jobTitle,
          candidateName,
          inviteLink: link,
          companyName,
          jobDescription,
          location,
          experience,
          compensation,
          clientName: companyName
        })
        emailSent = true
      } catch (e: any) {
        emailError = e?.message || "Failed to send email"
        console.error("sendInviteEmail error:", e)
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
    }

    const updateData: any = { updated_at: now, metadata: { source: "internal" } }
    if (sendEmail) {
      updateData.metadata.email = { sent: emailSent, error: emailError, sent_at: emailSent ? now : null }
    }
    if (shouldSendWhatsapp || sendWhatsapp) {
      updateData.metadata.whatsapp = {
        status: whatsappSent ? "sent" : "failed",
        phone,
        error: whatsappError,
        sent_at: whatsappSent ? now : null
      }
    }
    if (emailSent || whatsappSent) {
      updateData.sent_at = now
      updateData.status = "sent"
    } else if (emailError || whatsappError) {
      updateData.status = "failed"
    }
    await supabaseAdmin.from("job_invites").update(updateData).eq("id", invite.id)

    return {
      success: true,
      invite,
      link,
      emailSent,
      emailError,
      whatsappSent,
      whatsappError,
      created: true
    }
  }

  if (candidateIds.length > 0) {
    const results: any[] = []
    for (const cId of candidateIds) {
      const res = await enhancedProcessSingleInvite({
        jobId,
        candidateId: cId,
        sendEmail,
        sendWhatsapp,
        resend,
        from,
        jobTitle,
        companyName,
        inviteEmailTemplate,
        inviteWhatsappTemplate,
        now,
        buildLink
      })
      results.push({ candidateId: cId, ...res })
    }
    return NextResponse.json({ results })
  } else {
    const res = await enhancedProcessSingleInvite({
      jobId,
      candidateId,
      email: emailFromBody,
      phone: phoneFromBody,
      sendEmail,
      sendWhatsapp,
      resend,
      from,
      jobTitle,
      companyName,
      inviteEmailTemplate,
      inviteWhatsappTemplate,
      now,
      buildLink
    })
    if (!res.success) return NextResponse.json({ error: res.error }, { status: 500 })
    return NextResponse.json(res)
  }
}
