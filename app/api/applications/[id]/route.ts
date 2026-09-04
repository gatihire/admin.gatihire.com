import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { sendRejectionEmail } from "@/lib/mailer"
import { logCandidateActivity } from "@/lib/activity-logger"

export async function PUT(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  try {
    const params = await props.params
    const { id } = params
    const body = await request.json()
    const { status, notes, origin } = body

    // Fetch current application to check if status is changing to rejected
    const { data: currentApp, error: fetchError } = await supabaseAdmin
      .from("applications")
      .select(`
        id,
        status,
        origin,
        source,
        job_id,
        candidate_id,
        candidates:candidate_id (name, email),
        jobs:job_id (title, client_name)
      `)
      .eq("id", id)
      .single()

    if (fetchError || !currentApp) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }

    const isRejecting = status === "rejected" && currentApp.status !== "rejected"
    const shouldSendRejectionEmail = isRejecting && (
      currentApp.origin === "inbound" ||
      currentApp.source === "board-app"
    )

    const patch: Record<string, unknown> = {}
    if (status !== undefined) patch.status = status
    if (notes !== undefined) patch.notes = notes
    if (origin !== undefined) patch.origin = origin
    patch.updated_at = new Date().toISOString()

    const { data, error } = await supabaseAdmin
      .from("applications")
      .update(patch)
      .eq("id", id)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Log stage changed event if status actually changed
    if (status && currentApp.status !== status) {
      logCandidateActivity({
        jobId: currentApp.job_id,
        candidateId: currentApp.candidate_id,
        applicationId: id,
        eventType: "stage_changed",
        eventData: { from: currentApp.status, to: status },
        actor: "hr",
      })
    }

    // Send rejection email for inbound/board-app candidates
    if (shouldSendRejectionEmail && data) {
      const candidate = (data as any).candidates
      const job = (data as any).jobs
      const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || "noreply@gatihire.com"

      try {
        await sendRejectionEmail({
          to: candidate?.email || "",
          from: fromEmail,
          subject: `Update on your application ${job?.title ? `for ${job.title}` : ""}`,
          candidateName: candidate?.name,
          jobTitle: job?.title,
          companyName: job?.client_name,
        })
      } catch (emailErr) {
        console.error("Failed to send rejection email:", emailErr)
      }
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error("Update application error:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
