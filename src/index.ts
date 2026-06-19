/**
 * index.ts — Cloudflare Worker entry point.
 *
 * Public routes (no auth required):
 *   GET  /                  — Landing page + recent cases archive
 *   POST /subscribe         — Sign-up form handler
 *   GET  /subscribed        — "Check your email" page
 *   GET  /confirm?token=X   — Confirm subscription
 *   GET  /unsubscribe?token=X — One-click unsubscribe
 *
 * Admin UI routes (session cookie auth):
 *   GET  /admin             — Login form or dashboard (cookie-gated)
 *   POST /admin             — Login form submission
 *   POST /admin/delete-subscriber — Delete a subscriber
 *   GET  /admin/logout      — Clear session cookie
 *
 * Admin API routes (Bearer token required):
 *   GET  /health            — Public health check
 *   POST /run               — Manual pipeline trigger (202 async)
 *   GET  /admin/seen-cases  — List recent processed cases
 *   GET  /admin/status      — Subscriber + config summary
 *   POST /admin/seed-seen   — Mark all current ERA listings as seen
 *   POST /admin/clear-seen  — Clear seen_cases table
 *   POST /admin/upload-ec-case — Upload Employment Court PDF for manual processing
 *   POST /admin/send-digest — Send digest from stored summaries
 *
 * Dashboard API routes (session cookie auth — added 8 June 2026):
 *   POST /admin/dashboard/backfill-era      — Scrape ERA pages 1–N and silently process new cases (no email)
 *   POST /admin/dashboard/upload-era-url    — Process a single ERA case by PDF URL (no email, manual backfill)
 *   POST /admin/test-email  — Send test email
 *   GET  /admin/test-llm    — Test OpenRouter connectivity
 */

import { EmailMessage } from 'cloudflare:email';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env, ProcessedCase, CaseListing } from './types';
import {
  filterNewCases, markCaseSeen, getActiveSubscribers, getAllSubscribers,
  hasEmailBeenSentToday, recordEmailSent, recordRunAt, getRecentCases, getRecentCasesPaged, getCaseCountPaged, getCaseStatistics,
  getConfig, setConfig, addSubscriberPending, confirmSubscriber, unsubscribeByToken,
  deleteSubscriber, deleteStalePendingSubscribers, setProcessingLock, isProcessing,
  getSubscriberByToken, updatePreferences,
  insertCaseAward, getCaseAwardRows, getCasesWithoutAwards,
  savePromptWithHistory, getPromptVersions, revertPromptToVersion,
  insertErrorLog, getRecentErrors, getVisibleCaseOrder,
} from './db';
import { scrapeRecentPage, scrapeAllPages, enrichCasesWithDetails, scrapeEraDetailPage } from './scraper';
import { getPdfContent, getPdfContentFromBytes, type PdfContent } from './pdf';
import { summariseCase } from './summariser';
import { summariseEmploymentCourtCase } from './summariserEmploymentCourt';
import {
  sendDigestToAll, sendAdminAlert, buildDigestEmail,
  sendConfirmationEmail,
} from './emailer';
import {
  homePage, subscribedPage, confirmedPage, unsubscribedPage,
  alreadyUnsubscribedPage, invalidTokenPage, alreadySubscribedPage,
  adminLoginPage, preferencesPage, awardsPage,
} from './pages';
import { getDashboardHtml } from './dashboard';
import { isValidEmail, parseAwardsBlock, timingSafeEqual } from './utils';
import { checkRateLimit, getClientIp } from './rate-limiter';
import { DIAGNOSTICS_TESTS, type DiagnosticsReport } from './diagnostics';

// ─── Cookie helpers ───────────────────────────────────────────────────────────

const SESSION_COOKIE = 'era_admin';

function getAdminCookie(request: Request): string | null {
  const cookie = request.headers.get('Cookie') ?? '';
  const match = cookie.match(/era_admin=([^;]+)/);
  return match?.[1] ?? null;
}

function setAdminCookie(secret: string): string {
  return `${SESSION_COOKIE}=${secret}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`;
}

function clearAdminCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/**
 * Checks if a request is authenticated via session cookie or Bearer token.
 */
function isAuthenticated(request: Request, env: Env): boolean {
  const session = getAdminCookie(request);
  if (session === env.ADMIN_SECRET) return true;
  const authHeader = request.headers.get('Authorization') ?? '';
  return authHeader.startsWith('Bearer ') && authHeader.slice(7) === env.ADMIN_SECRET;
}

// ─── Email notice helper ──────────────────────────────────────────────────────

/**
 * Fetch optional email notice from D1 config (peek only — does NOT clear).
 * Returns null if no notice is configured.
 */
async function getEmailNotice(db: D1Database): Promise<string | null> {
  try {
    return await getConfig(db, 'email_notice');
  } catch (err) {
    console.warn(`Failed to fetch email notice: ${err}`);
    return null;
  }
}

/**
 * Clears the email notice after successful delivery.
 */
async function clearEmailNotice(db: D1Database): Promise<void> {
  try {
    await db.prepare(`UPDATE config SET value = NULL WHERE key = 'email_notice'`).run();
    console.log('Email notice cleared after successful delivery');
  } catch (err) {
    console.warn(`Failed to clear email notice: ${err}`);
  }
}

// ─── PDF extraction helper ─────────────────────────────────────────────────────

/**
 * Extract text from a PDF using the Python sidecar worker (pdf-parser-python).
 * This worker uses pypdf to handle CID fonts in Employment Court PDFs.
 * 
 * @param pdfBytes — Raw PDF bytes from request body
 * @param env — Worker environment (includes PDF_PARSER binding)
 * @returns Extracted text string
 */
async function extractTextWithPython(pdfBytes: ArrayBuffer, env: Env): Promise<string> {
  // 20-second circuit breaker to prevent infinite hangs
  const timeoutPromise = new Promise<never>(
    (_, reject) => setTimeout(() => reject(new Error('PDF extraction timeout (20s)')), 20000)
  );

  const fetchPromise = env.PDF_PARSER.fetch('http://pdf-parser.local/', {
    method: 'POST',
    body: pdfBytes,
    headers: { 'Content-Type': 'application/pdf' },
  });

  const response = await Promise.race([fetchPromise, timeoutPromise]);

  if (!response.ok) {
    const errorData: any = await response.json();
    throw new Error(`PDF Extraction Failed: ${errorData.error}`);
  }

  const result: any = await response.json();
  return result.text || '';
}

export default {
  // ─── Cron trigger ────────────────────────────────────────────────────────────

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await Promise.all([
      runDigest(env),
      deleteStalePendingSubscribers(env.DB, 48).then(n => {
        if (n > 0) console.log(`ERA Digest: purged ${n} stale pending subscriber(s)`);
      }),
    ]);
  },

  // ─── HTTP handler ─────────────────────────────────────────────────────────────

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ══════════════════════════════════════════════════════════════════════════
    // PUBLIC ROUTES (no auth required)
    // ══════════════════════════════════════════════════════════════════════════

    // GET / — Landing page (paginated)
    if (request.method === 'GET' && url.pathname === '/') {
      const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
      const PAGE_SIZE = 20;
      const offset = (page - 1) * PAGE_SIZE;
      const [cases, totalCount] = await Promise.all([
        getRecentCasesPaged(env.DB, PAGE_SIZE, offset, false, false),
        getCaseCountPaged(env.DB, false, false),
      ]);
      return htmlResponse(homePage(cases, undefined, page, totalCount));
    }

    // GET /awards — Public awards & damages statistics page
    if (request.method === 'GET' && url.pathname === '/awards') {
      try {
        const rows = await getCaseAwardRows(env.DB, 'ERA');
        // Build page-number map so Summary links go to the right home-page page
        const pageSize = 20;
        const caseOrder = await getVisibleCaseOrder(env.DB);
        const pageMap = new Map<string, number>();
        caseOrder.forEach((c, i) => {
          pageMap.set(c.pdf_filename, Math.floor(i / pageSize) + 1);
        });
        return htmlResponse(awardsPage(rows, pageMap));
      } catch (err) {
        console.error(`Awards page error: ${err}`);
        return htmlResponse(awardsPage([]));
      }
    }

    // GET /remedies → redirect to /awards
    if (request.method === 'GET' && url.pathname === '/remedies') {
      return new Response(null, {
        status: 301,
        headers: { Location: '/awards' },
      });
    }

    // POST /subscribe — Handle sign-up form (rate limited: 20/IP/min)
    if (request.method === 'POST' && url.pathname === '/subscribe') {
      if (!checkRateLimit(getClientIp(request))) {
        return new Response('Too many requests. Please try again later.', { status: 429 });
      }
      const formData = await request.formData();
      const email = (formData.get('email') as string ?? '').trim().toLowerCase();
      const name = (formData.get('name') as string ?? '').trim() || null;
      const showCosts = formData.get('show_costs') === '1';
      const showConsent = formData.get('show_consent') === '1';
      const preferences = JSON.stringify({ show_costs: showCosts, show_consent: showConsent });

      if (!email || !isValidEmail(email)) {
        const [cases, totalCount] = await Promise.all([
          getRecentCasesPaged(env.DB, 20, 0, false, false),
          getCaseCountPaged(env.DB, false, false),
        ]);
        return htmlResponse(homePage(cases, 'Please enter a valid email address.', 1, totalCount));
      }

      const { token, alreadyActive } = await addSubscriberPending(env.DB, email, name, preferences);

      if (alreadyActive) {
        return htmlResponse(alreadySubscribedPage(email));
      }

      // Send confirmation email (non-blocking — don't fail the page if email fails)
      try {
        await sendConfirmationEmail(email, name, token, env.SENDING_ADDRESS, env.SITE_URL, env.EMAIL);
      } catch (err) {
        console.error(`Failed to send confirmation email to ${email}: ${err}`);
        // Still redirect — they can try again
      }

      return new Response('', {
        status: 302,
        headers: { Location: `/subscribed?email=${encodeURIComponent(email)}` },
      });
    }

    // GET /preferences?token=X — Preferences page
    if (request.method === 'GET' && url.pathname === '/preferences') {
      const token = url.searchParams.get('token') ?? '';
      if (!token) return htmlResponse(invalidTokenPage());
      const sub = await getSubscriberByToken(env.DB, token);
      if (!sub) return htmlResponse(invalidTokenPage());
      return htmlResponse(preferencesPage(sub));
    }

    // POST /preferences — Update subscriber preferences
    if (request.method === 'POST' && url.pathname === '/preferences') {
      const formData = await request.formData();
      const token = (formData.get('token') as string ?? '').trim();
      const showCosts = formData.get('show_costs') === '1';
      const showConsent = formData.get('show_consent') === '1';
      if (!token) return htmlResponse(invalidTokenPage());
      const sub = await getSubscriberByToken(env.DB, token);
      if (!sub) return htmlResponse(invalidTokenPage());
      await updatePreferences(env.DB, token, JSON.stringify({ show_costs: showCosts, show_consent: showConsent }));
      return htmlResponse(preferencesPage({ ...sub, preferences: JSON.stringify({ show_costs: showCosts, show_consent: showConsent }) }, true));
    }

    // GET /subscribed — "Check your email" page
    if (request.method === 'GET' && url.pathname === '/subscribed') {
      const email = url.searchParams.get('email') ?? '';
      return htmlResponse(subscribedPage(email));
    }

    // GET /confirm?token=X — Confirm subscription
    if (request.method === 'GET' && url.pathname === '/confirm') {
      const token = url.searchParams.get('token') ?? '';
      if (!token) return htmlResponse(invalidTokenPage());
      const sub = await confirmSubscriber(env.DB, token);
      if (!sub) return htmlResponse(invalidTokenPage());
      return htmlResponse(confirmedPage(sub.name ?? 'there'));
    }

    // GET /unsubscribe?token=X — One-click unsubscribe
    if (request.method === 'GET' && url.pathname === '/unsubscribe') {
      const token = url.searchParams.get('token') ?? '';
      if (!token) return htmlResponse(invalidTokenPage());
      const done = await unsubscribeByToken(env.DB, token);
      return htmlResponse(done ? unsubscribedPage() : alreadyUnsubscribedPage());
    }

    // GET /health — Public health check
    if (request.method === 'GET' && url.pathname === '/health') {
      const lastRun = await getConfig(env.DB, 'last_run_at');
      const lastEmail = await getConfig(env.DB, 'last_email_sent_at');
      return jsonResponse({ status: 'ok', lastRunAt: lastRun, lastEmailSentAt: lastEmail });
    }

    // GET /diag — Pipeline diagnostic (returns pipeline debug info)
    if (request.method === 'GET' && url.pathname === '/diag') {
      try {
        const isProc = await isProcessing(env.DB);
        const lastRun = await getConfig(env.DB, 'last_run_at');
        const lastErr = await getConfig(env.DB, 'last_error');
        const procVal = await env.DB.prepare("SELECT value, updated_at FROM config WHERE key = 'is_processing'").first();
        
        let scrapeResult = 'not tested';
        try {
          const allCases = await scrapeRecentPage(env.SOURCE_URL);
          scrapeResult = allCases.length + ' cases found';
        } catch (e) {
          scrapeResult = 'SCRAPE FAILED: ' + String(e);
        }
        
        return jsonResponse({
          is_processing: isProc,
          processing_config: procVal,
          last_run_at: lastRun,
          last_error: lastErr,
          scrape: scrapeResult,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        return jsonResponse({ error: String(err), stack: err instanceof Error ? err.stack : '' }, 500);
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ADMIN UI ROUTES (session cookie auth)
    // ══════════════════════════════════════════════════════════════════════════

    // GET /admin/logout — Clear session cookie
    if (request.method === 'GET' && url.pathname === '/admin/logout') {
      return new Response('', {
        status: 302,
        headers: { Location: '/admin', 'Set-Cookie': clearAdminCookie() },
      });
    }

    // GET /admin/logoff — Redirect to /admin/logout (common misspelling)
    if (request.method === 'GET' && url.pathname === '/admin/logoff') {
      return new Response('', {
        status: 302,
        headers: { Location: '/admin/logout' },
      });
    }

    // GET /admin — Show login form or dashboard
    if (request.method === 'GET' && url.pathname === '/admin') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return htmlResponse(adminLoginPage());
      }
      const [subscribers, lastRun, , stats, isPausedConfig] = await Promise.all([
        getAllSubscribers(env.DB),
        getConfig(env.DB, 'last_run_at'),
        getConfig(env.DB, 'last_email_sent_at'),
        getCaseStatistics(env.DB),
        getConfig(env.DB, 'system_paused'),
      ]);
      const isPaused = isPausedConfig === '1';
      const emailNotice = await getConfig(env.DB, 'email_notice');
      const dashboardHtml = getDashboardHtml({
        total_subscribers: subscribers.length,
        active_subscribers: subscribers.filter((s: any) => s.confirmed).length,
        subscribers: subscribers as any[],
        last_run_at: lastRun,
        is_paused: isPaused,
        total_cases: stats.total,
        era_cases: stats.era,
        ec_cases: stats.ec,
        cron_schedule: env.CRON_SCHEDULE,
        timezone: env.TIMEZONE,
        email_notice: emailNotice,
      });
      return htmlResponse(dashboardHtml);
    }

    // POST /admin — Login form submission (rate limited: 10/IP/min)
    if (request.method === 'POST' && url.pathname === '/admin') {
      if (!checkRateLimit(getClientIp(request), 10, 60_000)) {
        return new Response('Too many requests. Please try again later.', { status: 429 });
      }
      const formData = await request.formData();
      const password = (formData.get('password') as string ?? '').trim();
      if (!timingSafeEqual(password, env.ADMIN_SECRET)) {
        return htmlResponse(adminLoginPage('Incorrect password. Please try again.'));
      }
      return new Response('', {
        status: 302,
        headers: {
          Location: '/admin',
          'Set-Cookie': setAdminCookie(env.ADMIN_SECRET),
        },
      });
    }

    // POST /admin/delete-subscriber — Delete a subscriber (cookie-gated)
    if (request.method === 'POST' && url.pathname === '/admin/delete-subscriber') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      const formData = await request.formData();
      const id = parseInt(formData.get('id') as string ?? '', 10);
      if (id) await deleteSubscriber(env.DB, id);
      return new Response('', { status: 302, headers: { Location: '/admin' } });
    }

    // GET /admin/preview-digest?limit=N — Get HTML email preview
    if (request.method === 'GET' && url.pathname === '/admin/preview-digest') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const limit = parseInt(url.searchParams.get('limit') ?? '10', 10);
        const recentCases = await getRecentCases(env.DB, limit);
        const cases: ProcessedCase[] = recentCases
          .filter((r: any) => r.summary && !r.summary.startsWith('(seeded'))
          .map((r: any) => ({
            caseId: r.case_id,
            title: r.title,
            caseUrl: r.case_url,
            pdfUrl: r.pdf_url ?? null,
            member: r.member,
            datePublished: r.date_published,
            category: r.category,
            summary: r.summary,
            processedAt: r.processed_at,
            source: r.source || 'ERA',
          }));

        if (cases.length === 0) {
          return new Response('<p style="color: #999;">No cases available for preview.</p>', {
            headers: { 'Content-Type': 'text/html' }
          });
        }

        const { html } = await buildDigestEmail(cases, env.TIMEZONE, `${env.SITE_URL}/unsubscribe?token=preview-token`);
        return new Response(html, {
          headers: { 'Content-Type': 'text/html' }
        });
      } catch (err) {
        return new Response(`<p style="color: #c00;">Error: ${String(err)}</p>`, {
          status: 500,
          headers: { 'Content-Type': 'text/html' }
        });
      }
    }

    // POST /admin/clear-lock — Clear stuck processing lock
    if (request.method === 'POST' && url.pathname === '/admin/clear-lock') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const now = new Date().toISOString();
        await env.DB.prepare(
          "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('is_processing', '0', ?)"
        ).bind(now).run();
        return new Response(JSON.stringify({ success: true, message: 'Processing lock cleared' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
      }
    }

// POST /admin/set-pause — Pause/resume via form submission
    if (request.method === 'POST' && url.pathname === '/admin/set-pause') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const formData = await request.formData();
        const paused = (formData.get('paused') ?? '0') === '1' ? '1' : '0';
        await env.DB.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))')
          .bind('system_paused', paused)
          .run();
        return new Response('', {
          status: 302,
          headers: { Location: '/admin' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
      }
    }
    // POST /admin/upload-ec-case — Upload EC PDF
    // Supports two modes:
    //   1. Raw binary body (Content-Type: application/pdf) with ?filename=... query param
    //      — preferred for curl batch uploads (avoids Workers UTF-8 FormData corruption)
    //   2. Multipart form (Content-Type: multipart/form-data) — used by dashboard UI
    if (request.method === 'POST' && url.pathname === '/admin/upload-ec-case') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      const diagnostics: Record<string, unknown> = {};
      try {
        const contentType = request.headers.get('Content-Type') ?? '';
        const isRawUpload = contentType.startsWith('application/pdf') || contentType.startsWith('application/octet-stream');

        let arrayBuffer: ArrayBuffer;
        let resolvedFilename: string;
        let title: string | null = null;
        let caseUrl: string | null = null;
        let datePublished: string | null = null;
        let member: string | null = null;
        let category: string | null = null;

        if (isRawUpload) {
          // Raw binary mode — read body directly to avoid Workers FormData UTF-8 corruption
          resolvedFilename = url.searchParams.get('filename') ?? 'upload.pdf';
          arrayBuffer = await request.arrayBuffer();
          // Optional metadata from query params
          title = url.searchParams.get('title');
          member = url.searchParams.get('member');
          datePublished = url.searchParams.get('date_published');
          category = url.searchParams.get('category');
        } else {
          // Multipart form mode (dashboard UI)
          const formData = await request.formData();
          const file = formData.get('file');
          title = formData.get('title') as string | null;
          caseUrl = formData.get('case_url') as string | null;
          datePublished = formData.get('date_published') as string | null;
          member = formData.get('member') as string | null;
          category = formData.get('category') as string | null;

          if (!file) {
            return jsonResponse({ error: 'Missing file in form data', diagnostics }, 400);
          }

          // Derive filename — File.name may be undefined on some CF Workers runtime versions
          const explicitFilename = (formData.get('filename') as string | null) ?? null;
          resolvedFilename =
            (typeof file === 'object' && file !== null && 'name' in file && typeof (file as any).name === 'string' ? (file as any).name : null) ??
            explicitFilename ??
            'upload.pdf';

          // Read bytes — CF Workers may return Blob, File, or a UTF-8-decoded string
          if (typeof file === 'object' && file !== null && 'arrayBuffer' in file) {
            arrayBuffer = await (file as any).arrayBuffer();
          } else {
            // Last resort: wrap in Response (may produce incorrect bytes for binary data)
            arrayBuffer = await new Response(file as BodyInit).arrayBuffer();
          }
        }

        diagnostics.uploadMode = isRawUpload ? 'raw' : 'form';
        diagnostics.filename = resolvedFilename;
        diagnostics.arrayBufferBytes = arrayBuffer.byteLength;

        // Auto-derive PDF URL from filename
        const pdfUrl = `https://www.employmentcourt.govt.nz/assets/Documents/Decisions/${resolvedFilename}`;
        diagnostics.derivedPdfUrl = pdfUrl;

        const pdfFilename = resolvedFilename;
        if (!pdfFilename.toLowerCase().endsWith('.pdf')) {
          return jsonResponse({ error: 'File must be a PDF', diagnostics }, 400);
        }

        // Extract PDF text using Python sidecar (handles CID fonts in EC PDFs)
        let extractedText: string;
        try {
          extractedText = await extractTextWithPython(arrayBuffer, env);
          diagnostics.pdfStrategy = 'python-sidecar';
          diagnostics.pdfTextLength = extractedText.length;
        } catch (extractErr) {
          console.warn(`Python extraction failed, falling back to FlateDecode: ${extractErr}`);
          diagnostics.pdfStrategy = 'fallback-flatedecode';
          const usePdfPassthrough = env.USE_PDF_URL_PASSTHROUGH !== 'false';
          const pdfContent = await getPdfContentFromBytes(arrayBuffer, usePdfPassthrough);
          extractedText = pdfContent.strategy === 'text' ? pdfContent.text : '';
          diagnostics.pdfTextLength = extractedText.length;
        }
        
        // Clean extracted text — strip control/escape characters from CID font extraction
        extractedText = cleanExtractedText(extractedText);
        const pdfContentForSummariser: PdfContent = { strategy: 'text', text: extractedText };

        // Parse case title from filename if not provided
        if (!title) {
          const parsed = parseTitleFromFilename(resolvedFilename);
          title = parsed.title;
          if (!category) category = parsed.citation;
        }

        // Create case listing object for summariser
        const caseListing = {
          caseId: resolvedFilename.replace(/\.pdf$/i, ''),
          title: title || resolvedFilename,
          caseUrl: caseUrl || pdfUrl,
          pdfUrl: pdfUrl,
          member: member || null,
          datePublished: datePublished || new Date().toISOString().split('T')[0],
          category: category || 'Employment Court Appeal',
        };

        // Summarise using Employment Court summariser (pass DB so D1 prompt is used if set)
        const summaryResult = await summariseEmploymentCourtCase(
          caseListing,
          pdfContentForSummariser,
          env.OPENROUTER_API_KEY,
          env.OPENROUTER_MODEL,
          env.DB
        );

        if (!summaryResult.success) {
          return jsonResponse({
            error: `LLM summarisation failed: ${summaryResult.error}`,
            diagnostics,
          }, 500);
        }

        // Override title with parties extracted from LLM summary (more accurate)
        const summaryTitle = extractTitleFromSummary(summaryResult.summary, caseListing.category);
        if (summaryTitle) caseListing.title = summaryTitle;

        // Store in D1
        const now = new Date().toISOString();
        await env.DB.prepare(`
          INSERT OR REPLACE INTO seen_cases
          (pdf_filename, source, title, case_url, member, date_published, category, summary, pdf_url, processed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          pdfFilename,
          'EMPLOYMENT_COURT',
          caseListing.title,
          caseListing.caseUrl,
          caseListing.member,
          caseListing.datePublished,
          caseListing.category,
          summaryResult.summary,
          pdfUrl,
          now
        ).run();

        // Return JSON response with summary preview
        return jsonResponse({
          message: 'EC case uploaded and summarised successfully',
          caseId: caseListing.caseId,
          title: caseListing.title,
          summary: summaryResult.summary,
        }, 200);
      } catch (err) {
        console.error('EC upload error:', err);
        return jsonResponse({
          error: `Upload failed: ${String(err)}`,
          diagnostics,
        }, 500);
      }
    }

    // POST /admin/upload-ec-case-text — Upload EC case via pre-extracted text (JSON body)
    // Accepts { filename, text, title?, member?, date_published?, category? }
    // Preferred for batch processing where text has been extracted locally (e.g. pdfminer)
    // Auth: Bearer token OR cookie (same as upload-ec-case)
    if (request.method === 'POST' && url.pathname === '/admin/upload-ec-case-text') {
      const session = getAdminCookie(request);
      const authHeader2 = request.headers.get('Authorization') ?? '';
      const isAuth = session === env.ADMIN_SECRET || (authHeader2.startsWith('Bearer ') && authHeader2.slice(7) === env.ADMIN_SECRET);
      if (!isAuth) return new Response('Unauthorized', { status: 401 });
      try {
        const body = await request.json() as {
          filename: string;
          text: string;
          title?: string;
          member?: string;
          date_published?: string;
          category?: string;
        };
        if (!body.filename || !body.text) {
          return jsonResponse({ error: 'Missing required fields: filename, text' }, 400);
        }
        const pdfFilename = body.filename;
        const pdfUrl = `https://www.employmentcourt.govt.nz/assets/Documents/Decisions/${pdfFilename}`;
        const pdfContent = { strategy: 'text' as const, text: body.text };
        const caseListing = {
          caseId: pdfFilename.replace(/\.pdf$/i, ''),
          title: body.title || pdfFilename,
          caseUrl: 'https://www.employmentcourt.govt.nz/judgments/decisions/?Filter_Jurisdiction=17',
          pdfUrl,
          member: body.member || null,
          datePublished: body.date_published || new Date().toISOString().split('T')[0],
          category: body.category || 'Employment Court Appeal',
        };
        // Pass DB so D1 prompt is used if set
        const summaryResult = await summariseEmploymentCourtCase(
          caseListing, pdfContent, env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL, env.DB
        );
        if (!summaryResult.success) {
          return jsonResponse({ error: `LLM summarisation failed: ${summaryResult.error}` }, 500);
        }
        // Override title with parties from LLM summary
        const summaryTitle = extractTitleFromSummary(summaryResult.summary, caseListing.category);
        if (summaryTitle) caseListing.title = summaryTitle;
        const now = new Date().toISOString();
        // Use extracted judge name if no member was provided
        const memberField = body.member || summaryResult.judgeName || null;
        await env.DB.prepare(`
          INSERT OR REPLACE INTO seen_cases
          (pdf_filename, source, title, case_url, member, date_published, category, summary, pdf_url, processed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          pdfFilename, 'EMPLOYMENT_COURT',
          caseListing.title, caseListing.caseUrl, memberField,
          caseListing.datePublished, caseListing.category,
          summaryResult.summary, pdfUrl, now
        ).run();
        return jsonResponse({
          message: 'EC case uploaded and summarised successfully',
          caseId: caseListing.caseId,
          title: caseListing.title,
          summary: summaryResult.summary,
        }, 200);
      } catch (err) {
        return jsonResponse({ error: `Upload failed: ${String(err)}` }, 500);
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // DASHBOARD API ROUTES (cookie auth — used by Prompts and Rescan tabs)
    // ══════════════════════════════════════════════════════════════════════════

    // GET /admin/dashboard/get-prompts — Load current LLM prompts from D1 config
    if (request.method === 'GET' && url.pathname === '/admin/dashboard/get-prompts') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const [promptEra, promptEc] = await Promise.all([
          getConfig(env.DB, 'prompt_era'),
          getConfig(env.DB, 'prompt_ec'),
        ]);
        return jsonResponse({ prompt_era: promptEra || '', prompt_ec: promptEc || '' });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // POST /admin/dashboard/update-prompts — Save LLM prompts to D1 config (with version history)
    if (request.method === 'POST' && url.pathname === '/admin/dashboard/update-prompts') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const formData = await request.formData();
        const promptEra = (formData.get('prompt_era') as string ?? '').trim();
        const promptEc = (formData.get('prompt_ec') as string ?? '').trim();
        // savePromptWithHistory archives the current value before overwriting
        if (promptEra) await savePromptWithHistory(env.DB, 'prompt_era', promptEra);
        if (promptEc)  await savePromptWithHistory(env.DB, 'prompt_ec',  promptEc);
        return jsonResponse({ success: true, message: 'Prompts saved' });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // GET /admin/dashboard/prompt-versions — Return version history for a prompt key
    if (request.method === 'GET' && url.pathname === '/admin/dashboard/prompt-versions') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const key = url.searchParams.get('key') as 'prompt_era' | 'prompt_ec' | null;
        if (key !== 'prompt_era' && key !== 'prompt_ec') {
          return jsonResponse({ error: 'key must be prompt_era or prompt_ec' }, 400);
        }
        const versions = await getPromptVersions(env.DB, key);
        // Return id, saved_at, and a short preview (first 100 chars) to keep response small
        return jsonResponse({
          versions: versions.map(v => ({
            id: v.id,
            saved_at: v.saved_at,
            preview: v.content.slice(0, 100).replace(/\n/g, ' ') + (v.content.length > 100 ? '…' : ''),
          })),
        });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // POST /admin/dashboard/revert-prompt — Revert a prompt to a specific version
    if (request.method === 'POST' && url.pathname === '/admin/dashboard/revert-prompt') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const body = await request.json() as { key?: string; version_id?: number };
        const key = body?.key as 'prompt_era' | 'prompt_ec' | undefined;
        const versionId = body?.version_id;
        if (key !== 'prompt_era' && key !== 'prompt_ec') {
          return jsonResponse({ error: 'key must be prompt_era or prompt_ec' }, 400);
        }
        if (!versionId || typeof versionId !== 'number') {
          return jsonResponse({ error: 'version_id must be a number' }, 400);
        }
        const ok = await revertPromptToVersion(env.DB, key, versionId);
        if (!ok) return jsonResponse({ error: 'Version not found' }, 404);
        return jsonResponse({ success: true, message: `Prompt reverted to version ${versionId}` });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // POST /admin/dashboard/rescan-cases — Delete last N cases and reprocess
    if (request.method === 'POST' && url.pathname === '/admin/dashboard/rescan-cases') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '5', 10), 50);
        const body = await request.json() as { send_email?: boolean } | null;
        const sendEmail = body?.send_email ?? false;

        // Get the N most recent cases (to know what we deleted)
        const recentCases = await getRecentCases(env.DB, limit);

        if (recentCases.length === 0) {
          return jsonResponse({ error: 'No cases to rescan', deleted: 0 }, 400);
        }

        // Delete them from seen_cases using their composite keys
        for (const c of recentCases) {
          await env.DB.prepare(
            'DELETE FROM seen_cases WHERE source = ? AND pdf_filename = ?'
          ).bind(c.source, c.pdf_filename).run();
        }

        // Reset last_era_id to a point below the deleted cases so the next
        // internal-index probe will re-find them. Extract era_case_id from
        // each case's case_url (e.g. /determination/view/21324 → 21324).
        let minEraId = Infinity;
        for (const c of recentCases) {
          const match = c.case_url.match(/\/determination\/view\/(\d+)/);
          if (match) {
            const id = parseInt(match[1], 10);
            if (id < minEraId) minEraId = id;
          }
        }
        const resetTo = minEraId !== Infinity ? Math.max(minEraId - 1, 0) : 21299;
        await setConfig(env.DB, 'last_era_id', String(resetTo));
        console.log(`Rescan: reset last_era_id to ${resetTo} for reprocessing`);

        // Trigger pipeline — always reprocess rescanned cases
        if (sendEmail && recentCases.length > 0) {
          await setConfig(env.DB, 'email_notice',
            `Updated summaries for ${recentCases.length} recently rescanned case(s) (new prompt applied).`
          );
        }
        // Fire-and-forget the pipeline (reprocesses deleted cases from the ERA listing)
        if (recentCases.length > 0) {
          ctx.waitUntil(runDigest(env, true, limit));
        }

        return jsonResponse({
          success: true,
          deleted: recentCases.length,
          send_email: sendEmail,
          message: sendEmail
            ? `Deleted ${recentCases.length} cases, setting notice banner and triggering pipeline.`
            : `Deleted ${recentCases.length} cases and triggered silent reprocessing. Check results on the home page.`,
        });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // POST /admin/dashboard/rescan-by-ids — Delete specific cases by ERA ID and reprocess
    if (request.method === 'POST' && url.pathname === '/admin/dashboard/rescan-by-ids') {
      if (!isAuthenticated(request, env)) return new Response('Unauthorized', { status: 401 });
      try {
        const idsParam = url.searchParams.get('ids') ?? '';
        const ids = idsParam.split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)).map(Number);
        if (ids.length === 0) return jsonResponse({ error: 'No valid ERA IDs provided. Use ?ids=21324,21325' }, 400);
        if (ids.length > 20) return jsonResponse({ error: 'Maximum 20 IDs at a time.' }, 400);

        // Find matching cases by extracting ID from case_url
        const allCases = await env.DB.prepare(
          "SELECT source, pdf_filename, case_url FROM seen_cases WHERE source = 'ERA'"
        ).all<{source: string; pdf_filename: string; case_url: string}>();
        const toDelete = allCases.results.filter(c => {
          return ids.some(id => c.case_url?.includes(`/view/${id}`));
        });

        if (toDelete.length === 0) {
          return jsonResponse({ error: `No seen_cases matched ERA IDs: ${ids.join(', ')}` }, 404);
        }

        // Delete matched cases
        for (const c of toDelete) {
          await env.DB.prepare('DELETE FROM seen_cases WHERE source = ? AND pdf_filename = ?')
            .bind(c.source, c.pdf_filename).run();
        }

        // Find the min ERA ID among deleted and reset last_era_id
        let minId = Infinity;
        for (const c of toDelete) {
          for (const id of ids) {
            if (c.case_url?.includes(`/view/${id}`) && id < minId) minId = id;
          }
        }
        const resetTo = minId !== Infinity ? Math.max(minId - 1, 0) : 1;
        await setConfig(env.DB, 'last_era_id', String(resetTo));
        console.log(`Rescan-IDs: reset last_era_id to ${resetTo}, deleted ${toDelete.length} cases`);

        // Fire-and-forget pipeline
        ctx.waitUntil(runDigest(env, true, ids.length));

        return jsonResponse({
          success: true,
          deleted: toDelete.length,
          ids: ids,
          message: `Deleted ${toDelete.length} case(s) (IDs: ${ids.join(', ')}). Pipeline triggered for reprocessing. Existing summaries will be regenerated.`,
        });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // POST /admin/dashboard/resummarise-selected
    //
    // Re-summarises specific cases by pdf_filename without deleting them first.
    // Uses the upload-era-url overwrite pattern (UPDATE, not DELETE+re-scrape).
    // Processes cases synchronously, one by one, and returns per-case results.
    //
    // Body: { "pdfFilenames": ["2026-NZERA-379.pdf", "2026-NZERA-326.pdf"] }
    // Max 20 per call.
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/admin/dashboard/resummarise-selected') {
      if (!isAuthenticated(request, env)) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const body = await request.json() as { pdfFilenames?: string[] } | null;
        const pdfFilenames = body?.pdfFilenames ?? [];
        if (pdfFilenames.length === 0) {
          return jsonResponse({ error: 'No pdf_filenames provided.' }, 400);
        }
        if (pdfFilenames.length > 20) {
          return jsonResponse({ error: 'Maximum 20 cases per call.' }, 400);
        }

        // Look up case metadata for all requested files
        const placeholders = pdfFilenames.map(() => '?').join(',');
        const cases = await env.DB.prepare(
          `SELECT pdf_filename, pdf_url, case_url, title, member, date_published, category
           FROM seen_cases WHERE source = 'ERA' AND pdf_filename IN (${placeholders})`
        ).bind(...pdfFilenames).all<{
          pdf_filename: string; pdf_url: string; case_url: string;
          title: string; member: string | null;
          date_published: string | null; category: string | null;
        }>();

        const results: { pdfFilename: string; success: boolean; error?: string }[] = [];
        let processed = 0;
        let failed = 0;

        for (const c of cases.results) {
          try {
            if (!c.pdf_url) {
              results.push({ pdfFilename: c.pdf_filename, success: false, error: 'No PDF URL' });
              failed++;
              continue;
            }

            const pdfContent = await getPdfContent(c.pdf_url);
            const caseListing: CaseListing = {
              caseId: c.pdf_filename.replace(/\.pdf$/i, ''),
              title: c.title,
              caseUrl: c.case_url,
              pdfUrl: c.pdf_url,
              member: c.member,
              datePublished: c.date_published,
              category: c.category,
            };
            const summaryResult = await summariseCase(
              caseListing, pdfContent, env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL, env.DB
            );
            if (!summaryResult.success) {
              results.push({ pdfFilename: c.pdf_filename, success: false, error: summaryResult.error ?? 'Summarisation failed' });
              failed++;
              continue;
            }

            const { awardsData, strippedSummary } = parseAwardsBlock(summaryResult.summary);
            const betterTitle = extractTitleFromSummary(strippedSummary, c.category);

            // Update the existing row (preserve member via COALESCE)
            await env.DB.prepare(
              `UPDATE seen_cases SET title=?, summary=?, member=COALESCE(?, member), category=?,
               processed_at=?, paragraph_count=?
               WHERE source='ERA' AND pdf_filename=?`
            ).bind(
              betterTitle || c.title, strippedSummary, c.member,
              c.category, new Date().toISOString(),
              summaryResult.paragraphCount ?? null, c.pdf_filename
            ).run();

            // Store awards data if extracted
            if (awardsData) {
              await insertCaseAward(env.DB, c.pdf_filename, 'ERA', awardsData, 'prompt_structured')
                .catch(e => console.warn(`Resummarise-selected: failed to insert awards for ${c.pdf_filename}: ${e}`));
            }

            results.push({ pdfFilename: c.pdf_filename, success: true });
            processed++;
          } catch (err) {
            results.push({ pdfFilename: c.pdf_filename, success: false, error: String(err) });
            failed++;
          }
        }

        return jsonResponse({
          success: true,
          processed,
          failed,
          results,
          message: `Re-summarised ${processed} case(s)${failed > 0 ? `, ${failed} failed` : ''}.`,
        });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // POST /admin/dashboard/backfill-era
    //
    // Option A — Multi-page ERA backfill (added 8 June 2026).
    // Scrapes the ERA recent determinations listing across multiple pages
    // (up to 30 cases from the last ~10 days) and silently processes any cases
    // that are not yet in seen_cases.  No email is sent — this is a pure
    // archive-population operation.
    //
    // Query params:
    //   pages  — Number of ERA listing pages to scrape (1–3, default 3)
    //
    // Each page uses ?start=N offset (0, 10, 20…) on the ERA listing URL.
    // Deduplication is handled by filterNewCases (seen_cases composite key).
    // Cases are marked as seen immediately after each successful summarisation
    // (unlike the normal cron run, which only marks after email dispatch — there
    // is no email here, so immediate commit is correct).
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/admin/dashboard/backfill-era') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const pages = Math.min(Math.max(parseInt(url.searchParams.get('pages') ?? '3', 10), 1), 5);

        console.log(`ERA Backfill: scraping ${pages} page(s) of ERA listings`);

        const allScraped = await scrapeAllPages(pages, env.SOURCE_URL);
        console.log(`ERA Backfill: ${allScraped.length} unique cases scraped across ${pages} page(s)`);

        const newCases = await filterNewCases(env.DB, allScraped);
        console.log(`ERA Backfill: ${newCases.length} new (unseen) cases to process`);

        // Process at most 1 case synchronously (stay within Worker time limits)
        const batch = newCases.slice(0, 1);
        let processed = 0;
        let failed = 0;
        let lastError: string | null = null;

        for (const c of batch) {
          console.log(`ERA Backfill: processing ${c.caseId} — ${c.title}`);
          try {
            if (!c.pdfUrl) {
              console.warn(`ERA Backfill: skipping ${c.caseId} — no PDF URL`);
              failed++;
              continue;
            }

            const pdfContent = await getPdfContent(c.pdfUrl);
            const summaryResult = await summariseCase(c, pdfContent, env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL, env.DB);
            if (!summaryResult.success) {
              console.warn(`ERA Backfill: summarisation failed for ${c.caseId}`);
              failed++;
              continue;
            }

            // Strip AWARDS_DATA block before storing
            const { awardsData, strippedSummary } = parseAwardsBlock(summaryResult.summary);
            const betterTitle = extractTitleFromSummary(strippedSummary, c.category);
            const processedCase: ProcessedCase = {
              ...c,
              title: betterTitle || c.title,
              summary: strippedSummary,
              processedAt: new Date().toISOString(),
              source: 'ERA',
            };

            // Mark as seen immediately — no email to wait for
            await markCaseSeen(env.DB, processedCase, 'ERA');

            // Store awards data if extracted
            if (awardsData && c.pdfUrl) {
              const pdfFilename = c.pdfUrl.split('/').pop() ?? '';
              if (pdfFilename) {
                await insertCaseAward(env.DB, pdfFilename, 'ERA', awardsData, 'prompt_structured')
                  .catch(e => console.warn(`ERA Backfill: failed to insert awards for ${pdfFilename}: ${e}`));
              }
            }

            processed++;
            console.log(`ERA Backfill: stored ${c.caseId} (${betterTitle || c.title})`);
          } catch (err) {
            lastError = `ERA Backfill: error processing ${c.caseId}: ${err}`;
            console.error(lastError);
            try {
              await env.DB.prepare(
                "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('last_error', ?, datetime('now'))"
              ).bind(lastError.substring(0, 500)).run();
            } catch (_) {}

            // Mark unreadable cases as seen so they don't block future runs
            const errStr = String(err);
            if (errStr.includes('insufficient content') || errStr.includes('404') || errStr.includes('unreachable')) {
              try {
                const fallbackCase: ProcessedCase = {
                  caseId: c.caseId, title: c.title, caseUrl: c.caseUrl,
                  pdfUrl: c.pdfUrl, member: c.member, datePublished: c.datePublished,
                  category: c.category, source: 'ERA',
                  summary: `Summary unavailable — the determination text could not be extracted from the PDF. [View determination](${c.caseUrl})`,
                  processedAt: new Date().toISOString(),
                };
                await markCaseSeen(env.DB, fallbackCase, 'ERA');
                console.warn(`ERA Backfill: marked ${c.caseId} as seen (unreadable PDF)`);
              } catch (_) {}
            }

            failed++;
          }
        }

        console.log(`ERA Backfill done: ${processed} processed, ${failed} failed`);
        return jsonResponse({
          success: true,
          pages_scraped: pages,
          found: allScraped.length,
          new_cases: newCases.length,
          processed,
          failed,
          message: processed > 0
            ? `Processed ${processed} case(s).`
            : newCases.length === 0
              ? `No new cases found — all ${allScraped.length} cases already in DB.`
              : `Processed 0 (${failed} failed) — try pages=1 and check /diag for errors.`,
        });
      } catch (err) {
        console.error(`ERA Backfill error: ${err}`);
        return jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // POST /admin/dashboard/backfill-awards
    //
    // Extracts structured awards data from existing ERA summaries that have no
    // entry in case_awards. Sends each summary to the LLM with a short targeted
    // extraction prompt asking for JSON. Inserts results into case_awards.
    //
    // Query params:
    //   limit  — Max cases to process per call (default 50, max 200)
    //
    // This is safe to call multiple times — it skips cases already extracted.
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/admin/dashboard/backfill-awards') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
        const cases = await getCasesWithoutAwards(env.DB, 'ERA');
        const toProcess = cases.slice(0, limit);

        if (toProcess.length === 0) {
          return jsonResponse({ success: true, processed: 0, failed: 0, message: 'All ERA cases already have awards data extracted.' });
        }

        const EXTRACTION_PROMPT = `You are a data extractor. From the employment case summary below, extract remedy and award information.

Return ONLY a valid JSON object with these exact keys (no other text, no markdown fences):
{
  "hhd_amount": null or integer (NZD dollars for hurt/humiliation/distress award — NOT total compensation),
  "lost_wages": null or integer (NZD dollars total for lost wages or wage compensation),
  "weekly_wage": null or integer (NZD weekly wage if stated anywhere in the summary),
  "lost_wages_weeks": null or number (weeks of salary the lost wages figure represents, if explicitly stated),
  "costs_awarded": null or integer (NZD costs order if any),
  "reinstatement": false or true,
  "outcome": "applicant" or "respondent" or "mixed" or "none",
  "decision_date": null or string (decision date in YYYY-MM-DD format if stated),
  "employment_tenure": null or string (duration of employment if stated, e.g. "2.5 years" or "6 months"),
  "contribution_applied": false or true (whether the Authority reduced any remedy due to contributory conduct),
  "contribution_reduction": null or string (percentage reduction if stated, e.g. "25%", or calculated as "25% (calculated)"),
  "contribution_conduct": null or string (brief description of the conduct justifying the reduction),
  "penalties": null or integer (total statutory penalties ordered against the respondent in NZD)
}

Rules:
- Look in the REMEDY and OUTCOME sections
- HHD = hurt, humiliation and distress (also called personal grievance compensation)
- "outcome: applicant" means the employee/applicant succeeded; "respondent" means the employer succeeded
- Use null (not 0) for amounts that are explicitly not awarded, nil, or not stated
- Numbers must be plain integers — no $ signs, no commas
- Return ONLY the raw JSON object`;

        let processed = 0;
        let failed = 0;

        for (const c of toProcess) {
          try {
            const pdfFilename = c.pdf_filename;
            if (!pdfFilename || !c.summary) { failed++; continue; }

            // Call LLM for extraction
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000);
            let jsonText: string;
            try {
              const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                signal: controller.signal,
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
                  'HTTP-Referer': 'https://whenroutinebiteshard.com',
                  'X-Title': 'ERA Digest Awards Extraction',
                },
                body: JSON.stringify({
                  model: env.OPENROUTER_MODEL,
                  messages: [
                    { role: 'system', content: EXTRACTION_PROMPT },
                    { role: 'user', content: c.summary },
                  ],
                  max_tokens: 300,
                }),
              });
              clearTimeout(timeoutId);
              const json = await resp.json() as { choices?: Array<{ message: { content: string } }>; error?: { message: string } };
              if (!resp.ok || json.error) throw new Error(json.error?.message ?? `HTTP ${resp.status}`);
              jsonText = json.choices?.[0]?.message?.content?.trim() ?? '';
            } finally {
              clearTimeout(timeoutId);
            }

            // Robustly extract JSON from response (handles trailing text or code fences)
            const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error(`No JSON in response: ${jsonText.slice(0, 100)}`);
            const data = JSON.parse(jsonMatch[0]) as {
              hhd_amount?: number | null;
              lost_wages?: number | null;
              weekly_wage?: number | null;
              lost_wages_weeks?: number | null;
              costs_awarded?: number | null;
              reinstatement?: boolean;
              outcome?: string | null;
            };

            // Derive weeks if not stated but both salary figures available
            let weeksCalc = (typeof data.lost_wages_weeks === 'number') ? data.lost_wages_weeks : null;
            if (!weeksCalc && data.lost_wages && data.weekly_wage && data.weekly_wage > 0) {
              weeksCalc = Math.round((data.lost_wages / data.weekly_wage) * 10) / 10;
            }

            await insertCaseAward(env.DB, pdfFilename, 'ERA', {
              hhd_amount: typeof data.hhd_amount === 'number' ? data.hhd_amount : null,
              lost_wages: typeof data.lost_wages === 'number' ? data.lost_wages : null,
              weekly_wage: typeof data.weekly_wage === 'number' ? data.weekly_wage : null,
              lost_wages_weeks: weeksCalc,
              costs_awarded: typeof data.costs_awarded === 'number' ? data.costs_awarded : null,
              reinstatement: data.reinstatement === true,
              outcome: (data.outcome as string | null) ?? null,
            }, 'llm_backfill');

            processed++;
            console.log(`Awards backfill: extracted data for ${pdfFilename}`);
          } catch (err) {
            console.error(`Awards backfill: failed for ${c.pdf_filename}: ${err}`);
            failed++;
          }
        }

        return jsonResponse({
          success: true,
          found: cases.length,
          processed,
          failed,
          message: processed > 0
            ? `Extracted awards data for ${processed} case(s). ${failed > 0 ? `${failed} failed.` : ''}`
            : `No cases processed. ${failed > 0 ? `${failed} failed.` : ''}`,
        });
      } catch (err) {
        console.error(`Awards backfill error: ${err}`);
        return jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // POST /admin/dashboard/scrape-id-range
    //
    // Scrapes ERA cases by internal ID range. Probes each ID in [start_id, end_id]
    // using scrapeEraDetailPage(). Processes unseen cases.
    //
    // Query params:
    //   start_id  — First ERA ID to probe (default: latest known - 50)
    //   end_id    — Last ERA ID to probe (default: latest known)
    //               When start_id == end_id, scrapes a single case.
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/admin/dashboard/scrape-id-range') {
      if (!isAuthenticated(request, env)) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const rawEnd = url.searchParams.get('end_id');
        const rawStart = url.searchParams.get('start_id');
        // Default: probe near latest known ID
        const lastIdRaw = await getConfig(env.DB, 'last_era_id');
        const lastKnown = lastIdRaw ? parseInt(lastIdRaw, 10) : 21324;
        const endId = rawEnd ? parseInt(rawEnd, 10) : lastKnown;
        const startId = rawStart ? parseInt(rawStart, 10) : Math.max(endId - 49, 1);
        if (isNaN(startId) || isNaN(endId) || startId > endId || startId < 1) {
          return jsonResponse({ error: 'Invalid ID range. start_id must be <= end_id and >= 1.' }, 400);
        }
        const total = endId - startId + 1;
        console.log(`ERA ID Scrape: probing ${startId}–${endId} (${total} IDs)`);

        // Probe in batches of 5, stop after 3 consecutive misses in the last batch
        const BATCH = 5;
        const allCases: import('./types').CaseListing[] = [];
        let consecutiveMisses = 0;
        let probeCount = 0;
        for (let id = startId; id <= endId && consecutiveMisses < 3; id += BATCH) {
          const batchIds = Array.from({ length: BATCH }, (_, i) => id + i).filter(i => i <= endId);
          const batchResults = await Promise.all(
            batchIds.map(i => scrapeEraDetailPage(i).catch(() => null))
          );
          probeCount += batchIds.length;
          let batchHits = 0;
          for (const detail of batchResults) {
            if (detail) { allCases.push(detail); batchHits++; }
          }
          consecutiveMisses = batchHits === 0 ? consecutiveMisses + 1 : 0;
        }

        // Filter to new cases
        const newCases = await filterNewCases(env.DB, allCases);
        console.log(`ERA ID Scrape: ${allCases.length} found, ${newCases.length} new, ${probeCount} probes`);

        // Process up to 5 cases synchronously
        const batch = newCases.slice(0, 5);
        let processed = 0;
        let failed = 0;
        let lastError: string | null = null;

        for (const c of batch) {
          try {
            if (!c.pdfUrl) { failed++; continue; }
            const pdfContent = await getPdfContent(c.pdfUrl);
            const summaryResult = await summariseCase(c, pdfContent, env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL, env.DB);
            if (!summaryResult.success) { failed++; continue; }
            const { awardsData, strippedSummary } = parseAwardsBlock(summaryResult.summary);
            const betterTitle = extractTitleFromSummary(strippedSummary, c.category);
            await markCaseSeen(env.DB, {
              ...c, title: betterTitle || c.title, summary: strippedSummary,
              processedAt: new Date().toISOString(), source: 'ERA',
            }, 'ERA');
            if (awardsData && c.pdfUrl) {
              const pdfFilename = c.pdfUrl.split('/').pop() ?? '';
              if (pdfFilename) {
                await insertCaseAward(env.DB, pdfFilename, 'ERA', awardsData, 'prompt_structured')
                  .catch(e => console.warn(`Awards insert failed: ${e}`));
              }
            }
            processed++;
          } catch (err) {
            console.error(`ID scrape failed for ${c.caseId}: ${err}`);
            lastError = String(err);
            failed++;
          }
        }

        // Update last_era_id to highest probed ID
        const newLastId = Math.max(startId, endId);
        await setConfig(env.DB, 'last_era_id', String(newLastId));

        return jsonResponse({
          success: true, probed: probeCount, found: allCases.length, new: newCases.length,
          processed, failed, last_error: lastError,
          cases: allCases.map(c => ({ title: c.title, era_id: c.caseId })),
          message: processed > 0
            ? `Processed ${processed} case(s). ${failed > 0 ? `${failed} failed.` : ''}`
            : newCases.length > 0 ? `Found ${newCases.length} new case(s) but none processed.` : 'No new cases found.',
        });
      } catch (err) {
        console.error(`ERA ID Scrape error: ${err}`);
        return jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // POST /admin/dashboard/scrape-date-range
    //
    // Scrapes ERA recent listing pages to find cases within a date window.
    // Uses the older /recent pagination approach.
    //
    // Query params:
    //   date_from  — Start date (YYYY-MM-DD, default: 7 days ago)
    //   date_to    — End date (YYYY-MM-DD, default: today)
    //   pages      — Max listing pages to scan (1–10, default: 5)
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/admin/dashboard/scrape-date-range') {
      if (!isAuthenticated(request, env)) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const pages = Math.min(Math.max(parseInt(url.searchParams.get('pages') ?? '5', 10), 1), 10);
        const dateFrom = url.searchParams.get('date_from');
        const dateTo = url.searchParams.get('date_to');

        console.log(`ERA Date Scrape: scanning ${pages} page(s) for dates ${dateFrom ?? '7d ago'}–${dateTo ?? 'today'}`);

        const allScraped = await scrapeAllPages(pages, env.SOURCE_URL);

        // Filter by date range if provided
        let filtered = allScraped;
        if (dateFrom) {
          const from = new Date(dateFrom);
          filtered = filtered.filter(c => c.datePublished && new Date(c.datePublished) >= from);
        }
        if (dateTo) {
          const to = new Date(dateTo);
          to.setHours(23, 59, 59, 999);
          filtered = filtered.filter(c => c.datePublished && new Date(c.datePublished) <= to);
        }

        console.log(`ERA Date Scrape: ${allScraped.length} scraped, ${filtered.length} in date range`);
        const newCases = await filterNewCases(env.DB, filtered);
        console.log(`ERA Date Scrape: ${newCases.length} new cases to process`);

        // Process up to 3 cases
        const batch = newCases.slice(0, 3);
        let processed = 0;
        let failed = 0;
        let lastError: string | null = null;

        for (const c of batch) {
          try {
            if (!c.pdfUrl) { failed++; continue; }
            const pdfContent = await getPdfContent(c.pdfUrl);
            const summaryResult = await summariseCase(c, pdfContent, env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL, env.DB);
            if (!summaryResult.success) { failed++; continue; }
            const { awardsData, strippedSummary } = parseAwardsBlock(summaryResult.summary);
            const betterTitle = extractTitleFromSummary(strippedSummary, c.category);
            await markCaseSeen(env.DB, {
              ...c, title: betterTitle || c.title, summary: strippedSummary,
              processedAt: new Date().toISOString(), source: 'ERA',
            }, 'ERA');
            if (awardsData && c.pdfUrl) {
              const pdfFilename = c.pdfUrl.split('/').pop() ?? '';
              if (pdfFilename) {
                await insertCaseAward(env.DB, pdfFilename, 'ERA', awardsData, 'prompt_structured')
                  .catch(e => console.warn(`Awards insert failed: ${e}`));
              }
            }
            processed++;
          } catch (err) {
            console.error(`Date scrape failed for ${c.caseId}: ${err}`);
            lastError = String(err);
            failed++;
          }
        }

        return jsonResponse({
          success: true, scraped: allScraped.length, in_range: filtered.length, new: newCases.length,
          processed, failed, last_error: lastError,
        });
      } catch (err) {
        console.error(`ERA Date Scrape error: ${err}`);
        return jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // POST /admin/dashboard/upload-era-pdf
    //
    // Bulk ERA PDF upload. Accepts multipart form with PDF file(s).
    // Metadata is derived from the PDF filename (citation pattern).
    // Files are processed sequentially — one at a time.
    //
    // Request: multipart/form-data with field "files" (one or more PDFs)
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/admin/dashboard/upload-era-pdf') {
      if (!isAuthenticated(request, env)) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const formData = await request.formData();
        const pdfFiles: File[] = [];
        for (const entry of formData.entries()) {
          const val = entry[1] as any;
          if (typeof val !== 'string' && val.name && val.name.endsWith('.pdf')) {
            pdfFiles.push(val as File);
          }
        }

        if (pdfFiles.length === 0) {
          return jsonResponse({ error: 'No PDF files found in upload. Use field name "files".' }, 400);
        }

        console.log(`ERA PDF Upload: ${pdfFiles.length} file(s) received`);
        let processed = 0;
        let failed = 0;
        const details: Array<{ filename: string; success: boolean; title?: string; error?: string }> = [];

        for (const file of pdfFiles) {
          try {
            const pdfFilename = file.name;
            // Derive metadata from filename
            const caseId = pdfFilename.replace(/\.pdf$/i, '');
            const citMatch = pdfFilename.match(/^(\d{4})-([A-Z]+)-(\d+)\.pdf$/i);
            const category = citMatch
              ? `[${citMatch[1]}] ${citMatch[2].toUpperCase()} ${citMatch[3]}`
              : null;

            // Check if already in DB
            const existing = await env.DB.prepare(
              "SELECT summary FROM seen_cases WHERE source = 'ERA' AND pdf_filename = ?"
            ).bind(pdfFilename).first<{summary: string}>();
            if (existing) {
              details.push({ filename: pdfFilename, success: false, error: 'Already exists in database' });
              failed++;
              continue;
            }

            // Read file bytes
            const pdfBytes = await file.arrayBuffer();
            const pdfContent = await getPdfContentFromBytes(pdfBytes as ArrayBuffer, (env as any).USE_PDF_URL_PASSTHROUGH !== 'false');

            // Build case listing from filename
            const caseListing: import('./types').CaseListing = {
              caseId, title: pdfFilename.replace(/\.pdf$/i, '').replace(/-/g, ' '),
              caseUrl: `https://determinations.era.govt.nz/determination/view/${caseId}`,
              pdfUrl: null, member: null, datePublished: null, category,
            };

            const summaryResult = await summariseCase(caseListing, pdfContent, env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL, env.DB);
            if (!summaryResult.success) {
              details.push({ filename: pdfFilename, success: false, error: String(summaryResult.error ?? 'Unknown error') });
              failed++;
              continue;
            }

            const { awardsData, strippedSummary } = parseAwardsBlock(summaryResult.summary);
            const betterTitle = extractTitleFromSummary(strippedSummary, category);
            await markCaseSeen(env.DB, {
              ...caseListing, title: betterTitle || caseListing.title, summary: strippedSummary,
              processedAt: new Date().toISOString(), source: 'ERA',
            }, 'ERA');

            if (awardsData) {
              await insertCaseAward(env.DB, pdfFilename, 'ERA', awardsData, 'prompt_structured')
                .catch(e => console.warn(`Awards insert failed: ${e}`));
            }

            details.push({ filename: pdfFilename, success: true, title: betterTitle || caseListing.title });
            processed++;
          } catch (err) {
            console.error(`ERA PDF upload failed for ${file.name}: ${err}`);
            details.push({ filename: file.name, success: false, error: String(err) });
            failed++;
          }
        }

        return jsonResponse({
          success: true, total: pdfFiles.length, processed, failed, details,
        });
      } catch (err) {
        console.error(`ERA PDF Upload error: ${err}`);
        return jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // POST /admin/dashboard/upload-era-url
    //
    // Option C — Manual ERA case URL upload (added 8 June 2026).
    // Allows a single ERA case to be processed by pasting its PDF URL into
    // the admin dashboard.  Designed for cases that are no longer on the ERA
    // recent listing (older than ~10 days) and cannot be recovered via the
    // auto-scrape backfill above.
    //
    // Request body (JSON):
    //   { pdfUrl: string }   — Full URL to the ERA PDF
    //                          e.g. https://determinations.era.govt.nz/assets/elawpdf/2026/2026-NZERA-225.pdf
    //
    // Metadata is derived automatically from the URL:
    //   pdfFilename  — last segment of the URL path
    //   category     — citation inferred from filename (e.g. "[2026] NZERA 225")
    //   caseId       — filename without .pdf extension
    //
    // The ERA listing page URL is used as caseUrl (the "View case summary" link
    // in emails) since we don't know the integer detail-page ID from the PDF URL.
    //
    // No email is sent — this is a silent archive-population operation.
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/admin/dashboard/upload-era-url') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const body = await request.json() as { pdfUrl?: string; eraId?: number; updateTitle?: boolean; overwrite?: boolean } | null;
        const pdfUrl = body?.pdfUrl?.trim();
        const eraId = body?.eraId ? Number(body.eraId) : null;

        if (!pdfUrl) {
          return jsonResponse({ error: 'Missing required field: pdfUrl' }, 400);
        }

        // Validate it looks like an ERA PDF URL
        if (!pdfUrl.match(/determinations\.era\.govt\.nz.*\.pdf$/i)) {
          return jsonResponse({
            error: 'URL does not appear to be an ERA PDF. Expected: https://determinations.era.govt.nz/assets/elawpdf/YYYY/YYYY-NZERA-NNN.pdf',
          }, 400);
        }

        // Derive metadata from URL
        const pdfFilename = pdfUrl.split('/').pop() ?? 'unknown.pdf';
        const caseId = pdfFilename.replace(/\.pdf$/i, '');

        // Infer citation from filename pattern like "2026-NZERA-225.pdf" → "[2026] NZERA 225"
        const citMatch = pdfFilename.match(/^(\d{4})-([A-Z]+)-(\d+)\.pdf$/i);
        const category = citMatch
          ? `[${citMatch[1]}] ${citMatch[2].toUpperCase()} ${citMatch[3]}`
          : null;

        // If eraId is provided, scrape the ERA detail page for proper metadata
        let titleFromScrape: string | null = null;
        let memberFromScrape: string | null = null;
        let dateFromScrape: string | null = null;
        let caseUrl: string | null = null;
        if (eraId && eraId > 0) {
          try {
            const detail = await scrapeEraDetailPage(eraId);
            if (detail) {
              titleFromScrape = detail.title;
              memberFromScrape = detail.member;
              dateFromScrape = detail.datePublished;
              caseUrl = detail.caseUrl;
            }
          } catch (err) {
            console.warn(`ERA URL Upload: failed to scrape detail page for eraId=${eraId}: ${err}`);
          }
        }

        // If only updating title (updateTitle=true), skip summarisation
        const updateOnly = body?.updateTitle === true;
        if (updateOnly && titleFromScrape) {
          await env.DB.prepare(
            "UPDATE seen_cases SET title=?, member=?, case_url=? WHERE source='ERA' AND pdf_filename=?"
          ).bind(titleFromScrape, memberFromScrape, caseUrl, pdfFilename).run();
          return jsonResponse({
            success: true, pdfFilename, title: titleFromScrape,
            message: `Title updated to: ${titleFromScrape}`,
          });
        }

        // Check if already in seen_cases — allow overwriting placeholder summaries
        const existingRow = await env.DB.prepare(
          "SELECT summary, member FROM seen_cases WHERE source = 'ERA' AND pdf_filename = ?"
        ).bind(pdfFilename).first<{summary: string; member: string | null}>();

        const isPlaceholder = existingRow
          ? (existingRow.summary ?? '').startsWith('(seeded')
          : false;
        const overwrite = body?.overwrite === true;

        if (existingRow && !isPlaceholder && !overwrite) {
          return jsonResponse({
            success: false,
            already_exists: true,
            message: `Case ${pdfFilename} is already in the database.`,
          });
        }

        // Build a CaseListing with what we know
        const caseListing = {
          caseId,
          title: titleFromScrape ?? category ?? caseId,
          caseUrl: caseUrl ?? env.SOURCE_URL,
          pdfUrl,
          member: memberFromScrape,
          datePublished: dateFromScrape,
          category,
        };

        // Download and extract PDF using Strategy B (FlateDecode — works for all ERA PDFs)
        const pdfContent = await getPdfContent(pdfUrl);
        
        // Summarise with ERA prompt (read from D1 at runtime)
        const summaryResult = await summariseCase(
          caseListing, pdfContent, env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL, env.DB
        );

        if (!summaryResult.success) {
          const errMsg = summaryResult.error || 'Summarisation failed or returned empty result';
          console.error(`ERA URL Upload: summarisation failed for ${pdfFilename}: ${errMsg}`);
          return jsonResponse({
            success: false,
            error: errMsg,
          }, 500);
        }

        const betterTitle = extractTitleFromSummary(summaryResult.summary, category);
        
        // Strip AWARDS_DATA block before storing and extract awards
        const { awardsData, strippedSummary } = parseAwardsBlock(summaryResult.summary);
        
        // Preserve existing member from DB if eraId wasn't provided (no scrape)
        let effectiveMember = memberFromScrape;
        if (!effectiveMember) {
          effectiveMember = existingRow?.member ?? null;
        }
        
        const processedCase: ProcessedCase = {
          ...caseListing,
          title: betterTitle || caseListing.title,
          summary: strippedSummary,
          processedAt: new Date().toISOString(),
          source: 'ERA',
          paragraphCount: summaryResult.paragraphCount ?? null,
        };

        if (isPlaceholder || overwrite) {
          // Overwrite the existing placeholder row with the real summary
          await env.DB.prepare(
            `UPDATE seen_cases SET title=?, summary=?, member=COALESCE(?, member), category=?, processed_at=?, paragraph_count=?
             WHERE source='ERA' AND pdf_filename=?`
          ).bind(
            processedCase.title,
            processedCase.summary,
            effectiveMember,
            processedCase.category ?? null,
            processedCase.processedAt,
            processedCase.paragraphCount ?? null,
            pdfFilename
          ).run();
        } else {
          await markCaseSeen(env.DB, processedCase, 'ERA');
        }
        
        // Store awards data if extracted
        if (awardsData) {
          await insertCaseAward(env.DB, pdfFilename, 'ERA', awardsData, 'prompt_structured')
            .catch(e => console.warn(`ERA URL Upload: failed to insert awards for ${pdfFilename}: ${e}`));
        }
        console.log(`ERA URL Upload: stored ${caseId} (${betterTitle || caseListing.title})`);

        return jsonResponse({
          success: true,
          pdfFilename,
          title: betterTitle || caseListing.title,
          category,
          message: `Case processed and stored successfully. No email sent.`,
        });
      } catch (err) {
        console.error(`ERA URL Upload error: ${err}`);
        return jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    // POST /admin/dashboard/refresh-summaries — Re-summarise all existing ERA cases with current prompts
    // Runs in background (ctx.waitUntil). One case per tick — call repeatedly until done.
    if (request.method === 'POST' && url.pathname === '/admin/dashboard/refresh-summaries') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        // Accept ?offset=N to skip already-processed cases
        const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10));
        const pageSize = 1;

        // Get all ERA cases with PDF URLs, excluding enforcement cases
        const allCases = await env.DB.prepare(
          `SELECT pdf_filename, pdf_url, case_url, title, member, date_published, category
           FROM seen_cases WHERE source = 'ERA' AND pdf_url IS NOT NULL
           AND summary NOT LIKE '[ENFORCEMENT]%'
           ORDER BY processed_at DESC
           LIMIT ? OFFSET ?`
        ).bind(pageSize, offset).all<{ pdf_filename: string; pdf_url: string; case_url: string; title: string; member: string | null; date_published: string | null; category: string | null }>();

        if (allCases.results.length === 0) {
          return jsonResponse({ success: true, message: 'All cases refreshed. No more to process.' });
        }

        // Also get total count for remaining calculation
        const totalResult = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM seen_cases
           WHERE source = 'ERA' AND pdf_url IS NOT NULL
           AND summary NOT LIKE '[ENFORCEMENT]%'`
        ).first<{ count: number }>();
        const totalCount = totalResult?.count ?? 0;

        const c = allCases.results[0];
        const remaining = Math.max(0, totalCount - offset - 1);
        const thisTitle = c.title;
        ctx.waitUntil((async () => {
          try {
            const pdfContent = await getPdfContent(c.pdf_url);
            const caseListing = {
              caseId: c.pdf_filename.replace(/\.pdf$/i, ''),
              title: c.title, caseUrl: c.case_url,
              pdfUrl: c.pdf_url, member: c.member,
              datePublished: c.date_published, category: c.category,
            };
            const summaryResult = await summariseCase(
              caseListing, pdfContent, env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL, env.DB
            );
            if (!summaryResult.success) {
              console.error(`Refresh-summaries: failed for ${c.pdf_filename}: ${summaryResult.error}`);
              await insertErrorLog(env.DB, 'error', 'refresh_summaries', `Failed: ${c.pdf_filename} - ${summaryResult.error}`);
              return;
            }
            const betterTitle = extractTitleFromSummary(summaryResult.summary, c.category);
            const { awardsData, strippedSummary } = parseAwardsBlock(summaryResult.summary);
            // Update existing row — keep original processed_at so ORDER BY position stays stable
            await env.DB.prepare(
              `UPDATE seen_cases SET title=?, summary=?, member=?, category=?, paragraph_count=?
               WHERE source='ERA' AND pdf_filename=?`
            ).bind(
              betterTitle || c.title, strippedSummary, c.member, c.category,
              summaryResult.paragraphCount ?? null, c.pdf_filename
            ).run();
            // Store awards data if extracted
            if (awardsData) {
              await insertCaseAward(env.DB, c.pdf_filename, 'ERA', awardsData, 'prompt_structured')
                .catch(e => console.warn(`Refresh-summaries: failed to insert awards for ${c.pdf_filename}: ${e}`));
            }
            console.log(`Refresh-summaries: updated ${c.pdf_filename}`);
          } catch (err) {
            console.error(`Refresh-summaries error for ${c.pdf_filename}: ${err}`);
            await insertErrorLog(env.DB, 'error', 'refresh_summaries', `Error: ${c.pdf_filename} - ${err}`);
          }
        })());

        // Include this case's pdf_filename in a "skip" list to prevent re-picking it
        return jsonResponse({
          success: true, processed: 1, remaining,
          message: `Processing ${thisTitle}. ${remaining} case(s) remaining. Wait ~30s then call again.`,
        });
      } catch (err) {
        console.error(`Refresh-summaries error: ${err}`);
        return jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    // GET /admin/dashboard/scraper-stats — Scraper tab stats (cookie auth)
    if (request.method === 'GET' && url.pathname === '/admin/dashboard/scraper-stats') {
      if (!isAuthenticated(request, env)) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const [latestCase, oldestCase, stats] = await Promise.all([
          env.DB.prepare("SELECT title, case_url, pdf_filename FROM seen_cases WHERE source='ERA' ORDER BY pdf_filename DESC LIMIT 1").first<{title: string; case_url: string; pdf_filename: string}>(),
          env.DB.prepare("SELECT title, case_url, pdf_filename FROM seen_cases WHERE source='ERA' ORDER BY pdf_filename ASC LIMIT 1").first<{title: string; case_url: string; pdf_filename: string}>(),
          getCaseStatistics(env.DB),
        ]);
        const lastIdRaw = await getConfig(env.DB, 'last_era_id');
        return jsonResponse({
          latest: latestCase ? {
            title: latestCase.title,
            pdf_filename: latestCase.pdf_filename,
            era_id: latestCase.case_url?.match(/\/view\/(\d+)/)?.[1] || null,
          } : null,
          oldest: oldestCase ? {
            title: oldestCase.title,
            pdf_filename: oldestCase.pdf_filename,
            era_id: oldestCase.case_url?.match(/\/view\/(\d+)/)?.[1] || null,
          } : null,
          last_era_id: lastIdRaw ? parseInt(lastIdRaw, 10) : null,
          total_cases: stats.total,
          era_cases: stats.era,
          ec_cases: stats.ec,
        });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // GET /admin/dashboard/digest-config — Digest tab config (cookie auth)
    if (request.method === 'GET' && url.pathname === '/admin/dashboard/digest-config') {
      if (!isAuthenticated(request, env)) return new Response('Unauthorized', { status: 401 });
      try {
        const [subject, bannerDefault, bannerOnetime, footerDefault, footerOnetime, rangeStart, rangeMax, lastSent] = await Promise.all([
          getConfig(env.DB, 'email_subject'),
          getConfig(env.DB, 'email_banner_default'),
          getConfig(env.DB, 'email_banner_onetime'),
          getConfig(env.DB, 'email_footer_default'),
          getConfig(env.DB, 'email_footer_onetime'),
          getConfig(env.DB, 'digest_range_start'),
          getConfig(env.DB, 'digest_range_max'),
          env.DB.prepare("SELECT title, pdf_filename, processed_at FROM seen_cases WHERE source='ERA' ORDER BY pdf_filename DESC LIMIT 1").first<{title: string; pdf_filename: string; processed_at: string}>(),
        ]);
        // Also get latest available case
        const latestAvail = await env.DB.prepare("SELECT title, pdf_filename, case_url FROM seen_cases WHERE source='ERA' ORDER BY pdf_filename DESC LIMIT 1").first<{title: string; pdf_filename: string; case_url: string}>();
        return jsonResponse({
          email_subject: subject,
          email_banner_default: bannerDefault,
          email_banner_onetime: bannerOnetime,
          email_footer_default: footerDefault,
          email_footer_onetime: footerOnetime,
          digest_range_start: rangeStart,
          digest_range_max: rangeMax ? parseInt(rangeMax, 10) : 10,
          last_sent: lastSent ? { title: lastSent.title, pdf_filename: lastSent.pdf_filename, processed_at: lastSent.processed_at } : null,
          latest_avail: latestAvail ? { title: latestAvail.title, pdf_filename: latestAvail.pdf_filename, era_id: latestAvail.case_url?.match(/\/view\/(\d+)/)?.[1] || null } : null,
        });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // POST /admin/dashboard/save-email-template — Save email templates (cookie auth)
    if (request.method === 'POST' && url.pathname === '/admin/dashboard/save-email-template') {
      if (!isAuthenticated(request, env)) return new Response('Unauthorized', { status: 401 });
      try {
        const body = await request.json() as {
          subject?: string; banner_default?: string; banner_onetime?: string;
          footer_default?: string; footer_onetime?: string;
        } | null;
        if (!body) return jsonResponse({ error: 'Empty request body' }, 400);
        const updates: Array<Promise<void>> = [];
        if (body.subject !== undefined) updates.push(setConfig(env.DB, 'email_subject', body.subject));
        if (body.banner_default !== undefined) updates.push(setConfig(env.DB, 'email_banner_default', body.banner_default));
        if (body.banner_onetime !== undefined) updates.push(setConfig(env.DB, 'email_banner_onetime', body.banner_onetime));
        if (body.footer_default !== undefined) updates.push(setConfig(env.DB, 'email_footer_default', body.footer_default));
        if (body.footer_onetime !== undefined) updates.push(setConfig(env.DB, 'email_footer_onetime', body.footer_onetime));
        await Promise.all(updates);
        return jsonResponse({ success: true, message: 'Email templates saved.' });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // POST /admin/dashboard/set-digest-range — Set next digest range override
    if (request.method === 'POST' && url.pathname === '/admin/dashboard/set-digest-range') {
      if (!isAuthenticated(request, env)) return new Response('Unauthorized', { status: 401 });
      try {
        const body = await request.json() as { start_id?: number; max_cases?: number } | null;
        if (!body) return jsonResponse({ error: 'Empty request body' }, 400);
        if (body.start_id !== undefined) await setConfig(env.DB, 'digest_range_start', String(body.start_id));
        if (body.max_cases !== undefined) await setConfig(env.DB, 'digest_range_max', String(body.max_cases));
        return jsonResponse({ success: true, message: 'Digest range updated for next run.' });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ADMIN API ROUTES (Bearer token required)
    // ══════════════════════════════════════════════════════════════════════════

    const authHeader = request.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ') || !timingSafeEqual(authHeader.slice(7), env.ADMIN_SECRET)) {
      return new Response('Unauthorized', { status: 401 });
    }

    // POST /run — manual trigger (returns 202 immediately, processes in background)
    if (request.method === 'POST' && url.pathname === '/run') {
      const force = url.searchParams.get('force') === 'true';
      const limit = parseInt(url.searchParams.get('limit') ?? '3', 10);
      ctx.waitUntil(runDigest(env, force, Math.min(limit, 50)));
      return jsonResponse({ message: `Pipeline started (limit=${limit}). Check /admin/seen-cases in ~2 minutes.` }, 202);
    }

    // GET /admin/seen-cases
    if (request.method === 'GET' && url.pathname === '/admin/seen-cases') {
      if (!isAuthenticated(request, env)) return new Response('Unauthorized', { status: 401 });
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
      const cases = await getRecentCases(env.DB, Math.min(limit, 100));
      return jsonResponse({ cases, count: cases.length });
    }

    // GET /admin/status
    if (request.method === 'GET' && url.pathname === '/admin/status') {
      const allSubscribers = await getAllSubscribers(env.DB);
      const activeSubscribers = await getActiveSubscribers(env.DB);
      const lastRun = await getConfig(env.DB, 'last_run_at');
      const lastEmail = await getConfig(env.DB, 'last_email_sent_at');
      const isPaused = await getConfig(env.DB, 'system_paused');
      const recentCases = await getRecentCases(env.DB, 1000);
      const eraCases = recentCases.filter((c: any) => c.source === 'ERA').length;
      const ecCases = recentCases.filter((c: any) => c.source === 'EMPLOYMENT_COURT').length;

      return jsonResponse({
        total_subscribers: allSubscribers.length,
        active_subscribers: activeSubscribers.length,
        subscribers: activeSubscribers.map(s => ({
          id: s.id,
          email: s.email,
          name: s.name,
          confirmed: s.confirmed,
          confirmed_at: s.confirmed_at,
          created_at: s.created_at,
        })),
        last_run_at: lastRun,
        last_email_sent_at: lastEmail,
        is_paused: isPaused === '1' || isPaused === 'true',
        total_cases: recentCases.length,
        era_cases: eraCases,
        ec_cases: ecCases,
        sending_address: env.SENDING_ADDRESS,
        site_url: env.SITE_URL,
        cron_schedule: env.CRON_SCHEDULE,
        timezone: env.TIMEZONE,
        email_notice: await getConfig(env.DB, 'email_notice'),
      });
    }

    // POST /admin/notice-banner — Set or clear the email notice banner
    if (request.method === 'POST' && url.pathname === '/admin/notice-banner') {
      try {
        const body = await request.json() as { notice?: string };
        const notice = body.notice?.trim() ?? '';
        await setConfig(env.DB, 'email_notice', notice);
        return jsonResponse({ success: true, notice: notice || null });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // POST /admin/seed-seen
    if (request.method === 'POST' && url.pathname === '/admin/seed-seen') {
      const allCases = await scrapeRecentPage(env.SOURCE_URL);
      const newCases = await filterNewCases(env.DB, allCases);
      let seeded = 0;
      for (const c of newCases) {
        await markCaseSeen(env.DB, {
          ...c,
          summary: '(seeded — not processed)',
          processedAt: new Date().toISOString(),
          source: 'ERA',
        }, 'ERA');
        seeded++;
      }
      return jsonResponse({ seeded, message: `Marked ${seeded} existing cases as seen.` });
    }

    // POST /admin/clear-seen — requires { confirm: true } to prevent accidental data loss
    if (request.method === 'POST' && url.pathname === '/admin/clear-seen') {
      try {
        const body = await request.json() as { confirm?: boolean };
        if (!body.confirm) {
          return jsonResponse({
            error: 'Confirmation required. Send {\"confirm\": true} to proceed. This will permanently delete all seen_cases records.',
          }, 400);
        }
        const result = await env.DB.prepare('DELETE FROM seen_cases').run();
        return jsonResponse({ message: 'seen_cases table cleared.', deleted: result.meta.changes ?? 0 });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // POST /admin/delete-seen-case — remove a single case from seen_cases by case_id
    if (request.method === 'POST' && url.pathname === '/admin/delete-seen-case') {
      const body = await request.json() as { case_id?: string };
      if (!body.case_id) {
        return jsonResponse({ error: 'Missing case_id in request body.' }, 400);
      }
      const result = await env.DB.prepare('DELETE FROM seen_cases WHERE case_id = ?')
        .bind(body.case_id)
        .run();
      return jsonResponse({ message: `Deleted case_id=${body.case_id} from seen_cases.`, meta: result.meta });
    }



    // POST /admin/send-digest — send digest from existing summaries
    if (request.method === 'POST' && url.pathname === '/admin/send-digest') {
      const diagnostics: Record<string, unknown> = {};
      try {
        const limit = parseInt(url.searchParams.get('limit') ?? '10', 10);
        const preview = url.searchParams.get('preview') === 'true';
        const recentCases = await getRecentCases(env.DB, limit);
        const cases: ProcessedCase[] = recentCases
          .filter((r: any) => r.summary && !r.summary.startsWith('(seeded'))
          .map((r: any) => ({
            caseId: r.case_id,
            title: r.title,
            caseUrl: r.case_url,
            pdfUrl: r.pdf_url ?? null,
            member: r.member,
            datePublished: r.date_published,
            category: r.category,
            summary: r.summary,
            processedAt: r.processed_at,
            source: r.source || 'ERA',
          }));
        diagnostics.casesFound = cases.length;
        if (cases.length === 0) {
          return jsonResponse({ error: 'No summarised cases found', diagnostics }, 400);
        }

        const subscribers = await getActiveSubscribers(env.DB);
        diagnostics.subscriberCount = subscribers.length;

        if (preview) {
          // Return preview HTML without sending
          const { html } = await buildDigestEmail(cases, env.TIMEZONE, `${env.SITE_URL}/unsubscribe?token=preview-token`);
          return jsonResponse({
            cases,
            html_preview: html,
            recipient_count: subscribers.length,
          });
        }

        const notice = await getEmailNotice(env.DB);
        const { sent, failed } = await sendDigestToAll(
          subscribers, cases, env.SENDING_ADDRESS, env.TIMEZONE, env.EMAIL, env.SITE_URL, notice || undefined
        );

        // Only clear notice after successful email dispatch
        if (sent > 0) {
          await clearEmailNotice(env.DB);
        }

        return jsonResponse({ success: true, sent, failed, diagnostics });
      } catch (err) {
        diagnostics.errorMessage = String(err);
        return jsonResponse({ success: false, diagnostics }, 500);
      }
    }

    // POST /admin/delete-subscriber (JSON API version)
    if (request.method === 'POST' && url.pathname === '/admin/delete-subscriber') {
      try {
        const body = await request.json() as { email?: string };
        if (!body.email) {
          return jsonResponse({ error: 'Missing email in request body' }, 400);
        }
        await env.DB.prepare('DELETE FROM subscribers WHERE email = ?').bind(body.email).run();
        return jsonResponse({ success: true, deleted: body.email });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // POST /admin/set-pause — Pause/resume the cron digest
    if (request.method === 'POST' && url.pathname === '/admin/set-pause') {
      try {
        const body = await request.json() as { paused?: boolean };
        const paused = body.paused === true ? '1' : '0';
        await env.DB.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))')
          .bind('system_paused', paused)
          .run();
        return jsonResponse({ success: true, is_paused: paused === '1' });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // GET /admin/errors — Get recent errors (queries error_log table)
    if (request.method === 'GET' && url.pathname === '/admin/errors') {
      if (!isAuthenticated(request, env)) return new Response('Unauthorized', { status: 401 });
      try {
        const errors = await getRecentErrors(env.DB, 50);
        return jsonResponse({ errors, count: errors.length });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // POST /admin/approve-ec-case (placeholder - in future will move from temp to permanent)
    if (request.method === 'POST' && url.pathname === '/admin/approve-ec-case') {
      try {
        const body = await request.json() as { caseId?: string };
        if (!body.caseId) {
          return jsonResponse({ error: 'Missing caseId' }, 400);
        }
        // The case is already stored by upload-ec-case, so this is a no-op
        return jsonResponse({ success: true, message: 'Case approved and stored' });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // POST /admin/discard-ec-case (placeholder)
    if (request.method === 'POST' && url.pathname === '/admin/discard-ec-case') {
      try {
        const body = await request.json() as { caseId?: string };
        if (!body.caseId) {
          return jsonResponse({ error: 'Missing caseId' }, 400);
        }
        // Delete from database if it exists
        await env.DB.prepare('DELETE FROM seen_cases WHERE case_id = ?').bind(body.caseId).run();
        return jsonResponse({ success: true, message: 'Case discarded' });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // POST /admin/test-email
    if (request.method === 'POST' && url.pathname === '/admin/test-email') {
      const diagnostics: Record<string, unknown> = {};
      try {
        const subscribers = await getActiveSubscribers(env.DB);
        if (subscribers.length === 0) {
          return jsonResponse({ error: 'No active subscribers', diagnostics }, 400);
        }
        const sub = subscribers[0];
        diagnostics.to = sub.email;

        const mimeMessage = [
          `From: ${env.SENDING_ADDRESS}`,
          `To: ${sub.email}`,
          `Subject: ERA Digest Test Email`,
          `Date: ${new Date().toUTCString()}`,
          `MIME-Version: 1.0`,
          `Content-Type: text/plain; charset=utf-8`,
          ``,
          'This is a test email from ERA Digest Worker.',
        ].join('\r\n');

        const encoder = new TextEncoder();
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        const writer = writable.getWriter();
        writer.write(encoder.encode(mimeMessage)).then(() => writer.close());

        const message = new EmailMessage(env.SENDING_ADDRESS, sub.email, readable);
        await env.EMAIL.send(message);

        return jsonResponse({ success: true, sentTo: sub.email, diagnostics });
      } catch (err) {
        diagnostics.error = String(err);
        return jsonResponse({ success: false, diagnostics }, 500);
      }
    }

    // GET /admin/diagnostics — Run diagnostic tests
    if (request.method === 'GET' && url.pathname === '/admin/diagnostics') {
      try {
        const testName = url.searchParams.get('test') ?? 'all';
        const results: DiagnosticsReport[] = [];

        if (testName === 'all') {
          for (const [, test] of Object.entries(DIAGNOSTICS_TESTS)) {
            const report = await test.run(env, request);
            results.push(report);
          }
        } else if (DIAGNOSTICS_TESTS[testName]) {
          const report = await DIAGNOSTICS_TESTS[testName].run(env, request);
          results.push(report);
        } else {
          return jsonResponse({
            error: `Unknown test "${testName}". Available: ${Object.keys(DIAGNOSTICS_TESTS).join(', ')}`,
            available_tests: Object.keys(DIAGNOSTICS_TESTS),
          }, 400);
        }

        // Compute overall summary
        const overall = { pass: 0, fail: 0, warn: 0 };
        for (const r of results) {
          overall.pass += r.summary.pass;
          overall.fail += r.summary.fail;
          overall.warn += r.summary.warn;
        }

        return jsonResponse({ tests: results, summary: overall });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // GET /admin/test-llm
    if (request.method === 'GET' && url.pathname === '/admin/test-llm') {
      try {
        const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            'HTTP-Referer': env.SITE_URL,
            'X-Title': 'ERA Determinations Digest',
          },
          body: JSON.stringify({
            model: env.OPENROUTER_MODEL,
            messages: [{ role: 'user', content: 'Reply with just the word: OK' }],
            max_tokens: 5,
          }),
        });
        const json = await resp.json() as unknown;
        return jsonResponse({ httpStatus: resp.status, body: json, model: env.OPENROUTER_MODEL });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    return new Response('Not found', { status: 404 });
  },
};

// ─── Main pipeline ────────────────────────────────────────────────────────────

interface RunResult {
  newCasesFound: number;
  summarised: number;
  failed: number;
  emailsSent: number;
  skippedAlreadySentToday: boolean;
  error?: string;
}

async function runDigest(env: Env, force = false, limit = 3): Promise<RunResult> {
  const result: RunResult = {
    newCasesFound: 0,
    summarised: 0,
    failed: 0,
    emailsSent: 0,
    skippedAlreadySentToday: false,
  };

  try {
    // Step 1: DST guard
    if (!force && await hasEmailBeenSentToday(env.DB, env.TIMEZONE)) {
      console.log('ERA Digest: email already sent today — skipping');
      result.skippedAlreadySentToday = true;
      return result;
    }

    // Step 1.5: Concurrency lock — prevent race conditions from duplicate cron triggers
    if (await isProcessing(env.DB)) {
      console.log('ERA Digest: Another instance is currently processing. Exiting to prevent race condition.');
      return result;
    }
    await setProcessingLock(env.DB, true);
    console.log('ERA Digest: Processing lock acquired');

    // Step 2: Scrape — probe ERA internal index for new cases
    //
    // Replaces the old approach of scraping /recent?start=N which was limited
    // to ~38 cases. The internal index (/determination/view/{id}) is perfectly
    // sequential — every integer from 1 to the current max resolves to a real
    // case. New cases always appear at the highest IDs.
    //
    // Probe strategy: start from a known high-water mark, fetch IDs in parallel
    // batches of 5 with a 300ms delay between batches. Stop at 3 consecutive
    // 404s within a batch.
    const probeStart = 21300; // Conservative floor — current max is ~21325
    const probeBatchSize = 5;
    const probeLimit = Math.min(limit * 2, 20); // Probe more than we'll process
    let allCases: CaseListing[] = [];
    let consecutiveMisses = 0;

    for (let offset = 0; offset < probeLimit && consecutiveMisses < 3; offset += probeBatchSize) {
      const batchIds = Array.from({ length: probeBatchSize }, (_, i) => probeStart + offset + i);
      const batchResults = await Promise.all(
        batchIds.map(id =>
          scrapeEraDetailPage(id).catch(() => null)
        )
      );

      // Add successes, stop early on 3 consecutive 404s
      let batchHits = 0;
      for (const detail of batchResults) {
        if (detail) {
          batchHits++;
          consecutiveMisses = 0;
          allCases.push({
            caseId: detail.caseId,
            title: detail.title,
            caseUrl: detail.caseUrl,
            pdfUrl: detail.pdfUrl,
            member: detail.member,
            datePublished: detail.datePublished,
            category: detail.category,
          });
        } else {
          consecutiveMisses++;
        }
      }

      // If every ID in this batch missed, increment the counter
      if (batchHits === 0) consecutiveMisses += probeBatchSize;

      if (offset + probeBatchSize < probeLimit) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    console.log(`ERA Digest: probed IDs ${probeStart}–${probeStart + probeLimit}, found ${allCases.length} new case(s)`);

    // Step 3: Filter
    let newCases = await filterNewCases(env.DB, allCases);
    console.log(`ERA Digest: ${newCases.length} new cases to process`);
    if (newCases.length > limit) {
      newCases = newCases.slice(0, limit);
    }
    result.newCasesFound = newCases.length;

    if (newCases.length === 0) {
      await recordRunAt(env.DB);
      return result;
    }

    // Step 4: Enrich
    const enrichedCases = await enrichCasesWithDetails(newCases);

    // Steps 5 & 6: Summarise + store (only commit if successful)
    const processedCases: ProcessedCase[] = [];
    // Map from pdf_filename → parsed awards data (populated during summarisation,
    // inserted into case_awards after markCaseSeen succeeds)
    const awardsMap = new Map<string, ReturnType<typeof parseAwardsBlock>['awardsData']>();

    for (const c of enrichedCases) {
      console.log(`ERA Digest: processing ${c.caseId} — ${c.title}`);

      let summary: string;
      let success = true;
      let paragraphCount: number | null = null;

      if (!c.pdfUrl) {
        summary = `Summary unavailable — no PDF link found. [View determination](${c.caseUrl})`;
        success = false;
      } else {
        try {
          const pdfContent = await getPdfContent(c.pdfUrl);
          const summaryResult = await summariseCase(c, pdfContent, env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL, env.DB);
          summary = summaryResult.summary;
          success = summaryResult.success;
          paragraphCount = summaryResult.paragraphCount ?? null;
          if (!success) result.failed++;
        } catch (err) {
          const errMsg = `Pipeline failed for ${c.caseId}: ${err}`;
          console.error(errMsg);
          // Log to error_log table for admin dashboard visibility
          try {
            await insertErrorLog(env.DB, 'error', 'pipeline', errMsg, undefined, c.caseId);
          } catch (_) {}
          summary = `Summary unavailable — an error occurred. [View determination](${c.caseUrl})`;
          result.failed++;
          success = false;
        }
      }

      // FIX: Only commit to database and add to processedCases if successful
      // Failed cases are skipped and will be retried on next run
      if (success) {
        result.summarised++;

        // Strip the AWARDS_DATA block before storing; keep awards data for later insert
        const { awardsData, strippedSummary } = parseAwardsBlock(summary);
        if (awardsData) {
          const pdfFilename = c.pdfUrl?.split('/').pop() ?? '';
          if (pdfFilename) awardsMap.set(pdfFilename, awardsData);
        }

        // Extract better title from LLM summary if available
        const betterTitle = extractTitleFromSummary(strippedSummary, c.category);
        // Capture the prompt version at summarisation time (updated_at of the active prompt)
        const promptVersionRow = await env.DB.prepare(
          "SELECT updated_at FROM config WHERE key = 'prompt_era'"
        ).first<{ updated_at: string }>();
        const promptVersion = promptVersionRow?.updated_at ?? null;
        const processedCase: ProcessedCase = {
          ...c,
          title: betterTitle || c.title,
          summary: strippedSummary,
          processedAt: new Date().toISOString(),
          source: 'ERA',
          summaryVersion: promptVersion,
          paragraphCount,
        };
        processedCases.push(processedCase);
        // NOTE: markCaseSeen is NOT called here. Cases are marked as seen only AFTER
        // successful email dispatch (or if no subscribers exist). This ensures that
        // if email dispatch fails, cases will be retried on the next run.
      } else {
        console.warn(`Skipping database commit for ${c.caseId} due to failure. Will retry next run.`);
      }
    }

    // Step 7: Send digest (only if we have successful cases)
    const subscribers = await getActiveSubscribers(env.DB);
    if (subscribers.length > 0 && processedCases.length > 0) {
      const notice = await getEmailNotice(env.DB);
      const { sent, failed } = await sendDigestToAll(
        subscribers, processedCases, env.SENDING_ADDRESS,
        env.TIMEZONE, env.EMAIL, env.SITE_URL, notice || undefined
      );
      result.emailsSent = sent;
      if (failed > 0) result.failed += failed;

      // Only mark cases as seen after successful email dispatch
      for (const pc of processedCases) {
        await markCaseSeen(env.DB, pc, 'ERA');
        // Insert awards data if available
        const pdfFilename = pc.pdfUrl?.split('/').pop() ?? '';
        const awards = awardsMap.get(pdfFilename);
        if (awards) {
          await insertCaseAward(env.DB, pdfFilename, 'ERA', awards, 'prompt_structured')
            .catch(e => console.warn(`Failed to insert awards for ${pdfFilename}: ${e}`));
        }
      }

      // Only clear notice after successful email + markSeen are complete
      if (sent > 0) {
        await clearEmailNotice(env.DB);
      }
    } else if (subscribers.length === 0 && processedCases.length > 0) {
      console.warn('ERA Digest: no active subscribers, but marking processed cases as seen for archive');
      // Still mark cases as seen even if no subscribers (for archival purposes)
      for (const pc of processedCases) {
        await markCaseSeen(env.DB, pc, 'ERA');
        const pdfFilename = pc.pdfUrl?.split('/').pop() ?? '';
        const awards = awardsMap.get(pdfFilename);
        if (awards) {
          await insertCaseAward(env.DB, pdfFilename, 'ERA', awards, 'prompt_structured')
            .catch(e => console.warn(`Failed to insert awards for ${pdfFilename}: ${e}`));
        }
      }
    } else {
      console.log('ERA Digest: no successful cases processed, skipping email');
    }

    // Step 8: Record
    await recordEmailSent(env.DB);
    console.log(`ERA Digest: done. ${result.summarised} summarised, ${result.emailsSent} sent.`);
    return result;

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`ERA Digest: fatal error — ${errMsg}`);
    result.error = errMsg;
    // Log to error_log table so /admin/errors can retrieve it
    await insertErrorLog(env.DB, 'error', 'pipeline', `Fatal: ${errMsg}`).catch(e =>
      console.warn(`Failed to log fatal error: ${e}`)
    );
    await sendAdminAlert(
      `Fatal error:\n\n${errMsg}`,
      env.SENDING_ADDRESS, env.ADMIN_EMAIL, env.EMAIL
    ).catch(() => {});
    await recordRunAt(env.DB).catch(() => {});
    return result;
  } finally {
    // Always release the processing lock, even if a run crashes
    await setProcessingLock(env.DB, false).catch(e => 
      console.error(`Failed to release processing lock: ${e}`)
    );
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Clean extracted PDF text by stripping control/escape characters often produced
 * by CID font extraction. Keeps printable ASCII, common Unicode, \n, \r, \t.
 */
function cleanExtractedText(text: string): string {
  let cleaned = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);

    // Keep: printable ASCII (0x20-0x7E), tab(0x09), LF(0x0A), CR(0x0D)
    if (ch >= 0x20 && ch <= 0x7E) {
      cleaned += text[i];
    } else if (ch === 0x09 || ch === 0x0A || ch === 0x0D) {
      cleaned += text[i];
    } else if (ch >= 0xA0 && ch !== 0xFEFF && ch !== 0xFFFE && ch !== 0xFFFF) {
      // Keep higher Unicode (printable non-ASCII: en-dash, smart quotes, macrons, etc.)
      // But drop BOM, non-characters, and other problematic codepoints
      cleaned += text[i];
    }
    // Everything else including DEL (0x7F) and C1 controls (0x80-0x9F) is dropped
  }

  // Replace literal backslash-escape sequences that appear as text
  cleaned = cleaned.replace(/\\n/g, '\n');
  cleaned = cleaned.replace(/\\r/g, '\r');
  cleaned = cleaned.replace(/\\t/g, ' ');

  // Strip any remaining bare backslash-bomb sequences
  cleaned = cleaned.replace(/\\(?:[0-7]{1,3}|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/g, '');

  // Collapse runs of whitespace (but keep paragraph breaks)
  cleaned = cleaned.replace(/[ \t]+/g, ' ');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

/**
 * Parse an EC PDF filename to extract a proper case title (with citation) and
 * citation string.
 *
 * Handles two filename patterns:
 *   1. Name-first: "Healey-v-Health-New-Zealand-2026-NZEmpC-98.pdf"
 *      → "Healey v Health New Zealand [2026] NZEmpC 98"
 *   2. Citation-first: "2026-NZEmpC-111-Du-Fall-v-Mokoia-School-Judgment-Copy.pdf"
 *      → "Du Fall v Mokoia School [2026] NZEmpC 111"
 */
function parseTitleFromFilename(filename: string): { title: string; citation: string | null } {
  const name = filename.replace(/\.pdf$/i, '');

  // Extract citation: "2026-NZEmpC-98" or "2026-NZERA-225"
  const citeMatch = name.match(/(\d{4}-NZ\w+-\d+)/i);
  const citationStr = citeMatch ? citeMatch[1] : null;

  // Build proper citation format: "[2026] NZEmpC 98"
  let citation: string | null = null;
  if (citationStr) {
    const parts = citationStr.match(/(\d{4})-NZ(\w+)-(\d+)/i);
    if (parts) {
      citation = `[${parts[1]}] NZ${parts[2]} ${parts[3]}`;
    } else {
      citation = citationStr.replace(/-/g, ' ');
    }
  }

  // Extract case name by removing the citation suffix/prefix
  let caseName = name;
  if (citationStr) {
    // Remove the citation string
    caseName = caseName.replace(citationStr, '');
  }

  // Strip common suffixes
  caseName = caseName.replace(/-Judgment-Copy$/i, '');
  caseName = caseName.replace(/-Judgment$/i, '');
  caseName = caseName.replace(/-Decision$/i, '');
  caseName = caseName.replace(/-Order$/i, '');
  caseName = caseName.replace(/-Copy$/i, '');

  // Strip trailing/leading hyphens
  caseName = caseName.replace(/^-+|-+$/g, '');

  // Replace remaining hyphens with spaces
  caseName = caseName.replace(/-/g, ' ');

  // Use the existing toTitleCase from utils for proper formatting
  // (imported at top of file — but we duplicate the logic here for simplicity)
  caseName = toTitleCaseSimple(caseName);

  // Include citation in the title
  const fullTitle = citation ? `${caseName} ${citation}` : caseName;

  return { title: fullTitle, citation };
}

/**
 * Simple title case for case names — keeps "v" and legal particles lowercase.
 */
function toTitleCaseSimple(s: string): string {
  const particles = new Set([
    'v', 'and', 'or', 'of', 'the', 'in', 'at', 'for',
    'nor', 'but', 'to', 'a', 'an', 'by', 'as', 'per',
  ]);
  return s
    .split(' ')
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (i === 0) return lower.charAt(0).toUpperCase() + lower.slice(1);
      if (particles.has(lower)) return lower;
      if (/^[A-Z]{2,6}$/.test(word)) return word;
      if (/^[A-Z]{2,}[a-z]/.test(word)) return word;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ')
    .replace(/(?<!& )\bAnor\b/g, '& Anor');
}

/**
 * Strips a party name extracted from a LLM PARTIES section line.
 *
 * The LLM formats party names as:
 *   Applicant: Jane Smith (employee — some description)
 *   Respondent: Acme Ltd (employer)
 *
 * This helper removes the parenthetical role description so only the bare
 * name is returned. It handles two cases:
 *   1. Closed parenthetical on the same line: "Jane Smith (employee)" → "Jane Smith"
 *   2. Unclosed parenthetical (line ends mid-description): "Jane Smith (employee —"
 *      → "Jane Smith"  (prevents stray open-paren in the stored title)
 */
function cleanPartyName(raw: string): string {
  return raw
    .replace(/\(.*?\)/g, '')    // remove closed parentheticals
    .replace(/\s*\([^)]*$/, '') // strip unclosed trailing parenthetical
    .trim();
}

/**
 * Words that indicate the "party name" extracted from PARTIES is actually a
 * legal representative. This happens when the ERA registry lists a case using
 * a counsel's name (e.g. "Mark Donovan & Anor v Rhino-Rack NZ Ltd") and the
 * LLM is influenced by that metadata rather than the determination body text.
 *
 * When triggered, the label-based extraction is discarded and the function
 * falls through to the "v" pattern fallback, then returns null if that also
 * fails. The caller must fall back to the scraped ERA title and should log a
 * warning to prompt a rescan.
 */
const REPRESENTATIVE_WORDS = /\b(counsel|solicitor|barrister|advocate)\b/i;

/**
 * Extracts a display title from the LLM summary's PARTIES section.
 *
 * Why this exists:
 *   The ERA case registry sometimes titles cases using the name of a party's
 *   legal counsel rather than the actual parties (employee / employer). The
 *   scraper picks up that registry title verbatim. This function reads the
 *   structured PARTIES section that the LLM generates from the determination
 *   body text — which always names the real parties — and uses that instead.
 *
 * Supported formats:
 *   ERA:  Applicant: [name]  /  Respondent: [name]
 *   EC:   Appellant: [name]  /  Respondent: [name]
 *   Fallback: "[left] v [right]" free-text line in PARTIES
 *
 * Robustness improvements over v1:
 *   - cleanPartyName() handles closed and unclosed parentheticals uniformly
 *   - ERA lookahead increased from 6 → 10 lines (handles LLMs that add blank
 *     lines between the section header and the first label)
 *   - REPRESENTATIVE_WORDS sanity check prevents counsel names leaking through
 *     if the LLM was confused by a bad ERA registry title in the case metadata
 *   - Centralized console.warn on null return — all 5 call sites are covered
 *
 * Returns null if extraction fails; caller falls back to scraped ERA title.
 */
function extractTitleFromSummary(summary: string, citation?: string | null): string | null {
  const lines = summary.split('\n');
  let leftNames: string[] = [];
  let rightNames: string[] = [];
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line !== 'PARTIES') continue;

    // ── EC format: Appellant:/Respondent: labels ──────────────────────────────
    // EC summaries use "Appellant:" instead of "Applicant:". Detect this first
    // so the ERA path doesn't misfire on a following "Respondent:" line.
    const ecAppellants: string[] = [];
    const ecRespondents: string[] = [];
    let isEc = false;

    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const next = lines[j].trim();
      if (next === '' || next.match(/^---/)) continue;
      if (next.match(/^[A-Z &]{4,}:/) && !next.match(/^Appellant:/i) && !next.match(/^Respondent:/i)) break;

      if (next.match(/^Appellant:/i)) {
        isEc = true;
        const name = cleanPartyName(next.replace(/^Appellant:\s*/i, ''));
        if (name) ecAppellants.push(name);
      } else if (isEc && next.match(/^Respondent:/i)) {
        const name = cleanPartyName(next.replace(/^Respondent:\s*/i, ''));
        if (name) ecRespondents.push(name);
      } else if (isEc && next && !next.match(/^[A-Z ]{4,}:/) && !next.match(/^[A-Z &]{4,}$/)) {
        // Continuation of previous party on the next line (multi-line name)
        const cleaned = cleanPartyName(next);
        if (ecRespondents.length > 0) {
          ecRespondents[ecRespondents.length - 1] += ' ' + cleaned;
        } else if (ecAppellants.length > 0) {
          ecAppellants[ecAppellants.length - 1] += ' ' + cleaned;
        }
      } else if (isEc) {
        break;
      }
    }

    if (isEc && (ecAppellants.length > 0 || ecRespondents.length > 0)) {
      leftNames = ecAppellants;
      rightNames = ecRespondents;
      found = true;
      break;
    }

    // ── ERA format: Applicant:/Respondent: labels ─────────────────────────────
    // Lookahead is 10 lines so we handle LLMs that emit blank lines between the
    // "PARTIES" header and the first "Applicant:" label. (Previous value: 6.)
    let applicantName = '';
    let respondentName = '';

    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const eraLine = lines[j].trim();
      if (!eraLine || eraLine.match(/^---/)) continue;

      // Stop at any all-caps section header (with OR without trailing colon).
      // e.g. "REPRESENTATIVES", "FACTS", "LEGAL ISSUES" — these don't have
      // colons in the structured summary format, so the old check (/^[A-Z &]{4,}:/)
      // missed them, causing the loop to read into the REPRESENTATIVES section
      // and overwrite correctly-extracted party names with counsel names.
      if (eraLine.match(/^[A-Z][A-Z &]{3,}:?$/)) break;
      if (eraLine.match(/^[A-Z &]{4,}:/)) break;

      const appMatch = eraLine.match(/^Applicant:\s*(.+)/i);
      if (appMatch) {
        applicantName = cleanPartyName(appMatch[1]);
        // Early exit once both names are found — don't read further into
        // REPRESENTATIVES or other sections.
        if (respondentName) break;
        continue;
      }

      const respMatch = eraLine.match(/^Respondent:\s*(.+)/i);
      if (respMatch) {
        respondentName = cleanPartyName(respMatch[1]);
        if (applicantName) break; // both found — stop immediately
        continue;
      }
    }

    if (applicantName && respondentName) {
      // Sanity check: if either extracted name contains legal representative
      // language, the LLM has confused parties with counsel — almost always
      // caused by the ERA registry title containing a counsel's name that was
      // passed to the LLM as case metadata. Don't trust these names; fall
      // through to the "v" pattern fallback instead.
      if (REPRESENTATIVE_WORDS.test(applicantName) || REPRESENTATIVE_WORDS.test(respondentName)) {
        console.warn(
          `[extractTitleFromSummary] Extracted party names appear to contain legal ` +
          `representative language — skipping label extraction. ` +
          `applicant="${applicantName}", respondent="${respondentName}", ` +
          `citation="${citation ?? ''}". Falling through to "v" pattern fallback.`
        );
        // Do not set found; fall through to "v" pattern below
      } else {
        const splitParties = (s: string): string[] =>
          s.split(/\s*,\s*|\s*;\s*|\s+and\s+/i).map(x => x.trim()).filter(Boolean);

        leftNames = splitParties(applicantName);
        rightNames = splitParties(respondentName);
        found = true;
      }
    }

    // ── Fallback: "Party v Other Party" free-text line ───────────────────────
    // Used when Applicant:/Respondent: labels are missing — e.g. summaries that
    // were generated with the minimal fallback prompt before real prompts were
    // seeded into D1.
    if (!found) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const vLine = lines[j].trim();
        if (!vLine || vLine.match(/^[A-Z ]{4,}:/)) continue;

        const vMatch = vLine.match(/^(.+?)\s+v(?:s)?\.?\s+(.+)/i);
        if (vMatch) {
          const splitParties = (s: string): string[] =>
            s.split(/\s*,\s*|\s+and\s+|\s*;\s*/).map(x => cleanPartyName(x)).filter(Boolean);

          leftNames = splitParties(vMatch[1].trim());
          rightNames = splitParties(vMatch[2].trim());
          found = true;
          break;
        }
      }
    }

    if (found) break;
  }

  if (!found || (leftNames.length === 0 && rightNames.length === 0)) {
    // This warning is visible in Cloudflare Workers tail logs.
    // Common causes: PARTIES section absent, unexpected LLM formatting, or
    // the summary was generated with the minimal fallback prompt (pre-D1 seeding).
    // Action: rescan the affected case after seeding the proper prompt in D1.
    console.warn(
      `[extractTitleFromSummary] Could not extract title from PARTIES section. ` +
      `citation="${citation ?? 'none'}". Scraped ERA title will be used as fallback — ` +
      `this may contain a counsel name if the ERA registry used counsel as the case title. ` +
      `Rescan this case with an updated prompt to correct the stored title.`
    );
    return null;
  }

  // Apply & Anor / & Ors legal naming convention
  const formatSide = (names: string[]): string => {
    if (names.length === 0) return '';
    const first = names[0];
    if (names.length === 2) return first + ' & Anor';
    if (names.length > 2) return first + ' & Ors';
    return first;
  };

  const left = formatSide(leftNames);
  const right = formatSide(rightNames);

  let result = left;
  if (right) result += ' v ' + right;

  // Append citation if provided and not already embedded in the result string
  const citationPattern = /^\[\d{4}\]\s+NZ/;
  if (citation && citationPattern.test(citation) && !result.includes(citation)) {
    result += ' ' + citation;
  }

  return result;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
