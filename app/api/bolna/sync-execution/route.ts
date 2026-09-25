import { NextRequest, NextResponse } from "next/server"
export const runtime = "nodejs"

import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { BOLNA_TERMINAL_STATUSES } from "@/lib/bolna"
import {
  resolveSyncTarget,
  persistBolnaExecutionId,
  handleCompletedExecution,
  handleFailedExecution,
} from "@/lib/bolna-execution"

// Manually re-sync a Bolna execution into the DB. Used when a terminal webhook
// never arrived (or failed) so a completed call stays stuck as "calling" in the UI.
//  GET  ...?executionId=<id>&sync=1        -> resolve + apply (one-click recovery)
//  GET  ...?phone=<dial>&sync=1            -> resolve by phone
//  GET  ...?email=<address>&sync=1         -> resolve by candidate email
//  GET  ... (no sync=1)                    -> dry-run: report what would happen
//  POST { executionId }                    -> apply (programmatic)

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const executionId = request.nextUrl.searchParams.get("executionId") || ""
  const phone = request.nextUrl.searchParams.get("phone") || ""
  const email = request.nextUrl.searchParams.get("email") || ""
  const shouldSync = request.nextUrl.searchParams.get("sync") === "1"

  if (!executionId && !phone && !email) {
    return NextResponse.json({
      error: "Provide executionId, phone, or email",
      usage: "?executionId=<id>[&sync=1] | ?phone=<dial>[&sync=1] | ?email=<addr>[&sync=1]",
    }, { status: 400 })
  }

  if (request.nextUrl.searchParams.get("debug") === "1") {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: recent } = await supabaseAdmin
      .from("phone_screening_participants")
      .select(`
        id, status, bolna_execution_id, call_attempts, last_attempt_at,
        candidates: candidate_id (id, name, phone, phone_e164, email)
      `)
      .in("status", ["calling", "in_progress", "failed", "failed_partial", "unreachable"])
      .gte("created_at", since)
      .order("last_attempt_at", { ascending: false })
      .limit(30)
    return NextResponse.json({ ok: true, debug: recent || [] })
  }

  const { execution, participant } = await resolveSyncTarget({ executionId, phone, email })

  if (!participant) {
    return NextResponse.json({
      error: "No matching participant found",
      diagnostics: {
        executionFetched: !!execution,
        executionId: execution?.id || executionId || null,
        executionStatus: execution?.status || null,
        executionDialedNumber: execution?.telephony_data?.to_number || (execution as any)?.user_number || null,
        contextParticipantId: execution?.context_details?.participant_id || null,
      },
    }, { status: 404 })
  }

  const { data: current } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("id, status, bolna_execution_id, bolna_status, verdict_json, recording_url")
    .eq("id", participant.id)
    .maybeSingle()

  const terminal = execution ? BOLNA_TERMINAL_STATUSES.has(execution.status || "") : null
  const alreadySynced =
    current?.status === "completed" && (current.verdict_json || current.recording_url)

  if (!shouldSync || !execution || !terminal) {
    return NextResponse.json({
      ok: true,
      executionId: execution?.id || executionId || null,
      bolnaStatus: execution?.status || null,
      terminal,
      participantId: participant.id,
      current: current || null,
      wouldSync: !!(execution && terminal && !alreadySynced),
      note: !execution
        ? "Execution could not be fetched from Bolna (yet). Try again or pass executionId."
        : !terminal
          ? `Not terminal yet (${execution.status}) — nothing to sync`
          : undefined,
    })
  }

  if (alreadySynced) {
    return NextResponse.json({ ok: true, alreadySynced: true, participant: current })
  }

  if (execution.id) await persistBolnaExecutionId(participant.id, execution.id)

  logger.info("Syncing Bolna execution (GET)", {
    executionId: execution.id,
    participantId: participant.id,
    status: execution.status,
  })

  if (execution.status === "completed") {
    await handleCompletedExecution(participant.id, execution)
  } else {
    await handleFailedExecution(participant as any, execution)
  }

  const { data: after } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("id, status, bolna_status, bolna_execution_id, verdict_json, recording_url, ai_score, ai_recommendation, transcript_raw")
    .eq("id", participant.id)
    .maybeSingle()

  return NextResponse.json({ ok: true, alreadySynced: false, synced: after })
}

export async function POST(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.edit")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  let body: any = {}
  try {
    body = await request.json()
  } catch { /* ignore */ }
  const executionId = String(body?.executionId || "").trim()
  if (!executionId) return NextResponse.json({ error: "executionId is required" }, { status: 400 })

  const { execution, participant } = await resolveSyncTarget({ executionId })
  if (!execution) {
    return NextResponse.json({ error: "Execution not found on Bolna" }, { status: 404 })
  }
  if (!participant) {
    return NextResponse.json({ error: "No matching participant found" }, { status: 404 })
  }

  const status = execution.status || ""
  if (!BOLNA_TERMINAL_STATUSES.has(status)) {
    return NextResponse.json({ error: `Execution not terminal (status="${status}")` }, { status: 409 })
  }

  const { data: current } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("id, status, bolna_execution_id, verdict_json, recording_url")
    .eq("id", participant.id)
    .maybeSingle()

  if (current?.status === "completed" && (current.verdict_json || current.recording_url)) {
    return NextResponse.json({ ok: true, alreadySynced: true, participant: current })
  }

  if (execution.id) await persistBolnaExecutionId(participant.id, execution.id)

  logger.info("Syncing Bolna execution (POST)", { executionId, participantId: participant.id, status })

  if (status === "completed") {
    await handleCompletedExecution(participant.id, execution)
  } else {
    await handleFailedExecution(participant as any, execution)
  }

  const { data: after } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("id, status, bolna_status, bolna_execution_id, verdict_json, recording_url, ai_score, ai_recommendation, transcript_raw")
    .eq("id", participant.id)
    .maybeSingle()

  return NextResponse.json({ ok: true, alreadySynced: false, synced: after })
}