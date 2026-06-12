-- Migration 0013: Add summary_version column to seen_cases
-- Tracks which version of the LLM prompt was used to generate each summary.
-- The version is the updated_at timestamp of the prompt_era/prompt_ec config
-- entry at the time the case was processed.
ALTER TABLE seen_cases ADD COLUMN summary_version TEXT;
