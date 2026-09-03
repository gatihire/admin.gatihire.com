-- Add enriched_summary JSONB column to store Gemini-analyzed transcript insights
ALTER TABLE phone_screening_participants
ADD COLUMN IF NOT EXISTS enriched_summary JSONB;

COMMENT ON COLUMN phone_screening_participants.enriched_summary IS 'Gemini-enriched analysis of call transcript: comprehensive_summary, fit_assessment, strengths, concerns, salary_analysis, relocation_assessment, recommended_next_steps, interview_focus_areas, overall_verdict, confidence_score';
