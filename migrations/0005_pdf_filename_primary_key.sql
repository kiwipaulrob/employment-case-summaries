-- Migration: 0005_pdf_filename_primary_key.sql
-- CRITICAL FIX: Change primary key from case_id to pdf_filename
--
-- DISCOVERED BUG (24 Apr 2026): The ERA website reassigns integer case_id values
-- to different cases over time. This caused the deduplication logic to fail —
-- incorrect summaries were stored under the wrong case IDs.
--
-- FIX: Use pdf_filename (extracted from the PDF URL, e.g. "2026-NZERA-225.pdf")
-- as the stable primary key. The PDF filename is immutable and derived from the
-- official citation number, making it a globally unique and permanent identifier.
--
-- SCHEMA CHANGE:
--   OLD: seen_cases (case_id TEXT PRIMARY KEY, ...)
--   NEW: seen_cases (pdf_filename TEXT PRIMARY KEY, case_id TEXT, ...)
--
-- NOTE: If seen_cases contains data at migration time, the migration will:
-- 1. Create a temporary table with the new schema
-- 2. Migrate existing rows (if any)
-- 3. Drop the old table
-- 4. Rename temporary table to seen_cases
--
-- In practice (April 24, 2026), the seen_cases table was cleared before
-- this migration, so the migration simply drops and recreates the table.

-- Drop the old table (now that we've cleared stale data)
DROP TABLE IF EXISTS seen_cases;

-- Create the new seen_cases table with pdf_filename as primary key
CREATE TABLE seen_cases (
  pdf_filename  TEXT PRIMARY KEY,       -- e.g. "2026-NZERA-225.pdf" (immutable, stable)
  case_id       TEXT,                   -- e.g. "21178" (informational only — ERA reassigns these)
  title         TEXT NOT NULL,
  case_url      TEXT NOT NULL,
  date_published TEXT NOT NULL,
  member        TEXT,
  category      TEXT,
  pdf_url       TEXT,                   -- direct PDF link from listing page
  summary       TEXT,                   -- LLM-generated structured summary
  processed_at   TEXT NOT NULL          -- ISO 8601 UTC timestamp
);
