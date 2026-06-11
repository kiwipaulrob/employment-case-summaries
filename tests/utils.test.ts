/**
 * Tests for src/utils.ts — pure utility functions.
 * These are the highest-value tests because these functions are:
 *   - deterministic (same input → same output)
 *   - used across multiple modules (emailer, pages, index)
 *   - easy to break during refactoring (as PR #9 demonstrated)
 */

import { describe, expect, it } from 'vitest';
import {
  toTitleCase,
  escapeHtml,
  decodeHtmlEntities,
  isValidEmail,
  stripHtml,
  stripLlmArtifacts,
  parseAwardsBlock,
  parseDollarAmount,
  getSummaryExcerpt,
  sleep,
} from '../src/utils';

// ─── toTitleCase ───────────────────────────────────────────────────────────────

describe('toTitleCase', () => {
  it('lowercases particles ("v", "and", "of", "the" etc.) when not first word', () => {
    expect(toTitleCase('John v Acme Ltd')).toBe('John v Acme Ltd');
    expect(toTitleCase('The Queen AND The Government')).toBe('The Queen and the Government');
    expect(toTitleCase('Rights of Man')).toBe('Rights of Man');
  });

  it('capitalises the first word even if it is a particle', () => {
    expect(toTitleCase('the company limited')).toBe('The Company Limited');
    expect(toTitleCase('a bird in the hand')).toBe('A Bird in the Hand');
  });

  it('preserves all-caps abbreviations (2–6 uppercase chars) — except first word', () => {
    // First word is always normal-cased per code comment "never preserve all-caps"
    expect(toTitleCase('FHE v Auckland Transport')).toBe('Fhe v Auckland Transport');
    // Subsequent words preserve all-caps:
    expect(toTitleCase('Referring to ACC appeal')).toBe('Referring to ACC Appeal');
    expect(toTitleCase('The IRD v taxpayer')).toBe('The IRD v Taxpayer');
    expect(toTitleCase('Submit to UPOWER review')).toBe('Submit to UPOWER Review');
  });

  it('preserves PascalCase abbreviations (e.g. NZEmpC, NZBORA) — except first word', () => {
    // First word is always normal-cased
    expect(toTitleCase('NZEmpC ruling')).toBe('Nzempc Ruling');
    // Subsequent words preserve PascalCase:
    expect(toTitleCase('The NZBORA claim')).toBe('The NZBORA Claim');
    expect(toTitleCase('Review the NZEnvC decision')).toBe('Review the NZEnvC Decision');
  });

  it('applies & Anor convention when "Anor" is already title-cased', () => {
    // The regex /(?<!& )\bAnor\b/g is case-sensitive — only matches "Anor" not "ANOR"
    expect(toTitleCase('Jung & Anor v Health NZ')).toBe('Jung & Anor v Health NZ');
    expect(toTitleCase('Byungok Jung & Anor v Health New Zealand')).toBe('Byungok Jung & Anor v Health New Zealand');
  });

  it('does not double the ampersand before Anor', () => {
    // The negative lookbehind (?<!& ) prevents "& & Anor"
    const result = toTitleCase('Jung & Anor');
    expect(result).not.toContain('& &');
    expect(result).toContain('& Anor');
  });

  it('handles mixed input correctly', () => {
    expect(toTitleCase('the chief executive of the department of corrections'))
      .toBe('The Chief Executive of the Department of Corrections');
  });

  it('returns empty string for empty input', () => {
    expect(toTitleCase('')).toBe('');
  });
});

// ─── escapeHtml ────────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('div > span')).toBe('div &gt; span');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('he said "hello"')).toBe('he said &quot;hello&quot;');
  });

  it('handles mixed special characters', () => {
    expect(escapeHtml('<a href="x"> & </a>')).toBe('&lt;a href=&quot;x&quot;&gt; &amp; &lt;/a&gt;');
  });

  it('passes through plain text unchanged', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
  });
});

// ─── decodeHtmlEntities ────────────────────────────────────────────────────────

describe('decodeHtmlEntities', () => {
  it('decodes &amp;', () => {
    expect(decodeHtmlEntities('a &amp; b')).toBe('a & b');
  });

  it('decodes &lt; and &gt;', () => {
    expect(decodeHtmlEntities('&lt;tag&gt;')).toBe('<tag>');
  });

  it('decodes &quot;', () => {
    expect(decodeHtmlEntities('&quot;hello&quot;')).toBe('"hello"');
  });

  it('decodes numeric character references', () => {
    expect(decodeHtmlEntities('&#39;')).toBe("'");
    expect(decodeHtmlEntities('&#65;')).toBe('A');
  });

  it('decodes &nbsp; to non-breaking space', () => {
    expect(decodeHtmlEntities('&nbsp;')).toBe('\u00a0');
  });

  it('decodes &mdash; and &ndash;', () => {
    expect(decodeHtmlEntities('&mdash;')).toBe('\u2014');
    expect(decodeHtmlEntities('&ndash;')).toBe('\u2013');
  });

  it('decodes smart quotes', () => {
    expect(decodeHtmlEntities('&lsquo;')).toBe('\u2018');
    expect(decodeHtmlEntities('&rsquo;')).toBe('\u2019');
    expect(decodeHtmlEntities('&ldquo;')).toBe('\u201c');
    expect(decodeHtmlEntities('&rdquo;')).toBe('\u201d');
  });

  it('passes through plain text', () => {
    expect(decodeHtmlEntities('hello world')).toBe('hello world');
  });
});

// ─── isValidEmail ──────────────────────────────────────────────────────────────

describe('isValidEmail', () => {
  it('accepts valid email addresses', () => {
    expect(isValidEmail('paul@example.com')).toBe(true);
    expect(isValidEmail('paul.a.robertson@heaneypartners.com')).toBe(true);
    expect(isValidEmail('user+tag@domain.co.nz')).toBe(true);
  });

  it('rejects strings without @', () => {
    expect(isValidEmail('notanemail')).toBe(false);
  });

  it('rejects strings without domain', () => {
    expect(isValidEmail('paul@')).toBe(false);
  });

  it('rejects strings without TLD', () => {
    expect(isValidEmail('paul@example')).toBe(false);
  });

  it('rejects strings with spaces', () => {
    expect(isValidEmail('paul @ example.com')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidEmail('')).toBe(false);
  });
});

// ─── stripHtml ─────────────────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('strips simple tags', () => {
    expect(stripHtml('<p>text</p>')).toBe('text');
  });

  it('strips self-closing tags', () => {
    expect(stripHtml('before<br/>after')).toBe('beforeafter');
  });

  it('strips tags with attributes', () => {
    expect(stripHtml('<a href="https://x.com">link</a>')).toBe('link');
  });

  it('passes through text without tags', () => {
    expect(stripHtml('plain text')).toBe('plain text');
  });
});

// ─── stripLlmArtifacts ─────────────────────────────────────────────────────────

describe('stripLlmArtifacts', () => {
  it('removes "I\'ll analyze…" preamble', () => {
    const result = stripLlmArtifacts(`I'll analyze this determination and provide a structured summary.

PARTIES
Applicant: Jane Smith (employee)`);
    expect(result).not.toMatch(/^I'll analyze/i);
    expect(result).toMatch(/^PARTIES/);
  });

  it('removes "I\'ll summarize…" preamble', () => {
    const result = stripLlmArtifacts(`I'll summarize this case.

PARTIES`);
    expect(result).not.toMatch(/^I'll summarize/i);
    expect(result).toMatch(/^PARTIES/);
  });

  it('removes "Let me provide…" preamble', () => {
    const result = stripLlmArtifacts(`Let me provide a structured summary.

FACTS`);
    expect(result).not.toMatch(/^Let me provide/i);
    expect(result).toMatch(/^FACTS/);
  });

  it('removes "Here\'s…" preamble', () => {
    const result = stripLlmArtifacts(`Here's a structured summary of the case.

PARTIES`);
    expect(result).not.toMatch(/^Here's/i);
    expect(result).toMatch(/^PARTIES/);
  });

  it('removes [FINAL DETERMINATION] flag', () => {
    expect(stripLlmArtifacts('[FINAL DETERMINATION]\n\nPARTIES')).toBe('PARTIES');
  });

  it('removes [INTERIM/…] flag', () => {
    expect(stripLlmArtifacts('[INTERIM/INTERLOCUTORY: This decision relates to an application for interim relief]\n\nPARTIES')).toBe('PARTIES');
  });

  it('removes [CONSENT ORDER] flag', () => {
    expect(stripLlmArtifacts('[CONSENT ORDER]\n\nPARTIES')).toBe('PARTIES');
  });

  it('removes [COSTS ORDER] flag', () => {
    expect(stripLlmArtifacts('[COSTS ORDER]\n\nPARTIES')).toBe('PARTIES');
  });

  it('removes [JUDGMENT ON APPEAL] flag', () => {
    expect(stripLlmArtifacts('[JUDGMENT ON APPEAL]\n\nPARTIES')).toBe('PARTIES');
  });

  it('removes FORMAT START/END markers', () => {
    const input = '---FORMAT START---\nPARTIES\n---FORMAT END---';
    expect(stripLlmArtifacts(input)).toBe('PARTIES');
  });

  it('passes through clean text unchanged', () => {
    const input = 'PARTIES\nApplicant: Jane Smith (employee)';
    expect(stripLlmArtifacts(input)).toBe(input);
  });

  it('removes quoted preambles', () => {
    const result = stripLlmArtifacts(`"Let me provide a structured summary."

OUTCOME`);
    expect(result).not.toMatch(/^"/);
    expect(result).toMatch(/^OUTCOME/);
  });

  it('trims whitespace', () => {
    expect(stripLlmArtifacts('  \n  PARTIES  \n  ')).toBe('PARTIES');
  });
});

// validateSummaryNotDoubleEncoded added in PR #50 (guardrail-notice-timing)
// Tests will be enabled once that PR is merged.

// ─── parseAwardsBlock ──────────────────────────────────────────────────────────

describe('parseAwardsBlock', () => {
  const fullSummary = `PARTIES
Applicant: Jane Smith (employee)

REMEDY
Compensation: $12,500

AWARDS_DATA
HHD: $12,500
Lost wages: $8,400
Weekly wage: $950
Lost wages weeks: 8.8
Costs: $2,500
Reinstatement: yes
Outcome: applicant
AWARDS_DATA_END`;

  it('extracts awards data from a full block', () => {
    const { awardsData, strippedSummary } = parseAwardsBlock(fullSummary);
    expect(awardsData).not.toBeNull();
    expect(awardsData!.hhd_amount).toBe(12500);
    expect(awardsData!.lost_wages).toBe(8400);
    expect(awardsData!.weekly_wage).toBe(950);
    expect(awardsData!.lost_wages_weeks).toBe(8.8);
    expect(awardsData!.costs_awarded).toBe(2500);
    expect(awardsData!.reinstatement).toBe(true);
    expect(awardsData!.outcome).toBe('applicant');
  });

  it('strips the AWARDS_DATA block from the summary', () => {
    const { strippedSummary } = parseAwardsBlock(fullSummary);
    expect(strippedSummary).not.toContain('AWARDS_DATA');
    expect(strippedSummary).not.toContain('HHD: $12,500');
    expect(strippedSummary).toContain('PARTIES');
    expect(strippedSummary).toContain('REMEDY');
  });

  it('returns null awardsData and unchanged summary when no block present', () => {
    const summary = 'PARTIES\nApplicant: Jane Smith';
    const { awardsData, strippedSummary } = parseAwardsBlock(summary);
    expect(awardsData).toBeNull();
    expect(strippedSummary).toBe(summary);
  });

  it('derives lost_wages_weeks from lost_wages / weekly_wage when weeks not stated', () => {
    const summary = `REMEDY
Compensation: $10,000

AWARDS_DATA
HHD: nil
Lost wages: $10,000
Weekly wage: $1,000
Costs: nil
Reinstatement: no
Outcome: applicant
AWARDS_DATA_END`;
    const { awardsData } = parseAwardsBlock(summary);
    // 10000 / 1000 = 10 weeks (derived)
    expect(awardsData!.lost_wages_weeks).toBe(10);
  });

  it('does not derive weeks when weekly_wage is missing', () => {
    const summary = `AWARDS_DATA
HHD: $5,000
Lost wages: $10,000
Weekly wage: nil
Costs: nil
Reinstatement: no
Outcome: applicant
AWARDS_DATA_END`;
    const { awardsData } = parseAwardsBlock(summary);
    expect(awardsData!.lost_wages_weeks).toBeNull();
  });

  it('parses nil values correctly', () => {
    const summary = `AWARDS_DATA
HHD: nil
Lost wages: nil
Weekly wage: nil
Costs: nil
Reinstatement: no
Outcome: none
AWARDS_DATA_END`;
    const { awardsData } = parseAwardsBlock(summary);
    expect(awardsData!.hhd_amount).toBeNull();
    expect(awardsData!.lost_wages).toBeNull();
    expect(awardsData!.reinstatement).toBe(false);
    expect(awardsData!.outcome).toBe('none');
  });

  it('handles "not ordered" and "not stated" values', () => {
    const summary = `AWARDS_DATA
HHD: not ordered
Lost wages: Not stated
Costs: no award
Reinstatement: no
Outcome: none
AWARDS_DATA_END`;
    const { awardsData } = parseAwardsBlock(summary);
    expect(awardsData!.hhd_amount).toBeNull();
    expect(awardsData!.lost_wages).toBeNull();
    expect(awardsData!.costs_awarded).toBeNull();
  });
});

// ─── parseDollarAmount ─────────────────────────────────────────────────────────

describe('parseDollarAmount', () => {
  it('parses $12,500', () => {
    expect(parseDollarAmount('$12,500')).toBe(12500);
  });

  it('parses $8,400', () => {
    expect(parseDollarAmount('$8,400')).toBe(8400);
  });

  it('returns null for "nil"', () => {
    expect(parseDollarAmount('nil')).toBeNull();
  });

  it('returns null for "none"', () => {
    expect(parseDollarAmount('none')).toBeNull();
  });

  it('returns null for "n/a"', () => {
    expect(parseDollarAmount('n/a')).toBeNull();
  });

  it('returns null for "not stated"', () => {
    expect(parseDollarAmount('not stated')).toBeNull();
  });

  it('returns null for "not ordered"', () => {
    expect(parseDollarAmount('not ordered')).toBeNull();
  });

  it('returns null for hyphen', () => {
    expect(parseDollarAmount('-')).toBeNull();
  });

  it('parses number without $ sign', () => {
    expect(parseDollarAmount('1500')).toBe(1500);
  });

  it('parses number with decimal', () => {
    expect(parseDollarAmount('$123.45')).toBe(123);
  });

  it('returns null for empty string', () => {
    expect(parseDollarAmount('')).toBeNull();
  });
});

// ─── getSummaryExcerpt ─────────────────────────────────────────────────────────

describe('getSummaryExcerpt', () => {
  it('returns empty string for "Summary unavailable"', () => {
    expect(getSummaryExcerpt('Summary unavailable — error')).toBe('');
  });

  it('returns empty string for seeded summaries', () => {
    expect(getSummaryExcerpt('(seeded — not processed)')).toBe('');
  });

  it('extracts the FACTS section from a full summary', () => {
    const summary = `PARTIES
Applicant: Jane Smith

FACTS
The applicant was employed as a receptionist from March 2020.
She was dismissed in June 2024 after a restructuring process.

LEGAL ISSUES
1. Was the dismissal unjustified?`;
    const excerpt = getSummaryExcerpt(summary);
    expect(excerpt).toContain('receptionist');
    expect(excerpt).toContain('March 2020');
    expect(excerpt).not.toContain('LEGAL ISSUES');
  });

  it('truncates long excerpts and appends ellipsis', () => {
    const summary = `FACTS
The applicant was employed as a receptionist from March 2020. She was dismissed in June 2024.
This is a very long string that will definitely exceed the maximum length of 50 characters.`;
    const excerpt = getSummaryExcerpt(summary, 50);
    expect(excerpt.length).toBeLessThanOrEqual(53); // 50 + '…'
    expect(excerpt).toMatch(/…$/);
  });

  it('falls back to first non-label line when FACTS section not found', () => {
    const summary = 'PARTIES\nApplicant: Jane Smith\nRespondent: Acme Ltd';
    const excerpt = getSummaryExcerpt(summary);
    expect(excerpt).toContain('Applicant');
  });

  it('returns truncated fallback when no FACTS and first line is long', () => {
    const summary = 'A'.repeat(500);
    const excerpt = getSummaryExcerpt(summary, 10);
    expect(excerpt.length).toBeLessThanOrEqual(13);
  });
});

// ─── sleep ─────────────────────────────────────────────────────────────────────

describe('sleep', () => {
  it('resolves after the specified delay', async () => {
    const start = Date.now();
    await sleep(10);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(5);
  });

  it('resolves with 0ms delay', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});
