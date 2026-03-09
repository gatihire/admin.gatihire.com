import { generateEmbedding, extractSearchKeywordsWithAI, generateWebsearchQueryFromJDWithAI, extractKeywordsFromSentence } from "@/lib/ai-utils"
import { SupabaseCandidateService } from "@/lib/supabase-candidates"
import { parseSearchRequirement, intelligentCandidateSearch, type SearchRequirement, type RoleScope } from "@/lib/intelligent-search"

// Caches
const jdRequirementsCache = new Map<string, { at: number; req: any }>()
const JD_REQUIREMENTS_TTL_MS = 10 * 60_000
const jdKeywordCache = new Map<string, { at: number; terms: string[] }>()
const JD_KEYWORDS_TTL_MS = 10 * 60_000
const jdWebsearchCache = new Map<string, { at: number; query: string }>()
const jdEmbeddingCache = new Map<string, { at: number; emb: number[] }>()
const JD_EMBEDDING_TTL_MS = 10 * 60_000

function hashKey(input: string) {
  return Buffer.from(input, 'utf8').toString('base64').slice(0, 200)
}

function parseYears(text: string) {
  const t = String(text || '')
  const m = t.match(/(\d{1,2})(?:\+)?\s*(?:years?|yrs?)/i)
  if (!m) return 0
  const v = Number(m[1])
  return Number.isFinite(v) ? v : 0
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

function expandRoleVariants(role: string) {
  const t = String(role || "").trim()
  if (!t) return []
  const parts = t.split(/\s+/).filter(Boolean)
  if (!parts.length) return [t]

  const first = parts[0]
  const lower = first.toLowerCase()
  const out = new Set<string>()
  out.add(t)

  if (lower.length > 3) {
    if (lower.endsWith("s") && !lower.endsWith("ss")) {
      const singular = first.slice(0, -1)
      out.add([singular, ...parts.slice(1)].join(" "))
    } else if (!lower.endsWith("s")) {
      out.add([first + "s", ...parts.slice(1)].join(" "))
    }
  }

  return Array.from(out)
}

function normalizeTerms(list: string[]) {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const v = String(raw || '').trim()
    if (!v) continue
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

export function parseListParam(value: string | null): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
}

function getCandidateRoleText(candidate: any, roleScope: RoleScope) {
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

export function applySidebarFilters(results: any[], filters: any) {
  return results.filter((candidate: any) => {
    if (filters.mustHaveKeywords?.length) {
      const candidateText = [
        candidate.name || "",
        candidate.currentRole || "",
        candidate.location || "",
        candidate.summary || "",
        candidate.currentCompany || "",
        ...(candidate.technicalSkills || []),
        ...(candidate.softSkills || []),
        ...(candidate.jobTitles || []),
        candidate.resumeText || "",
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
        candidate.currentRole || "",
        candidate.location || "",
        candidate.summary || "",
        candidate.currentCompany || "",
        ...(candidate.technicalSkills || []),
        ...(candidate.softSkills || []),
        ...(candidate.jobTitles || []),
        candidate.resumeText || "",
      ]
        .join(" ")
        .toLowerCase()
      const hasExcludedKeyword = filters.excludeKeywords.some((keyword: string) =>
        candidateText.includes(keyword.toLowerCase()),
      )
      if (hasExcludedKeyword) return false
    }

    if (filters.hideInactive && candidate.status === "inactive") return false

    if (filters.showOnlyAvailable) {
      const noticePeriod = candidate.noticePeriod || ""
      const isAvailable =
        noticePeriod.toLowerCase().includes("immediate") ||
        noticePeriod.toLowerCase().includes("0") ||
        noticePeriod === "" ||
        noticePeriod.toLowerCase().includes("ready")
      if (!isAvailable) return false
    }

    if (filters.currentCity?.length) {
      const candidateLocation = (candidate.location || "").toLowerCase()
      const matchesCity = filters.currentCity.some((city: string) =>
        candidateLocation.includes(city.toLowerCase()),
      )
      if (!matchesCity) return false
    }

    if (filters.experience?.min || filters.experience?.max) {
      const experienceYears = parseYears(candidate.totalExperience)
      const minExp = filters.experience.min ? Number(filters.experience.min) : 0
      const maxExp = filters.experience.max ? Number(filters.experience.max) : Infinity
      if (experienceYears < minExp || experienceYears > maxExp) return false
    }

    if (filters.salaryRange?.min || filters.salaryRange?.max) {
      const currentSalary = candidate.currentSalary || ""
      const expectedSalary = candidate.expectedSalary || ""
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
        candidate.highestQualification || "",
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
      const candidateLanguages = (candidate.languagesKnown || []).map((l: string) => l.toLowerCase())
      const matchesLanguage = filters.languages.some((lang: string) =>
        candidateLanguages.some((cl: string) => cl.includes(lang.toLowerCase())),
      )
      if (!matchesLanguage) return false
    }

    return true
  })
}

function toWebsearchOrQuery(terms: string[], maxTerms = 18) {
  return terms
    .slice(0, maxTerms)
    .map((t) => {
      const v = String(t || "").trim()
      if (!v) return ""
      return v.includes(" ") ? `"${v}"` : v
    })
    .filter(Boolean)
    .join(" OR ")
}

function sanitizeWebsearchQuery(q: string) {
  return String(q || "")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Helper for JD search scoring (copied/adapted from intelligent-search for context)
export function calculateRoleMatch(requiredRole: string, candidate: any, roleScope: RoleScope): number {
  const candRole = getCandidateRoleText(candidate, roleScope);
  const required = requiredRole.toLowerCase();
  if (!candRole) return 0;
  
  const candNorm = normalizeRoleText(candRole)
  const reqNorm = normalizeRoleText(required)
  if (candNorm && reqNorm) {
    if (candNorm.includes(reqNorm) || reqNorm.includes(candNorm)) return 1
  }

  const roleSynonyms: Record<string, string[]> = {
    'fleet manager': ['fleet management', 'transportation manager', 'logistics manager', 'operations manager', 'fleet operations manager'],
    'truck driver': ['driver', 'heavy vehicle driver', 'commercial driver', 'truck operator'],
    'logistics coordinator': ['logistics executive', 'supply chain coordinator', 'logistics specialist'],
    'operations manager': ['operations executive', 'operations head', 'operations supervisor', 'fleet manager'],
    'accounts manager': ['accountant', 'finance manager', 'finance executive', 'accounts executive']
  };

  let best = 0
  for (const [key, synonyms] of Object.entries(roleSynonyms)) {
    if (required.includes(key)) {
      if (synonyms.some(s => candRole.includes(s))) best = Math.max(best, 0.85);
    }
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

  return best;
}

export async function jdBasedSearch(jobDescription: string, extractedKeywords: string[] = [], roleScope: RoleScope): Promise<any[]> {
  console.log("=== JD-Based Search (Intelligent Extraction) ===")

  try {
    const jdText = (jobDescription || '').toLowerCase();
    
    const cacheKey = hashKey(jobDescription.trim())
    const now = Date.now()

    const cachedReq = jdRequirementsCache.get(cacheKey)
    const requirementsPromise = cachedReq && now - cachedReq.at < JD_REQUIREMENTS_TTL_MS
      ? Promise.resolve(cachedReq.req as SearchRequirement)
      : parseSearchRequirement(jobDescription).catch(() => null).then((req) => {
          jdRequirementsCache.set(cacheKey, { at: now, req })
          return req as SearchRequirement | null
        })

    const cachedKw = jdKeywordCache.get(cacheKey)
    const keywordPromise = cachedKw && now - cachedKw.at < JD_KEYWORDS_TTL_MS
      ? Promise.resolve(cachedKw.terms)
      : extractSearchKeywordsWithAI(jobDescription.slice(0, 7000))
          .catch(() => [])
          .then((terms) => {
            jdKeywordCache.set(cacheKey, { at: now, terms })
            return terms
          })

    const cachedWeb = jdWebsearchCache.get(cacheKey)
    const websearchPromise = cachedWeb && now - cachedWeb.at < JD_KEYWORDS_TTL_MS
      ? Promise.resolve(cachedWeb.query)
      : generateWebsearchQueryFromJDWithAI(jobDescription)
          .catch(() => "")
          .then((query) => {
            jdWebsearchCache.set(cacheKey, { at: now, query: String(query || "") })
            return String(query || "")
          })

    const cachedEmb = jdEmbeddingCache.get(cacheKey)
    const embeddingPromise = cachedEmb && now - cachedEmb.at < JD_EMBEDDING_TTL_MS
      ? Promise.resolve(cachedEmb.emb)
      : generateEmbedding(jobDescription.slice(0, 7000))
          .catch(() => [])
          .then((emb) => {
            jdEmbeddingCache.set(cacheKey, { at: now, emb })
            return emb
          })

    const [parsedReq, aiTerms, websearchFromAI, embedding] = await Promise.all([
      requirementsPromise,
      keywordPromise,
      websearchPromise,
      embeddingPromise,
    ])

    // 2. Extract Location and Role for heavy weighting
    const targetLocation = parsedReq?.location?.toLowerCase() || "";
    const targetRole = parsedReq?.role?.toLowerCase() || "";
    const minYears = Math.max(parseYears(jobDescription), Number(parsedReq?.experience?.min || 0) || 0)

    console.log(`Target: Role="${targetRole}", Location="${targetLocation}", Exp>=${minYears}`);

    // 3. Match skills appearing in the JD text
    const LOGISTICS_SKILLS = [
      'gps tracking', 'fleet management', 'route optimization', 'supply chain management',
      'inventory management', 'logistics planning', 'vehicle tracking', 'warehouse management',
      'transportation management', 'driver management', 'fuel management', 'maintenance scheduling',
      'compliance', 'safety regulations', 'dot regulations', 'international fuel tax agreement',
      'communication', 'problem solving', 'leadership', 'team management', 'data analysis',
    ];
    
    const matchedSkills = LOGISTICS_SKILLS.filter(skill => jdText.includes(skill.toLowerCase()));
    const skillsForSearch = matchedSkills.length > 0 ? matchedSkills : LOGISTICS_SKILLS;

    const mustPhrases = normalizeTerms([
      ...expandRoleVariants(targetRole),
      targetLocation,
      ...aiTerms,
      ...skillsForSearch,
      ...(parsedReq?.skills || []),
      'DOT', 'FMCSA', 'fleet drivers', 'preventive maintenance',
      'fuel management', 'vehicle tracking', 'driver management', 'compliance',
    ]).filter(Boolean).slice(0, 50)

    const websearchQuery = sanitizeWebsearchQuery(websearchFromAI) || toWebsearchOrQuery(mustPhrases, 20)
    const roleTerms = normalizeTerms(expandRoleVariants(targetRole))
    const roleQuery = roleTerms.length ? toWebsearchOrQuery(roleTerms, 8) : ""

    const [vectorResults, textResults, roleTextResults, currentRoleResults] = await Promise.all([
      embedding.length ? SupabaseCandidateService.searchCandidatesByEmbedding(embedding, 0.22, 350) : Promise.resolve([]),
      SupabaseCandidateService.searchCandidatesByText(websearchQuery, 800, false),
      roleQuery ? SupabaseCandidateService.searchCandidatesByText(roleQuery, 800, false) : Promise.resolve([]),
      roleScope === "current" && roleTerms.length ? SupabaseCandidateService.searchCandidatesByCurrentRole(roleTerms, 800) : Promise.resolve([]),
    ]);

    const mergedById = new Map<string, any>()
    for (const c of textResults || []) { if (c?.id) mergedById.set(String(c.id), c); }
    for (const c of vectorResults || []) {
      if (!c?.id) continue
      const id = String(c.id)
      const existing = mergedById.get(id)
      mergedById.set(id, existing ? { ...existing, ...c } : c)
    }
    for (const c of roleTextResults || []) {
      if (!c?.id) continue
      const id = String(c.id)
      const existing = mergedById.get(id)
      mergedById.set(id, existing ? { ...existing, ...c } : c)
    }
    for (const c of currentRoleResults || []) {
      if (!c?.id) continue
      const id = String(c.id)
      const existing = mergedById.get(id)
      mergedById.set(id, existing ? { ...existing, ...c } : c)
    }

    const merged = Array.from(mergedById.values())
    if (merged.length) {
      const scored = merged.map((candidate) => {
        const candText = [
          getCandidateRoleText(candidate, roleScope),
          (candidate.summary || ""),
          (candidate.resumeText || ""),
          (candidate.currentCompany || ""),
          ...(candidate.technicalSkills || []),
          ...(candidate.softSkills || []),
        ].join(" ").toLowerCase()

        // --- LOCATION SCORE (High Weight) ---
        let locationScore = 0;
        if (targetLocation) {
          const candLoc = (candidate.location || "").toLowerCase();
          if (candLoc.includes(targetLocation) || targetLocation.includes(candLoc)) {
            locationScore = 1.0;
          } else {
            // Check major city variations (synonyms)
            const variations: Record<string, string[]> = {
              'delhi': ['delhi', 'ncr', 'gurgaon', 'gurugram', 'noida', 'faridabad'],
              'mumbai': ['mumbai', 'bombay', 'navi mumbai', 'thane'],
              'bangalore': ['bangalore', 'bengaluru'],
              'gurgaon': ['gurgaon', 'gurugram', 'haryana'],
              'pune': ['pune', 'poona']
            };
            for (const [key, vars] of Object.entries(variations)) {
              if (targetLocation.includes(key) && vars.some(v => candLoc.includes(v))) {
                locationScore = 0.9;
                break;
              }
            }
          }
        }

        // --- ROLE SCORE (High Weight) ---
        let roleScore = 0;
        if (targetRole) {
          const roleText = getCandidateRoleText(candidate, roleScope)
          const roleTextNorm = normalizeRoleText(roleText)
          const targetRoleNorm = normalizeRoleText(targetRole)
          if (roleTextNorm && targetRoleNorm && roleTextNorm.includes(targetRoleNorm)) {
            roleScore = 1.0;
          } else {
            const roleMatch = calculateRoleMatch(targetRole, candidate, roleScope);
            roleScore = roleMatch;
          }
        }

        // --- SKILLS SCORE ---
        const candidateSkills = new Set((candidate.technicalSkills || []).map((s: string) => s.toLowerCase()))
        let skillHits = 0
        for (const skill of skillsForSearch) {
          if (candidateSkills.has(skill.toLowerCase()) || candText.includes(skill.toLowerCase())) skillHits += 1
        }
        const skillBase = skillHits / skillsForSearch.length

        // --- EXPERIENCE SCORE ---
        const yrs = parseYears(candidate.totalExperience)
        const expScore = minYears ? (yrs >= minYears ? 1.0 : yrs > 0 ? (yrs / minYears) : 0) : 0.5

        // --- VECTOR SIMILARITY ---
        const sim = Number((candidate as any)?.vectorSimilarity || 0)

        // --- FINAL RELEVANCE FORMULA ---
        // Weights: Role(30%), Location(30%), Skills(20%), Experience(10%), Vector Similarity(10%)
        const relevanceScore = (roleScore * 0.30) + (locationScore * 0.30) + (skillBase * 0.20) + (expScore * 0.10) + (sim * 0.10);
        const matchPercentage = Math.round(relevanceScore * 100)

        const matchingCriteria = [];
        if (roleScore > 0.5) matchingCriteria.push("Role Match");
        if (locationScore > 0.5) matchingCriteria.push("Location Match");
        if (skillHits > 0) matchingCriteria.push(`${skillHits} Skills`);
        if (expScore >= 1.0) matchingCriteria.push("Experience Match");

        return {
          ...candidate,
          relevanceScore,
          matchPercentage,
          matchingKeywords: matchedSkills.length > 0 ? matchedSkills : skillsForSearch,
          matchingCriteria,
          roleScore
        }
      })

      return scored
        .filter((c) => (c?.relevanceScore || 0) >= 0.2 && (roleScope !== "current" || !targetRole || (c?.roleScore || 0) >= 0.2))
        .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
        .slice(0, 250)
    }

    return []
  } catch (error) {
    console.error('JD analysis failed:', error);
    return [];
  }
}

export async function enhancedManualSearch(filters: any, candidates: any[], roleScope: RoleScope): Promise<any[]> {
  try {
    console.log("=== Enhanced Manual Search ===")
    console.log("Filters:", filters)

    const keywords = (filters.keywords || filters.query || '').toLowerCase().split(' ').filter((k: string) => k.length > 2);
    const location = (filters.location || '').toLowerCase();
    const minExp = parseFloat(filters.minExperience || '0');
    const maxExp = parseFloat(filters.maxExperience || '100');
    const education = (filters.education || '').toLowerCase();

    // Use intelligent parsing if keywords contain natural language
    const hasNaturalLanguage = keywords.some((k: string) => 
      k.includes('experience') || k.includes('years') || k.includes('manager') || k.includes('driver')
    );

    if (hasNaturalLanguage && keywords.length > 2) {
      console.log("Detected natural language query, using intelligent parsing")
      const query = filters.keywords || filters.query || ''
      const requirements = await parseSearchRequirement(query)
      return await intelligentCandidateSearch(requirements, candidates, { roleScope })
    }

    // Traditional keyword-based search with improved relevance scoring
    const results = candidates.map((c: any) => {
      const textBlob = [
        (c.currentRole || ''),
        (c.summary || ''),
        (c.resumeText || ''),
        (c.currentCompany || ''),
        ...(Array.isArray(c.technicalSkills) ? c.technicalSkills : []),
        ...(Array.isArray(c.softSkills) ? c.softSkills : []),
      ].join(' ').toLowerCase();

      // Calculate keyword relevance score
      let keywordScore = 0;
      let matchedKeywords: string[] = [];
      
      if (keywords.length > 0) {
        const keywordMatches = keywords.filter((k: string) => textBlob.includes(k));
        matchedKeywords = keywordMatches;
        keywordScore = keywordMatches.length / keywords.length;
      }

      // Location matching
      let locationScore = 0;
      if (location) {
        const candidateLocation = (c.location || '').toLowerCase();
        if (candidateLocation.includes(location)) {
          locationScore = 1;
        } else if (location.includes(candidateLocation)) {
          locationScore = 0.8;
        }
      }

      // Experience matching
      let experienceScore = 0;
      let candidateYears = 0;
      const expText = (c.totalExperience || '').toLowerCase();
      const expMatch = expText.match(/([0-9]+(?:\.[0-9]+)?)\s*year/);
      if (expMatch) {
        candidateYears = parseFloat(expMatch[1]);
        if ((!filters.minExperience && !filters.maxExperience) || 
            (candidateYears >= minExp && candidateYears <= maxExp)) {
          experienceScore = 1;
        }
      }

      // Education matching
      let educationScore = 0;
      if (education) {
        const candidateEducation = ((c.highestQualification || '') + ' ' + (c.degree || '')).toLowerCase();
        if (candidateEducation.includes(education)) {
          educationScore = 1;
        }
      }

      // Calculate overall relevance score
      const totalScore = (keywordScore * 0.5) + (locationScore * 0.2) + (experienceScore * 0.2) + (educationScore * 0.1);

      return {
        ...c,
        relevanceScore: Math.min(0.95, totalScore),
        matchPercentage: Math.round(totalScore * 100),
        matchingKeywords: matchedKeywords,
        searchCriteria: {
          keywords: matchedKeywords,
          location: locationScore > 0 ? c.location : null,
          experience: experienceScore > 0 ? c.totalExperience : null,
          education: educationScore > 0 ? c.highestQualification : null
        }
      };
    });

    // Filter out candidates with very low relevance and sort by relevance
    const filteredResults = results
      .filter((c: any) => c.relevanceScore >= 0.3) // Minimum 30% relevance
      .sort((a: any, b: any) => {
        if (b.relevanceScore !== a.relevanceScore) {
          return b.relevanceScore - a.relevanceScore;
        }
        const dateA = new Date(a.uploadedAt || 0).getTime();
        const dateB = new Date(b.uploadedAt || 0).getTime();
        return dateB - dateA;
      });

    console.log(`Enhanced manual search found ${filteredResults.length} relevant candidates`);
    return filteredResults;
  } catch (error) {
    console.error('Enhanced manual search failed:', error);
    return [];
  }
}
