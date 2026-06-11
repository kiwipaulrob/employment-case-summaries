/**
 * pages.ts — Server-rendered HTML pages for the ERA Digest public site.
 *
 * All pages share a common shell (header, nav, footer) and are styled with
 * a clean, modern design. No external CSS or JavaScript dependencies — all
 * styles are inlined so there is nothing to load from a CDN.
 */

import type { DbSeenCase, DbSubscriber } from './types';
import type { CaseAwardWithCase } from './db';
import { toTitleCase, escapeHtml, decodeHtmlEntities, getSummaryExcerpt, summaryToPageHtml } from './utils';

// ─── Shared design tokens ────────────────────────────────────────────────────

const COLORS = {
  navy:     '#0f172a',
  navyMid:  '#1e3a5f',
  blue:     '#1d4ed8',
  blueHov:  '#1e40af',
  bg:       '#f8f9fa',
  white:    '#ffffff',
  text:     '#1e293b',
  muted:    '#64748b',
  border:   '#e2e8f0',
  success:  '#166534',
  successBg:'#dcfce7',
  error:    '#991b1b',
  errorBg:  '#fee2e2',
  badge:    '#dbeafe',
  badgeText:'#1e40af',
};

const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 16px; -webkit-text-size-adjust: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: ${COLORS.bg};
    color: ${COLORS.text};
    line-height: 1.6;
    min-height: 100vh;
  }
  a { color: ${COLORS.blue}; text-decoration: underline; }
  a:hover { color: ${COLORS.blueHov}; }
  .container { max-width: 720px; margin: 0 auto; padding: 0 20px; }

  /* Header */
  .site-header {
    background: ${COLORS.navy};
    padding: 16px 0;
  }
  .site-header .container {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .site-header a { color: ${COLORS.white}; text-decoration: none; }
  .site-header a:hover { color: #cbd5e1; }
  .logo-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    background: ${COLORS.blue};
    border-radius: 8px;
    font-size: 18px;
    font-weight: 700;
    color: white;
    flex-shrink: 0;
  }
  .site-name {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.3px;
    color: white;
  }
  .site-tagline {
    font-size: 13px;
    color: #94a3b8;
    margin-left: auto;
  }

  /* Page content */
  .page-content { padding: 48px 0 64px 0; }

  /* Hero */
  .hero { text-align: center; margin-bottom: 48px; }
  .hero h1 {
    font-size: 32px;
    font-weight: 700;
    letter-spacing: -0.5px;
    line-height: 1.2;
    margin-bottom: 12px;
    color: ${COLORS.navy};
  }
  .hero p {
    font-size: 17px;
    color: ${COLORS.muted};
    max-width: 520px;
    margin: 0 auto 28px auto;
  }

  /* Form card */
  .form-card {
    background: ${COLORS.white};
    border: 1px solid ${COLORS.border};
    border-radius: 12px;
    padding: 32px;
    margin-bottom: 48px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
  }
  .form-card h2 {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 20px;
    color: ${COLORS.navy};
  }
  .form-row { margin-bottom: 16px; }
  .form-row label {
    display: block;
    font-size: 14px;
    font-weight: 500;
    margin-bottom: 6px;
    color: ${COLORS.text};
  }
  .form-row input {
    width: 100%;
    padding: 10px 14px;
    font-size: 15px;
    border: 1px solid ${COLORS.border};
    border-radius: 8px;
    background: ${COLORS.bg};
    color: ${COLORS.text};
    outline: none;
    transition: border-color 0.15s;
    font-family: inherit;
  }
  .form-row input:focus {
    border-color: ${COLORS.blue};
    background: ${COLORS.white};
    box-shadow: 0 0 0 3px rgba(29,78,216,0.1);
  }
  .form-hint {
    font-size: 13px;
    color: ${COLORS.muted};
    margin-top: 4px;
  }
  .btn-primary {
    display: inline-block;
    background: ${COLORS.blue};
    color: white;
    font-size: 15px;
    font-weight: 600;
    padding: 11px 28px;
    border-radius: 8px;
    border: none;
    cursor: pointer;
    text-decoration: none;
    font-family: inherit;
    transition: background 0.15s;
    margin-top: 4px;
  }
  .btn-primary:hover { background: ${COLORS.blueHov}; color: white; }
  .btn-secondary {
    display: inline-block;
    background: transparent;
    color: ${COLORS.blue};
    font-size: 15px;
    font-weight: 500;
    padding: 10px 24px;
    border-radius: 8px;
    border: 1px solid ${COLORS.blue};
    cursor: pointer;
    text-decoration: none;
    font-family: inherit;
    transition: all 0.15s;
  }
  .btn-secondary:hover { background: ${COLORS.badge}; color: ${COLORS.blueHov}; }
  .btn-danger {
    display: inline-block;
    background: transparent;
    color: ${COLORS.error};
    font-size: 13px;
    font-weight: 500;
    padding: 5px 12px;
    border-radius: 6px;
    border: 1px solid ${COLORS.error};
    cursor: pointer;
    text-decoration: none;
    font-family: inherit;
  }
  .btn-danger:hover { background: ${COLORS.errorBg}; }

  /* Alert boxes */
  .alert {
    padding: 14px 18px;
    border-radius: 8px;
    font-size: 14px;
    margin-bottom: 20px;
  }
  .alert-success { background: ${COLORS.successBg}; color: ${COLORS.success}; border: 1px solid #86efac; }
  .alert-error { background: ${COLORS.errorBg}; color: ${COLORS.error}; border: 1px solid #fca5a5; }

  /* Filter checkboxes */
  .filter-form { margin-bottom: 16px; display: flex; gap: 16px; flex-wrap: wrap; }
  .filter-check { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; color: #555; cursor: pointer; }
  .filter-check input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; }
  .pref-row { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; }

  /* Section headings */
  .section-heading {
    font-size: 20px;
    font-weight: 700;
    color: ${COLORS.navy};
    margin-bottom: 20px;
    padding-bottom: 12px;
    border-bottom: 2px solid ${COLORS.border};
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .section-count {
    font-size: 14px;
    font-weight: 500;
    color: ${COLORS.muted};
  }

  /* Case cards */
  .case-card {
    background: ${COLORS.white};
    border: 1px solid ${COLORS.border};
    border-radius: 10px;
    padding: 22px 24px;
    margin-bottom: 14px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .case-card:hover { border-color: #c7d2fe; box-shadow: 0 2px 8px rgba(29,78,216,0.08); }
  .case-card-title {
    font-size: 16px;
    font-weight: 600;
    color: ${COLORS.navy};
    margin-bottom: 4px;
    line-height: 1.4;
  }
  .case-card-meta {
    font-size: 13px;
    color: ${COLORS.muted};
    margin-bottom: 10px;
  }
  .case-card-excerpt {
    font-size: 14px;
    color: #374151;
    line-height: 1.6;
  }
  .case-card-links { font-size: 13px; margin-top: 14px; }
  .case-card-links a { margin-right: 16px; font-weight: 500; }

  /* Expandable summary */
  details.case-expand { margin-top: 8px; }
  details.case-expand > summary {
    list-style: none;
    cursor: pointer;
    user-select: none;
  }
  details.case-expand > summary::-webkit-details-marker { display: none; }
  .expand-hint {
    display: inline-block;
    font-size: 13px;
    color: ${COLORS.blue};
    font-weight: 500;
    margin-top: 8px;
  }
  details[open] .expand-hint { display: none; }
  details[open] .case-card-excerpt { display: none; }
  .case-full-summary {
    padding-top: 14px;
    margin-top: 10px;
    border-top: 1px solid ${COLORS.border};
  }
  .show-less {
    display: inline-block;
    font-size: 13px;
    color: ${COLORS.blue};
    font-weight: 500;
    margin-top: 12px;
    cursor: pointer;
    background: none;
    border: none;
    padding: 0;
    font-family: inherit;
  }
  .show-less:hover { color: ${COLORS.blueHov}; }

  /* Summary section styles */
  .sum-label {
    font-size: 13px;
    font-weight: 700;
    color: ${COLORS.navy};
    margin-top: 14px;
    margin-bottom: 4px;
  }
  .sum-label:first-child { margin-top: 0; }
  .sum-body { font-size: 14px; color: #374151; line-height: 1.6; margin-bottom: 4px; }
  .sum-body p { margin: 0 0 6px 0; }
  .sum-body ol { margin: 4px 0 6px 0; padding-left: 20px; }
  .sum-body li { margin-bottom: 4px; }

  /* Status badges */
  .badge {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .badge-active { background: ${COLORS.successBg}; color: ${COLORS.success}; }
  .badge-pending { background: #fef9c3; color: #854d0e; }
  .badge-inactive { background: #f1f5f9; color: ${COLORS.muted}; }

  /* Centered content */
  .center-content {
    max-width: 480px;
    margin: 0 auto;
    text-align: center;
    padding: 32px 0;
  }
  .center-content .icon { font-size: 48px; margin-bottom: 16px; }
  .center-content h1 { font-size: 26px; font-weight: 700; margin-bottom: 12px; color: ${COLORS.navy}; }
  .center-content p { font-size: 16px; color: ${COLORS.muted}; margin-bottom: 24px; line-height: 1.6; }
  .center-content .actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }

  /* Admin table */
  .admin-table { width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 24px; }
  .admin-table th {
    text-align: left;
    padding: 10px 14px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: ${COLORS.muted};
    border-bottom: 2px solid ${COLORS.border};
    background: ${COLORS.bg};
  }
  .admin-table td {
    padding: 12px 14px;
    border-bottom: 1px solid ${COLORS.border};
    vertical-align: middle;
  }
  .admin-table tr:last-child td { border-bottom: none; }
  .admin-table tr:hover td { background: #f8faff; }

  /* Stats grid */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-bottom: 32px; }
  .stat-card { background: ${COLORS.white}; border: 1px solid ${COLORS.border}; border-radius: 10px; padding: 18px 20px; }
  .stat-value { font-size: 28px; font-weight: 700; color: ${COLORS.navy}; line-height: 1; margin-bottom: 4px; }
  .stat-label { font-size: 13px; color: ${COLORS.muted}; }

  /* Footer */
  .site-footer {
    background: ${COLORS.navy};
    color: #94a3b8;
    text-align: center;
    padding: 24px 20px;
    font-size: 13px;
  }
  .site-footer a { color: #cbd5e1; text-decoration: underline; }
  .site-footer a:hover { color: white; }

  /* Admin login */
  .login-card {
    background: ${COLORS.white};
    border: 1px solid ${COLORS.border};
    border-radius: 12px;
    padding: 40px 36px;
    max-width: 380px;
    margin: 64px auto;
    box-shadow: 0 4px 20px rgba(0,0,0,0.08);
  }
  .login-card h1 { font-size: 22px; font-weight: 700; color: ${COLORS.navy}; margin-bottom: 8px; }
  .login-card p { font-size: 14px; color: ${COLORS.muted}; margin-bottom: 24px; }

  @media (max-width: 600px) {
    .hero h1 { font-size: 26px; }
    .form-card, .case-card { padding: 20px 16px; }
    .site-tagline { display: none; }
    .stats-grid { grid-template-columns: 1fr 1fr; }
  }
`;

// ─── Shared shell ─────────────────────────────────────────────────────────────

function shell(title: string, body: string, extraCss = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} — ERA Digest</title>
<style>${BASE_CSS}${extraCss}</style>
</head>
<body>
<header class="site-header">
  <div class="container">
    <a href="/" style="display:flex;align-items:center;gap:10px;text-decoration:none;">
      <div class="logo-mark">E</div>
      <span class="site-name">ERA Digest</span>
    </a>
    <span class="site-tagline">NZ Employment Law Determinations</span>
  </div>
</header>
${body}
<footer class="site-footer">
  <div>
    &copy; ${new Date().getFullYear()} ERA Digest &mdash;
    Summaries are AI-generated. Always refer to the full determination.
  </div>
</footer>
</body>
</html>`;
}

// ─── Landing page ─────────────────────────────────────────────────────────────

export function homePage(
  cases: DbSeenCase[],
  error?: string,
  prefill?: { name?: string; email?: string; show_costs?: boolean; show_consent?: boolean },
  showCosts = false,
  showConsent = false,
  page = 1,
  totalCount = 0
): string {
  // Cases are pre-filtered server-side; just render them all
  const caseCount = cases.length;

  const caseCards = cases
    .filter(c => c.summary && !c.summary.startsWith('(seeded'))
    .map(c => {
      const title = toTitleCase(decodeHtmlEntities(c.title));
      const member = c.member ? decodeHtmlEntities(c.member) : null;
      const meta = [member, c.date_published].filter(Boolean).join(' \u00b7 ');
      const excerpt = getSummaryExcerpt(c.summary ?? '', 240);
      const fullHtml = summaryToPageHtml(c.summary ?? '');
      const pdfLink = c.pdf_url
        ? `<a href="${escapeHtml(c.pdf_url)}" target="_blank" rel="noopener">Download PDF</a>`
        : '';
      const caseLink = `<a href="${escapeHtml(c.case_url)}" target="_blank" rel="noopener">View on ERA website</a>`;

      const expandable = fullHtml ? `
<details class="case-expand">
  <summary>
    ${excerpt ? `<div class="case-card-excerpt">${escapeHtml(excerpt)}</div>` : ''}
    <span class="expand-hint">Read full summary ▾</span>
  </summary>
  <div class="case-full-summary">
    ${fullHtml}
    <button class="show-less" onclick="this.closest('details').removeAttribute('open');return false;">Show less ▴</button>
  </div>
</details>` : (excerpt ? `<div class="case-card-excerpt" style="margin-top:8px;">${escapeHtml(excerpt)}</div>` : '');

      return `<div class="case-card">
  <div class="case-card-title">${escapeHtml(title)}</div>
  ${meta ? `<div class="case-card-meta">${escapeHtml(meta)}</div>` : ''}
  ${expandable}
  <div class="case-card-links">${caseLink}${pdfLink ? ` ${pdfLink}` : ''}</div>
</div>`;
    })
    .join('\n');

  const errorAlert = error
    ? `<div class="alert alert-error">${escapeHtml(error)}</div>`
    : '';

  const nameVal = prefill?.name ? escapeHtml(prefill.name) : '';
  const emailVal = prefill?.email ? escapeHtml(prefill.email) : '';

  // Pagination calculations
  const PAGE_SIZE = 20;
  const totalPages = totalCount > 0 ? Math.ceil(totalCount / PAGE_SIZE) : 1;
  const filterParams = (showCosts ? '&show_costs=1' : '') + (showConsent ? '&show_consent=1' : '');
  const prevPage = page > 1 ? page - 1 : null;
  const nextPage = page < totalPages ? page + 1 : null;
  const startNum = totalCount > 0 ? (page - 1) * PAGE_SIZE + 1 : 0;
  const endNum = Math.min(page * PAGE_SIZE, totalCount);

  const paginationNav = totalPages > 1 ? `
<div style="display:flex;align-items:center;justify-content:space-between;margin-top:24px;padding-top:16px;border-top:1px solid ${COLORS.border};flex-wrap:wrap;gap:10px;">
  <span style="font-size:13px;color:${COLORS.muted};">Showing ${startNum}–${endNum} of ${totalCount} determinations</span>
  <div style="display:flex;gap:8px;">
    ${prevPage ? `<a href="/?page=${prevPage}${filterParams}" class="btn-secondary" style="font-size:13px;padding:7px 16px;">← Previous</a>` : '<span style="font-size:13px;color:#ccc;padding:7px 16px;border:1px solid #eee;border-radius:8px;">← Previous</span>'}
    <span style="font-size:13px;color:${COLORS.muted};padding:7px 4px;">Page ${page} of ${totalPages}</span>
    ${nextPage ? `<a href="/?page=${nextPage}${filterParams}" class="btn-secondary" style="font-size:13px;padding:7px 16px;">Next →</a>` : '<span style="font-size:13px;color:#ccc;padding:7px 16px;border:1px solid #eee;border-radius:8px;">Next →</span>'}
  </div>
</div>` : '';

  const archiveSection = totalCount > 0 ? `
<div class="section-heading">
  Recent determinations
  <span class="section-count">${totalCount} total</span>
</div>
<form method="GET" action="/" class="filter-form">
  <label class="filter-check">
    <input type="checkbox" name="show_costs" value="1"${showCosts ? ' checked' : ''} onchange="this.form.submit()">
    Show costs decisions
  </label>
  <label class="filter-check">
    <input type="checkbox" name="show_consent" value="1"${showConsent ? ' checked' : ''} onchange="this.form.submit()">
    Show consent orders
  </label>
  <noscript><button type="submit" class="btn-sm">Apply</button></noscript>
</form>
<p style="font-size:14px;color:${COLORS.muted};margin-bottom:20px;">
  AI-generated summaries &mdash; always refer to the full determination before acting.
</p>
${caseCards}
${paginationNav}` : '';

  const body = `
<div class="page-content">
  <div class="container">
    <div class="hero">
      <h1>Stay informed about NZ Employment law</h1>
      <p>Get a daily digest of new Employment Relations Authority determinations, summarised by AI and delivered to your inbox each morning.</p>
    </div>

    <div class="form-card">
      <h2>Subscribe for free</h2>
      ${errorAlert}
      <form method="POST" action="/subscribe" novalidate>
        <div class="form-row">
          <label for="name">First name <span style="color:${COLORS.muted};font-weight:400;">(optional)</span></label>
          <input type="text" id="name" name="name" value="${nameVal}" autocomplete="given-name" placeholder="e.g. Alex">
        </div>
        <div class="form-row">
          <label for="email">Email address</label>
          <input type="email" id="email" name="email" value="${emailVal}" required autocomplete="email" placeholder="you@example.com">
          <div class="form-hint">One email per day, only when new cases are published. Unsubscribe any time.</div>
        </div>
        <div class="form-row pref-row">
          <label class="filter-check">
            <input type="checkbox" name="show_costs" value="1"${prefill?.show_costs ? ' checked' : ''}>
            Include costs decisions
          </label>
          <label class="filter-check">
            <input type="checkbox" name="show_consent" value="1"${prefill?.show_consent ? ' checked' : ''}>
            Include consent orders
          </label>
        </div>
        <button type="submit" class="btn-primary">Subscribe &rarr;</button>
      </form>
    </div>

    ${archiveSection}
  </div>
</div>`;

  return shell('Subscribe', body);
}

// ─── Subscribed (check your email) page ──────────────────────────────────────

export function subscribedPage(email: string): string {
  const body = `
<div class="page-content">
  <div class="container">
    <div class="center-content">
      <div class="icon">📬</div>
      <h1>Check your inbox</h1>
      <p>We've sent a confirmation email to <strong>${escapeHtml(email)}</strong>. Click the link inside to activate your subscription.</p>
      <p style="font-size:14px;">Can't find it? Check your spam folder.</p>
      <div class="actions">
        <a href="/" class="btn-secondary">Back to home</a>
      </div>
    </div>
  </div>
</div>`;
  return shell('Check your inbox', body);
}

// ─── Confirmed page ───────────────────────────────────────────────────────────

export function confirmedPage(name: string): string {
  const greeting = name && name.toLowerCase() !== 'there' ? name : 'there';
  const body = `
<div class="page-content">
  <div class="container">
    <div class="center-content">
      <div class="icon">✅</div>
      <h1>You're subscribed, ${escapeHtml(greeting)}!</h1>
      <p>Your subscription to ERA Digest is now active. You'll receive a daily email whenever new Employment Relations Authority determinations are published.</p>
      <div class="actions">
        <a href="/" class="btn-primary">View recent cases</a>
      </div>
    </div>
  </div>
</div>`;
  return shell("You're subscribed", body);
}

// ─── Unsubscribed page ────────────────────────────────────────────────────────

export function unsubscribedPage(): string {
  const body = `
<div class="page-content">
  <div class="container">
    <div class="center-content">
      <div class="icon">👋</div>
      <h1>You've been unsubscribed</h1>
      <p>You won't receive any more emails from ERA Digest. If you change your mind, you're always welcome to subscribe again.</p>
      <div class="actions">
        <a href="/" class="btn-secondary">Subscribe again</a>
      </div>
    </div>
  </div>
</div>`;
  return shell('Unsubscribed', body);
}

// ─── Already unsubscribed page ────────────────────────────────────────────────

export function alreadyUnsubscribedPage(): string {
  const body = `
<div class="page-content">
  <div class="container">
    <div class="center-content">
      <div class="icon">ℹ️</div>
      <h1>Already unsubscribed</h1>
      <p>This email address is not currently subscribed to ERA Digest.</p>
      <div class="actions">
        <a href="/" class="btn-secondary">Back to home</a>
      </div>
    </div>
  </div>
</div>`;
  return shell('Already unsubscribed', body);
}

// ─── Invalid token page ───────────────────────────────────────────────────────

export function invalidTokenPage(): string {
  const body = `
<div class="page-content">
  <div class="container">
    <div class="center-content">
      <div class="icon">🔗</div>
      <h1>Link not valid</h1>
      <p>This link may have expired or already been used. If you need help, <a href="/">subscribe again</a> with your email address.</p>
      <div class="actions">
        <a href="/" class="btn-secondary">Back to home</a>
      </div>
    </div>
  </div>
</div>`;
  return shell('Invalid link', body);
}

// ─── Already subscribed page ──────────────────────────────────────────────────

export function alreadySubscribedPage(email: string): string {
  const body = `
<div class="page-content">
  <div class="container">
    <div class="center-content">
      <div class="icon">✉️</div>
      <h1>Already subscribed</h1>
      <p><strong>${escapeHtml(email)}</strong> is already an active subscriber. You'll receive the next digest when new cases are published.</p>
      <div class="actions">
        <a href="/" class="btn-secondary">Back to home</a>
      </div>
    </div>
  </div>
</div>`;
  return shell('Already subscribed', body);
}

// ─── Preferences page ──────────────────────────────────────────────────────────

export function preferencesPage(
  subscriber: { email: string; name: string | null; preferences: string },
  saved?: boolean,
  unsubscribed?: boolean
): string {
  let prefs = { show_costs: false, show_consent: false };
  try { prefs = JSON.parse(subscriber.preferences); } catch {}
  const msg = unsubscribed
    ? '<div class="alert alert-success"><strong>✓ Unsubscribed.</strong> You will no longer receive ERA Digest emails.</div>'
    : saved
    ? '<div class="alert alert-success"><strong>✓ Preferences saved.</strong></div>'
    : '';

  const body = `
<div class="page-content">
  <div class="container">
    <div class="center-content">
      <h1>Your preferences</h1>
      <p style="margin-bottom: 1.5rem; color: #666;">
        For <strong>${escapeHtml(subscriber.email)}</strong>
      </p>
      ${msg}
      <form method="POST" action="/preferences" style="text-align: left; max-width: 400px; margin: 0 auto;">
        <input type="hidden" name="token" value="${escapeHtml(subscriber.email)}">
        <div class="pref-row" style="margin-bottom: 1rem;">
          <label class="filter-check" style="display: block; margin-bottom: 0.5rem;">
            <input type="checkbox" name="show_costs" value="1"${prefs.show_costs ? ' checked' : ''}>
            Include costs decisions
          </label>
          <label class="filter-check" style="display: block;">
            <input type="checkbox" name="show_consent" value="1"${prefs.show_consent ? ' checked' : ''}>
            Include consent orders
          </label>
        </div>
        <button type="submit" class="btn-primary" style="width: 100%;">Update preferences</button>
      </form>
      <div class="actions" style="margin-top: 2rem;">
        <a href="/unsubscribe?token=${encodeURIComponent(subscriber.email)}" class="btn-secondary" style="color: #c00;" onclick="return confirm('Unsubscribe from all ERA Digest emails?')">Unsubscribe from all</a>
      </div>
      <div class="actions" style="margin-top: 1rem;">
        <a href="/" class="btn-secondary">Back to home</a>
      </div>
    </div>
  </div>
</div>`;
  return shell('Preferences', body);
}

// ─── Admin login page ─────────────────────────────────────────────────────────

export function adminLoginPage(error?: string): string {
  const errorAlert = error
    ? `<div class="alert alert-error" style="margin-bottom:20px;">${escapeHtml(error)}</div>`
    : '';

  const body = `
<div class="page-content">
  <div class="login-card">
    <h1>Admin</h1>
    <p>Enter the admin password to continue.</p>
    ${errorAlert}
    <form method="POST" action="/admin">
      <div class="form-row">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autofocus>
      </div>
      <button type="submit" class="btn-primary" style="width:100%;margin-top:8px;text-align:center;">
        Sign in
      </button>
    </form>
  </div>
</div>`;

  return shell('Admin login', body);
}

// ─── Admin dashboard page ─────────────────────────────────────────────────────

export interface AdminStats {
  lastRunAt: string | null;
  lastEmailSentAt: string | null;
  totalCases: number;
}

export function adminPage(subscribers: DbSubscriber[], stats: AdminStats): string {
  const active = subscribers.filter(s => s.active === 1 && s.confirmed === 1).length;
  const pending = subscribers.filter(s => s.confirmed === 0).length;
  const inactive = subscribers.filter(s => s.active === 0 && s.confirmed === 1).length;

  const statsHtml = `
<div class="stats-grid">
  <div class="stat-card">
    <div class="stat-value">${active}</div>
    <div class="stat-label">Active subscribers</div>
  </div>
  <div class="stat-card">
    <div class="stat-value">${pending}</div>
    <div class="stat-label">Pending confirmation</div>
  </div>
  <div class="stat-card">
    <div class="stat-value">${stats.totalCases}</div>
    <div class="stat-label">Cases summarised</div>
  </div>
  <div class="stat-card">
    <div class="stat-value" style="font-size:16px;padding-top:4px;">${stats.lastEmailSentAt ? formatDate(stats.lastEmailSentAt) : 'Never'}</div>
    <div class="stat-label">Last email sent</div>
  </div>
</div>`;

  const rows = subscribers.map(s => {
    let badgeHtml: string;
    if (s.confirmed === 0) {
      badgeHtml = '<span class="badge badge-pending">Pending</span>';
    } else if (s.active === 1) {
      badgeHtml = '<span class="badge badge-active">Active</span>';
    } else {
      badgeHtml = '<span class="badge badge-inactive">Unsubscribed</span>';
    }

    const deleteForm = `
<form method="POST" action="/admin/delete-subscriber" onsubmit="return confirm('Delete ${escapeHtml(s.email)}?');" style="display:inline;">
  <input type="hidden" name="id" value="${s.id}">
  <button type="submit" class="btn-danger">Delete</button>
</form>`;

    return `<tr>
  <td>${escapeHtml(s.name ?? '—')}</td>
  <td>${escapeHtml(s.email)}</td>
  <td>${badgeHtml}</td>
  <td style="color:${COLORS.muted};font-size:12px;">${formatDate(s.created_at)}</td>
  <td>${deleteForm}</td>
</tr>`;
  }).join('\n');

  const tableHtml = subscribers.length === 0
    ? `<p style="color:${COLORS.muted};font-style:italic;">No subscribers yet.</p>`
    : `<div style="overflow-x:auto;">
<table class="admin-table">
  <thead>
    <tr>
      <th>Name</th>
      <th>Email</th>
      <th>Status</th>
      <th>Joined</th>
      <th>Actions</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
</div>`;

  const lastRun = stats.lastRunAt ? formatDate(stats.lastRunAt) : 'Never';

  const body = `
<div class="page-content">
  <div class="container">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;flex-wrap:wrap;gap:12px;">
      <h1 style="font-size:24px;font-weight:700;color:${COLORS.navy};">Admin Dashboard</h1>
      <span style="font-size:13px;color:${COLORS.muted};">Last pipeline run: ${escapeHtml(lastRun)}</span>
    </div>

    ${statsHtml}

    <div class="section-heading">Subscribers</div>
    ${tableHtml}

    <div style="margin-top:32px;padding-top:24px;border-top:1px solid ${COLORS.border};">
      <h3 style="font-size:16px;font-weight:600;margin-bottom:14px;color:${COLORS.navy};">Pipeline actions</h3>
      <div style="display:flex;flex-wrap:wrap;gap:10px;">
        <a href="/admin/logout" class="btn-secondary" style="font-size:13px;padding:8px 16px;">Sign out</a>
      </div>
      <p style="font-size:12px;color:${COLORS.muted};margin-top:14px;">
        API endpoints (require <code>Authorization: Bearer &lt;secret&gt;</code> header):
        <code>/run</code> &middot; <code>/admin/send-digest</code> &middot; <code>/admin/status</code>
      </p>
    </div>
  </div>
</div>`;

  return shell('Admin', body);
}

// ─── Awards & Damages page ────────────────────────────────────────────────────

export function awardsPage(rows: CaseAwardWithCase[]): string {
  // ── Stat helpers ──────────────────────────────────────────────────────────
  function median(arr: number[]): number | null {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }
  function avg(arr: number[]): number | null {
    if (arr.length === 0) return null;
    return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  }
  function fmtDollar(n: number | null | undefined): string {
    if (n === null || n === undefined || n === 0) return '—';
    return '$' + n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmtWeeks(n: number | null | undefined): string {
    if (n === null || n === undefined || n === 0) return '—';
    return n % 1 === 0 ? `${n} wks` : `${n.toFixed(1)} wks`;
  }

  // ── Compute stats ─────────────────────────────────────────────────────────
  const hhdArr   = rows.filter(r => r.hhd_amount   != null && r.hhd_amount   > 0).map(r => r.hhd_amount!);
  const wagesArr = rows.filter(r => r.lost_wages    != null && r.lost_wages   > 0).map(r => r.lost_wages!);
  const weeksArr = rows.filter(r => r.lost_wages_weeks != null && r.lost_wages_weeks > 0).map(r => r.lost_wages_weeks!);

  const statsHHD   = { avg: avg(hhdArr), median: median(hhdArr), max: hhdArr.length ? Math.max(...hhdArr) : null, count: hhdArr.length };
  const statsWages = { avg: avg(wagesArr), median: median(wagesArr), max: wagesArr.length ? Math.max(...wagesArr) : null, count: wagesArr.length };
  const statsWeeks = { avg: weeksArr.length ? Math.round((weeksArr.reduce((a,b)=>a+b,0)/weeksArr.length)*10)/10 : null, max: weeksArr.length ? Math.max(...weeksArr) : null };

  const reinstatementCount = rows.filter(r => r.reinstatement === 1).length;
  const applicantWins  = rows.filter(r => r.outcome === 'applicant').length;
  const respondentWins = rows.filter(r => r.outcome === 'respondent').length;
  const mixedOutcomes  = rows.filter(r => r.outcome === 'mixed').length;
  const total = rows.length;

  // ── HHD distribution chart ─────────────────────────────────────────────────
  const buckets = [
    { label: 'Nil', count: rows.filter(r => !r.hhd_amount || r.hhd_amount === 0).length },
    { label: '$1–5k',  count: hhdArr.filter(n => n >= 1    && n <= 5000 ).length },
    { label: '$5–10k', count: hhdArr.filter(n => n > 5000  && n <= 10000).length },
    { label: '$10–20k',count: hhdArr.filter(n => n > 10000 && n <= 20000).length },
    { label: '$20–40k',count: hhdArr.filter(n => n > 20000 && n <= 40000).length },
    { label: '$40k+',  count: hhdArr.filter(n => n > 40000).length },
  ];
  const maxBucketCount = Math.max(...buckets.map(b => b.count), 1);
  const chartH = 160;
  const barW = 52;
  const gap = 18;
  const leftPad = 28;
  const topPad = 24;
  const svgW = leftPad + buckets.length * (barW + gap) - gap + 4;
  const svgH = chartH + topPad + 38;

  const chartBars = buckets.map((b, i) => {
    const h = Math.max(Math.round((b.count / maxBucketCount) * chartH), b.count > 0 ? 4 : 0);
    const x = leftPad + i * (barW + gap);
    const y = topPad + chartH - h;
    const fill = b.count === 0 ? '#e2e8f0' : (i === 0 ? '#94a3b8' : '#1d4ed8');
    return `
  <rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${fill}" rx="3"/>
  ${b.count > 0 ? `<text x="${x + barW / 2}" y="${y - 6}" text-anchor="middle" font-size="12" fill="#374151" font-weight="600">${b.count}</text>` : ''}
  <text x="${x + barW / 2}" y="${topPad + chartH + 16}" text-anchor="middle" font-size="11" fill="#64748b">${b.label}</text>`;
  }).join('');

  const chart = `
<svg viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" style="overflow:visible;display:block;">
  <text x="10" y="${topPad + chartH / 2}" text-anchor="middle" font-size="10" fill="#94a3b8"
    transform="rotate(-90,10,${topPad + chartH / 2})">Cases</text>
  ${chartBars}
</svg>`;

  // ── Case table ─────────────────────────────────────────────────────────────
  const outcomeLabel: Record<string, string> = {
    applicant: 'Applicant ✓', respondent: 'Respondent ✓', mixed: 'Mixed', none: '—',
  };
  const outcomeColor: Record<string, string> = {
    applicant: `color:${COLORS.success};font-weight:600;`,
    respondent: `color:${COLORS.error};font-weight:600;`,
    mixed: 'color:#b45309;font-weight:600;',
    none: `color:${COLORS.muted};`,
  };

  const tableRows = rows.map(r => {
    const title = toTitleCase(decodeHtmlEntities(r.title));
    const citation = r.category ? escapeHtml(r.category) : '';
    const outcome = r.outcome ?? 'none';
    return `<tr>
  <td style="font-weight:500;">${escapeHtml(title)}${citation ? `<br><span style="font-size:12px;color:${COLORS.muted};">${citation}</span>` : ''}</td>
  <td style="text-align:right;">${fmtDollar(r.hhd_amount)}</td>
  <td style="text-align:right;">${fmtDollar(r.lost_wages)}</td>
  <td style="text-align:right;">${fmtWeeks(r.lost_wages_weeks)}</td>
  <td style="text-align:right;">${fmtDollar(r.costs_awarded)}</td>
  <td style="text-align:center;">${r.reinstatement ? '✓' : '—'}</td>
  <td style="${outcomeColor[outcome] ?? ''}">${outcomeLabel[outcome] ?? '—'}</td>
  <td style="font-size:12px;">${r.pdf_url ? `<a href="${escapeHtml(r.pdf_url)}" target="_blank" rel="noopener">PDF</a>` : '—'}</td>
</tr>`;
  }).join('\n');

  const emptyState = total === 0
    ? `<div style="text-align:center;padding:48px 0;color:${COLORS.muted};">
        <p style="font-size:32px;margin-bottom:12px;">📊</p>
        <p style="font-size:16px;">No awards data yet.</p>
        <p style="font-size:14px;margin-top:8px;">Awards are extracted automatically from new ERA determinations, or can be backfilled from the admin dashboard.</p>
      </div>`
    : '';

  const extraCss = `
  .awards-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-bottom:32px; }
  .awards-stat { background:${COLORS.white}; border:1px solid ${COLORS.border}; border-radius:10px; padding:16px 18px; }
  .awards-stat-value { font-size:24px; font-weight:700; color:${COLORS.navy}; line-height:1.1; margin-bottom:4px; }
  .awards-stat-label { font-size:12px; color:${COLORS.muted}; }
  .awards-section { background:${COLORS.white}; border:1px solid ${COLORS.border}; border-radius:10px; padding:24px; margin-bottom:24px; }
  .awards-section h2 { font-size:16px; font-weight:700; color:${COLORS.navy}; margin-bottom:16px; }
  .awards-table { width:100%; border-collapse:collapse; font-size:13px; }
  .awards-table th { text-align:left; padding:8px 10px; font-size:11px; font-weight:600; text-transform:uppercase;
    letter-spacing:0.4px; color:${COLORS.muted}; border-bottom:2px solid ${COLORS.border}; background:${COLORS.bg}; white-space:nowrap; }
  .awards-table th.right { text-align:right; }
  .awards-table th.center { text-align:center; }
  .awards-table td { padding:10px 10px; border-bottom:1px solid ${COLORS.border}; vertical-align:middle; }
  .awards-table tr:last-child td { border-bottom:none; }
  .awards-table tr:hover td { background:#f8faff; }
  .stat-row-label { font-size:13px; font-weight:600; color:${COLORS.navy}; margin-bottom:10px; }
  @media(max-width:600px){ .awards-stats{grid-template-columns:1fr 1fr;} .awards-table{font-size:12px;} }
  `;

  const body = `
<div class="page-content">
  <div class="container">
    <div class="hero" style="margin-bottom:32px;">
      <h1>Awards &amp; Damages</h1>
      <p>Remedy data extracted from ERA determinations. ${total > 0 ? `${total} case${total !== 1 ? 's' : ''} analysed.` : 'No data yet.'}</p>
    </div>

    ${total === 0 ? emptyState : `
    <!-- HHD stats -->
    <p class="stat-row-label">Hurt, humiliation &amp; distress</p>
    <div class="awards-stats">
      <div class="awards-stat">
        <div class="awards-stat-value">${fmtDollar(statsHHD.avg)}</div>
        <div class="awards-stat-label">Average HHD</div>
      </div>
      <div class="awards-stat">
        <div class="awards-stat-value">${fmtDollar(statsHHD.median)}</div>
        <div class="awards-stat-label">Median HHD</div>
      </div>
      <div class="awards-stat">
        <div class="awards-stat-value">${fmtDollar(statsHHD.max)}</div>
        <div class="awards-stat-label">Highest HHD</div>
      </div>
      <div class="awards-stat">
        <div class="awards-stat-value">${statsHHD.count}</div>
        <div class="awards-stat-label">Cases with HHD award</div>
      </div>
    </div>

    <!-- Lost wages stats -->
    <p class="stat-row-label">Lost wages</p>
    <div class="awards-stats">
      <div class="awards-stat">
        <div class="awards-stat-value">${fmtDollar(statsWages.avg)}</div>
        <div class="awards-stat-label">Average lost wages</div>
      </div>
      <div class="awards-stat">
        <div class="awards-stat-value">${fmtDollar(statsWages.median)}</div>
        <div class="awards-stat-label">Median lost wages</div>
      </div>
      <div class="awards-stat">
        <div class="awards-stat-value">${statsWeeks.avg !== null ? statsWeeks.avg.toFixed(1) + ' wks' : '—'}</div>
        <div class="awards-stat-label">Avg weeks of salary</div>
      </div>
      <div class="awards-stat">
        <div class="awards-stat-value">${statsWeeks.max !== null ? statsWeeks.max.toFixed(1) + ' wks' : '—'}</div>
        <div class="awards-stat-label">Highest weeks of salary</div>
      </div>
    </div>

    <!-- Outcomes -->
    <p class="stat-row-label">Outcomes</p>
    <div class="awards-stats" style="margin-bottom:32px;">
      <div class="awards-stat">
        <div class="awards-stat-value" style="color:${COLORS.success};">${applicantWins}</div>
        <div class="awards-stat-label">Applicant wins</div>
      </div>
      <div class="awards-stat">
        <div class="awards-stat-value" style="color:${COLORS.error};">${respondentWins}</div>
        <div class="awards-stat-label">Respondent wins</div>
      </div>
      <div class="awards-stat">
        <div class="awards-stat-value" style="color:#b45309;">${mixedOutcomes}</div>
        <div class="awards-stat-label">Mixed outcomes</div>
      </div>
      <div class="awards-stat">
        <div class="awards-stat-value">${reinstatementCount}</div>
        <div class="awards-stat-label">Reinstatement orders</div>
      </div>
    </div>

    <!-- HHD Distribution chart -->
    <div class="awards-section">
      <h2>HHD award distribution</h2>
      <div style="overflow-x:auto;padding-bottom:4px;">
        ${chart}
      </div>
      <p style="font-size:12px;color:${COLORS.muted};margin-top:12px;">Distribution of hurt, humiliation &amp; distress awards across ${total} ERA cases.</p>
    </div>

    <!-- Case detail table -->
    <div class="awards-section" style="overflow-x:auto;">
      <h2>Case detail</h2>
      <table class="awards-table">
        <thead>
          <tr>
            <th>Case</th>
            <th class="right">HHD</th>
            <th class="right">Lost wages</th>
            <th class="right">Weeks</th>
            <th class="right">Costs</th>
            <th class="center">Reinstate</th>
            <th>Outcome</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>
    `}

    <p style="font-size:12px;color:${COLORS.muted};margin-top:8px;">
      Data is AI-extracted from case summaries. Figures should be verified against the full determination before relying on them.
      Awards data covers ERA determinations only.
    </p>
  </div>
</div>`;

  return shell('Awards & Damages', body, extraCss);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-NZ', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Pacific/Auckland',
    });
  } catch {
    return iso;
  }
}
