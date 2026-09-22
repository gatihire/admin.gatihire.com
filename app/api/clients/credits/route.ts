import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.view") && !hasPermission(ctx, "jobs.edit") && !hasPermission(ctx, "jobs.post")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const search = searchParams.get("search") || ""
  const page = parseInt(searchParams.get("page") || "1")
  const limit = parseInt(searchParams.get("limit") || "50")
  const offset = (page - 1) * limit

  let clientQuery = supabaseAdmin
    .from("clients")
    .select("id, name, slug, primary_contact_email, primary_contact_name, contact_phone, contact_name, industry, employee_count, hiring_for, created_at, updated_at", { count: "exact" })
    .order("name", { ascending: true })
    .range(offset, offset + limit - 1)

  if (search) {
    const searchTerm = `%${search.toLowerCase()}%`
    clientQuery = clientQuery.or(`name.ilike.${searchTerm},primary_contact_email.ilike.${searchTerm},primary_contact_name.ilike.${searchTerm},slug.ilike.${searchTerm}`)
  }

  const { data: clients, error: clientsError, count } = await clientQuery

  if (clientsError) {
    console.error("[clients/credits GET]", clientsError)
    return NextResponse.json({ error: "Failed to fetch clients" }, { status: 500 })
  }

  const clientIds = (clients || []).map(c => c.id)
  let creditsMap: Record<string, { job_post_credits: number; profile_unlock_credits: number }> = {}

  if (clientIds.length > 0) {
    const { data: credits } = await supabaseAdmin
      .from("client_credits")
      .select("client_id, job_post_credits, profile_unlock_credits")
      .in("client_id", clientIds)

    if (credits) {
      for (const c of credits) {
        creditsMap[c.client_id] = {
          job_post_credits: c.job_post_credits || 0,
          profile_unlock_credits: c.profile_unlock_credits || 0
        }
      }
    }
  }

  const clientsWithCredits = (clients || []).map(client => ({
    ...client,
    job_post_credits: creditsMap[client.id]?.job_post_credits || 0,
    profile_unlock_credits: creditsMap[client.id]?.profile_unlock_credits || 0
  }))

  return NextResponse.json({
    clients: clientsWithCredits,
    total: count || 0,
    page,
    limit,
    totalPages: Math.ceil((count || 0) / limit)
  })
}

async function sendCreditsEmail(
  clientName: string,
  clientEmail: string,
  jobCredits: number,
  unlockCredits: number,
  changeType: "added" | "removed" | "set",
  adminNote?: string
) {
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN
  if (!postmarkToken || !clientEmail) return { sent: false, reason: "No email config or client email" }

  const actionText = changeType === "added" ? "added to" : changeType === "removed" ? "removed from" : "set for"
  const direction = changeType === "added" ? "increase" : changeType === "removed" ? "decrease" : "update"

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border-radius: 12px; padding: 32px; color: white;">
        <h1 style="margin: 0 0 8px; font-size: 24px;">Credit Update for ${clientName}</h1>
        <p style="margin: 0; opacity: 0.8;">Your GatiHire account credits have been updated</p>
      </div>
      
      <div style="background: #f8fafc; border-radius: 12px; padding: 24px; margin-top: 16px;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 12px 0; font-weight: 600; color: #374151;">Job Post Credits</td>
            <td style="padding: 12px 0; text-align: right; font-family: monospace; font-size: 18px; font-weight: 700; color: #1a1a2e;">${jobCredits}</td>
          </tr>
          <tr>
            <td style="padding: 12px 0; font-weight: 600; color: #374151;">Profile Unlock Credits</td>
            <td style="padding: 12px 0; text-align: right; font-family: monospace; font-size: 18px; font-weight: 700; color: #1a1a2e;">${unlockCredits}</td>
          </tr>
        </table>
        
        ${adminNote ? `
        <div style="margin-top: 20px; padding: 16px; background: #fff; border-radius: 8px; border-left: 4px solid #3b82f6;">
          <p style="margin: 0; font-size: 14px; color: #374151;"><strong>Admin Note:</strong> ${adminNote}</p>
        </div>
        ` : ""}
      </div>

      <p style="margin-top: 24px; font-size: 14px; color: #6b7280; text-align: center;">
        Questions? Contact <a href="mailto:support@gatihire.com" style="color: #3b82f6;">support@gatihire.com</a>
      </p>
    </div>
  `

  try {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": postmarkToken
      },
      body: JSON.stringify({
        From: "GatiHire Credits <credits@gatihire.com>",
        To: clientEmail,
        Subject: `Your GatiHire credits have been updated`,
        HtmlBody: htmlBody,
        MessageStream: "outbound"
      })
    })
    return { sent: res.ok, status: res.status }
  } catch (e) {
    return { sent: false, error: String(e) }
  }
}

export async function PATCH(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.edit") && !hasPermission(ctx, "jobs.post")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await request.json().catch(() => null)
  const { client_id, job_post_credits, profile_unlock_credits, admin_note, send_email = true } = body || {}

  if (!client_id) return NextResponse.json({ error: "client_id required" }, { status: 400 })
  if (job_post_credits === undefined && profile_unlock_credits === undefined) {
    return NextResponse.json({ error: "At least one credit field required" }, { status: 400 })
  }

  // Get current credits and client info
  const [{ data: existingCredits }, { data: client }] = await Promise.all([
    supabaseAdmin.from("client_credits").select("job_post_credits, profile_unlock_credits").eq("client_id", client_id).single(),
    supabaseAdmin.from("clients").select("name, primary_contact_email").eq("id", client_id).single()
  ])

  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 })

  const currentJob = existingCredits?.job_post_credits || 0
  const currentUnlock = existingCredits?.profile_unlock_credits || 0
  const newJob = job_post_credits !== undefined ? Number(job_post_credits) : currentJob
  const newUnlock = profile_unlock_credits !== undefined ? Number(profile_unlock_credits) : currentUnlock

  const jobDiff = newJob - currentJob
  const unlockDiff = newUnlock - currentUnlock

  // Determine change type for email
  let changeType: "added" | "removed" | "set" = "set"
  if (jobDiff > 0 || unlockDiff > 0) changeType = "added"
  else if (jobDiff < 0 || unlockDiff < 0) changeType = "removed"

  // Upsert credits
  const { error: upsertError } = await supabaseAdmin.from("client_credits").upsert({
    client_id,
    job_post_credits: newJob,
    profile_unlock_credits: newUnlock,
    updated_at: new Date().toISOString()
  }, { onConflict: "client_id" })

  if (upsertError) {
    console.error("[credits PATCH] upsert error:", upsertError)
    return NextResponse.json({ error: "Failed to update credits" }, { status: 500 })
  }

  // Log transaction
  const notes = []
  if (jobDiff !== 0) notes.push(`Job post credits: ${currentJob} → ${newJob} (${jobDiff > 0 ? "+" : ""}${jobDiff})`)
  if (unlockDiff !== 0) notes.push(`Profile unlock credits: ${currentUnlock} → ${newUnlock} (${unlockDiff > 0 ? "+" : ""}${unlockDiff})`)
  if (admin_note) notes.push(`Note: ${admin_note}`)

  await supabaseAdmin.from("client_credit_transactions").insert({
    client_id,
    type: changeType === "added" ? "admin_add" : changeType === "removed" ? "admin_remove" : "admin_set",
    amount: Math.abs(jobDiff) + Math.abs(unlockDiff),
    note: notes.join(" | ")
  })

  // Send email notification
  let emailResult = { sent: false }
  if (send_email && client.primary_contact_email && (jobDiff !== 0 || unlockDiff !== 0)) {
    emailResult = await sendCreditsEmail(
      client.name,
      client.primary_contact_email,
      newJob,
      newUnlock,
      changeType,
      admin_note
    )
  }

  return NextResponse.json({ 
    success: true, 
    client: { ...client, job_post_credits: newJob, profile_unlock_credits: newUnlock },
    email: emailResult
  })
}