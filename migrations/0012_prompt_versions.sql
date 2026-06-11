-- Migration 0012: Prompt version history
-- Stores the last 10 versions of each LLM prompt so admins can revert changes.

CREATE TABLE IF NOT EXISTS prompt_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_key TEXT    NOT NULL,  -- 'prompt_era' or 'prompt_ec'
  content    TEXT    NOT NULL,
  saved_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prompt_versions_key_id
  ON prompt_versions (prompt_key, id DESC);
