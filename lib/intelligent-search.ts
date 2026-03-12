import { GoogleGenerativeAI } from "@google/generative-ai"
import { SupabaseCandidateService } from "./supabase-candidates"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "")
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash"

export interface SearchRequirement {
  role?: string;
  experience?: {
    min?: number;
    max?: number;
    exact?: number;
  };
  location?: string;
  skills?: string[];
  education?: string;
  certifications?: string[];
  industry?: string;
  specificRequirements?: string[];
}

export type RoleScope = "current" | "current_past"

export async function parseSearchRequirement(naturalLanguageQuery: string): Promise<SearchRequirement> {
  console.log("=== Parsing Search Requirement with Gemini ===")
  console.log("Query:", naturalLanguageQuery)

  if (!process.env.GEMINI_API_KEY) {
    console.log("⚠️ GEMINI_API_KEY not configured, using keyword extraction")
    return extractBasicRequirements(naturalLanguageQuery)
  }

  try {
    const model = genAI.getGenerativeModel({ model: DEFAULT_GEMINI_MODEL })
    
    const prompt = `You are an expert HR recruiter with deep knowledge of logistics and transportation industry. Parse this job requirement and extract structured information with semantic understanding:

"${naturalLanguageQuery}"

Extract and return ONLY a JSON object with this exact structure:
{
  "role": "Job title/position (e.g., 'Fleet Manager', 'Truck Driver')",
  "experience": {
    "min": minimum years of experience (number or null),
    "max": maximum years of experience (number or null),
    "exact": exact years if specified (number or null)
  },
  "location": "Required location/city",
  "skills": ["Array of required technical skills"],
  "education": "Education requirement",
  "certifications": ["Required certifications"],
  "industry": "Industry type (logistics, transportation, etc.)",
  "specificRequirements": ["Any other specific requirements"]
}

Important parsing rules:
- "5+ years" means min: 5
- "2-5 years" means min: 2, max: 5
- "Clean license" means certifications: ["Clean Driving License"]
- "CDL" means certifications: ["Commercial Driver License"]
- "Hazmat" means certifications: ["Hazmat Certification"]
- Location names should be extracted as-is
- Include both hard skills and soft skills
- Be precise and don't make assumptions

Return ONLY the JSON object, no additional text.`

    const result = await model.generateContent(prompt)
    const response = await result.response
    const text = response.text().replace(/```json\n?/g, "").replace(/```\n?/g, "").trim()
    
    console.log("Gemini parsing response:", text)
    
    try {
      const parsed = JSON.parse(text)
      console.log("✅ Successfully parsed requirements:", parsed)
      return parsed
    } catch (parseError) {
      console.log("❌ Failed to parse Gemini response, using fallback")
      return extractBasicRequirements(naturalLanguageQuery)
    }
  } catch (error) {
    console.error("❌ Gemini parsing failed:", error)
    console.log("🔄 Falling back to basic requirement extraction")
    return extractBasicRequirements(naturalLanguageQuery)
  }
}

function extractBasicRequirements(query: string): SearchRequirement {
  const lowerQuery = query.toLowerCase()
  const requirements: SearchRequirement = {}

  // Extract experience with various patterns
  const expPatterns = [
    /(\d+)\+?\s*years?/,           // "5+ years", "5 years"
    /(\d+)-(\d+)\s*years?/,        // "2-5 years"
    /minimum\s*(\d+)\s*years?/,    // "minimum 5 years"
    /at\s*least\s*(\d+)\s*years?/  // "at least 5 years"
  ]
  
  for (const pattern of expPatterns) {
    const match = lowerQuery.match(pattern)
    if (match) {
      if (match.length === 3) { // Range pattern
        requirements.experience = { min: parseInt(match[1]), max: parseInt(match[2]) }
      } else {
        requirements.experience = { min: parseInt(match[1]) }
      }
      break
    }
  }

  // Extract location with better coverage
  const locationKeywords = [
    'delhi', 'mumbai', 'bangalore', 'chennai', 'kolkata', 'pune', 'hyderabad', 'ahmedabad',
    'gurgaon', 'gurugram', 'noida', 'faridabad', 'ghaziabad', 'navi mumbai', 'thane',
    'jaipur', 'lucknow', 'chandigarh', 'indore', 'bhopal', 'patna', 'ranchi'
  ]
  
  for (const location of locationKeywords) {
    if (lowerQuery.includes(location)) {
      requirements.location = location
      break
    }
  }

  // Extract role with comprehensive coverage
  const roleKeywords = [
    'fleet manager', 'truck driver', 'logistics coordinator', 'warehouse manager', 
    'supply chain manager', 'transport manager', 'operations manager', 'delivery manager',
    'fleet supervisor', 'logistics executive', 'warehouse executive', 'transport coordinator'
  ]
  
  for (const role of roleKeywords) {
    if (lowerQuery.includes(role)) {
      requirements.role = role
      break
    }
  }

  // Extract skills
  const skillKeywords = [
    'gps tracking', 'fleet management', 'route optimization', 'supply chain', 'inventory management',
    'warehouse management', 'transportation', 'logistics', 'vehicle tracking', 'driver management',
    'fuel management', 'maintenance scheduling', 'compliance', 'safety regulations', 'dot regulations',
    'clean license', 'cdl', 'commercial driver license', 'hazmat', 'hazmat certification'
  ]
  
  const foundSkills = skillKeywords.filter(skill => lowerQuery.includes(skill))
  if (foundSkills.length > 0) {
    requirements.skills = foundSkills
  }

  // Extract certifications
  const certKeywords = [
    'cdl', 'commercial driver license', 'hazmat', 'hazmat certification', 'clean license',
    'dot certification', 'safety certification', 'forklift certification'
  ]
  
  const foundCerts = certKeywords.filter(cert => lowerQuery.includes(cert))
  if (foundCerts.length > 0) {
    requirements.certifications = foundCerts
  }

  // Extract education
  const educationKeywords = ['bachelor', 'master', 'diploma', 'degree', 'b.tech', 'mba']
  for (const edu of educationKeywords) {
    if (lowerQuery.includes(edu)) {
      requirements.education = edu
      break
    }
  }

  console.log("📋 Basic requirement extraction results:", requirements)
  return requirements
}

export async function intelligentCandidateSearch(
  requirements: SearchRequirement, 
  candidates: any[],
  options?: { roleScope?: RoleScope }
): Promise<any[]> {
  const debug = process.env.SEARCH_DEBUG === "1"
  const log = (...args: any[]) => {
    if (debug) console.log(...args)
  }
  const roleScope = options?.roleScope ?? "current_past"

  log("=== Intelligent Candidate Search ===")
  log("Requirements:", JSON.stringify(requirements, null, 2))
  log("Total candidates:", candidates.length)

  // First, try Supabase skill-based search if we have skills
  let supabaseResults: any[] = []
  if (requirements.skills && requirements.skills.length > 0) {
    try {
      log("Trying Supabase skill-based search with skills:", requirements.skills)
      supabaseResults = await SupabaseCandidateService.searchCandidatesBySkills(requirements.skills)
      log(`Supabase found ${supabaseResults.length} candidates with matching skills`)
    } catch (error) {
      log("Supabase skill search failed, continuing with local filtering:", error)
    }
  }

  // If no Supabase results, use all candidates
  const candidatesToFilter = supabaseResults.length > 0 ? supabaseResults : candidates
  log(`Filtering through ${candidatesToFilter.length} candidates`)

  // Intelligent filtering based on parsed requirements
  const filteredCandidates = candidatesToFilter.reduce((acc, candidate) => {
    let score = 0
    let matchingCriteria: string[] = []
    let roleQualified = true
    
    log(`\n📝 Analyzing candidate: ${candidate.name} (${candidate.currentRole})`)
    log(`📍 Location: ${candidate.location}`)
    log(`⏱️ Experience: ${candidate.totalExperience}`)
    log(`🛠️ Skills: ${(candidate.technicalSkills || []).join(', ')}`)

    // Role matching
    if (requirements.role) {
      const roleMatch = calculateRoleMatch(requirements.role, candidate, roleScope)
      log(`🎯 Role match score: ${roleMatch} (${requirements.role} vs ${candidate.currentRole})`)
      if (roleScope === "current" && roleMatch < 0.2) {
        roleQualified = false
      }
      if (roleMatch > 0.2) {
        score += roleMatch * 30
        matchingCriteria.push(`Role: ${candidate.currentRole} (${Math.round(roleMatch * 100)}%)`)
      }
    }

    // Experience matching
    if (requirements.experience) {
      const expScore = calculateExperienceScore(requirements.experience, candidate.totalExperience)
      log(`⏱️ Experience score: ${expScore} (${JSON.stringify(requirements.experience)} vs ${candidate.totalExperience})`)
      score += expScore * 25
      if (expScore > 0.2) {
        matchingCriteria.push(`Experience: ${candidate.totalExperience} (${Math.round(expScore * 100)}%)`)
      }
    }

    // Location matching
    if (requirements.location) {
      const locationScore = calculateLocationScore(requirements.location, candidate.location)
      log(`📍 Location score: ${locationScore} (${requirements.location} vs ${candidate.location})`)
      score += locationScore * 15
      if (locationScore > 0.2) {
        matchingCriteria.push(`Location: ${candidate.location} (${Math.round(locationScore * 100)}%)`)
      }
    }

    // Skills matching
    if (requirements.skills && requirements.skills.length > 0) {
      const skillsScore = calculateSkillsScore(requirements.skills, candidate)
      log(`🛠️ Skills score: ${skillsScore} (${requirements.skills.join(', ')} vs ${(candidate.technicalSkills || []).join(', ')})`)
      score += skillsScore * 20
      if (skillsScore > 0.1) {
        matchingCriteria.push(`Skills match: ${Math.round(skillsScore * 100)}%`)
      }
    }

    // Education matching
    if (requirements.education) {
      const eduScore = calculateEducationScore(requirements.education, candidate)
      log(`🎓 Education score: ${eduScore} (${requirements.education} vs ${candidate.highestQualification})`)
      score += eduScore * 10
      if (eduScore > 0.2) {
        matchingCriteria.push(`Education: ${candidate.highestQualification} (${Math.round(eduScore * 100)}%)`)
      }
    }

    log(`📊 Total score: ${score}/100 (${Math.round(score)}%)`)

    if (!roleQualified) {
      return acc
    }

    acc.push({
      ...candidate,
      relevanceScore: Math.min(0.95, score / 100),
      matchPercentage: Math.round((score / 100) * 100),
      matchingCriteria,
      parsedRequirements: requirements
    })
    return acc
  }, [] as any[])

  // Sort by relevance score and filter out poor matches
  const relevantCandidates = filteredCandidates
    .filter((candidate: any) => candidate.relevanceScore >= 0.12)
    .sort((a: any, b: any) => b.relevanceScore - a.relevanceScore)

  log(`Found ${relevantCandidates.length} relevant candidates`)
  return relevantCandidates
}

function getCandidateRoleText(candidate: any, roleScope: RoleScope): string {
  const parts: string[] = []
  const currentRole = extractCurrentRoleText(candidate)
  if (currentRole) parts.push(currentRole)
  if (roleScope === "current_past") {
    if (candidate?.desiredRole) parts.push(String(candidate.desiredRole))
    if (Array.isArray(candidate?.jobTitles)) parts.push(...candidate.jobTitles.map((t: any) => String(t)))
    if (Array.isArray(candidate?.workExperience)) {
      parts.push(...candidate.workExperience.map((exp: any) => exp?.role).filter(Boolean).map((t: any) => String(t)))
    }
  }
  return parts.join(" ").toLowerCase()
}

function normalizeRoleText(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function extractCurrentRoleText(candidate: any) {
  if (candidate?.currentRole) return String(candidate.currentRole)
  const exps = Array.isArray(candidate?.workExperience) ? candidate.workExperience : []
  const present = exps.find((exp: any) => /present|current|till date/i.test(String(exp?.duration || "")))
  if (present?.role) return String(present.role)
  if (exps[0]?.role) return String(exps[0].role)
  return ""
}

function calculateRoleMatch(requiredRole: string, candidate: any, roleScope: RoleScope): number {
  const candidateRole = getCandidateRoleText(candidate, roleScope)
  const required = requiredRole.toLowerCase()
  
  if (!candidateRole) return 0

  const candNorm = normalizeRoleText(candidateRole)
  const reqNorm = normalizeRoleText(required)
  if (candNorm && reqNorm) {
    if (candNorm.includes(reqNorm) || reqNorm.includes(candNorm)) return 1
  }

  // Comprehensive role synonyms mapping
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

  // Check if candidate has relevant skills for the role
  const allSkills = [
    ...(candidate.technicalSkills || []),
    ...(candidate.softSkills || []),
    ...(candidate.tags || [])
  ].map(skill => skill.toLowerCase())

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

function calculateExperienceScore(requiredExp: any, candidateExp: string): number {
  if (!candidateExp) return 0.3
  
  // More robust experience parsing
  const expPatterns = [
    /(\d+(?:\.\d+)?)\s*years?/,           // "5 years", "3.5 years"
    /(\d+(?:\.\d+)?)\s*yr/,               // "5 yr", "3.5 yr"
    /(\d+)\s*years?\s*(\d+)\s*months?/,  // "2 years 6 months"
    /(\d+)\s*months?/                     // "18 months"
  ]
  
  let candidateYears = 0
  let foundMatch = false
  
  for (const pattern of expPatterns) {
    const match = candidateExp.match(pattern)
    if (match) {
      if (match.length === 3 && candidateExp.includes('months')) {
        // Handle "2 years 6 months" format
        candidateYears = parseFloat(match[1]) + (parseFloat(match[2]) / 12)
      } else if (candidateExp.includes('months') && !candidateExp.includes('years')) {
        // Handle "18 months" format
        candidateYears = parseFloat(match[1]) / 12
      } else {
        // Handle "5 years" or "5 yr" format
        candidateYears = parseFloat(match[1])
      }
      foundMatch = true
      break
    }
  }
  
  if (!foundMatch) return 0.3
  
  if (requiredExp.exact) {
    return Math.abs(candidateYears - requiredExp.exact) <= 1 ? 1 : 0.3
  }
  
  if (requiredExp.min && candidateYears >= requiredExp.min) {
    return requiredExp.max && candidateYears <= requiredExp.max ? 1 : 0.8
  }
  
  // If no specific requirement, give some score based on having experience
  return candidateYears > 0 ? 0.5 : 0.2
}

function calculateLocationScore(requiredLocation: string, candidateLocation: string): number {
  if (!candidateLocation) return 0.3
  
  const required = requiredLocation.toLowerCase()
  const candidate = candidateLocation.toLowerCase()
  
  if (candidate.includes(required) || required.includes(candidate)) return 1
  
  // Check for major cities and their variations
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

function calculateSkillsScore(requiredSkills: string[], candidate: any): number {
  const allCandidateSkills = [
    ...(candidate.technicalSkills || []),
    ...(candidate.softSkills || []),
    ...(candidate.tags || [])
  ].map(skill => skill.toLowerCase())
  
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

function calculateEducationScore(requiredEducation: string, candidate: any): number {
  const candidateEducation = (candidate.highestQualification || candidate.degree || '').toLowerCase()
  const required = requiredEducation.toLowerCase()
  
  if (!candidateEducation) return 0.3
  
  if (candidateEducation.includes(required) || required.includes(candidateEducation)) return 1
  
  // Education level matching
  const educationLevels = ['high school', 'diploma', 'bachelor', 'master', 'phd']
  const candidateLevel = educationLevels.findIndex(level => candidateEducation.includes(level))
  const requiredLevel = educationLevels.findIndex(level => required.includes(level))
  
  if (candidateLevel >= 0 && requiredLevel >= 0) {
    return candidateLevel >= requiredLevel ? 0.8 : 0.4
  }
  
  return 0.2
}
