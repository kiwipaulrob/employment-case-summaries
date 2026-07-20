-- 0013_add_seen_cases_indexes.sql
-- Applied: 7 Jul 2026
-- Fixes D1 timeout issues on digest queries

CREATE INDEX IF NOT EXISTS idx_seen_cases_source_pdf_filename ON seen_cases(source, pdf_filename);
CREATE INDEX IF NOT EXISTS idx_seen_cases_source_processed_at ON seen_cases(source, processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_seen_cases_processed_at ON seen_cases(processed_at DESC);
