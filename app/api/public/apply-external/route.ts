import { NextRequest, NextResponse } from "next/server"
import { supabase, supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const token = formData.get("token") as string
    const jobId = formData.get("jobId") as string
    const name = formData.get("name") as string
    const email = formData.get("email") as string
    const phone = formData.get("phone") as string
    const resume = formData.get("resume") as File

    if (!token || !jobId || !name || !email) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      )
    }

    // Validate the token
    const { data: outreachMessage, error: tokenError } = await supabase
      .from("outreach_messages")
      .select("*")
      .eq("job_id", jobId)
      .ilike("unique_link", `%token=${token}%`)
      .maybeSingle()

    if (tokenError || !outreachMessage) {
      return NextResponse.json(
        { error: "Invalid or expired application link" },
        { status: 400 }
      )
    }

    // Check if already applied
    const { data: existingApplication } = await supabase
      .from("applications")
      .select("id")
      .eq("job_id", jobId)
      .eq("candidate_id", outreachMessage.candidate_id)
      .single()

    if (existingApplication) {
      return NextResponse.json(
        { error: "You have already applied for this position" },
        { status: 409 }
      )
    }

    // Update outreach message status to opened
    await supabaseAdmin
      .from("outreach_messages")
      .update({
        status: "opened",
        opened_at: new Date().toISOString()
      })
      .eq("id", outreachMessage.id)

    // Create application record
    const { data: application, error: appError } = await supabaseAdmin
      .from("applications")
      .insert({
        job_id: jobId,
        candidate_id: outreachMessage.candidate_id,
        status: "applied",
        source: "external_outreach",
        applied_at: new Date().toISOString()
      })
      .select()
      .single()

    if (appError) {
      logger.error("Error creating application", appError)
      return NextResponse.json(
        { error: "Failed to submit application" },
        { status: 500 }
      )
    }

    // Update job outreach responded count
    const { data: job } = await supabaseAdmin
      .from("jobs")
      .select("outreach_responded_count")
      .eq("id", jobId)
      .single()

    if (job) {
      await supabaseAdmin
        .from("jobs")
        .update({
          outreach_responded_count: (job.outreach_responded_count || 0) + 1,
          updated_at: new Date().toISOString()
        })
        .eq("id", jobId)
    }

    logger.info(`External application submitted via outreach`, {
      jobId,
      candidateId: outreachMessage.candidate_id,
      token
    })

    return NextResponse.json({
      success: true,
      message: "Application submitted successfully",
      application_id: application.id
    })

  } catch (error: any) {
    logger.error("Error in external application", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const token = searchParams.get("token")
    const jobId = searchParams.get("jobId")

    if (!token || !jobId) {
      return NextResponse.json(
        { error: "Missing token or job ID" },
        { status: 400 }
      )
    }

    // Validate the token
    const { data: outreachMessage, error } = await supabase
      .from("outreach_messages")
      .select(`
        *,
        jobs:job_id (title, description, requirements, client_name),
        candidates:candidate_id (name, email)
      `)
      .eq("job_id", jobId)
      .ilike("unique_link", `%token=${token}%`)
      .maybeSingle()

    if (error || !outreachMessage) {
      return NextResponse.json(
        { error: "Invalid or expired application link" },
        { status: 400 }
      )
    }

    // Check if already applied
    const { data: existingApplication } = await supabase
      .from("applications")
      .select("id")
      .eq("job_id", jobId)
      .eq("candidate_id", outreachMessage.candidate_id)
      .single()

    if (existingApplication) {
      return NextResponse.json(
        { error: "You have already applied for this position" },
        { status: 409 }
      )
    }

    return NextResponse.json({
      valid: true,
      job: outreachMessage.jobs,
      candidate: outreachMessage.candidates
    })

  } catch (error: any) {
    logger.error("Error validating external application link", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
