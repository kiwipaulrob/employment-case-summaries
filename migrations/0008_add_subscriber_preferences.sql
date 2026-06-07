-- Migration 0008: Add subscriber preferences column
-- Stores JSON with show_costs / show_consent toggles

ALTER TABLE subscribers ADD COLUMN preferences TEXT NOT NULL DEFAULT '{"show_costs":false,"show_consent":false}';
