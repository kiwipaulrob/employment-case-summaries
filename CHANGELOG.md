# Changelog

## 2026-06-05
- PR #12: Updated HANDOVER.md with session activity
- PR #11: `/admin/errors` now functional, `/admin/clear-seen` requires confirmation
- PR #10: Double-encoding guardrail added, notice banner timing fixed (clear only after successful send)
- PR #9: Shared utility extraction (`stripLlmArtifacts`, `sleep` → `utils.ts`), dynamic import replaced
- Closed issues #3 (README password), #4 (production safeguards), #5 (circuit breaker timeout)

## 2026-05-30
- Added `scripts/seed_prompts.sql` — seeds real ERA/EC prompts into D1 config table

## 2026-05-29
- Added Prompts and Rescan tabs to admin dashboard
- Prompts are now editable via the dashboard UI and loaded from D1 at runtime

## 2026-05-24
- Increased LLM timeout from 25s → 45s to fix AbortError failures on long cases
- Updated model from `claude-3.5-sonnet` → `claude-sonnet-4.6`

## 2026-05-19
- 4 critical stability fixes: sidecar crash recovery, stale processing lock (10-min timeout), truncation warnings, secure batch script

## 2026-05-17
- Increased `max_tokens` from 1200/1500 → 4000 to handle complex multi-issue cases
- GitHub Actions deployment workflow added

## 2026-05-09
- Initial project upload: scraper, summariser, emailer, D1 migrations, Python sidecar, admin dashboard, documentation
