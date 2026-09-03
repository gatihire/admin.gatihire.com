import { createClient } from '@supabase/supabase-js'
import {
  CLIENT_LOGOS_BUCKET_ALLOWED_MIME_TYPES,
  CLIENT_LOGOS_BUCKET_NAME,
  RESUME_BUCKET_ALLOWED_MIME_TYPES,
  RESUME_BUCKET_NAME,
} from "@/lib/constants/storage"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// For server-side operations that require elevated permissions
export const supabaseAdmin = createClient(
  supabaseUrl,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function ensureBucketExists(params: {
  bucketName: string
  public: boolean
  fileSizeLimit?: number
  allowedMimeTypes?: string[]
}) {
  const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets()
  if (listError) {
    console.error('Error checking buckets:', listError)
    return false
  }

  const existing = buckets?.find(bucket => bucket.name === params.bucketName)

  if (!existing) {
    const { error: createError } = await supabaseAdmin.storage.createBucket(params.bucketName, {
      public: params.public,
      ...(typeof params.fileSizeLimit === 'number' ? { fileSizeLimit: params.fileSizeLimit } : {}),
      ...(params.allowedMimeTypes ? { allowedMimeTypes: params.allowedMimeTypes } : {}),
    })

    if (createError) {
      console.error('Error creating bucket:', createError)
      return false
    }

    return true
  }

  if (typeof (existing as any)?.public === 'boolean' && (existing as any).public !== params.public) {
    const { error: updateError } = await supabaseAdmin.storage.updateBucket(params.bucketName, {
      public: params.public,
      ...(typeof params.fileSizeLimit === 'number' ? { fileSizeLimit: params.fileSizeLimit } : {}),
      ...(params.allowedMimeTypes ? { allowedMimeTypes: params.allowedMimeTypes } : {}),
    })
    if (updateError) {
      console.error('Error updating bucket:', updateError)
      return false
    }
  }

  return true
}

export async function ensureResumeBucketExists() {
  return ensureBucketExists({
    bucketName: RESUME_BUCKET_NAME,
    public: true,
    fileSizeLimit: 10485760,
    allowedMimeTypes: [...RESUME_BUCKET_ALLOWED_MIME_TYPES],
  })
}

export async function ensureClientLogosBucketExists() {
  return ensureBucketExists({
    bucketName: CLIENT_LOGOS_BUCKET_NAME,
    public: true,
    fileSizeLimit: 5242880,
    allowedMimeTypes: [...CLIENT_LOGOS_BUCKET_ALLOWED_MIME_TYPES],
  })
}

// Database types (generated from your schema)
export interface Database {
  public: {
    Tables: {
      candidates: {
        Row: {
          id: string
          name: string
          email: string
          phone: string | null
          date_of_birth: string | null
          gender: 'male' | 'female' | 'other' | 'prefer-not-to-say' | null
          marital_status: 'single' | 'married' | 'divorced' | 'widowed' | null
          current_role: string
          desired_role: string | null
          current_company: string | null
          location: string
          preferred_location: string | null
          looking_for_work: boolean | null
          open_job_types: string[] | null
          available_start_time: string | null
          available_end_time: string | null
          work_timezone: string | null
          available_start_date: string | null
          availability_notes: string | null
          work_availability_updated_at: string | null
          total_experience: string
          current_salary: string | null
          expected_salary: string | null
          notice_period: string | null
          highest_qualification: string | null
          degree: string | null
          specialization: string | null
          university: string | null
          education_year: string | null
          education_percentage: string | null
          additional_qualifications: string | null
          technical_skills: any[]
          soft_skills: any[]
          languages_known: any[]
          certifications: any[]
          previous_companies: any[]
          job_titles: any[]
          work_duration: any[]
          key_achievements: any[]
          projects: any[]
          awards: any[]
          publications: any[]
          references: any[]
          linkedin_profile: string | null
          portfolio_url: string | null
          github_profile: string | null
          summary: string | null
          resume_text: string | null
          file_name: string | null
          file_url: string | null
          file_hash: string | null
          file_size: number | null
          file_type: string | null
          status: 'new' | 'reviewed' | 'shortlisted' | 'rejected' | 'hired' | 'interviewed' | 'selected' | 'on-hold'
          tags: string[]
          rating: number | null
          notes: string | null
          uploaded_at: string
          updated_at: string
          last_contacted: string | null
          interview_status: 'not-scheduled' | 'scheduled' | 'completed' | 'offered' | 'accepted' | 'declined' | 'no-show' | 'rescheduled' | null
          feedback: string | null
          parsing_method: 'gemini' | 'openai' | 'manual' | null
          parsing_confidence: number | null
          parsing_errors: any[] | null
          uploaded_by: string | null
          search_vector: any
          embedding: any // vector
          source: string | null
          source_profile_id: string | null
        }
        Insert: {
          id?: string
          name: string
          email: string
          phone?: string | null
          date_of_birth?: string | null
          gender?: 'male' | 'female' | 'other' | 'prefer-not-to-say' | null
          marital_status?: 'single' | 'married' | 'divorced' | 'widowed' | null
          current_role: string
          desired_role?: string | null
          current_company?: string | null
          location: string
          preferred_location?: string | null
          looking_for_work?: boolean | null
          open_job_types?: string[] | null
          available_start_time?: string | null
          available_end_time?: string | null
          work_timezone?: string | null
          available_start_date?: string | null
          availability_notes?: string | null
          work_availability_updated_at?: string | null
          total_experience: string
          current_salary?: string | null
          expected_salary?: string | null
          notice_period?: string | null
          highest_qualification?: string | null
          degree?: string | null
          specialization?: string | null
          university?: string | null
          education_year?: string | null
          education_percentage?: string | null
          additional_qualifications?: string | null
          technical_skills?: any[]
          soft_skills?: any[]
          languages_known?: any[]
          certifications?: any[]
          previous_companies?: any[]
          job_titles?: any[]
          work_duration?: any[]
          key_achievements?: any[]
          projects?: any[]
          awards?: any[]
          publications?: any[]
          references?: any[]
          linkedin_profile?: string | null
          portfolio_url?: string | null
          github_profile?: string | null
          summary?: string | null
          resume_text?: string | null
          file_name?: string | null
          file_url?: string | null
          file_hash?: string | null
          file_size?: number | null
          file_type?: string | null
          status?: 'new' | 'reviewed' | 'shortlisted' | 'rejected' | 'hired' | 'interviewed' | 'selected' | 'on-hold' | 'offered' | 'accepted' | 'declined'
          tags?: string[]
          rating?: number | null
          notes?: string | null
          uploaded_at?: string
          updated_at?: string
          last_contacted?: string | null
          interview_status?: 'not-scheduled' | 'scheduled' | 'completed' | 'offered' | 'accepted' | 'declined' | 'no-show' | 'rescheduled' | null
          feedback?: string | null
          parsing_method?: 'gemini' | 'openai' | 'manual' | null
          parsing_confidence?: number | null
          parsing_errors?: any[] | null
          uploaded_by?: string | null
          embedding?: any // vector(768)
          source?: string | null
          source_profile_id?: string | null
        }
        Update: {
          id?: string
          name?: string
          email?: string
          phone?: string | null
          date_of_birth?: string | null
          gender?: 'male' | 'female' | 'other' | 'prefer-not-to-say' | null
          marital_status?: 'single' | 'married' | 'divorced' | 'widowed' | null
          current_role?: string
          desired_role?: string | null
          current_company?: string | null
          location?: string
          preferred_location?: string | null
          looking_for_work?: boolean | null
          open_job_types?: string[] | null
          available_start_time?: string | null
          available_end_time?: string | null
          work_timezone?: string | null
          available_start_date?: string | null
          availability_notes?: string | null
          work_availability_updated_at?: string | null
          total_experience?: string
          current_salary?: string | null
          expected_salary?: string | null
          notice_period?: string | null
          highest_qualification?: string | null
          degree?: string | null
          specialization?: string | null
          university?: string | null
          education_year?: string | null
          education_percentage?: string | null
          additional_qualifications?: string | null
          technical_skills?: any[]
          soft_skills?: any[]
          languages_known?: any[]
          certifications?: any[]
          previous_companies?: any[]
          job_titles?: any[]
          work_duration?: any[]
          key_achievements?: any[]
          projects?: any[]
          awards?: any[]
          publications?: any[]
          references?: any[]
          linkedin_profile?: string | null
          portfolio_url?: string | null
          github_profile?: string | null
          summary?: string | null
          resume_text?: string | null
          file_name?: string | null
          file_url?: string | null
          file_hash?: string | null
          file_size?: number | null
          file_type?: string | null
          status?: 'new' | 'reviewed' | 'shortlisted' | 'rejected' | 'hired' | 'interviewed' | 'selected' | 'on-hold'
          tags?: string[]
          rating?: number | null
          notes?: string | null
          uploaded_at?: string
          updated_at?: string
          last_contacted?: string | null
          interview_status?: 'not-scheduled' | 'scheduled' | 'completed' | 'offered' | 'accepted' | 'declined' | 'no-show' | 'rescheduled' | null
          feedback?: string | null
          parsing_method?: 'gemini' | 'openai' | 'manual' | null
          parsing_confidence?: number | null
          parsing_errors?: any[] | null
          uploaded_by?: string | null
          embedding?: any // vector(768)
          source?: string | null
          source_profile_id?: string | null
        }
      }
      work_experience: {
        Row: {
          id: string
          candidate_id: string
          company: string
          role: string
          duration: string
          description: string | null
          start_date: string | null
          end_date: string | null
          is_current: boolean
          created_at: string
        }
        Insert: {
          id?: string
          candidate_id: string
          company: string
          role: string
          duration: string
          description?: string | null
          start_date?: string | null
          end_date?: string | null
          is_current?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          candidate_id?: string
          company?: string
          role?: string
          duration?: string
          description?: string | null
          start_date?: string | null
          end_date?: string | null
          is_current?: boolean
          created_at?: string
        }
      },
      job_matches: {
        Row: {
          job_id: string
          candidate_id: string
          relevance_score: number | null
          match_summary: string | null
          score_breakdown: any | null
          matching_keywords: any[] | null
          matchingCriteria: any | null
          match_score: number | null
          source: string | null
          created_at: string
          updated_at: string | null
        }
        Insert: {
          job_id: string
          candidate_id: string
          relevance_score?: number | null
          match_summary?: string | null
          score_breakdown?: any | null
          matching_keywords?: any[] | null
          matchingCriteria?: any | null
          match_score?: number | null
          source?: string | null
          created_at?: string
          updated_at?: string | null
        }
        Update: {
          job_id?: string
          candidate_id?: string
          relevance_score?: number | null
          match_summary?: string | null
          score_breakdown?: any | null
          matching_keywords?: any[] | null
          matchingCriteria?: any | null
          match_score?: number | null
          source?: string | null
          created_at?: string
          updated_at?: string | null
        }
      }
      education: {
        Row: {
          id: string
          candidate_id: string
          degree: string
          specialization: string | null
          institution: string
          year: string | null
          percentage: string | null
          is_highest: boolean
          created_at: string
        }
        Insert: {
          id?: string
          candidate_id: string
          degree: string
          specialization?: string | null
          institution: string
          year?: string | null
          percentage?: string | null
          is_highest?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          candidate_id?: string
          degree?: string
          specialization?: string | null
          institution?: string
          year?: string | null
          percentage?: string | null
          is_highest?: boolean
          created_at?: string
        }
      }
      file_storage: {
        Row: {
          id: string
          candidate_id: string
          file_name: string
          file_url: string
          file_size: number
          file_type: string
          storage_provider: string
          original_path: string | null
          created_at: string
        }
        Insert: {
          id?: string
          candidate_id: string
          file_name: string
          file_url: string
          file_size: number
          file_type: string
          storage_provider?: string
          original_path?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          candidate_id?: string
          file_name?: string
          file_url?: string
          file_size?: number
          file_type?: string
          storage_provider?: string
          original_path?: string | null
          created_at?: string
        }
      }
      parsing_jobs: {
        Row: {
          id: string
          candidate_id: string | null
          file_id: string | null
          status: 'pending' | 'processing' | 'completed' | 'failed'
          parsing_method: string
          input_tokens: number | null
          output_tokens: number | null
          cost_usd: number | null
          error_message: string | null
          started_at: string | null
          completed_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          candidate_id?: string | null
          file_id?: string | null
          status?: 'pending' | 'processing' | 'completed' | 'failed'
          parsing_method: string
          input_tokens?: number | null
          output_tokens?: number | null
          cost_usd?: number | null
          error_message?: string | null
          started_at?: string | null
          completed_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          candidate_id?: string | null
          file_id?: string | null
          status?: 'pending' | 'processing' | 'completed' | 'failed'
          parsing_method?: string
          input_tokens?: number | null
          output_tokens?: number | null
          cost_usd?: number | null
          error_message?: string | null
          started_at?: string | null
          completed_at?: string | null
          created_at?: string
        }
      }
      hr_users: {
        Row: {
          id: string
          email: string
          password_hash: string
          name: string | null
          created_at: string
          last_login: string | null
        }
        Insert: {
          id?: string
          email: string
          password_hash: string
          name?: string | null
          created_at?: string
          last_login?: string | null
        }
        Update: {
          id?: string
          email?: string
          password_hash?: string
          name?: string | null
          created_at?: string
          last_login?: string | null
        }
      }
      search_logs: {
        Row: {
          id: string
          hr_user_id: string | null
          search_query: string | null
          filters: any | null
          results_count: number | null
          created_at: string
        }
        Insert: {
          id?: string
          hr_user_id?: string | null
          search_query?: string | null
          filters?: any | null
          results_count?: number | null
          created_at?: string
        }
        Update: {
          id?: string
          hr_user_id?: string | null
          search_query?: string | null
          filters?: any | null
          results_count?: number | null
          created_at?: string
        }
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      search_candidates: {
        Args: {
          search_query: string
        }
        Returns: {
          id: string
          name: string
          current_role: string
          location: string
          technical_skills: any[]
          rank: number
        }[]
      }
      search_candidates_by_skills: {
        Args: {
          skills: string[]
        }
        Returns: {
          id: string
          name: string
          current_role: string
          location: string
          technical_skills: any[]
          skill_matches: number
        }[]
      }
      get_candidate_stats: {
        Args: Record<PropertyKey, never>
        Returns: {
          total_candidates: number
          new_candidates: number
          reviewed_candidates: number
          shortlisted_candidates: number
          selected_candidates: number
          rejected_candidates: number
        }[]
      }
      verify_hr_credentials: {
        Args: {
          email_input: string
          password_input: string
        }
        Returns: {
          id: string
          email: string
          name: string
        }[]
      }
      get_hr_analytics: {
        Args: {
          target_hr_id: string
        }
        Returns: any
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
