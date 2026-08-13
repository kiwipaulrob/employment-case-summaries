-- 0019: Data-block columns for multi-block extraction (Jul 2026)
-- Awards + legal issues + parties + dates + keywords (30-field upsert).
-- NOTE: already applied to production manually before this file existed —
-- do NOT re-run against prod (duplicate column name errors are expected).

ALTER TABLE case_awards ADD COLUMN legal_issues TEXT;
ALTER TABLE case_awards ADD COLUMN legal_issues_applicant_won TEXT;
ALTER TABLE case_awards ADD COLUMN legal_issues_respondent_won TEXT;
ALTER TABLE case_awards ADD COLUMN party_applicant TEXT;
ALTER TABLE case_awards ADD COLUMN party_respondent TEXT;
ALTER TABLE case_awards ADD COLUMN representative_applicant TEXT;
ALTER TABLE case_awards ADD COLUMN representative_respondent TEXT;
ALTER TABLE case_awards ADD COLUMN employment_start TEXT;
ALTER TABLE case_awards ADD COLUMN dismissal_date TEXT;
ALTER TABLE case_awards ADD COLUMN grievance_raised TEXT;
ALTER TABLE case_awards ADD COLUMN keywords TEXT;
