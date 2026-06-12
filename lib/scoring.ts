export function normalizeRoleText(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function parseYears(text: string) {
  const t = String(text || '')
  const m = t.match(/(\d{1,2})(?:\+)?\s*(?:years?|yrs?)/i)
  if (!m) return 0
  const v = Number(m[1])
  return Number.isFinite(v) ? v : 0
}

export function applySidebarFilters(results: any[], filters: any) {
  if (!filters || Object.keys(filters).length === 0) return results;

  return results.filter((candidate: any) => {
    if (filters.mustHaveKeywords?.length) {
      const candidateText = [
        candidate.name || "",
        candidate.current_role || "",
        candidate.location || "",
        candidate.summary || "",
        candidate.current_company || "",
        ...(candidate.technical_skills || []),
        ...(candidate.soft_skills || []),
        ...(candidate.job_titles || []),
      ]
        .join(" ")
        .toLowerCase()
      const hasAllKeywords = filters.mustHaveKeywords.every((keyword: string) =>
        candidateText.includes(keyword.toLowerCase()),
      )
      if (!hasAllKeywords) return false
    }

    if (filters.excludeKeywords?.length) {
      const candidateText = [
        candidate.name || "",
        candidate.current_role || "",
        candidate.location || "",
        candidate.summary || "",
        candidate.current_company || "",
        ...(candidate.technical_skills || []),
        ...(candidate.soft_skills || []),
        ...(candidate.job_titles || []),
      ]
        .join(" ")
        .toLowerCase()
      const hasExcludedKeyword = filters.excludeKeywords.some((keyword: string) =>
        candidateText.includes(keyword.toLowerCase()),
      )
      if (hasExcludedKeyword) return false
    }

    if (filters.currentCity?.length) {
      const candidateLocation = (candidate.location || "").toLowerCase()
      const matchesCity = filters.currentCity.some((city: string) =>
        candidateLocation.includes(city.toLowerCase()),
      )
      if (!matchesCity) return false
    }

    if (filters.experience?.min || filters.experience?.max) {
      const experienceYears = parseYears(candidate.total_experience)
      const minExp = filters.experience.min ? Number(filters.experience.min) : 0
      const maxExp = filters.experience.max ? Number(filters.experience.max) : Infinity
      if (experienceYears < minExp || experienceYears > maxExp) return false
    }

    if (filters.salaryRange?.min || filters.salaryRange?.max) {
      const currentSalary = candidate.current_salary || ""
      const expectedSalary = candidate.expected_salary || ""
      const salaryStr = currentSalary || expectedSalary
      if (salaryStr) {
        const salaryMatch = salaryStr.match(/(\d+(?:\.\d+)?)/)
        if (salaryMatch) {
          const salaryValue = parseFloat(salaryMatch[1])
          const minSalary = filters.salaryRange.min ? Number(filters.salaryRange.min) : 0
          const maxSalary = filters.salaryRange.max ? Number(filters.salaryRange.max) : Infinity
          if (salaryValue < minSalary || salaryValue > maxSalary) return false
        }
      }
    }

    if (filters.education?.length) {
      const candidateEducation = [
        candidate.degree || "",
        candidate.highest_qualification || "",
        candidate.education || "",
      ]
        .join(" ")
        .toLowerCase()
      const matchesEducation = filters.education.some((edu: string) => {
        const eduLower = edu.toLowerCase()
        return (
          candidateEducation.includes(eduLower) ||
          (eduLower.includes("graduate") &&
            (candidateEducation.includes("bachelor") || candidateEducation.includes("master"))) ||
          (eduLower.includes("post graduate") && candidateEducation.includes("master"))
        )
      })
      if (!matchesEducation) return false
    }

    if (filters.gender?.length) {
      const candidateGender = (candidate.gender || "").toLowerCase()
      const matchesGender = filters.gender.some((g: string) => candidateGender.includes(g.toLowerCase()))
      if (!matchesGender) return false
    }

    if (filters.languages?.length) {
      const candidateLanguages = (candidate.languages_known || []).map((l: string) => l.toLowerCase())
      const matchesLanguage = filters.languages.some((lang: string) =>
        candidateLanguages.some((cl: string) => cl.includes(lang.toLowerCase())),
      )
      if (!matchesLanguage) return false
    }

    return true
  })
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

export function calculateRoleMatch(requiredRole: string, candidate: any): number {
  const candidateRole = getCandidateRoleText(candidate)
  const required = requiredRole.toLowerCase()
  
  if (!candidateRole) return 0

  const candNorm = normalizeRoleText(candidateRole)
  const reqNorm = normalizeRoleText(required)
  if (candNorm && reqNorm) {
    if (candNorm.includes(reqNorm) || reqNorm.includes(candNorm)) return 1
  }

  const roleSynonyms: { [key: string]: string[] } = {
    'fleet manager': ['fleet management', 'transportation manager', 'logistics manager', 'operations manager', 'fleet operations manager'],
    'truck driver': ['driver', 'heavy vehicle driver', 'commercial driver', 'truck operator', 'heavy truck driver', 'delivery driver'],
    'logistics coordinator': ['logistics executive', 'supply chain coordinator', 'logistics specialist', 'operations coordinator'],
    'warehouse manager': ['warehouse executive', 'store manager', 'inventory manager', 'warehouse supervisor', 'store incharge'],
    'supply chain manager': ['supply chain executive', 'procurement manager', 'operations manager', 'logistics manager'],
    'transport manager': ['transportation manager', 'fleet manager', 'logistics manager', 'dispatch manager'],
    'operations manager': ['operations executive', 'operations head', 'operations supervisor', 'fleet manager', 'logistics manager']
  }

  let best = 0
  const synonyms = roleSynonyms[required] || []
  for (const synonym of synonyms) {
    if (candidateRole.includes(synonym)) best = Math.max(best, 0.8)
  }

  if (candNorm && reqNorm) {
    const reqTokens = reqNorm.split(" ").filter((t) => t.length > 2)
    const candTokens = new Set(candNorm.split(" ").filter((t) => t.length > 2))
    if (reqTokens.length > 0) {
      const hits = reqTokens.filter((t) => candTokens.has(t)).length
      const score = hits / reqTokens.length
      if (score >= 0.7) best = Math.max(best, 0.8)
      else if (score >= 0.5) best = Math.max(best, 0.6)
      else if (score >= 0.34) best = Math.max(best, 0.4)
    }
  }

  const allSkills = [
    ...(candidate.technical_skills || []),
    ...(candidate.soft_skills || [])
  ].map((skill: string) => skill.toLowerCase())

  const roleSkillMap: { [key: string]: string[] } = {
    'fleet manager': ['fleet', 'transportation', 'logistics', 'vehicle', 'route', 'driver management', 'fuel management'],
    'truck driver': ['driving', 'vehicle', 'transportation', 'license', 'delivery', 'logistics', 'commercial driving'],
    'logistics coordinator': ['logistics', 'supply chain', 'coordination', 'planning', 'inventory', 'transportation'],
    'warehouse manager': ['warehouse', 'inventory', 'store', 'logistics', 'supply chain', 'operations'],
    'supply chain manager': ['supply chain', 'procurement', 'logistics', 'inventory', 'operations', 'vendor management'],
    'transport manager': ['transportation', 'fleet', 'logistics', 'route', 'dispatch', 'vehicle management']
  }

  const requiredSkills = roleSkillMap[required] || []
  const skillMatches = allSkills.filter(skill => 
    requiredSkills.some(reqSkill => skill.includes(reqSkill))
  )

  return Math.max(best, skillMatches.length > 0 ? 0.6 : 0.2)
}

export function calculateExperienceScore(minExp: number | null, maxExp: number | null, candidateExpValue: number | string): number {
  if (candidateExpValue == null) return 0.3
  
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
        return 0.3
      }
    }
  }
  
  if (minExp != null && candidateYears >= minExp) {
    return maxExp != null && candidateYears <= maxExp ? 1 : 0.8
  } else if (minExp != null && candidateYears < minExp) {
    return 0.4
  }
  
  return candidateYears > 0 ? 0.5 : 0.2
}

export function calculateLocationScore(requiredLocation: string, candidateLocation: string): number {
  if (!candidateLocation) return 0.3
  
  const required = requiredLocation.toLowerCase()
  const candidate = candidateLocation.toLowerCase()
  
  if (candidate.includes(required) || required.includes(candidate)) return 1
  
  const locationVariations: { [key: string]: string[] } = {
    'delhi': ['delhi', 'ncr', 'new delhi', 'gurgaon', 'noida', 'faridabad'],
    'mumbai': ['mumbai', 'bombay', 'navi mumbai', 'thane'],
    'bangalore': ['bangalore', 'bengaluru'],
    'chennai': ['chennai', 'madras']
  }
  
  for (const [city, variations] of Object.entries(locationVariations)) {
    if (required.includes(city)) {
      for (const variation of variations) {
        if (candidate.includes(variation)) return 0.9
      }
    }
  }
  
  return 0.1
}

export function calculateSkillsScore(requiredSkills: string[], candidate: any): number {
  const allCandidateSkills = [
    ...(candidate.technical_skills || []),
    ...(candidate.soft_skills || [])
  ].map((skill: string) => skill.toLowerCase())
  
  if (allCandidateSkills.length === 0) return 0.2
  
  let matches = 0
  for (const requiredSkill of requiredSkills) {
    const required = requiredSkill.toLowerCase()
    if (allCandidateSkills.some(skill => skill.includes(required) || required.includes(skill))) {
      matches++
    }
  }
  
  return matches / requiredSkills.length
}

export function calculateCandidateScore(criteria: any, candidate: any): number {
  let score = 0
  let roleQualified = true

  if (criteria.role) {
    const roleMatch = calculateRoleMatch(criteria.role, candidate)
    if (roleMatch < 0.2) {
      roleQualified = false
    }
    if (roleMatch > 0.2) {
      score += roleMatch * 30
    }
  }

  if (criteria.min_experience_years != null || criteria.max_experience_years != null) {
    const expScore = calculateExperienceScore(criteria.min_experience_years, criteria.max_experience_years, candidate.total_experience)
    score += expScore * 25
  } else {
    score += 0.5 * 25 // default middle score
  }

  if (criteria.location) {
    const locationScore = calculateLocationScore(criteria.location, candidate.location)
    score += locationScore * 25
  } else {
    score += 0.5 * 25
  }

  if (criteria.skills && criteria.skills.length > 0) {
    const skillsScore = calculateSkillsScore(criteria.skills, candidate)
    score += skillsScore * 20
  } else {
    score += 0.5 * 20
  }

  if (!roleQualified) {
    return 0 // Failed hard requirement
  }

  return score
}
