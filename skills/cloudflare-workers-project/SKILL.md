---
name: cloudflare-workers-project
description: "Use when managing or building a Cloudflare Workers project with D1, Cron Triggers, Service Bindings, or GitHub Actions CI/CD. Covers wrangler CLI, migrations, secrets, deployment patterns, and production debugging."
version: 1.0.0
author: Tasklet
license: MIT
metadata:
  hermes:
    tags: [cloudflare, workers, d1, wrangler, typescript, devops, cron, github-actions]
    category: devops
    requires_toolsets: [terminal]
---

# Cloudflare Workers Project Management

## Overview

Cloudflare Workers is a serverless JavaScript/TypeScript runtime that runs at the edge. Projects in this stack typically combine:

- **Workers** — TypeScript/JS request handlers and scheduled jobs
- **D1** — SQLite-based serverless database (bound directly, no connection string)
- **Cron Triggers** — scheduled handlers (cron expressions in `wrangler.jsonc`)
- **Service Bindings** — zero-latency Worker-to-Worker calls (no HTTP round-trip)
- **Email Workers** — send email via Cloudflare Email Service (beta)
- **Secrets** — managed via `wrangler secret put`, never in source

The canonical project structure uses `wrangler.jsonc` for config, TypeScript source in `src/`, and SQL migrations in `migrations/`. Deployment is via `wrangler deploy` or GitHub Actions with `cloudflare/wrangler-action@v3`.

**Key constraint**: Workers have a 128 MB memory limit and a 30-second CPU time limit (on paid plans). The free tier is 10 ms CPU time per request.

## When to Use

- Adding or modifying a Workers project (new routes, cron jobs, bindings)
- Running D1 migrations or querying the production database
- Debugging production issues via `wrangler tail`
- Rotating secrets, updating environment variables
- Setting up or fixing GitHub Actions deployment
- Adding a Python sidecar worker for heavy processing (e.g., PDF extraction)
- Troubleshooting D1 migration state conflicts
- Any task involving `wrangler` CLI commands

**Do NOT** call Cloudflare REST APIs from within a Worker for services that have bindings (D1, R2, KV, Queues). Use the binding directly — no network hop, no auth token needed.

## wrangler Configuration Reference

The project config file is `wrangler.jsonc` (JSON with comments). Keep `compatibility_date` current and always include `nodejs_compat`.

```jsonc
{
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",       // Update regularly
  "compatibility_flags": ["nodejs_compat"],  // Required for node: built-ins

  "vars": {
    "MY_NON_SECRET_VAR": "some-value"        // Non-secret config only
  },

  // D1 database binding
  "d1_databases": [
    { "binding": "DB", "database_name": "my-db", "database_id": "xxxx-uuid" }
  ],

  // Cron triggers
  "triggers": {
    "crons": ["0 20 * * *"]                  // UTC — always use UTC
  },

  // Custom domain (Worker IS the origin)
  "routes": [
    { "pattern": "example.com", "custom_domain": true }
  ],

  // Service binding to another worker
  "services": [
    { "binding": "SIDECAR", "service": "my-sidecar-worker" }
  ],

  // Email binding (beta — no REST API available)
  "send_email": [
    { "name": "SEND_EMAIL" }
  ],

  // Observability (recommended for production)
  "observability": {
    "enabled": true,
    "logs": { "head_sampling_rate": 1 }
  }
}
```

**DST dual-cron pattern** — when the target time is timezone-sensitive (e.g., 8am NZT), use two crons to cover both summer and winter offsets:
```jsonc
"crons": ["0 19 * * *", "0 20 * * *"]
```
The scheduled handler should guard against double-fire by checking a `lastRunAt` timestamp in D1.

## D1 Database Operations

**Always include `--remote` when targeting the production database.** Without it, wrangler silently operates on a local SQLite file.

```powershell
# Run a SQL file against production
wrangler d1 execute my-db --remote --file "migrations\0001_initial.sql"

# Run an inline query (Windows PowerShell: use single quotes inside --command)
wrangler d1 execute my-db --remote --command "SELECT * FROM config WHERE key = 'prompt_era';"

# List all databases in account
wrangler d1 list

# Database info (size, row counts)
wrangler d1 info my-db

# Export schema + data
wrangler d1 export my-db --remote --output backup.sql

# Time Travel — restore to 30 minutes ago
wrangler d1 time-travel restore my-db --timestamp "2026-06-01T08:00:00Z"
```

**Migrations workflow:**
```powershell
# Create a new migration file (auto-numbered)
wrangler d1 migrations create my-db "add_user_preferences"

# Check which migrations are pending
wrangler d1 migrations list my-db --remote

# Apply all pending migrations
wrangler d1 migrations apply my-db --remote
```

**Migration state conflict fix** — if migrations were applied manually before wrangler started tracking them, the `d1_migrations` table will be out of sync. Fix: insert rows directly into `d1_migrations` to mark them as applied:
```sql
INSERT INTO d1_migrations (name, applied_at)
VALUES ('0003_add_source_column.sql', datetime('now'));
```

**D1 from within a Worker** — use the binding, never fetch the REST API:
```typescript
// In your Env interface
interface Env { DB: D1Database; }

// Query
const result = await env.DB.prepare('SELECT * FROM cases WHERE id = ?').bind(id).first();

// Insert
await env.DB.prepare('INSERT INTO cases (title, summary) VALUES (?, ?)').bind(title, summary).run();

// INSERT OR IGNORE (safe deduplication — does NOT update existing rows)
await env.DB.prepare('INSERT OR IGNORE INTO seen_cases (pdf_filename, source) VALUES (?, ?)').bind(filename, source).run();
```

## Secrets and Environment Variables

**Never put secrets in `wrangler.jsonc` or source code.** Use `wrangler secret put` for production secrets and a `.env` file (gitignored) for local dev.

```powershell
# Add/update a secret (prompted interactively)
wrangler secret put OPENROUTER_API_KEY

# Pipe a value non-interactively (CI/CD)
echo "sk-or-v1-..." | wrangler secret put OPENROUTER_API_KEY

# List all secrets for a worker
wrangler secret list

# Delete a secret
wrangler secret delete OLD_SECRET_NAME
```

Access at runtime via `env.SECRET_NAME` — identical API to `vars`, but encrypted at rest.

**GitHub Actions secrets** — store `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets. Reference via `secrets:` block in the workflow YAML.

## Deployment — GitHub Actions

Standard `deploy.yml` (push to `main` triggers deploy):

```yaml
name: Deploy Worker
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm install
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
        env:
          ADMIN_SECRET: ${{ secrets.ADMIN_SECRET }}
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

**Critical**: Do NOT add a separate `npm run build` step. Wrangler compiles TypeScript automatically during `wrangler deploy`. Adding a manual build step breaks the pipeline.

**GitHub connection limitation**: The GitHub connection in Tasklet CANNOT push workflow files to `.github/workflows/`. Those must be edited via the GitHub web UI.

**Manual deploy from local machine:**
```powershell
cd C:\Users\<user>\my-project
npm run deploy   # which calls: wrangler deploy
```

## Cron Triggers and Scheduled Handlers

```typescript
export default {
  // HTTP handler
  async fetch(request: Request, env: Env): Promise<Response> { ... },

  // Cron handler — fires for every matching cron expression
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Guard against double-fire (dual-cron DST workaround)
    const lastRun = await env.DB.prepare("SELECT value FROM config WHERE key = 'lastRunAt'").first<{value: string}>();
    const hoursSinceLast = lastRun ? (Date.now() - new Date(lastRun.value).getTime()) / 3600000 : 999;
    if (hoursSinceLast < 12) return; // skip if ran in last 12h

    ctx.waitUntil(runPipeline(env));
  }
};
```

**Simulate a cron locally:**
```powershell
wrangler dev --test-scheduled
# Then in another terminal:
curl "http://localhost:8787/__scheduled?cron=0+20+*+*+*"
```

**Trigger cron manually in production** (for testing):
```powershell
# Via HTTP endpoint (add one in your worker):
curl -X POST https://my-worker.example.com/run `
  -H "Authorization: Bearer $ADMIN_SECRET" `
  -H "User-Agent: Mozilla/5.0"
```

**⚠️ Cloudflare bot protection**: Programmatic requests to Workers deployed on custom domains may receive `403 Forbidden` without a valid `User-Agent` header. Always include `User-Agent: Mozilla/5.0` in curl/fetch calls to your own worker.

## Service Bindings (Worker-to-Worker)

Use when one Worker needs to call another without a public HTTP round-trip. Zero latency, no auth required.

```jsonc
// In the calling worker's wrangler.jsonc:
"services": [
  { "binding": "PDF_PARSER", "service": "pdf-parser-python" }
]
```

```typescript
// In Env interface:
interface Env { PDF_PARSER: Fetcher; }

// Calling the sidecar:
const response = await env.PDF_PARSER.fetch('https://internal/parse-pdf', {
  method: 'POST',
  body: pdfBytes,
  headers: { 'Content-Type': 'application/pdf' },
  signal: AbortSignal.timeout(20000)  // 20-second circuit breaker
});
```

**Python Workers sidecar pattern** — useful when TypeScript lacks a library for a task (e.g., CID-font PDF extraction). The Python worker uses `pypdf` to extract text, deployed separately:

```python
# python-sidecar/main.py (Python Workers beta)
from pypdf import PdfReader
import io

async def on_fetch(request, env):
    pdf_bytes = await request.bytes()
    reader = PdfReader(io.BytesIO(pdf_bytes))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    return Response(text)
```

Always implement a fallback in the calling Worker if the sidecar times out or errors.

## Observability and Debugging

**Live logs** (streams logs from deployed worker in real time):
```powershell
wrangler tail my-worker
wrangler tail my-worker --format json   # structured output
wrangler tail my-worker --search "ERROR"
```

**Structured logging** (searchable in Workers Observability dashboard):
```typescript
console.log(JSON.stringify({ message: "case processed", caseId, source }));
console.error(JSON.stringify({ message: "LLM timeout", caseId, durationMs }));
```

**Workers Observability dashboard**: https://dash.cloudflare.com → Workers & Pages → your worker → Logs

**Check worker status / recent invocations**: Workers dashboard → Metrics tab shows request count, error rate, CPU time, duration.

## Processing Lock Pattern (preventing cron double-fire)

Store a lock in D1 `config` table with a timestamp. Auto-expire stale locks after 10 minutes:

```typescript
async function acquireLock(db: D1Database): Promise<boolean> {
  const now = Date.now();
  const existing = await db.prepare("SELECT value FROM config WHERE key = 'processingLock'").first<{value: string}>();
  if (existing) {
    const lockAge = now - parseInt(existing.value);
    if (lockAge < 10 * 60 * 1000) return false; // locked
  }
  await db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('processingLock', ?)").bind(String(now)).run();
  return true;
}

// Always release in finally block:
try {
  if (!await acquireLock(env.DB)) return;
  await runPipeline(env);
} finally {
  await env.DB.prepare("DELETE FROM config WHERE key = 'processingLock'").run();
}
```

## Common Pitfalls

1. **Forgetting `--remote`** — `wrangler d1 execute` defaults to local. Every production D1 command needs `--remote`. Symptom: query runs silently but production DB unchanged.

2. **Double-encoded JSON in D1** — if LLM output is `JSON.stringify`'d before storing in a TEXT column, it arrives as a JSON string within a JSON string. Add a fast-fail guard: check if `summary.startsWith('{')` before INSERT and throw immediately.

3. **`npm run build` does not exist** — wrangler handles TypeScript compilation. Never add a manual build step to CI. The correct deploy command is `npm run deploy` (which calls `wrangler deploy`).

4. **Migration state mismatch** — if migrations were applied manually before wrangler tracked state, `wrangler d1 migrations apply` will try to re-run them. Fix: manually insert completed migration names into the `d1_migrations` table.

5. **Cloudflare bot protection (403)** — custom-domain Workers can reject programmatic requests without a browser-like `User-Agent`. Always set `User-Agent: Mozilla/5.0` for curl/fetch to your own worker endpoints.

6. **`ctx.waitUntil()` — don't destructure** — `const { waitUntil } = ctx` loses `this` binding and throws "Illegal invocation". Always call `ctx.waitUntil(...)` directly.

7. **Global mutable state** — Workers reuse isolates. Variables set in one request persist to the next. Never store request-scoped data in module-level variables.

8. **Email Workers has no REST API** — Cloudflare Email Service (beta) can only be called via the `SEND_EMAIL` binding from within a Worker, not via any external HTTP API.

9. **`INSERT OR IGNORE` does NOT update** — it silently no-ops if the row exists. Use `INSERT OR REPLACE` or a separate `UPDATE` when you need to overwrite an existing row.

10. **Windows PowerShell quoting** — in `--command "..."` strings, use single quotes for SQL string literals. Double quotes inside double quotes cause parse errors on Windows.

## Verification Checklist

- [ ] `wrangler.jsonc` has current `compatibility_date` (within ~6 months)
- [ ] `compatibility_flags: ["nodejs_compat"]` present
- [ ] All secrets stored via `wrangler secret put`, not in source or `vars`
- [ ] `.env` and any credential files are in `.gitignore`
- [ ] D1 migrations applied to production (`wrangler d1 migrations list --remote` shows none pending)
- [ ] Cron expressions tested with `wrangler dev --test-scheduled`
- [ ] `wrangler tail` streaming live logs before testing production endpoints
- [ ] Python sidecar deployed separately and service binding name matches `wrangler.jsonc`
- [ ] GitHub Actions secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) set in repo settings
- [ ] Worker responding at custom domain with `GET /health` → 200

## One-Shot Recipes

**Seed a config value into D1 production:**
```powershell
wrangler d1 execute my-db --remote --command "INSERT OR REPLACE INTO config (key, value) VALUES ('my_key', 'my_value');"
```

**View recent processed cases:**
```powershell
wrangler d1 execute my-db --remote --command "SELECT id, title, created_at FROM seen_cases ORDER BY created_at DESC LIMIT 10;"
```

**Rotate an API key (e.g., OpenRouter):**
```powershell
echo "sk-or-v1-newkey..." | wrangler secret put OPENROUTER_API_KEY
# Verify (lists secret names only, not values):
wrangler secret list
```

**Full backup before a risky migration:**
```powershell
wrangler d1 export my-db --remote --output "backup-$(Get-Date -Format 'yyyyMMdd-HHmm').sql"
```

**Force-trigger the pipeline and stream logs simultaneously:**
```powershell
# Terminal 1:
wrangler tail my-worker

# Terminal 2:
curl -X POST https://my-worker.example.com/run `
  -H "Authorization: Bearer $env:ADMIN_SECRET" `
  -H "User-Agent: Mozilla/5.0"
```

**Mark all current listed items as seen (to skip them on next run):**
```powershell
curl -X POST https://my-worker.example.com/admin/seed-seen `
  -H "Authorization: Bearer $env:ADMIN_SECRET" `
  -H "User-Agent: Mozilla/5.0"
```

**Deploy Python sidecar worker:**
```powershell
cd python-sidecar
wrangler deploy   # uses the sidecar's own wrangler.jsonc
```
