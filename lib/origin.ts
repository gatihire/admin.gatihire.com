export type CandidateOrigin = "inbound" | "outbound"

// The resume screening flow splits by whether we already have the candidate's
// CTC / notice details (captured via the talent-portal apply form) or not:
//  - portal   : applied through our board-app form -> shortlist + schedule only
//  - external : resume pulled from an external job portal -> 7-field WhatsApp
//  - outbound : sourced profiles -> matched outreach, then 7-field if interested
export type CandidateFlow = "portal" | "external" | "outbound"

export const PORTAL_SOURCES = new Set([
  "board-app",
  "board_app",
  "boardapp",
  "applied",
  "candidate_board",
])

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

export function deriveCandidateFlow(
  source: string | null | undefined,
  origin: CandidateOrigin
): CandidateFlow {
  if (origin === "outbound") return "outbound"
  const normalized = String(source || "").trim().toLowerCase()
  if (
    PORTAL_SOURCES.has(normalized) ||
    normalized.includes("board-app") ||
    normalized.includes("board_app") ||
    normalized.includes("boardapp")
  ) {
    return "portal"
  }
  return "external"
}
