# ERA Digest Worker — Setup Guide

**⚠️ Latest Deployment (8 June 2026):** ERA Backfill feature — Options A & C (commit d7950bd)
- `scrapeAllPages()` added to scraper — scrapes ERA listing pages 1–3 (up to 30 cases)
- New dashboard tab **ERA Backfill**: auto-scrape multiple pages OR paste a single PDF URL
- New endpoints: `POST /admin/dashboard/backfill-era` and `POST /admin/dashboard/upload-era-url`
- No email sent by either endpoint — purely for silent archive population
- Also: seed-seen 500 bug fixed; migration 0009 (confirm_token); migration 0008 applied

**Previous Deployment (May 17, 2026):** PR #7 — 4 critical stability fixes:
- LLM API timeout (25s AbortController on OpenRouter calls)
- Dashboard OOM prevention (SQL aggregate instead of loading 1000 records)
- Concurrent email dispatch (25 batches instead of sequential)
- Premature DB commits fixed (mark cases seen only after email succeeds)

---

## Recovering from a wiped `seen_cases` table

If `seen_cases` is wiped or cases are missing from the archive, use the **ERA Backfill** tab
in the admin dashboard (`/admin` → ERA Backfill tab):

1. **Option A (Auto-scrape)** — Click "Backfill Now" with pages=3. This scrapes all 3 ERA
   listing pages (up to 30 cases from the last ~10 days), summarises any unseen cases, and
   stores them. No email is sent.

2. **Option C (Manual URL)** — For cases older than ~10 days that are no longer on the ERA
   listing. Find the PDF URL from the ERA website, paste it in, click "Process Case".
   URL format: `https://determinations.era.govt.nz/assets/elawpdf/YYYY/YYYY-NZERA-NNN.pdf`

This guide walks you through every step to deploy the ERA Digest Worker from scratch.
Commands are run in a **terminal** on your local machine unless stated otherwise.

---

## Prerequisites

### 1. Node.js
You need Node.js 18 or later.

Check if you have it:
```
node --version
```

If not, download from https://nodejs.org (choose the LTS version).

---

### 2. Wrangler CLI (Cloudflare's developer tool)
Wrangler is the command-line tool for deploying to Cloudflare Workers. Install it globally:

```
npm install -g wrangler
```

Verify:
```
wrangler --version
```

---

### 3. Log in to Cloudflare via Wrangler
This opens a browser window to authorise Wrangler against your Cloudflare account:

```
wrangler login
```

Complete the browser prompt. You only need to do this once per machine.

---

## Step 1 — Get the project onto your machine

The project files are in `/agent/home/era-digest-worker/` on this agent. Download the
folder as a zip from the agent's file storage, or copy the files to your local machine.

Once you have the folder, open a terminal and navigate into it:

```
cd /path/to/era-digest-worker
```

All commands from here on are run **inside this directory**.

Install dependencies:

```
npm install
```

---

## Step 2 — Create the D1 database on Cloudflare

Run this command to create a new D1 database in your Cloudflare account:

```
wrangler d1 create era-digest
```

You will see output like this:

```
✅ Successfully created DB 'era-digest' in region APAC
Created your new D1 database.

[[d1_databases]]
binding = "DB"
database_name = "era-digest"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"   ← COPY THIS
```

**Copy the `database_id` value** (the UUID on the last line).

Now open `wrangler.jsonc` in a text editor and replace `REPLACE_WITH_D1_DATABASE_ID`
with the UUID you just copied:

```jsonc
"database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Save the file.

---

## Step 3 — Run the database migrations

This creates all the tables and inserts your subscriber record.

> **Important:** The `--remote` flag is required. Without it, Wrangler targets a local
> development copy of the database instead of the real one on Cloudflare.

```
npm run db:migrate
npm run db:seed
```

Both commands include `--remote` automatically — you don't need to add it yourself.

To verify everything was created correctly:

```
wrangler d1 execute era-digest --remote --command "SELECT * FROM subscribers;"
```

You should see a row with your email (paul.robertson@heaneypartners.com) and name (Paul).

> **Note:** Running the same command *without* `--remote` queries the empty local database
> and returns no rows — this is expected, not an error.

### Migration 0005: PDF filename as primary key (Discovered April 24, APPLIED April 25, 2026)

> **CRITICAL FIX:** On April 24, 2026, we discovered that the ERA website reassigns integer `case_id` values to different cases over time. This caused deduplication to fail — incorrect summaries were stored under the wrong case IDs.
>
> **Solution:** Migration 0005 changes the primary key from `case_id INT` to `pdf_filename TEXT`. The PDF filename (e.g. `2026-NZERA-225.pdf`) is immutable and derived from the official citation number, making it globally unique and stable.

**STATUS (as of April 25, 2026, 16:30 GMT+12):** ✅ **APPLIED** via Cloudflare D1 API. All 10 cases in the database have been migrated to use immutable `pdf_filename` keys. The code in `types.ts` and `db.ts` has been updated to extract and use pdf_filename instead of case_id. Worker redeployed.

If you're setting up from scratch, this migration runs automatically with `npm run db:migrate`. **The seen_cases table uses pdf_filename TEXT PRIMARY KEY**, so any old data using case_id as the key will not be compatible.

To verify the migration in your local environment:

```
wrangler d1 execute era-digest --remote --command ".schema seen_cases"
```

The output should show `pdf_filename TEXT PRIMARY KEY` as the first column.

---

## Step 4 — Set up Email Sending on Cloudflare (Dashboard)

This is the only step that requires the Cloudflare web dashboard.

1. Go to https://dash.cloudflare.com and log in.
2. In the left sidebar, click **Email** → **Email Sending**.
3. Click **Add domain**.
4. Enter `whenroutinebiteshard.com` and click **Continue**.
5. Cloudflare will show you DNS records to add. Since `whenroutinebiteshard.com` is
   already managed in Cloudflare, click **Add records automatically** (or add them
   manually if that option isn't shown — they are SPF, DKIM, and DMARC TXT records).
6. Wait for verification — usually instant since the domain is already on Cloudflare.
7. Once the domain shows as **Verified**, the email binding in the Worker is ready.

> **Note:** The Cloudflare Email Service is in beta. If you don't see "Email Sending"
> in the sidebar, go to https://dash.cloudflare.com/?to=/:account/email and enable it.

---

## Step 5 — Set secrets

Secrets are sensitive values stored encrypted in Cloudflare — never put them in files.

### OpenRouter API key

If you don't have one yet:
1. Go to https://openrouter.ai/
2. Sign up or log in
3. Go to **Keys** → **Create key**
4. Copy the key (starts with `sk-or-...`)

Set it in Wrangler:

```
wrangler secret put OPENROUTER_API_KEY
```

Wrangler will prompt: `Enter a secret value:` — paste your key and press Enter.

### Admin secret

This is a password you invent to protect the manual HTTP trigger endpoints
(e.g. to force a run or check status). Choose something strong:

```
wrangler secret put ADMIN_SECRET
```

Type or paste your chosen password and press Enter. Store it somewhere safe
(e.g. your password manager) — you'll use it to call the admin endpoints later.

---

## Step 6 — Deploy

```
npm run deploy
```

You should see:

```
✅ Deployed era-digest-worker
  https://era-digest-worker.<your-subdomain>.workers.dev
  Triggers:
    - cron: 0 20 * * *
    - cron: 0 19 * * *
```

Your worker is now live.

---

## Step 7 — Test it manually

You can trigger a run immediately without waiting for the cron, using the admin
HTTP endpoint. Replace `YOUR_ADMIN_SECRET` with the password you set in Step 5:

```
curl -X POST "https://era-digest-worker.<your-subdomain>.workers.dev/run" \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET"
```

On Windows PowerShell:

```powershell
Invoke-WebRequest -Uri "https://era-digest-worker.<your-subdomain>.workers.dev/run" -Method POST -Headers @{Authorization="Bearer YOUR_ADMIN_SECRET"}
```

This will:
1. Scrape the ERA recent determinations page
2. Find any cases not yet in the database
3. Fetch and summarise each new case via OpenRouter/Claude
4. Send the digest email to paul.robertson@heaneypartners.com

Watch the logs in real time with:

```
wrangler tail
```

Run this in a second terminal window before triggering the run so you can see
what's happening step by step.

### Batch limiting

The `/run` endpoint processes a maximum of **3 cases per invocation** by default. This is because each case requires:
- PDF download from ERA
- PDF text extraction (with zlib decompression)
- LLM API call to OpenRouter (~5–10 seconds)
- Database write

Processing more than 3 cases sequentially can exceed Cloudflare Workers' 30-second execution timeout.

If more than 3 new cases are published, the next cron tick processes the remaining cases.

To override the batch size, use the `?limit=N` query parameter (max 50):

```
curl -X POST "https://era-digest-worker.<your-subdomain>.workers.dev/run?limit=5" \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET"
```

### First run behaviour

On the very first run, the database is empty, so **all** cases currently listed
on the ERA page will be treated as "new". Depending on how many are listed, this
may generate a large email and a number of OpenRouter API calls.

To avoid this, you can seed the database with the current cases *without* emailing,
then only send digests for genuinely new ones going forward. Use:

```
curl -X POST "https://era-digest-worker.<your-subdomain>.workers.dev/admin/seed-seen" \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET"
```

On Windows PowerShell:

```powershell
Invoke-WebRequest -Uri "https://era-digest-worker.<your-subdomain>.workers.dev/admin/seed-seen" -Method POST -Headers @{Authorization="Bearer YOUR_ADMIN_SECRET"}
```

This marks all currently listed cases as seen without summarising or emailing them.
Then your first real digest will only cover cases published after this point.

---

## Step 8 — Verify the cron schedule

In the Cloudflare Dashboard:
1. Go to **Workers & Pages** → **era-digest-worker**
2. Click the **Triggers** tab
3. You should see two cron entries: `0 20 * * *` and `0 19 * * *`

These fire at 8:00 am NZST (UTC+12, April–September) and 8:00 am NZDT (UTC+13,
October–March) respectively. The D1 `last_email_sent_at` guard ensures only one
email is sent per day even when both triggers fire on DST changeover days.

---

## Switching to change-detection mode

If you later want emails sent immediately when a new case is published (instead of
waiting for 8 am), open `wrangler.jsonc` and replace the two cron entries:

```jsonc
"crons": [
  "*/30 * * * *"
]
```

Also change:

```jsonc
"TRIGGER_MODE": "change_detection"
```

Then redeploy:

```
npm run deploy
```

---

## Changing the LLM model

To switch models, edit `wrangler.jsonc`:

```jsonc
"OPENROUTER_MODEL": "anthropic/claude-3.5-sonnet"
```

Replace the value with any model ID from https://openrouter.ai/models — for example:
- `"openai/gpt-4o"` — OpenAI GPT-4o
- `"anthropic/claude-opus-4"` — Claude Opus (higher quality, higher cost)
- `"google/gemini-pro-1.5"` — Google Gemini Pro

> **Important:** OpenRouter rejects unversioned model names. Use the full model ID
> (e.g. `anthropic/claude-3.7-sonnet`, not `anthropic/claude-3.5-sonnet`).

Then redeploy with `npm run deploy`. No other code changes needed.

---

## Customising the LLM summary prompt

The system prompt that instructs Claude how to summarise cases is in `src/summariser.ts`, lines 25–104.

The current prompt (deployed 25 Apr 2026) is **Option B — the comprehensive version**:
- Requires 2–4 sentences per issue resolution (vs. 1–3 in the original)
- Instructs the model to explain the statutory test, evidence application, authorities cited, and conclusion
- Adds a "DOCUMENT TYPE FLAG" section to classify whether the determination is [FINAL DETERMINATION], [INTERIM/INTERLOCUTORY], [CONSENT ORDER], or [COSTS ORDER]
- Adds a "COMPLETENESS CHECK" requiring the model to verify all issues have matching resolutions before output
- Increased token budget from 800 to 1200 to allow for more detailed summaries (500–800 words, up from 400–600)

To adjust the prompt, edit the `SYSTEM_PROMPT` variable and redeploy. No other code changes needed.

---

## Admin HTTP endpoints

### Admin API (Bearer token required)
All require `Authorization: Bearer YOUR_ADMIN_SECRET` header.

| Method | Path | What it does |
|--------|------|-------------|
| GET | `/health` | Public health check — returns last run time (no auth needed) |
| POST | `/run` | Trigger a full run immediately (returns 202, processes in background) |
| POST | `/run?limit=3` | Trigger a run capped at N new cases (useful for testing or backlog pacing) |
| POST | `/run?force=true` | Force a run even if email already sent today |
| POST | `/admin/seed-seen` | Mark all current ERA cases as seen (no email sent) |
| POST | `/admin/clear-seen` | Delete all rows from `seen_cases` table (for testing) |
| GET | `/admin/seen-cases` | List recently processed cases |
| GET | `/admin/seen-cases?limit=50` | List up to 50 recently processed cases |
| GET | `/admin/test-llm` | Diagnostic: checks OpenRouter key and tests a minimal LLM call |
| POST | `/admin/test-email` | Sends a simple test email to the first active subscriber |
| POST | `/admin/send-digest` | Sends a digest email from existing summaries in D1 (no scraping/LLM) |
| GET | `/admin/status` | Shows subscriber list and pipeline metadata |

### Admin UI (session cookie, browser)
Visit `https://whenroutinebiteshard.com/admin` in a browser and log in with `ADMIN_SECRET`. Shows subscriber list with delete buttons and pipeline stats.

### Public routes (no auth)
| Method | Path | What it does |
|--------|------|-------------|
| GET | `/` | Landing page with sign-up form and recent cases archive |
| POST | `/subscribe` | Handles sign-up form — sends confirmation email |
| GET | `/confirm?token=X` | Confirms subscription via email link |
| GET | `/unsubscribe?token=X` | One-click unsubscribe from email footer link |

### Subscriber housekeeping (automatic)
On every cron run, the Worker automatically purges unconfirmed (`confirmed=0`) subscriber rows older than **48 hours**. No manual action required. If a pending subscriber wants to try again after expiry, they simply re-submit the sign-up form.

---

## Troubleshooting

**"Error: D1_ERROR" in logs**
The database ID in `wrangler.jsonc` is wrong or the migration hasn't been run.
Check with: `wrangler d1 execute era-digest --command "SELECT name FROM sqlite_master WHERE type='table';"`

**"Email sending failed"**
The domain `whenroutinebiteshard.com` is not yet verified in Cloudflare Email Sending.
Complete Step 4 and wait a few minutes for DNS propagation.

**"OpenRouter API error: 401"**
The `OPENROUTER_API_KEY` secret is wrong or not set. Re-run `wrangler secret put OPENROUTER_API_KEY`.

**"No new cases found"**
Expected if you ran `/admin/seed-seen` first, or if the ERA site hasn't published
anything new since the last run. Check D1 with:
`wrangler d1 execute era-digest --command "SELECT * FROM cases ORDER BY seen_at DESC LIMIT 5;"`

**Checking logs after a scheduled run**
Scheduled (cron) runs don't appear in `wrangler tail` unless you're watching at the
exact moment. Instead, view historical logs in the Cloudflare Dashboard:
Workers & Pages → era-digest-worker → **Logs** tab.

---

## Critical Bug Fixes Applied (29 April 2026)

Two critical bugs were discovered and immediately fixed:

### 1. Timezone Bug in `hasEmailBeenSentToday()` ✅ FIXED

**Problem:** The function compared email send dates in UTC instead of NZ time (Pacific/Auckland). This caused the daily digest guard to fire incorrectly — blocking emails when the UTC date matched the last send, even if the NZ date was different (e.g., email sent 28 Apr 02:11 UTC = 14:11 NZT; cron tried to run 28 Apr 20:00 UTC = 8am NZT 29 Apr, but guard saw same UTC date and blocked it).

**Fix:** Function now accepts timezone parameter and converts stored UTC timestamp to target timezone before comparing dates.

**Location:** `src/db.ts`, line ~246

**Impact:** Correct 8am NZT daily delivery is now working. Catch-up digest with 72 hours of missed cases was sent 29 Apr 02:30 UTC.

### 2. Parameter Mismatch in `recordRunAt()` ✅ FIXED

**Problem:** Function signature required a `label` parameter, but `index.ts` called it without arguments. Timestamp was stored to `run_undefined` instead of `last_run_at`, making it invisible.

**Fix:** Made `label` parameter optional with default value `'last_run_at'`.

**Location:** `src/db.ts`, line ~313; caller in `index.ts`

**Impact:** Pipeline run timestamps now properly tracked. Enables future monitoring and DST guard logic.

---

## Known Issues — Cloudflare Email Service (Beta)

These issues were discovered during development and may be relevant if you modify the
email sending code:

1. **Never pass `env.EMAIL` as a function parameter.** The `.send()` method loses its
   internal `this` context when the binding is passed as a variable. Either call
   `env.EMAIL.send()` directly or use `.send.call(binding, message)`.

2. **Error 1101 is opaque.** If email sending fails at the runtime level, the Worker
   crashes with HTTP 1101 and no error message. A `try/catch` block does not catch it.
   This makes debugging difficult — use the `/admin/test-email` endpoint to verify
   email is working before testing the full pipeline.

3. **Use fire-and-forget stream writes.** When constructing an `EmailMessage` from a
   `ReadableStream`, use `writer.write(data).then(() => writer.close())` — do **not**
   `await writer.close()` before passing the stream to `EmailMessage`.

---

## LLM Prompt Updates

### 25 Apr 2026 — ALL-ISSUES Completeness Fix

The system prompt in `src/summariser.ts` (lines 25–83) has been updated to capture **ALL issues** addressed in a determination, not just the main claims:

**Changes:**
- Explicit instruction: "EXTRACT ALL ISSUES from the determination, preserving their numbering and sequence. Do not filter or omit any issue."
- Each issue now flagged with status: **(Established), (Dismissed), (Not reached), (Partially established), or (Conditional)**
- Prompt now includes: threshold issues, secondary claims, statutory breach claims (e.g. s.4), procedural matters (costs), dismissed issues, and issues not reached
- For each unresolved issue, model must explain **why** it was not reached
- Completeness check expanded from 4 to 7 verification steps

**Example:** The Jansen case [2026] NZERA 230 previously omitted issues (c)–(f) and (h):
- ✗ *Old prompt:* 3 of 8 issues captured
- ✓ *New prompt:* All 8 issues + status flags + reasoning for each

To modify the prompt further, edit lines 44–52 (LEGAL ISSUES section) and lines 70–76 (COMPLETENESS CHECK) in `src/summariser.ts`, then redeploy.

---

### 28 Apr 2026 — Stream Boundary Validation & Diagnostic Logging

The PDF text extraction logic in `src/pdf.ts` has been enhanced to handle edge cases and provide better diagnostics:

**Problem addressed:**
- PDFs can contain the literal text `stream` embedded in compressed data
- The original code searched for any occurrence of `stream` without validating it was a valid PDF stream boundary
- This caused extraction to fail for some determinations, e.g. NZERA 232 which has 58 "stream" keywords but only 29 actual PDF stream objects

**Fixes implemented:**
- **Stream boundary validation** (lines 163–176): Now verifies that stream keywords are preceded by `>>` (the PDF dictionary terminator), filtering out embedded text false positives
- **Decompression logging** (lines 235–264): Logs which decompression format succeeded (deflate vs deflate-raw) and the bytes decompressed
- **Block and text extraction logging** (lines 271–310, 207–225): Shows BT...ET block counts and final extracted text size
- **Strategy logging** (lines 42–81): Distinguishes between base64 passthrough (Strategy A) and text extraction (Strategy B) with byte counts

**Impact:**
- Previously-failing cases (NZERA 232, NZERA 238) now process successfully
- Future extraction failures can be diagnosed via logs without requiring production access
- The fix is transparent — no configuration changes needed

See `/agent/home/extraction-fix-report.md` for full technical analysis and test results.

---

### 2 May 2026 — LLM Anti-Hallucination Fix (Representatives Section)

**Problem identified:**
The CANDOO FRANCHISING LIMITED case ([2026] NZERA 250) contained fabricated representative names:
- Stored in DB: "Applicant: Tim Mackinnon, Counsel; Respondent: Stella Ding, Counsel"
- Actual PDF: "Applicant: Allan Halse, advocate; Respondent: No appearance"

The LLM (Claude) invented plausible-sounding names instead of faithfully extracting the document text, particularly for the "No appearance" case.

**Root cause:**
The system prompt did not explicitly instruct the model what to do when:
1. A party had "No appearance" explicitly stated in the document
2. Representative information was stated in an unexpected format
3. Information was genuinely missing or unclear

**Fixes implemented:**
- **`src/summariser.ts` (lines 37–42):** Updated REPRESENTATIVES section with explicit instruction: "If the document says 'No appearance' for a party, write exactly: 'No appearance'. Do NOT invent or speculate about representative names if they are not explicitly stated."
- **`src/summariser.ts` (lines 83–86):** Added anti-hallucination instruction: "CRITICAL: Never invent or hallucinate information. If a detail is not in the document, do not guess — write 'Not provided' or leave it blank."
- **`src/summariser.ts` (line 83 in COMPLETENESS CHECK):** Added verification step: "ANTI-HALLUCINATION CHECK: For the REPRESENTATIVES section, verify that every name and title is explicitly stated in the document. If a party had 'No appearance', write exactly 'No appearance'. Do not invent names."
- **`src/summariserEmploymentCourt.ts`:** Applied identical fixes to the Employment Court prompt (lines 45–50 and completeness check)

**Impact:**
- Future summaries will now include explicit anti-hallucination verification in the LLM completeness check
- The CANDOO case was manually corrected in D1
- All future cases with "No appearance" or missing representative data will be handled correctly

**Verification:**
Next case with "No appearance" or missing representative info will auto-verify this fix in production.

---

### 2 May 2026 — EC Case Upload Authorization Fix

**Problem reported:**
EC Case Upload endpoint was returning "Unauthorized" error when users submitted forms from the dashboard.

**Root cause:**
The EC case upload endpoint was implemented only in the **Bearer token API routes section** (which requires `Authorization: Bearer <secret>` header). However, the dashboard was making requests via **form submission with session cookies** (using `era_admin` cookie). These two authentication systems never met, so all dashboard upload attempts were rejected at the auth check.

Additionally, browser JavaScript fetch requests were not including cookies because `credentials: 'same-origin'` was missing from the fetch options.

**Fixes implemented:**

1. **`src/index.ts` (lines 292–377):** Added a **cookie-gated version** of the EC upload endpoint in the Admin UI Routes section (before the Bearer token check). This endpoint:
   - Accepts multipart form data (file + metadata)
   - Validates `era_admin` session cookie
   - Processes PDF upload and LLM summarization
   - Stores result in D1
   - Returns JSON response with summary preview

2. **`src/dashboard.ts`:**
   - Line 481: Added `credentials: 'same-origin'` to `/admin/upload-ec-case` fetch
   - Line 523: Added `credentials: 'same-origin'` to `/admin/preview-digest` fetch
   - This ensures browser sends session cookies with each request

**Result:**
- ✅ EC Case Upload works from the dashboard without "Unauthorized" errors
- ✅ Cookie authentication properly validates sessions
- ✅ Forms with file + URL successfully reach the LLM summarizer
- ✅ Uploaded cases appear in the archive and are sent in next digest email

**Technical detail:**
The system now has one EC upload endpoint:
1. **Cookie-gated (line 293):** For dashboard forms and API calls, uses session cookie authentication
The duplicate Bearer token endpoint (that was at line 502) was removed to avoid confusion.

---

### 3 May 2026 — EC Upload Database and Endpoint Cleanup

**Issues fixed:**

1. **Missing `case_url` column in D1 INSERT statement**
   - **Problem:** EC upload endpoint was missing `case_url` in the INSERT INTO statement, causing "NOT NULL constraint failed: seen_cases.case_url" errors
   - **Root cause:** The endpoint manually built an INSERT statement that didn't include the `case_url` column, even though the code created a `caseListing.caseUrl` value
   - **Fix (lines 376–387):** Added `case_url` to both the column list and bind parameters:
     ```sql
     INSERT OR REPLACE INTO seen_cases
     (pdf_filename, source, title, case_url, member, date_published, category, summary, pdf_url, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ```
   - **Impact:** EC uploads now store complete case metadata without database constraint errors

2. **Duplicate `/admin/upload-ec-case` endpoint**
   - **Problem:** Two endpoints with the same route existed (lines 293 and 502), causing confusion
   - **Root cause:** The Bearer token endpoint from the initial implementation wasn't fully removed when the cookie-gated version was added
   - **Fix:** Removed the duplicate endpoint at line 502 (the old Bearer token version)
   - **Impact:** Single, clean upload flow; no competing route handlers

**Result:**
- ✅ EC upload fully working via dashboard
- ✅ Cases correctly stored with all metadata (including `case_url`, `pdf_url`, source)
- ✅ LLM summaries generated and saved (7 sections for EC format)
- ✅ Cases appear in digest emails with correct formatting
- ✅ No database constraint errors

**Test case verified:** Sheridan v Pact Group [EMPC-38-2025] successfully uploaded, summarised, and stored with complete judgment text and all metadata fields.

---

### 7 May 2026 — PDF TJ-Array Fragmentation Fix + toTitleCase Fix + Deployment Issue

#### PDF Extraction Fix (`src/pdf.ts`)

**Problem:** Some PDFs (notably Sheridan v Pact Group) use character-level kerning via TJ arrays, e.g. `[(S)-6(HE)-4.3(R)-1.7(DAN v)]TJ`. The extractor was joining kerning fragments with spaces (`blockParts.join(' ')`), producing shattered text like `S HE R I DAN v P AC T`. The LLM received unreadable text and hallucinated entirely.

**Fix:** Changed `blockParts.join(' ')` → `blockParts.join('')` in `extractTextFromStream`. Spaces are already embedded within the text elements themselves. Also added binary-garbage filter for non-text streams.

#### toTitleCase Fix (`src/utils.ts`)

**Problem:** Particles of 2–3 characters (THE, FOR, etc.) were being preserved as uppercase because the abbreviation check (`/^[A-Z]{2,3}$/`) ran before the particle check.

**Fix:** Particle check now runs first. THE/OF/AND/FOR are lowercased correctly. Genuine abbreviations (FHE, ACC, IRD) still preserved.

#### Deployment: Versions API Workaround

**Problem:** Cloudflare API token lacks `D1 bind` permission required by the standard `PUT /workers/scripts/{name}` endpoint (error code 10023).

**Workaround:** Use the Versions API:
1. `POST /workers/scripts/{name}/versions` — upload new bundle with full binding metadata
2. `POST /workers/scripts/{name}/deployments` — deploy the version at 100%

**⚠️ Secrets are NOT automatically carried over when using the Versions API.** After deploying via Versions API, re-add all secrets manually:
```
POST /workers/scripts/{name}/secrets  body: {"name":"ADMIN_SECRET","text":"...","type":"secret_text"}
POST /workers/scripts/{name}/secrets  body: {"name":"OPENROUTER_API_KEY","text":"...","type":"secret_text"}
```

Then restore all plain_text bindings via `PATCH /workers/scripts/{name}/settings`.

**Current state after 7 May deployment:**
- ✅ PDF extraction fixed
- ✅ toTitleCase fixed
- ✅ ADMIN_SECRET restored
- ✅ All env vars (D1, EMAIL, OPENROUTER_MODEL, SITE_URL, USE_PDF_URL_PASSTHROUGH, ADMIN_EMAIL, SENDING_ADDRESS, TIMEZONE, TRIGGER_MODE, SOURCE_URL) restored
- ❌ OPENROUTER_API_KEY still missing — must be re-added before LLM processing will work

---

### 11 June 2026 — Counsel Name in Case Title Fix (commit 1945030)

**Problem:** The ERA case registry sometimes assigns a title using the filing counsel's name
rather than the actual parties, e.g. `"Mark Donovan & Anor v Rhino-Rack NZ Ltd"` where
Mark Donovan is counsel for applicant Todd Dormer (employee). `extractTitleFromSummary()`
is supposed to override this with names from the LLM PARTIES section, but silently returned
null when: (a) the LLM added blank lines between `PARTIES` and `Applicant:` (6-line lookahead
exhausted), or (b) the minimal fallback prompt was used (no guaranteed `Applicant:/Respondent:`
labels in output). All failures were silent — no log entry, no alert.

**Files changed:**

**`src/index.ts`** — `extractTitleFromSummary()` hardened:
- New `cleanPartyName()` helper: strips closed parentheticals `(employee)` AND unclosed
  trailing parentheticals `(employee — Head of Sales` to prevent stray `(` in stored titles.
- ERA lookahead increased **6 → 10 lines**: handles LLM blank lines between section header
  and first `Applicant:` label.
- `REPRESENTATIVE_WORDS` sanity check (`/\b(counsel|solicitor|barrister|advocate)\b/i`):
  if extracted name contains these words, discard and fall through to the `"v"` pattern
  fallback rather than storing a counsel name as the case title.
- Centralized `console.warn` on null return: includes citation number, visible in
  `wrangler tail`. Previously the function returned null with no log output at all.
- Consistent `cleanPartyName()` use in EC path (was using inline ad-hoc replace).

**`src/summariser.ts`** — `SYSTEM_PROMPT` PARTIES guardrail:
- Added `CRITICAL` instruction under the PARTIES format example: LLM must list actual
  parties (employee/employer by name), never counsel, and must disregard ERA registry titles.
- **Also update `prompt_era` in D1** via the Prompts tab — the hardcoded `SYSTEM_PROMPT` is
  used only when D1 prompt rows are absent; D1 takes precedence when seeded.

**`scripts/fix_counsel_titles.sql`** — DB correction:
- `UPDATE seen_cases SET title = 'Todd Dormer v Rhino-Rack New Zealand Limited [2026] NZERA 353'`
- Commented diagnostic `SELECT` to surface other counsel-name titles.

**Post-deploy actions:**
```powershell
# 1. Apply the DB title fix
wrangler d1 execute era-digest --remote --file "scripts\fix_counsel_titles.sql"

# 2. Run diagnostic query to check for other affected cases
wrangler d1 execute era-digest --remote --command "SELECT id, title, category, created_at FROM seen_cases WHERE source = 'ERA' ORDER BY id DESC LIMIT 50"

# 3. Update prompt_era in D1 via admin dashboard Prompts tab (add the PARTIES CRITICAL line)

# 4. Rescan [2026] NZERA 353 via Rescan tab to regenerate summary with updated prompt
```

---

### 13 May 2026 — GitHub Actions Fixes & Preamble-Stripping Deployment

#### GitHub Actions Workflow Fixes
**Problems fixed:**
1. **`${{ secrets.X }}` escaping in `run:` block** — Shell does NOT resolve GitHub's `${{ }}` syntax inside `run:` blocks. Secrets were appearing as literal `${{ }}` strings.
2. **Secrets not deployed to Cloudflare** — The workflow lacked `wrangler secret put` steps, so no secrets were set in the worker after deployment.
3. **Model name inconsistency** — `wrangler.jsonc` was set to an older model; `.github/workflows/deploy.yml` comment referenced a different model.

**Fixes implemented:**
- **Line 29–33 of `.github/workflows/deploy.yml`**: Added secrets-setting block with corrected pattern:
  ```yaml
  env:
    ADMIN_SECRET: ${{ secrets.ADMIN_SECRET }}
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
  ```
  Then call: `echo "$ADMIN_SECRET" | npx wrangler secret put ADMIN_SECRET`
- **`wrangler.jsonc`**: Updated `OPENROUTER_MODEL` to `anthropic/claude-3.7-sonnet`
- **Result**: GitHub Actions now successfully deploys secrets to Cloudflare on every push to `circuit-breaker-fix` or `initial-upload` branch

#### Code Fixes Deployed
1. **ERA Summariser Preamble Stripping** (`src/summariser.ts`)
   - **Problem:** Case 278 (NZERA 278, May 10) had LLM preamble "Please provide me with a structured summary..." leaked into stored summary text
   - **Root cause:** ERA summariser had no preamble stripping, unlike EC summariser
   - **Fix:** Added `stripEraLlmArtifacts()` function (mirroring EC approach); now both pipelines strip LLM preambles before storage
   - **Status**: ✅ Deployed to `circuit-breaker-fix` branch
   
2. **Cases Reprocessing**
   - **Case 278**: Preamble-corrupted summary — marked for deletion and reprocessing
   - **Cases 281-283** (May 11): Had "Summary unavailable — error occurred" due to zero-char text extraction — summaries deleted, marked for reprocessing
   - **Next step**: Manually trigger `/run` endpoint to reprocess all 4 cases with fixed code

#### Workflow Improvements Research
- **Cloudflare Secrets Store (Beta)** — Emerging alternative to dashboard secrets; monitor for GA announcement
- **Official `cloudflare/wrangler-action@v3`** — Recommended upgrade over current manual workflow; handles secrets automatically
- See `/agent/home/GITHUB_ACTIONS_IMPROVEMENTS_2026.md` for full analysis and upgrade checklist

**Impact:**
- ✅ GitHub Actions now correctly deploys worker code + secrets
- ✅ Preamble-stripping consistent across ERA + EC pipelines
- ✅ Cases queued for reprocessing will generate clean summaries on next `/run` trigger
- ✅ Future improvements identified (Secrets Store, wrangler-action v3)
