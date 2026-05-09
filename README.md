# Employment Case Summaries

An automated system that scrapes employment law case determinations from the New Zealand Employment Relations Authority (ERA) and Employment Court, generates AI-powered summaries, and distributes them via email.

## 🎯 Overview

This project provides:
- **Daily automated scraping** of ERA case determinations
- **AI-powered summaries** using OpenRouter (Claude 3.5 Sonnet)
- **Email distribution** to subscribers via Cloudflare Email Service
- **Public archive** of recent cases with advanced search
- **Admin dashboard** for system management and Employment Court case uploads
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
2. Scrape https://determinations.era.govt.nz/determinations/recent
3. Extract case metadata (parties, citation, PDF URL)
4. Check D1 `seen_cases` table for duplicates
5. Fetch PDF → extract text (FlateDecode/zlib decompression)
6. Send text to OpenRouter LLM → receive structured summary
7. Store summary in D1
8. Compose HTML email with all new cases
9. Send to all active subscribers
10. Log run metadata

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
| `ADMIN_SECRET` | Admin authentication (secret) | `Banana1717` |
| `OPENROUTER_MODEL` | LLM model to use | `anthropic/claude-3.5-sonnet-20241022` |
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

### Option 1: Browser Paste (Recommended)

1. Go to **Cloudflare Dashboard** → **Workers & Pages** → **era-digest-worker** → **Edit Code**
2. Copy contents of `src/index.ts` (and other files as needed)
3. Paste into the Quick Editor
4. Ignore TypeScript warning about gzip
5. Click **Save and Deploy**

### Option 2: CLI Deployment

```bash
# Set secrets first
npm run secret:openrouter
npm run secret:admin

# Deploy
npm run deploy

# View logs
npm run logs
```

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
| `/admin` | GET | Cookie | Dashboard (protected) |
| `/admin` | POST | Cookie | Login form submission |
| `/run` | POST | Bearer | Manually trigger full pipeline |
| `/admin/status` | GET | Bearer | System status & analytics |
| `/admin/upload-ec-case` | POST | Cookie | Upload EC PDF for processing |
| `/admin/send-digest` | POST | Bearer | Send digest from stored cases |
| `/admin/preview-digest` | GET | Cookie | Preview email HTML |

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

Migrations are in the `migrations/` directory and run automatically on deploy:

| File | Purpose |
|------|---------|
| `0001_initial.sql` | Create base tables (cases, subscribers, seen_cases) |
| `0002_seed.sql` | Seed test subscriber |
| `0003_add_pdf_url.sql` | Add PDF URL column |
| `0004_add_confirmed.sql` | Add confirmation status tracking |
| `0005_pdf_filename_primary_key.sql` | Fix deduplication (PDF filename as primary key) |
| `0006_add_source_column.sql` | Add source tracking (ERA vs EC) |

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

- [DEPLOYMENT.md](./docs/DEPLOYMENT.md) — Detailed deployment guide
- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — System architecture & design decisions
- [PYTHON_SIDECAR.md](./docs/PYTHON_SIDECAR.md) — Python worker setup
- [SETUP.md](./SETUP.md) — Original setup guide

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
- **LLM:** OpenRouter API (Claude 3.5 Sonnet)
- **Hosting:** Cloudflare Workers (serverless)

## 📞 Support

For issues or questions:
1. Check [Troubleshooting](#-troubleshooting) section
2. Review worker logs: `npm run logs`
3. Inspect D1 database: `wrangler d1 execute era-digest --remote "SELECT * FROM cases LIMIT 5;"`

---

**Last updated:** May 2026
