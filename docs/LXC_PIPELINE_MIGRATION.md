# LXC Pipeline Migration Guide

**Purpose:** Move the scrape → extract → summarise pipeline off Cloudflare Workers and onto the local LXC, keeping Workers as a thin web server + email dispatcher + database host.

**Status:** Draft — ready for implementation by an agent or developer.

---

## Background

The current architecture runs the entire pipeline inside a Cloudflare Worker:

```
Cloudflare Workers (everything)
├── Cron trigger (0 19/20 * * *)
├── Scrape ERA/EC listing pages
├── Download PDFs
├── Extract text (FlateDecode / Python sidecar)
├── LLM summarise via OpenRouter
├── Write to D1
├── Send digest email
└── Serve public website + admin dashboard
```

Since PDF OCR is now handled by software on the LXC, this guide completes the migration to a cleaner split:

```
LXC (processing)                    Cloudflare Workers (web + email)
────────────────                    ────────────────────────────────
Local cron job           →→→        POST /admin/upload-era-case-text
Scrape ERA/EC listings              POST /admin/upload-ec-case-text
Download PDFs                       POST /admin/dashboard/send-digest
OCR / extract text                  GET  /admin/dashboard/check-new-cases
LLM summarise via OpenRouter        Serve /  /awards  /subscribe  etc.
                                    Send digest emails (CF Email Service)
                                    D1 database
                                    Admin dashboard (view + config only)
```

---

## What Stays on Cloudflare Workers (Do Not Touch)

- All public routes: `/`, `/awards`, `/subscribe`, `/confirm`, `/unsubscribe`, `/preferences`
- Email sending — tightly coupled to Cloudflare Email Service binding
- D1 database — stays on Cloudflare; LXC writes via HTTP API
- Admin dashboard UI — convenient to keep; becomes view-only for pipeline status
- Subscription management

---

## Phase 0 — Add `extracted_text` to D1

Currently, extracted PDF text is discarded after summarisation. This means re-running a case requires re-downloading and re-OCR-ing the PDF. Storing it enables fast re-summarisation when prompts are updated.

### Migration SQL

```sql
-- migrations/0013_add_extracted_text.sql
ALTER TABLE seen_cases ADD COLUMN extracted_text TEXT;
```

Apply with:

```powershell
npx wrangler d1 migrations apply era-digest --remote
```

### Workers change needed

In `index.ts`, update both `markCaseSeen` calls and the `upload-ec-case-text` handler to write `extracted_text` alongside the summary:

```typescript
// Pseudo code — in markCaseSeen() or at the INSERT callsite
await db.prepare(`
  INSERT OR REPLACE INTO seen_cases
    (pdf_filename, source, title, ..., summary, extracted_text, processed_at)
  VALUES (?, ?, ?, ..., ?, ?, ?)
`).bind(..., summary, extractedText, processedAt).run();
```

The `extracted_text` value comes from `pdfContent.text` which is already in scope at the summarisation step.

---

## Phase 1 — New Workers Endpoint: Accept Pre-Processed ERA Cases

The `/admin/upload-ec-case-text` endpoint already accepts pre-extracted text for EC cases. A matching ERA endpoint is needed.

### New endpoint: `POST /admin/upload-era-case-text`

Add to `index.ts` (alongside the existing EC text endpoint):

```typescript
// POST /admin/upload-era-case-text
// Body (JSON):
// {
//   filename: string,          // e.g. "2026-NZERA-225.pdf"
//   text: string,              // extracted text content
//   title?: string,            // optional — LLM will override from summary
//   member?: string,
//   date_published?: string,   // YYYY-MM-DD
//   category?: string,         // e.g. "[2026] NZERA 225"
//   case_url?: string,
// }
// Auth: Bearer <ADMIN_SECRET>
//
// Steps:
//   1. Validate required fields (filename, text)
//   2. Check not already in seen_cases (skip if exists and not placeholder)
//   3. Build CaseListing from body
//   4. Call summariseCase(caseListing, { strategy: 'text', text }, apiKey, model, db)
//   5. Parse AWARDS_DATA block from summary
//   6. Call markCaseSeen() to write to D1
//   7. Call insertCaseAward() if awards data present
//   8. Return { success: true, title, category, pdfFilename }
```

This mirrors the existing `upload-era-url` endpoint but receives text instead of downloading the PDF itself.

---

## Phase 2 — LXC Pipeline Script

Create `/opt/era-digest/pipeline.py` (or equivalent) on the LXC.

### Dependencies

```
pip install requests beautifulsoup4 httpx
# Plus whatever OCR/PDF tool is already installed (pdftotext, pypdf, etc.)
```

### Configuration file: `/opt/era-digest/config.json`

```json
{
  "worker_base_url": "https://era-digest-worker.paul-a-robertson-d00.workers.dev",
  "admin_secret": "<ADMIN_SECRET>",
  "openrouter_api_key": "<OPENROUTER_API_KEY>",
  "openrouter_model": "anthropic/claude-sonnet-4.6",
  "era_source_url": "https://determinations.era.govt.nz/determinations/recent",
  "ec_source_url": "https://www.employmentcourt.govt.nz/judgments/decisions/?Filter_Jurisdiction=17",
  "max_new_cases_per_run": 5,
  "request_delay_seconds": 1.5
}
```

### Pseudo code: `pipeline.py`

```python
import json, time, requests
from bs4 import BeautifulSoup
from pdf_extractor import extract_text   # whatever OCR tool is installed

CONFIG = json.load(open('/opt/era-digest/config.json'))
HEADERS = {'User-Agent': 'Mozilla/5.0'}
WORKER = CONFIG['worker_base_url']
AUTH   = {'Authorization': f"Bearer {CONFIG['admin_secret']}"}


# Step 1: Scrape ERA listing

def scrape_era_listing(pages=1):
    """Return list of {filename, pdf_url, date, citation, member} dicts."""
    cases = []
    for page in range(pages):
        url = CONFIG['era_source_url']
        if page > 0:
            url += f"?start={page * 10}"
        soup = BeautifulSoup(requests.get(url, headers=HEADERS).text, 'html.parser')
        for li in soup.select('li.search-results__record'):
            pdf_link = li.select_one('a[href$=".pdf"]')
            if not pdf_link:
                continue
            pdf_path = pdf_link['href']
            pdf_url  = f"https://determinations.era.govt.nz{pdf_path}"
            filename = pdf_path.split('/')[-1]
            cases.append({
                'filename': filename,
                'pdf_url':  pdf_url,
                # ... parse date, citation, member from <li> content
            })
        time.sleep(CONFIG['request_delay_seconds'])
    return cases


# Step 2: Check which cases are new

def filter_new_cases(cases):
    """
    Ask the Worker which filenames are already in D1.
    Uses GET /admin/check-new-cases (new endpoint — see Phase 1 note).

    Option A: POST list of filenames, Worker returns unseen ones.
    Option B (interim): attempt upload and treat already_exists=true as seen.
    """
    resp = requests.post(
        f"{WORKER}/admin/check-new-cases",
        json={'filenames': [c['filename'] for c in cases]},
        headers=AUTH
    )
    seen = set(resp.json()['seen_filenames'])
    return [c for c in cases if c['filename'] not in seen]


# Step 3: Download and extract PDF text

def extract_pdf_text(pdf_url):
    """Download PDF and extract text using local OCR tool."""
    pdf_bytes = requests.get(pdf_url, headers=HEADERS).content
    text = extract_text(pdf_bytes)   # pdftotext, pypdf, etc.
    if not text or len(text.strip()) < 100:
        raise ValueError(f"Extracted text too short from {pdf_url}")
    return text


# Step 4: Fetch prompt from Workers

def get_era_prompt():
    """Read the current ERA prompt from D1 via the Workers API."""
    resp = requests.get(
        f"{WORKER}/admin/dashboard/get-prompts",
        headers=AUTH
    )
    return resp.json().get('prompt_era', '')


# Step 5: Upload result to Workers

def upload_era_case(filename, text, meta=None):
    """
    POST to /admin/upload-era-case-text (new endpoint from Phase 1).
    Workers runs summarisation server-side using the D1 prompt.
    """
    payload = {
        'filename':       filename,
        'text':           text,
        'date_published': meta.get('date') if meta else None,
        'member':         meta.get('member') if meta else None,
        'category':       meta.get('citation') if meta else None,
    }
    resp = requests.post(
        f"{WORKER}/admin/upload-era-case-text",
        json=payload,
        headers=AUTH
    )
    if resp.status_code == 200:
        result = resp.json()
        if result.get('already_exists'):
            print(f"  SKIP {filename} — already in DB")
            return False
        print(f"  OK   {filename} -> {result.get('title')}")
        return True
    else:
        print(f"  FAIL {filename} — HTTP {resp.status_code}: {resp.text}")
        return False


# Step 6: Trigger email digest

def trigger_digest_email():
    """
    Tell Workers to compose and send the digest for cases processed today.
    Uses existing POST /admin/dashboard/send-digest endpoint.
    """
    resp = requests.post(
        f"{WORKER}/admin/dashboard/send-digest",
        json={'force': False},
        headers=AUTH
    )
    print(f"Digest trigger: {resp.status_code} {resp.text}")


# Main

def main():
    print("ERA Digest LXC Pipeline starting")

    cases = scrape_era_listing(pages=2)
    new_cases = filter_new_cases(cases)
    new_cases = new_cases[:CONFIG['max_new_cases_per_run']]

    if not new_cases:
        print("No new ERA cases found")
        return

    print(f"Processing {len(new_cases)} new cases")
    uploaded = 0
    for case in new_cases:
        try:
            text = extract_pdf_text(case['pdf_url'])
            ok = upload_era_case(case['filename'], text, meta=case)
            if ok:
                uploaded += 1
            time.sleep(CONFIG['request_delay_seconds'])
        except Exception as e:
            print(f"  ERROR {case['filename']}: {e}")

    if uploaded > 0:
        trigger_digest_email()

    print(f"Done. {uploaded}/{len(new_cases)} cases uploaded.")


if __name__ == '__main__':
    main()
```

---

## Phase 3 — Replace Cloudflare Cron with Local Cron

Once the LXC pipeline is running reliably, remove the Cloudflare cron triggers from `wrangler.jsonc` to prevent the Worker running its own redundant pipeline.

### Remove from `wrangler.jsonc`:

```jsonc
// DELETE these lines:
"triggers": {
  "crons": ["0 20 * * *", "0 19 * * *"]
}
```

### Add to LXC crontab (`crontab -e`):

```cron
# ERA Digest — run at 8:00 PM NZST
# The dual CF cron workaround for DST is no longer needed here:
# set TZ and use a single trigger.
SHELL=/bin/bash
TZ=Pacific/Auckland
0 20 * * * /usr/bin/python3 /opt/era-digest/pipeline.py >> /var/log/era-digest.log 2>&1
```

> **Note:** The existing dual-cron workaround (`0 19` + `0 20`) was a Cloudflare Workers hack — Workers runs in UTC with no TZ support. On the LXC, `TZ=Pacific/Auckland` in the crontab handles DST correctly with a single trigger.

---

## Phase 4 — Simplify Workers `runDigest` to Email-Only

After the pipeline moves to LXC, the Workers `runDigest` function no longer needs to scrape, download, or call the LLM. It only needs to:

1. Check an email hasn't already been sent today
2. Load all cases processed since the last email
3. Compose the digest
4. Send via CF Email Service
5. Record `last_email_sent_at`

```typescript
// Simplified runDigest pseudo code (Workers only)
async function runDigest(env: Env, force = false): Promise<RunResult> {
  if (!force && await hasEmailBeenSentToday(env.DB, env.TIMEZONE)) return skip();

  // Get cases processed since last email send
  const newCases = await getCasesProcessedSinceLastEmail(env.DB);
  if (newCases.length === 0) return noNewCases();

  const subscribers = await getActiveSubscribers(env.DB);
  if (subscribers.length === 0) return noSubscribers();

  const notice = await getAndClearEmailNotice(env.DB);
  const { sent, failed } = await sendDigestToAll(
    subscribers, newCases, env.SENDING_ADDRESS,
    env.TIMEZONE, env.EMAIL, env.SITE_URL, notice
  );

  await recordEmailSent(env.DB);
  return { emailsSent: sent, failed };
}
```

This requires a small DB addition: either an `emailed_at` column on `seen_cases`, or tracking which cases have been included in an email send, so the Worker knows what is "new since last email".

---

## Phase 5 — EC Pipeline (Same Pattern)

The `POST /admin/upload-ec-case-text` endpoint **already exists** and accepts pre-extracted text. The LXC just needs a matching scraper.

```python
# EC scraper pseudo code
def scrape_ec_listing():
    """Scrape https://www.employmentcourt.govt.nz/judgments/decisions/?Filter_Jurisdiction=17"""
    # Parse table rows — extract PDF URL, filename, date, citation, judge name
    pass

def upload_ec_case(filename, text, meta):
    payload = {
        'filename':       filename,
        'text':           text,
        'date_published': meta.get('date'),
        'member':         meta.get('judge'),
        'category':       meta.get('citation'),
    }
    resp = requests.post(
        f"{WORKER}/admin/upload-ec-case-text",
        json=payload,
        headers=AUTH
    )
    # Same error handling as ERA upload
```

---

## Summary of Changes Required

| # | What | Where | Effort |
|---|------|-------|--------|
| 0 | Add `extracted_text` column to D1 | Migration + Workers INSERT calls | Small |
| 1 | New `POST /admin/upload-era-case-text` endpoint | `src/index.ts` | Small |
| 2 | New `POST /admin/check-new-cases` endpoint | `src/index.ts` | Small |
| 3 | Write `pipeline.py` on LXC | LXC | Medium |
| 4 | Set up LXC cron | LXC | Trivial |
| 5 | Remove cron from `wrangler.jsonc` | `wrangler.jsonc` | Trivial |
| 6 | Simplify `runDigest` in Workers | `src/index.ts` | Medium |
| 7 | EC scraper on LXC | LXC | Medium (upload endpoint exists) |

---

## Key Invariants to Preserve

- `markCaseSeen` must ONLY be called after successful email dispatch (or when there are no subscribers)
- Email notice banner must ONLY clear after successful send
- Processing lock (10-min auto-expiry) should move to LXC (use a lockfile or DB-based mutex)
- Double-encoding guardrail: still validate summary before INSERT (check for `{` or `"` prefix)
- `User-Agent: Mozilla/5.0` required on all requests to `whenroutinebiteshard.com`
- Admin auth: Bearer token in `Authorization` header (`Bearer <ADMIN_SECRET>`)
- LLM `max_tokens=4000`, timeout 45s, model `anthropic/claude-sonnet-4.6`

---

## Files to Create/Modify

```
era-digest-worker/ (repo root)
├── migrations/
│   └── 0013_add_extracted_text.sql        ← NEW
├── src/
│   └── index.ts                           ← Add upload-era-case-text + check-new-cases
│                                             Simplify runDigest (Phase 4)
└── wrangler.jsonc                         ← Remove crons (Phase 3)

/opt/era-digest/  (on LXC — not in repo)
├── config.json                            ← NEW (contains secrets — do not commit)
├── pipeline.py                            ← NEW
└── pdf_extractor.py                       ← NEW (wraps installed OCR tool)
```
