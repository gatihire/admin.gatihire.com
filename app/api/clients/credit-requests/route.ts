import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext } from "@/lib/internal-auth"

function parseClientMessage(message: string | null): string {
  if (!message) return ""
  let msg = message
  if (msg.includes("---ADMIN_NOTE---")) {
    msg = msg.split("---ADMIN_NOTE---")[0]
  }
  if (msg.includes("---ORDER_DETAILS---")) {
    msg = msg.split("---ORDER_DETAILS---")[0]
  }
  return msg.trim()
}

function parseOrderDetails(message: string | null) {
  if (!message || !message.includes("---ORDER_DETAILS---")) return null
  try {
    const parts = message.split("---ORDER_DETAILS---")
    return JSON.parse(parts[1].trim())
  } catch {
    return null
  }
}

function determineCreditType(requestType: string, orderDetails: any): { profileUnlock: boolean, jobPost: boolean } {
  if (orderDetails?.type === "bundle") {
    const bundle = orderDetails.bundle
    if (bundle === "database") return { profileUnlock: true, jobPost: false }
    if (bundle === "jobposting") return { profileUnlock: false, jobPost: true }
    if (bundle === "both") return { profileUnlock: true, jobPost: true }
  }
  if (orderDetails?.type === "individual") {
    const creditType = orderDetails.creditType
    return {
      profileUnlock: creditType === "profile_unlocks" || creditType === "profile_unlock",
      jobPost: creditType === "job_posts" || creditType === "job_post",
    }
  }
  const isProfileUnlock = requestType === "profile_unlocks" || requestType === "profile_unlock"
  const isJobPost = requestType === "job_posts" || requestType === "job_post"
  return { profileUnlock: isProfileUnlock, jobPost: isJobPost }
}

function calculateCreditsFromBundle(orderDetails: any): { profileUnlock: number, jobPost: number } {
  if (!orderDetails || orderDetails.type !== "bundle") return { profileUnlock: 0, jobPost: 0 }
  
  const credits = orderDetails.credits || ""
  const profileMatch = credits.match(/(\d+)\s*profile\s*unlock/i)
  const jobMatch = credits.match(/(\d+)\s*job/i)
  
  return {
    profileUnlock: profileMatch ? parseInt(profileMatch[1], 10) : 0,
    jobPost: jobMatch ? parseInt(jobMatch[1], 10) : 0,
  }
}

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const status = searchParams.get("status") || "pending"

  let q = supabaseAdmin
    .from("client_credit_requests")
    .select(`
      id, client_id, request_type, requested_amount, message, status, created_at, fulfilled_at,
      clients!client_id (id, name, primary_contact_email, primary_contact_name, contact_phone, contact_name, industry, employee_count, hiring_for)
    `)
    .order("created_at", { ascending: false })

  if (status !== "all") q = (q as any).eq("status", status)

  const { data, error } = await q

  if (error) {
    console.error("[credit-requests GET]", error)
    return NextResponse.json({ error: "Query failed" }, { status: 500 })
  }

  const formattedData = (data || []).map(req => ({
    ...req,
    status: req.status === "fulfilled" ? "approved" : req.status,
    reviewed_at: req.fulfilled_at,
    clientMessage: parseClientMessage(req.message),
    orderDetails: parseOrderDetails(req.message),
  }))

  return NextResponse.json({ requests: formattedData })
}

export async function PATCH(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json().catch(() => null)
  const { request_id, action, amount, admin_note } = body || {}

  if (!request_id || !["approve", "reject", "edit"].includes(action)) {
    return NextResponse.json({ error: "request_id and action (approve|reject|edit) required" }, { status: 400 })
  }

  const { data: req } = await supabaseAdmin
    .from("client_credit_requests")
    .select("*")
    .eq("id", request_id)
    .single()

  if (!req) return NextResponse.json({ error: "Request not found" }, { status: 404 })

  const orderDetails = parseOrderDetails(req.message)
  const finalAmount = amount !== undefined ? Number(amount) : req.requested_amount
  const originalMessage = parseClientMessage(req.message)
  const finalMessage = admin_note ? `${originalMessage}\n\n---ADMIN_NOTE---\n${admin_note}` : req.message

  if (action === "edit") {
    if (req.status !== "fulfilled" && req.status !== "approved") {
      return NextResponse.json({ error: "Only approved requests can be edited" }, { status: 400 })
    }

    const amountDiff = finalAmount - req.requested_amount

    await supabaseAdmin.from("client_credit_requests").update({
      requested_amount: finalAmount,
      message: finalMessage,
    }).eq("id", request_id)

    if (amountDiff !== 0) {
      const { data: existing } = await supabaseAdmin
        .from("client_credits")
        .select("profile_unlock_credits, job_post_credits")
        .eq("client_id", req.client_id)
        .single()

      const { profileUnlock, jobPost } = determineCreditType(req.request_type, orderDetails)

      if (existing) {
        await supabaseAdmin.from("client_credits").update({
          profile_unlock_credits: profileUnlock
            ? (existing.profile_unlock_credits || 0) + amountDiff
            : (existing.profile_unlock_credits || 0),
          job_post_credits: jobPost
            ? (existing.job_post_credits || 0) + amountDiff
            : (existing.job_post_credits || 0),
          updated_at: new Date().toISOString(),
        }).eq("client_id", req.client_id)
      }

      await supabaseAdmin.from("client_credit_transactions").insert({
        client_id: req.client_id,
        type: amountDiff > 0 ? "admin_add" : "admin_remove",
        amount: Math.abs(amountDiff),
        note: `Admin edited request #${request_id} — ${req.request_type} adjustment: ${amountDiff > 0 ? '+' : ''}${amountDiff}`,
      })
    }

    return NextResponse.json({ success: true })
  }

  if (req.status !== "pending") return NextResponse.json({ error: "Already processed" }, { status: 400 })

  await supabaseAdmin.from("client_credit_requests").update({
    status: action === "approve" ? "fulfilled" : "rejected",
    requested_amount: finalAmount,
    message: finalMessage,
    fulfilled_at: new Date().toISOString(),
  }).eq("id", request_id)

  if (action === "approve") {
    const { data: existing } = await supabaseAdmin
      .from("client_credits")
      .select("profile_unlock_credits, job_post_credits")
      .eq("client_id", req.client_id)
      .single()

    const { profileUnlock, jobPost } = determineCreditType(req.request_type, orderDetails)

    let profileUnlockAmount = 0
    let jobPostAmount = 0

    if (orderDetails?.type === "bundle") {
      const bundleCredits = calculateCreditsFromBundle(orderDetails)
      profileUnlockAmount = bundleCredits.profileUnlock
      jobPostAmount = bundleCredits.jobPost
    } else {
      profileUnlockAmount = profileUnlock ? finalAmount : 0
      jobPostAmount = jobPost ? finalAmount : 0
    }

    if (existing) {
      await supabaseAdmin.from("client_credits").update({
        profile_unlock_credits: (existing.profile_unlock_credits || 0) + profileUnlockAmount,
        job_post_credits: (existing.job_post_credits || 0) + jobPostAmount,
        updated_at: new Date().toISOString(),
      }).eq("client_id", req.client_id)
    } else {
      await supabaseAdmin.from("client_credits").insert({
        client_id: req.client_id,
        profile_unlock_credits: profileUnlockAmount,
        job_post_credits: jobPostAmount,
      })
    }

    const noteParts = []
    if (orderDetails?.type === "bundle") {
      noteParts.push(`Bundle: ${orderDetails.bundle} (${orderDetails.duration})`)
      noteParts.push(`Credits: ${orderDetails.credits}`)
    } else if (orderDetails?.type === "individual") {
      noteParts.push(`Individual: ${orderDetails.creditType} × ${orderDetails.amount}`)
    } else {
      noteParts.push(`${req.request_type} × ${finalAmount}`)
    }
    if (admin_note) noteParts.push(`Note: ${admin_note}`)

    await supabaseAdmin.from("client_credit_transactions").insert({
      client_id: req.client_id,
      type: "admin_add",
      amount: profileUnlockAmount + jobPostAmount,
      note: `Admin approved — ${noteParts.join(" | ")} (request #${request_id})`,
    })
  }

  return NextResponse.json({ success: true })
}
