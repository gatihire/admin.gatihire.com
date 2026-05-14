import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext } from "@/lib/internal-auth"

// GET — list all credit requests (optionally filter by status=pending|approved|rejected|all)
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

  // Map database enum to UI enum if needed
  const formattedData = (data || []).map(req => ({
    ...req,
    status: req.status === "fulfilled" ? "approved" : req.status,
    reviewed_at: req.fulfilled_at,
  }))

  return NextResponse.json({ requests: formattedData })
}

// PATCH — approve or reject a credit request; approve also recharges credits
export async function PATCH(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json().catch(() => null)
  const { request_id, action, amount, admin_note } = body || {}

  if (!request_id || !["approve", "reject", "edit"].includes(action)) {
    return NextResponse.json({ error: "request_id and action (approve|reject|edit) required" }, { status: 400 })
  }

  // Fetch the request
  const { data: req } = await supabaseAdmin
    .from("client_credit_requests")
    .select("*")
    .eq("id", request_id)
    .single()

  if (!req) return NextResponse.json({ error: "Request not found" }, { status: 404 })

  const finalAmount = amount !== undefined ? Number(amount) : req.requested_amount
  const originalMessage = req.message ? req.message.split("\n\n---ADMIN_NOTE---")[0] : ""
  const finalMessage = admin_note ? `${originalMessage}\n\n---ADMIN_NOTE---\n${admin_note}` : req.message

  if (action === "edit") {
    if (req.status !== "fulfilled" && req.status !== "approved") {
      return NextResponse.json({ error: "Only approved requests can be edited" }, { status: 400 })
    }

    const amountDiff = finalAmount - req.requested_amount

    // Update the request
    await supabaseAdmin.from("client_credit_requests").update({
      requested_amount: finalAmount,
      message: finalMessage,
    }).eq("id", request_id)

    // If amount changed, adjust the client's credits
    if (amountDiff !== 0) {
      const { data: existing } = await supabaseAdmin
        .from("client_credits")
        .select("profile_unlock_credits, job_post_credits")
        .eq("client_id", req.client_id)
        .single()

      const isProfileUnlock = req.request_type === "profile_unlocks" || req.request_type === "profile_unlock"
      const isJobPost = req.request_type === "job_posts" || req.request_type === "job_post"

      if (existing) {
        await supabaseAdmin.from("client_credits").update({
          profile_unlock_credits: isProfileUnlock
            ? (existing.profile_unlock_credits || 0) + amountDiff
            : (existing.profile_unlock_credits || 0),
          job_post_credits: isJobPost
            ? (existing.job_post_credits || 0) + amountDiff
            : (existing.job_post_credits || 0),
          updated_at: new Date().toISOString(),
        }).eq("client_id", req.client_id)
      }

      // Log transaction
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

  // Mark as processed
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

    const isProfileUnlock = req.request_type === "profile_unlocks" || req.request_type === "profile_unlock"
    const isJobPost = req.request_type === "job_posts" || req.request_type === "job_post"

    if (existing) {
      await supabaseAdmin.from("client_credits").update({
        profile_unlock_credits: isProfileUnlock
          ? (existing.profile_unlock_credits || 0) + finalAmount
          : (existing.profile_unlock_credits || 0),
        job_post_credits: isJobPost
          ? (existing.job_post_credits || 0) + finalAmount
          : (existing.job_post_credits || 0),
        updated_at: new Date().toISOString(),
      }).eq("client_id", req.client_id)
    } else {
      await supabaseAdmin.from("client_credits").insert({
        client_id: req.client_id,
        profile_unlock_credits: isProfileUnlock ? finalAmount : 0,
        job_post_credits: isJobPost ? finalAmount : 0,
      })
    }

    // Log transaction
    await supabaseAdmin.from("client_credit_transactions").insert({
      client_id: req.client_id,
      type: "admin_add",
      amount: finalAmount,
      note: `Admin approved — ${req.request_type} × ${finalAmount} (request #${request_id})${admin_note ? ' - Note: ' + admin_note : ''}`,
    })
  }

  return NextResponse.json({ success: true })
}
