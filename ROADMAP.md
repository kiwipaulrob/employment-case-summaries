# Roadmap

## 🔴 Next
- [ ] Rotate exposed Cloudflare API token and `ADMIN_SECRET`
- [ ] Apply pending migrations (0007–0012) to production D1
- [ ] Re-summarise cases processed with minimal fallback prompt (use Rescan tab)

## 🟡 Soon
- [ ] Graceful per-case PDF error handling — one bad PDF should not crash the entire batch
- [ ] Handle encrypted/password-protected PDFs (detect + skip with clear error)
- [ ] Rate limiting on `/subscribe` and `/admin` endpoints
- [ ] Prompt injection wrapper (`<document>` tags around PDF LLM input)
- [ ] Update stale `README.md` (model name, deployment method, missing migrations, API endpoints)
- [ ] Update `DEPLOYMENT.md` — browser paste method is outdated

## 💙 Eventually
- [ ] Review LLM prompt strategy — completeness-first generates very long summaries; consider brevity-first with a cheaper model
- [ ] Fix hyperlinks in 22 historic EC case summaries (ERA URLs instead of EC listing URLs)
- [ ] Timing-safe password comparison for admin login
- [ ] `summary_version` column on `seen_cases` to track which prompt version generated each summary
- [ ] JSON Mode for Claude Sonnet 4.6 (structured output instead of text parsing)
- [ ] Add audit logging for admin actions
- [ ] Monitoring and alerting for `pdf-parser-python` sidecar
- [ ] Page chunking for long EC PDFs (>100 pages) in Python sidecar
- [ ] Admin UI for notice banner, subscriber preferences, and case classification tags
- [ ] Dark mode support
- [ ] Add `package-lock.json` to repo for reproducible installs
