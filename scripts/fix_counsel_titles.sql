-- fix_counsel_titles.sql
-- Corrects case titles where the ERA registry used a counsel's name
-- instead of the actual party names.
--
-- Background:
--   The ERA case registry sometimes assigns a case title using the name of
--   the filing counsel (e.g. "Mark Donovan & Anor v Rhino-Rack NZ Ltd")
--   rather than the actual parties (employee / employer).  The scraper
--   stores that title verbatim.  The extractTitleFromSummary() function
--   normally overrides this using the LLM's PARTIES section, but it returns
--   null (and silently falls back to the scraped title) when:
--     (a) the case was processed before the function was added (pre June 2026), or
--     (b) the summary was generated with the minimal fallback prompt which
--         did not reliably produce "Applicant: / Respondent:" labels.
--
-- Run with:
--   wrangler d1 execute era-digest --remote --file "scripts\fix_counsel_titles.sql"
--
-- After running, rescan the affected cases via the Rescan tab in the admin
-- dashboard (or POST /admin/dashboard/rescan-cases) so fresh summaries are
-- generated with the updated prompt that includes the PARTIES guardrail.

-- ── Known fixes ──────────────────────────────────────────────────────────────

-- [2026] NZERA 353
-- ERA registry title: "Mark Donovan & Anor v Rhino-rack New Zealand Limited"
--   Mark Donovan is counsel for the applicant Todd Dormer, not a party.
-- Corrected title: "Todd Dormer v Rhino-Rack New Zealand Limited"
UPDATE seen_cases
SET title = 'Todd Dormer v Rhino-Rack New Zealand Limited [2026] NZERA 353'
WHERE category = '[2026] NZERA 353'
  AND source = 'ERA';

-- ── Diagnostic query — run separately to surface other potentially wrong titles
-- ── (copy-paste into wrangler d1 execute --command "..." to inspect)
-- SELECT id, title, category, created_at
-- FROM seen_cases
-- WHERE source = 'ERA'
-- ORDER BY id DESC
-- LIMIT 50;
--
-- Look for titles where the "applicant" side is a person's name that also
-- appears in the REPRESENTATIVES section of the stored summary — that pattern
-- indicates a counsel name was stored as a party name.
