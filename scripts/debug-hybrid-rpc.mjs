/**
 * Standalone diagnostic for the DB Matches pipeline.
 * Usage: node scripts/debug-hybrid-rpc.mjs <jobId>
 * Mirrors app/api/jobs/[id]/matches/route.ts stage by stage and prints counts.
 */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const envPath = path.resolve(process.cwd(), ".env.local")
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s?(.*)\s*$/)
  if (!m) continue
  let val = m[2].trim()
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
  if (!(m[1] in process.env)) process.env[m[1]] = val
}

const require = createRequire(import.meta.url)
const { createClient } = require("@supabase/supabase-js")

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local")
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

const JOB_ID = process.argv[2]
if (!JOB_ID) {
  console.error("Usage: node scripts/debug-hybrid-rpc.mjs <jobId>")
  process.exit(1)
}

async function embed(text) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return { vec: [], err: "no GEMINI_API_KEY" }
  const model = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001"
  const targetDim = Number(process.env.EMBEDDING_DIM || 768)
  const input = String(text || "").trim().slice(0, 8000)
  if (!input) return { vec: [], err: "empty input" }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ model: `models/${model}`, content: { parts: [{ text: input }] }, output_dimensionality: targetDim }),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) return { vec: [], err: `${res.status} ${json?.error?.message || res.statusText}` }
  const values = json?.embedding?.values || []
  let vec = values.map(Number).filter(Number.isFinite)
  if (vec.length > targetDim) vec = vec.slice(0, targetDim)
  if (vec.length < targetDim) vec = [...vec, ...Array(targetDim - vec.length).fill(0)]
  return { vec, err: null }
}

async function geminiExtract(jd) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return { out: null, err: "no GEMINI_API_KEY" }
  const prompt = `Analyze this job description and extract key hiring criteria for candidate matching.\nJD: """${jd.slice(0, 3000)}"""\nReturn ONLY valid JSON:\n{"title": string, "required_skills": string[], "preferred_skills": string[], "min_experience_years": number|null, "location": string|null, "key_keywords": string[]}`
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  )
  const json = await res.json().catch(() => null)
  if (!res.ok) return { out: null, err: `${res.status} ${json?.error?.message || res.statusText}` }
  try {
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || ""
    return { out: JSON.parse(text.replace(/```json\n?|\n?```/g, "").trim()), err: null }
  } catch (e) {
    return { out: null, err: `parse: ${e.message}` }
  }
}

const { data: job, error: jobErr } = await sb
  .from("jobs")
  .select("title, description, location, city, skills_must_have, skills_good_to_have, experience_min_years")
  .eq("id", JOB_ID)
  .single()
if (jobErr || !job) {
  console.error("Job fetch failed:", jobErr?.message || "not found")
  process.exit(1)
}
const baseText = [job.title || "", job.description || ""].join("\n").trim()
console.log("=== JOB ===")
console.log("title:", job.title)
console.log("descLen:", (job.description || "").length, "baseTextLen:", baseText.length)
console.log("structured city:", job.city, "| minExp:", job.experience_min_years, "| mustSkills:", job.skills_must_have)

const { count: candTotal } = await sb.from("candidates").select("id", { count: "exact", head: true })
console.log("\n=== POOL === candidates table total:", candTotal)

console.log("\n=== EMBEDDING ===")
const t0 = Date.now()
const { vec, err: embErr } = await embed(baseText.slice(0, 7000))
console.log("dims:", vec.length, "err:", embErr, `(${Date.now() - t0}ms)`)

console.log("\n=== GEMINI CRITERIA ===")
const { out: crit, err: critErr } = await geminiExtract(baseText)
if (critErr) console.log("criteria err:", critErr)
else {
  console.log("title:", crit?.title)
  console.log("required_skills:", (crit?.required_skills || []).length, crit?.required_skills)
  console.log("key_keywords:", (crit?.key_keywords || []).length)
}

const title = (job.title || crit?.title || "").toLowerCase().trim()
const allKeyTerms = [...new Set([title, ...(crit?.required_skills || []), ...(crit?.key_keywords || [])])].filter(Boolean)
const websearchQ = allKeyTerms.slice(0, 15).map((t) => (t.includes(" ") ? `"${t}"` : t)).join(" OR ").replace(/[()]/g, " ").trim()
console.log("\n=== QUERY ===")
console.log("websearchQ:", websearchQ)

async function rpc(label, params) {
  const { data, error } = await sb.rpc("search_candidates_hybrid", params)
  const n = Array.isArray(data) ? data.length : 0
  const top = Array.isArray(data) && data[0] ? Number(data[0].match_score).toFixed(3) : "-"
  console.log(`${label}: rows=${n} topMatchScore=${top} ${error ? `ERROR: ${error.message}` : ""}`)
  return n
}

await rpc("RPC A (text+emb, no filters)", {
  p_query_text: websearchQ,
  p_query_embedding: vec.length ? vec : null,
  p_match_threshold: 0.15,
  p_filters: {},
  p_limit: 500,
  p_offset: 0,
})

await rpc("RPC B (text only, no filters)", {
  p_query_text: websearchQ,
  p_query_embedding: null,
  p_match_threshold: 0.15,
  p_filters: {},
  p_limit: 500,
  p_offset: 0,
})

await rpc("RPC C (emb only, no filters)", {
  p_query_text: "",
  p_query_embedding: vec.length ? vec : null,
  p_match_threshold: 0.15,
  p_filters: {},
  p_limit: 500,
  p_offset: 0,
})

if (job.city) {
  await rpc("RPC D (client-style HARD city+kw filters)", {
    p_query_text: websearchQ,
    p_query_embedding: vec.length ? vec : null,
    p_match_threshold: 0.15,
    p_filters: {
      ...(job.city ? { currentCity: [job.city.split(",")[0].trim()] } : {}),
      must_kw: allKeyTerms.slice(0, 10),
    },
    p_limit: 500,
    p_offset: 0,
  })
}
