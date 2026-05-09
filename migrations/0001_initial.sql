-- Migration: 0001_initial.sql
-- Creates the V1 schema for the ERA Digest Worker.
-- Run via: wrangler d1 migrations apply era-digest

-- ── seen_cases ────────────────────────────────────────────────────────────────
-- Every determination that has been processed (scraped, summarised, emailed).
-- Writing summaries here enables V2 to display an archive without re-calling the LLM.
-- V1.1 note: Consider adding a R2 key column to cache extracted PDF text.

CREATE TABLE IF NOT EXISTS seen_cases (
  case_id        TEXT PRIMARY KEY,          -- e.g. "21178"
  title          TEXT NOT NULL,
  case_url       TEXT NOT NULL,
  date_published TEXT NOT NULL,
  member         TEXT,
  category       TEXT,
  summary        TEXT,                      -- LLM-generated structured summary
  processed_at   TEXT NOT NULL              -- ISO 8601 UTC timestamp
);

-- ── subscribers ───────────────────────────────────────────────────────────────
-- Email recipients. V1: one row. V2: populated via sign-up form.

CREATE TABLE IF NOT EXISTS subscribers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT UNIQUE NOT NULL,
  name               TEXT,
  active             INTEGER NOT NULL DEFAULT 1,   -- 1=active, 0=unsubscribed
  created_at         TEXT NOT NULL,
  unsubscribe_token  TEXT UNIQUE                    -- for V2 one-click unsubscribe
);

-- ── config ────────────────────────────────────────────────────────────────────
-- Runtime key-value configuration. Allows certain settings to be changed without
-- redeployment (e.g. pausing the digest, adjusting batch behaviour).

CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Initial config rows.
-- last_run_at and last_email_sent_at are updated by the Worker after each run.
-- These seed values use the Unix epoch so the first run always proceeds.
INSERT OR IGNORE INTO config (key, value, updated_at) VALUES
  ('last_run_at',         '1970-01-01T00:00:00.000Z', datetime('now')),
  ('last_email_sent_at',  '1970-01-01T00:00:00.000Z', datetime('now')),
  ('trigger_mode',        'scheduled',                 datetime('now')),
  ('email_new_cases_only','true',                      datetime('now'));
