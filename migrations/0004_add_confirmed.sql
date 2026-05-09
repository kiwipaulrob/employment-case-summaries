-- Migration 0004: Add confirmed column to subscribers
-- Existing manually-seeded rows default to confirmed = 1 (already active).
-- New sign-ups via the web form start with confirmed = 0 until they
-- click the confirmation link sent to their email.
ALTER TABLE subscribers ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 1;
