/**
 * tests/dashboard.test.ts — Tests for the admin dashboard HTML/JS generation
 *
 * These verify that the server-rendered dashboard HTML contains valid
 * JavaScript without syntax errors, preventing the recurring issue where
 * template literal escaping problems cause the entire inline script to fail.
 */
import { describe, it, expect } from 'vitest';

// The dashboard.ts module
import { getDashboardHtml } from '../src/dashboard';

const MOCK_STATUS = {
  total_subscribers: 3,
  active_subscribers: 2,
  last_run_at: '2026-06-14T05:43:31.683Z',
  is_paused: false,
  total_cases: 30,
  era_cases: 28,
  ec_cases: 2,
  cron_schedule: 'Daily at 8am NZT (dual cron for DST)',
  timezone: 'Pacific/Auckland',
  email_notice: null,
};

describe('dashboard HTML generation', () => {
  it('returns a complete HTML document', () => {
    const html = getDashboardHtml(MOCK_STATUS);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  it('contains a single inline script tag with all functions', () => {
    const html = getDashboardHtml(MOCK_STATUS);
    // Count script tags
    const openTags = html.match(/<script>/g)?.length ?? 0;
    const closeTags = html.match(/<\/script>/g)?.length ?? 0;
    expect(openTags).toBe(1);
    expect(closeTags).toBe(1);
  });

  it('produces parseable JavaScript with no syntax errors', () => {
    const html = getDashboardHtml(MOCK_STATUS);
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    const script = match![1];

    // Use Function constructor to check syntax — it throws on invalid JS
    // Wrap async functions so the constructor doesn't reject them
    // (Function constructor doesn't support async/await directly in all environments)
    const wrapped = `
      "use strict";
      ${script}
    `;

    // Test that key functions exist by evaluating the script
    // We catch the error and check it's not a SyntaxError
    try {
      // eslint-disable-next-line no-new, no-new-func
      new Function(wrapped);
    } catch (e: unknown) {
      const err = e as Error;
      // Syntax errors indicate broken escaping in the template literal
      if (err instanceof SyntaxError || err.name === 'SyntaxError') {
        // Extract relevant context around the error
        const lineMatch = err.message.match(/at line (\d+)/);
        const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : 0;
        const lines = wrapped.split('\n');
        const context = lines.slice(Math.max(0, lineNum - 3), lineNum + 2).join('\n');
        expect.fail(
          `JavaScript SyntaxError in generated dashboard script:\n${err.message}\n\nContext around line ${lineNum}:\n${context}`
        );
      }
      // Other errors (ReferenceError for missing DOM APIs) are expected and OK
      // since the script runs in a browser, not Node
    }
  });

  it('includes all expected tab functions in the script', () => {
    const html = getDashboardHtml(MOCK_STATUS);
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    const script = match![1];

    const expectedFunctions = [
      'switchTab',
      'loadErrors',
      'loadScraperStats',
      'scrapeIdRange',
      'scrapeDateRange',
      'uploadEraUrl',
      'handleEraPdfFiles',
      'cancelPreview',
      'loadPrompts',
      'runDiag',
    ];

    for (const fn of expectedFunctions) {
      expect(script).toContain(`function ${fn}`);
    }
  });

  it('has no bare // inside regex patterns in the script (would create comments)', () => {
    const html = getDashboardHtml(MOCK_STATUS);
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    const script = match![1];

    // Check for common regex patterns that lose backslashes in template literals
    // A regex like /\/view\/(\d+)/ rendered as //view/(d+)/ would break the script
    // because // starts a single-line comment
    const commentPatterns = script.match(/\/\/[a-z]\/[a-z]/gi);
    // Some // patterns are valid (URL comments, etc.) — we check specific known cases
    const brokenRegexLines = script
      .split('\n')
      .filter(line => /\.match\(\/\/[a-z]/.test(line.trim()));
    
    expect(brokenRegexLines).toEqual([]);
  });

  it('renders digest tab sections correctly', () => {
    const html = getDashboardHtml(MOCK_STATUS);
    expect(html).toContain('Cron Schedule');
    expect(html).toContain('Digest State & Range');
    expect(html).toContain('Preview');
    expect(html).toContain('Email Templates');
    expect(html).toContain('System Running');
    expect(html).toContain('Pause');
  });

  it('renders all tab sections', () => {
    const html = getDashboardHtml(MOCK_STATUS);
    const expectedTabs = [
      'digest',
      'ec-upload',
      'subscribers',
      'analytics',
      'prompts',
      'scraper',
      'diagnostics',
      'errors',
    ];
    for (const tab of expectedTabs) {
      expect(html).toContain(`id="${tab}"`);
    }
  });
});
