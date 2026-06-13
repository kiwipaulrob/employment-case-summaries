# ERA Digest — Architecture & Development Plan

**Created:** 13 June 2026  
**Updated:** 13 June 2026 (evening — sidecar + tunnel deployed)  
**Status:** Active planning document  
**Purpose:** Capture all decisions, proposals, and future work for the employment-case-summaries project.

---

## 📋 Current Architecture Summary

```
┌──────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge                           │
│  whenroutinebiteshard.com → era-digest-worker (TypeScript)   │
│  extractor.robertsons.cloud → tunnel → network-hub → LXC    │
│  12 *.robertsons.cloud hostnames → tunnel → Caddy → LAN     │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  Proxmox prox1 (192.168.214.130)                             │
│                                                              │
│  CT 100: Hermes (195) — this agent                           │
│  CT 101: deemix-lxc (190) — music downloader                 │
│  CT 102: memos (200) — note-taking                           │
│  CT 103: network-hub (210) — cloudflared + Caddy tunnel      │
│  CT 104: pdf-extractor (100) — pdfminer.six sidecar          │
└──────────────────────────────────────────────────────────────┘
```

### Component Details
- **Worker**: Cloudflare Workers TypeScript (`era-digest-worker`)
- **Database**: Cloudflare D1 (`era-digest` — 13 migrations)
- **Email**: Cloudflare Email Service (`digest@whenroutinebiteshard.com`)
- **LLM**: OpenRouter → `anthropic/claude-sonnet-4.6`
- **Cron**: Dual cron `0 20 * * *` and `0 19 * * *` (8am NZT DST-aware)
- **PDF Extraction (ERA)**: pdfminer.six on CT 104, accessed via https://extractor.robertsons.cloud (via tunnel)
- **PDF Extraction (EC)**: Workers-native FlateDecode fallback
- **Tunnel**: cloudflared + Caddy on CT 103 network-hub, token-based auth

---

## 🎯 Current State (13 June 2026 Evening)

### ✅ PDF Extraction Bottleneck — SOLVED

The pdfminer.six sidecar is deployed and working. Two ERA PDFs tested:
- 2026-NZERA-364: **90,949 chars, 42 pages** ✅
- 2026-NZERA-363: **44,461 chars, 20 pages** ✅

The previous 5% success rate (1/20) is now provably 100% for test cases.

### ✅ Cloudflare Tunnel — LIVE

12 hostnames routed through the network-hub LXC's tunnel:
- `extractor.robertsons.cloud` → CT 104 pdfminer service
- `hermes.robertsons.cloud` → CT 100 Hermes dashboard
- `music.robertsons.cloud` → CT 101 deemix
- `homenas.robertsons.cloud`, `newhpnas.robertsons.cloud`
- `zbee.robertsons.cloud`, `zbrouter.robertsons.cloud`
- `proxmox.robertsons.cloud`, `webui.robertsons.cloud`
- `bookmark.robertsons.cloud`, `pihole.robertsons.cloud`, `health.robertsons.cloud`

### 🔴 Remaining Issues
- **3-case limit** per cron run (workaround for 30s CPU timeout)
- **45s OpenRouter timeout** too tight for 84K-char inputs
- **Silent failures** — errors logged to console.log but not surfaced in dashboard
- **`SUMMARY_UNAVAILABLE` check** in summariser.ts still present
- **Sequential LLM calls** — no parallelism
- **No CI tests in deploy** — pushes to main skip vitest + tsc
- **No Dependabot**

---

## 🗺️ Three-Phase Plan (Updated 13 June 2026)

### Phase 1: Pipeline Reliability 🔴 IN PROGRESS

| Step | Change | Status | Effort |
|------|--------|--------|--------|
| 1a | Remove SUMMARY_UNAVAILABLE check | ⏳ Pending | 5 min |
| 1b | Deploy pdfminer.six sidecar on Proxmox CT 104 | ✅ **DONE** | Medium |
| 1c | Update pdf.ts to call sidecar with fallback | ✅ **DONE** | Small |
| 1d | Set up Cloudflare Tunnel for all services | ✅ **DONE** | Medium |
| 1e | Increase OpenRouter timeout to 120s | ⏳ Pending | 2 min |
| 1f | Store error reasons in DB (dashboard-visible) | ⏳ Pending | Small |
| 1g | Enable Workers Observability in wrangler.jsonc | ⏳ Pending | 5 min |
| 1h | Add CI test stage to deploy.yml | ⏳ Pending | 10 min |
| 1i | Add Dependabot | ⏳ Pending | 5 min |

### Phase 2: Merge Scraper PR 🟡 NEXT

Merge the large PR that changes ERA website scraping. Only after Phase 1 proves the pipeline reliably processes cases.

### Phase 3: Architectural Overhaul 💙 FUTURE

| Change | Rationale |
|--------|-----------|
| **Cloudflare Queues** | Decouple pipeline stages, eliminate 30s CPU timeout, auto-retry per case via DLQ |
| **Hono routing framework** | Replace 2137-line index.ts if/else chain |
| **Zod validation** | Validate API inputs + LLM structured function calling for awards data |
| **AI Gateway** | LLM provider fallback chain (OpenRouter → fallback) |
| **Parallel LLM calls** | Promise.allSettled with 3-5 concurrent |

---

## 🔭 Future Features

### A. Filter Costs-Only and Consent Cases (Decided 13 Jun)
[COSTS ONLY] and [CONSENT] tags exist in the LLM prompt. Filter them out after LLM response — don't summarise or store.

### B. Employment Court Scraping (separate website)
Automate EC decision scraping (currently manual PDF upload only). Feed into same pipeline via summariserEmploymentCourt.ts.

### C. Local LXC-Hosted Scraping
Evaluate running scraper on Proxmox LXC instead of Workers — bypasses Cloudflare Turnstile blocks on NZLII and court websites.

### D. GUI/UX Review
The website has grown organically. Needs design pass: landing page, admin dashboard, email templates, responsive layout, dark mode.

### E. Search Feature
FTS5 full-text search across case titles, members, categories, and LLM summaries. D1 supports SQLite FTS5. Could also use workers-ai embeddings for semantic search.

### F. NetBox Installation (Requested 13 Jun)
Install NetBox on CT 103 network-hub LXC for network documentation and DCIM.

---

## 🌐 jurislex.nz — Dev/Staging Environment

**Decision (13 June 2026):** Freeze current production code at a known-good state. Create `dev` branch deployed to jurislex.nz as staging.

### Staging Setup
| Component | Production | Staging (jurislex.nz) |
|-----------|-----------|----------------------|
| Domain | whenroutinebiteshard.com | jurislex.nz |
| Worker | era-digest-worker | era-digest-dev |
| Branch | main | dev |
| D1 DB | era-digest | era-digest-staging |
| Email | digests@whenroutinebiteshard.com | digests@jurislex.nz |
| Cron | Dual cron for 8am NZT | Same dual cron |
| Subscribers | Real subscribers (~100+) | Paul only |

---

## 🔧 Recommendations Summary

### Quick Wins
- [ ] Enable Workers Observability in wrangler.jsonc
- [ ] Add CI test stage to deploy.yml
- [ ] Add dependabot.yml
- [ ] Increase OpenRouter timeout 45s → 120s
- [ ] Remove SUMMARY_UNAVAILABLE check

### Phase 1 Remaining
- [ ] Store error reasons in DB

### Phase 2
- [ ] Merge large scraper PR

### Phase 3
- [ ] Cloudflare Queues / Hono / Zod / AI Gateway / Parallel LLM

### Future
- [ ] Filter costs/consent cases
- [ ] GUI/UX review pass
- [ ] FTS5 search on archive
- [ ] Employment Court scraping
- [ ] Local LXC scraper evaluation
- [ ] NetBox installation on network-hub CT 103
- [ ] Dark mode / Audit logging

---

## 📁 Document History

| Date | Change |
|------|--------|
| 13 Jun 2026 | Created. Captured all decisions from architecture review, debugging email. |
| 13 Jun 2026 (eve) | Updated with completed Phase 1 work: sidecar, pdf.ts, tunnel, music, network inventory. Added NetBox, GUI review, search to roadmap. |
