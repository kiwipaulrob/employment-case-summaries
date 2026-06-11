-- Migration 0011: Add preferences column to subscribers table
-- Stores per-subscriber JSON preferences e.g. {"show_costs":false,"show_consent":false}
ALTER TABLE subscribers ADD COLUMN preferences TEXT;
