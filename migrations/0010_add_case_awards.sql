-- Migration: 0010_add_case_awards.sql
-- Purpose: Add case_awards table to track remedy amounts extracted from ERA summaries
--
-- Columns:
--   pdf_filename      — FK to seen_cases.pdf_filename (composite PK)
--   source            — FK to seen_cases.source (composite PK); default 'ERA'
--   hhd_amount        — Hurt, humiliation and distress award in NZD
--   lost_wages        — Total lost wages compensation in NZD
--   lost_wages_weeks  — Weeks of salary the lost wages figure represents
--   weekly_wage       — Weekly wage extracted from the determination (used to calculate weeks)
--   costs_awarded     — Costs order amount in NZD
--   reinstatement     — 1 if reinstatement was ordered, 0 otherwise
--   outcome           — 'applicant' | 'respondent' | 'mixed' | 'none'
--   extraction_method — 'prompt_structured' (from AWARDS_DATA block) | 'llm_backfill' (post-hoc)
--
-- UNIQUE constraint on (pdf_filename, source) means upserts are safe.

CREATE TABLE IF NOT EXISTS case_awards (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  pdf_filename       TEXT    NOT NULL,
  source             TEXT    NOT NULL DEFAULT 'ERA',
  hhd_amount         INTEGER,
  lost_wages         INTEGER,
  lost_wages_weeks   REAL,
  weekly_wage        INTEGER,
  costs_awarded      INTEGER,
  reinstatement      INTEGER NOT NULL DEFAULT 0,
  outcome            TEXT,
  extraction_method  TEXT    NOT NULL DEFAULT 'llm_backfill',
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pdf_filename, source)
);
