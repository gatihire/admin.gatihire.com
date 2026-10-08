// Backfill missing ai_score / ai_recommendation for completed screening calls.
//
// Root cause of the misses: Bolna appends a `{"General":{"Call Summary":…}}`
// metadata blob to transcripts — valid JSON, but not a verdict — and the old
// parser accepted it as one, so most completed calls stored no score. This
// script re-derives a verdict for every completed participant that still lacks
// one:
//   1. from stored verdict_json if it is actually verdict-shaped
//   2. else from the transcript via the (now strict) extraction
//   3. else via the Gemini enrichment prompt used in production
// Writes only the columns that are missing. Requires .env.local with the
// working Supabase keys and a GEMINI_API_KEY.
//
// Run from the repo root: node scripts/backfill-screening-verdicts.mjs

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const env = {}
for (const line of fs.readFileSync(path.join(root, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, "").trim()
}

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL || "https://dmnypjxbfbjegraylspt.supabase.co"
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || null
const svc = SERVICE_KEY || fs.readFileSync("/tmp/service_role.txt", "utf8").trim()
const GEMINI_KEY = env.GEMINI_API_KEY
const GEMINI_MODEL = env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview"

const R = (url, opts = {}) => {
  const headers = { apikey: svc, Authorization: `Bearer ${svc}`, ...(opts.headers || {}) }
  return fetch(`${SUPABASE_URL}${url}`, { ...opts, headers })
}
const q = encodeURIComponent

const VERDICT_KEYS = [
  "score", "recommendation", "next_round_ready", "verdict_explanation",
  "pluses", "minuses", "relocation_willing", "current_salary",
  "expected_salary", "salary_manipulation_risk", "salary_notes",
  "callback_requested", "callback_time", "callback_preference_text",
  "key_answers", "summary",
]
const looksLikeVerdict = (v) =>
  !!v && typeof v === "object" && !Array.isArray(v) && VERDICT_KEYS.some((k) => k in v)

const ALIAS = {
  pass: "advance", fail: "not_a_fit", review: "further_review",
  strong_fit: "advance", good_fit: "further_review",
  possible_fit: "further_review", not_fit: "not_a_fit",
  advance: "advance", further_review: "further_review", not_a_fit: "not_a_fit",
}
function normalize(v) {
  const raw = v || {}
  const rec = raw.recommendation ? ALIAS[String(raw.recommendation).toLowerCase()] : undefined
  const score = typeof raw.score === "number" ? Math.max(0, Math.min(10, Number(raw.score))) : undefined
  return {
    score: score ?? (rec === "advance" ? 8 : rec === "further_review" ? 6 : rec === "not_a_fit" ? 2 : raw.score),
    recommendation: rec ?? (score != null ? (score >= 8 ? "advance" : score >= 5 ? "further_review" : "not_a_fit") : raw.recommendation),
  }
}

function extractVerdict(transcript) {
  if (!transcript) return null
  const clean = transcript.replace(/```(?:json)?/gi, "").replace(/```/g, "")
  const attempts = []
  const match = clean.match(/\{[\s\S]*\}/)
  if (match) attempts.push(match[0])
  const first = clean.indexOf("{")
  const last = clean.lastIndexOf("}")
  if (first >= 0 && last > first) attempts.push(clean.slice(first, last + 1))
  for (const t of attempts) {
    try {
      const parsed = JSON.parse(t)
      if (looksLikeVerdict(parsed)) return parsed
    } catch { /* next */ }
  }
  return null
}

async function enrich(transcript, candidate, job) {
  if (!GEMINI_KEY || !transcript || transcript.trim().length < 50) return null
  const qa = transcript
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      const am = line.match(/^assistant:\s*(.*)$/i)
      const um = line.match(/^user:\s*(.*)$/i)
      if (am) return `AI: ${am[1].trim()}`
      if (um) return `Candidate: ${um[1].trim()}`
      return null
    })
    .filter(Boolean)
    .join("\n")

  const skills = Array.isArray(candidate?.technical_skills) ? candidate.technical_skills.join(", ") : ""
  const candBlock = [
    `- Name: ${candidate?.name || "Not specified"}`,
    `- Role: ${candidate?.current_role || "Not specified"}`,
    `- Company: ${candidate?.current_company || "Not specified"}`,
    `- Experience: ${candidate?.total_experience || "Not specified"} years`,
    `- Location: ${candidate?.location || "Not specified"}`,
    `- Skills: ${skills || "Not specified"}`,
    `- Resume: ${String(candidate?.resume_text || "").slice(0, 800) || "Not provided"}`,
  ].join("\n")
  const jobBlock = [
    `- Title: ${job?.title || "Not specified"}`,
    `- Company: ${job?.client_name || "Not specified"}`,
    `- Location: ${job?.city || job?.location || "Not specified"}`,
    `- Experience: ${job?.experience_min_years ?? "?"}–${job?.experience_max_years ?? "?"} years`,
    `- Salary: ${job?.salary_min || "?"}–${job?.salary_max || "?"} ${job?.salary_type || "monthly"}`,
  ].join("\n")

  const prompt = `You are a senior HR analyst reviewing an AI screening call transcript. Analyze the conversation and candidate profile against the job requirements.

Provide a detailed, actionable assessment.

Return ONLY a JSON object (no markdown, no commentary) with exactly this structure:
{
  "comprehensive_summary": "3-5 sentence summary of the call covering what was discussed, candidate's key responses, and overall impression",
  "fit_assessment": "Detailed paragraph on how well the candidate fits this specific role, referencing specific skills and experience from the transcript",
  "strengths": ["strength 1 backed by transcript evidence", "strength 2", "..."],
  "concerns": ["concern 1 with specific transcript reference", "concern 2", "..."],
  "salary_analysis": {
    "current": "what candidate stated as current salary",
    "expected": "what candidate stated as expected salary",
    "risk": "none/low/medium/high with explanation",
    "notes": "any red flags or observations about salary discussion"
  },
  "relocation_assessment": "Candidate's willingness to relocate/commute, as stated in the call",
  "recommended_next_steps": "Specific next action: advance to interview / schedule callback / reject, with reasoning",
  "interview_focus_areas": ["area 1 the next interviewer should probe deeper", "area 2", "..."],
  "overall_verdict": "strong_fit/good_fit/possible_fit/not_fit",
  "confidence_score": 0.85
}

RULES:
- Base EVERY claim on what was actually said in the transcript. Do not infer or fabricate.
- If the candidate declined to answer something, note it as "declined to share" not a guess.
- If the call was very short (under 60s), note that the assessment has limited confidence.
- Score: strong_fit (8-10), good_fit (6-7), possible_fit (4-5), not_fit (0-3).

Job:
${jobBlock}

Candidate:
${candBlock}

Call Transcript:
${qa}

JSON:`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  )
  const data = await res.json()
  if (!res.ok) {
    console.error("  Gemini error:", res.status, JSON.stringify(data).slice(0, 300))
    return null
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

// Bolna sometimes only stores its own metadata wrapper in ai_summary:
// {"General":{"Call Summary":{"subjective":"…"}}}. No score, and the results
// sheet has no summary to render. When present, the subjective field is the
// prose Bolna wrote for the call — surface it as the real ai_summary.
function blobSubjective(raw) {
  if (typeof raw !== "string" || !raw.trim().startsWith("{")) return null
  try {
    const j = JSON.parse(raw)
    const s = j?.General?.["Call Summary"]?.subjective
    return typeof s === "string" ? s : null
  } catch { return null }
}

async function main() {
  const url = `/rest/v1/phone_screening_participants?select=${q(
    "id,candidate_id,status,ai_score,ai_recommendation,ai_summary,transcript_raw,verdict_json,bolna_status,jobs:job_id(id,title,client_name,city,location,experience_min_years,experience_max_years,salary_min,salary_max,salary_type)"
  )}&status=eq.completed&limit=1000`

  const resp = await R(url)
  if (!resp.ok) { console.error("Fetch participants failed:", resp.status, await resp.text()); return }
  const rows = await resp.json()
  console.log("completed participants missing score/rec:", rows.length)

  let candidatesById = new Map()
  const candidateIds = [...new Set(rows.map((r) => r.candidate_id).filter(Boolean))]
  if (candidateIds.length) {
    const candRes = await R(`/rest/v1/candidates?select=${q("id,name,current_role,current_company,total_experience,location,technical_skills,resume_text")}&id=in.(${candidateIds.join(",")})`)
    if (!candRes.ok) { console.error("Fetch candidates failed:", candRes.status, await candRes.text()); return }
    candidatesById = new Map((await candRes.json()).map((c) => [c.id, c]))
  }

  let ok = 0, viaGemini = 0, viaStored = 0, failed = 0, skipped = 0
  for (const row of rows) {
    const pid = row.id

    const needScore = row.ai_score == null || row.ai_recommendation == null
    const staleBlob = blobSubjective(row.ai_summary)
    if (!needScore && !staleBlob) { skipped++; continue }

    let norm = null
    if (needScore) {
      if (looksLikeVerdict(row.verdict_json)) { norm = normalize(row.verdict_json); viaStored++ }
      if (!norm) {
        const extracted = extractVerdict(row.transcript_raw)
        if (extracted) { norm = normalize(extracted); viaStored++ }
      }
      if (!norm) {
        const enriched = await enrich(row.transcript_raw, candidatesById.get(row.candidate_id), row.jobs)
        if (enriched) {
          const ratingAlias = { strong_fit: "advance", good_fit: "further_review", possible_fit: "further_review", not_fit: "not_a_fit" }
          const recommendation = ratingAlias[enriched.overall_verdict] ?? "further_review"
          const score = { advance: 8, further_review: 6, not_a_fit: 2 }[recommendation]
          norm = { score, recommendation, summary: enriched.comprehensive_summary }
          viaGemini++
        }
      }
    }

    const patch = {}
    if (needScore && norm) {
      patch.ai_score = norm.score
      patch.ai_recommendation = norm.recommendation
    }
    if (staleBlob) patch.ai_summary = staleBlob

    if (!Object.keys(patch).length) {
      failed++
      console.log(`  ✗ ${pid.slice(0, 8)} — could not derive a score`)
      continue
    }

    const up = await R(`/rest/v1/phone_screening_participants?id=eq.${pid}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal", "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
    if (!up.ok) {
      failed++
      console.log(`  ✗ ${pid.slice(0, 8)} — PATCH ${up.status}: ${(await up.text()).slice(0, 200)}`)
      continue
    }
    ok++
    const detail = []
    if (patch.ai_score != null) detail.push(`${patch.ai_score}/10 ${patch.ai_recommendation}`)
    if (patch.ai_summary) detail.push("summary recovered from Bolna blob")
    console.log(`  ✓ ${pid.slice(0, 8)} → ${detail.join(" · ")}`)
  }

  console.log("\nDone:", { patched: ok, fromGemini: viaGemini, fromStoredOrTranscript: viaStored, skipped, failed, total: rows.length })
}

main().catch((e) => { console.error(e); process.exit(1) })