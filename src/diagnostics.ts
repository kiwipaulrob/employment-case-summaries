/**
 * diagnostics.ts — Isolated diagnostic tests for the ERA Digest Worker.
 *
 * Each test exercises a single layer of the summarisation pipeline so you
 * can pinpoint where failures occur: Cloudflare runtime, AI binding,
 * PDF extraction, or application logic.
 *
 * Results are grouped and returned as a flat object — no side effects.
 */

import type { Env } from './types';
import type { PdfContent } from './pdf';
import { getPdfContent } from './pdf';
import { summariseCase } from './summariser';
import { scrapeRecentPage, enrichCasesWithDetails } from './scraper';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function ok<T>(label: string, value: T, ms: number): TestResult {
  return { status: 'pass', label, detail: String(value), duration_ms: Math.round(ms) };
}

function fail(label: string, detail: string, ms: number): TestResult {
  return { status: 'fail', label, detail, duration_ms: Math.round(ms) };
}

function warn(label: string, detail: string, ms: number): TestResult {
  return { status: 'warn', label, detail, duration_ms: Math.round(ms) };
}

export interface TestResult {
  status: 'pass' | 'fail' | 'warn';
  label: string;
  detail: string;
  duration_ms: number;
}

export interface DiagnosticsReport {
  test: string;
  label: string;
  results: TestResult[];
  summary: { pass: number; fail: number; warn: number };
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test 1  —  Cloudflare Environment
// ═══════════════════════════════════════════════════════════════════════════════

export async function testPing(env: Env, _request: Request): Promise<DiagnosticsReport> {
  const results: TestResult[] = [];
  const start = performance.now();

  // 1a — Worker is alive
  results.push(ok('worker_alive', 'Hermes diagnostics endpoint reached', performance.now() - start));

  // 1b — D1 connectivity
  const dbStart = performance.now();
  try {
    const row = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    if (row?.ok === 1) {
      results.push(ok('d1_connectivity', 'SELECT 1 returned OK', performance.now() - dbStart));
    } else {
      results.push(fail('d1_connectivity', `Unexpected result: ${JSON.stringify(row)}`, performance.now() - dbStart));
    }
  } catch (err) {
    results.push(fail('d1_connectivity', String(err), performance.now() - dbStart));
  }

  // 1c — Env vars present
  const envStart = performance.now();
  const checks: Array<{ key: string; value: string | undefined }> = [
    { key: 'ADMIN_SECRET', value: env.ADMIN_SECRET },
    { key: 'SITE_URL', value: env.SITE_URL },
    { key: 'AI', value: env.AI ? 'present' : undefined },
  ];
  const missing = checks.filter(c => !c.value);
  if (missing.length === 0) {
    results.push(ok('env_vars', `${checks.length}/${checks.length} required vars present`, performance.now() - envStart));
  } else {
    results.push(fail('env_vars', `Missing: ${missing.map(m => m.key).join(', ')}`, performance.now() - envStart));
  }

  return finalise('ping', 'Cloudflare Environment', results);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test 2  —  Cloudflare AI Connectivity
// ═══════════════════════════════════════════════════════════════════════════════

export async function testCloudflareAIConnectivity(env: Env): Promise<DiagnosticsReport> {
  const results: TestResult[] = [];

  // 2a — Ping the AI binding with a minimal prompt
  const aiStart = performance.now();
  try {
    const response = await (env.AI as any).run('anthropic/claude-sonnet-4.6', {
      messages: [{ role: 'user', content: 'Reply with just the word: OK' }],
      max_tokens: 5,
    });
    const text = response?.result?.content?.[0]?.text ?? response?.content?.[0]?.text;
    const ms = performance.now() - aiStart;

    if (text) {
      results.push(ok('ai_completion', `Response: "${text.trim()}" in ${Math.round(ms)}ms`, ms));
    } else if (response?.error) {
      results.push(fail('ai_completion', `AI error: ${response.error.message}`, ms));
    } else {
      results.push(fail('ai_completion', `Unexpected response: ${JSON.stringify(response).slice(0, 300)}`, ms));
    }
  } catch (err) {
    results.push(fail('ai_completion', `Request failed: ${String(err)}`, performance.now() - aiStart));
  }

  return finalise('cloudflare-ai-connectivity', 'Cloudflare AI Connectivity', results);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test 3  —  Full Summary on a Known Good PDF
// ═══════════════════════════════════════════════════════════════════════════════

export async function testFullSummary(env: Env): Promise<DiagnosticsReport> {
  const results: TestResult[] = [];

  // Use a known-good ERA case that's reliably available
  // NZERA 411 — a recent-ish determination
  const pdfUrl = 'https://determinations.era.govt.nz/determination/view/21502'; // NZERA 411
  const testCase = {
    caseId: 'TEST-21502',
    title: 'Diagnostic Test Case v ERA',
    caseUrl: pdfUrl,
    pdfUrl: pdfUrl + '/pdf',
    member: 'Test Member',
    datePublished: new Date().toISOString().split('T')[0],
    category: 'Test',
  };

  // 3a — PDF extraction
  const pdfStart = performance.now();
  let pdfContent: PdfContent;
  try {
    pdfContent = await getPdfContent(testCase.pdfUrl);
    const textLen = pdfContent.strategy === 'text' ? pdfContent.text.length : 0;
    results.push(ok('pdf_extraction', `Strategy: ${pdfContent.strategy}, text length: ${textLen}`, performance.now() - pdfStart));
  } catch (err) {
    results.push(fail('pdf_extraction', `Failed: ${String(err)}`, performance.now() - pdfStart));
    return finalise('cloudflare-ai-summary', 'Full Summary (Known PDF)', results);
  }

  // 3b — LLM summarisation via Cloudflare AI
  const llmStart = performance.now();
  try {
    const summaryResult = await summariseCase(testCase, pdfContent, env);
    const ms = performance.now() - llmStart;

    if (summaryResult.success) {
      const wordCount = summaryResult.summary.split(/\s+/).length;
      results.push(ok('llm_summary', `Success — ${wordCount} words, ${Math.round(ms)}ms`, ms));
      // Show first 200 chars so you can see quality
      results.push(ok('summary_preview', summaryResult.summary.slice(0, 200).replace(/\n/g, '↵ '), 0));
    } else {
      results.push(fail('llm_summary', `Failed: ${summaryResult.error ?? 'Unknown error'}`, ms));
    }
  } catch (err) {
    results.push(fail('llm_summary', `Exception: ${String(err)}`, performance.now() - llmStart));
  }

  return finalise('cloudflare-ai-summary', 'Full Summary Test', results);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test 4  —  PDF Extraction Quality
// ═══════════════════════════════════════════════════════════════════════════════

export async function testPdfExtraction(): Promise<DiagnosticsReport> {
  const results: TestResult[] = [];

  const pdfUrls = [
    { label: 'ERA determination', url: 'https://determinations.era.govt.nz/determination/view/21502/pdf' },
    // Try an older case too
    { label: 'ERA older case', url: 'https://determinations.era.govt.nz/determination/view/21178/pdf' },
  ];

  for (const p of pdfUrls) {
    const start = performance.now();
    try {
      const content = await getPdfContent(p.url);
      let textLen = 0;
      if (content.strategy === 'text') {
        textLen = content.text.length;
      }
      if (content.strategy === 'base64') {
        results.push(warn(p.label, `base64 (PDF sent to LLM directly) — no text length available`, performance.now() - start));
      } else if (textLen > 100) {
        results.push(ok(p.label, `${textLen} chars extracted (strategy: ${content.strategy})`, performance.now() - start));
      } else if (textLen > 0) {
        results.push(warn(p.label, `Only ${textLen} chars — may be too short for good summary`, performance.now() - start));
      } else {
        results.push(fail(p.label, `Zero chars extracted (strategy: ${content.strategy})`, performance.now() - start));
      }
    } catch (err) {
      results.push(fail(p.label, `Error: ${String(err)}`, performance.now() - start));
    }
  }

  return finalise('pdf-extraction', 'PDF Extraction Quality', results);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test 5  —  Time Budget Breakdown
// ═══════════════════════════════════════════════════════════════════════════════

export async function testTimeBudget(env: Env): Promise<DiagnosticsReport> {
  const results: TestResult[] = [];
  const overallStart = performance.now();

  // 5a — ERA listing page fetch
  const scrapeStart = performance.now();
  try {
    const cases = await scrapeRecentPage(env.SOURCE_URL);
    results.push(ok('scrape_listing', `${cases.length} cases found on ERA listing page`, performance.now() - scrapeStart));
  } catch (err) {
    results.push(fail('scrape_listing', String(err), performance.now() - scrapeStart));
  }

  // 5b — D1 read latency
  const dbStart = performance.now();
  try {
    const count = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM seen_cases').first<{ cnt: number }>();
    results.push(ok('d1_read', `${count?.cnt ?? 0} stored cases`, performance.now() - dbStart));
  } catch (err) {
    results.push(fail('d1_read', String(err), performance.now() - dbStart));
  }

  // 5c — D1 write (small insert)
  const dbWriteStart = performance.now();
  try {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('diag_last_test', ?, datetime('now'))"
    ).bind(new Date().toISOString()).run();
    results.push(ok('d1_write', 'Config write OK', performance.now() - dbWriteStart));
  } catch (err) {
    results.push(fail('d1_write', String(err), performance.now() - dbWriteStart));
  }

  const total = performance.now() - overallStart;
  results.push(ok('total_time', `${Math.round(total)}ms total for all stages`, total));

  return finalise('time-budget', 'Time Budget Breakdown', results);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test 6  —  End-to-End Single Case
// ═══════════════════════════════════════════════════════════════════════════════

export async function testEndToEnd(env: Env): Promise<DiagnosticsReport> {
  const results: TestResult[] = [];
  const overallStart = performance.now();

  // 6a — Scrape the ERA recent listing
  const scrapeStart = performance.now();
  let cases: import('./types').CaseListing[];
  try {
    cases = await scrapeRecentPage(env.SOURCE_URL);
    results.push(ok('scrape', `${cases.length} cases on listing`, performance.now() - scrapeStart));
  } catch (err) {
    results.push(fail('scrape', `Scrape failed: ${String(err)}`, performance.now() - scrapeStart));
    return finalise('end-to-end', 'End-to-End Single Case', results);
  }

  if (cases.length === 0) {
    results.push(fail('scrape', 'No cases found on listing page', performance.now() - scrapeStart));
    return finalise('end-to-end', 'End-to-End Single Case', results);
  }

  // 6b — Pick the first case and enrich it
  const candidate = cases[0];
  const enrichStart = performance.now();
  try {
    const enriched = await enrichCasesWithDetails([candidate]);
    if (enriched.length > 0 && enriched[0].pdfUrl) {
      results.push(ok('enrich', `Case: "${enriched[0].title}" — PDF: ${enriched[0].pdfUrl}`, performance.now() - enrichStart));
    } else {
      results.push(fail('enrich', 'Enrichment returned no PDF URL', performance.now() - enrichStart));
      return finalise('end-to-end', 'End-to-End Single Case', results);
    }
  } catch (err) {
    results.push(fail('enrich', String(err), performance.now() - enrichStart));
    return finalise('end-to-end', 'End-to-End Single Case', results);
  }

  // 6c — PDF extraction
  const pdfStart = performance.now();
  let pdfContent: PdfContent;
  try {
    pdfContent = await getPdfContent(candidate.pdfUrl!);
    const textLen = pdfContent.strategy === 'text' ? pdfContent.text.length : 0;
    results.push(ok('pdf_extract', `Strategy: ${pdfContent.strategy}, text: ${textLen} chars`, performance.now() - pdfStart));
  } catch (err) {
    results.push(fail('pdf_extract', `Failed: ${String(err)}`, performance.now() - pdfStart));
    return finalise('end-to-end', 'End-to-End Single Case', results);
  }

  // 6d — Summarisation via Cloudflare AI
  const llmStart = performance.now();
  try {
    const summaryResult = await summariseCase(candidate, pdfContent, env);
    const ms = performance.now() - llmStart;

    if (summaryResult.success) {
      const wordCount = summaryResult.summary.split(/\s+/).length;
      results.push(ok('llm_summary', `Success — ${wordCount} words, ${Math.round(ms)}ms`, ms));

      // Check finish_reason by looking for truncation warning
      if (summaryResult.summary.includes('[WARNING: Summary was truncated')) {
        results.push(warn('truncation', 'Summary was truncated due to max_tokens limit!', 0));
      }

      // Check if it's a costs-only or consent case
      if (summaryResult.summary.startsWith('[COSTS ONLY]') || summaryResult.summary.startsWith('[CONSENT]')) {
        results.push(warn('case_type', 'This is a costs-only or consent case — stats will be excluded', 0));
      }
    } else {
      results.push(fail('llm_summary', `Failed: ${summaryResult.error ?? 'Unknown'}`, ms));
    }
  } catch (err) {
    results.push(fail('llm_summary', `Exception: ${String(err)}`, performance.now() - llmStart));
  }

  const total = performance.now() - overallStart;
  results.push(ok('total_time', `End-to-end: ${Math.round(total)}ms`, total));

  return finalise('end-to-end', 'End-to-End Single Case', results);
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function finalise(test: string, label: string, results: TestResult[]): DiagnosticsReport {
  const pass = results.filter(r => r.status === 'pass').length;
  const failCount = results.filter(r => r.status === 'fail').length;
  const warnCount = results.filter(r => r.status === 'warn').length;
  return { test, label, results, summary: { pass, fail: failCount, warn: warnCount } };
}

/**
 * Registry of all available tests.
 */
export const DIAGNOSTICS_TESTS: Record<string, {
  label: string;
  run: (env: Env, request: Request) => Promise<DiagnosticsReport>;
}> = {
  'ping': { label: 'Cloudflare Environment', run: testPing },
  'cloudflare-ai-connectivity': { label: 'Cloudflare AI Connectivity', run: testCloudflareAIConnectivity },
  'cloudflare-ai-summary': { label: 'Full Summary (Known PDF)', run: testFullSummary },
  'pdf-extraction': { label: 'PDF Extraction Quality', run: testPdfExtraction },
  'time-budget': { label: 'Time Budget Breakdown', run: testTimeBudget },
  'end-to-end': { label: 'End-to-End Single Case', run: testEndToEnd },
};
