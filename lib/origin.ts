export type CandidateOrigin = "inbound" | "outbound"

export const INBOUND_SOURCES = new Set([
  "applied",
  "candidate_board",
  "board-app",
  "external_outreach",
  "portal",
  "apna",
  "naukri",
  "workindia",
  "job_board",
  "database > board-app",
])

export const OUTBOUND_SOURCES = new Set([
  "database",
  "enhanced_match",
  "recruiter_upload",
])

export function deriveOrigin(source?: string | null): CandidateOrigin {
  if (!source) return "inbound"
  const normalized = String(source).trim().toLowerCase()
  if (OUTBOUND_SOURCES.has(normalized)) return "outbound"
  if (INBOUND_SOURCES.has(normalized)) return "inbound"
  if (normalized.startsWith("database")) return "outbound"
  return "inbound"
}
