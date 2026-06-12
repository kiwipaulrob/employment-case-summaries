-- Migration: 0015_add_extended_awards.sql
-- Purpose: Add new fields to case_awards for grievance type, contributory
-- conduct, penalties, employment tenure, and decision date tracking.
--
-- The AWARDS_DATA block in the LLM prompt now emits additional fields.
-- These columns store them for display on the /awards page.

ALTER TABLE case_awards ADD COLUMN decision_date TEXT;
ALTER TABLE case_awards ADD COLUMN employment_tenure TEXT;
ALTER TABLE case_awards ADD COLUMN contribution_applied INTEGER NOT NULL DEFAULT 0;
ALTER TABLE case_awards ADD COLUMN contribution_reduction TEXT;
ALTER TABLE case_awards ADD COLUMN contribution_conduct TEXT;
ALTER TABLE case_awards ADD COLUMN penalties INTEGER;
ALTER TABLE case_awards ADD COLUMN costs_awarded_text TEXT;
