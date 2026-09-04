export type CandidateSource =
  | "board-app"
  | "candidate_board"
  | "database"
  | "enhanced_match"
  | "recruiter_upload"
  | "applied"
  | "portal"
  | "apna"
  | "naukri"
  | "workindia"
  | "job_board"
  | "external_outreach"
  | string

export const SOURCE_LABELS: Record<string, string> = {
  portal: "GatiHire Portal",
  apna: "Apna",
  naukri: "Naukri",
  workindia: "WorkIndia",
  job_board: "Job Board",
  applied: "Applied",
  candidate_board: "Candidate Board",
  "board-app": "Board App",
  external_outreach: "External Outreach",
  database: "Database Match",
  enhanced_match: "Enhanced Match",
  recruiter_upload: "Recruiter Upload",
}

/** Returns "inbound" | "outbound" based on source */
export function deriveOrigin(source?: string | null): "inbound" | "outbound" {
  if (!source) return "inbound"
  const normalized = String(source).trim().toLowerCase()
  const outbound = new Set(["database", "enhanced_match", "recruiter_upload"])
  if (outbound.has(normalized) || normalized.startsWith("database")) return "outbound"
  return "inbound"
}

/** Human-readable label for a source */
export function formatSourceLabel(source: string): string {
  return SOURCE_LABELS[source] || source.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Tailwind classes for source badge background/text/border based on origin */
export function getSourceBadgeClasses(source?: string | null): string {
  const origin = deriveOrigin(source)
  if (origin === "outbound") {
    return "bg-violet-50 text-violet-700 border-violet-200"
  }
  return "bg-blue-50 text-blue-700 border-blue-200"
}
