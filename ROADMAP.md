# Roadmap

## 🔴 Next
- [ ] Rotate exposed Cloudflare API token and `ADMIN_SECRET`
- [ ] Test Prompts tab end-to-end now that config rows are seeded
- [ ] Test Rescan tab (delete last N from `seen_cases`, rescan, re-email)

## 🟡 Soon
- [ ] Review LLM prompt strategy — completeness-first generates very long summaries; consider brevity-first with a cheaper model
- [ ] Fix EC case summaries with wrong hyperlinks (ERA URLs instead of EC listing URLs)
- [ ] Graceful per-case PDF error handling — one bad PDF should not crash the entire batch
- [ ] Update stale `README.md` (model name, deployment method, missing migrations, API endpoints)

## 💙 Eventually
- [ ] Rate limiting on `/subscribe` endpoint
- [ ] Timing-safe password comparison for admin login
- [ ] `summary_version` column on `seen_cases` (migration 0008)
- [ ] JSON Mode for Claude Sonnet 4.6 (structured output instead of text parsing)
- [ ] Audit logging (who sent what, when)
- [ ] Monitoring and alerting for `pdf-parser-python` sidecar
- [ ] Move to Cloudflare Secrets Store (when GA)
