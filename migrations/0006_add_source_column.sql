-- Migration: 0006_add_source_column.sql
-- Purpose: Add multi-source support (ERA + Employment Court + others)
--
-- CHANGE: Add `source` column to seen_cases table
-- This enables tracking cases from multiple sources without PK collisions
--
-- New schema allows:
--   - ERA determinations (source = 'ERA')
--   - Employment Court judgments (source = 'EMPLOYMENT_COURT')
--   - Future sources (source = 'XXX')
--
-- The composite key is now (source, pdf_filename) — ensuring PDFs from
-- different sources don't collide even if they share the same filename.

-- SQLITE: Recreate table with new schema (SQLite does not support ALTER COLUMN)
CREATE TABLE seen_cases_new (
  source        TEXT NOT NULL,              -- 'ERA' or 'EMPLOYMENT_COURT'
  pdf_filename  TEXT NOT NULL,              -- e.g. "2026-NZERA-225.pdf"
  case_id       TEXT,                       -- informational only (may be null for EC)
  title         TEXT NOT NULL,
  case_url      TEXT NOT NULL,
  date_published TEXT NOT NULL,
  member        TEXT,
  category      TEXT,
  pdf_url       TEXT,
  summary       TEXT,
  processed_at  TEXT NOT NULL,
  PRIMARY KEY (source, pdf_filename)
);

-- Migrate existing data (all current rows are ERA source)
INSERT INTO seen_cases_new
  SELECT 'ERA', pdf_filename, case_id, title, case_url, date_published,
         member, category, pdf_url, summary, processed_at
  FROM seen_cases;

-- Drop old table
DROP TABLE seen_cases;

-- Rename new table
ALTER TABLE seen_cases_new RENAME TO seen_cases;
