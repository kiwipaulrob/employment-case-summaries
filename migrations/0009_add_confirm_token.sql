-- Migration 0009: add confirm_token column to subscribers
-- Required for double opt-in subscription flow
ALTER TABLE subscribers ADD COLUMN confirm_token TEXT;
