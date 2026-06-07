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
    .replace(/\bAnor\b/g, '& Anor');
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
  return s.replace(/<[^>]+>/g, '');
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
          .map(l => l.replace(/^\d+[.)]\s*/, '').replace(/^[•\-]\s*/, '').trim())
          .filter(Boolean);
        const listHtml = items.map(i => `<li>${escapeHtml(i)}</li>`).join('');
        parts.push(`<div class="sum-body"><ol>${listHtml}</ol></div>`);
      } else {
        const paras = content.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
        const paraHtml = paras
          .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
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

/**
 * Extracts a short excerpt from a structured LLM summary.
 * Tries to find the FACTS section; falls back to first non-label line.
 */
export function getSummaryExcerpt(summary: string, maxLength = 260): string {
  if (!summary || summary.startsWith('Summary unavailable') || summary.startsWith('(seeded')) {
    return '';
  }

  // Try to extract the FACTS section
  const factsMatch = summary.match(/FACTS[:\s]*\n([\s\S]*?)(?:\n[A-Z &]{3,}[:\s]*\n|$)/);
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
