# Roadmap

## 🔴 Phase 1: Pipeline Reliability (IN PROGRESS)
- [ ] **Remove SUMMARY_UNAVAILABLE check** — dead code in summariser.ts, prompt already forbids it
- [ ] **Deploy real Python sidecar on Proxmox** using pdfminer.six — fixes the 95% PDF extraction failure rate
- [ ] **Increase OpenRouter timeout 45s → 120s** — 84K-char inputs need more time for 4000-token summaries
- [ ] **Store error reasons in DB** — surface per-case failure info in dashboard
- [ ] Enable Workers Observability in wrangler.jsonc
- [ ] Add CI test stage (vitest + tsc) to deploy.yml
- [ ] Add Dependabot for automated dependency updates

## 🟡 Phase 2: Scraper PR (COMPLETE)
- [x] **Merge the large pending PR that changes how cases are scraped from the ERA website**
  - Replaced `/determinations/recent?start=N` with direct internal index probing (`/determination/view/{id}`)
  - Probes sequential IDs in parallel batches of 5 with 300ms delay
  - Stops after 3 consecutive 404s — no dependency on listing page structure
  - Finds cases that dropped off the recent listing
  - Old `scrapeRecentPage()` retained for manual backfill-era endpoint
- [x] Rescan now resets `last_era_id` so probe re-finds deleted cases
- [x] Silent rescan triggers reprocessing pipeline (not just delete)
- [x] `runDigest()` passes `env.DB` to `summariseCase` so D1 prompt_era is respected

## 💙 Phase 3: Architecture Overhaul
- [ ] Cloudflare Queues — decouple pipeline stages, eliminate 30s CPU timeout
- [ ] Hono routing framework — replace 2137-line index.ts if/else chain
- [ ] Zod validation — API inputs + LLM structured output (function calling for awards data)
- [ ] AI Gateway — LLM provider fallback chain
- [ ] Parallel LLM calls — Promise.allSettled with 3-5 concurrent

## 🔮 Future Features
- [ ] GUI/UX review — the website has grown organically and needs design attention
- [ ] FTS5 search — full-text search across case titles, members, categories, and LLM summaries
- [ ] Employment Court scraping — automate scraping from EC website (currently manual upload only)
- [ ] Evaluate local LXC-hosted scraping vs Workers fetch() — cheaper/more reliable for Cloudflare-blocked sites
- [ ] Rotate exposed Cloudflare API token and ADMIN_SECRET
- [ ] Apply pending migrations (0007–0012) to production D1
- [ ] Re-summarise cases processed with minimal fallback prompt (use Rescan tab)
- [ ] Dark mode support
- [ ] Add audit logging for admin actions
- [ ] Add `package-lock.json` to repo for reproducible installs
