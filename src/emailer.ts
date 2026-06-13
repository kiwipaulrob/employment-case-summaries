/**
 * emailer.ts — Email composition and sending via Cloudflare Email Service.
 *
 * Constructs a multipart/alternative MIME email (HTML + plain text fallback)
 * and sends it using the Workers Email Service binding.
 *
 * The HTML template is intentionally minimal:
 *   - Clean typography suitable for legal professionals
 *   - No tracking pixels, no external resources, no JavaScript
 *   - Renders well in Outlook, Gmail, and Apple Mail
 *
 * To replace Cloudflare Email Service with another provider (e.g. Resend,
 * SendGrid), update only the sendEmail() function below — the rest is unchanged.
 */

import { EmailMessage } from 'cloudflare:email';
import type { ProcessedCase, DbSubscriber } from './types';
import { toTitleCase, escapeHtml, decodeHtmlEntities } from './utils';

/**
 * Italicizes case citations when they appear in narrative text.
 * Looks for patterns like "Case Name v Other [20xx] NZERA 123" or "Case Name v Other"
 * and wraps them in <i> tags.
 * Called AFTER escapeHtml so HTML is already safe.
 */
function italicizeCaseCitations(text: string): string {
  // Pattern: "Word v Word ... [20xx] NZERA|NZEmpC 123"
  // Or simpler: "Word v Word" patterns (but only in legal context, so we look for citation first)
  
  // Match full case citations like "[2026] NZERA 229" or "[2026] NZEmpC 73"
  // Prefix with "word v word" or "Name v Name and Name" etc.
  text = text.replace(
    /([A-Za-z][A-Za-z0-9\s.,&'-]*?)\s+v\s+([A-Za-z][A-Za-z0-9\s.,&'-]*?)\s*(\[20\d{2}\]\s*NZ(?:ERA|EmpC)\s*\d+)/g,
    '<i>$1 v $2 $3</i>'
  );
  
  return text;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SendEmailParams {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Pass the raw env.EMAIL binding — must be called as binding.send() to preserve `this` */
  emailBinding: SendEmail;
}

// ─── Email construction ───────────────────────────────────────────────────────

/**
 * Builds the full email content (subject + HTML + text) for a digest run.
 * @param unsubscribeUrl  Per-subscriber unsubscribe URL (personalised).
 */
export function buildDigestEmail(
  cases: ProcessedCase[],
  timezone: string,
  unsubscribeUrl = 'https://whenroutinebiteshard.com/unsubscribe',
  notice?: string
): { subject: string; html: string; text: string } {
  const dateStr = new Date().toLocaleDateString('en-NZ', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const n = cases.length;
  const subject = `ERA Determinations — ${n} new case${n === 1 ? '' : 's'} — ${dateStr}`;

  const html = buildHtml(cases, dateStr, unsubscribeUrl, notice);
  const text = buildPlainText(cases, dateStr, unsubscribeUrl, notice);

  return { subject, html, text };
}

/**
 * Builds a confirmation email for new subscribers.
 */
export function buildConfirmationEmail(
  name: string | null,
  confirmUrl: string,
  siteUrl: string
): { subject: string; html: string; text: string } {
  const greeting = name ? `Hi ${name},` : 'Hello,';
  const subject = 'Confirm your ERA Digest subscription';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Confirm your subscription</title>
</head>
<body style="font-family: Georgia, 'Times New Roman', serif; font-size: 16px; line-height: 1.7; color: #1a1a1a; background: #ffffff; margin: 0; padding: 0;">
<div style="max-width: 560px; margin: 0 auto; padding: 40px 24px;">
  <div style="border-bottom: 2px solid #1a1a1a; padding-bottom: 16px; margin-bottom: 32px;">
    <p style="font-family: Arial, sans-serif; font-size: 13px; color: #555; margin: 0 0 4px 0; text-transform: uppercase; letter-spacing: 0.6px;">ERA Digest</p>
    <h1 style="font-size: 22px; margin: 0;">Confirm your subscription</h1>
  </div>

  <p>${escapeHtml(greeting)}</p>

  <p>You've signed up to receive ERA Digest — daily summaries of new Employment Relations Authority determinations, delivered to your inbox each morning.</p>

  <p>To activate your subscription, please confirm your email address:</p>

  <div style="margin: 32px 0; text-align: center;">
    <a href="${escapeHtml(confirmUrl)}"
       style="display: inline-block; background: #1d4ed8; color: white; font-family: Arial, sans-serif;
              font-size: 15px; font-weight: 600; padding: 13px 32px; border-radius: 8px;
              text-decoration: none; letter-spacing: 0.2px;">
      Confirm subscription &rarr;
    </a>
  </div>

  <p style="font-size: 14px; color: #666;">Or copy and paste this link into your browser:</p>
  <p style="font-size: 13px; color: #1d4ed8; word-break: break-all;">${escapeHtml(confirmUrl)}</p>

  <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #888; font-family: Arial, sans-serif;">
    <p>If you didn't sign up for ERA Digest, you can safely ignore this email — you won't receive anything further.</p>
    <p>This link expires after 7 days.</p>
  </div>
</div>
</body>
</html>`;

  const text = `${greeting}

You've signed up to receive ERA Digest — daily summaries of new Employment Relations Authority determinations.

To activate your subscription, visit:
${confirmUrl}

If you didn't sign up for ERA Digest, please ignore this email.

—ERA Digest
${siteUrl}`;

  return { subject, html, text };
}

/**
 * Builds an admin alert email for unexpected errors.
 */
export function buildAlertEmail(errorMessage: string): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `⚠️ ERA Digest — Run error at ${new Date().toISOString()}`;
  const body = `The ERA Digest Worker encountered an error during its scheduled run:\n\n${errorMessage}\n\nPlease check the Worker logs in the Cloudflare dashboard.`;
  return {
    subject,
    html: `<pre style="font-family: monospace; white-space: pre-wrap;">${escapeHtml(body)}</pre>`,
    text: body,
  };
}

// ─── HTML template ────────────────────────────────────────────────────────────

function buildHtml(cases: ProcessedCase[], dateStr: string, unsubscribeUrl: string, notice?: string): string {
  // Separate cases by source
  const ecCases = cases.filter(c => c.source === 'EMPLOYMENT_COURT');
  const eraCases = cases.filter(c => c.source === 'ERA');

  // Build sections for each source
  let sectionsHtml = '';

  // Employment Court section (first if present)
  if (ecCases.length > 0) {
    const ecCaseSections = ecCases
      .map((c, i) => buildCaseHtml(c, true))
      .join('\n<hr style="border:none;border-top:1px solid #ccc;margin:20px 0 10px 0;">\n');
    
    sectionsHtml += `<div class="section">
  <div class="source-header">
    <h2 style="font-size: 18px; margin: 0 0 4px 0; letter-spacing: -0.3px; font-weight: bold; color: #1a1a1a;">Employment Court</h2>
    <p style="font-size: 14px; color: #555; margin: 0; font-family: Arial, sans-serif;">New judgments &mdash; ${escapeHtml(dateStr)}</p>
  </div>
  ${ecCaseSections}
</div>`;
  }

  // ERA section (second if present)
  if (eraCases.length > 0) {
    const eraCaseSections = eraCases
      .map((c, i) => buildCaseHtml(c, ecCases.length === 0 && i === 0))
      .join('\n<hr style="border:none;border-top:1px solid #ccc;margin:20px 0 10px 0;">\n');
    
    // Add separator between sections if both exist
    const separator = ecCases.length > 0 
      ? '<hr style="border:none;border-top:2px solid #1a1a1a;margin:48px 0 36px 0;"></hr>'
      : '';
    
    sectionsHtml += `${separator}<div class="section">
  <div class="source-header">
    <h2 style="font-size: 18px; margin: 0 0 4px 0; letter-spacing: -0.3px; font-weight: bold; color: #1a1a1a;">Employment Relations Authority</h2>
    <p style="font-size: 14px; color: #555; margin: 0; font-family: Arial, sans-serif;">New determinations &mdash; ${escapeHtml(dateStr)}</p>
  </div>
  ${eraCaseSections}
</div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ERA Determinations Digest</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 16px; line-height: 1.7;
         color: #1a1a1a; background: #ffffff; margin: 0; padding: 0; }
  .wrapper { max-width: 680px; margin: 0 auto; padding: 24px 20px; }
  .section { margin-bottom: 20px; }
  .source-header { padding-bottom: 16px; margin-bottom: 36px; border-bottom: 2px solid #1a1a1a; }
  .case-block { padding: 20px 0 40px 0; }
  .case-title { font-size: 17px; font-weight: bold; margin: 0 0 8px 0; line-height: 1.4; }
  .case-meta { font-size: 13px; color: #666; font-family: Arial, sans-serif;
               margin-bottom: 28px; }
  .section-label { font-family: Arial, sans-serif; font-size: 14px; font-weight: bold;
                   color: #1a1a1a; margin: 28px 0 6px 0; }
  .section-body { margin: 0; font-size: 15px; font-weight: normal; }
  .section-body ol { margin: 4px 0 0 0; padding-left: 22px; }
  .section-body ol li { margin-bottom: 8px; padding-left: 4px; }
  .case-links { margin-top: 28px; font-family: Arial, sans-serif; font-size: 13px; }
  .case-links a { color: #1a1a1a; text-decoration: underline; margin-right: 20px; }
  .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee;
            font-size: 12px; color: #888; font-family: Arial, sans-serif; }
  .disclaimer { font-size: 12px; color: #888; font-style: italic;
                margin-top: 8px; font-family: Arial, sans-serif; }
</style>
</head>
<body>
<div class="wrapper">

  ${notice ? `<div style="background:#fef3c7;border:1px solid #d97706;border-radius:6px;padding:16px 20px;margin-bottom:32px;font-family:Arial,sans-serif;font-size:14px;color:#92400e;line-height:1.6;"><strong>Note:</strong> ${escapeHtml(notice)}</div>` : ''}

  ${sectionsHtml}

  <div class="footer">
    <p>You are receiving this digest because you subscribed at <a href="https://whenroutinebiteshard.com">whenroutinebiteshard.com</a>. To unsubscribe, <a href="${escapeHtml(unsubscribeUrl)}">click here</a>.</p>
    <p class="disclaimer">&#9888;&#65039; Summaries are AI-generated. Always refer to the full determination. This is not legal advice.</p>
  </div>
</div>
</body>
</html>`;
}

function buildCaseHtml(c: ProcessedCase, isFirst: boolean): string {
  const member = c.member ? decodeHtmlEntities(c.member) : null;
  const meta = [c.datePublished, c.category].filter(Boolean).join(' · ');

  const summaryHtml = summaryToHtml(c.summary, c.caseUrl, c.pdfUrl);
  const linksHtml = buildLinksHtml(c.source, c.pdfUrl);

  const topPadding = isFirst ? '20px' : '16px';

  // Build member sentence if available
  const memberSentence = member
    ? `<p class="case-member" style="font-size: 13px; color: #555; font-family: Arial, sans-serif; margin: -4px 0 4px 0;">This case was determined by ${escapeHtml(member)}.</p>`
    : '';

  return `<div class="case-block" style="padding: ${topPadding} 0 40px 0;">
  <p class="case-title">${escapeHtml(toTitleCase(decodeHtmlEntities(c.title)))}</p>
  ${memberSentence}
  ${meta ? `<p class="case-meta">${escapeHtml(meta)}</p>` : ''}
  ${summaryHtml}
  ${linksHtml}
</div>`;
}

function buildLinksHtml(source: string, pdfUrl: string | null): string {
  // Different "View case summary" links by source
  const viewLink = source === 'EMPLOYMENT_COURT'
    ? 'https://www.employmentcourt.govt.nz/judgments/decisions/?Filter_Jurisdiction=17'
    : 'https://determinations.era.govt.nz/determinations/recent';

  const links = [
    `<a href="${escapeHtml(viewLink)}">View case summary</a>`,
  ];
  if (pdfUrl) {
    links.push(`<a href="${escapeHtml(pdfUrl)}">Download PDF</a>`);
  }
  return `<div class="case-links">${links.join('\n  ')}</div>`;
}

/**
 * Converts `**text**` markdown bold markers to HTML `<strong>` tags.
 * Applied after HTML escaping so special chars are already safe.
 */
function convertBold(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/**
 * Converts the LLM's plain-text structured summary into styled HTML.
 */
function summaryToHtml(summary: string, _caseUrl: string, _pdfUrl: string | null): string {
  if (
    summary.startsWith('Summary unavailable') ||
    summary.includes('SUMMARY_UNAVAILABLE')
  ) {
    return `<p style="color: #c00;">${escapeHtml(summary)}</p>`;
  }

  // Strip the DOCUMENT TYPE FLAG section entirely
  let cleaned = summary;
  const dtfMatch = cleaned.match(/^DOCUMENT TYPE FLAG\s*\n(\[.*?\](?:\s*:.*?)?\s*\n?)/m);
  if (dtfMatch) {
    cleaned = cleaned.replace(/^DOCUMENT TYPE FLAG\s*\n(\[.*?\](?:\s*:.*?)?\s*\n?)/m, '');
  }
  // Also handle inline format where the flag content is on the same line or next line without brackets
  cleaned = cleaned.replace(/^DOCUMENT TYPE FLAG.*(?:\n\[.*?\].*)?$/m, '').trim();

  const SECTION_LABEL_MAP: Record<string, string> = {
    'JUDGE & DATE': 'Judge & Date',
    'PARTIES': 'Parties',
    'REPRESENTATIVES': 'Representatives',
    'FACTS': 'Facts',
    'ERA FINDINGS': 'ERA Findings',
    'EMPLOYMENT COURT ISSUES RAISED': 'Employment Court Issues Raised',
    'HOW THE EMPLOYMENT COURT ISSUES WERE RESOLVED': 'How the Employment Court Issues Were Resolved',
    'LEGAL ISSUES': 'Legal issues',
    'EXECUTIVE SUMMARY': 'Executive Summary',
    'HOW THE ISSUES WERE RESOLVED': 'How the issues were resolved',
    'OUTCOME': 'Outcome',
    'REMEDY': 'Remedy',
  };

  const SECTION_LABELS = Object.keys(SECTION_LABEL_MAP);

  const lines = cleaned.split('\n');
  const parts: string[] = [];
  let currentLabel = '';
  let currentLines: string[] = [];

  function flushSection() {
    if (!currentLabel && currentLines.length === 0) return;
    if (currentLabel) {
      const displayLabel = SECTION_LABEL_MAP[currentLabel] ?? currentLabel;
      parts.push(`<p class="section-label">${escapeHtml(displayLabel)}</p>`);
    }
    const content = currentLines.join('\n').trim();
    if (content) {
      if (content.includes('\n•') || content.startsWith('•') ||
          /^\d+[.)]\s/.test(content)) {
        const items = content
          .split('\n')
          .map((l) => l.replace(/^\d+[.)]\s*/, '').replace(/^[•\-]\s*/, '').trim())
          .filter(Boolean);
        const listHtml = items.map((i) => {
          const escaped = escapeHtml(i);
          const italicized = italicizeCaseCitations(escaped);
          const bolded = convertBold(italicized);
          return `<li>${bolded}</li>`;
        }).join('\n');
        parts.push(`<div class="section-body"><ol>${listHtml}</ol></div>`);
      } else {
        const paras = content
          .split(/\n{2,}/)
          .map((p) => p.trim())
          .filter(Boolean);
        const paraHtml = paras
          .map((p) => {
            const escaped = escapeHtml(p).replace(/\n/g, '<br>');
            const italicized = italicizeCaseCitations(escaped);
            const bolded = convertBold(italicized);
            return `<p style="margin: 6px 0;">${bolded}</p>`;
          })
          .join('');
        parts.push(`<div class="section-body">${paraHtml}</div>`);
      }
    }
    currentLines = [];
    currentLabel = '';
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const matchedLabel = SECTION_LABELS.find(
      (l) => trimmed === l || trimmed.startsWith(l + ':') || trimmed.startsWith(l + ' ')
    );

    if (matchedLabel) {
      flushSection();
      currentLabel = matchedLabel;
      const inline = trimmed.substring(matchedLabel.length).replace(/^:\s*/, '');
      if (inline) currentLines.push(inline);
    } else if (trimmed.startsWith('[NOTE:')) {
      parts.push(
        `<p style="background:#fff3cd;border-left:3px solid #f0ad4e;padding:8px 12px;` +
          `font-family:Arial,sans-serif;font-size:14px;">${escapeHtml(trimmed)}</p>`
      );
    } else {
      currentLines.push(line);
    }
  }
  flushSection();

  return parts.join('\n');
}

// ─── Plain text template ──────────────────────────────────────────────────────

function buildPlainText(cases: ProcessedCase[], dateStr: string, unsubscribeUrl: string, notice?: string): string {
  const divider = '━'.repeat(60);
  const sections = cases
    .map(
      (c) =>
        `${divider}\n` +
        `${decodeHtmlEntities(c.title)}\n` +
        [c.member ? decodeHtmlEntities(c.member) : null, c.datePublished, c.category]
          .filter(Boolean)
          .join(' · ') +
        '\n\n' +
        c.summary +
        `\n\n▶ View case summary: ${c.caseUrl}` +
        (c.pdfUrl ? `\n▶ Download PDF: ${c.pdfUrl}` : '') +
        '\n'
    )
    .join('\n');

  return (
    `EMPLOYMENT RELATIONS AUTHORITY — NEW DETERMINATIONS\n` +
    `${dateStr}\n\n` +
    (notice ? `NOTE: ${notice}\n\n` : '') +
    sections +
    `\n${divider}\n\n` +
    `Summaries are AI-generated. Always refer to the full determination. This is not legal advice.\n` +
    `To unsubscribe: ${unsubscribeUrl}\n` +
    `Digest delivered by whenroutinebiteshard.com\n`
  );
}

// ─── Sending ──────────────────────────────────────────────────────────────────

/**
 * Sends a single email via the Cloudflare Email Service Workers binding.
 */
export async function sendEmail(params: SendEmailParams): Promise<void> {
  const boundary = `ERA_DIGEST_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const encodeBody = (s: string): string => {
    const latin1 = unescape(encodeURIComponent(s));
    const b64 = btoa(latin1);
    return b64.match(/.{1,76}/g)?.join('\r\n') ?? b64;
  };

  const mimeMessage = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    encodeBody(params.text),
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    encodeBody(params.html),
    ``,
    `--${boundary}--`,
  ].join('\r\n');

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  writer.write(encoder.encode(mimeMessage)).then(() => writer.close());

  const message = new EmailMessage(params.from, params.to, readable);
  await params.emailBinding.send.call(params.emailBinding, message);
}

/**
 * Sends the digest to all provided subscribers with personalised unsubscribe links.
 */
export async function sendDigestToAll(
  subscribers: DbSubscriber[],
  cases: ProcessedCase[],
  from: string,
  timezone: string,
  emailBinding: SendEmail,
  siteUrl: string,
  notice?: string
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  const BATCH_SIZE = 25; // Send up to 25 emails concurrently
  for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
    const batch = subscribers.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (subscriber) => {
      const preferencesUrl = subscriber.unsubscribe_token
        ? `${siteUrl}/preferences?token=${subscriber.unsubscribe_token}`
        : `${siteUrl}/preferences`;

      // Filter cases by subscriber preferences
      let prefs = { show_costs: false, show_consent: false };
      try { prefs = JSON.parse(subscriber.preferences || '{}'); } catch {}
      const filteredCases = cases.filter(c => {
        const firstLine = (c.summary || '').split('\n')[0].trim();
        if (firstLine === '[COSTS ONLY]' && !prefs.show_costs) return false;
        if (firstLine === '[CONSENT]' && !prefs.show_consent) return false;
        return true;
      });

      // Don't send email if no cases match preferences
      if (filteredCases.length === 0) {
        console.log(`Skipping email to ${subscriber.email}: no matching cases for their preferences`);
        return;
      }

      const { subject, html, text } = buildDigestEmail(filteredCases, timezone, preferencesUrl, notice);

      try {
        await sendEmail({
          from,
          to: subscriber.email,
          subject,
          html,
          text,
          emailBinding,
        });
        sent++;
        console.log(`Email sent to ${subscriber.email}`);
      } catch (err) {
        failed++;
        console.error(`Failed to send email to ${subscriber.email}: ${err}`);
      }
    }));
  }

  return { sent, failed };
}

/**
 * Sends a confirmation email to a new subscriber.
 */
export async function sendConfirmationEmail(
  to: string,
  name: string | null,
  token: string,
  from: string,
  siteUrl: string,
  emailBinding: SendEmail
): Promise<void> {
  const confirmUrl = `${siteUrl}/confirm?token=${token}`;
  const { subject, html, text } = buildConfirmationEmail(name, confirmUrl, siteUrl);
  await sendEmail({ from, to, subject, html, text, emailBinding });
}

/**
 * Sends an admin alert for unexpected errors.
 */
export async function sendAdminAlert(
  errorMessage: string,
  from: string,
  adminEmail: string,
  emailBinding: SendEmail
): Promise<void> {
  try {
    const { subject, html, text } = buildAlertEmail(errorMessage);
    await sendEmail({ from, to: adminEmail, subject, html, text, emailBinding });
  } catch (err) {
    console.error(`Could not send admin alert: ${err}`);
  }
}
