/**
 * utils.ts — Shared utility functions used across emailer.ts and pages.ts
 */

/**
 * Converts an ALL-CAPS or mixed-case string to title case suitable for display.
 * Small legal particles (v, and, or, of, the, in, at, etc.) stay lowercase
 * unless they are the first word.
 * 
 * Preserves all-caps abbreviations (2-3 character words that are all-caps):
 * "FHE V AUCKLAND TRANSPORT" → "FHE v Auckland Transport"
 */
export function toTitleCase(s: string): string {
  const particles = new Set([
    'v', 'and', 'or', 'of', 'the', 'in', 'at', 'for',
    'nor', 'but', 'to', 'a', 'an', 'by', 'as',
  ]);
  return s
    .split(' ')
    .map((word, i) => {
      const lower = word.toLowerCase();
      // First word: always capitalize normally (never preserve all-caps, never lowercase as particle)
      if (i === 0) return lower.charAt(0).toUpperCase() + lower.slice(1);
      // Non-first particles always go lowercase (e.g. "THE" → "the", "OF" → "of")
      if (particles.has(lower)) return lower;
      // Preserve genuine all-caps abbreviations (2-6 chars, e.g. FHE, ACC, IRD, NZERA)
      if (/^[A-Z]{2,6}$/.test(word)) return word;
      // Preserve PascalCase abbreviations (e.g. NZEmpC, NZEnvC, NZBORA)
      if (/^[A-Z]{2,}[a-z]/.test(word)) return word;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ')
    .replace(/(?<!& )\bAnor\b/g, '& Anor');
}

/**
 * Escapes HTML special characters to prevent XSS in server-rendered pages.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Decodes common HTML entities that may appear in scraped ERA page text.
 * Applied before escapeHtml to prevent double-encoding.
 */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&ndash;/g, '\u2013')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rdquo;/g, '\u201d')
    .replace(/&ldquo;/g, '\u201c');
}

/**
 * Validates an email address with a basic RFC 5322 pattern.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Generates a URL-safe random token (UUID v4 formatted).
 */
export function generateToken(): string {
  return crypto.randomUUID();
}

/**
 * Strips HTML tags from a string, returning plain text.
 */
export function stripHtml(s: string): string {
  return s.replace(/<[a-z\/][^>]*>/gi, '');
}

/**
 * Strip common LLM preambles and metadata artifacts from both ERA and EC summaries.
 * Centralised here so both summariser files share the same logic.
 */
export function stripLlmArtifacts(text: string): string {
  let cleaned = text;

  // Remove conversational preambles — I'll / Let me / Here's
  cleaned = cleaned.replace(/^['"]?(?:I'll|Let\s+me|Here's)\s+.*?\.?\s*\n\n/is, '');

  // Remove document type flags
  cleaned = cleaned.replace(/^\[FINAL DETERMINATION\]\s*\n\n/im, '');
  cleaned = cleaned.replace(/^\[INTERIM[^\]]*\]\s*\n\n/im, '');
  cleaned = cleaned.replace(/^\[CONSENT ORDER\]\s*\n\n/im, '');
  cleaned = cleaned.replace(/^\[COSTS ORDER\]\s*\n\n/im, '');
  cleaned = cleaned.replace(/^\[JUDGMENT ON APPEAL\]\s*\n\n/im, '');

  // Remove format markers
  cleaned = cleaned.replace(/^---?FORMAT\s+START---?\s*\n*/im, '');
  cleaned = cleaned.replace(/\n*---?FORMAT\s+END---?\s*$/im, '');
  cleaned = cleaned.replace(/\n{2,}---[\s-]*$/m, ''); // trailing --- dashes LLMs sometimes emit

  return cleaned.trim();
}

/**
 * Async sleep/delay helper.
 * Used by both summarisers for retry-backoff between API call attempts.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 *
 * Standard `!==` short-circuits on the first differing character, leaking
 * information about how many prefix characters were correct — enabling
 * character-by-character brute-force. This function always compares every
 * byte of the longer string, making the execution time independent of
 * where the strings differ.
 *
 * If the strings differ in length, the shorter is null-padded to match.
 * This prevents leaking which input was shorter.
 *
 * Use for: password checks, API token validation, any secret comparison.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  const bufA = new Uint8Array(maxLen);
  const bufB = new Uint8Array(maxLen);
  for (let i = 0; i < a.length; i++) bufA[i] = a.charCodeAt(i);
  for (let i = 0; i < b.length; i++) bufB[i] = b.charCodeAt(i);
  let result = 0;
  for (let i = 0; i < maxLen; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

/**
 * Converts a plain-text structured LLM summary into styled HTML for web pages.
 * Uses the same section-label parsing as the email renderer but with page CSS classes.
 */
export function summaryToPageHtml(summary: string): string {
  if (
    !summary ||
    summary.startsWith('Summary unavailable') ||
    summary.startsWith('(seeded') ||
    summary.includes('SUMMARY_UNAVAILABLE')
  ) {
    return '';
  }

  const SECTION_LABEL_MAP: Record<string, string> = {
    'JUDGE & DATE': 'Judge & Date',
    'PARTIES': 'Parties',
    'REPRESENTATIVES': 'Representatives',
    'FACTS': 'Facts',
    'ERA FINDINGS': 'ERA Findings',
    'EXECUTIVE SUMMARY': 'Executive Summary',
    'EMPLOYMENT COURT ISSUES RAISED': 'Employment Court Issues Raised',
    'HOW THE EMPLOYMENT COURT ISSUES WERE RESOLVED': 'How the Employment Court Issues Were Resolved',
    'LEGAL ISSUES': 'Legal issues',
    'HOW THE ISSUES WERE RESOLVED': 'How the issues were resolved',
    'OUTCOME': 'Outcome',
    'REMEDY': 'Remedy',
  };

  const SECTION_LABELS = Object.keys(SECTION_LABEL_MAP);
  const lines = summary.split('\n');
  const parts: string[] = [];
  let currentLabel = '';
  let currentLines: string[] = [];

  function flushSection() {
    if (!currentLabel && currentLines.length === 0) return;
    if (currentLabel) {
      const displayLabel = SECTION_LABEL_MAP[currentLabel] ?? currentLabel;
      parts.push(`<div class="sum-label">${escapeHtml(displayLabel)}</div>`);
    }
    const content = currentLines.join('\n').trim();
    if (content) {
      if (/^\d+[.)]\s/.test(content) || content.includes('\n•') || content.startsWith('•')) {
        const items = content
          .split('\n')
          .map(l => l.replace(/^(\d+[.)]|[•\-])\s*/, '').trim())
          .filter(Boolean);
        const listHtml = items.map(i => `<li>${escapeHtml(i).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</li>`).join('');
        parts.push(`<div class="sum-body"><ol>${listHtml}</ol></div>`);
      } else {
        const paras = content.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
        const paraHtml = paras
          .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`)
          .join('');
        parts.push(`<div class="sum-body">${paraHtml}</div>`);
      }
    }
    currentLines = [];
    currentLabel = '';
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const matchedLabel = SECTION_LABELS.find(
      l => trimmed === l || trimmed.startsWith(l + ':')
    );
    if (matchedLabel) {
      flushSection();
      currentLabel = matchedLabel;
      const inline = trimmed.substring(matchedLabel.length).replace(/^:\s*/, '');
      if (inline) currentLines.push(inline);
    } else {
      currentLines.push(line);
    }
  }
  flushSection();

  return parts.join('\n');
}

// ─── Awards data extraction ───────────────────────────────────────────────────

/**
 * Structured remedy data extracted from an LLM-generated summary or backfill.
 */
export interface AwardsData {
  hhd_amount: number | null;
  lost_wages: number | null;
  lost_wages_weeks: number | null;
  weekly_wage: number | null;
  costs_awarded: number | null;
  costs_awarded_text: string | null;  // raw text like "reserved", or null
  reinstatement: boolean;
  outcome: 'applicant' | 'respondent' | 'mixed' | 'none' | null;
  decision_date: string | null;        // YYYY-MM-DD if stated
  employment_tenure: string | null;    // e.g. "2.5 years", "6 months"
  contribution_applied: boolean;
  contribution_reduction: string | null;  // e.g. "25%", "25% (calculated)"
  contribution_conduct: string | null;    // 1-2 sentence description
  penalties: number | null;               // total dollar amount
}

/**
 * Parses the AWARDS_DATA...AWARDS_DATA_END block appended by the ERA summariser prompt,
 * returns the extracted structured data plus the summary with that block stripped out.
 * If no block is found, awardsData is null and strippedSummary is unchanged.
 */
export function parseAwardsBlock(summary: string): { awardsData: AwardsData | null; strippedSummary: string } {
  const START = 'AWARDS_DATA';
  const END   = 'AWARDS_DATA_END';

  const startIdx = summary.indexOf(START);
  const endIdx   = summary.indexOf(END);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { awardsData: null, strippedSummary: summary };
  }

  const block          = summary.slice(startIdx + START.length, endIdx).trim();
  const strippedSummary = (summary.slice(0, startIdx) + summary.slice(endIdx + END.length)).trim();

  const awardsData: AwardsData = {
    hhd_amount: null, lost_wages: null, lost_wages_weeks: null,
    weekly_wage: null, costs_awarded: null, costs_awarded_text: null,
    reinstatement: false, outcome: null,
    decision_date: null, employment_tenure: null,
    contribution_applied: false, contribution_reduction: null,
    contribution_conduct: null, penalties: null,
  };

  for (const line of block.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key   = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    const lowerVal = value.toLowerCase();

    switch (key) {
      case 'hhd':              awardsData.hhd_amount    = parseDollarAmount(value); break;
      case 'lost wages':       awardsData.lost_wages    = parseDollarAmount(value); break;
      case 'weekly wage':      awardsData.weekly_wage   = parseDollarAmount(value); break;
      case 'lost wages weeks': {
        const n = parseFloat(value.replace(/[^\d.]/g, ''));
        awardsData.lost_wages_weeks = isNaN(n) ? null : Math.round(n * 10) / 10;
        break;
      }
      case 'costs': {
        const dollarVal = parseDollarAmount(value);
        awardsData.costs_awarded = dollarVal;
        // If it's a non-numeric value like "reserved", preserve it as text
        if (dollarVal === null && !/^(nil|none|n\/a|not\s+stated|-)$/i.test(value)) {
          awardsData.costs_awarded_text = value.trim() || null;
        }
        break;
      }
      case 'reinstatement':
        awardsData.reinstatement = /^yes$/i.test(value.trim());
        break;
      case 'outcome': {
        const v = value.trim().toLowerCase();
        if (v === 'applicant' || v === 'respondent' || v === 'mixed' || v === 'none') {
          awardsData.outcome = v as AwardsData['outcome'];
        }
        break;
      }
      case 'decision date':
        awardsData.decision_date = /^(nil|none|n\/a|-)$/i.test(lowerVal) ? null : value.trim() || null;
        break;
      case 'employment tenure':
        awardsData.employment_tenure = /^(nil|none|n\/a|-)$/i.test(lowerVal) ? null : value.trim() || null;
        break;
      case 'contribution applied':
        awardsData.contribution_applied = /^yes$/i.test(value.trim());
        break;
      case 'contribution reduction':
        awardsData.contribution_reduction = /^(nil|none|n\/a|-)$/i.test(lowerVal) ? null : value.trim() || null;
        break;
      case 'contribution conduct':
        awardsData.contribution_conduct = /^(nil|none|n\/a|-)$/i.test(lowerVal) ? null : value.trim() || null;
        break;
      case 'penalties':
        awardsData.penalties = parseDollarAmount(value);
        break;
    }
  }

  // Derive weeks from dollar figures if not explicitly stated
  if (
    awardsData.lost_wages_weeks === null &&
    awardsData.lost_wages !== null && awardsData.lost_wages > 0 &&
    awardsData.weekly_wage !== null && awardsData.weekly_wage > 0
  ) {
    awardsData.lost_wages_weeks = Math.round((awardsData.lost_wages / awardsData.weekly_wage) * 10) / 10;
  }

  return { awardsData, strippedSummary };
}

/**
 * Parses a dollar-amount string such as "$12,500" or "nil" into an integer (dollars) or null.
 */
export function parseDollarAmount(s: string): number | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (/^(nil|none|n\/a|not\s+stated|not\s+ordered|no\s+award|-)$/i.test(trimmed)) return null;
  const match = trimmed.replace(/,/g, '').match(/\$?([\d]+(?:\.\d+)?)/);
  if (!match) return null;
  return Math.round(parseFloat(match[1]));
}

/**
 * Extracts a short excerpt from a structured LLM summary.
 * Tries to find the FACTS section; falls back to first non-label line.
 */
export function getSummaryExcerpt(summary: string, maxLength = 260): string {
  if (!summary || summary.startsWith('Summary unavailable') || summary.startsWith('(seeded')) {
    return '';
  }

  // Try to extract the FACTS section
  const factsMatch = summary.match(/FACTS[:\s]*\n([\s\S]*?)(?:\n[A-Z &]{4,}[:\s]*\n|$)/);
  if (factsMatch?.[1]) {
    const excerpt = factsMatch[1].trim();
    return excerpt.length > maxLength ? excerpt.slice(0, maxLength).trimEnd() + '…' : excerpt;
  }

  // Fallback: first non-empty, non-label line
  const lines = summary.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !/^[A-Z &]{4,}:?\s*$/.test(trimmed)) {
      return trimmed.length > maxLength ? trimmed.slice(0, maxLength).trimEnd() + '…' : trimmed;
    }
  }

  return summary.slice(0, maxLength).trimEnd() + '…';
}

/**
 * Validates that a summary has not been double-JSON-encoded.
 *
 * Cloudflare Workers can sometimes JSON.stringify an already-stringified value,
 * producing `"\"PARTIES\\nApplicant: ...\""` instead of `"PARTIES\\nApplicant: ..."`.
 * This function detects that pattern and throws immediately so it can't silently
 * corrupt the database.
 *
 * @throws if the summary looks double-encoded
 */
export function validateSummaryNotDoubleEncoded(summary: string): void {
  if (!summary) return;
  // Double-encoded strings start with a literal quote character
  if (summary.startsWith('"') && summary.endsWith('"') && summary.length > 2) {
    // Try to parse it — if it succeeds and produces another string, it was double-encoded
    try {
      const parsed = JSON.parse(summary);
      if (typeof parsed === 'string') {
        throw new Error(
          `Double-encoding detected: summary starts with literal quote and JSON.parse produces another string. ` +
          `First 80 chars: ${summary.slice(0, 80)}...`
        );
      }
    } catch {
      // Not valid JSON — this is a normal string that happens to start/end with quotes, safe to proceed
    }
  }
}
