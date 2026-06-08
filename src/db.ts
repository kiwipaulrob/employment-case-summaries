/**
 * db.ts — D1 database query helpers
 *
 * All SQL queries are isolated here so the rest of the codebase
 * stays clean and can easily be adapted to a different database.
 */

import type { CaseListing, ProcessedCase, DbSubscriber, DbSeenCase } from './types';

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
         (source, pdf_filename, case_id, title, case_url, pdf_url, date_published, member, category, summary, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      processedCase.processedAt
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
  
  const { generateToken } = await import('./utils');
  const confirmToken = generateToken();
  const unsubscribeToken = generateToken();
  
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
  await db
    .prepare(`INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('is_processing', ?, datetime('now'))`)
    .bind(value)
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
    const lockTime = new Date(result.updated_at).getTime();
    const now = Date.now();
    const lockAgeMs = now - lockTime;
    const lockTimeoutMs = 10 * 60 * 1000; // 10 minutes
    
    if (lockAgeMs > lockTimeoutMs) {
      console.warn(`Stale processing lock detected (age: ${Math.round(lockAgeMs / 1000)}s), treating as unlocked`);
      return false;
    }
    
    return true;
  } catch (err) {
    console.warn(`Error checking lock age: ${err}, treating lock as active`);
    return true;
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
