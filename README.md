# Employment Case Summaries

An automated system that scrapes employment law case determinations from the New Zealand Employment Relations Authority (ERA) and Employment Court, generates AI-powered summaries, and distributes them via email.

## 🎯 Overview

This project provides:
- **Daily automated scraping** of ERA case determinations via the ERA's sequential internal index
- **AI-powered summaries** using OpenRouter (Claude Sonnet 4.6)
- **Email distribution** to subscribers via Cloudflare Email Service
- **Public archive** of recent cases with advanced search
- **Public awards & damages statistics page** at `/awards` — remedy data, contribution analysis, penalty trends
- **Admin dashboard** for system management, prompt editing, backfill, and Employment Court case uploads
- **Double opt-in subscription** with GDPR-compliant unsubscribe links

## 🏗️ Architecture

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│            Cloudflare Workers (TypeScript)                   │
├─────────────────────────────────────────────────────────────┤
│  • Web server (GET / POST routes)                            │
│  • D1 database operations                                    │
│  • PDF text extraction & caching                             │
│  • LLM integration (OpenRouter API)                          │
│  • Email composition & sending                               │
└─────────────────────────────────────────────────────────────┘
        ↓                    ↓                    ↓
┌──────────────┐  ┌─────────────────┐  ┌──────────────────┐
│  Cloudflare  │  │  Employment     │  │  Python Sidecar  │
│  D1 (SQLite) │  │  Relations      │  │  Worker (pypdf)  │
│              │  │  Authority      │  │                  │
│  • Cases     │  │  Website        │  │  Extracts text   │
│  • Summaries │  │  (scraping)     │  │  from CID-font   │
│  • Subscribers   │              │  │  EC PDFs         │
└──────────────┘  └─────────────────┘  └──────────────────┘
```

### Data Flow

**Employment Relations Authority (Automated Daily)**
1. Cron triggers at 8am NZT (daily)
2. Probe ERA internal index `/determination/view/{id}` from last known ID upward (parallel batches of 5, 300ms delay)
3. Extract case metadata (parties, citation, PDF URL, member, date) from the detail page HTML table
4. Check D1 `seen_cases` table for duplicates (by pdf_filename)
5. Fetch PDF → extract text (FlateDecode/zlib decompression)
6. Send text to OpenRouter LLM → receive structured summary with AWARDS_DATA block
7. Store summary + structured awards data in D1
8. Compose HTML email with all new cases
9. Send to all active subscribers
10. Log run metadata, update `last_era_id` high-water mark

**Employment Court (Manual via Admin Dashboard)**
1. User uploads EC PDF via admin dashboard
2. Worker sends bytes to Python sidecar (pypf)
3. Python sidecar extracts text (handles CID fonts)
4. Send text to OpenRouter LLM (EC-specific prompt)
5. Store summary in D1
6. Email sent manually (not automatic)

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Cloudflare account with Workers enabled
- D1 database created
- Domain with Email Routing enabled (optional but recommended)

### Local Development

1. **Clone and install**
   ```bash
   git clone https://github.com/yourusername/employment-case-summaries
   cd employment-case-summaries
   npm install
   ```

2. **Set up environment variables**
   ```bash
   cp .env.example .env.local
   # Edit .env.local with your credentials
   ```

3. **Create D1 database** (if not already created)
   ```bash
   wrangler d1 create era-digest
   # Copy the database_id into wrangler.jsonc
   ```

4. **Run migrations**
   ```bash
   npm run db:migrate:local
   npm run db:seed:local
   ```

5. **Set secrets**
   ```bash
   wrangler secret put OPENROUTER_API_KEY
   wrangler secret put ADMIN_SECRET
   ```

6. **Start local dev server**
   ```bash
   npm run dev
   # Visit http://localhost:8787
   ```

## 📋 Configuration

### Environment Variables

See `.env.example` for all required variables:

| Variable | Purpose | Example |
|----------|---------|---------|
| `OPENROUTER_API_KEY` | LLM API key (secret) | `sk-or-v1-...` |
| `ADMIN_SECRET` | Admin authentication (secret) | `<your-admin-secret>` |
|| `OPENROUTER_MODEL` | LLM model to use | `anthropic/claude-sonnet-4.6` |
| `SENDING_ADDRESS` | Email sender address | `digest@yourdomain.com` |
| `ADMIN_EMAIL` | Admin alert recipient | `admin@example.com` |
| `TIMEZONE` | Cron timezone | `Pacific/Auckland` |
| `SITE_URL` | Website base URL | `https://yourdomain.com` |
| `SOURCE_URL` | ERA scraping URL | `https://determinations.era.govt.nz/determinations/recent` |

### Database Schema

The system uses three main tables:

**`cases`** — Processed case summaries
```sql
id, pdf_filename, source, citation, parties, representatives, facts,
legal_issues, resolutions, outcome, remedy, summary_json, pdf_url,
judge_name, created_at
```

**`subscribers`** — Email subscribers
```sql
id, email, name, confirmed, confirmation_token, confirmation_sent_at,
created_at, unsubscribed_at, unsubscribe_token
```

**`seen_cases`** — Deduplication cache
```sql
id, pdf_filename, source, created_at
```

**`config`** — System configuration
```sql
key (primary), value, updated_at
```

## 🔐 Security

### Secret Management

This project uses Cloudflare Secrets (not environment variables) for sensitive data:

```bash
# Set these via wrangler CLI, NOT in wrangler.jsonc
wrangler secret put OPENROUTER_API_KEY
wrangler secret put ADMIN_SECRET
```

**Why?** Secrets are stored in Cloudflare's secure vault and never appear in:
- Git repositories
- Log files
- Worker source code

### Authentication

- **Public routes** (landing page, sign-up, archive): No auth
- **Admin dashboard**: Session cookie + password check
- **Admin API endpoints**: Bearer token (ADMIN_SECRET header)
- **Subscription confirmation**: Cryptographic token

### Email Security

- Unsubscribe links are **one-click** with unique tokens
- Confirmation emails use **double opt-in** (prevent abuse)
- Unconfirmed subscribers auto-delete after 48 hours

## 📧 Email Template

Emails include:

1. **Header** — Optional notice banner (set via D1 config)
2. **Employment Court section** — EC cases (if any)
3. **ERA section** — ERA cases (if any)
4. **Footer** — Personalized unsubscribe link

**Summary structure per case:**
- Parties & Representatives
- Brief summary of facts
- Legal issues raised (numbered)
- How each issue was resolved (numbered)
- Outcome & remedy
- Links: "View case summary" + "Download PDF"

## 🛠️ Deployment

Deployment is automatic via **GitHub Actions** on push to `main`:

```bash
git add .
git commit -m "Your message"
git push origin main
# GitHub Actions auto-deploys to Cloudflare Workers
```

The workflow is defined in `.github/workflows/deploy.yml`. It runs `npm install` then `wrangler deploy` with secrets passed from GitHub repository secrets.

### Manual CLI Deployment (Fallback)

```bash
# Set secrets first (one-time)
npm run secret:openrouter
npm run secret:admin

# Deploy
npm run deploy

# View logs
npm run logs
```

> ⚠️ Do NOT use the Cloudflare Dashboard "Quick Editor" / browser paste method — it does not bundle all source files correctly and will produce broken deployments. Always use `wrangler deploy` or the GitHub Actions workflow.

### Python Sidecar Setup

The system includes an optional Python worker for extracting text from Employment Court PDFs (which use CID fonts):

1. Create a new Cloudflare Worker with Python runtime
2. Copy `python-sidecar/main.py` into the worker
3. Set service binding in `wrangler.jsonc`:
   ```json
   "services": [
     {
       "binding": "PDF_PARSER",
       "service": "pdf-parser-python",
       "environment": "production"
     }
   ]
   ```

See [Python Sidecar Setup](./docs/PYTHON_SIDECAR.md) for details.

## 🔌 API Endpoints

### Public Routes

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Landing page + archive |
| `/subscribe` | POST | Sign-up form handler |
| `/confirm?token=X` | GET | Activate subscription |
| `/unsubscribe?token=X` | GET | One-click unsubscribe |
| `/health` | GET | Health check (public) |

### Admin Routes (Authenticated)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/admin` | GET | Cookie | Dashboard (login or main dashboard) |
| `/admin` | POST | Cookie | Login form submission |
| `/admin/logout` | GET | Cookie | Clear session cookie |
| `/run` | POST | Bearer | Manually trigger full pipeline |
| `/admin/status` | GET | Bearer | System status & analytics |
| `/admin/upload-ec-case` | POST | Cookie | Upload EC PDF for processing |
| `/admin/send-digest` | POST | Bearer | Send digest from stored cases |
| `/admin/preview-digest` | GET | Cookie | Preview email HTML |
| `/admin/dashboard/backfill-era` | POST | Cookie | Scrape ERA pages 1–N silently (no email) |
| `/admin/dashboard/upload-era-url` | POST | Cookie | Process a single ERA case by PDF URL |
| `/admin/dashboard/backfill-awards` | POST | Cookie | Extract awards data from existing summaries |
| `/admin/dashboard/get-prompts` | GET | Cookie | Load LLM prompts from D1 |
| `/admin/dashboard/update-prompts` | POST | Cookie | Save LLM prompts to D1 |
| `/admin/dashboard/revert-prompt` | POST | Cookie | Revert prompt to a previous version |
| `/admin/dashboard/rescan-cases` | POST | Cookie | Delete + reprocess last N cases |
| `/admin/seed-seen` | POST | Bearer | Mark all current ERA cases as seen |
| `/admin/clear-seen` | POST | Bearer | Clear seen_cases table (requires confirm) |
| `/admin/errors` | GET | Bearer | Retrieve last pipeline error |
| `/admin/test-llm` | GET | Bearer | Test OpenRouter connectivity |
| `/admin/test-email` | POST | Bearer | Send test email to first subscriber |
| `/admin/delete-subscriber` | POST | Cookie | Delete a subscriber |
| `/admin/delete-seen-case` | POST | Bearer | Delete a single case from seen_cases |
| `/admin/backfill-status` | GET | Cookie | Backfill progress (scrape_status counts) |

**Additional public routes:**
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/awards` | GET | None | Public awards & damages statistics |
| `/remedies` | GET | None | Redirects to /awards |
| `/preferences?token=X` | GET | None | Per-subscriber preferences page |
| `/subscribed` | GET | None | "Check your email" confirmation page |

**Bearer token format:**
```
Authorization: Bearer <ADMIN_SECRET>
```

## 🧪 Testing

### Manual Pipeline Trigger

```bash
curl -X POST https://yourworker.com/run \
  -H "Authorization: Bearer your-admin-secret" \
  -H "User-Agent: Mozilla/5.0"
```

### Send Test Email

```bash
curl -X POST https://yourworker.com/admin/test-email \
  -H "Authorization: Bearer your-admin-secret" \
  -H "User-Agent: Mozilla/5.0"
```

### Check LLM Connection

```bash
curl https://yourworker.com/admin/test-llm \
  -H "Authorization: Bearer your-admin-secret"
```

## 📊 Database Migrations

All 12 migrations in the `migrations/` directory run automatically on deploy:

| File | Purpose |
|------|---------|
| `0001_initial.sql` | Create base tables (seen_cases, subscribers, config) |
| `0002_seed.sql` | Seed test subscriber |
| `0003_add_pdf_url.sql` | Add PDF URL column |
| `0004_add_confirmed.sql` | Add confirmation status tracking |
| `0005_pdf_filename_primary_key.sql` | Fix deduplication (PDF filename as primary key) |
| `0006_add_source_column.sql` | Add source tracking (ERA vs EC) |
| `0007_add_llm_prompts.sql` | Seed LLM prompts into config |
| `0008_add_subscriber_preferences.sql` | Add subscriber preferences column |
| `0009_add_confirm_token.sql` | Add confirm_token column for double opt-in |
| `0010_add_case_awards.sql` | Awards tracking table (remedy amounts) |
| `0011_add_subscriber_preferences.sql` | Add preferences JSON column |
| `0012_prompt_versions.sql` | Prompt version history for undo/rollback |
| `0013_add_summary_version.sql` | Track prompt version per case summary |
| `0015_add_extended_awards.sql` | Extended awards: contribution, penalties, tenure |

To apply migrations manually:
```bash
npm run db:migrate
npm run db:seed
```

## 🐍 Python Sidecar Worker

The Python sidecar handles PDF text extraction for Employment Court cases, which use CID font encoding that JavaScript cannot parse.

**Location:** `python-sidecar/main.py`

**Dependencies:**
- `pypdf==4.2.0` — Handles CID font lookup tables

**Why?** Employment Court PDFs store glyph indices (e.g., `<0036>`) that require ToUnicode mapping to render as text. The Python library `pypdf` handles this natively, while JavaScript/Cloudflare Workers cannot.

## 🔧 Troubleshooting

### "No new cases" emails
The system **deliberately skips** sending emails when no new cases are found. This is intentional—check the logs to confirm the scraper is running.

### PDF text extraction empty
- **ERA cases:** Should work (FlateDecode/Latin-1). Check PDF format.
- **EC cases:** Requires Python sidecar. Verify the worker is deployed and service binding is correct.

### Unconfirmed subscribers stuck
A cron job automatically deletes unconfirmed subscribers after 48 hours. Check `deleteStalePendingSubscribers()` in `src/index.ts`.

### Email not sending
- Verify Email Service is enabled on your domain
- Check D1 for subscriber records with `confirmed=1`
- Review worker logs for SMTP errors

## 📚 Documentation

- [DEPLOYMENT.md](./docs/DEPLOYMENT.md) — Deployment guide
- [PYTHON_SIDECAR.md](./docs/PYTHON_SIDECAR.md) — Python worker setup
- [SETUP.md](./SETUP.md) — Original setup guide
- [HANDOVER.md](./HANDOVER.md) — Agent handover & maintenance guide
- [SECURITY.md](./SECURITY.md) — Secret management guidelines

## 🤝 Contributing

This is a personal project, but suggestions are welcome:

1. Fork the repository
2. Create a feature branch
3. Submit a pull request with clear description

## 📝 License

MIT License — See [LICENSE](./LICENSE)

## ⚙️ Tech Stack

- **Runtime:** Cloudflare Workers (TypeScript)
- **Database:** Cloudflare D1 (SQLite)
- **Email:** Cloudflare Email Service
- **Web scraping:** HTMLRewriter
- **PDF processing:** FlateDecode (ERA), pypdf (EC)
- **LLM:** OpenRouter API (Claude Sonnet 4.6)
- **Hosting:** Cloudflare Workers (serverless)

## 📞 Support

For issues or questions:
1. Check [Troubleshooting](#-troubleshooting) section
2. Review worker logs: `npm run logs`
3. Inspect D1 database: `wrangler d1 execute era-digest --remote "SELECT * FROM cases LIMIT 5;"`

---

**Last updated:** June 2026
