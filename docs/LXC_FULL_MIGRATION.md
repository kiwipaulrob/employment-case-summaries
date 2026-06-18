# Full LXC Migration — Moving the Entire App Off Cloudflare Workers

**Status:** Draft — ready for review and implementation.

This document supersedes an earlier partial pipeline-migration draft. That draft
only moved the scraping/summarise pipeline to the LXC and left Workers as a
"thin web server." On review that half-measure exists for inertia, not for a
technical reason. This plan moves **everything** — database, web server, dashboard,
pipeline, cron — onto a single LXC, keeping Cloudflare only where it has no
substitute: the **Email Service binding** and **edge DNS/TLS**.

---

## The one constraint that shapes this plan

Cloudflare Email Service is exposed to code exclusively through the Workers
`env.EMAIL` binding and the `cloudflare:email` `EmailMessage` class:

```typescript
// emailer.ts:16
import { EmailMessage } from 'cloudflare:email';
// emailer.ts:521
const message = new EmailMessage(params.from, params.to, readable);
await params.emailBinding.send(message);
```

Neither `EmailMessage` nor `binding.send()` resolves outside the Worker runtime —
there is no public HTTP API for Cloudflare Email Service, no CLI, no SDK for
non-Worker hosts. If we want to keep delivering the digest from
`digest@whenroutinebiteshard.com` via Cloudflare's sender-reputation IPs, exactly
**one** Cloudflare Worker must remain: a tiny **email relay** whose only job is to
receive an RFC 822 message over HTTP and hand it to `env.EMAIL.send()`.

Everything else can — and should — move.

---

## Target architecture

```
                           ┌──────────────────────────────────┐
   Internet ──DNS──►  Cloudflare edge (Tunnel + Email sending)
                           └──┬───────────────────────────┬───┘
                     HTTP/443 │                    HTTPS  │
                              ▼                           ▼
               ┌──────────────────────────┐    ┌────────────────────────┐
               │  LXC (everything else)  │    │ Cloudflare Worker       │
               │  ─────────────────────  │    │ era-email-relay         │
               │                         │    │ (~25 lines)             │
               │  Caddy :3000            │    │                         │
               │   └─► app.ts (Hono)     │    │  POST /send             │
               │       • public routes   │───►│   Authorization: Bearer │
               │       • /admin dashboard│    │   Body: raw MIME         │
               │                         │    │   → env.EMAIL.send()    │
               │  SQLite (era-digest.db) │    └────────────────────────┘
               │   (was: Cloudflare D1)  │
               │                         │
               │  pipeline.py            │
               │   (cron 8am NZT)        │
               │   • scrape ERA/EC        │
               │   • extract PDF text     │
               │   • LLM via OpenRouter   │
               │   • write to SQLite      │
               │   • POST summaries app   │
               │   • trigger /send-digest │
               │                         │
               │  cloudflared (tunnel)   │
               └──────────────────────────┘
```

**One LXC, one codebase, one database, one cron, one set of secrets.** Cloudflare
keeps exactly two things: the email-binding Worker (25 lines) and the Tunnel that
protects the LXC's public HTTPS surface.

---

## What stays on Cloudflare vs. what leaves

| Capability | Before | After |
|---|---|---|
| Email sending | Main Worker (`env.EMAIL`) | Dedicated `era-email-relay` Worker (~25 lines) |
| Edge TLS / DDoS / bot protection | Workers edge | Cloudflare Tunnel → LXC |
| Public website (`/`, `/awards`, `/subscribe`) | Workers fetch handler | Caddy + Hono on LXC |
| Admin dashboard | Workers + inline JS | Same UI, served by LXC app |
| D1 database (SQLite-over-HTTP) | Cloudflare D1 | Local SQLite file |
| Cron trigger | `wrangler.jsonc` crons | LXC crontab, TZ=Pacific/Auckland |
| PDF text extraction | FlateDecode + `PDF_PARSER` sidecar | Local tool on LXC |
| LLM summarisation | Workers → OpenRouter (45s timeout) | LXC → OpenRouter (no CPU limit) |
| Secrets | Cloudflare secrets + GitHub Actions secrets | `/opt/era-digest/config.json`, root-only |
| Deployment | `git push main` → GH Actions → wrangler deploy | `git pull` on LXC + `systemctl restart` |
| TS build / typecheck | `tsc` in CI blocking deploys | Not blocking — app runs from source |

Gains: no Workers CPU/wall-clock/memory limits (resolves ROADMAP Phase 1's 45s→120s
item, 84K-char inputs, 4000-token outputs), no D1 migration-tracking bug (the
"stuck on 0003" HANDOVER issue), no `npm ci`+`tsc` in CI blocking every deploy,
one secrets location instead of three.

---

## Phases

Phases are ordered so the system stays working at every step. Each phase ends in a
deployable, verifiable state. Never run two phases concurrently.

---

### Phase 0 — Schema preparation

Add two columns before any code moves:

**Migration `0018_add_extracted_text.sql`** (note: 0013 is already taken by
`0013_add_summary_version.sql`; next free slot is **0018**):

```sql
-- migrations/0018_add_extracted_text.sql
ALTER TABLE seen_cases ADD COLUMN extracted_text TEXT;
```

**Migration `0019_add_emailed_at.sql`** (needed by Phase 4; do it now to batch):

```sql
-- migrations/0019_add_emailed_at.sql
ALTER TABLE seen_cases ADD COLUMN emailed_at TEXT;
```

For the D1 staging phase (before the final SQLite cutover), apply both via
`npx wrangler d1 migrations apply era-digest --remote`. Later, when D1 is
exported to a local SQLite file (Phase 4), these columns come along for free.

---

### Phase 1 — Stand up the email relay Worker

This is the **only** Cloudflare Worker that survives the migration. It does
nothing but turn an HTTPS POST into an `env.EMAIL.send()` call.

**New repo (or new directory in the existing repo): `email-relay/`**

`email-relay/src/index.ts`:

```typescript
// ~25 lines. The entire residual Cloudflare footprint.
import { EmailMessage } from 'cloudflare:email';

export interface Env {
  EMAIL: SendEmail;
  RELAY_SECRET: string;        // shared secret with the LXC app
  ALLOWED_FROM: string;        // "digest@whenroutinebiteshard.com"
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    const auth = request.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== env.RELAY_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }
    const from = request.headers.get('X-Mail-From');
    const to   = request.headers.get('X-Mail-To');
    if (!from || !to) {
      return new Response('Missing X-Mail-From / X-Mail-To headers', { status: 400 });
    }
    if (from !== env.ALLOWED_FROM) {
      return new Response('From address not permitted', { status: 403 });
    }
    // Request body IS the raw RFC 822 message stream.
    const message = new EmailMessage(from, to, request.body);
    try {
      await env.EMAIL.send(message);
      return new Response('OK', { status: 200 });
    } catch (err) {
      return new Response(`Email send failed: ${err}`, { status: 500 });
    }
  },
};
```

`email-relay/wrangler.jsonc`:

```jsonc
{
  "name": "era-email-relay",
  "main": "src/index.ts",
  "compatibility_date": "2024-09-23",
  "send_email": [{ "name": "EMAIL" }],
  "vars": { "ALLOWED_FROM": "digest@whenroutinebiteshard.com" }
  // RELAY_SECRET set via: wrangler secret put RELAY_SECRET
}
```

Deploy: `cd email-relay && npx wrangler deploy`. Note the resulting URL
`https://era-email-relay.<account>.workers.dev`.

**Why this shape:**
- The LXC owns MIME assembly (the existing `sendEmail()` logic in `emailer.ts:484`
  moves to the LXC verbatim — same base64, same multipart/alternative). The relay
  never sees structured fields beyond from/to; it cannot assemble, reorder, or
  misinterpret content.
- `from` is pinned to `ALLOWED_FROM` server-side — the LXC cannot spoof other
  senders even if its `RELAY_SECRET` leaks.
- `to` is taken from the `X-Mail-To` header rather than the MIME `To:` field so
  the binding uses the SMTP envelope recipient, not the display header. The LXC
  sets both consistently.

**Verify Phase 1:**

```bash
curl -X POST https://era-email-relay.<account>.workers.dev/send \
  -H "Authorization: Bearer $RELAY_SECRET" \
  -H "X-Mail-From: digest@whenroutinebiteshard.com" \
  -H "X-Mail-To: paul.robertson@heaneypartners.com" \
  -H "Content-Type: message/rfc822" \
  --data-binary @test-email.txt
# Expect 200 OK and an email in Paul's inbox.
```

---

### Phase 2 — LXC pipeline (scrape → extract → summarise → store)

This phase moves the cron pipeline. Workers still serves the public site and
dashboard; the LXC just starts writing cases into D1 over HTTP then asks the Worker
to send the digest.

Create `/opt/era-digest/` on the LXC.

**`/opt/era-digest/config.json`** (root:root, mode 0600 — contains secrets):

```json
{
  "worker_base_url": "https://era-digest-worker.<account>.workers.dev",
  "relay_url": "https://era-email-relay.<account>.workers.dev",
  "relay_secret": "<RELAY_SECRET>",
  "admin_secret": "<ADMIN_SECRET>",
  "openrouter_api_key": "<OPENROUTER_API_KEY>",
  "openrouter_model": "anthropic/claude-sonnet-4.6",
  "openrouter_timeout_seconds": 120,
  "openrouter_max_tokens": 4000,
  "era_source_url": "https://determinations.era.govt.nz/determinations/recent",
  "ec_source_url": "https://www.employmentcourt.govt.nz/judgments/decisions/?Filter_Jurisdiction=17",
  "max_new_cases_per_run": 5,
  "request_delay_seconds": 1.5,
  "db_path": "/opt/era-digest/era-digest.db"
}
```

Note `openrouter_timeout_seconds: 120` — the 45s Workers CPU limit no longer
applies on the LXC. This single config value resolves ROADMAP Phase 1.

**`/opt/era-digest/pipeline.py`** (full pseudo code):

```python
#!/usr/bin/env python3
"""ERA Digest LXC pipeline: scrape → extract → summarise → store → notify."""
import json, time, requests
from bs4 import BeautifulSoup
from pdf_extractor import extract_text   # wraps pdftotext / pypdf / installed OCR
from summariser import summarise_case    # local OpenRouter client, see below

CONFIG = json.load(open('/opt/era-digest/config.json'))
UA = {'User-Agent': 'Mozilla/5.0'}
WORKER = CONFIG['worker_base_url']
AUTH = {'Authorization': f"Bearer {CONFIG['admin_secret']}", **UA}


def scrape_era_listing(pages=2):
    """Return list of {filename, pdf_url, date, citation, member} dicts."""
    cases = []
    for page in range(pages):
        url = CONFIG['era_source_url'] + (f"?start={page*10}" if page else '')
        soup = BeautifulSoup(requests.get(url, headers=UA).text, 'html.parser')
        for li in soup.select('li.search-results__record'):
            link = li.select_one('a[href$=".pdf"]')
            if not link:
                continue
            path = link['href']
            cases.append({
                'filename': path.split('/')[-1],
                'pdf_url':  f"https://determinations.era.govt.nz{path}",
                # parse date/citation/member from <li> content
            })
        time.sleep(CONFIG['request_delay_seconds'])
    return cases


def filter_new_cases(cases):
    """POST filenames to Workers; it returns the subset already in D1."""
    r = requests.post(f"{WORKER}/admin/check-new-cases",
                      json={'filenames': [c['filename'] for c in cases]},
                      headers=AUTH)
    seen = set(r.json().get('seen_filenames', []))
    return [c for c in cases if c['filename'] not in seen]


def extract_pdf_text(pdf_url):
    """Local extraction — no Cloudflare sidecar, no 30s limit."""
    pdf_bytes = requests.get(pdf_url, headers=UA).content
    text = extract_text(pdf_bytes)            # pdftotext/pypdf/etc.
    if not text or len(text.strip()) < 100:
        raise ValueError(f"Extracted text too short from {pdf_url}")
    return text


def upload_era_case(filename, text, summary, awards, meta):
    """POST a fully-written case to the Workers DB-write endpoint.

    Workers does NOT run the LLM in this flow — the summary is already complete.
    """
    payload = {
        'filename':       filename,
        'text':           text,
        'summary':        summary,           # pre-written by LXC summariser
        'awards':         awards,            # parsed AWARDS_DATA block
        'title':          meta.get('title'),
        'member':         meta.get('member'),
        'date_published': meta.get('date'),
        'category':       meta.get('citation'),
    }
    r = requests.post(f"{WORKER}/admin/upload-era-case-text",
                      json=payload, headers=AUTH)
    if r.status_code == 200:
        return True
    print(f"  FAIL {filename}: HTTP {r.status_code} {r.text}")
    return False


def trigger_digest_email():
    """Tell the LXC app (Phase 3) or, until then, the Workers app to send."""
    requests.post(f"{WORKER}/admin/dashboard/send-digest",
                  json={'force': False}, headers=AUTH)


def main():
    cases = scrape_era_listing()
    new = filter_new_cases(cases)
    new = new[:CONFIG['max_new_cases_per_run']]
    if not new:
        print("No new ERA cases"); return

    prompt_era = get_era_prompt()             # GET /admin/dashboard/get-prompts
    uploaded = 0
    for case in new:
        try:
            text = extract_pdf_text(case['pdf_url'])
            summary, awards = summarise_case(
                text, prompt_era,
                api_key=CONFIG['openrouter_api_key'],
                model=CONFIG['openrouter_model'],
                timeout=CONFIG['openrouter_timeout_seconds'],   # 120
                max_tokens=CONFIG['openrouter_max_tokens'],     # 4000
            )
            if upload_era_case(case['filename'], text, summary, awards, case):
                uploaded += 1
            time.sleep(CONFIG['request_delay_seconds'])
        except Exception as e:
            print(f"  ERROR {case['filename']}: {e}")

    if uploaded > 0:
        trigger_digest_email()
    print(f"Done. {uploaded}/{len(new)} uploaded.")
```

**`/opt/era-digest/summariser.py`** (local OpenRouter client):

```python
import requests, re, json

def summarise_case(text, prompt, *, api_key, model, timeout, max_tokens):
    """Call OpenRouter from the LXC. No 45s Workers limit — uses config timeout."""
    r = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": model,
            "max_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": f"<document>\n{text}\n</document>\n\n{prompt}"},
            ],
        },
        timeout=timeout,   # 120
    )
    r.raise_for_status()
    summary = r.json()['choices'][0]['message']['content']
    awards = parse_awards_block(summary)   # reuse the <AWARDS_DATA>...</> regex
    return summary, awards
```

**Two new endpoints in the existing main Worker (Phase 2 only — removed in Phase 6):**

- `POST /admin/check-new-cases` — body `{filenames: string[]}`, returns
  `{seen_filenames: string[]}`. Wraps the existing internal `filterNewCases()`
  (`db.ts:18`). Settle on POST (matches the EC text-endpoint style) and the
  `/admin/check-new-cases` path (top-level, accepts Bearer OR cookie like
  `index.ts:668`).
- `POST /admin/upload-era-case-text` — body
  `{filename, text, summary, awards?, title?, member?, date_published?, category?}`.
  **Pure DB writer.** Does NOT call `summariseCase()` server-side — the summary
  arrives pre-written.

**markCaseSeen invariant — resolved.** Do **not** call `markCaseSeen()` inside
`upload-era-case-text`. The existing code at `index.ts:2490` deliberately defers
markCaseSeen until after a successful email dispatch; preserve that. The
`upload-era-case-text` handler inserts the row with `emailed_at = NULL`. A separate
`POST /admin/mark-cases-emailed` (called by `send-digest` after successful send)
sets `emailed_at = now()` for the batch. This keeps the "retry on email failure"
guarantee intact.

**Verify Phase 2:**

```bash
# Run pipeline once, observe cases landing in D1 + digest email being sent.
sudo -u era-digest python3 /opt/era-digest/pipeline.py
```

Email arrives from `digest@whenroutinebiteshard.com` via Cloudflare (because the
Worker still runs send-digest, which still uses `env.EMAIL`). Pipeline reliability
already improved: no 45s LLM timeout, no sidecar dependency.

---

### Phase 3 — LXC web server (public site + admin dashboard)

Move the route handlers out of `index.ts` (a 2500-line if/else chain) into a small
app. The ROADMAP Phase 3 goal ("Hono routing framework — replace 2137-line
index.ts if/else chain") is realised as a side effect.

**Recommended stack: Hono on Node.js or Bun.** Hono is a 14KB framework that ran
on Workers and runs identically on Node's `@hono/node-server`. The route-map
translates almost 1:1 from the existing `if (url.pathname === ...)` chain.

`/opt/era-digest/app/src/index.ts`:

```typescript
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { homePage, awardsPage, subscribePage, /* … */ } from './pages';
import * as db from './db';   // better-sqlite3 driver, see Phase 4
import { sendDigest } from './emailer';   // calls the relay Worker, see Phase 5

const app = new Hono();

app.get('/', async (c) => {
  const cases = await db.getRecentCasesPaged(20, 0);
  return c.html(homePage(cases));
});
app.get('/awards', async (c) => { /* … */ });
app.post('/subscribe', async (c) => { /* … */ });
app.get('/confirm', async (c) => { /* … */ });
app.get('/preferences', async (c) => { /* … */ });
app.get('/unsubscribe', async (c) => { /* … */ });

app.get('/admin', async (c) => { /* dashboard HTML, cookie auth */ });
app.post('/admin', async (c) => { /* login */ });
app.get('/admin/status', async (c) => { /* … */ });
// … the rest of the routes from README "API Endpoints"

serve({ fetch: app.fetch, port: 3000 });
console.log('LXC app on :3000');
```

`pages.ts`, `utils.ts`, `dashboard.ts` move to the LXC app essentially unchanged —
they already produce plain HTML strings and don't use Workers APIs.

**Caddy reverse proxy on the LXC** (port 3000 exposed to the tunnel):

```caddyfile
# /etc/caddy/Caddyfile
whenroutinebiteshard.com {
    reverse_proxy 127.0.0.1:3000
    encode gzip
}
```

**Authentication stays the same:** session cookie for the dashboard, `ADMIN_SECRET`
Bearer for API routes. The auth code at `index.ts:670` (Bearer OR cookie,
timing-safe compare from PR #58) moves directly.

**Verify Phase 3:**

```bash
# Locally (before exposing):
curl http://localhost:3000/        # home page renders
curl http://localhost:3000/awards  # awards page
curl -X POST http://localhost:3000/admin -d 'password=...'  # sets cookie
```

---

### Phase 4 — Migrate D1 → local SQLite

D1 is SQLite-over-HTTP. The schema, the SQL, the indexes — all portable. The `db.ts`
layer is already a clean abstraction; swap the driver, keep the SQL.

**Export D1 → file:**

```bash
npx wrangler d1 export era-digest --remote --output=era-digest-dump.sql
sqlite3 /opt/era-digest/era-digest.db < era-digest-dump.sql
```

The dump includes `seen_cases`, `subscribers`, `config`, `case_awards`, prompt
version history — everything. Migrations 0018/0019 (`extracted_text`,
`emailed_at`) are already applied; they ride along.

**Replace the D1 driver.** In the LXC app, swap `D1Database.prepare()` for
`better-sqlite3`:

```typescript
// db.ts on LXC — was: async D1Database; now: sync better-sqlite3
import Database from 'better-sqlite3';
const db = new Database('/opt/era-digest/era-digest.db');

export function getRecentCasesPaged(limit: number, offset: number) {
  return db.prepare(
    'SELECT * FROM seen_cases ORDER BY processed_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
}
```

The SQL statements are identical — only the call shape differs (sync vs. async).
Route handlers gain an `await` here and there; the migration is mechanical.

**Backup strategy:** daily `sqlite3 era-digest.db .dump` cron to
`/opt/era-digest/backups/`. Keep 7 days. This replaces D1's automatic backups
with something Paul can inspect directly (`sqlite3 era-digest.db`).

**This phase removes the D1 migration-tracking bug entirely.** The HANDOVER.md §5.3
"stuck on 0003" issue simply cannot exist on a local SQLite file — there is no
`_cf_KV` table, no wrangler migration framework, no Cloudflare REST API dance.

**Verify Phase 4:**

```bash
sqlite3 /opt/era-digest/era-digest.db "SELECT COUNT(*) FROM seen_cases;"
# Should match the D1 count before export.
sqlite3 /opt/era-digest/era-digest.db "SELECT email FROM subscribers WHERE active=1;"
# Should show the 4 known subscribers.
```

---

### Phase 5 — Migrate the emailer to use the relay Worker

Move `sendEmail()` from `emailer.ts:484` into the LXC app unchanged — same MIME
assembly, same base64 encoding, same multipart/alternative boundary. The only
difference: instead of `params.emailBinding.send(message)`, POST the raw MIME to
the relay Worker built in Phase 1.

`/opt/era-digest/app/src/emailer.ts`:

```typescript
// The MIME assembly (lines 484–521 of the old emailer.ts) is unchanged.
// The final send becomes an HTTP POST to the relay:

import { EmailMessage /* NOT imported — no longer needed */ } from 'cloudflare:email';

export async function sendEmail(params: SendEmailParams, relay: RelayConfig): Promise<void> {
  const mimeMessage = buildMimeMessage(params);   // the existing logic, verbatim

  const r = await fetch(`${relay.url}/send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${relay.secret}`,
      'X-Mail-From':   params.from,
      'X-Mail-To':     params.to,
      'Content-Type':  'message/rfc822',
    },
    body: mimeMessage,
  });
  if (!r.ok) {
    throw new Error(`Relay rejected: ${r.status} ${await r.text()}`);
  }
}
```

`sendDigestToAll()` (`emailer.ts:528`) — the per-subscriber loop, preferences
filtering, unsubscribe-link personalisation — is unchanged. It iterates and calls
`sendEmail()` per subscriber; the HTTP round-trip to the relay replaces the
in-process `binding.send()`.

**Verify Phase 5:**

```bash
# Trigger a digest send from the LXC app and confirm delivery.
curl -X POST http://localhost:3000/admin/send-digest \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json"
# Expect 200 OK and an email in each subscriber's inbox,
# delivered from digest@whenroutinebiteshard.com via Cloudflare.
```

---

### Phase 6 — Decommission the main Worker

Once Phases 1–5 are running and verified for at least one full daily cycle, the
main `era-digest-worker` is dead weight. Delete it.

**Delete:**
- The `src/`, `migrations/`, `python-sidecar/`, `scripts/` directories (they move
  into `/opt/era-digest/app/` — keep a copy in the repo as `lxc-app/` if you want
  the LXC code version-controlled)
- `wrangler.jsonc` (the one with crons, D1 binding, `PDF_PARSER` service binding,
  committed D1 ID, committed admin email — all gone)
- `.github/workflows/deploy.yml` (no more Workers to deploy)
- `package.json` root (keep a `package.json` in `email-relay/` and one in the LXC
  app dir)

**Keep in the repo:**
- `email-relay/` (the one surviving Worker — deploy it once, forget it)
- `lxc-app/` (the LXC application code, if you want it in git)
- `README.md`, `CHANGELOG.md`, `ROADMAP.md`, `HANDOVER.md` (update them — see below)

**Secrets cleanup:**
- Remove `OPENROUTER_API_KEY` from Cloudflare Worker secrets (no longer needed on
  Workers — only on the LXC).
- Remove `OPENROUTER_API_KEY` and `ADMIN_SECRET` from GitHub Actions secrets.
- Remove `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from GitHub Actions
  secrets (no more `wrangler deploy` in CI). The token was flagged as exposed in
  HANDOVER.md §5.1 — this completes that rotation.
- All four secrets now live only in `/opt/era-digest/config.json`, root:root,
  mode 0600. This is the smallest possible secret surface.

**Verify Phase 6:**

- `curl https://era-digest-worker.<account>.workers.dev/` should 404 or be gone.
- A new case scraped + summarised + emailed should work with the main Worker
  deleted.

---

### Phase 7 — Cloudflare Tunnel for edge protection

The LXC app is on `127.0.0.1:3000`. Put it behind a Cloudflare Tunnel so the public
hostname keeps edge TLS, DDoS protection, and Cloudflare's bot filtering (the
`User-Agent: Mozilla/5.0` requirement in HANDOVER.md §6 is still enforced at the
edge).

**Install + configure `cloudflared` on the LXC** (pattern Paul already uses on
CT103 — see the tunnel world-model: tunnel UUID, `config.yml`, systemd unit,
CNAME records must all align):

```bash
# Create the tunnel (records the UUID; do not lose it)
cloudflared tunnel create era-digest
# ~/.cloudflared/<UUID>.json holds the credentials

# Public hostname: whenroutinebiteshard.com → tunnel → LXC :3000
cloudflared tunnel route dns era-digest whenroutinebiteshard.com
# This creates the CNAME record pointing the hostname to <UUID>.cfargotunnel.com.
# Per the tunnel world-model: removing/breaking this DNS record drops traffic.
```

`/etc/cloudflared/config.yml`:

```yaml
tunnel: <UUID>
credentials-file: /root/.cloudflared/<UUID>.json

ingress:
  - hostname: whenroutinebiteshard.com
    service: http://localhost:3000
  - service: http_status:404
```

Systemd unit `/etc/systemd/system/cloudflared.service` (must reference the
correct tunnel UUID — per the world-model, a mismatched unit breaks the tunnel):

```ini
[Unit]
Description=Cloudflare Tunnel for era-digest
After=network-online.target

[Service]
TimeoutStartSec=0
Type=notify
ExecStart=/usr/bin/cloudflared --config /etc/cloudflared/config.yml tunnel run
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now cloudflared
```

**DNS check:** `dig whenroutinebiteshard.com` must show a CNAME to
`<UUID>.cfargotunnel.com`. If the record is missing, the tunnel won't receive
traffic (per the world-model's primary failure mode).

**Verify Phase 7:**

```bash
curl -I https://whenroutinebiteshard.com/   # 200, tls served by Cloudflare
curl -I https://whenroutinebiteshard.com/ -H "User-Agent: curl/8"   # may 403 (bot filter)
```

---

### Phase 8 — EC pipeline (same pattern)

EC PDFs are currently manual uploads. With the LXC in place the same `pipeline.py`
pattern applies — just add an EC scraper (`scrape_ec_listing()` in the doc's
existing Phase 5) that hits
`https://www.employmentcourt.govt.nz/judgments/decisions/?Filter_Jurisdiction=17`
and feeds `upload_ec_case_case_text`. The endpoint signature mirrors the ERA one:
`{filename, text, summary, awards?, title?, member?, ...}` — pure DB writer.

The PDF-parser-python sidecar is now dead — extraction happens locally on the LXC
with whatever tool is installed (pdftotext, pypdf, or OCR for scans). Delete the
`PDF_PARSER` service binding reference (already gone with `wrangler.jsonc`).

**Verify Phase 8:**

```bash
# EC cron run (or manual trigger) lands EC cases in SQLite + no sidecar calls.
python3 -c "from pipeline import scrape_ec_listing; print(len(scrape_ec_listing()))"
```

---

## Cutover order + rollback

Run phases strictly in order. Each phase is independently verifiable and
rollback-safe:

| Phase | Risk if it fails | Rollback |
|---|---|---|
| 0 | None — additive columns | Drop the columns |
| 1 | Relay returns 5xx | The main Worker still sends email via `env.EMAIL`; nothing depends on the relay yet |
| 2 | LXC pipeline errors | Disable the LXC cron, re-enable `wrangler.jsonc` crons, rollback complete |
| 3 | LXC web server broken | Keep Workers serving the public site until verified; Caddy stays off until cut over |
| 4 | SQLite import corrupt | Keep D1 live; the LXC app can still query D1 over HTTP until Phase 4 verified |
| 5 | Emailer can't reach relay | Relay from Phase 1 is already deployed and tested; failure here = config typo |
| 6 | Main Worker deleted prematurely | Re-deploy from `git` (the repo still has the Worker code at the pre-deletion commit) |
| 7 | Tunnel misconfigured | CNAME missing = site dark (per world-model). Keep the old Worker until tunnel verified |
| 8 | EC scraper breaks | EC uploads are manual; revert the scraper, uploads still work via dashboard |

**The safe cutover checkpoint** is after Phase 2: at that point, the LXC owns the
pipeline, the email still flows through Cloudflare, and the main Worker still serves
the public site. You can sit there indefinitely while you build out Phases 3–5.

---

## Invariants to preserve

- **`markCaseSeen` only after successful email dispatch** (code comment at
  `index.ts:2490`). Phase 2's `upload-era-case-text` must NOT call markCaseSeen;
  `emailed_at` tracks the email state and `send-digest` flips it.
- **Email notice banner clears only after successful send.**
- **`User-Agent: Mozilla/5.0` required on all requests to the public hostname** —
  Cloudflare's bot filter still applies in front of the tunnel.
- **Double-encoding guardrail** — validate summary before INSERT (check for `{` or
  `"` prefix) — move this into the LXC `db.ts`.
- **Processing lock** — move from the D1 `is_processing` row to an LXC lockfile
  (`flock` on `/opt/era-digest/.pipeline.lock`) or a SQLite-backed mutex.
- **LLM prompt editing UX survives** — the dashboard still reads/writes the prompt
  in the DB (now SQLite); `pipeline.py` reads it before each run.
- **Subscriber preferences** (`show_costs`, `show_consent`) continue to filter cases
  per-subscriber before the digest is composed.
- **From envelope pinned** — the relay Worker enforces `ALLOWED_FROM` so a leaked
  `RELAY_SECRET` cannot be used to spoof other senders.

---

## Lingering items from the open-issues list this plan resolves

| Issue | How this plan resolves it |
|---|---|
| #33 sidecar monitoring | Sidecar deleted — no monitoring needed |
| #41 long PDF timeout (>100p) | No Workers 30s CPU limit; extraction runs as long as it needs |
| #42 scanned PDF OCR | LXC can run Tesseract locally as a fallback in `pdf_extractor.py` |
| #43 encrypted PDF detection | Local extractor catches and reports before the LLM call |
| #40 hardcoded D1 ID in .env.example | `wrangler.jsonc` deleted (D1 ID gone with it) |
| #35 prompt strategy / cost | LLM runs on LXC with full control over `max_tokens`, timeout, model — easy to A/B |
| #26 one bad PDF breaks batch | LXC pipeline's per-case try/except (pseudo code above) makes this free |
| #30 JSON Mode output | No Workers constraints; switch the LXC summariser to `response_format: json` trivially |
| #29 `summary_version` column | Already merged (PR #64); `pipeline.py` writes it on every case |

---

## Files to create / modify / delete

```
Repo (github.com/kiwipaulrob/employment-case-summaries)
├── email-relay/                         ← NEW (the one surviving Worker)
│   ├── src/index.ts                      ← NEW (~25 lines)
│   └── wrangler.jsonc                    ← NEW
├── lxc-app/                              ← NEW (optional; LXC app code in git)
│   └── src/
│       ├── index.ts (Hono app)          ← migrated from src/index.ts
│       ├── db.ts (better-sqlite3)        ← migrated from src/db.ts
│       ├── pages.ts                      ← moved unchanged
│       ├── emailer.ts                    ← moved; sends via relay
│       ├── utils.ts                      ← moved unchanged
│       ├── dashboard.ts                  ← moved unchanged
│       └── summariser.ts (not needed)    ← LLM runs in pipeline.py on LXC
├── migrations/
│   ├── 0018_add_extracted_text.sql       ← NEW (Phase 0)
│   └── 0019_add_emailed_at.sql           ← NEW (Phase 0)
├── docs/LXC_FULL_MIGRATION.md            ← NEW (this document)
└── DELETE (Phase 6):
    ├── wrangler.jsonc                    (main Worker config — gone)
    ├── .github/workflows/deploy.yml      (no more GH Actions deploys)
    ├── src/                              (moved into lxc-app/)
    ├── migrations/                       (applied to local SQLite; kept in repo as history)
    ├── python-sidecar/                   (extraction now on LXC)
    └── package.json (root)               (keep email-relay/package.json + lxc-app/package.json)

LXC (/opt/era-digest/)
├── config.json                           ← NEW (secrets, mode 0600)
├── era-digest.db                         ← NEW (was Cloudflare D1)
├── pipeline.py                           ← NEW (cron, scrape+summarise)
├── summariser.py                         ← NEW (local OpenRouter client)
├── pdf_extractor.py                      ← NEW (wraps installed OCR tool)
├── backups/                              ← NEW (daily SQLite dumps)
├── app/                                  ← git clone of lxc-app/ from repo
│   └── src/...
└── .pipeline.lock                        ← NEW (flock for cron mutex)
```

---

## Open question for Paul

This plan assumes `whenroutinebiteshard.com` stays as the public hostname.
If you'd rather host the LXC-served site on a different subdomain and redirect
the old one at the edge, say so before Phase 7 — the tunnel CNAME would target
the new name instead.
