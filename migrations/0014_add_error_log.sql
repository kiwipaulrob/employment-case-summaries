-- Migration: 0014_add_error_log.sql
-- Creates a dedicated error_log table for pipeline and runtime errors.
-- Replaces the single config:last_error entry with a proper log.

CREATE TABLE IF NOT EXISTS error_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  level     TEXT NOT NULL DEFAULT 'error',   -- 'error', 'warn', 'info'
  source    TEXT NOT NULL DEFAULT 'pipeline', -- 'pipeline', 'api', 'admin', 'system'
  message   TEXT NOT NULL,
  details   TEXT,                            -- optional JSON or stack trace
  case_id   TEXT,                            -- optional link to a specific case
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for ordering and filtering
CREATE INDEX IF NOT EXISTS idx_error_log_created_at ON error_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_source ON error_log(source);
CREATE INDEX IF NOT EXISTS idx_error_log_level ON error_log(level);
