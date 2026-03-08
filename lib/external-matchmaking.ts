import { supabaseAdmin } from "./supabase"
import { logger } from "./logger"
import { generateEmbedding } from "./ai-utils"

interface MatchmakingCandidate {
  id: string
  name: string
  email: string
  phone?: string
  current_role: string
  location: string
  technical_skills: string[]
  resume_text?: string
  embedding?: number[]
}

interface JobMatch {
  candidate: MatchmakingCandidate
  score: number
  matchedSkills: string[]
  explanation: string
}

export class ExternalMatchmakingService {
  /**
   * Find similar candidates for external job openings
   * Uses less restrictive matching criteria
   */
  async findSimilarCandidates(jobId: string, jobTitle: string, jobDescription: string, jobRequirements: string[]): Promise<JobMatch[]> {
    try {
      // Get job embedding for semantic search
      const jobText = `${jobTitle} ${jobDescription} ${jobRequirements.join(" ")}`
      const jobEmbedding = await generateEmbedding(jobText)

      // Get all candidates with embeddings
      const { data: candidates, error } = await supabaseAdmin
        .from("candidates")
        .select("id, name, email, phone, current_role, location, technical_skills, resume_text, embedding")
        .not("embedding", "is", null)
        .limit(100) // Limit for performance

      if (error) {
        logger.error("Error fetching candidates for matchmaking", error)
        return []
      }

      if (!candidates || candidates.length === 0) {
        logger.info("No candidates with embeddings found for matchmaking")
        return []
      }

      // Calculate similarity scores using less restrictive criteria
      const matches: JobMatch[] = []
      
      for (const candidate of candidates) {
        const score = this.calculateSimilarityScore(
          jobTitle,
          jobDescription,
          jobRequirements,
          candidate as MatchmakingCandidate,
          jobEmbedding
        )

        if (score >= 0.3) { // Lower threshold for external candidates
          const matchedSkills = this.findMatchedSkills(jobRequirements, candidate.technical_skills || [])
          
          matches.push({
            candidate: candidate as MatchmakingCandidate,
            score,
            matchedSkills,
            explanation: this.generateMatchExplanation(score, matchedSkills, candidate.current_role, jobTitle)
          })
        }
      }

      // Sort by score descending
      matches.sort((a, b) => b.score - a.score)
      
      logger.info(`Found ${matches.length} similar candidates for external job ${jobId}`)
      return matches.slice(0, 20) // Return top 20 matches

    } catch (error: any) {
      logger.error(`Error in external matchmaking for job ${jobId}`, error)
      return []
    }
  }

  /**
   * Calculate similarity score using multiple factors
   */
  private calculateSimilarityScore(
    jobTitle: string,
    jobDescription: string,
    jobRequirements: string[],
    candidate: MatchmakingCandidate,
    jobEmbedding: number[]
  ): number {
    let totalScore = 0
    let factors = 0

    // 1. Role similarity (30% weight)
    const roleScore = this.calculateRoleSimilarity(jobTitle, candidate.current_role)
    totalScore += roleScore * 0.3
    factors++

    // 2. Skills match (40% weight)
    const skillsScore = this.calculateSkillsMatch(jobRequirements, candidate.technical_skills || [])
    totalScore += skillsScore * 0.4
    factors++

    // 3. Location compatibility (20% weight)
    const locationScore = this.calculateLocationCompatibility(jobDescription, candidate.location)
    totalScore += locationScore * 0.2
    factors++

    // 4. Experience level (10% weight)
    const experienceScore = this.calculateExperienceMatch(jobDescription, candidate.resume_text || "")
    totalScore += experienceScore * 0.1
    factors++

    return factors > 0 ? totalScore / factors : 0
  }

  /**
   * Calculate role similarity using keyword matching
   */
  private calculateRoleSimilarity(jobTitle: string, candidateRole: string): number {
    const jobKeywords = this.extractKeywords(jobTitle)
    const candidateKeywords = this.extractKeywords(candidateRole)
    
    const commonKeywords = jobKeywords.filter(keyword => 
      candidateKeywords.some(candidateKeyword => 
        candidateKeyword.toLowerCase().includes(keyword.toLowerCase()) ||
        keyword.toLowerCase().includes(candidateKeyword.toLowerCase())
      )
    )

    return commonKeywords.length > 0 ? commonKeywords.length / Math.max(jobKeywords.length, candidateKeywords.length) : 0
  }

  /**
   * Calculate skills match percentage
   */
  private calculateSkillsMatch(jobRequirements: string[], candidateSkills: string[]): number {
    if (!candidateSkills.length) return 0

    const jobSkills = this.extractSkillsFromRequirements(jobRequirements)
    const matchedSkills = jobSkills.filter(jobSkill =>
      candidateSkills.some(candidateSkill =>
        candidateSkill.toLowerCase().includes(jobSkill.toLowerCase()) ||
        jobSkill.toLowerCase().includes(candidateSkill.toLowerCase())
      )
    )

    return matchedSkills.length > 0 ? matchedSkills.length / jobSkills.length : 0
  }

  /**
   * Calculate location compatibility
   */
  private calculateLocationCompatibility(jobDescription: string, candidateLocation: string): number {
    const jobLocations = this.extractLocations(jobDescription)
    
    if (jobLocations.length === 0) return 0.5 // Neutral if no location specified

    const isRemote = jobDescription.toLowerCase().includes("remote") || 
                     jobDescription.toLowerCase().includes("work from home") ||
                     jobDescription.toLowerCase().includes("wfh")

    if (isRemote) return 0.8 // High score for remote positions

    return jobLocations.some(jobLocation => 
      candidateLocation.toLowerCase().includes(jobLocation.toLowerCase()) ||
      jobLocation.toLowerCase().includes(candidateLocation.toLowerCase())
    ) ? 0.9 : 0.2
  }

  /**
   * Calculate experience level match
   */
  private calculateExperienceMatch(jobDescription: string, candidateResume: string): number {
    const jobExperienceLevel = this.extractExperienceLevel(jobDescription)
    const candidateExperienceLevel = this.extractExperienceLevel(candidateResume)

    if (jobExperienceLevel === "any" || candidateExperienceLevel === "any") return 0.5
    
    const levels = ["entry", "mid", "senior", "lead", "principal"]
    const jobLevelIndex = levels.indexOf(jobExperienceLevel)
    const candidateLevelIndex = levels.indexOf(candidateExperienceLevel)

    if (jobLevelIndex === -1 || candidateLevelIndex === -1) return 0.3

    const levelDifference = Math.abs(jobLevelIndex - candidateLevelIndex)
    return Math.max(0.2, 1 - (levelDifference * 0.2))
  }

  /**
   * Extract keywords from text
   */
  private extractKeywords(text: string): string[] {
    const stopWords = new Set(["the", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "a", "an"])
    const words = text.toLowerCase().split(/\s+/).filter(word => word.length > 2 && !stopWords.has(word))
    return [...new Set(words)]
  }

  /**
   * Extract skills from job requirements
   */
  private extractSkillsFromRequirements(requirements: string[]): string[] {
    const skills: string[] = []
    const skillKeywords = [
      "javascript", "python", "java", "react", "node", "angular", "vue", "typescript",
      "aws", "docker", "kubernetes", "git", "sql", "mongodb", "postgresql", "mysql",
      "html", "css", "sass", "webpack", "babel", "jest", "cypress", "selenium",
      "leadership", "communication", "teamwork", "problem solving", "analytical",
      "project management", "agile", "scrum", "kanban", "devops", "ci/cd"
    ]

    requirements.forEach(requirement => {
      skillKeywords.forEach(keyword => {
        if (requirement.toLowerCase().includes(keyword)) {
          skills.push(keyword)
        }
      })
    })

    return [...new Set(skills)]
  }

  /**
   * Extract locations from text
   */
  private extractLocations(text: string): string[] {
    const locationKeywords = ["remote", "hybrid", "onsite", "office", "location", "city", "state"]
    const locations: string[] = []
    
    locationKeywords.forEach(keyword => {
      if (text.toLowerCase().includes(keyword)) {
        locations.push(keyword)
      }
    })

    return locations
  }

  /**
   * Extract experience level from text
   */
  private extractExperienceLevel(text: string): string {
    const lowerText = text.toLowerCase()
    
    if (lowerText.includes("entry") || lowerText.includes("junior") || lowerText.includes("0-2")) return "entry"
    if (lowerText.includes("mid") || lowerText.includes("2-5") || lowerText.includes("3-5")) return "mid"
    if (lowerText.includes("senior") || lowerText.includes("5-8") || lowerText.includes("5+")) return "senior"
    if (lowerText.includes("lead") || lowerText.includes("principal") || lowerText.includes("8+")) return "lead"
    
    return "any"
  }

  /**
   * Find matched skills between job and candidate
   */
  private findMatchedSkills(jobRequirements: string[], candidateSkills: string[]): string[] {
    const jobSkills = this.extractSkillsFromRequirements(jobRequirements)
    
    return jobSkills.filter(jobSkill =>
      candidateSkills.some(candidateSkill =>
        candidateSkill.toLowerCase().includes(jobSkill.toLowerCase()) ||
        jobSkill.toLowerCase().includes(candidateSkill.toLowerCase())
      )
    )
  }

  /**
   * Generate match explanation
   */
  private generateMatchExplanation(score: number, matchedSkills: string[], candidateRole: string, jobTitle: string): string {
    const explanations: string[] = []

    if (score >= 0.7) {
      explanations.push("Strong overall match")
    } else if (score >= 0.5) {
      explanations.push("Good overall match")
    } else {
      explanations.push("Moderate match potential")
    }

    if (matchedSkills.length > 0) {
      explanations.push(`Relevant skills: ${matchedSkills.slice(0, 3).join(", ")}`)
    }

    if (candidateRole.toLowerCase().includes(jobTitle.toLowerCase()) || jobTitle.toLowerCase().includes(candidateRole.toLowerCase())) {
      explanations.push("Similar role experience")
    }

    return explanations.join(" • ")
  }
}

export const externalMatchmakingService = new ExternalMatchmakingService()