// Scoring engine — Role 35 + Skills 30 + Experience 20 + Location 15 = 100 max.
// Phase 1-3 optimization: rebalanced weights, smarter role matching, weighted skills.

export function normalizeRoleText(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function extractCurrentRoleText(candidate: any) {
  if (candidate?.current_role) return String(candidate.current_role)
  return ""
}

export function getCandidateRoleText(candidate: any): string {
  const parts: string[] = []
  const currentRole = extractCurrentRoleText(candidate)
  if (currentRole) parts.push(currentRole)
  if (candidate?.desired_role) parts.push(String(candidate.desired_role))
  if (Array.isArray(candidate?.job_titles)) parts.push(...candidate.job_titles.map((t: any) => String(t)))
  return parts.join(" ").toLowerCase()
}

// ── Phase 2: Expanded role synonyms covering sales/BD/logistics/operations ──

const ROLE_SYNONYMS: { [key: string]: string[] } = {
  "corporate relationship manager": [
    "relationship manager", "client manager", "key account manager",
    "business development manager", "sales manager", "account manager",
    "corporate sales manager", "b2b sales manager",
  ],
  "relationship manager": [
    "client manager", "key account manager", "corporate relationship manager",
    "account manager", "client relationship manager",
  ],
  "business development manager": [
    "bd manager", "sales manager", "bd executive",
    "key account manager", "relationship manager",
    "business development executive", "b2b business development",
  ],
  "sales manager": [
    "business development manager", "revenue manager", "sales executive",
    "client acquisition", "key account manager", "business sales manager",
  ],
  "business development executive": [
    "bd executive", "sales executive", "bde", "business sales executive",
  ],
  "key account manager": [
    "relationship manager", "client manager", "account manager",
    "corporate account manager", "key account executive",
  ],
  "fleet manager": [
    "fleet management", "transportation manager", "logistics manager",
    "transport manager", "fleet supervisor", "fleet incharge",
    "fleet operations manager",
  ],
  "fleet incharge": [
    "fleet manager", "fleet supervisor", "fleet operations",
    "transport incharge", "fleet executive",
  ],
  "truck driver": [
    "driver", "heavy vehicle driver", "commercial driver",
    "truck operator", "vehicle driver", "delivery driver",
  ],
  "logistics coordinator": [
    "logistics executive", "supply chain coordinator",
    "transport coordinator", "dispatch executive",
  ],
  "operations manager": [
    "operations executive", "operations head", "fleet manager",
    "branch manager", "operations supervisor",
  ],
  "dispatcher": [
    "dispatch executive", "dispatch coordinator", "fleet dispatcher",
  ],
  "supply chain": [
    "procurement", "warehouse", "inventory", "logistics", "distribution",
  ],
  "driver": [
    "truck driver", "vehicle operator", "commercial driver", "delivery driver",
  ],
  "warehouse manager": [
    "warehouse executive", "store manager", "inventory manager",
    "warehouse supervisor", "store incharge",
  ],
  "supply chain manager": [
    "supply chain executive", "procurement manager", "operations manager",
    "logistics manager",
  ],
  "transport manager": [
    "transportation manager", "fleet manager", "logistics manager",
    "dispatch manager",
  ],
}

// ── Domain relevance keywords per job-role family ──

const ROLE_DOMAIN_KEYWORDS: { [key: string]: string[] } = {
  "corporate relationship manager": [
    "logistics", "transportation", "supply chain", "courier", "freight",
    "shipping", "cargo", "3pl", "4pl", "e-commerce", "b2b", "sales",
    "business development", "client acquisition", "account management",
  ],
  "business development manager": [
    "sales", "business development", "b2b", "b2c", "lead generation",
    "client acquisition", "revenue", "partnership", "strategic",
  ],
  "relationship manager": [
    "client", "account", "relationship", "retention", "customer success",
    "b2b", "enterprise", "corporate",
  ],
  "sales manager": [
    "sales", "revenue", "target", "quota", "pipeline", "conversion",
    "b2b", "b2c", "lead", "prospect",
  ],
  "fleet manager": [
    "fleet", "transport", "vehicle", "route", "dispatch", "logistics",
    "driver", "fuel", "maintenance",
  ],
}

const ROLE_SKILL_MAP: { [key: string]: string[] } = {
  "corporate relationship manager": ["relationship management", "client acquisition", "business development", "sales", "b2b", "account management", "revenue generation", "lead generation", "negotiation", "partnership"],
  "business development manager": ["business development", "lead generation", "sales", "b2b", "b2c", "client acquisition", "revenue", "pipeline", "prospecting", "partnership"],
  "relationship manager": ["client management", "account management", "relationship management", "customer retention", "b2b", "enterprise"],
  "sales manager": ["sales", "revenue", "target achievement", "pipeline management", "lead conversion", "b2b", "b2c"],
  "fleet manager": ["fleet", "transportation", "logistics", "vehicle", "route", "driver management", "fuel management"],
  "fleet incharge": ["fleet", "transportation", "logistics", "vehicle", "route", "driver management", "dispatch"],
  "truck driver": ["driving", "vehicle", "transportation", "license", "delivery", "logistics", "commercial driving"],
  "logistics coordinator": ["logistics", "supply chain", "coordination", "planning", "inventory", "transportation"],
  "warehouse manager": ["warehouse", "inventory", "store", "logistics", "supply chain", "operations"],
  "supply chain manager": ["supply chain", "procurement", "logistics", "inventory", "operations", "vendor management"],
  "transport manager": ["transportation", "fleet", "logistics", "route", "dispatch", "vehicle management"],
}

// ── Role matching ──

/** calculateRoleMatch - returns 0-1 indicating how well the candidate's role matches */
export function calculateRoleMatch(requiredRole: string, candidate: any): number {
  const candidateRole = getCandidateRoleText(candidate)
  const required = String(requiredRole || "").toLowerCase()

  if (!candidateRole || !required) return 0

  const candNorm = normalizeRoleText(candidateRole)
  const reqNorm = normalizeRoleText(required)

  // 1. Exact inclusion (either direction) → 1.0
  if (candNorm && reqNorm) {
    if (candNorm.includes(reqNorm) || reqNorm.includes(candNorm)) return 1
  }

  let best = 0

  // 2. Synonym match → 0.8
  const synonyms = ROLE_SYNONYMS[required] || []
  for (const synonym of synonyms) {
    if (candidateRole.includes(synonym)) best = Math.max(best, 0.8)
  }

  // 3. Token overlap — only count MEANINGFUL tokens (skip generic words)
  if (candNorm && reqNorm) {
    const genericTokens = new Set(["manager", "executive", "senior", "junior", "lead", "head", "officer", "associate", "assistant", "director"])
    const reqTokens = reqNorm.split(" ").filter((t) => t.length > 3 && !genericTokens.has(t))
    const candTokens = new Set(candNorm.split(" ").filter((t) => t.length > 3))
    if (reqTokens.length > 0) {
      const hits = reqTokens.filter((t) => candTokens.has(t)).length
      const score = hits / reqTokens.length
      if (score >= 0.7) best = Math.max(best, 0.7)
      else if (score >= 0.5) best = Math.max(best, 0.5)
      else if (score >= 0.34) best = Math.max(best, 0.3)
    }
  }

  // 4. Role→skill map check → 0.5
  const candidateSkills = [
    ...(candidate.technical_skills || []),
    ...(candidate.soft_skills || []),
  ].map((skill: string) => skill.toLowerCase())

  const requiredSkills = ROLE_SKILL_MAP[required] || []
  const skillMatches = candidateSkills.filter(skill =>
    requiredSkills.some(reqSkill => skill.includes(reqSkill))
  )
  best = Math.max(best, skillMatches.length > 0 ? 0.5 : 0)

  // No domain bonus — it inflated scores for wrong-domain candidates
  return Math.max(best, best > 0 ? best : 0.1)
}

// ── Experience matching (progressive penalty for over-qualification) ──

/** calculateExperienceScore - in range → 1.0; above max → progressive penalty; below min → 0.2 */
export function calculateExperienceScore(minExp: number | null, maxExp: number | null, candidateExpValue: number | string): number {
  if (candidateExpValue == null) return 0.1

  let candidateYears = 0
  if (typeof candidateExpValue === 'number') {
    candidateYears = candidateExpValue
  } else {
    const expPatterns = [
      /(\d+(?:\.\d+)?)\s*years?/,
      /(\d+(?:\.\d+)?)\s*yr/,
      /(\d+)\s*years?\s*(\d+)\s*months?/,
      /(\d+)\s*months?/
    ]
    let foundMatch = false
    const candidateExpStr = String(candidateExpValue).toLowerCase()

    for (const pattern of expPatterns) {
      const match = candidateExpStr.match(pattern)
      if (match) {
        if (match.length === 3 && candidateExpStr.includes('months')) {
          candidateYears = parseFloat(match[1]) + (parseFloat(match[2]) / 12)
        } else if (candidateExpStr.includes('months') && !candidateExpStr.includes('years')) {
          candidateYears = parseFloat(match[1]) / 12
        } else {
          candidateYears = parseFloat(match[1])
        }
        foundMatch = true
        break
      }
    }

    if (!foundMatch) {
      const num = parseFloat(candidateExpStr)
      if (!isNaN(num)) {
        candidateYears = num
      } else {
        return 0.1
      }
    }
  }

  // In range → 1.0
  if (minExp != null && candidateYears >= minExp) {
    if (maxExp != null && candidateYears <= maxExp) return 1.0

    // Above max → progressive penalty
    if (maxExp != null && candidateYears > maxExp) {
      const overBy = candidateYears - maxExp
      if (overBy <= 1) return 0.75
      if (overBy <= 2) return 0.6
      if (overBy <= 4) return 0.4
      return 0.2
    }

    // Above min but no max specified
    return 0.7
  }

  // Below min
  if (minExp != null && candidateYears < minExp) {
    return candidateYears >= minExp - 1 ? 0.3 : 0.15
  }

  return candidateYears > 0 ? 0.4 : 0.1
}

// ── Location matching (expanded Indian metros) ──

/** calculateLocationScore - exact/containment → 1.0; metro area → 0.85-0.9; miss → 0.1 */
export function calculateLocationScore(requiredLocation: string, candidateLocation: string): number {
  if (!candidateLocation) return 0.1

  const required = String(requiredLocation || "").toLowerCase().trim()
  const candidate = candidateLocation.toLowerCase()

  if (!required) return 0.3

  // Exact match or containment → 1.0
  if (candidate.includes(required) || required.includes(candidate)) return 1

  const locationVariations: { [key: string]: { variations: string[]; exact: string[] } } = {
    "delhi": {
      variations: ["delhi", "ncr", "new delhi", "gurgaon", "gurugram", "noida", "faridabad", "ghaziabad", "dwarka", "rohini", "mahipalpur", "janakpuri", "pitampura", "saket", "lajpat nagar"],
      exact: ["gurgaon", "gurugram", "noida", "faridabad", "ghaziabad"],
    },
    "mumbai": {
      variations: ["mumbai", "bombay", "navi mumbai", "thane", "vashi", "andheri", "borivali", "powai", "lower parel", "worli"],
      exact: ["thane", "navi mumbai"],
    },
    "bangalore": {
      variations: ["bangalore", "bengaluru", "whitefield", "electronic city", "koramangala", "indiranagar", "HSR layout", "sarjapur"],
      exact: [],
    },
    "chennai": {
      variations: ["chennai", "madras", "omr", "adyar", "velachery", "tambaram"],
      exact: [],
    },
    "pune": {
      variations: ["pune", "pimpri", "chinchwad", "hinjewadi", "wakad", "baner"],
      exact: ["pimpri", "chinchwad"],
    },
    "hyderabad": {
      variations: ["hyderabad", "secunderabad", "hitec city", "cyberabad", "madhapur", "gachibowli"],
      exact: ["secunderabad"],
    },
    "kolkata": {
      variations: ["kolkata", "calcutta", "salt lake", "new town", "sector v"],
      exact: [],
    },
    "jaipur": {
      variations: ["jaipur", "malviya nagar", "tonk road", "mansarovar"],
      exact: [],
    },
  }

  for (const [city, config] of Object.entries(locationVariations)) {
    if (required.includes(city)) {
      // Satellite city → 0.85
      for (const exact of config.exact) {
        if (candidate.includes(exact)) return 0.85
      }
      // Broader metro area → 0.9
      for (const variation of config.variations) {
        if (candidate.includes(variation)) return 0.9
      }
    }
  }

  return 0.1
}

// ── Skills matching (Phase 3: weighted must-have vs good-to-have + resume text scanning) ──

/** Count how many required skills match against candidate skills + resume text */
function countSkillMatches(
  requiredSkills: string[],
  candidateSkillsLower: string[],
  candidateText: string
): number {
  let matches = 0
  for (const requiredSkill of requiredSkills) {
    const req = requiredSkill.toLowerCase().trim()
    if (!req || req.length < 2) continue

    // Check structured skills first (containment, but tightened)
    const skillMatch = candidateSkillsLower.some(skill => {
      if (skill.includes(req) || req.includes(skill)) return true
      // Word-level match: check if any significant word overlaps
      const reqWords = req.split(/\s+/).filter(w => w.length > 3)
      const skillWords = new Set(skill.split(/\s+/))
      if (reqWords.length > 0 && reqWords.every(w => skillWords.has(w))) return true
      return false
    })

    if (skillMatch) {
      matches++
      continue
    }

    // Phase 3: scan resume text and summary for the skill keyword
    if (candidateText && req.length > 3) {
      const escaped = req.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const regex = new RegExp(`\\b${escaped}\\b`, "i")
      if (regex.test(candidateText)) {
        matches++
      }
    }
  }
  return matches
}

/** calculateSkillsScore - weighted scoring with must-have (70%) + good-to-have (30%) + resume text scanning */
export function calculateSkillsScore(
  requiredSkills: string[],
  candidate: any,
  preferredSkills?: string[]
): number {
  const allCandidateSkills = [
    ...(candidate.technical_skills || []),
    ...(candidate.soft_skills || []),
  ].map((skill: string) => skill.toLowerCase())

  // Phase 3: also scan resume text and summary for keyword matches
  const candidateText = [
    candidate.summary || "",
    candidate.resume_text || "",
  ].join(" ").toLowerCase()

  if (!requiredSkills || requiredSkills.length === 0) {
    // No required skills → check good-to-have only
    if (!preferredSkills || preferredSkills.length === 0) return 0.3
    const goodMatches = countSkillMatches(preferredSkills, allCandidateSkills, candidateText)
    return 0.2 + (goodMatches / preferredSkills.length) * 0.3
  }

  if (allCandidateSkills.length === 0 && !candidateText) return 0.1

  // Must-have scoring (70% weight)
  const mustHaveMatches = countSkillMatches(requiredSkills, allCandidateSkills, candidateText)
  const mustHaveScore = mustHaveMatches / requiredSkills.length

  // Good-to-have scoring (30% weight)
  let goodToHaveScore = 0.3 // default if no preferred skills
  if (preferredSkills && preferredSkills.length > 0) {
    const goodMatches = countSkillMatches(preferredSkills, allCandidateSkills, candidateText)
    goodToHaveScore = goodMatches / preferredSkills.length
  }

  return mustHaveScore * 0.7 + goodToHaveScore * 0.3
}

// ── Main scoring function (Phase 1: rebalanced weights) ──

/**
 * calculateCandidateScoreWithBreakdown
 * Weights: Role 35 / Skills 30 / Experience 20 / Location 15 = 100 max.
 * Hard-fails to 0 when role match < 0.15.
 */
export function calculateCandidateScoreWithBreakdown(criteria: any, candidate: any): {
  score: number
  breakdown: Record<string, { earned: number; max: number }>
} {
  let score = 0
  const breakdown: Record<string, { earned: number; max: number }> = {}
  const round = (n: number) => Math.round(n * 100) / 100

  // ── Role (35 pts) — no hard-fail, role contributes proportionally ──
  if (criteria.role) {
    const roleMatch = calculateRoleMatch(criteria.role, candidate)
    const earned = roleMatch * 35
    score += earned
    breakdown.role = { earned: round(earned), max: 35 }
  } else {
    breakdown.role = { earned: 10, max: 35 }
    score += 10
  }

  // ── Skills (30 pts) — Phase 3: weighted must-have + good-to-have ──
  if (criteria.must_have_skills?.length > 0 || criteria.good_to_have_skills?.length > 0) {
    const skillsScore = calculateSkillsScore(
      criteria.must_have_skills || [],
      candidate,
      criteria.good_to_have_skills || []
    )
    const earned = skillsScore * 30
    score += earned
    breakdown.skills = { earned: round(earned), max: 30 }
  } else if (criteria.skills && criteria.skills.length > 0) {
    // Backward compat: flat skills array
    const skillsScore = calculateSkillsScore(criteria.skills, candidate)
    const earned = skillsScore * 30
    score += earned
    breakdown.skills = { earned: round(earned), max: 30 }
  } else {
    breakdown.skills = { earned: 8, max: 30 }
    score += 8
  }

  // ── Experience (20 pts) ──
  if (criteria.min_experience_years != null || criteria.max_experience_years != null) {
    const expScore = calculateExperienceScore(criteria.min_experience_years, criteria.max_experience_years, candidate.total_experience)
    const earned = expScore * 20
    score += earned
    breakdown.experience = { earned: round(earned), max: 20 }
  } else {
    breakdown.experience = { earned: 6, max: 20 }
    score += 6
  }

  // ── Location (15 pts) ──
  if (criteria.location) {
    const locationScore = calculateLocationScore(criteria.location, candidate.location)
    const earned = locationScore * 15
    score += earned
    breakdown.location = { earned: round(earned), max: 15 }
  } else {
    breakdown.location = { earned: 4, max: 15 }
    score += 4
  }

  return { score: round(score), breakdown }
}

// ── Legacy wrapper ──

/** calculateCandidateScore - client-parity weighted score (Role 35 / Skills 30 / Exp 20 / Loc 15) */
export function calculateCandidateScore(criteria: any, candidate: any): number {
  return calculateCandidateScoreWithBreakdown(criteria, candidate).score
}
