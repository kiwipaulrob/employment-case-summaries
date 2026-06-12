# Deployment Guide

Complete step-by-step instructions for deploying the Employment Case Summaries system.

## Prerequisites

- [ ] Cloudflare account (free or paid)
- [ ] Domain with Cloudflare DNS
- [ ] Node.js 18+ installed
- [ ] `wrangler` CLI installed (`npm install -g wrangler`)
- [ ] OpenRouter account with API key (https://openrouter.ai)

## Step 1: Cloudflare Setup

### 1.1 Enable Email Service

1. Go to **Cloudflare Dashboard** → **Email** → **Email Routing**
2. Select your domain
3. Click **Enable Email Routing**
4. Add forwarding rule: `digest@yourdomain.com` → your personal email

### 1.2 Create D1 Database

```bash
cd employment-case-summaries
wrangler d1 create era-digest
```

This outputs a database ID. Copy it.

### 1.3 Update wrangler.jsonc

Edit `wrangler.jsonc` and replace the `database_id` value:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "era-digest",
    "database_id": "YOUR_DATABASE_ID_HERE",  // ← Paste here
    "migrations_dir": "migrations"
  }
]
```

### 1.4 Configure Environment Variables

Edit `wrangler.jsonc` → `vars` section:

```jsonc
"vars": {
  "SENDING_ADDRESS": "digest@yourdomain.com",  // Your email address
  "ADMIN_EMAIL": "admin@yourdomain.com",       // Alert recipient
  "SITE_URL": "https://yourdomain.com",        // Your domain
  "TIMEZONE": "Pacific/Auckland",               // Your timezone
  "OPENROUTER_MODEL": "anthropic/claude-sonnet-4.6"
}
```

## Step 2: Database Setup

### 2.1 Create Tables

```bash
wrangler d1 migrations apply era-digest --remote
```

### 2.2 Seed Initial Data

```bash
wrangler d1 execute era-digest --remote --file=migrations/0002_seed.sql
```

This creates one test subscriber.

## Step 3: Set Secrets

### 3.1 OpenRouter API Key

Get your API key from https://openrouter.ai/keys

```bash
wrangler secret put OPENROUTER_API_KEY
# Paste your key when prompted
```

### 3.2 Admin Password

Choose a strong password for the `/admin` dashboard:

```bash
wrangler secret put ADMIN_SECRET
# Enter your password when prompted
```

## Step 4: Deploy

### GitHub Actions (Recommended)

Deployment is automatic on push to `main`. The workflow is defined in `.github/workflows/deploy.yml`.

### CLI Deploy (Manual Fallback)

```bash
npm run deploy
```

This bundles all TypeScript files and deploys via `wrangler deploy`.

> ⚠️ Do NOT use the Cloudflare Dashboard Quick Editor / browser paste method for full deployments — it does not bundle all source files correctly. The Quick Editor is only suitable for testing small snippets. Always use `wrangler deploy` or the GitHub Actions workflow for production deployments.

## Step 5: Verify Deployment

### 5.1 Check Health

```bash
curl https://yourdomain.com/health
# Should return: {"status": "ok"}
```

### 5.2 Test LLM Connection

```bash
curl https://yourdomain.com/admin/test-llm \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET"
# Should return connection status
```

### 5.3 Check Admin Dashboard

1. Go to `https://yourdomain.com/admin`
2. Enter your `ADMIN_SECRET` password
3. You should see the admin dashboard

## Step 6: Python Sidecar (EC PDF Support)

If you plan to upload Employment Court PDFs, set up the Python sidecar:

### 6.1 Create Python Worker

1. Go to **Cloudflare Dashboard** → **Workers & Pages** → **Create**
2. Choose **Python** as the language
3. Name it `pdf-parser-python`
4. Copy the contents of `python-sidecar/main.py` into the worker editor
5. Update the `requirements.txt` (in the Python editor):
   ```
   pypdf==4.2.0
   ```
6. Deploy

### 6.2 Update Service Binding

In `wrangler.jsonc`, ensure the service binding exists:

```jsonc
"services": [
  {
    "binding": "PDF_PARSER",
    "service": "pdf-parser-python",
    "environment": "production"
  }
]
```

Then redeploy:
```bash
npm run deploy
```

## Step 7: Test the Full Pipeline

### 7.1 Manual Pipeline Trigger

```bash
curl -X POST https://yourdomain.com/run \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
  -H "User-Agent: Mozilla/5.0"
```

This scrapes the ERA website and sends a digest (if new cases are found).

### 7.2 Check Logs

```bash
npm run logs
# View real-time worker logs
```

### 7.3 Check Database

```bash
wrangler d1 execute era-digest --remote "SELECT COUNT(*) as count FROM cases;"
```

If you see cases with non-zero count, the pipeline worked!

## Step 8: Production Configuration

### 8.1 Update Subscriber

The seed migration creates one test subscriber. Replace it with your email:

```bash
wrangler d1 execute era-digest --remote "
UPDATE subscribers 
SET email = 'your-real@email.com', name = 'Your Name' 
WHERE id = 1;
"
```

### 8.2 Customize Landing Page

Edit `src/pages.ts` → `homePage()` function to customize:
- Hero title & description
- Sign-up form text
- Archive display settings

### 8.3 Set Cron Schedule

In `wrangler.jsonc`, the crons are set to 8am NZT daily:

```jsonc
"triggers": {
  "crons": [
    "0 20 * * *",  // Oct–Mar (NZDT, UTC+13)
    "0 19 * * *"   // Apr–Sep (NZST, UTC+12)
  ]
}
```

Modify if needed for your timezone.

## Troubleshooting

### "Email not sending"

1. Check Cloudflare Email Routing is enabled
2. Verify SENDING_ADDRESS is correct
3. Check D1 for active subscribers:
   ```bash
   wrangler d1 execute era-digest --remote "
   SELECT email, confirmed FROM subscribers;
   "
   ```
4. Ensure subscriber has `confirmed = 1`

### "Database migration failed"

```bash
# Check what migrations have run
wrangler d1 execute era-digest --remote "SELECT * FROM _cf_KV;"

# Manually run a specific migration
wrangler d1 migrations apply era-digest --remote
```

### "No new cases found"

1. Check ERA website manually: https://determinations.era.govt.nz/determinations/recent
2. View worker logs: `npm run logs`
3. Check `seen_cases` table:
   ```bash
   wrangler d1 execute era-digest --remote "
   SELECT COUNT(*) FROM seen_cases;
   "
   ```

### "LLM returns empty summary"

1. Verify OpenRouter API key is set correctly
2. Check account has available credits
3. Test the API directly:
   ```bash
   curl https://openrouter.ai/api/v1/models
   ```

### "Python sidecar not responding"

1. Verify `pdf-parser-python` worker is deployed
2. Check service binding name in `wrangler.jsonc` (must be `PDF_PARSER`)
3. Verify main worker can call it:
   ```bash
   curl https://yourdomain.com/admin/test-llm
   # Should succeed if binding works
   ```

## Monitoring & Maintenance

### Regular Checks

- **Weekly:** Review case summaries in the archive
- **Monthly:** Check subscriber list (unconfirmed accounts auto-delete after 48h)
- **Monthly:** Review error logs
- **Quarterly:** Update LLM model if needed

### Backup Your Data

D1 databases are backed up by Cloudflare, but you can export manually:

```bash
# Export all cases
wrangler d1 execute era-digest --remote "
SELECT * FROM cases;
" > cases-backup.json
```

### Update Dependencies

```bash
npm outdated
npm update
npm run deploy
```

## Scaling Considerations

### Current Limits
- **Cron:** 1 execution per day
- **Subscribers:** Unlimited (within Cloudflare limits)
- **Email rate:** ~100/min (Cloudflare limit)
- **Database:** D1 free tier = 3GB

### To increase capacity
1. **More frequent scraping:** Change `TRIGGER_MODE` to `change_detection` in vars
2. **Larger database:** Upgrade D1 plan
3. **Concurrent processing:** Add worker instances (via wrangler configuration)

## Support

If you encounter issues:

1. Check the troubleshooting section above
2. Review worker logs: `npm run logs`
3. Inspect D1 directly: `wrangler d1`
4. Check Cloudflare status: https://www.cloudflarestatus.com

---

**Last updated:** May 2026
