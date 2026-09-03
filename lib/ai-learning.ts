import { GoogleGenerativeAI } from "@google/generative-ai"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "")
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash"

const REQUIRED_ANSWER_KEYS = [
  "current_salary",
  "expected_salary",
  "reason_for_switching",
  "notice_period",
  "current_role_summary",
  "skills_assessment",
  "availability",
]

const SHORT_CALL_SECONDS = 60
const MIN_CANDIDATE_TURNS = 1

interface TranscriptSegment {
  speaker: string
  text: string
  start_time_sec?: number | null
  end_time_sec?: number | null
}

interface AnswerRow {
  question_key: string
  answer_text: string | null
  sentiment?: string | null
}

interface CallData {
  participantId: string
  jobId: string | null
  callUuid: string | null
  durationSeconds: number | null
  transcript: TranscriptSegment[]
  answers: AnswerRow[]
}

export interface QualityMetrics {
  duration_seconds: number | null
  agent_turns: number
  candidate_turns: number
  missing_answers: string[]
  avg_candidate_answer_words: number | null
  negative_sentiment_count: number
  aborted: boolean
  issues_count: number
  quality_score: number | null
}

export interface QualityResult {
  participantId: string
  evaluated: boolean
  metrics: QualityMetrics | null
}

async function runGeminiJson(prompt: string): Promise<any> {
  if (!process.env.GEMINI_API_KEY) return null
  const model = genAI.getGenerativeModel({ model: MODEL })
  const result = await model.generateContent(prompt)
  const text = result.response.text().trim()
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/, "").trim()
  return JSON.parse(cleaned)
}

async function fetchCallData(participantId: string): Promise<CallData | null> {
  const { data: participant } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("id, job_id, plivo_call_uuid, call_duration_seconds")
    .eq("id", participantId)
    .single()

  if (!participant) return null

  const { data: transcript } = await supabaseAdmin
    .from("call_transcripts")
    .select("speaker, text, start_time_sec, end_time_sec")
    .eq("participant_id", participantId)
    .order("start_time_sec", { ascending: true })

  const { data: answers } = await supabaseAdmin
    .from("screening_answers")
    .select("question_key, answer_text, sentiment")
    .eq("participant_id", participantId)

  return {
    participantId,
    jobId: participant.job_id,
    callUuid: participant.plivo_call_uuid,
    durationSeconds: participant.call_duration_seconds,
    transcript: (transcript || []) as TranscriptSegment[],
    answers: (answers || []) as AnswerRow[],
  }
}

function computeRuleBasedMetrics(call: CallData): QualityMetrics {
  const agentTurns = call.transcript.filter((s) => s.speaker === "ai").length
  const candidateTurns = call.transcript.filter((s) => s.speaker === "candidate").length

  const candidateTexts = call.transcript
    .filter((s) => s.speaker === "candidate")
    .map((s) => s.text || "")

  const totalWords = candidateTexts.reduce((sum, t) => sum + t.trim().split(/\s+/).filter(Boolean).length, 0)
  const avgWords = candidateTurns > 0 ? totalWords / candidateTurns : null

  const missingAnswers = REQUIRED_ANSWER_KEYS.filter(
    (key) => !call.answers.find((a) => a.question_key === key && (a.answer_text || "").trim())
  )

  const negativeSentimentCount = call.answers.filter((a) => a.sentiment === "negative").length
  const aborted = (call.durationSeconds ?? 0) < SHORT_CALL_SECONDS || candidateTurns <= MIN_CANDIDATE_TURNS

  const issuesCount =
    missingAnswers.length +
    (aborted ? 1 : 0) +
    (candidateTurns === 0 ? 1 : 0) +
    negativeSentimentCount

  const qualityScore = Math.max(0, Math.min(10, 10 - issuesCount))

  return {
    duration_seconds: call.durationSeconds,
    agent_turns: agentTurns,
    candidate_turns: candidateTurns,
    missing_answers: missingAnswers,
    avg_candidate_answer_words: avgWords ? Number(avgWords.toFixed(1)) : null,
    negative_sentiment_count: negativeSentimentCount,
    aborted,
    issues_count: issuesCount,
    quality_score: Number(qualityScore.toFixed(2)),
  }
}

interface ClassifiedIssue {
  category: string
  severity: "low" | "medium" | "high"
  evidence: string
  lesson: string
}

async function classifyCallWithAi(call: CallData): Promise<{
  issues: ClassifiedIssue[]
  positives: { category: string; evidence: string }[]
}> {
  const transcriptText = call.transcript
    .map((s) => `${s.speaker.toUpperCase()}: ${s.text}`)
    .join("\n")
    .slice(0, 12000)

  const answersText = call.answers
    .map((a) => `${a.question_key}: ${a.answer_text || "(no answer)"}`)
    .join("\n")

  const prompt = `You are a quality analyst for an AI recruiter that conducts first-round phone screenings.
Analyze the call below and produce a JSON object with:
- issues: array of { category, severity ("low"|"medium"|"high"), evidence (short quote), lesson (one sentence on how the agent should behave next time) }
- positives: array of { category, evidence }

Look for: candidate confusion or requests to repeat, mishandled salary/notice-period answers, off-topic questions the agent failed to handle, abrupt endings, missing key answers, the agent revealing scoring, dead air or interruptions, and any recurring pattern worth learning from.
If a conversation is healthy, return empty arrays.

TRANSCRIPT:
${transcriptText}

STRUCTURED ANSWERS:
${answersText}

Return ONLY valid JSON.`

  const data = await runGeminiJson(prompt)
  if (!data || !Array.isArray(data.issues)) {
    return { issues: [], positives: [] }
  }
  return {
    issues: data.issues as ClassifiedIssue[],
    positives: Array.isArray(data.positives) ? data.positives : [],
  }
}

export async function evaluateCallQuality(participantId: string): Promise<QualityResult> {
  try {
    const { data: existing } = await supabaseAdmin
      .from("call_quality_metrics")
      .select("id")
      .eq("participant_id", participantId)
      .maybeSingle()

    if (existing) {
      return { participantId, evaluated: false, metrics: null }
    }

    const call = await fetchCallData(participantId)
    if (!call || call.transcript.length === 0) {
      return { participantId, evaluated: false, metrics: null }
    }

    const metrics = computeRuleBasedMetrics(call)

    let issues: ClassifiedIssue[] = []
    let positives: { category: string; evidence: string }[] = []

    try {
      const aiResult = await classifyCallWithAi(call)
      issues = aiResult.issues
      positives = aiResult.positives
    } catch (err: any) {
      logger.warn("AI call classification failed", { participantId, error: err.message })
    }

    for (const key of metrics.missing_answers) {
      if (!issues.some((i) => i.category === "missing_answer")) {
        issues.push({
          category: "missing_answer",
          severity: "medium",
          evidence: key,
          lesson: `Ensure the ${key.replace(/_/g, " ")} question is asked clearly and gently re-asked if the candidate dodges it.`,
        })
      }
    }

    if (metrics.aborted) {
      issues.push({
        category: "aborted_call",
        severity: "high",
        evidence: `${metrics.duration_seconds}s, ${metrics.candidate_turns} candidate turns`,
        lesson: "Confirm the candidate is free and comfortable at the start; offer to reschedule before diving into questions.",
      })
    }

    const eventRows = [
      ...issues.map((i) => ({
        participant_id: participantId,
        job_id: call.jobId,
        call_uuid: call.callUuid,
        event_type: "quality_issue",
        issue_category: i.category,
        severity: i.severity,
        evidence_text: i.evidence?.slice(0, 500),
        lesson: i.lesson,
      })),
      ...positives.map((p) => ({
        participant_id: participantId,
        job_id: call.jobId,
        call_uuid: call.callUuid,
        event_type: "positive_pattern",
        issue_category: p.category,
        severity: null,
        evidence_text: p.evidence?.slice(0, 500),
      })),
    ]

    if (eventRows.length > 0) {
      await supabaseAdmin.from("ai_learning_events").insert(eventRows)
    }

    await supabaseAdmin.from("call_quality_metrics").insert({
      participant_id: participantId,
      job_id: call.jobId,
      duration_seconds: metrics.duration_seconds,
      agent_turns: metrics.agent_turns,
      candidate_turns: metrics.candidate_turns,
      missing_answers: metrics.missing_answers,
      avg_candidate_answer_words: metrics.avg_candidate_answer_words,
      negative_sentiment_count: metrics.negative_sentiment_count,
      aborted: metrics.aborted,
      issues_count: metrics.issues_count,
      quality_score: metrics.quality_score,
    })

    logger.info(`Call quality evaluated`, { participantId, quality_score: metrics.quality_score, issues: eventRows.length })
    return { participantId, evaluated: true, metrics }
  } catch (err: any) {
    logger.error("Call quality evaluation failed", { participantId, error: err.message })
    return { participantId, evaluated: false, metrics: null }
  }
}

interface PlaybookSynthesis {
  title: string
  summary: string
  prompt_override: string
  rules: { category: string; rule: string }[]
  qa_examples: { question: string; answer: string }[]
}

function buildRuleBasedPlaybook(stats: any): PlaybookSynthesis {
  const topIssues = stats.topIssues || []
  const rules = topIssues.map((t: any) => ({
    category: t.category,
    rule: `Watch for "${t.category}" during calls (${t.count} times this period): ${t.exampleLesson || "address it clearly and move on."}`,
  }))
  return {
    title: "Weekly Playbook (rule-based)",
    summary: `Automated synthesis from ${stats.callsReviewed} reviewed calls.`,
    prompt_override: rules.map((r: any) => `- ${r.rule}`).join("\n"),
    rules,
    qa_examples: [],
  }
}

async function synthesizePlaybookWithAi(periodStart: string, periodEnd: string, stats: any, sampleTranscripts: string[]): Promise<PlaybookSynthesis> {
  const transcriptSample = sampleTranscripts.join("\n\n---\n\n").slice(0, 16000)

  const prompt = `You are a senior HR consultant who trains AI recruitment agents. Review the weekly call data below and write an updated "generalist HR" playbook.

THIS WEEK'S STATS:
${JSON.stringify(stats, null, 2)}

SAMPLE TRANSCRIPTS:
${transcriptSample}

Produce JSON:
{
  "title": "short title",
  "summary": "2-3 sentence summary of how the agent performed and what changed",
  "prompt_override": "a prose block (max ~200 words) to append to the AI agent's system prompt this week, turning recurring mistakes into concrete instructions",
  "rules": [{ "category": "e.g. salary_handling", "rule": "specific reusable instruction" }],
  "qa_examples": [{ "question": "real question candidates asked", "answer": "best-practice answer" }]
}

Rules must be generalizable across jobs (any role, any client) — not job-specific. Return ONLY valid JSON.`

  const data = await runGeminiJson(prompt)
  if (!data || typeof data !== "object") {
    return buildRuleBasedPlaybook(stats)
  }
  return {
    title: data.title || "Weekly Playbook",
    summary: data.summary || "",
    prompt_override: data.prompt_override || "",
    rules: Array.isArray(data.rules) ? data.rules : [],
    qa_examples: Array.isArray(data.qa_examples) ? data.qa_examples : [],
  }
}

export async function runWeeklyReview(opts?: { dryRun?: boolean }): Promise<any> {
  const dryRun = Boolean(opts?.dryRun)

  const now = new Date()

  const { data: latest } = await supabaseAdmin
    .from("ai_playbook_versions")
    .select("id, version, period_end")
    .eq("status", "active")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()

  const periodEnd = now.toISOString()
  const periodStart = latest?.period_end ? new Date(latest.period_end).toISOString() : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data: metrics } = await supabaseAdmin
    .from("call_quality_metrics")
    .select("participant_id, quality_score, aborted, issues_count, missing_answers, duration_seconds")
    .gte("created_at", periodStart)
    .lte("created_at", periodEnd)

  const { data: events } = await supabaseAdmin
    .from("ai_learning_events")
    .select("issue_category, severity, lesson, evidence_text, created_at")
    .eq("event_type", "quality_issue")
    .gte("created_at", periodStart)
    .lte("created_at", periodEnd)

  const callsReviewed = metrics?.length || 0
  const issueCount = events?.length || 0

  const byCategory = new Map<string, { count: number; exampleLesson: string }>()
  for (const e of events || []) {
    const cat = (e as any).issue_category || "unknown"
    const cur = byCategory.get(cat) || { count: 0, exampleLesson: "" }
    cur.count += 1
    if (!cur.exampleLesson && (e as any).lesson) cur.exampleLesson = (e as any).lesson
    byCategory.set(cat, cur)
  }

  const topIssues = [...byCategory.entries()]
    .map(([category, v]) => ({ category, count: v.count, exampleLesson: v.exampleLesson }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)

  const abortedCount = metrics?.filter((m: any) => m.aborted).length || 0
  const avgQuality = callsReviewed > 0
    ? Number((metrics!.reduce((s: number, m: any) => s + (m.quality_score || 0), 0) / callsReviewed).toFixed(2))
    : null

  const stats = {
    period_start: periodStart,
    period_end: periodEnd,
    calls_reviewed: callsReviewed,
    issues_found: issueCount,
    aborted_calls: abortedCount,
    avg_quality_score: avgQuality,
    top_issues: topIssues,
  }

  if (dryRun || callsReviewed === 0) {
    return { dryRun, callsReviewed, stats, playbook: null }
  }

  const { data: participantIds } = await supabaseAdmin
    .from("call_quality_metrics")
    .select("participant_id")
    .gte("created_at", periodStart)
    .lte("created_at", periodEnd)
    .limit(3)

  const sampleTranscripts: string[] = []
  if (participantIds && participantIds.length > 0) {
    const { data: rows } = await supabaseAdmin
      .from("call_transcripts")
      .select("speaker, text")
      .in("participant_id", participantIds.map((p: any) => p.participant_id))
      .order("start_time_sec", { ascending: true })

    const byParticipant = new Map<string, string[]>()
    for (const r of rows || []) {
      const pid = (r as any).participant_id
      const arr = byParticipant.get(pid) || []
      arr.push(`${(r as any).speaker.toUpperCase()}: ${(r as any).text}`)
      byParticipant.set(pid, arr)
    }
    for (const lines of byParticipant.values()) {
      sampleTranscripts.push(lines.join("\n").slice(0, 6000))
    }
  }

  let playbook: PlaybookSynthesis
  try {
    playbook = await synthesizePlaybookWithAi(periodStart, periodEnd, stats, sampleTranscripts)
  } catch (err: any) {
    logger.warn("Playbook AI synthesis failed, using rule-based fallback", { error: err.message })
    playbook = buildRuleBasedPlaybook(stats)
  }

  const nextVersion = (latest?.version || 0) + 1

  const { data: inserted } = await supabaseAdmin
    .from("ai_playbook_versions")
    .insert({
      version: nextVersion,
      status: "active",
      title: playbook.title,
      summary: playbook.summary,
      prompt_override: playbook.prompt_override,
      rules: playbook.rules,
      qa_examples: playbook.qa_examples,
      stats,
      period_start: periodStart,
      period_end: periodEnd,
    })
    .select()
    .single()

  if (latest?.version) {
    await supabaseAdmin.from("ai_playbook_versions").update({ status: "superseded" }).eq("id", latest.id)
  }

  supabaseAdmin
    .from("analytics_events")
    .insert({
      event_name: "ai.learning.weekly_review",
      entity_type: "ai_playbook_versions",
      entity_id: inserted?.id ?? null,
      metadata: { version: nextVersion, calls_reviewed: callsReviewed, issues_found: issueCount },
    })
    .then(() => {})

  logger.info("Weekly playbook generated", { version: nextVersion, calls_reviewed: callsReviewed, issues: issueCount })
  return { dryRun: false, stats, playbook: { version: nextVersion, ...playbook } }
}

export async function extractFineTuneRows(opts?: { limit?: number }): Promise<number> {
  const limit = opts?.limit || 500

  const { data: rows } = await supabaseAdmin
    .from("call_transcripts")
    .select("participant_id, speaker, text")
    .not("text", "is", null)
    .order("start_time_sec", { ascending: true })
    .limit(limit * 4)

  if (!rows || rows.length === 0) return 0

  const grouped = new Map<string, { participant_id: string; lines: { role: string; content: string }[] }>()
  for (const r of rows as any[]) {
    const existingGroup = grouped.get(r.participant_id)
    const g = existingGroup || { participant_id: r.participant_id, lines: [] as { role: string; content: string }[] }
    const role = r.speaker === "ai" ? "assistant" : "user"
    if (g.lines.length === 0 || g.lines[g.lines.length - 1].role !== role) {
      g.lines.push({ role, content: String(r.text).trim() })
    } else {
      g.lines[g.lines.length - 1].content += "\n" + String(r.text).trim()
    }
    grouped.set(r.participant_id, g)
  }

  const { data: existing } = await supabaseAdmin
    .from("ai_fine_tune_rows")
    .select("participant_id")
    .limit(1)

  const seen = new Set((existing || []).map((e: any) => e.participant_id))

  const insertRows: { participant_id: string; role: string; content: string; metadata: any }[] = []
  for (const g of grouped.values()) {
    if (seen.has(g.participant_id)) continue
    for (const line of g.lines) {
      insertRows.push({
        participant_id: g.participant_id,
        role: line.role,
        content: line.content.slice(0, 8000),
        metadata: {},
      })
    }
    if (insertRows.length >= limit * 3) break
  }

  if (insertRows.length > 0) {
    await supabaseAdmin.from("ai_fine_tune_rows").insert(insertRows)
  }

  logger.info("Fine-tune rows extracted", { rows: insertRows.length })
  return insertRows.length
}
