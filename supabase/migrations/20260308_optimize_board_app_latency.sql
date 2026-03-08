CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_candidates_auth_user_id ON candidates (auth_user_id);
CREATE INDEX IF NOT EXISTS idx_candidates_email_lower ON candidates (lower(email));

CREATE INDEX IF NOT EXISTS idx_candidate_notifications_candidate_created ON candidate_notifications (candidate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_candidate_applied ON applications (candidate_id, applied_at DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_employment_type ON jobs (employment_type);
CREATE INDEX IF NOT EXISTS idx_jobs_shift_type ON jobs (shift_type);
CREATE INDEX IF NOT EXISTS idx_jobs_department_category ON jobs (department_category);
CREATE INDEX IF NOT EXISTS idx_jobs_role_category ON jobs (role_category);
CREATE INDEX IF NOT EXISTS idx_jobs_sub_category ON jobs (sub_category);

CREATE INDEX IF NOT EXISTS idx_jobs_title_trgm ON jobs USING GIN (lower(title) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_jobs_client_name_trgm ON jobs USING GIN (lower(client_name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_jobs_industry_trgm ON jobs USING GIN (lower(industry) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_jobs_department_trgm ON jobs USING GIN (lower(department_category) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_jobs_role_trgm ON jobs USING GIN (lower(role_category) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_jobs_sub_category_trgm ON jobs USING GIN (lower(sub_category) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_jobs_city_trgm ON jobs USING GIN (lower(city) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_jobs_location_trgm ON jobs USING GIN (lower(location) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_jobs_skills_must_have ON jobs USING GIN (skills_must_have);
CREATE INDEX IF NOT EXISTS idx_jobs_skills_good_to_have ON jobs USING GIN (skills_good_to_have);
