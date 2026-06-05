# ERA Digest Worker — Agent Handover & Maintenance Guide

_Last updated: 6 June 2026. Written for a successor agent taking over this codebase._

---

## Recent Agent Activity Log

| Date | Commit / PR | Author | What changed |
|------|------------|--------|-------------|
| 6 Jun 2026 | PR #9, #10, #11 | root (new agent) | **3 PRs shipped:** Shared utility extraction (`stripLlmArtifacts`/`sleep` → utils.ts), double-encoding guardrail, notice banner timing fix, `/admin/errors` now functional, `/admin/clear-seen` confirmation required. Closed issues #4 and #5. |
| 6 Jun 2026 | — | kiwipaulrob | Ran `scripts/seed_prompts.sql` against production D1 — `prompt_era` and `prompt_ec` rows now seeded in config table. ✅ Migration 0007 no longer blocked. |
| 6 Jun 2026 | `039234f5` | kiwipaulrob | Added this HANDOVER.md |
| 5 Jun 2026 | `15d5a6b3` | root (new agent) | README.md: replaced hardcoded `Banana1717` example with `<your-admin-secret>` placeholder. Closed issue #3. |
| 30 May 2026 | `59fc45c6` | kiwipaulrob | Added `scripts/seed_prompts.sql` |
| 29 May 2026 | `a01d9345` | kiwipaulrob | Added Prompts and Rescan tabs to admin dashboard |
| 24 May 2026 | `090a0d5e` | kiwipaulrob | Increased LLM timeout 25s → 45s |

**⚠️ README.md is partially stale** — a future agent should fix these (do NOT fix without user's knowledge as README is public):
- Model name shows `anthropic/claude-3.5-sonnet-20241022` — actual model is `anthropic/claude-sonnet-4.6`
- "Option 1: Browser Paste (Recommended)" as deployment method is wrong — deployment is via GitHub Actions
- Migration table missing `0007_add_llm_prompts.sql`
- API endpoints table incomplete (missing Prompts/Rescan/dashboard routes added in V4)
- References docs that don't exist: `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`, `docs/PYTHON-SIDECAR.md`
- "Last updated: May 2026" is stale

---

## 1. What This System Does

A fully automated legal digest service for New Zealand employment law practitioners.

**Two sources of cases:**
- **Employment Relations Authority (ERA)**: Scraped daily from `https://determinations.era.govt.nz/determinations/recent`. Fully automated.
- **Employment Court (EC)**: PDFs uploaded manually by the admin via the dashboard or batch script. EC cases are appeals from ERA decisions — they have a different structure and a different LLM prompt.

**Pipeline (runs daily at 8am NZT):**
1. Scrape ERA listing page for new case PDFs
2. Filter against D1 `seen_cases` table (deduplication by `source + pdf_filename`)
3. Acquire processing lock (10-min auto-expiry)
4. Extract text from each PDF (ERA: local FlateDecode; EC: Python sidecar via `pypdf`)
5. Send text to OpenRouter LLM → structured summary
6. Store summary in D1
7. Compose HTML email with two sections (Employment Court at top, ERA below)
8. Send to all active confirmed subscribers (25 concurrent per batch)
9. Mark cases as seen **only after** successful email send
10. Release processing lock

**Public site**: `https://whenroutinebiteshard.com`
- Landing page with hero, sign-up form, archive of last 20 cases (click-to-expand)
- Double opt-in subscription flow
- Personalised unsubscribe links

**Admin dashboard**: `https://whenroutinebiteshard.com/admin`
- Password: `<ADMIN_SECRET>` (stored in Cloudflare Worker secrets + GitHub Actions secret)
- 6 tabs: Digest Controls, EC Upload, Subscribers, Analytics, Prompts, Rescan

---

## 2. Infrastructure

| Component | Detail |
|-----------|--------|
| Runtime | Cloudflare Workers (TypeScript via Wrangler) |
| Database | Cloudflare D1 — `era-digest` (ID: `see wrangler.jsonc`) |
| Email | Cloudflare Email Service (beta) — sends from `digest@whenroutinebiteshard.com` |
| PDF parsing (EC) | Python sidecar worker `pdf-parser-python` using `pypdf 4.2.0` — called via service binding `PDF_PARSER` |
| LLM | OpenRouter → `anthropic/claude-sonnet-4.6`; `max_tokens: 4000`; timeout: 45s |
| Domain | `whenroutinebiteshard.com` — registered and DNS managed in Cloudflare |
| Cron | Dual cron: `0 20 * * *` and `0 19 * * *` (covers 8am NZT across DST) |
| Deployment | GitHub Actions on push to `main` — `npm run deploy` (no separate build step) |
| Repo | `https://github.com/kiwipaulrob/employment-case-summaries` |

**Worker secrets (set via `wrangler secret put`):**
- `OPENROUTER_API_KEY`
- `ADMIN_SECRET`

**Worker vars (in `wrangler.jsonc`):**
- `OPENROUTER_MODEL`, `SOURCE_URL`, `ADMIN_EMAIL`, `SENDING_ADDRESS`, `TIMEZONE`, `SITE_URL`, `USE_PDF_URL_PASSTHROUGH`, `TRIGGER_MODE`

---

## 3. Source File Map

```
src/
├── types.ts                    — Shared TypeScript interfaces
├── db.ts                       — All D1 queries (includes validateSummaryNotDoubleEncoded guardrail)
├── scraper.ts                  — HTMLRewriter scraper for ERA listing page
├── pdf.ts                      — Strategy B local FlateDecode PDF text extraction
├── summariser.ts               — ERA OpenRouter client; imports sleep/stripLlmArtifacts from utils
├── summariserEmploymentCourt.ts— EC OpenRouter client; 7-section format; imports sleep/stripLlmArtifacts from utils
├── emailer.ts                  — HTML email composition; two-section layout; 25 concurrent sends
├── utils.ts                    — toTitleCase, sleep, stripLlmArtifacts, validateSummaryNotDoubleEncoded, escapeHtml, etc.
├── pages.ts                    — HTML templates for public pages
├── dashboard.ts                — V4 Admin Dashboard (6 tabs; all inline HTML/JS)
└── index.ts                    — Main worker; HTTP routes; pipeline logic; notice timing fix

migrations/
├── 0001_initial.sql            — Base schema
├── 0002_seed.sql               — Initial subscriber seed
├── 0003–0006                   — Applied manually before wrangler tracked migrations
└── 0007_add_llm_prompts.sql    — ✅ Applied via seed_prompts.sql on 6 Jun 2026

python-sidecar/
└── main.py                     — Cloudflare Python worker; pypdf for EC PDFs

scripts/
├── batch_upload_ec.py          — Batch EC upload script
└── seed_prompts.sql            — SQL to seed prompt_era/prompt_ec ✅ Run on 6 Jun 2026
```

---

## 4. D1 Database Schema

See HANDOVER.md section 4 for full schema. Key additions since initial writing:
- `config` table now has `prompt_era` and `prompt_ec` rows (seeded 6 Jun 2026)
- `config` table has `last_error` row for error tracking (PR #11)

---

## 5. Outstanding Issues — Priority Order

### 🔴 CRITICAL — Security

**1. Cloudflare API token is exposed**
The token `<CLOUDFLARE_API_TOKEN — stored in GitHub Actions secrets>` has appeared in conversation history.
- Revoke at: `https://dash.cloudflare.com → Profile → API Tokens`
- Regenerate a new token with the same scopes
- Update GitHub secret `CLOUDFLARE_API_TOKEN` in the repo settings

**2. Admin secret is exposed**
`<ADMIN_SECRET>` has appeared in conversation history.
- Update GitHub secret `ADMIN_SECRET`
- Set new worker secret: `wrangler secret put ADMIN_SECRET`

---

### 🟠 HIGH — Validation (test these manually)

**3. Test the Prompts tab end-to-end** ⬅️ Now possible — config rows seeded
- Open admin dashboard → Prompts tab
- Both textareas should show the full detailed prompts (6,000+ chars)
- Edit a small word, click "Save Prompts"
- Trigger `/run` — verify changed prompt was used in LLM call

**4. Test the Rescan tab end-to-end**
- Admin dashboard → Rescan tab
- Enter N=2, click "Rescan Silently" → verify 2 rows deleted from `seen_cases`
- Enter N=2, click "Rescan & Send Now" → verify email with updated summaries

**5. Test EC PDF upload via dashboard**
- Admin dashboard → EC Upload tab
- Drag & drop a real EC PDF
- Check worker logs for PDF_PARSER service binding call

---

### 🟡 MEDIUM

**6. Review LLM prompt strategy — brevity vs completeness**
Current "Completeness is your ABSOLUTE PRIMARY goal" generates very long summaries (hitting `max_tokens: 4000`). Consider brevity-first approach with a cheaper model.

**7. Update EC case summaries with wrong hyperlinks**
Early EC cases have ERA listing URLs instead of EC listing URLs. Need rescan.

**8. Add graceful PDF error handler**
One bad PDF shouldn't crash the entire batch. Add try/catch around individual case processing.

---

### 💙 LOW — Backlog

- Prompt injection wrapper (`<document>` tags around PDF content)
- Timing-safe password compare for admin login
- `summary_version` column on `seen_cases` (migration 0008)
- JSON Mode for Claude Sonnet 4.6
- Rate limiting on `/subscribe` and `/admin`
- Audit logging
- Monitoring for `pdf-parser-python` sidecar
- Move to Cloudflare Secrets Store (when GA)
- Add `package-lock.json` to repo for reproducible installs

---

## 6. Key Behaviours & Gotchas

### PDF extraction strategy
- **ERA cases**: Strategy B (local FlateDecode/zlib in `pdf.ts`). Python sidecar NEVER called.
- **EC cases**: CID font encoding — must use `pdf-parser-python` sidecar via `PDF_PARSER` binding. 20s circuit breaker with FlateDecode fallback.

### Processing lock
- `config:is_processing = '1'` — 10-min auto-expiry. Released in `finally` block.
- If stuck: `wrangler d1 execute era-digest --remote --command "UPDATE config SET value='0' WHERE key='is_processing';"`

### Case deduplication
- Composite PK: `(source, pdf_filename)`. Cases marked as seen **only after** successful email dispatch.

### DST guard
- Dual cron (20:00 and 19:00 UTC). `hasEmailBeenSentToday()` compares stored timestamp against Pacific/Auckland date via `Intl.DateTimeFormat`.

### Notice banner
- Set via `config:email_notice`. Auto-clears **after** successful send (PR #10 fix — previously cleared before send).

### Double-encoding guardrail (PR #10)
- `validateSummaryNotDoubleEncoded()` in `db.ts` checks every summary before INSERT.
- Throws immediately if double-JSON-stringified. Admin is alerted. Email is NOT sent.

### Admin authentication
- Dashboard: cookie-based (POST `/admin` with password). API: Bearer token.
- All programmatic requests need `User-Agent: Mozilla/5.0` — Cloudflare bot protection.

---

## 7. How to Deploy

**Standard deploy (via GitHub — preferred):**
```powershell
cd C:\Users\prob\employment-case-summaries
git add .
git commit -m "Your message"
git push origin main
# GitHub Actions auto-deploys on push to main
```

**Manual deploy (fallback):**
```powershell
cd C:\Users\prob\employment-case-summaries
npm run deploy
```

---

## 8. Useful Manual Commands

```powershell
# Check migration status
wrangler d1 migrations list era-digest --remote

# Check config table
wrangler d1 execute era-digest --remote --command "SELECT key, substr(value,1,50), updated_at FROM config;"

# Clear processing lock (if stuck)
wrangler d1 execute era-digest --remote --command "UPDATE config SET value='0' WHERE key='is_processing';"

# List recent seen cases
wrangler d1 execute era-digest --remote --command "SELECT source, pdf_filename, title, processed_at FROM seen_cases ORDER BY processed_at DESC LIMIT 10;"

# Delete last N seen cases (forces rescan)
wrangler d1 execute era-digest --remote --command "DELETE FROM seen_cases WHERE rowid IN (SELECT rowid FROM seen_cases ORDER BY processed_at DESC LIMIT 5);"

# Manually trigger pipeline
curl -X POST https://whenroutinebiteshard.com/run -H "Authorization: Bearer <ADMIN_SECRET>" -H "User-Agent: Mozilla/5.0"

# Force trigger bypassing DST guard
curl -X POST "https://whenroutinebiteshard.com/run?force=true" -H "Authorization: Bearer <ADMIN_SECRET>" -H "User-Agent: Mozilla/5.0"

# Preview digest email
curl "https://whenroutinebiteshard.com/admin/preview-digest?limit=3" -H "Authorization: Bearer <ADMIN_SECRET>" -H "User-Agent: Mozilla/5.0"

# Check LLM connectivity
curl "https://whenroutinebiteshard.com/admin/test-llm" -H "Authorization: Bearer <ADMIN_SECRET>" -H "User-Agent: Mozilla/5.0"
```

---

## 9. Active Subscribers

| Email | Name | Status |
|-------|------|--------|
| paul.robertson@heaneypartners.com | Paul | Active ✅ |
| paul.a.robertson@gmail.com | Paul | Active ✅ |
| simon.a.schofield@gmail.com | Simon | Active ✅ |
| joy.walpolewilliams@heaneypartners.com | Joy | Active ✅ |

**Admin email** (error alerts): `paul.robertson@heaneypartners.com`

---

## 10. Key External Links

| Resource | URL |
|----------|-----|
| ERA recent determinations | https://determinations.era.govt.nz/determinations/recent |
| EC judgments listing | https://www.employmentcourt.govt.nz/judgments/decisions/?Filter_Jurisdiction=17 |
| EC PDF URL pattern | `https://www.employmentcourt.govt.nz/assets/Documents/Decisions/<filename>.pdf` |
| OpenRouter | https://openrouter.ai/ |
| Cloudflare dashboard | https://dash.cloudflare.com |
| GitHub repo | https://github.com/kiwipaulrob/employment-case-summaries |
| Live site | https://whenroutinebiteshard.com |
| Admin dashboard | https://whenroutinebiteshard.com/admin |
| Worker logs | Cloudflare dashboard → Workers → era-digest-worker → Logs |
| PR #9 | https://github.com/kiwipaulrob/employment-case-summaries/pull/9 |
| PR #10 | https://github.com/kiwipaulrob/employment-case-summaries/pull/10 |
| PR #11 | https://github.com/kiwipaulrob/employment-case-summaries/pull/11 |

---

_Keep this file updated after every significant code change or resolved issue._
