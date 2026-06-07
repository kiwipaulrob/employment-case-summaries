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
 *   POST /admin/test-email  — Send test email
 *   GET  /admin/test-llm    — Test OpenRouter connectivity
 */

import { EmailMessage } from 'cloudflare:email';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env, ProcessedCase } from './types';
import {
  filterNewCases, markCaseSeen, getActiveSubscribers, getAllSubscribers,
  hasEmailBeenSentToday, recordEmailSent, recordRunAt, getRecentCases, getCaseStatistics,
  getConfig, setConfig, addSubscriberPending, confirmSubscriber, unsubscribeByToken,
  deleteSubscriber, deleteStalePendingSubscribers, setProcessingLock, isProcessing,
} from './db';
import { scrapeRecentPage, enrichCasesWithDetails } from './scraper';
import { getPdfContent, getPdfContentFromBytes, type PdfContent } from './pdf';
import { summariseCase } from './summariser';
import { summariseEmploymentCourtCase } from './summariserEmploymentCourt';
import {
  sendDigestToAll, sendAdminAlert, buildDigestEmail,
  sendEmail, sendConfirmationEmail,
} from './emailer';
import {
  homePage, subscribedPage, confirmedPage, unsubscribedPage,
  alreadyUnsubscribedPage, invalidTokenPage, alreadySubscribedPage,
  adminLoginPage, adminPage,
} from './pages';
import { getDashboardHtml } from './dashboard';
import { isValidEmail } from './utils';

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

// ─── Email notice helper ──────────────────────────────────────────────────────

/**
 * Fetch optional email notice from D1 config, then immediately clear it.
 * This is a one-shot: after fetching, the notice is set to NULL so it won't
 * appear in subsequent emails until manually set again.
 * Returns null if no notice is configured.
 */
async function getAndClearEmailNotice(db: D1Database): Promise<string | null> {
  try {
    const notice = await getConfig(db, 'email_notice');
    if (notice) {
      // Clear it immediately after reading
      await db.prepare(`UPDATE config SET value = NULL WHERE key = 'email_notice'`).run();
      console.log('Email notice cleared after read');
    }
    return notice;
  } catch (err) {
    console.warn(`Failed to fetch/clear email notice: ${err}`);
    return null;
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

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      Promise.all([
        runDigest(env),
        deleteStalePendingSubscribers(env.DB, 48).then(n => {
          if (n > 0) console.log(`ERA Digest: purged ${n} stale pending subscriber(s)`);
        }),
      ])
    );
  },

  // ─── HTTP handler ─────────────────────────────────────────────────────────────

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ══════════════════════════════════════════════════════════════════════════
    // PUBLIC ROUTES (no auth required)
    // ══════════════════════════════════════════════════════════════════════════

    // GET / — Landing page
    if (request.method === 'GET' && url.pathname === '/') {
      const cases = await getRecentCases(env.DB, 20);
      return htmlResponse(homePage(cases));
    }

    // POST /subscribe — Handle sign-up form
    if (request.method === 'POST' && url.pathname === '/subscribe') {
      const formData = await request.formData();
      const email = (formData.get('email') as string ?? '').trim().toLowerCase();
      const name = (formData.get('name') as string ?? '').trim() || null;

      if (!email || !isValidEmail(email)) {
        const cases = await getRecentCases(env.DB, 20);
        return htmlResponse(homePage(cases, 'Please enter a valid email address.', { name: name ?? '', email }));
      }

      const { token, alreadyActive } = await addSubscriberPending(env.DB, email, name);

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

    // GET /admin — Show login form or dashboard
    if (request.method === 'GET' && url.pathname === '/admin') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return htmlResponse(adminLoginPage());
      }
      const [subscribers, lastRun, lastEmail, stats, isPausedConfig] = await Promise.all([
        getAllSubscribers(env.DB),
        getConfig(env.DB, 'last_run_at'),
        getConfig(env.DB, 'last_email_sent_at'),
        getCaseStatistics(env.DB),
        getConfig(env.DB, 'system_paused'),
      ]);
      const isPaused = isPausedConfig === '1';
      const dashboardHtml = getDashboardHtml({
        total_subscribers: subscribers.length,
        active_subscribers: subscribers.filter((s: any) => s.confirmed).length,
        subscribers: subscribers as any[],
        last_run_at: lastRun,
        is_paused: isPaused,
        total_cases: stats.total,
        era_cases: stats.era,
        ec_cases: stats.ec,
      });
      return htmlResponse(dashboardHtml);
    }

    // POST /admin — Login form submission
    if (request.method === 'POST' && url.pathname === '/admin') {
      const formData = await request.formData();
      const password = (formData.get('password') as string ?? '').trim();
      if (password !== env.ADMIN_SECRET) {
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

    // POST /admin/set-pause — Pause/resume via form submission
    if (request.method === 'POST' && url.pathname === '/admin/set-pause') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const formData = await request.formData();
        const paused = (formData.get('paused') ?? '0') === '1' ? '1' : '0';
        await env.DB.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
          .bind('system_paused', paused)
          .run();
        return new Response('', { status: 302, headers: { Location: '/admin' } });
      } catch (err) {
        return new Response(`Error: ${String(err)}`, { status: 500 });
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
            (file instanceof File && file.name ? file.name : null) ??
            explicitFilename ??
            'upload.pdf';

          // Read bytes — CF Workers may return Blob, File, or a UTF-8-decoded string
          if (file instanceof Blob) {
            arrayBuffer = await (file as Blob).arrayBuffer();
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

        // Summarise using Employment Court summariser
        const summaryResult = await summariseEmploymentCourtCase(
          caseListing,
          pdfContentForSummariser,
          env.OPENROUTER_API_KEY,
          env.OPENROUTER_MODEL
        );

        if (!summaryResult.success) {
          return jsonResponse({
            error: `LLM summarisation failed: ${summaryResult.error}`,
            diagnostics,
          }, 500);
        }

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
        const summaryResult = await summariseEmploymentCourtCase(
          caseListing, pdfContent, env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL
        );
        if (!summaryResult.success) {
          return jsonResponse({ error: `LLM summarisation failed: ${summaryResult.error}` }, 500);
        }
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

    // POST /admin/dashboard/update-prompts — Save LLM prompts to D1 config
    if (request.method === 'POST' && url.pathname === '/admin/dashboard/update-prompts') {
      const session = getAdminCookie(request);
      if (session !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const formData = await request.formData();
        const promptEra = (formData.get('prompt_era') as string ?? '').trim();
        const promptEc = (formData.get('prompt_ec') as string ?? '').trim();
        await Promise.all([
          setConfig(env.DB, 'prompt_era', promptEra),
          setConfig(env.DB, 'prompt_ec', promptEc),
        ]);
        return jsonResponse({ success: true, message: 'Prompts saved' });
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

        // If sendEmail, set a notice banner, then trigger pipeline
        if (sendEmail && recentCases.length > 0) {
          await setConfig(env.DB, 'email_notice',
            `Updated summaries for ${recentCases.length} recently rescanned case(s) (new prompt applied).`
          );
          // Fire-and-forget the pipeline
          ctx.waitUntil(runDigest(env, true, limit));
        }

        return jsonResponse({
          success: true,
          deleted: recentCases.length,
          send_email: sendEmail,
          message: sendEmail
            ? `Deleted ${recentCases.length} cases, setting notice banner and triggering pipeline.`
            : `Deleted ${recentCases.length} cases. Run /admin/send-digest to email, or wait for next cron.`
        });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ADMIN API ROUTES (Bearer token required)
    // ══════════════════════════════════════════════════════════════════════════

    const authHeader = request.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== env.ADMIN_SECRET) {
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
      });
    }

    // POST /admin/seed-seen
    if (request.method === 'POST' && url.pathname === '/admin/seed-seen') {
      const allCases = await scrapeRecentPage(env.SOURCE_URL);
      const newCases = await filterNewCases(env.DB, allCases);
      let seeded = 0;
      for (const c of newCases) {
        await markCaseSeen(env.DB, {
          ...c,
          pdfUrl: undefined as any,
          date: '',
          summary: '(seeded — not processed)',
          processedAt: new Date().toISOString(),
          source: 'ERA',
        }, 'ERA');
        seeded++;
      }
      return jsonResponse({ seeded, message: `Marked ${seeded} existing cases as seen.` });
    }

    // POST /admin/clear-seen
    if (request.method === 'POST' && url.pathname === '/admin/clear-seen') {
      await env.DB.prepare('DELETE FROM seen_cases').run();
      return jsonResponse({ message: 'seen_cases table cleared.' });
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

        const notice = await getAndClearEmailNotice(env.DB);
        const { sent, failed } = await sendDigestToAll(
          subscribers, cases, env.SENDING_ADDRESS, env.TIMEZONE, env.EMAIL, env.SITE_URL, notice
        );

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
        await env.DB.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
          .bind('system_paused', paused)
          .run();
        return jsonResponse({ success: true, is_paused: paused === '1' });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // GET /admin/errors — Get recent errors
    if (request.method === 'GET' && url.pathname === '/admin/errors') {
      try {
        const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
        // For now, return empty array since we don't have error tracking table yet
        // This will be populated by error logging in production
        return jsonResponse({ errors: [] });
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

    // Step 2: Scrape
    console.log(`ERA Digest: scraping ${env.SOURCE_URL}`);
    let allCases = await scrapeRecentPage(env.SOURCE_URL);
    console.log(`ERA Digest: found ${allCases.length} cases`);

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
    const usePdfPassthrough = env.USE_PDF_URL_PASSTHROUGH !== 'false';
    const processedCases: ProcessedCase[] = [];

    for (const c of enrichedCases) {
      console.log(`ERA Digest: processing ${c.caseId} — ${c.title}`);

      let summary: string;
      let success = true;

      if (!c.pdfUrl) {
        summary = `Summary unavailable — no PDF link found. [View determination](${c.caseUrl})`;
        success = false;
      } else {
        try {
          const pdfContent = await getPdfContent(c.pdfUrl, usePdfPassthrough);
          const summaryResult = await summariseCase(c, pdfContent, env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL);
          summary = summaryResult.summary;
          success = summaryResult.success;
          if (!success) result.failed++;
        } catch (err) {
          console.error(`Pipeline failed for ${c.caseId}: ${err}`);
          summary = `Summary unavailable — an error occurred. [View determination](${c.caseUrl})`;
          result.failed++;
          success = false;
        }
      }

      // FIX: Only commit to database and add to processedCases if successful
      // Failed cases are skipped and will be retried on next run
      if (success) {
        result.summarised++;
        const processedCase: ProcessedCase = {
          ...c,
          summary,
          processedAt: new Date().toISOString(),
          source: 'ERA',
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
      const notice = await getAndClearEmailNotice(env.DB);
      const { sent, failed } = await sendDigestToAll(
        subscribers, processedCases, env.SENDING_ADDRESS,
        env.TIMEZONE, env.EMAIL, env.SITE_URL, notice
      );
      result.emailsSent = sent;
      if (failed > 0) result.failed += failed;
      
      // Only mark cases as seen after successful email dispatch
      for (const pc of processedCases) {
        await markCaseSeen(env.DB, pc, 'ERA');
      }
    } else if (subscribers.length === 0 && processedCases.length > 0) {
      console.warn('ERA Digest: no active subscribers, but marking processed cases as seen for archive');
      // Still mark cases as seen even if no subscribers (for archival purposes)
      for (const pc of processedCases) {
        await markCaseSeen(env.DB, pc, 'ERA');
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
    .replace(/\bAnor\b/g, '& Anor');
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
