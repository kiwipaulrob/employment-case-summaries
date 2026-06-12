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

  const placeholders = pdfFilenames.map(() => '?').join(', ');
  const result = await db
    .prepare(`SELECT pdf_filename FROM seen_cases WHERE source = ? AND pdf_filename IN (${placeholders})`)
    .bind(source, ...pdfFilenames)
    .all<{ pdf_filename: string }>();

  const seenFilenames = new Set(result.results.map((r) => r.pdf_filename));
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
         (source, pdf_filename, case_id, title, case_url, pdf_url, date_published, member, category, summary, processed_at, summary_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      source,
      pdfFilename,
      processedCase.caseId,
      processedCase.title,
      processedCase.caseUrl,
      processedCase.pdfUrl ?? null,
      processedCase.datePublished ?? '',
      processedCase.member ?? null,
      processedCase.category ?? null,
      processedCase.summary,
      processedCase.processedAt,
      processedCase.summaryVersion ?? null
    )
    .run();
}

/**
 * Returns the N most recently processed cases (used by the /admin HTTP handler).
 */
export async function getRecentCases(
  db: D1Database,
  limit = 20
): Promise<DbSeenCase[]> {
  const result = await db
    .prepare(
      'SELECT * FROM seen_cases ORDER BY processed_at DESC LIMIT ?'
    )
    .bind(limit)
    .all<DbSeenCase>();
  return result.results;
}

/**
 * Returns a paginated slice of cases for the public landing page.
 * Filters out placeholder summaries and (optionally) tagged cases server-side.
 */
export async function getRecentCasesPaged(
  db: D1Database,
  limit: number,
  offset: number,
  showCosts: boolean,
  showConsent: boolean
): Promise<DbSeenCase[]> {
  let where = "WHERE summary IS NOT NULL AND summary NOT LIKE '(seeded%'";
  if (!showCosts) where += " AND summary NOT LIKE '[COSTS ONLY]%'";
  if (!showConsent) where += " AND summary NOT LIKE '[CONSENT]%'";
  const result = await db
    .prepare(`SELECT * FROM seen_cases ${where} ORDER BY processed_at DESC LIMIT ? OFFSET ?`)
    .bind(limit, offset)
    .all<DbSeenCase>();
  return result.results;
}

/**
 * Returns total count of cases visible on the landing page (respecting tag filters).
 * Used for pagination.
 */
export async function getCaseCountPaged(
  db: D1Database,
  showCosts: boolean,
  showConsent: boolean
): Promise<number> {
  let where = "WHERE summary IS NOT NULL AND summary NOT LIKE '(seeded%'";
  if (!showCosts) where += " AND summary NOT LIKE '[COSTS ONLY]%'";
  if (!showConsent) where += " AND summary NOT LIKE '[CONSENT]%'";
  const result = await db
    .prepare(`SELECT COUNT(*) as count FROM seen_cases ${where}`)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

/**
 * Returns case statistics (counts by source).
 * Used by dashboard to avoid loading full result sets.
 */
export async function getCaseStatistics(db: D1Database): Promise<{ total: number; era: number; ec: number }> {
  const result = await db
    .prepare('SELECT source, COUNT(*) as count FROM seen_cases GROUP BY source')
    .all<{ source: string; count: number }>();
  
  let era = 0;
  let ec = 0;
  result.results.forEach((r) => {
    if (r.source === 'ERA') era = r.count;
    if (r.source === 'EMPLOYMENT_COURT') ec = r.count;
  });
  
  return { total: era + ec, era, ec };
}

// ─── Subscribers ──────────────────────────────────────────────────────────────

/**
 * Returns all active (opted-in and confirmed) subscribers.
 */
export async function getActiveSubscribers(
  db: D1Database
): Promise<DbSubscriber[]> {
  const result = await db
    .prepare('SELECT * FROM subscribers WHERE active = 1 AND confirmed = 1')
    .all<DbSubscriber>();
  return result.results;
}

/**
 * Returns all subscribers (for admin view).
 */
export async function getAllSubscribers(
  db: D1Database
): Promise<DbSubscriber[]> {
  const result = await db
    .prepare('SELECT * FROM subscribers')
    .all<DbSubscriber>();
  return result.results;
}

/**
 * Returns a specific subscriber by email.
 */
export async function getSubscriberByEmail(
  db: D1Database,
  email: string
): Promise<DbSubscriber | null> {
  const result = await db
    .prepare('SELECT * FROM subscribers WHERE email = ?')
    .bind(email)
    .first<DbSubscriber>();
  return result || null;
}

/**
 * Adds a pending (unconfirmed) subscriber. Returns the subscriber record.
 */
export async function addPendingSubscriber(
  db: D1Database,
  email: string,
  name: string | null,
  confirmToken: string,
  unsubscribeToken: string
): Promise<DbSubscriber> {
  await db
    .prepare(
      `INSERT INTO subscribers (email, name, active, confirmed, confirm_token, unsubscribe_token, created_at)
       VALUES (?, ?, 0, 0, ?, ?, datetime('now'))`
    )
    .bind(email, name, confirmToken, unsubscribeToken)
    .run();
  
  const subscriber = await getSubscriberByEmail(db, email);
  if (!subscriber) throw new Error('Failed to retrieve newly inserted subscriber');
  return subscriber;
}

/**
 * Confirms a subscription by token. Returns the subscriber record if found.
 */
export async function confirmSubscriber(
  db: D1Database,
  confirmToken: string
): Promise<DbSubscriber | null> {
  const result = await db
    .prepare('SELECT * FROM subscribers WHERE confirm_token = ?')
    .bind(confirmToken)
    .first<DbSubscriber>();
  
  if (!result) return null;

  await db
    .prepare('UPDATE subscribers SET confirmed = 1 WHERE id = ?')
    .bind(result.id)
    .run();
  
  return { ...result, confirmed: 1 };
}

/**
 * Unsubscribes a subscriber by token.
 */
export async function unsubscribeByToken(
  db: D1Database,
  unsubscribeToken: string
): Promise<DbSubscriber | null> {
  const result = await db
    .prepare('SELECT * FROM subscribers WHERE unsubscribe_token = ?')
    .bind(unsubscribeToken)
    .first<DbSubscriber>();
  
  if (!result) return null;

  await db
    .prepare('UPDATE subscribers SET active = 0 WHERE id = ?')
    .bind(result.id)
    .run();
  
  return { ...result, active: 0 };
}

/**
 * Deletes a subscriber by ID.
 */
export async function deleteSubscriber(
  db: D1Database,
  subscriberId: number
): Promise<void> {
  await db
    .prepare('DELETE FROM subscribers WHERE id = ?')
    .bind(subscriberId)
    .run();
}

/**
 * Deletes all subscribers with confirmed=0 AND created_at older than 48 hours.
 * Used by the cron job to clean up unconfirmed sign-ups.
 */
export async function deleteStalePendingSubscribers(
  db: D1Database,
  hoursAgo = 48
): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM subscribers 
       WHERE confirmed = 0 AND created_at < datetime('now', '-${hoursAgo} hours')`
    )
    .run();
  return result.meta.changes || 0;
}

// ─── Config/state ────────────────────────────────────────────────────────────

/**
 * Checks if an email has been sent today (in target timezone, not UTC).
 * Used by DST guard to prevent duplicate digests.
 * 
 * For Pacific/Auckland (UTC+12 winter, UTC+13 summer), we calculate the date
 * in that timezone and check if the email was sent on that same date.
 */
export async function hasEmailBeenSentToday(db: D1Database, timezone: string): Promise<boolean> {
  // Fetch the stored timestamp
  const row = await db
    .prepare(`SELECT value FROM config WHERE key = 'last_email_sent_at'`)
    .first<{ value: string }>();
  
  if (!row?.value) return false;

  // Convert both timestamps to dates in the target timezone
  // For Pacific/Auckland, we use Intl.DateTimeFormat which auto-handles DST
  try {
    const now = new Date();
    const storedDate = new Date(row.value);
    
    // Format both dates as YYYY-MM-DD in the target timezone
    const formatter = new Intl.DateTimeFormat('en-NZ', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    
    const todayStr = formatter.format(now);
    const storedStr = formatter.format(storedDate);
    
    console.log(`ERA Digest: DST check — stored=${storedStr}, today=${todayStr} (${timezone})`);
    
    // Both should be "YYYY-MM-DD" formatted strings
    return storedStr === todayStr;
  } catch (err) {
    // Fallback: if Intl fails, use simple UTC date comparison with offset
    // This is a safety net only — the Intl approach should work
    console.warn(`ERA Digest: Intl.DateTimeFormat failed, falling back to UTC: ${err}`);
    const storedDate = new Date(row.value);
    const now = new Date();
    
    // Simple UTC fallback: return false if more than 12 hours have passed
    // This prevents duplicate sends within a 12-hour window
    const hoursSince = (now.getTime() - storedDate.getTime()) / (1000 * 60 * 60);
    return hoursSince < 12;
  }
}

/**
 * Records that an email was sent (current UTC timestamp).
 */
export async function recordEmailSent(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT INTO config (key, value, updated_at) 
       VALUES ('last_email_sent_at', datetime('now'), datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run();
}

/**
 * Records when a pipeline run occurred (for monitoring/debugging).
 * If no label is provided, records to 'last_run_at'.
 */
export async function recordRunAt(db: D1Database, label?: string): Promise<void> {
  const key = label ? `run_${label}` : 'last_run_at';
  await db
    .prepare(
      `INSERT INTO config (key, value, updated_at) 
       VALUES (?, datetime('now'), datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key)
    .run();
}

/**
 * Retrieves a config value.
 */
export async function getConfig(db: D1Database, key: string): Promise<string | null> {
  const result = await db
    .prepare('SELECT value FROM config WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return result?.value ?? null;
}

/**
 * Sets (upserts) a config value by key.
 */
export async function setConfig(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(`INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .bind(key, value)
    .run();
}

/**
 * Looks up an active subscriber by their unsubscribe token.
 */
export async function getSubscriberByToken(
  db: D1Database,
  token: string
): Promise<DbSubscriber | null> {
  return db
    .prepare('SELECT * FROM subscribers WHERE unsubscribe_token = ?')
    .bind(token)
    .first<DbSubscriber>();
}

/**
 * Updates the preferences JSON blob for a subscriber identified by unsubscribe token.
 */
export async function updatePreferences(
  db: D1Database,
  token: string,
  preferences: string
): Promise<void> {
  await db
    .prepare('UPDATE subscribers SET preferences = ? WHERE unsubscribe_token = ?')
    .bind(preferences, token)
    .run();
}

/**
 * Alias for addPendingSubscriber to match the old interface.
 */
export async function addSubscriberPending(
  db: D1Database,
  email: string,
  name: string | null
): Promise<{ token: string; alreadyActive: boolean }> {
  const existing = await getSubscriberByEmail(db, email);
  if (existing && existing.active && existing.confirmed) {
    return { token: existing.unsubscribe_token ?? '', alreadyActive: true };
  }
  
  // generateToken() was just a wrapper for crypto.randomUUID(); call it directly to avoid the dynamic import
  const confirmToken = crypto.randomUUID();
  const unsubscribeToken = crypto.randomUUID();
  
  await addPendingSubscriber(db, email, name, confirmToken, unsubscribeToken);
  return { token: confirmToken, alreadyActive: false };
}

// ─── Processing lock ──────────────────────────────────────────────────────

/**
 * Sets a processing lock to prevent concurrent cron executions.
 * Uses INSERT OR REPLACE with timestamp to track lock age.
 */
export async function setProcessingLock(db: D1Database, locked: boolean): Promise<void> {
  const value = locked ? '1' : '0';
  const now = new Date().toISOString(); // ISO 8601: "2026-06-13T01:15:23.000Z"
  await db
    .prepare(`INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('is_processing', ?, ?)`)
    .bind(value, now)
    .run();
}

/**
 * Checks if a processing lock is currently active.
 * Returns false if the lock is stale (older than 10 minutes).
 * This prevents deadlock if a cron run crashes without releasing the lock.
 */
export async function isProcessing(db: D1Database): Promise<boolean> {
  const result = await db
    .prepare(`SELECT value, updated_at FROM config WHERE key = 'is_processing'`)
    .first<{ value: string; updated_at: string }>();
  
  if (result?.value !== '1') return false;
  
  // If lock is older than 10 minutes, consider it stale and ignore it
  try {
    // Normalize date string: MySQL format "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SS"
    // ISO 8601 "2026-06-13T01:15:23.000Z" passes through unchanged
    const normalizedDate = result.updated_at.replace(' ', 'T');
    // Append 'Z' if no timezone suffix (MySQL format has none, so treat as UTC)
    const dateStr = normalizedDate.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(normalizedDate)
      ? normalizedDate
      : normalizedDate + 'Z';
    const lockTime = new Date(dateStr).getTime();
    if (isNaN(lockTime)) {
      console.warn(`Unparseable lock timestamp: "${result.updated_at}", treating as stale`);
      await setProcessingLock(db, false); // clear the corrupt lock
      return false;
    }
    const now = Date.now();
    const lockAgeMs = now - lockTime;
    const lockTimeoutMs = 10 * 60 * 1000; // 10 minutes
    
    if (lockAgeMs > lockTimeoutMs) {
      console.warn(`Stale processing lock detected (age: ${Math.round(lockAgeMs / 1000)}s), treating as unlocked`);
      await setProcessingLock(db, false); // clear the stale lock automatically
      return false;
    }
    
    return true;
  } catch (err) {
    console.warn(`Error checking lock age: ${err}, clearing lock and continuing`);
    await setProcessingLock(db, false).catch(() => {});
    return false;
  }
}

// ─── LLM Prompts ──────────────────────────────────────────────────────────

/**
 * Retrieves the current LLM system prompt for a given type.
 * type: 'era' or 'ec' (Employment Court)
 */
export async function getPrompt(db: D1Database, type: 'era' | 'ec'): Promise<string> {
  const key = type === 'era' ? 'prompt_era' : 'prompt_ec';
  const result = await db
    .prepare('SELECT value FROM config WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  
  if (!result?.value) {
    // Fallback: if prompt not in DB (shouldn't happen after migration 0007), return a minimal default
    return type === 'era' 
      ? 'You are a legal analyst. Provide a structured summary with these sections: PARTIES, REPRESENTATIVES, FACTS, LEGAL ISSUES, HOW THE ISSUES WERE RESOLVED, OUTCOME, REMEDY.'
      : 'You are a legal analyst. Provide a structured 7-section summary: JUDGE & DATE, PARTIES, REPRESENTATIVES, FACTS, ERA FINDINGS, EMPLOYMENT COURT ISSUES RAISED, HOW THE EMPLOYMENT COURT ISSUES WERE RESOLVED, OUTCOME & REMEDY.';
  }
  
  return result.value;
}

/**
 * Updates the LLM system prompt for a given type.
 * type: 'era' or 'ec'
 * prompt: The new prompt text
 */
export async function setPrompt(db: D1Database, type: 'era' | 'ec', prompt: string): Promise<void> {
  const key = type === 'era' ? 'prompt_era' : 'prompt_ec';
  await db
    .prepare(`INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .bind(key, prompt)
    .run();
}

// ─── Prompt version history ───────────────────────────────────────────────────

export interface PromptVersion {
  id: number;
  prompt_key: string;
  content: string;
  saved_at: string;
}

/**
 * Returns the last N prompt versions for a given key, newest first.
 */
export async function getPromptVersions(
  db: D1Database,
  key: 'prompt_era' | 'prompt_ec',
  limit = 10
): Promise<PromptVersion[]> {
  const result = await db
    .prepare('SELECT * FROM prompt_versions WHERE prompt_key = ? ORDER BY id DESC LIMIT ?')
    .bind(key, limit)
    .all<PromptVersion>();
  return result.results;
}

/**
 * Saves the current prompt value to version history, then writes the new value to config.
 * Trims history to keep only the last 10 versions per key.
 * Safe to call even if config has no current value (initial seed).
 */
export async function savePromptWithHistory(
  db: D1Database,
  key: 'prompt_era' | 'prompt_ec',
  newContent: string
): Promise<void> {
  // Snapshot current value before overwriting
  const current = await db
    .prepare('SELECT value FROM config WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();

  if (current?.value?.trim()) {
    // Archive current value
    await db
      .prepare(
        `INSERT INTO prompt_versions (prompt_key, content, saved_at)
         VALUES (?, ?, datetime('now'))`
      )
      .bind(key, current.value)
      .run();

    // Keep only the last 10 versions — delete anything outside the top 10
    await db
      .prepare(
        `DELETE FROM prompt_versions
         WHERE prompt_key = ? AND id NOT IN (
           SELECT id FROM prompt_versions WHERE prompt_key = ? ORDER BY id DESC LIMIT 10
         )`
      )
      .bind(key, key)
      .run();
  }

  // Write new value to config
  await db
    .prepare(
      `INSERT OR REPLACE INTO config (key, value, updated_at)
       VALUES (?, ?, datetime('now'))`
    )
    .bind(key, newContent)
    .run();
}

/**
 * Reverts a prompt to a specific version by its ID.
 * Saves the current prompt to history first (so the revert itself is undoable).
 * Returns false if the version ID is not found.
 */
export async function revertPromptToVersion(
  db: D1Database,
  key: 'prompt_era' | 'prompt_ec',
  versionId: number
): Promise<boolean> {
  const version = await db
    .prepare('SELECT * FROM prompt_versions WHERE id = ? AND prompt_key = ?')
    .bind(versionId, key)
    .first<PromptVersion>();

  if (!version) return false;

  // Remove this version from history — it's about to become the live prompt
  await db
    .prepare('DELETE FROM prompt_versions WHERE id = ?')
    .bind(versionId)
    .run();

  // Archive current + write reverted content (savePromptWithHistory handles both)
  await savePromptWithHistory(db, key, version.content);

  return true;
}

// ─── Case awards ──────────────────────────────────────────────────────────────

export interface CaseAwardRow {
  id: number;
  pdf_filename: string;
  source: string;
  hhd_amount: number | null;
  lost_wages: number | null;
  lost_wages_weeks: number | null;
  weekly_wage: number | null;
  costs_awarded: number | null;
  costs_awarded_text: string | null;
  reinstatement: number;
  outcome: string | null;
  extraction_method: string;
  created_at: string;
  decision_date: string | null;
  employment_tenure: string | null;
  contribution_applied: number;
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

/**
 * Inserts or updates a case award record.
 * Safe to call multiple times — upserts on (pdf_filename, source).
 */
export async function insertCaseAward(
  db: D1Database,
  pdfFilename: string,
  source: string,
  data: {
    hhd_amount: number | null;
    lost_wages: number | null;
    lost_wages_weeks: number | null;
    weekly_wage: number | null;
    costs_awarded: number | null;
    costs_awarded_text?: string | null;
    reinstatement: boolean;
    outcome: string | null;
    decision_date?: string | null;
    employment_tenure?: string | null;
    contribution_applied?: boolean;
    contribution_reduction?: string | null;
    contribution_conduct?: string | null;
    penalties?: number | null;
  },
  extractionMethod: string
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO case_awards
        (pdf_filename, source, hhd_amount, lost_wages, lost_wages_weeks, weekly_wage,
         costs_awarded, costs_awarded_text, reinstatement, outcome, extraction_method,
         decision_date, employment_tenure, contribution_applied, contribution_reduction,
         contribution_conduct, penalties)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pdf_filename, source) DO UPDATE SET
        hhd_amount            = excluded.hhd_amount,
        lost_wages            = excluded.lost_wages,
        lost_wages_weeks      = excluded.lost_wages_weeks,
        weekly_wage           = excluded.weekly_wage,
        costs_awarded         = excluded.costs_awarded,
        costs_awarded_text    = excluded.costs_awarded_text,
        reinstatement         = excluded.reinstatement,
        outcome               = excluded.outcome,
        extraction_method     = excluded.extraction_method,
        decision_date         = excluded.decision_date,
        employment_tenure     = excluded.employment_tenure,
        contribution_applied  = excluded.contribution_applied,
        contribution_reduction= excluded.contribution_reduction,
        contribution_conduct  = excluded.contribution_conduct,
        penalties             = excluded.penalties
    `)
    .bind(
      pdfFilename, source,
      data.hhd_amount, data.lost_wages, data.lost_wages_weeks,
      data.weekly_wage, data.costs_awarded,
      data.costs_awarded_text ?? null,
      data.reinstatement ? 1 : 0,
      data.outcome, extractionMethod,
      data.decision_date ?? null,
      data.employment_tenure ?? null,
      data.contribution_applied ? 1 : 0,
      data.contribution_reduction ?? null,
      data.contribution_conduct ?? null,
      data.penalties ?? null
    )
    .run();
}

/**
 * Returns all award rows joined with their seen_cases metadata.
 * Used by the public /awards page.
 */
export async function getCaseAwardRows(
  db: D1Database,
  source = 'ERA'
): Promise<CaseAwardWithCase[]> {
  const result = await db
    .prepare(`
      SELECT ca.*, sc.title, sc.category, sc.date_published, sc.pdf_url, sc.case_url
      FROM case_awards ca
      JOIN seen_cases sc ON sc.pdf_filename = ca.pdf_filename AND sc.source = ca.source
      WHERE ca.source = ?
        AND sc.summary NOT LIKE '[COSTS ONLY]%'
        AND sc.summary NOT LIKE '[CONSENT]%'
      ORDER BY sc.date_published DESC, sc.processed_at DESC
    `)
    .bind(source)
    .all<CaseAwardWithCase>();
  return result.results;
}

/**
 * Returns ERA cases that have a summary but no entry in case_awards.
 * Used by the backfill-awards endpoint to find cases needing extraction.
 */
export async function getCasesWithoutAwards(
  db: D1Database,
  source = 'ERA'
): Promise<DbSeenCase[]> {
  const result = await db
    .prepare(`
      SELECT sc.*
      FROM seen_cases sc
      LEFT JOIN case_awards ca ON ca.pdf_filename = sc.pdf_filename AND ca.source = sc.source
      WHERE sc.source = ?
        AND sc.summary IS NOT NULL
        AND sc.summary NOT LIKE '(seeded%'
        AND sc.summary NOT LIKE 'Summary unavailable%'
        AND sc.summary NOT LIKE '[COSTS ONLY]%'
        AND sc.summary NOT LIKE '[CONSENT]%'
        AND ca.id IS NULL
      ORDER BY sc.processed_at DESC
    `)
    .bind(source)
    .all<DbSeenCase>();
  return result.results;
}

// ─── Error log ──────────────────────────────────────────────────────────────

/**
 * Inserts a new entry into the error_log table.
 * Replaces the old single config:last_error pattern with a proper log.
 */
export async function insertErrorLog(
  db: D1Database,
  level: string,
  source: string,
  message: string,
  details?: string | null,
  caseId?: string | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO error_log (level, source, message, details, case_id, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    )
    .bind(level, source, message?.substring(0, 1000), details ?? null, caseId ?? null)
    .run();
}

/**
 * Returns recent error log entries, newest first.
 */
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

/**
 * Deletes error log entries older than N days.
 * Returns the number of deleted rows.
 */
export async function pruneErrorLog(db: D1Database, daysOld = 30): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM error_log WHERE created_at < datetime('now', '-${daysOld} days')`)
    .run();
  return result.meta.changes || 0;
}
