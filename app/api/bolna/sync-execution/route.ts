import { NextRequest, NextResponse } from "next/server"
export const runtime = "nodejs"

import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { getBolnaExecution, BOLNA_TERMINAL_STATUSES, type BolnaExecution } from "@/lib/bolna"
import { toDial } from "@/lib/phone"
import {
  findParticipant,
  handleCompletedExecution,
  handleFailedExecution,
} from "@/lib/bolna-execution"

// Manually re-sync a Bolna execution into the DB. Used when a terminal webhook
// never arrived (or failed) so a completed call stays stuck as "calling" in the UI.
//  GET  ...?executionId=<id>                -> dry-run status, no writes
//  GET  ...?executionId=<id>&sync=1         -> dry-run then apply (one-click recovery)
//  GET  ...?phone=<dial>&sync=1             -> resolve by phone instead of execution id
//  POST { executionId }                     -> apply (programmatic)

async function resolveParticipant(executionId: string, phone: string) {
  if (executionId) {
    const execution = await getBolnaExecution(executionId)
    if (execution) {
      const participant = await findParticipant(execution as unknown as BolnaExecution)
      if (participant) return { execution, participant }
    }
  }
  if (phone) {
    const dial = toDial(phone)
    if (dial) {
      const { data: candidate } = await supabaseAdmin
        .from("candidates")
        .select("id")
        .eq("phone_e164", toDialWithPlus(dial))
        .limit(1)
        .maybeSingle()
      const candidateId = candidate?.id || null
      const { data: participant } = await supabaseAdmin
        .from("phone_screening_participants")
        .select(
          `id,
           candidates: candidate_id (id, name, phone),
           jobs: job_id (id, title, client_name)`
        )
        .in(candidateId ? "candidate_id" : "id", candidateId ? [candidateId] : [])
        .order("last_attempt_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (participant) {
        // phone_e164 may not be backfilled; fall back to scanning by stored phone.
        return { execution: null, participant: participant as any }
      }
    }
  }
  return null
}

function toDialWithPlus(dial: string): string {
  return `+${dial}`
}

const isTerminal = (s: string) => BOLNA_TERMINAL_STATUSES.has(s)

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const executionId = request.nextUrl.searchParams.get("executionId") || ""
  const phone = request.nextUrl.searchParams.get("phone") || ""
  const shouldSync = request.nextUrl.searchParams.get("sync") === "1"

  if (!executionId && !phone) {
    return NextResponse.json({ error: "Provide executionId or phone" }, { status: 400 })
  }

  const resolved = await resolveParticipant(executionId, phone)
  const execution = resolved?.execution || null
  const participant = resolved?.participant || null

  if (!participant) {
    return NextResponse.json({ error: "No matching participant found" }, { status: 404 })
  }

  const { data: current } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("id, status, bolna_status, verdict_json, recording_url")
    .eq("id", participant.id)
    .maybeSingle()

  const terminal = execution ? isTerminal(execution.status || "") : null
  const alreadySynced =
    current?.status === "completed" && (current.verdict_json || current.recording_url)

  if (!shouldSync || !execution || !terminal) {
    return NextResponse.json({
      ok: true,
      executionId: executionId || execution?.id || null,
      bolnaStatus: execution?.status || null,
      terminal,
      participantId: participant.id,
      current: current || null,
      wouldSync: !!(execution && terminal && !alreadySynced),
      note: shouldSync && !terminal ? "Not terminal yet — nothing to sync" : undefined,
    })
  }

  if (alreadySynced) {
    return NextResponse.json({ ok: true, alreadySynced: true, participant: current })
  }

  logger.info("Syncing Bolna execution (GET sync=1)", {
    executionId: execution.id,
    participantId: participant.id,
    status: execution.status,
  })

  if (execution.status === "completed") {
    await handleCompletedExecution(participant.id, execution as unknown as BolnaExecution)
  } else {
    await handleFailedExecution(participant as any, execution as unknown as BolnaExecution)
  }

  const { data: after } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("id, status, bolna_status, verdict_json, recording_url, ai_score, ai_recommendation, transcript_raw")
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

  const execution = await getBolnaExecution(executionId)
  if (!execution) return NextResponse.json({ error: "Execution not found on Bolna" }, { status: 404 })

  const status = execution.status || ""
  if (!isTerminal(status)) {
    return NextResponse.json({ error: `Execution not terminal (status="${status}")` }, { status: 409 })
  }

  const participant = await findParticipant(execution as unknown as BolnaExecution)
  if (!participant) {
    return NextResponse.json({ error: "No matching participant found" }, { status: 404 })
  }

  const { data: current } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("id, status, bolna_status, verdict_json, recording_url")
    .eq("id", participant.id)
    .maybeSingle()

  if (current?.status === "completed" && (current.verdict_json || current.recording_url)) {
    return NextResponse.json({ ok: true, alreadySynced: true, participant: current })
  }

  logger.info("Syncing Bolna execution (POST)", { executionId, participantId: participant.id, status })

  if (status === "completed") {
    await handleCompletedExecution(participant.id, execution as unknown as BolnaExecution)
  } else {
    await handleFailedExecution(participant, execution as unknown as BolnaExecution)
  }

  const { data: after } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("id, status, bolna_status, verdict_json, recording_url, ai_score, ai_recommendation, transcript_raw")
    .eq("id", participant.id)
    .maybeSingle()

  return NextResponse.json({ ok: true, alreadySynced: false, synced: after })
}