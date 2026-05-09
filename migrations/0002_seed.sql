-- Migration: 0002_seed.sql
-- Adds the V1 single subscriber (you).
-- Run via: npm run db:seed
-- For local dev: npm run db:seed:local
--
-- Replace the values below with your own details before running.

INSERT OR IGNORE INTO subscribers (email, name, active, created_at, unsubscribe_token)
VALUES (
  'paul.robertson@heaneypartners.com',
  'Paul',
  1,
  datetime('now'),
  lower(hex(randomblob(16)))
);
