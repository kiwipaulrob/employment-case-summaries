# ERA Digest Worker — Agent Handover & Maintenance Guide

_Last updated: 6 June 2026. Written for a successor agent taking over this codebase._

---

## Recent Agent Activity Log

| Date | Commit | Author | What changed |
|------|--------|--------|-------------|
| 6 Jun 2026 | `039234f5` | kiwipaulrob | Added this HANDOVER.md |
| 5 Jun 2026 | `15d5a6b3` | root (new agent) | README.md: replaced hardcoded `Banana1717` example with `<your-admin-secret>` placeholder. Closed issue #3. ✅ Correct, low-risk fix. No source code touched. |
| 30 May 2026 | `59fc45c6` | kiwipaulrob | Added `scripts/seed_prompts.sql` — seeds real ERA/EC prompts into D1 |
| 29 May 2026 | `a01d9345` | kiwipaulrob | Added Prompts and Rescan tabs to admin dashboard (dashboard.ts 743 lines) |
| 24 May 2026 | `090a0d5e` | kiwipaulrob | Increased LLM timeout from 25s → 45s to fix AbortError failures |

**⚠️ README.md is partially stale** — a future agent should fix these (do NOT fix without user's knowledge as README is public):
- Model name shows `anthropic/claude-3.5-sonnet-20241022` — actual model is `anthropic/claude-sonnet-4.6`
- "Option 1: Browser Paste (Recommended)" as deployment method is wrong — deployment is via GitHub Actions
- Migration table missing `0007_add_llm_prompts.sql`
- API endpoints table incomplete (missing Prompts/Rescan/dashboard routes added in V4)
- References docs that don't exist: `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`, `docs/PYTHON_SIDECAR.md`
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
- Password: `<ADMIN_SECRET>` (stored in Cloudflare Worker secrets + GitHub Actions secret) (⚠️ should be rotated — see Outstanding Issues)
- 6 tabs: Overview, EC Upload, Analytics, Prompts, Rescan, [EC Upload duplicate — legacy]

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
| Cloudflare Account ID | See Cloudflare dashboard or ask Paul |

**Worker secrets (set via `wrangler secret put`):**
- `OPENROUTER_API_KEY`
- `ADMIN_SECRET`

**Worker vars (in `wrangler.jsonc`):**
- `OPENROUTER_MODEL`, `SOURCE_URL`, `ADMIN_EMAIL`, `SENDING_ADDRESS`, `TIMEZONE`, `SITE_URL`, `USE_PDF_URL_PASSTHROUGH`, `TRIGGER_MODE`

**Agent sandbox copy of repo:** `/agent/home/era-digest-worker/`
(This is the canonical working copy for the agent. Always check it matches GitHub `main` before making changes.)

---

## 3. Source File Map

```
src/
├── types.ts                    — Shared TypeScript interfaces (CaseListing, ProcessedCase, DbSeenCase, DbSubscriber, DbConfig, Env, SummaryResult, OpenRouter types)
├── db.ts                       — All D1 queries (seen cases, subscribers, config, processing lock, prompts)
├── scraper.ts                  — HTMLRewriter scraper for ERA listing page; extracts citation into `category` field
├── pdf.ts                      — Strategy B local FlateDecode PDF text extraction; getPdfContentFromBuffer() for EC uploads
├── summariser.ts               — ERA OpenRouter client; reads prompt_era from D1 at runtime; strips LLM preambles
├── summariserEmploymentCourt.ts— EC OpenRouter client; reads prompt_ec from D1 at runtime; 7-section format
├── emailer.ts                  — HTML email composition; two-section layout (EC top, ERA below); notice banner; 25 concurrent sends
├── utils.ts                    — toTitleCase (particles-first, preserves ALL-CAPS abbreviations), stripBullets, generateToken, SECTION_LABEL_MAP
├── pages.ts                    — HTML templates for public/landing/confirm/unsubscribe pages
├── dashboard.ts                — V4 Admin Dashboard (743 lines); 6 tabs; all inline HTML/JS
└── index.ts                    — Main worker; all HTTP routes; full pipeline logic (1110 lines)

migrations/
├── 0001_initial.sql            — Base schema (seen_cases, subscribers, config)
├── 0002_seed.sql               — Initial subscriber seed
├── 0003_add_pdf_url.sql        — ⚠️ Applied manually before wrangler tracked migrations
├── 0004_add_confirmed.sql      — ⚠️ Applied manually before wrangler tracked migrations
├── 0005_pdf_filename_primary_key.sql — ⚠️ Applied manually before wrangler tracked migrations
├── 0006_add_source_column.sql  — ⚠️ Applied manually before wrangler tracked migrations
└── 0007_add_llm_prompts.sql    — ⚠️ NOT yet applied — seeds prompt_era/prompt_ec into config table

python-sidecar/
└── main.py                     — Cloudflare Python worker; uses pypdf to extract text from EC PDFs; handles CID fonts

scripts/
├── batch_upload_ec.py          — Batch EC upload script (requires local Python + pdfminer)
└── seed_prompts.sql            — SQL to seed prompt_era and prompt_ec into config table (run this!)
```

---

## 4. D1 Database Schema

### `seen_cases`
| Column | Type | Notes |
|--------|------|-------|
| `source` | TEXT | `'ERA'` or `'EMPLOYMENT_COURT'` — composite PK part 1 |
| `pdf_filename` | TEXT | e.g. `2026-NZERA-225.pdf` — composite PK part 2 |
| `case_id` | TEXT | ERA case ID (non-unique; null for EC) |
| `title` | TEXT | Case name (title-cased) |
| `case_url` | TEXT | Link to case listing page |
| `pdf_url` | TEXT | Direct PDF download URL |
| `date_published` | TEXT | Publication date string |
| `member` | TEXT | Adjudicator/judge name |
| `category` | TEXT | Citation number e.g. `[2026] NZERA 229` |
| `summary` | TEXT | LLM-generated structured summary |
| `processed_at` | TEXT | ISO 8601 UTC timestamp |

### `subscribers`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | PK |
| `email` | TEXT | Unique |
| `name` | TEXT | Display name |
| `active` | INTEGER | 1=active, 0=unsubscribed |
| `confirmed` | INTEGER | 1=confirmed, 0=pending |
| `confirm_token` | TEXT | Used for double opt-in |
| `unsubscribe_token` | TEXT | Used for unsubscribe links |
| `created_at` | TEXT | ISO 8601 UTC |

### `config`
| Key | Purpose |
|-----|---------|
| `last_email_sent_at` | DST guard — prevents second cron from firing on same day |
| `is_processing` | Processing lock (value `'1'` or `'0'`; `updated_at` used for 10-min stale check) |
| `last_run_at` | Timestamp of last pipeline run |
| `prompt_era` | LLM system prompt for ERA cases (6,000+ chars; editable via Prompts tab) |
| `prompt_ec` | LLM system prompt for EC cases (6,000+ chars; editable via Prompts tab) |
| `email_notice` | Optional one-shot notice banner (amber HTML); auto-clears after email send |

---

## 5. Outstanding Issues — Priority Order

### 🔴 CRITICAL — Security

**1. Cloudflare API token is exposed**
The token `<CLOUDFLARE_API_TOKEN — stored in GitHub Actions secrets>` has appeared in conversation history.
- Revoke at: `https://dash.cloudflare.com → Profile → API Tokens`
- Regenerate a new token with the same scopes
- Update GitHub secret `CLOUDFLARE_API_TOKEN` in the repo settings

**2. Admin secret is exposed**
`<ADMIN_SECRET>` (stored in Cloudflare Worker secrets + GitHub Actions secret) has appeared in conversation history.
- Update GitHub secret `ADMIN_SECRET`
- Set new worker secret: `wrangler secret put ADMIN_SECRET`
- Update the Cloudflare dashboard worker env var if separately set there

---

### 🟠 HIGH — Broken Functionality

**3. Migration 0007 not applied — prompt_era / prompt_ec rows missing from D1**

This is the root cause of the Prompts tab showing blank text and production running with minimal fallback prompts.

**Background:** Migrations 0003–0006 were applied manually before Wrangler started tracking migration state. Wrangler still thinks 0003 is pending and tries to re-apply it, hitting a "duplicate column" error and aborting before it reaches 0007.

**Fix — two options:**

_Option A (recommended): Run the seed SQL directly_
```powershell
cd C:\Users\prob\employment-case-summaries
git pull origin main
wrangler d1 execute era-digest --remote --file "scripts\seed_prompts.sql"
```
Then hard-refresh the admin dashboard → Prompts tab. The real prompts (6,000+ chars) should appear.

_Option B (proper migration fix — do this eventually):_
The `_cf_KV` table that wrangler uses for migration tracking is read-only via `wrangler d1 execute`. The only way to mark 0003–0006 as applied is through the Cloudflare REST API. Use the D1 `query` endpoint to insert rows directly:
```
POST /accounts/{account_id}/d1/database/{database_id}/query
{ "sql": "INSERT INTO d1_migrations (name, applied_at) VALUES ('0003_add_pdf_url.sql', datetime('now')) ON CONFLICT(name) DO NOTHING;" }
```
Do this for 0003, 0004, 0005, 0006 — then run `wrangler d1 migrations apply --remote` normally for 0007.

**4. Re-summarise cases processed with minimal fallback prompt**

Any ERA cases summarised after the last deployment (from 29 May 2026 onwards) have been summarised using the minimal one-liner fallback prompt instead of the full detailed prompt. Use the Rescan tab (set N = number of recent cases to rescan) → "Rescan & Send Now" to regenerate and send updated summaries.

---

### 🟠 HIGH — Validation (test these manually)

**5. Test the Prompts tab end-to-end**
After seeding the config rows (issue #3 above):
- Open admin dashboard → Prompts tab
- Both textareas should show the full detailed prompts
- Edit a small word in one prompt, click "Save Prompts"
- Trigger a `/run` — verify the changed prompt was used in the LLM call (check console logs in Cloudflare Worker Logs)

**6. Test the Rescan tab end-to-end**
- Open admin dashboard → Rescan tab
- Enter N=2, click "Rescan Silently" → verify 2 rows deleted from `seen_cases` (check via `/admin/seen-cases`)
- Enter N=2, click "Rescan & Send Now" → verify email sent to subscribers with banner "Updated summaries for recently rescanned cases (new prompt applied)"

**7. Test EC PDF upload via dashboard**
- Admin dashboard → EC Upload tab
- Drag & drop a real EC PDF
- Verify Python sidecar is called (check worker logs for "PDF_PARSER" service binding call)
- Verify summary stored in D1

---

### 🟡 MEDIUM

**8. Review LLM prompt strategy — brevity vs completeness**

Current prompts use `"Completeness is your ABSOLUTE PRIMARY goal"` which generates very long summaries (sometimes hitting the `max_tokens: 4000` limit and triggering the truncation warning). The truncation check appends `[WARNING: Summary was truncated due to length limits. Please read full PDF.]` and logs a `console.warn`.

Consider switching to a brevity-first prompt (~350 words target) and a faster/cheaper model like `anthropic/claude-3-5-haiku-20241022` with `max_tokens: 1000`. This would also reduce OpenRouter costs significantly. Discuss with user before changing.

**9. Update the 22 EC case summaries that have wrong hyperlinks**

Early EC cases were stored with the ERA listing page URL instead of the EC listing page URL. The correct EC link is: `https://www.employmentcourt.govt.nz/judgments/decisions/?Filter_Jurisdiction=17`. These need to be re-summarised and re-sent.

**10. Add graceful PDF error handler**

If a PDF is corrupted or completely unreadable, the pipeline currently throws and the entire batch fails. Add a try/catch around individual case processing so one bad PDF skips cleanly and the rest of the batch continues.

---

### 💙 LOW — Backlog

- Prompt injection wrapper (`<document>` tags around PDF content for better LLM comprehension)
- Timing-safe password compare for admin login (currently uses simple string equality)
- `summary_version` column on `seen_cases` (migration 0008) — to track which prompt version generated each summary
- JSON Mode for Claude Sonnet 4.6 (structured output instead of text parsing)
- Rate limiting on `/subscribe` and `/admin` endpoints
- Audit logging (who sent what, when)
- Monitoring for `pdf-parser-python` sidecar (currently silent on errors beyond the fallback)
- Move to Cloudflare Secrets Store (when GA) — currently secrets via `wrangler secret put`
- Add `package-lock.json` to repo for reproducible installs

---

## 6. Key Behaviours & Gotchas

### PDF extraction strategy
- **ERA cases**: Always use Strategy B (local FlateDecode/zlib decompression in `pdf.ts`). ERA PDFs use simple Latin-1 fonts. The Python sidecar is NEVER called for ERA cases.
- **EC cases**: CID font encoding defeats FlateDecode. Must use the `pdf-parser-python` Python sidecar (called via `PDF_PARSER` service binding). There is a 20-second circuit breaker timeout; if the sidecar times out, the worker auto-falls back to FlateDecode and logs which method was used.

### Processing lock
- Stored in `config` table as `is_processing = '1'`
- 10-minute auto-expiry: if the lock's `updated_at` is older than 10 minutes, it's treated as stale/ignored
- Lock is released in a `finally` block — should survive crashes
- If a cron fails mid-run and the lock gets stuck, wait 10 minutes or clear it manually: `wrangler d1 execute era-digest --remote --command "UPDATE config SET value='0' WHERE key='is_processing';"`

### Case deduplication
- Composite primary key: `(source, pdf_filename)`
- `pdf_filename` is extracted from the PDF URL (the last path segment)
- **Cases are only marked as seen AFTER successful email dispatch** — if email sending fails, the case will be reprocessed next run

### DST guard
- New Zealand has two time zones: NZST (UTC+12, April–Sep) and NZDT (UTC+13, Oct–Mar)
- Two cron triggers fire each day (20:00 UTC and 19:00 UTC)
- `hasEmailBeenSentToday()` in `db.ts` compares the stored `last_email_sent_at` timestamp against today's date in Pacific/Auckland timezone (using `Intl.DateTimeFormat`)
- The second cron trigger that fires on the same NZT date is silently skipped

### Notice banner
- Set in D1: `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('email_notice', 'Your HTML notice here', datetime('now'));`
- Renders as an amber HTML banner above all case content in the email
- **Auto-clears after successful send** — one-shot by design
- "Rescan & Send Now" automatically sets the banner to: `"Updated summaries for recently rescanned cases (new prompt applied)"`

### Case title casing
- `toTitleCase()` in `utils.ts`: particles (`v`, `and`, `the`, `of`, `a`, `an`, `in`, `on`, `at`, `by`, `for`, `to`) are lowercased — **particles are checked FIRST**
- Then: 2–3 character all-uppercase words are preserved as abbreviations (ERA, ACC, FHE, etc.)
- Small words are not caught as abbreviations because the particle check runs first

### Double-encoding guardrail
- Before every INSERT into `seen_cases`, `validateSummaryNotDoubleEncoded()` in `db.ts` checks if the summary starts with `{` or `"`
- If it does, the error is thrown immediately, the email is NOT sent, and the admin is alerted
- Zero tolerance for storing JSON-encoded strings as summaries

### Email layout
- Two separate sections: **Employment Court** (top) and **Employment Relations Authority** (below)
- Each section has its own date/count header
- EC cases NEVER appear under the ERA heading and vice versa
- Unsubscribe link is personalised per subscriber using their unique `unsubscribe_token`
- Links in email: "View case summary" → source listing page; "Download PDF" → direct `pdf_url` stored in D1

### Admin authentication
- Dashboard login: POST `/admin` with password → sets session cookie
- API endpoints (legacy): `Authorization: Bearer <ADMIN_SECRET>` header
- **All programmatic requests** to `whenroutinebiteshard.com` must include `User-Agent: Mozilla/5.0` — Cloudflare bot protection blocks requests without it

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
# This runs: wrangler deploy
# ⚠️ Do NOT run npm run build — wrangler handles TS compilation automatically
```

**Agent sandbox → deploy (when agent makes changes):**
The agent sandbox has a copy at `/agent/home/era-digest-worker/`. After making changes there, use the `github_push_to_branch` tool to push to `main`, then instruct the user to `git pull origin main && npm run deploy` (GitHub Actions will also auto-deploy).

---

## 8. Useful Manual Commands

```powershell
# Check migration status
wrangler d1 migrations list era-digest --remote

# Seed prompts into config (if missing)
wrangler d1 execute era-digest --remote --file "scripts\seed_prompts.sql"

# Check config table
wrangler d1 execute era-digest --remote --command "SELECT key, substr(value,1,50), updated_at FROM config;"

# Clear processing lock (if stuck)
wrangler d1 execute era-digest --remote --command "UPDATE config SET value='0' WHERE key='is_processing';"

# List recent seen cases
wrangler d1 execute era-digest --remote --command "SELECT source, pdf_filename, title, processed_at FROM seen_cases ORDER BY processed_at DESC LIMIT 10;"

# Delete last N seen cases (forces rescan)
wrangler d1 execute era-digest --remote --command "DELETE FROM seen_cases WHERE rowid IN (SELECT rowid FROM seen_cases ORDER BY processed_at DESC LIMIT 5);"

# Check subscribers
wrangler d1 execute era-digest --remote --command "SELECT id, email, name, active, confirmed FROM subscribers;"

# Manually trigger pipeline (test)
curl -X POST https://whenroutinebiteshard.com/run -H "Authorization: Bearer <ADMIN_SECRET>" -H "User-Agent: Mozilla/5.0" -H "Content-Type: application/json"

# Force trigger bypassing DST guard
curl -X POST "https://whenroutinebiteshard.com/run?force=true" -H "Authorization: Bearer <ADMIN_SECRET>" -H "User-Agent: Mozilla/5.0"

# Preview digest email (returns HTML)
curl "https://whenroutinebiteshard.com/admin/preview-digest?limit=3" -H "Authorization: Bearer <ADMIN_SECRET>" -H "User-Agent: Mozilla/5.0"

# Check LLM is working
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

**Admin email** (receives error alerts): `paul.robertson@heaneypartners.com`

---

## 10. Key External Links

| Resource | URL |
|----------|-----|
| ERA recent determinations | https://determinations.era.govt.nz/determinations/recent |
| EC judgments listing | https://www.employmentcourt.govt.nz/judgments/decisions/?Filter_Jurisdiction=17 |
| EC PDF URL pattern | `https://www.employmentcourt.govt.nz/assets/Documents/Decisions/<filename>.pdf` |
| OpenRouter | https://openrouter.ai/ |
| Cloudflare dashboard | https://dash.cloudflare.com (account ID in wrangler.jsonc) |
| GitHub repo | https://github.com/kiwipaulrob/employment-case-summaries |
| Live site | https://whenroutinebiteshard.com |
| Admin dashboard | https://whenroutinebiteshard.com/admin |
| Worker logs | Cloudflare dashboard → Workers → era-digest-worker → Logs |

---

## 11. Related Agent Files

| File | Purpose |
|------|---------|
| `/agent/home/era-digest-spec.md` | V1 specification |
| `/agent/home/era-digest-spec-v2.md` | V2 specification |
| `/agent/home/era-digest-worker/SETUP.md` | Setup guide |
| `/agent/home/ADMIN-DASHBOARD-SPEC.md` | V4 Admin Dashboard full specification |
| `/agent/home/EC_UPLOAD_GUIDE.md` | Step-by-step EC batch upload guide |
| `/agent/home/IMPLEMENTATION-SUMMARY.md` | Prompts & Rescan implementation summary |
| `/agent/home/batch_upload_ec.py` | Batch EC upload Python script |
| `/agent/home/seed_prompts.sql` | SQL to seed real prompts into D1 |

---

_Keep this file updated after every significant code change or resolved issue._
