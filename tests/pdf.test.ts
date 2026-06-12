/**
 * Tests for src/pdf.ts — PDF text extraction utilities.
 *
 * Tests the pure string-processing functions used for PDF parsing.
 * Does NOT test fetch/network calls or Workers-specific APIs
 * (DecompressionStream, fetch) — those require a Workers runtime.
 */

import { describe, expect, it } from 'vitest';
import {
  truncateToTokenBudget,
  decodePdfString,
  hexToString,
  pdfBytesToText,
} from '../src/pdf';

// ─── decodePdfString ───────────────────────────────────────────────────────────

describe('decodePdfString', () => {
  it('converts escaped newline to newline', () => {
    // Input has literal backslash-n in the string; output should have a real newline
    const input = 'hello' + String.raw`\n` + 'world';
    expect(decodePdfString(input)).toBe('hello\nworld');
  });

  it('converts escaped parens to literal parens', () => {
    const input = String.raw`\(hello)`;
    expect(decodePdfString(input)).toBe('(hello)');
  });

  it('converts escaped close paren', () => {
    const input = String.raw`(hello\)`;
    expect(decodePdfString(input)).toBe('(hello)');
  });

  it('converts octal escapes to characters', () => {
    // \101 = 'A', \102 = 'B', \103 = 'C'
    const input = String.raw`\101\102\103`;
    expect(decodePdfString(input)).toBe('ABC');
  });

  it('preserves plain text unchanged', () => {
    expect(decodePdfString('Hello World')).toBe('Hello World');
  });

  it('handles empty string', () => {
    expect(decodePdfString('')).toBe('');
  });
});

// ─── hexToString ────────────────────────────────────────────────────────────────

describe('hexToString', () => {
  it('converts hex to ASCII', () => {
    expect(hexToString('48656c6c6f')).toBe('Hello');
  });

  it('converts hex space', () => {
    expect(hexToString('20')).toBe(' ');
  });

  it('drops last character when hex length is odd', () => {
    // '486' → only '48' is processed = 'H', '6' is dropped
    expect(hexToString('486')).toBe('H');
  });

  it('returns empty string for empty input', () => {
    expect(hexToString('')).toBe('');
  });
});

// ─── pdfBytesToText / encrypted PDF detection ──────────────────────────────────

describe('pdfBytesToText', () => {
  it('throws a clear error for encrypted/password-protected PDFs', async () => {
    // A minimal PDF-like byte sequence containing the /Encrypt marker
    const encryptedPdfBytes = new Uint8Array(
      Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Size 3 /Root 1 0 R /Encrypt 3 0 R >>\n%%EOF', 'latin1')
    );
    await expect(pdfBytesToText(encryptedPdfBytes.buffer)).rejects.toThrow(
      /encrypted|password-protected/i
    );
  });

  it('throws insufficient content error for unparseable non-encrypted PDF data', async () => {
    const junkBytes = new Uint8Array(50);
    await expect(pdfBytesToText(junkBytes.buffer)).rejects.toThrow(
      /insufficient content|unable|empty/i
    );
  });
});

// ─── truncateToTokenBudget ─────────────────────────────────────────────────────

describe('truncateToTokenBudget', () => {
  it('returns short text unchanged', () => {
    const text = 'Short text';
    expect(truncateToTokenBudget(text, 1000)).toBe(text);
  });

  it('truncates long text and appends truncation notice', () => {
    const text = 'A'.repeat(500); // long enough that truncation + note is shorter
    const result = truncateToTokenBudget(text, 1);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain('[NOTE: The full document was truncated');
  });

  it('uses default maxTokens of 12,000 when not specified', () => {
    const shortText = 'Short text';
    expect(truncateToTokenBudget(shortText)).toBe(shortText);
  });

  it('preserves text exactly at the token budget boundary', () => {
    const text = 'A'.repeat(48); // 48 chars = 12 tokens at 4 chars/token
    expect(truncateToTokenBudget(text, 12)).toBe(text);
  });

  it('truncates text just over the token budget boundary', () => {
    const text = 'A'.repeat(500); // long enough that truncation is meaningful
    const result = truncateToTokenBudget(text, 12);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain('[NOTE:');
  });
});
