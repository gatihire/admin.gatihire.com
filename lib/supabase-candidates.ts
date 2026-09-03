import { supabase, supabaseAdmin, Database } from './supabase'
import { ComprehensiveCandidateData } from './types'
import { BUCKET_NAME, deleteFileFromSupabase, uploadFileToSupabase } from './supabase-storage-utils'

type CandidateRow = Database['public']['Tables']['candidates']['Row']
type CandidateInsert = Database['public']['Tables']['candidates']['Insert']
type CandidateUpdate = Database['public']['Tables']['candidates']['Update']

export class SupabaseCandidateService {
  // Convert Supabase row to ComprehensiveCandidateData
  static mapRowToCandidate(row: CandidateRow): ComprehensiveCandidateData {
    return {
      id: row.id,
      _id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone || '',
      dateOfBirth: row.date_of_birth || '',
      gender: row.gender || '',
      maritalStatus: row.marital_status || '',
      currentRole: row.current_role,
      desiredRole: row.desired_role || '',
      currentCompany: row.current_company || '',
      location: row.location,
      preferredLocation: row.preferred_location || '',
      totalExperience: row.total_experience,
      currentSalary: row.current_salary || '',
      expectedSalary: row.expected_salary || '',
      noticePeriod: row.notice_period || '',
      highestQualification: row.highest_qualification || '',
      degree: row.degree || '',
      specialization: row.specialization || '',
      university: row.university || '',
      educationYear: row.education_year || '',
      educationPercentage: row.education_percentage || '',
      additionalQualifications: row.additional_qualifications || '',
      technicalSkills: row.technical_skills || [],
      softSkills: row.soft_skills || [],
      languagesKnown: row.languages_known || [],
      certifications: row.certifications || [],
      previousCompanies: row.previous_companies || [],
      jobTitles: row.job_titles || [],
      workDuration: row.work_duration || [],
      keyAchievements: row.key_achievements || [],
      workExperience: [], // Will be populated separately
      education: [], // Will be populated separately
      projects: row.projects || [],
      awards: row.awards || [],
      publications: row.publications || [],
      references: row.references || [],
      linkedinProfile: row.linkedin_profile || '',
      portfolioUrl: row.portfolio_url || '',
      githubProfile: row.github_profile || '',
      summary: row.summary || '',
      resumeText: row.resume_text || '',
      fileName: row.file_name || '',
      filePath: '', // Path in Supabase storage
      fileUrl: row.file_url || '',
      fileHash: (row as any).file_hash || '',
      status: row.status as any,
      tags: row.tags || [],
      rating: row.rating !== null ? row.rating : undefined,
      notes: row.notes || '',
      uploadedAt: row.uploaded_at,
      updatedAt: row.updated_at,
      lastContacted: row.last_contacted || '',
      interviewStatus: row.interview_status as any,
      feedback: row.feedback || '',
      uploadedBy: row.uploaded_by || undefined,
      embedding: row.embedding as any || undefined,
    }
  }

  private static buildInList(values: string[]) {
    const items = values.map((value) => `"${String(value).replace(/"/g, '\\"')}"`).join(",")
    return `(${items})`
  }

  private static async getInternalUserFilters() {
    const { data: roleRows } = await supabaseAdmin.from("user_roles").select("auth_user_id")
    const authUserIds = Array.from(
      new Set(
        (roleRows ?? [])
          .map((row: any) => String(row?.auth_user_id || "").trim())
          .filter((id: string) => id.length > 0)
      )
    )

    if (authUserIds.length === 0) return { authUserIds: [], emails: [] }

    const { data: profileRows } = await supabaseAdmin
      .from("internal_users")
      .select("email")
      .in("auth_user_id", authUserIds)

    const emails = (profileRows ?? [])
      .map((row: any) => String(row?.email || "").trim().toLowerCase())
      .filter((email: string) => email.length > 0)

    return { authUserIds, emails }
  }

  private static applyInternalUserExclusions(query: any, filters: { authUserIds: string[]; emails: string[] }) {
    if (filters.authUserIds.length > 0) {
      const list = this.buildInList(filters.authUserIds)
      query = query.or(`auth_user_id.is.null,auth_user_id.not.in.${list}`)
    }
    if (filters.emails.length > 0) {
      const list = this.buildInList(filters.emails)
      query = query.or(`email.is.null,email.not.in.${list}`)
    }
    return query
  }

  // Convert ComprehensiveCandidateData to Supabase insert format
  private static mapCandidateToInsert(candidate: Omit<ComprehensiveCandidateData, 'id'>): CandidateInsert {
    return {
      name: candidate.name,
      email: (candidate.email || '').trim().toLowerCase(),
      phone: candidate.phone || null,
      date_of_birth: candidate.dateOfBirth || null,
      gender: candidate.gender as any || null,
      marital_status: candidate.maritalStatus as any || null,
      current_role: candidate.currentRole,
      desired_role: candidate.desiredRole || null,
      current_company: candidate.currentCompany || null,
      location: candidate.location,
      preferred_location: candidate.preferredLocation || null,
      total_experience: candidate.totalExperience,
      current_salary: candidate.currentSalary || null,
      expected_salary: candidate.expectedSalary || null,
      notice_period: candidate.noticePeriod || null,
      highest_qualification: candidate.highestQualification || null,
      degree: candidate.degree || null,
      specialization: candidate.specialization || null,
      university: candidate.university || null,
      education_year: candidate.educationYear || null,
      education_percentage: candidate.educationPercentage || null,
      additional_qualifications: candidate.additionalQualifications || null,
      technical_skills: candidate.technicalSkills || [],
      soft_skills: candidate.softSkills || [],
      languages_known: candidate.languagesKnown || [],
      certifications: candidate.certifications || [],
      previous_companies: candidate.previousCompanies || [],
      job_titles: candidate.jobTitles || [],
      work_duration: candidate.workDuration || [],
      key_achievements: candidate.keyAchievements || [],
      projects: candidate.projects || [],
      awards: candidate.awards || [],
      publications: candidate.publications || [],
      references: candidate.references || [],
      linkedin_profile: candidate.linkedinProfile || null,
      portfolio_url: candidate.portfolioUrl || null,
      github_profile: candidate.githubProfile || null,
      summary: candidate.summary || null,
      resume_text: candidate.resumeText || null,
      file_name: candidate.fileName || null,
      file_url: candidate.fileUrl || null,
      file_hash: (candidate.fileHash && candidate.fileHash.trim()) ? candidate.fileHash.trim() : null,
      file_size: null, // Will be set when file is uploaded
      file_type: null, // Will be set when file is uploaded
      status: (candidate.status as any) || 'new',
      tags: candidate.tags || [],
      rating: candidate.rating || null,
      notes: candidate.notes || null,
      uploaded_at: candidate.uploadedAt || new Date().toISOString(),
      updated_at: candidate.updatedAt || new Date().toISOString(),
      last_contacted: candidate.lastContacted || null,
      interview_status: (candidate.interviewStatus as any) || 'not-scheduled',
      feedback: candidate.feedback || null,
      parsing_method: 'gemini', // Default to gemini
      parsing_confidence: 0.95, // Default confidence
      parsing_errors: [],
      uploaded_by: candidate.uploadedBy || null,
      embedding: Array.isArray(candidate.embedding) && candidate.embedding.length > 0 ? (candidate.embedding as any) : null,
    }
  }

  // Search candidates using Full Text Search (search_vector)
  static async searchCandidatesByText(query: string, limit: number = 50, includeDetails: boolean = true): Promise<ComprehensiveCandidateData[]> {
    try {
      if (!query.trim()) return [];

      // Format query for websearch_to_tsquery or plainto_tsquery
      // "websearch" handles quotes and +/- better
      const filters = await this.getInternalUserFilters()
      let queryBuilder: any = supabaseAdmin
        .from('candidates')
        .select('*')
        .textSearch('search_vector', query, {
          type: 'websearch',
          config: 'english'
        })
        .limit(limit)

      queryBuilder = this.applyInternalUserExclusions(queryBuilder, filters)
      const { data, error } = await queryBuilder

      let rows = data

      if (error) {
        console.warn('Text search failed, falling back to ilike search:', error)
        rows = null
      }

      if (!rows || rows.length === 0) {
        const terms = query
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 3)
          .slice(0, 8)

        if (!terms.length) return []

        const parts: string[] = []
        for (const t of terms) {
          const like = `%${t}%`
          parts.push(`name.ilike.${like}`)
          parts.push(`current_role.ilike.${like}`)
          parts.push(`current_company.ilike.${like}`)
          parts.push(`location.ilike.${like}`)
          parts.push(`summary.ilike.${like}`)
          parts.push(`resume_text.ilike.${like}`)
        }

        let fallbackBuilder: any = supabaseAdmin.from('candidates').select('*').or(parts.join(',')).limit(limit)
        fallbackBuilder = this.applyInternalUserExclusions(fallbackBuilder, filters)
        const { data: fallbackRows, error: fallbackError } = await fallbackBuilder
        if (fallbackError) {
          console.error('Fallback ilike search failed:', fallbackError)
          return []
        }
        rows = fallbackRows
      }

      const candidates = (rows || []).map((row: CandidateRow) => this.mapRowToCandidate(row));
      
      const candidateIds = includeDetails
        ? candidates.map((c: ComprehensiveCandidateData) => c.id).filter((id: string): id is string => !!id)
        : []
      if (candidateIds.length > 0) {
         try {
          const [{ data: workExps }, { data: educations }] = await Promise.all([
            supabaseAdmin.from('work_experience').select('*').in('candidate_id', candidateIds),
            supabaseAdmin.from('education').select('*').in('candidate_id', candidateIds)
          ]);

          const workByCandidate = new Map<string, any[]>();
          const eduByCandidate = new Map<string, any[]>();

          (workExps || []).forEach(exp => {
            const cid = exp.candidate_id;
            if (!cid) return;
            if (!workByCandidate.has(cid)) workByCandidate.set(cid, []);
            workByCandidate.get(cid)!.push({
              company: exp.company || '',
              role: exp.role || '',
              duration: exp.duration || [(exp.start_date || ''), (exp.end_date || '')].filter(Boolean).join(' - '),
              description: exp.description || ''
            });
          });

          (educations || []).forEach(edu => {
            const cid = edu.candidate_id;
            if (!cid) return;
            if (!eduByCandidate.has(cid)) eduByCandidate.set(cid, []);
            eduByCandidate.get(cid)!.push({
              degree: edu.degree || '',
              specialization: edu.specialization || '',
              institution: edu.institution || '',
              year: edu.year || [(edu.start_date || ''), (edu.end_date || '')].filter(Boolean).join(' - '),
              percentage: edu.percentage || ''
            });
          });

          candidates.forEach((c: ComprehensiveCandidateData) => {
            if (c.id) {
                c.workExperience = workByCandidate.get(c.id) || [];
                c.education = eduByCandidate.get(c.id) || [];
            }
          });
        } catch (bulkErr) {
          console.warn('Failed attaching detailed experience/education (search):', bulkErr);
        }
      }

      return candidates;
    } catch (error) {
      console.error('Failed to search candidates by text:', error);
      return [];
    }
  }

  static async searchCandidatesByCurrentRole(terms: string[], limit: number = 200): Promise<ComprehensiveCandidateData[]> {
    try {
      const cleanTerms = Array.from(new Set((terms || []).map((t) => String(t || "").trim()).filter(Boolean))).slice(0, 8)
      if (cleanTerms.length === 0) return []

      const filters = await this.getInternalUserFilters()
      const clauses = cleanTerms.map((t) => `current_role.ilike.%${t}%`)
      let queryBuilder: any = supabaseAdmin
        .from('candidates')
        .select('*')
        .or(clauses.join(','))
        .limit(limit)

      queryBuilder = this.applyInternalUserExclusions(queryBuilder, filters)
      const { data, error } = await queryBuilder
      if (error) {
        console.error('Current role search failed:', error)
        return []
      }

      return (data || []).map((row: CandidateRow) => this.mapRowToCandidate(row))
    } catch (error) {
      console.error('Failed to search candidates by current role:', error)
      return []
    }
  }

  // Get all candidates
  static async getAllCandidates(includeDetails: boolean = true): Promise<ComprehensiveCandidateData[]> {
    try {
      const filters = await this.getInternalUserFilters()
      let queryBuilder: any = supabase
        .from('candidates')
        .select('*')
        .order('uploaded_at', { ascending: false })
        .or('source.is.null,source.neq.juicebox')

      queryBuilder = this.applyInternalUserExclusions(queryBuilder, filters)
      const { data, error } = await queryBuilder

      if (error) {
        console.error('Error fetching candidates:', error)
        throw error
      }

      const candidates = (data || []).map((row: CandidateRow) => this.mapRowToCandidate(row))

      // Attach detailed work experience and education in bulk
      if (includeDetails) {
        const candidateIds = candidates.map((c: ComprehensiveCandidateData) => c.id).filter((id: string): id is string => !!id)
        if (candidateIds.length > 0) {
          try {
            const chunkSize = 200
            const chunkedIds: string[][] = []
            for (let i = 0; i < candidateIds.length; i += chunkSize) {
              chunkedIds.push(candidateIds.slice(i, i + chunkSize))
            }

            let workExpsAll: any[] = []
            let educationsAll: any[] = []

            for (const chunk of chunkedIds) {
              const [{ data: workExps, error: workErr }, { data: educations, error: eduErr }] = await Promise.all([
                supabase.from('work_experience').select('*').in('candidate_id', chunk),
                supabase.from('education').select('*').in('candidate_id', chunk)
              ])
              if (workErr) console.warn('Work experience fetch (bulk) error:', workErr)
              if (eduErr) console.warn('Education fetch (bulk) error:', eduErr)
              workExpsAll = workExpsAll.concat(workExps || [])
              educationsAll = educationsAll.concat(educations || [])
            }

            const workByCandidate = new Map<string, any[]>()
            const eduByCandidate = new Map<string, any[]>()

            ;(workExpsAll || []).forEach(exp => {
              const cid = exp.candidate_id
              if (!workByCandidate.has(cid)) workByCandidate.set(cid, [])
              workByCandidate.get(cid)!.push({
                company: exp.company || '',
                role: exp.role || '',
                duration: exp.duration || [(exp.start_date || ''), (exp.end_date || '')].filter(Boolean).join(' - '),
                description: exp.description || ''
              })
            })

            ;(educationsAll || []).forEach(edu => {
              const cid = edu.candidate_id
              if (!eduByCandidate.has(cid)) eduByCandidate.set(cid, [])
              eduByCandidate.get(cid)!.push({
                degree: edu.degree || '',
                specialization: edu.specialization || '',
                institution: edu.institution || '',
                year: edu.year || [(edu.start_date || ''), (edu.end_date || '')].filter(Boolean).join(' - '),
                percentage: edu.percentage || ''
              })
            })

            candidates.forEach((c: ComprehensiveCandidateData) => {
              const cid = c.id
              if (cid) {
                c.workExperience = workByCandidate.get(cid) || []
                c.education = eduByCandidate.get(cid) || []
              }
            })
          } catch (bulkErr) {
            console.warn('Failed attaching detailed experience/education (bulk):', bulkErr)
          }
        }
      }

      return candidates
    } catch (error) {
      console.error('Failed to get all candidates:', error)
      throw error
    }
  }

  // Add paginated fetch with optional search and sorting
  static async getCandidatesPaginated(options: {
    page?: number,
    perPage?: number,
    sortBy?: string,
    sortOrder?: 'asc' | 'desc',
    search?: string,
    status?: string
  } = {}): Promise<{ items: ComprehensiveCandidateData[], total: number, page: number, perPage: number }> {
    const page = Math.max(1, options.page ?? 1)
    const perPage = Math.min(200, Math.max(1, options.perPage ?? 20))
    const sortBy = options.sortBy ?? 'uploaded_at'
    const sortOrder = options.sortOrder ?? 'desc'
    const search = (options.search ?? '').trim()
    const status = options.status ?? 'all'

    const from = (page - 1) * perPage
    const to = from + perPage - 1

    try {
      const filters = await this.getInternalUserFilters()
      let query = supabaseAdmin
        .from('candidates')
        .select('*', { count: 'exact' })
        .order(sortBy, { ascending: sortOrder === 'asc' })
        .or('source.is.null,source.neq.juicebox')

      // Apply status filter if not 'all'
      if (status && status !== 'all') {
        query = query.eq('status', status)
      }

      if (search) {
        // Comprehensive search across all relevant text fields
        // This searches the ENTIRE database, not just the current page
        // Note: JSONB fields are included in search_vector for full-text search
        // but we can't use ::text casting in PostgREST .or() filters
        const searchTerm = `%${search.trim()}%`
        
        // Build search conditions for all searchable text fields
        // These fields cover most searchable content:
        // - Personal info: name, email, phone
        // - Professional: current_role, desired_role, current_company
        // - Location: location
        // - Education: university, degree
        // - Content: summary, resume_text (includes most JSONB data when parsed)
        const searchConditions = [
          `name.ilike.${searchTerm}`,
          `location.ilike.${searchTerm}`,
          `current_role.ilike.${searchTerm}`,
          `desired_role.ilike.${searchTerm}`,
          `summary.ilike.${searchTerm}`,
          `current_company.ilike.${searchTerm}`,
          `email.ilike.${searchTerm}`,
          `phone.ilike.${searchTerm}`,
          `resume_text.ilike.${searchTerm}`, // Contains most candidate data including skills
          `university.ilike.${searchTerm}`,
          `degree.ilike.${searchTerm}`
        ]
        
        // Apply OR filter - searches across ALL candidates in database before pagination
        query = query.or(searchConditions.join(','))
      }

      query = this.applyInternalUserExclusions(query, filters)

      // IMPORTANT: Apply range (pagination) AFTER filters to ensure we search entire database first
      const { data, error, count } = await query.range(from, to)

      if (error) {
        console.error('Error fetching candidates (paginated):', error)
        throw error
      }

      const candidates = (data || []).map((row: CandidateRow) => this.mapRowToCandidate(row))

      // Attach detailed work experience and education for the paginated set
      const candidateIds = candidates.map((c: ComprehensiveCandidateData) => c.id).filter(Boolean)
      if (candidateIds.length > 0) {
        try {
          const [{ data: workExps, error: workErr }, { data: educations, error: eduErr }] = await Promise.all([
            supabaseAdmin.from('work_experience').select('*').in('candidate_id', candidateIds),
            supabaseAdmin.from('education').select('*').in('candidate_id', candidateIds)
          ])

          if (workErr) console.warn('Work experience fetch (paginated) error:', workErr)
          if (eduErr) console.warn('Education fetch (paginated) error:', eduErr)

          const workByCandidate = new Map<string, any[]>()
          const eduByCandidate = new Map<string, any[]>()

          ;(workExps || []).forEach(exp => {
            const cid = exp.candidate_id
            if (!workByCandidate.has(cid)) workByCandidate.set(cid, [])
            workByCandidate.get(cid)!.push({
              company: exp.company || '',
              role: exp.role || '',
              duration: exp.duration || [(exp.start_date || ''), (exp.end_date || '')].filter(Boolean).join(' - '),
              description: exp.description || ''
            })
          })

          ;(educations || []).forEach(edu => {
            const cid = edu.candidate_id
            if (!eduByCandidate.has(cid)) eduByCandidate.set(cid, [])
            eduByCandidate.get(cid)!.push({
              degree: edu.degree || '',
              specialization: edu.specialization || '',
              institution: edu.institution || '',
              year: edu.year || [(edu.start_date || ''), (edu.end_date || '')].filter(Boolean).join(' - '),
              percentage: edu.percentage || ''
            })
          })

          candidates.forEach((c: ComprehensiveCandidateData) => {
            if (c.id) {
                c.workExperience = workByCandidate.get(c.id) || [];
                c.education = eduByCandidate.get(c.id) || [];
            }
          })
        } catch (bulkErr) {
          console.warn('Failed attaching detailed experience/education (paginated):', bulkErr)
        }
      }

      return { items: candidates, total: count ?? 0, page, perPage }
    } catch (error) {
      console.error('Failed to get candidates paginated:', error)
      throw error
    }
  }

  // Get candidate by ID
  static async getCandidate(id: string): Promise<ComprehensiveCandidateData | null> {
    try {
      const { data, error } = await supabase
        .from('candidates')
        .select('*')
        .eq('id', id)
        .single()

      if (error) {
        console.error('Error fetching candidate:', error)
        throw error
      }

      if (!data) {
        return null
      }

      // Convert to ComprehensiveCandidateData format
      const candidate = this.mapRowToCandidate(data)

      // Get file URL if available
      if (data.file_name) {
        try {
          const { data: urlData } = await supabase
            .storage
            .from(BUCKET_NAME)
            .createSignedUrl(data.file_name, 60 * 60) // 1 hour expiry

          if (urlData) {
            candidate.filePath = data.file_name
            candidate.fileUrl = urlData.signedUrl
          }
        } catch (urlError) {
          console.error('Error getting file URL:', urlError)
          // Continue without the URL
        }
      }

      // Fetch work experience data
      try {
        const { data: workExperienceData, error: workExperienceError } = await supabase
          .from('work_experience')
          .select('*')
          .eq('candidate_id', id)
          .order('start_date', { ascending: false })

        if (workExperienceError) {
          console.error('Error fetching work experience:', workExperienceError)
        } else if (workExperienceData && workExperienceData.length > 0) {
          candidate.workExperience = workExperienceData.map(exp => ({
            company: exp.company || '',
            role: exp.role || '',
            duration: exp.duration || [(exp.start_date || ''), (exp.end_date || '')].filter(Boolean).join(' - '),
            description: exp.description || ''
          }))
        }
      } catch (workExpError) {
        console.error('Failed to fetch work experience:', workExpError)
        // Continue without work experience data
      }

      // Fetch education data
      try {
        const { data: educationData, error: educationError } = await supabase
          .from('education')
          .select('*')
          .eq('candidate_id', id)
          .order('year', { ascending: false })

        if (educationError) {
          console.error('Error fetching education:', educationError)
        } else if (educationData && educationData.length > 0) {
          candidate.education = educationData.map(edu => ({
            degree: edu.degree || '',
            specialization: edu.specialization || '',
            institution: edu.institution || '',
            year: edu.year || [(edu.start_date || ''), (edu.end_date || '')].filter(Boolean).join(' - '),
            percentage: edu.percentage || ''
          }))
        }
      } catch (eduError) {
        console.error('Failed to fetch education:', eduError)
        // Continue without education data
      }

      return candidate
    } catch (error) {
      console.error('Failed to get candidate:', error)
      throw error
    }
  }

  // Add new candidate
  static async addCandidate(candidate: Omit<ComprehensiveCandidateData, 'id'>): Promise<string> {
    try {
      const candidateData = this.mapCandidateToInsert(candidate)
      
      const { data, error } = await supabaseAdmin
        .from('candidates')
        .insert([candidateData])
        .select('id')
        .single()

      if (error) {
        console.error('Error adding candidate:', error)
        throw error
      }
      
      const candidateId = data.id;
      
      // Store work experience data if available
      if (candidate.workExperience && candidate.workExperience.length > 0) {
        for (const exp of candidate.workExperience) {
          const { error: insertError } = await supabaseAdmin
            .from('work_experience')
            .insert({
              candidate_id: candidateId,
              company: exp.company || '',
              role: exp.role || '',
              duration: exp.duration || '',
              description: exp.description || ''
            })
          
          if (insertError) {
            console.error('Error inserting work experience:', insertError)
            // Continue with other entries even if one fails
          }
        }
      }
      
      // Store education data if available
      if (candidate.education && candidate.education.length > 0) {
        for (const edu of candidate.education) {
          const { error: insertError } = await supabaseAdmin
            .from('education')
            .insert({
              candidate_id: candidateId,
              degree: edu.degree || '',
              specialization: edu.specialization || '',
              institution: edu.institution || '',
              year: edu.year || '',
              percentage: edu.percentage || '',
              description: null,
              coursework: null,
              projects: null,
              achievements: null,
              start_date: null,
              end_date: null
            })
          
          if (insertError) {
            console.error('Error inserting education:', insertError)
            // Continue with other entries even if one fails
          }
        }
      }

      return candidateId;
    } catch (error) {
      console.error('Failed to add candidate:', error)
      throw error
    }
  }
  
  // Get candidate by email
  static async getCandidateByEmail(email: string): Promise<ComprehensiveCandidateData | null> {
    try {
      const normalized = email.trim()
      const { data, error } = await supabase
        .from('candidates')
        .select('*')
        .eq('email', normalized)
        .single()
      
      if (error) {
        // Fallback to case-insensitive search
        const { data: list, error: listErr } = await supabase
          .from('candidates')
          .select('*')
          .ilike('email', normalized)
          .limit(1)
        
        if (listErr) {
          return null
        }
        
        const row = (list || [])[0]
        if (!row) return null
        return this.mapRowToCandidate(row)
      }
      
      return data ? this.mapRowToCandidate(data) : null
    } catch (e) {
      return null
    }
  }

  static async getCandidateByEmailAndPhone(email: string, phone: string): Promise<ComprehensiveCandidateData | null> {
    try {
      const e = (email || '').trim()
      const p = (phone || '').trim()
      if (!e || !p) return null

      const { data, error } = await supabase
        .from('candidates')
        .select('*')
        .ilike('email', e)
        .eq('phone', p)
        .limit(1)

      if (error) {
        return null
      }

      const row = (data || [])[0]
      return row ? this.mapRowToCandidate(row) : null
    } catch (e) {
      return null
    }
  }

  static async getCandidateByPhone(phone: string): Promise<ComprehensiveCandidateData | null> {
    try {
      const normalized = phone.trim()
      if (!normalized) return null

      const { data, error } = await supabase
        .from('candidates')
        .select('*')
        .eq('phone', normalized)
        .limit(1)

      if (error) {
        return null
      }

      const row = (data || [])[0]
      return row ? this.mapRowToCandidate(row) : null
    } catch (e) {
      return null
    }
  }

  static async getCandidateByFileUrl(fileUrl: string): Promise<ComprehensiveCandidateData | null> {
    try {
      const normalized = (fileUrl || '').trim()
      if (!normalized) return null

      const { data, error } = await supabase
        .from('candidates')
        .select('*')
        .eq('file_url', normalized)
        .limit(1)

      if (error) {
        return null
      }

      const row = (data || [])[0]
      return row ? this.mapRowToCandidate(row) : null
    } catch (e) {
      return null
    }
  }

  static async getCandidateByFileName(fileName: string): Promise<ComprehensiveCandidateData | null> {
    try {
      const normalized = (fileName || '').trim()
      if (!normalized) return null

      const { data, error } = await supabase
        .from('candidates')
        .select('*')
        .eq('file_name', normalized)
        .limit(1)

      if (error) {
        return null
      }

      const row = (data || [])[0]
      return row ? this.mapRowToCandidate(row) : null
    } catch (e) {
      return null
    }
  }

  static async getCandidateByFileHash(fileHash: string): Promise<ComprehensiveCandidateData | null> {
    try {
      const h = (fileHash || '').trim()
      if (!h) return null

      const { data, error } = await supabase
        .from('candidates')
        .select('*')
        .eq('file_hash', h)
        .limit(1)

      if (error) {
        return null
      }

      const row = (data || [])[0]
      return row ? this.mapRowToCandidate(row) : null
    } catch (e) {
      return null
    }
  }

  static async getCandidateByNameAndPhone(name: string, phone: string): Promise<ComprehensiveCandidateData | null> {
    try {
      const n = (name || '').trim()
      const p = (phone || '').trim()
      if (!n || !p) return null

      const { data, error } = await supabase
        .from('candidates')
        .select('*')
        .eq('name', n)
        .eq('phone', p)
        .limit(1)

      if (error) {
        return null
      }

      const row = (data || [])[0]
      return row ? this.mapRowToCandidate(row) : null
    } catch (e) {
      return null
    }
  }

  static async getCandidateByNameAndLocation(name: string, location: string): Promise<ComprehensiveCandidateData | null> {
    try {
      const n = (name || '').trim()
      const l = (location || '').trim()
      if (!n || !l) return null

      const { data, error } = await supabase
        .from('candidates')
        .select('*')
        .eq('name', n)
        .eq('location', l)
        .limit(1)

      if (error) {
        return null
      }

      const row = (data || [])[0]
      return row ? this.mapRowToCandidate(row) : null
    } catch (e) {
      return null
    }
  }

  // Update candidate
  static async updateCandidate(id: string, updates: Partial<ComprehensiveCandidateData>): Promise<void> {
    try {
      const updateData: Partial<CandidateUpdate> = {}
      
      // Map only the fields that are being updated
      if (updates.name !== undefined) updateData.name = updates.name
      if (updates.email !== undefined) updateData.email = (updates.email || '').trim().toLowerCase()
      if (updates.phone !== undefined) updateData.phone = updates.phone
      if (updates.dateOfBirth !== undefined) updateData.date_of_birth = updates.dateOfBirth || null
      if (updates.gender !== undefined) updateData.gender = (updates.gender as any) || null
      if (updates.maritalStatus !== undefined) updateData.marital_status = (updates.maritalStatus as any) || null
      if (updates.currentRole !== undefined) updateData.current_role = updates.currentRole
      if (updates.desiredRole !== undefined) updateData.desired_role = updates.desiredRole || null
      if (updates.currentCompany !== undefined) updateData.current_company = updates.currentCompany || null
      if (updates.location !== undefined) updateData.location = updates.location
      if (updates.preferredLocation !== undefined) updateData.preferred_location = updates.preferredLocation || null
      if (updates.totalExperience !== undefined) updateData.total_experience = updates.totalExperience
      if (updates.currentSalary !== undefined) updateData.current_salary = updates.currentSalary || null
      if (updates.expectedSalary !== undefined) updateData.expected_salary = updates.expectedSalary || null
      if (updates.noticePeriod !== undefined) updateData.notice_period = updates.noticePeriod || null
      if (updates.highestQualification !== undefined) updateData.highest_qualification = updates.highestQualification || null
      if (updates.degree !== undefined) updateData.degree = updates.degree || null
      if (updates.specialization !== undefined) updateData.specialization = updates.specialization || null
      if (updates.university !== undefined) updateData.university = updates.university || null
      if (updates.educationYear !== undefined) updateData.education_year = updates.educationYear || null
      if (updates.educationPercentage !== undefined) updateData.education_percentage = updates.educationPercentage || null
      if (updates.additionalQualifications !== undefined) updateData.additional_qualifications = updates.additionalQualifications || null
      if (updates.technicalSkills !== undefined) updateData.technical_skills = updates.technicalSkills
      if (updates.softSkills !== undefined) updateData.soft_skills = updates.softSkills
      if (updates.languagesKnown !== undefined) updateData.languages_known = updates.languagesKnown
      if (updates.certifications !== undefined) updateData.certifications = updates.certifications
      if (updates.previousCompanies !== undefined) updateData.previous_companies = updates.previousCompanies
      if (updates.jobTitles !== undefined) updateData.job_titles = updates.jobTitles
      if (updates.workDuration !== undefined) updateData.work_duration = updates.workDuration
      if (updates.keyAchievements !== undefined) updateData.key_achievements = updates.keyAchievements
      if (updates.projects !== undefined) updateData.projects = updates.projects
      if (updates.awards !== undefined) updateData.awards = updates.awards
      if (updates.publications !== undefined) updateData.publications = updates.publications
      if (updates.references !== undefined) updateData.references = updates.references
      if (updates.linkedinProfile !== undefined) updateData.linkedin_profile = updates.linkedinProfile || null
      if (updates.portfolioUrl !== undefined) updateData.portfolio_url = updates.portfolioUrl || null
      if (updates.githubProfile !== undefined) updateData.github_profile = updates.githubProfile || null
      if (updates.summary !== undefined) updateData.summary = updates.summary || null
      if (updates.resumeText !== undefined) updateData.resume_text = updates.resumeText || null
      if (updates.fileName !== undefined) updateData.file_name = updates.fileName || null
      if (updates.fileUrl !== undefined) updateData.file_url = updates.fileUrl || null
      if (updates.status !== undefined) updateData.status = updates.status
      if (updates.notes !== undefined) updateData.notes = updates.notes
      if (updates.rating !== undefined) updateData.rating = updates.rating
      if (updates.tags !== undefined) updateData.tags = updates.tags
      if (updates.interviewStatus !== undefined) updateData.interview_status = updates.interviewStatus
      if (updates.feedback !== undefined) updateData.feedback = updates.feedback
      if (updates.uploadedBy !== undefined) updateData.uploaded_by = updates.uploadedBy
      if ((updates as any).parsing_method !== undefined) (updateData as any).parsing_method = (updates as any).parsing_method || null
      if ((updates as any).parsing_confidence !== undefined) (updateData as any).parsing_confidence = (updates as any).parsing_confidence ?? null
      if ((updates as any).parsing_errors !== undefined) (updateData as any).parsing_errors = (updates as any).parsing_errors || []
      if (updates.fileHash !== undefined) {
        const fh = (updates.fileHash || '').trim()
        ;(updateData as any).file_hash = fh ? fh : null
      }
      if (updates.embedding !== undefined) {
        updateData.embedding = Array.isArray(updates.embedding) && updates.embedding.length > 0 ? (updates.embedding as any) : null
      }
      
      // Handle timestamp safely: avoid sending empty string to timestamptz column
      if (updates.lastContacted !== undefined) {
        const lc = updates.lastContacted as any
        if (typeof lc === 'string' && lc.trim() === '') {
          // Skip updating last_contacted when empty string provided
        } else if (lc === null) {
          updateData.last_contacted = null
        } else {
          // If a date-like value is provided, normalize to ISO; otherwise, pass through
          const d = new Date(lc)
          updateData.last_contacted = isNaN(d.getTime()) ? lc : d.toISOString()
        }
      }
      
      // Always update the updated_at timestamp
      updateData.updated_at = new Date().toISOString()

      const { error } = await supabaseAdmin
        .from('candidates')
        .update(updateData)
        .eq('id', id)

      if (error) {
        console.error('Error updating candidate:', error)
        throw error
      }
      
      // Handle work experience separately if provided
      if (updates.workExperience && updates.workExperience.length > 0) {
        // First delete existing work experience entries for this candidate
        const { error: deleteError } = await supabaseAdmin
          .from('work_experience')
          .delete()
          .eq('candidate_id', id)
          
        if (deleteError) {
          console.error('Error deleting existing work experience:', deleteError)
          throw deleteError
        }
        
        // Then insert new work experience entries
        for (const exp of updates.workExperience) {
          const { error: insertError } = await supabaseAdmin
            .from('work_experience')
            .insert({
              candidate_id: id,
              company: exp.company || '',
              role: exp.role || '',
              duration: exp.duration || '',
              description: exp.description || ''
            })
            
          if (insertError) {
            console.error('Error inserting work experience:', insertError)
            throw insertError
          }
        }
      }
      
      // Handle education separately if provided
      if (updates.education && updates.education.length > 0) {
        // First delete existing education entries for this candidate
        const { error: deleteError } = await supabaseAdmin
          .from('education')
          .delete()
          .eq('candidate_id', id)
          
        if (deleteError) {
          console.error('Error deleting existing education:', deleteError)
          throw deleteError
        }
        
        // Then insert new education entries
        for (const edu of updates.education) {
          const { error: insertError } = await supabaseAdmin
            .from('education')
            .insert({
              candidate_id: id,
              degree: edu.degree || '',
              specialization: edu.specialization || '',
              institution: edu.institution || '',
              year: edu.year || '',
              percentage: edu.percentage || ''
            })
            
          if (insertError) {
            console.error('Error inserting education:', insertError)
            throw insertError
          }
        }
      }
    } catch (error) {
      console.error('Failed to update candidate:', error)
      throw error
    }
  }

  // Delete candidate
  static async deleteCandidate(id: string): Promise<boolean> {
    try {
      // 1. Get candidate info to find file name
      const { data: candidate, error: fetchErr } = await supabaseAdmin
        .from('candidates')
        .select('file_name, auth_user_id')
        .eq('id', id)
        .single()

      if (fetchErr) {
        console.error('Error fetching candidate for deletion:', fetchErr)
        throw fetchErr
      }

      // 2. Delete file from storage if it exists
      if (candidate?.file_name) {
        try {
          await deleteFileFromSupabase(candidate.file_name)
          console.log(`Deleted file ${candidate.file_name} from storage`)
        } catch (storageErr) {
          console.warn('Failed to delete file from storage during candidate deletion:', storageErr)
          // Continue deleting the record even if file deletion fails
        }
      }

      // 3. Delete from related tables (in case CASCADE is not set up)
      await Promise.all([
        supabaseAdmin.from('work_experience').delete().eq('candidate_id', id),
        supabaseAdmin.from('education').delete().eq('candidate_id', id),
        supabaseAdmin.from('file_storage').delete().eq('candidate_id', id),
        supabaseAdmin.from('parsing_jobs').delete().eq('candidate_id', id),
        supabaseAdmin.from('resume_parse_jobs').delete().eq('candidate_id', id),
        supabaseAdmin.from('applications').delete().eq('candidate_id', id),
        supabaseAdmin.from('job_invites').delete().eq('candidate_id', id),
      ])

      // 4. Delete the candidate record
      const { error: deleteErr } = await supabaseAdmin
        .from('candidates')
        .delete()
        .eq('id', id)

      if (deleteErr) {
        console.error('Error deleting candidate record:', deleteErr)
        throw deleteErr
      }

      return true
    } catch (error) {
      console.error('Failed to delete candidate:', error)
      throw error
    }
  }
  
  // Reparse candidate
  static async reparseCandidate(candidateId: string, fileUrl: string, fileName: string): Promise<boolean> {
    try {
      console.log(`=== Reparsing Candidate ${candidateId} from original file ===`)
      
      // Resolve a valid blob URL
      let resolvedUrl = fileUrl
      const looksLikeUrl = typeof resolvedUrl === "string" && /^https?:\/\//i.test(resolvedUrl)
      if (!looksLikeUrl) {
        console.log("URL is not a valid URL. Attempting to resolve via Supabase Storage...")
        // Try using filePath (often a pathname) first
        if (fileUrl && typeof fileUrl === "string") {
          const attempt1 = await this.checkFileExistsInStorage(fileUrl)
          if (attempt1.exists && attempt1.url) {
            resolvedUrl = attempt1.url
            console.log("Resolved from filePath/pathname:", resolvedUrl)
          }
        }
        // Try using provided fileName
        if (!/^https?:\/\//i.test(resolvedUrl) && fileName) {
          const attempt2 = await this.checkFileExistsInStorage(fileName)
          if (attempt2.exists && attempt2.url) {
            resolvedUrl = attempt2.url
            console.log("Resolved from fileName:", resolvedUrl)
          }
        }
        if (!/^https?:\/\//i.test(resolvedUrl)) {
          throw new Error(`Unable to resolve a valid file URL for reparsing. Got "${fileUrl}"`) 
        }
      }

      // Download the file
      const response = await fetch(resolvedUrl)
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status} ${response.statusText}`)
      }
      
      // Get the file content as buffer
      const buffer = await response.arrayBuffer()
      
      // Create a file-like object compatible with Node.js environment
      const file = {
        name: fileName,
        type: response.headers.get('content-type') || 'application/octet-stream',
        arrayBuffer: async () => buffer,
        text: async () => new TextDecoder().decode(buffer),
        size: buffer.byteLength
      }
      
      // Parse the resume
      const { parseResume } = require('./resume-parser')
      const parsedData = await parseResume(file)
      
      // Generate embedding if resume text is available
      if (parsedData.resumeText) {
        try {
          const { generateEmbedding } = require('./ai-utils')
          const embedding = await generateEmbedding(parsedData.resumeText)
          parsedData.embedding = embedding
        } catch (embError) {
          console.error('Failed to generate embedding during reparse:', embError)
          // Continue without embedding update
        }
      }
      
      // Update the candidate with new parsed data
      // PREVENT OVERWRITING ORIGINAL FILE URL
      parsedData.fileUrl = fileUrl
      parsedData.fileName = fileName
      
      await this.updateCandidate(candidateId, parsedData)
      
      return true
    } catch (error) {
      console.error('Failed to reparse candidate:', error)
      throw error
    }
  }
  
  // Check if file exists in storage
  static async checkFileExistsInStorage(filePath: string): Promise<{exists: boolean, url?: string}> {
    try {
      // Clean up the path - remove any leading slashes or bucket prefixes
      const cleanPath = filePath.replace(/^\/+/, '').replace(/^resume-files\//, '')
      
      // Try to get the public URL
      const { data } = supabase.storage
        .from(BUCKET_NAME)
        .getPublicUrl(cleanPath)
      
      // Check if the file exists by making a HEAD request
      const response = await fetch(data.publicUrl, { method: 'HEAD' })
      
      return {
        exists: response.ok,
        url: response.ok ? data.publicUrl : undefined
      }
    } catch (error) {
      console.error('Error checking file existence:', error)
      return { exists: false }
    }
  }
  
  // Search candidates using full-text search
  static async searchCandidates(query: string): Promise<ComprehensiveCandidateData[]> {
    try {
      const { data, error } = await supabaseAdmin
        .rpc('search_candidates', { search_query: query })

      if (error) {
        console.error('Error searching candidates:', error)
        throw error
      }

      // Get full candidate data for search results
      const candidateIds = (data || []).map((result: any) => result.result_id || result.id).filter(Boolean)
      
      if (candidateIds.length === 0) {
        return []
      }

      const filters = await this.getInternalUserFilters()
      let queryBuilder = supabaseAdmin.from('candidates').select('*').in('id', candidateIds)
      queryBuilder = this.applyInternalUserExclusions(queryBuilder, filters)
      const { data: candidates, error: candidatesError } = await queryBuilder

      if (candidatesError) {
        console.error('Error fetching search results:', candidatesError)
        throw candidatesError
      }

      return (candidates || []).map((row: CandidateRow) => this.mapRowToCandidate(row))
    } catch (error) {
      console.error('Failed to search candidates:', error)
      throw error
    }
  }

  // Search candidates by skills
  static async searchCandidatesBySkills(skills: string[]): Promise<ComprehensiveCandidateData[]> {
    try {
      const { data, error } = await supabaseAdmin
        .rpc('search_candidates_by_skills', { skills })

      if (error) {
        const msg = String((error as any)?.message || "")
        const code = String((error as any)?.code || "")
        if (code === "42883" && /unnest\(jsonb\) does not exist/i.test(msg)) {
          console.warn("Skill search RPC is incompatible with current DB schema (technical_skills is jsonb). Falling back.")
          return []
        }
        console.error('Error searching candidates by skills:', error)
        throw error
      }

      // Get full candidate data for search results
      const candidateIds = (data || []).map((result: any) => result.result_id || result.id).filter(Boolean)
      
      if (candidateIds.length === 0) {
        return []
      }

      const filters = await this.getInternalUserFilters()
      let queryBuilder = supabaseAdmin.from('candidates').select('*').in('id', candidateIds)
      queryBuilder = this.applyInternalUserExclusions(queryBuilder, filters)
      const { data: candidates, error: candidatesError } = await queryBuilder

      if (candidatesError) {
        console.error('Error fetching skill search results:', candidatesError)
        throw candidatesError
      }

      return (candidates || []).map((row: CandidateRow) => this.mapRowToCandidate(row))
    } catch (error) {
      console.error('Failed to search candidates by skills:', error)
      throw error
    }
  }

  // Search candidates by embedding (vector search)
  static async searchCandidatesByEmbedding(embedding: number[], threshold: number = 0.6, limit: number = 50): Promise<ComprehensiveCandidateData[]> {
    try {
      if (!embedding || embedding.length === 0) {
        console.warn('Empty embedding provided for vector search')
        return []
      }

      // Call the match_candidates function - Supabase will handle vector conversion
      const { data, error } = await supabaseAdmin
        .rpc('match_candidates', {
          query_embedding: embedding,
          match_threshold: threshold,
          match_count: limit
        })

      if (error) {
        console.error('Error in vector search:', error)
        return []
      }

      if (!data || data.length === 0) {
        return []
      }

      // Extract candidate IDs and sort by similarity
      const candidateIds = data.map((result: any) => result.id)
      const similarityMap = new Map(data.map((r: any) => [r.id, r.similarity]))

      // Fetch full candidate data
      const filters = await this.getInternalUserFilters()
      let queryBuilder = supabaseAdmin.from('candidates').select('*').in('id', candidateIds)
      queryBuilder = this.applyInternalUserExclusions(queryBuilder, filters)
      const { data: candidates, error: candidatesError } = await queryBuilder

      if (candidatesError) {
        console.error('Error fetching vector search results:', candidatesError)
        throw candidatesError
      }

      // Map to ComprehensiveCandidateData and preserve similarity score
      const results = (candidates || []).map((row: CandidateRow) => {
        const candidate = this.mapRowToCandidate(row)
        // Attach similarity score for relevance ranking
        ;(candidate as any).vectorSimilarity = similarityMap.get(row.id) || 0
        return candidate
      })

      // Sort by similarity (highest first)
      return results.sort((a, b) => {
        const simA = (a as any).vectorSimilarity || 0
        const simB = (b as any).vectorSimilarity || 0
        return simB - simA
      })
    } catch (error) {
      console.error('Failed to search candidates by embedding:', error)
      return []
    }
  }

  // Get analytics/statistics
  static async getAnalytics(period = "all"): Promise<any> {
    try {
      // Get basic stats
      const { data: stats, error: statsError } = await supabase
        .rpc('get_candidate_stats')

      if (statsError) {
        console.error('Error fetching stats:', statsError)
        throw statsError
      }

      const statsData = stats?.[0] || {
        total_candidates: 0,
        new_candidates: 0,
        reviewed_candidates: 0,
        shortlisted_candidates: 0,
        selected_candidates: 0,
        rejected_candidates: 0
      }

      // Get recent uploads
      const { data: recentCandidates, error: recentError } = await supabase
        .from('candidates')
        .select('*')
        .order('uploaded_at', { ascending: false })
        .limit(10)

      if (recentError) {
        console.error('Error fetching recent candidates:', recentError)
        throw recentError
      }

      // Get breakdown by role
      const { data: roleBreakdown, error: roleError } = await supabase
        .from('candidates')
        .select('current_role')
        .not('current_role', 'is', null)

      if (roleError) {
        console.error('Error fetching role breakdown:', roleError)
        throw roleError
      }

      // Get breakdown by location
      const { data: locationBreakdown, error: locationError } = await supabase
        .from('candidates')
        .select('location')
        .not('location', 'is', null)

      if (locationError) {
        console.error('Error fetching location breakdown:', locationError)
        throw locationError
      }

      // Process breakdowns
      const roleStats = (roleBreakdown || []).reduce((acc: any, row: any) => {
        acc[row.current_role] = (acc[row.current_role] || 0) + 1
        return acc
      }, {})

      const locationStats = (locationBreakdown || []).reduce((acc: any, row: any) => {
        acc[row.location] = (acc[row.location] || 0) + 1
        return acc
      }, {})

      return {
        totalResumes: statsData.total_candidates,
        totalCandidates: statsData.total_candidates,
        statusBreakdown: {
          new: statsData.new_candidates,
          reviewed: statsData.reviewed_candidates,
          shortlisted: statsData.shortlisted_candidates,
          selected: statsData.selected_candidates,
          rejected: statsData.rejected_candidates,
        },
        roleBreakdown: roleStats,
        locationBreakdown: locationStats,
        recentUploads: (recentCandidates || []).map(candidate => this.mapRowToCandidate(candidate))
      }
    } catch (error) {
      console.error('Failed to get analytics:', error)
      throw error
    }
  }

  // Get candidate by ID (alias for getCandidate for backward compatibility)
  static async getCandidateById(id: string): Promise<ComprehensiveCandidateData | null> {
    return this.getCandidate(id);
  }

  // Upload file to Supabase Storage
  static async uploadFile(file: File, candidateId: string): Promise<string> {
    try {
      const nameParts = String(file.name || "").split(".")
      const extFromName = nameParts.length > 1 ? nameParts[nameParts.length - 1].toLowerCase() : ""
      const extFromType = String((file as any)?.type || "").includes("pdf")
        ? "pdf"
        : String((file as any)?.type || "").includes("word")
          ? "docx"
          : ""
      const fileExt = extFromName || extFromType || "pdf"

      const fileBuffer = await file.arrayBuffer()
      const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer)
      const hashArray = Array.from(new Uint8Array(hashBuffer))
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')

      const { data: existing } = await supabaseAdmin
        .from('candidates')
        .select('file_url,file_hash')
        .eq('id', candidateId)
        .single()

      const existingHash = (existing as any)?.file_hash ? String((existing as any).file_hash) : ""
      const existingUrl = (existing as any)?.file_url ? String((existing as any).file_url) : ""
      if (existingHash && existingHash === hashHex && existingUrl) {
        return existingUrl
      }

      const storageObjectName = `${candidateId}.${fileExt}`
      const fileBlob = new Blob([new Uint8Array(fileBuffer)], { type: (file as any)?.type || undefined })
      const { url: publicUrl } = await uploadFileToSupabase(fileBlob, storageObjectName)

      const parseStoragePath = (url: string): string => {
        const u = String(url || "")
        const i = u.indexOf(`${BUCKET_NAME}/`)
        if (i < 0) return ""
        const rest = u.slice(i + BUCKET_NAME.length + 1)
        const q = rest.indexOf("?")
        return q >= 0 ? rest.slice(0, q) : rest
      }

      const oldPath = existingUrl ? parseStoragePath(existingUrl) : ""
      if (oldPath && oldPath !== storageObjectName) {
        try {
          await deleteFileFromSupabase(oldPath)
        } catch {
        }
      }

      await this.updateCandidate(candidateId, {
        fileName: file.name,
        fileUrl: publicUrl,
        fileHash: hashHex,
      })

      return publicUrl
    } catch (error) {
      console.error('Failed to upload file:', error)
      throw error
    }
  }

  // Delete file from Supabase Storage
  static async deleteFile(filePath: string): Promise<{ error: any }> {
    try {
      console.log(`Deleting file from Supabase Storage: ${filePath}`)
      
      // Use the improved deleteFileFromSupabase function
      const ok = await deleteFileFromSupabase(filePath)
      if (!ok) return { error: new Error('Failed to delete file from storage') }

      console.log(`✅ File deleted from Supabase Storage: ${filePath}`)
      return { error: null }
    } catch (error) {
      console.error('Failed to delete file from storage:', error)
      return { error: error as Error }
    }
  }

  // Test connection
  static async testConnection(): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('candidates')
        .select('count')
        .limit(1)

      if (error) {
        console.error('Database connection failed:', error)
        return false
      }

      console.log('✅ Supabase connection successful')
      return true
    } catch (error) {
      console.error('Database connection failed:', error)
      return false
    }
  }
}
