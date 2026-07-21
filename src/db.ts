/**
 * db.ts — D1 database query helpers
 *
 * All SQL queries are isolated here so the rest of the codebase
 * stays clean and can easily be adapted to a different database.
 */

import type { CaseListing, ProcessedCase, DbSubscriber, DbSeenCase } from './types';
import { validateSummaryNotDoubleEncoded } from './utils';

// ─── Seen cases ───────────────────────────────────────────────────────────────

/**
 * Filters a list of cases down to only those not already in the seen_cases table.
 * Uses (source, pdf_filename) as the composite unique key.
 * source: 'ERA' or 'EMPLOYMENT_COURT'
 */
export async function filterNewCases(
  db: D1Database,
  cases: CaseListing[],
  source: string = 'ERA'
): Promise<CaseListing[]> {
  if (cases.length === 0) return [];

  // Extract pdf_filename from each case's pdfUrl
  const pdfFilenames = cases.map((c) => {
    if (!c.pdfUrl) return null;
    const parts = c.pdfUrl.split('/');
    return parts[parts.length - 1];
  }).filter(Boolean) as string[];

  if (pdfFilenames.length === 0) return cases; // No PDFs to check

  // Batch into chunks of 500 to avoid SQLite's 999-variable limit
  const CHUNK_SIZE = 500;
  const seenFilenames = new Set<string>();

  for (let i = 0; i < pdfFilenames.length; i += CHUNK_SIZE) {
    const chunk = pdfFilenames.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const result = await db
      .prepare(`SELECT pdf_filename FROM seen_cases WHERE source = ? AND pdf_filename IN (${placeholders})`)
      .bind(source, ...chunk)
      .all<{ pdf_filename: string }>();
    for (const row of result.results) {
      seenFilenames.add(row.pdf_filename);
    }
  }
  return cases.filter((c) => {
    if (!c.pdfUrl) return true; // Include if no PDF (shouldn't happen)
    const filename = c.pdfUrl.split('/').pop() || '';
    return !seenFilenames.has(filename);
  });
}

/**
 * Writes a fully processed case to the seen_cases table.
 * Uses (source, pdf_filename) as the composite PRIMARY KEY.
 * source: 'ERA' or 'EMPLOYMENT_COURT'
 * Uses INSERT OR IGNORE so re-runs are idempotent.
 */
export async function markCaseSeen(
  db: D1Database,
  processedCase: ProcessedCase,
  source: string = 'ERA'
): Promise<void> {
  // Safety guardrail: prevent double-JSON-encoded summaries from entering the DB
  if (processedCase.summary) {
    validateSummaryNotDoubleEncoded(processedCase.summary);
  }

  // Extract pdf_filename from pdfUrl
  const pdfFilename = processedCase.pdfUrl
    ? processedCase.pdfUrl.split('/').pop() || ''
    : '';
  
  if (!pdfFilename) {
    throw new Error(`Cannot mark case as seen: no PDF filename for ${processedCase.title}`);
  }

  await db
    .prepare(
      `INSERT OR IGNORE INTO seen_cases
       (source, pdf_filename, case_id, title, case_url, pdf_url, date_published, member, category, summary, processed_at, summary_version, paragraph_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      source,
      pdfFilename,
      processedCase.caseId,
      processedCase.title,
      processedCase.caseUrl,
      processedCase.pdfUrl,
      processedCase.datePublished ?? '',
      processedCase.member ?? null,
      processedCase.category ?? null,
      processedCase.summary,
      processedCase.processedAt,
      processedCase.summaryVersion ?? null,
      processedCase.paragraphCount ?? null,
    )
    .run();
}

/**
 * Updates a single case's summary in the seen_cases table.
 * Used for manual editing of summaries (no LLM re-run needed).
 */
export async function updateCaseSummary(
  db: D1Database,
  pdfFilename: string,
  summary: string,
  source: string = 'ERA'
): Promise<void> {
  await db
    .prepare(`UPDATE seen_cases SET summary = ?, processed_at = datetime('now') WHERE source = ? AND pdf_filename = ?`)
    .bind(summary, source, pdfFilename)
    .run();
}

/**
 * Returns the most recent processed cases, newest first.
 */
export async function getRecentCases(
  db: D1Database,
  limit = 20
): Promise<DbSeenCase[]> {
  const result = await db
    .prepare('SELECT * FROM seen_cases ORDER BY processed_at DESC LIMIT ?')
    .bind(limit)
    .all<DbSeenCase>();
  return result.results;
}

/**
 * Returns paginated cases excluding costs-only and consent tagged cases.
 * Used for the public landing page.
 */
export async function getRecentCasesPaged(
  db: D1Database,
  perPage = 20,
  offset = 0,
  excludeCosts = true,
  excludeConsent = true
): Promise<DbSeenCase[]> {
  let sql = 'SELECT * FROM seen_cases WHERE source = ?';
  const params: any[] = ['ERA'];
  if (excludeCosts) {
    sql += " AND (summary IS NULL OR summary NOT LIKE '[COSTS ONLY]%')";
  }
  if (excludeConsent) {
    sql += " AND (summary IS NULL OR summary NOT LIKE '[CONSENT]%')";
  }
  sql += ' ORDER BY processed_at DESC LIMIT ? OFFSET ?';
  params.push(perPage, offset);
  const result = await db.prepare(sql).bind(...params).all<DbSeenCase>();
  return result.results;
}

export async function getCaseCountPaged(
  db: D1Database,
  excludeCosts = true,
  excludeConsent = true
): Promise<number> {
  let sql = 'SELECT COUNT(*) AS cnt FROM seen_cases WHERE source = ?';
  const params: any[] = ['ERA'];
  if (excludeCosts) {
    sql += " AND (summary IS NULL OR summary NOT LIKE '[COSTS ONLY]%')";
  }
  if (excludeConsent) {
    sql += " AND (summary IS NULL OR summary NOT LIKE '[CONSENT]%')";
  }
  const result = await db.prepare(sql).bind(...params).first<{ cnt: number }>();
  return result?.cnt ?? 0;
}

export async function getCaseStatistics(
  db: D1Database
): Promise<{ total: number; era: number; ec: number }> {
  const total = await db.prepare('SELECT COUNT(*) AS cnt FROM seen_cases').first<{ cnt: number }>();
  const era = await db.prepare("SELECT COUNT(*) AS cnt FROM seen_cases WHERE source = 'ERA'").first<{ cnt: number }>();
  const ec = await db.prepare("SELECT COUNT(*) AS cnt FROM seen_cases WHERE source = 'EMPLOYMENT_COURT'").first<{ cnt: number }>();
  return { total: total?.cnt ?? 0, era: era?.cnt ?? 0, ec: ec?.cnt ?? 0 };
}

// ─── Subscribers ──────────────────────────────────────────────────────────────

export async function getActiveSubscribers(db: D1Database): Promise<DbSubscriber[]> {
  const result = await db
    .prepare('SELECT * FROM subscribers WHERE active = 1 AND confirmed = 1 ORDER BY created_at')
    .all<DbSubscriber>();
  return result.results;
}

export async function getAllSubscribers(db: D1Database): Promise<DbSubscriber[]> {
  const result = await db
    .prepare('SELECT * FROM subscribers ORDER BY created_at DESC')
    .all<DbSubscriber>();
  return result.results;
}

export async function addSubscriberPending(
  db: D1Database,
  email: string,
  name: string | null,
  preferences: string | null
): Promise<{ token: string; alreadyActive: boolean }> {
  // Check if already active
  const existing = await db
    .prepare("SELECT active FROM subscribers WHERE email = ?")
    .bind(email)
    .first<{ active: number }>();
  if (existing?.active === 1) {
    return { token: '', alreadyActive: true };
  }
  const token = crypto.randomUUID();
  const unsubscribeToken = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO subscribers (email, name, active, confirmed, confirm_token, unsubscribe_token, preferences, created_at)
     VALUES (?, ?, 0, 0, ?, ?, ?, datetime('now'))`
  ).bind(email, name, token, unsubscribeToken, preferences).run();
  return { token, alreadyActive: false };
}

export async function confirmSubscriber(db: D1Database, token: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE subscribers SET active = 1, confirmed = 1, confirmed_at = datetime('now') WHERE confirm_token = ?")
    .bind(token)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function unsubscribeByToken(db: D1Database, token: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE subscribers SET active = 0, confirmed = 0 WHERE unsubscribe_token = ?")
    .bind(token)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteSubscriber(db: D1Database, email: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM subscribers WHERE email = ?")
    .bind(email)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function getSubscriberByToken(
  db: D1Database,
  token: string
): Promise<{ email: string; name: string | null; preferences: string | null } | null> {
  const row = await db
    .prepare("SELECT email, name, preferences FROM subscribers WHERE unsubscribe_token = ?")
    .bind(token)
    .first<{ email: string; name: string | null; preferences: string | null }>();
  return row ?? null;
}

export async function updatePreferences(
  db: D1Database,
  email: string,
  preferences: string
): Promise<void> {
  await db
    .prepare("UPDATE subscribers SET preferences = ? WHERE email = ?")
    .bind(preferences, email)
    .run();
}

export async function deleteStalePendingSubscribers(
  db: D1Database,
  maxAgeHours: number
): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM subscribers WHERE active = 0 AND created_at < datetime('now', '-${maxAgeHours} hours')`)
    .run();
  return result.meta.changes ?? 0;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export async function getConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM config WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setConfig(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  ).bind(key, value).run();
}

// ─── Email tracking ───────────────────────────────────────────────────────────

export async function hasEmailBeenSentToday(db: D1Database, timezone: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT value FROM config WHERE key = 'last_email_sent_at'`)
    .first<{ value: string }>();
  if (!row?.value) return false;
  const sentDate = new Date(row.value);
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-NZ', { timeZone: timezone });
  return formatter.format(sentDate) === formatter.format(now);
}

export async function recordEmailSent(db: D1Database): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('last_email_sent_at', ?, datetime('now'))"
  ).bind(new Date().toISOString()).run();
}

export async function recordRunAt(db: D1Database): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('last_run_at', ?, datetime('now'))"
  ).bind(new Date().toISOString()).run();
}

// ─── Processing lock ──────────────────────────────────────────────────────────

export async function setProcessingLock(db: D1Database, locked: boolean): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('is_processing', ?, datetime('now'))"
  ).bind(locked ? '1' : '0').run();
}

export async function isProcessing(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT value, updated_at FROM config WHERE key = 'is_processing'")
    .first<{ value: string; updated_at: string }>();
  if (!row || row.value !== '1') return false;
  // 10-minute auto-expiry
  const lockTime = new Date(row.updated_at).getTime();
  return Date.now() - lockTime < 600000;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

export async function savePromptWithHistory(
  db: D1Database,
  promptKey: string,
  content: string
): Promise<void> {
  // Save current version to history
  await db.prepare(
    `INSERT INTO prompt_versions (prompt_key, content, saved_at)
     SELECT ?, value, datetime('now') FROM config WHERE key = ?`
  ).bind(promptKey, promptKey).run();
  // Update the active prompt
  await db.prepare(
    "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  ).bind(promptKey, content).run();
}

export async function getPromptVersions(
  db: D1Database,
  promptKey: string,
  limit = 10
): Promise<Array<{ id: number; content: string; saved_at: string }>> {
  const result = await db
    .prepare(`SELECT id, content, saved_at FROM prompt_versions WHERE prompt_key = ? ORDER BY saved_at DESC LIMIT ?`)
    .bind(promptKey, limit)
    .all<{ id: number; content: string; saved_at: string }>();
  return result.results;
}

export async function revertPromptToVersion(
  db: D1Database,
  promptKey: string,
  versionId: number
): Promise<boolean> {
  const version = await db
    .prepare(`SELECT content FROM prompt_versions WHERE id = ? AND prompt_key = ?`)
    .bind(versionId, promptKey)
    .first<{ content: string }>();
  if (!version) return false;
  await db.prepare(
    "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  ).bind(promptKey, version.content).run();
  return true;
}

// ─── Case awards ──────────────────────────────────────────────────────────────

export interface CaseAwardRow {
  pdf_filename: string;
  source: string;
  hhd_amount: number | null;
  lost_wages: number | null;
  lost_wages_weeks: number | null;
  weekly_wage: number | null;
  costs_awarded: number | null;
  costs_awarded_text: string | null;
  reinstatement: boolean | null;
  reinstatement_sought: boolean | null;
  employee_status: boolean | null;
  outcome: string | null;
  extraction_method: string | null;
  decision_date: string | null;
  employment_tenure: string | null;
  contribution_applied: boolean | null;
  contribution_reduction: string | null;
  contribution_conduct: string | null;
  penalties: number | null;
}

export interface CaseAwardWithCase extends CaseAwardRow {
  title: string;
  category: string | null;
  date_published: string | null;
  pdf_url: string | null;
  case_url: string;
}

export async function insertCaseAward(
  db: D1Database,
  pdfFilename: string,
  source: string,
  awardsData: Record<string, any>,
  extractionMethod: string
): Promise<void> {
  await db.prepare(
    `INSERT OR REPLACE INTO case_awards
     (pdf_filename, source, hhd_amount, lost_wages, lost_wages_weeks, weekly_wage,
      costs_awarded, costs_awarded_text, reinstatement, reinstatement_sought, employee_status,
      outcome, extraction_method, decision_date, employment_tenure,
      contribution_applied, contribution_reduction, contribution_conduct, penalties)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    pdfFilename,
    source,
    awardsData.hhd_amount ?? null,
    awardsData.lost_wages ?? null,
    awardsData.lost_wages_weeks ?? null,
    awardsData.weekly_wage ?? null,
    awardsData.costs_awarded ?? null,
    awardsData.costs_awarded_text ?? null,
    awardsData.reinstatement ?? null,
    awardsData.reinstatement_sought ?? null,
    awardsData.employee_status ?? null,
    awardsData.outcome ?? null,
    extractionMethod,
    awardsData.decision_date ?? null,
    awardsData.employment_tenure ?? null,
    awardsData.contribution_applied ?? null,
    awardsData.contribution_reduction ?? null,
    awardsData.contribution_conduct ?? null,
    awardsData.penalties ?? null,
  ).run();
}

export async function getCaseAwardRows(
  db: D1Database,
  source: string = 'ERA'
): Promise<CaseAwardWithCase[]> {
  const result = await db
    .prepare(`
      SELECT ca.*, sc.title, sc.category, sc.date_published, sc.pdf_url, sc.case_url
      FROM case_awards ca
      JOIN seen_cases sc ON sc.pdf_filename = ca.pdf_filename AND sc.source = ca.source
      WHERE ca.source = ?
        AND sc.summary NOT LIKE '[COSTS ONLY]%'
        AND sc.summary NOT LIKE '[CONSENT]%'
      ORDER BY ca.pdf_filename DESC
    `)
    .bind(source)
    .all<CaseAwardWithCase>();
  return result.results;
}

export async function getCasesWithoutAwards(
  db: D1Database,
  source: string = 'ERA'
): Promise<DbSeenCase[]> {
  const result = await db
    .prepare(`SELECT s.* FROM seen_cases s LEFT JOIN case_awards a ON s.pdf_filename = a.pdf_filename AND s.source = a.source WHERE a.pdf_filename IS NULL AND s.source = ? AND s.summary IS NOT NULL ORDER BY s.processed_at DESC`)
    .bind(source)
    .all<DbSeenCase>();
  return result.results;
}

/**
 * Returns all visible cases ordered by processed_at DESC (for computing page numbers).
 */
export async function getVisibleCaseOrder(
  db: D1Database
): Promise<Array<{ pdf_filename: string }>> {
  const result = await db
    .prepare(`SELECT pdf_filename FROM seen_cases WHERE source = 'ERA' AND (summary IS NULL OR (summary NOT LIKE '[COSTS ONLY]%' AND summary NOT LIKE '[CONSENT]%')) ORDER BY processed_at DESC`)
    .all<{ pdf_filename: string }>();
  return result.results;
}

// ─── Error log ────────────────────────────────────────────────────────────────

export async function insertErrorLog(
  db: D1Database,
  level: string,
  source: string,
  message: string,
  details?: string | null,
  caseId?: string | null
): Promise<void> {
  await db.prepare(
    `INSERT INTO error_log (level, source, message, details, case_id, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  )
    .bind(level, source, message?.substring(0, 1000), details ?? null, caseId ?? null)
    .run();
}

export async function getRecentErrors(
  db: D1Database,
  limit = 20,
  sources?: string[]
): Promise<Array<{ id: number; level: string; source: string; message: string; details: string | null; case_id: string | null; created_at: string }>> {
  let query = 'SELECT * FROM error_log';
  const params: unknown[] = [];

  if (sources && sources.length > 0) {
    const placeholders = sources.map(() => '?').join(', ');
    query += ` WHERE source IN (${placeholders})`;
    params.push(...sources);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const result = await db.prepare(query).bind(...params).all<{
    id: number; level: string; source: string; message: string;
    details: string | null; case_id: string | null; created_at: string;
  }>();
  return result.results;
}

export async function pruneErrorLog(db: D1Database, daysOld = 30): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM error_log WHERE created_at < datetime('now', '-${daysOld} days')`)
    .run();
  return result.meta.changes || 0;
}

/** Search seen_cases by query against title, member, category, pdf_filename, summary */
export async function searchCases(
  db: D1Database,
  query: string,
  field?: string,
  limit = 20
): Promise<DbSeenCase[]> {
  const term = `%${query}%`;
  let sql: string;
  let params: unknown[];
  if (field && ['title', 'member', 'category', 'pdf_filename'].includes(field)) {
    sql = `SELECT * FROM seen_cases WHERE ${field} LIKE ? ORDER BY processed_at DESC LIMIT ?`;
    params = [term, limit];
  } else if (field === 'summary') {
    sql = `SELECT * FROM seen_cases WHERE summary LIKE ? ORDER BY processed_at DESC LIMIT ?`;
    params = [term, limit];
  } else {
    // All fields: search title, member, category, pdf_filename, and summary
    sql = `SELECT * FROM seen_cases WHERE title LIKE ? OR member LIKE ? OR category LIKE ? OR pdf_filename LIKE ? OR summary LIKE ? ORDER BY processed_at DESC LIMIT ?`;
    params = [term, term, term, term, term, limit];
  }
  const result = await db.prepare(sql).bind(...params).all<DbSeenCase>();
  return result.results;
}
