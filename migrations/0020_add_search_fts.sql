-- 0020: FTS5 full-text search index for seen_cases (+ case_awards fields)
-- Standalone FTS5 virtual table (content stored inside FTS5), kept in sync by
-- triggers on both seen_cases and case_awards. Columns mirror the searchable
-- fields; awards data-block fields (legal_issues, keywords, parties, dates)
-- come from case_awards via correlated subqueries.
--
-- NOTE (13 Aug 2026): host Cloudflare tokens are Workers:Edit-only, so this
-- migration CANNOT be applied with `wrangler d1 execute`. Apply through the
-- guarded worker endpoint POST /admin/dashboard/search-migrate (dual auth),
-- which runs this same DDL idempotently via the Worker's own D1 binding.
-- This file remains the source of truth for local dev (`db:migrate:local`).

CREATE VIRTUAL TABLE IF NOT EXISTS seen_cases_fts USING fts5(
  pdf_filename UNINDEXED,   -- join key back to seen_cases
  title,
  member,
  category,
  summary,
  legal_issues,
  keywords,
  parties,
  dates,
  tokenize = 'unicode61'
);

-- ── Triggers ────────────────────────────────────────────────────────────────

-- seen_cases INSERT: index the new row (with any awards fields present)
CREATE TRIGGER IF NOT EXISTS seen_cases_fts_ai AFTER INSERT ON seen_cases BEGIN
  INSERT INTO seen_cases_fts(pdf_filename, title, member, category, summary,
                             legal_issues, keywords, parties, dates)
  VALUES (NEW.pdf_filename, NEW.title, NEW.member, NEW.category, NEW.summary,
    (SELECT legal_issues FROM case_awards WHERE pdf_filename = NEW.pdf_filename AND source = NEW.source),
    (SELECT keywords FROM case_awards WHERE pdf_filename = NEW.pdf_filename AND source = NEW.source),
    (SELECT TRIM(COALESCE(party_applicant,'') || ' ' || COALESCE(party_respondent,'')) FROM case_awards WHERE pdf_filename = NEW.pdf_filename AND source = NEW.source),
    (SELECT COALESCE(decision_date,'') FROM case_awards WHERE pdf_filename = NEW.pdf_filename AND source = NEW.source));
END;

-- seen_cases UPDATE: re-index the row
CREATE TRIGGER IF NOT EXISTS seen_cases_fts_au AFTER UPDATE ON seen_cases BEGIN
  DELETE FROM seen_cases_fts WHERE pdf_filename = OLD.pdf_filename;
  INSERT INTO seen_cases_fts(pdf_filename, title, member, category, summary,
                             legal_issues, keywords, parties, dates)
  VALUES (NEW.pdf_filename, NEW.title, NEW.member, NEW.category, NEW.summary,
    (SELECT legal_issues FROM case_awards WHERE pdf_filename = NEW.pdf_filename AND source = NEW.source),
    (SELECT keywords FROM case_awards WHERE pdf_filename = NEW.pdf_filename AND source = NEW.source),
    (SELECT TRIM(COALESCE(party_applicant,'') || ' ' || COALESCE(party_respondent,'')) FROM case_awards WHERE pdf_filename = NEW.pdf_filename AND source = NEW.source),
    (SELECT COALESCE(decision_date,'') FROM case_awards WHERE pdf_filename = NEW.pdf_filename AND source = NEW.source));
END;

-- seen_cases DELETE: drop the indexed row
CREATE TRIGGER IF NOT EXISTS seen_cases_fts_ad AFTER DELETE ON seen_cases BEGIN
  DELETE FROM seen_cases_fts WHERE pdf_filename = OLD.pdf_filename;
END;

-- case_awards INSERT/UPDATE: (re)index the owning seen_cases row
CREATE TRIGGER IF NOT EXISTS seen_cases_fts_ca_ai AFTER INSERT ON case_awards BEGIN
  DELETE FROM seen_cases_fts WHERE pdf_filename = NEW.pdf_filename;
  INSERT INTO seen_cases_fts(pdf_filename, title, member, category, summary,
                             legal_issues, keywords, parties, dates)
  SELECT sc.pdf_filename, sc.title, sc.member, sc.category, sc.summary,
         NEW.legal_issues, NEW.keywords,
         TRIM(COALESCE(NEW.party_applicant,'') || ' ' || COALESCE(NEW.party_respondent,'')),
         COALESCE(NEW.decision_date,'')
  FROM seen_cases sc WHERE sc.pdf_filename = NEW.pdf_filename AND sc.source = NEW.source;
END;

CREATE TRIGGER IF NOT EXISTS seen_cases_fts_ca_au AFTER UPDATE ON case_awards BEGIN
  DELETE FROM seen_cases_fts WHERE pdf_filename = NEW.pdf_filename;
  INSERT INTO seen_cases_fts(pdf_filename, title, member, category, summary,
                             legal_issues, keywords, parties, dates)
  SELECT sc.pdf_filename, sc.title, sc.member, sc.category, sc.summary,
         NEW.legal_issues, NEW.keywords,
         TRIM(COALESCE(NEW.party_applicant,'') || ' ' || COALESCE(NEW.party_respondent,'')),
         COALESCE(NEW.decision_date,'')
  FROM seen_cases sc WHERE sc.pdf_filename = NEW.pdf_filename AND sc.source = NEW.source;
END;

-- case_awards DELETE: re-index the owning row (awards fields become empty)
CREATE TRIGGER IF NOT EXISTS seen_cases_fts_ca_ad AFTER DELETE ON case_awards BEGIN
  DELETE FROM seen_cases_fts WHERE pdf_filename = OLD.pdf_filename;
  INSERT INTO seen_cases_fts(pdf_filename, title, member, category, summary,
                             legal_issues, keywords, parties, dates)
  SELECT sc.pdf_filename, sc.title, sc.member, sc.category, sc.summary,
         NULL, NULL, NULL, NULL
  FROM seen_cases sc WHERE sc.pdf_filename = OLD.pdf_filename AND sc.source = OLD.source;
END;

-- ── Backfill existing rows ──────────────────────────────────────────────────
DELETE FROM seen_cases_fts;
INSERT INTO seen_cases_fts(pdf_filename, title, member, category, summary,
                           legal_issues, keywords, parties, dates)
SELECT sc.pdf_filename, sc.title, sc.member, sc.category, sc.summary,
       ca.legal_issues, ca.keywords,
       TRIM(COALESCE(ca.party_applicant,'') || ' ' || COALESCE(ca.party_respondent,'')),
       COALESCE(ca.decision_date,'')
FROM seen_cases sc
LEFT JOIN case_awards ca ON ca.pdf_filename = sc.pdf_filename AND ca.source = sc.source;
