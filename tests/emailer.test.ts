/**
 * Tests for src/emailer.ts — email composition and rendering.
 *
 * Tests the section-parsing logic that converts LLM plain-text summaries
 * into styled HTML. This is a high-regression-risk area because:
 *   - summaryToHtml() and summaryToPageHtml() in utils.ts are near-duplicates
 *   - SECTION_LABEL_MAP and list-detection logic can drift
 *   - The email is the primary user-facing output
 */

import { describe, expect, it, vi } from 'vitest';

// Mock the Workers-specific email module that doesn't exist in Node.js
vi.mock('cloudflare:email', () => ({
  EmailMessage: class EmailMessage {},
}));

// We import from emailer, which exports buildDigestEmail
// But summaryToHtml is internal — we test it indirectly through the output
import { buildDigestEmail, buildConfirmationEmail, buildAlertEmail } from '../src/emailer';

// ─── buildDigestEmail ──────────────────────────────────────────────────────────

describe('buildDigestEmail', () => {
  const sampleCases = [
    {
      caseId: '123',
      title: 'Smith v Acme Ltd',
      caseUrl: 'https://determinations.era.govt.nz/determination/view/123',
      pdfUrl: 'https://determinations.era.govt.nz/assets/elawpdf/2026/2026-NZERA-123.pdf',
      member: 'Robert Davies',
      datePublished: '15 Apr 2026',
      category: '[2026] NZERA 123',
      summary: `PARTIES
Applicant: Jane Smith (employee)
Respondent: Acme Ltd (employer)

REPRESENTATIVES
Applicant: John Doe, Smith & Co
Respondent: Self-represented

FACTS
The applicant was employed as a receptionist from March 2020.

LEGAL ISSUES
1. Was the dismissal unjustified? [Established]

OUTCOME
The claim was upheld.

REMEDY
Compensation: $12,500`,
      processedAt: '2026-04-15T00:00:00Z',
      source: 'ERA',
    },
  ];

  it('generates a subject line with case count and date', () => {
    const { subject } = buildDigestEmail(sampleCases, 'Pacific/Auckland', 'https://example.com/unsub');
    expect(subject).toMatch(/ERA Determinations/);
    expect(subject).toMatch(/1 new case/);
  });

  it('generates HTML with correct sections', () => {
    const { html } = buildDigestEmail(sampleCases, 'Pacific/Auckland', 'https://example.com/unsub');
    expect(html).toContain('Employment Relations Authority');
    expect(html).toContain('Smith v Acme Ltd');
    expect(html).toContain('Parties');
    expect(html).toContain('Facts');
    expect(html).toContain('Legal issues');
    expect(html).toContain('Outcome');
    expect(html).toContain('Remedy');
  });

  it('generates plain text alternative', () => {
    const { text } = buildDigestEmail(sampleCases, 'Pacific/Auckland', 'https://example.com/unsub');
    expect(text).toContain('NEW DETERMINATIONS');
    expect(text).toContain('Smith v Acme Ltd');
    expect(text).toContain('View case summary');
    expect(text).toContain('Download PDF');
  });

  it('includes header when notice is provided', () => {
    const { html } = buildDigestEmail(sampleCases, 'Pacific/Auckland', 'https://example.com/unsub', 'Important notice');
    expect(html).toContain('Important notice');
  });

  it('includes unsubscribe link', () => {
    const { html } = buildDigestEmail(sampleCases, 'Pacific/Auckland', 'https://example.com/unsub?token=abc');
    expect(html).toContain('unsubscribe');
    expect(html).toContain('unsub?token=abc');
  });

  it('shows disclaimer', () => {
    const { html } = buildDigestEmail(sampleCases, 'Pacific/Auckland', 'https://example.com/unsub');
    expect(html).toContain('AI-generated');
  });

  it('handles empty case list gracefully', () => {
    const { subject, html } = buildDigestEmail([], 'Pacific/Auckland', 'https://example.com/unsub');
    expect(subject).toMatch(/0 new cases/);
    // With no cases, neither section appears — just the wrapper and footer
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('unsubscribe');
  });

  it('includes inline citation italicization in HTML', () => {
    // Use a case with a citation in the summary text
    const casesWithCitation = [
      {
        ...sampleCases[0],
        summary: `PARTIES
Applicant: Jane Smith (employee)
Respondent: Acme Ltd (employer)

FACTS
In Smith v Jones [2026] NZERA 229 the Authority considered...

OUTCOME
Dismissed.

REMEDY
None ordered.`,
      },
    ];
    const { html } = buildDigestEmail(casesWithCitation, 'Pacific/Auckland', 'https://example.com/unsub');
    // The italicizeCaseCitations function should wrap the citation in <i>
    expect(html).toContain('<i>');
  });
});

// ─── buildConfirmationEmail ────────────────────────────────────────────────────

describe('buildConfirmationEmail', () => {
  it('includes the confirmation link', () => {
    const { html } = buildConfirmationEmail('Paul', 'https://example.com/confirm?token=abc', 'https://example.com');
    expect(html).toContain('https://example.com/confirm?token=abc');
  });

  it('greets the subscriber by name', () => {
    const { html } = buildConfirmationEmail('Paul', 'https://example.com/confirm', 'https://example.com');
    expect(html).toContain('Hi Paul');
  });

  it('uses generic greeting when name is null', () => {
    const { html } = buildConfirmationEmail(null, 'https://example.com/confirm', 'https://example.com');
    expect(html).toContain('Hello');
  });

  it('generates plain text with confirm link', () => {
    const { text } = buildConfirmationEmail('Paul', 'https://example.com/confirm', 'https://example.com');
    expect(text).toContain('https://example.com/confirm');
  });
});

// ─── buildAlertEmail ───────────────────────────────────────────────────────────

describe('buildAlertEmail', () => {
  it('includes the error message', () => {
    const { subject, html, text } = buildAlertEmail('Something went wrong');
    expect(subject).toContain('Run error');
    expect(html).toContain('Something went wrong');
    expect(text).toContain('Something went wrong');
  });
});
