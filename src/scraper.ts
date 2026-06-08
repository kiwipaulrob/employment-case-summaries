/**
 * scraper.ts — Scrapes the ERA recent determinations page.
 *
 * The ERA recent page uses a list layout:
 *
 *   <li class="search-results__record">
 *     <p class="search-results__record__title">
 *       <a href="/determination/view/21179">TITLE</a>
 *     </p>
 *     <p>Robert Davies [Employment Relations Authority - Auckland]</p>
 *     <ul class="search-results__record__data ...">
 *       <li><a href="/assets/elawpdf/2026/2026-NZERA-225.pdf">PDF</a></li>
 *       <li><p>15 April 2026</p></li>
 *       <li><p>[2026] NZERA 225</p></li>
 *     </ul>
 *   </li>
 *
 * All fields — including the PDF URL — are available on the list page itself,
 * so no N+1 detail-page fetches are required.
 */

import type { CaseListing } from './types';

const BASE_URL = 'https://determinations.era.govt.nz';
const USER_AGENT =
  'ERA-Digest/1.0 (automated digest; contact: digest@whenroutinebiteshard.com)';

// ─── Recent page scraper ──────────────────────────────────────────────────────

/**
 * Fetches the recent determinations page and returns all cases with full metadata,
 * including PDF URLs. All data is extracted from the list page in a single request.
 */
/**
 * Fetches a single page of recent ERA determinations.
 *
 * Option A — Pagination support (8 June 2026):
 * ERA's listing page supports a ?start=N offset parameter which shifts the
 * results window by N cases. Each page shows 10 cases, so:
 *   start=0  → cases 1–10  (default, same as base URL)
 *   start=10 → cases 11–20 (page 2)
 *   start=20 → cases 21–30 (page 3)
 * This allows backfilling cases that appeared on the listing in the last
 * 10 days but have since been pushed off by newer publications.
 *
 * @param sourceUrl   — Base URL of the ERA recent determinations page
 * @param startOffset — Pagination offset (0 = first page, 10 = second, etc.)
 */
export async function scrapeRecentPage(sourceUrl: string, startOffset = 0): Promise<CaseListing[]> {
  // Build the page URL — append ?start=N for pages beyond the first
  const pageUrl = startOffset > 0 ? `${sourceUrl}?start=${startOffset}` : sourceUrl;
  const response = await fetch(pageUrl, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(
      `ERA recent page returned HTTP ${response.status}: ${response.statusText}`
    );
  }

  interface RecordState {
    caseId: string | null;
    caseUrl: string | null;
    titleBuffer: string;
    inTitleLink: boolean;
    afterTitleP: boolean;
    memberBuffer: string;
    collectMember: boolean;
    pdfUrl: string | null;
    inDataList: boolean;
    dataListPCount: number;
    pBuffer: string;
    collectP: boolean;
    datePublished: string | null;
    citation: string | null;
  }

  const cases: CaseListing[] = [];
  let record: RecordState | null = null;

  const rewriter = new HTMLRewriter()

    // ── Record boundary ──────────────────────────────────────────────────────
    .on('li.search-results__record', {
      element(el) {
        record = {
          caseId: null,
          caseUrl: null,
          titleBuffer: '',
          inTitleLink: false,
          afterTitleP: false,
          memberBuffer: '',
          collectMember: false,
          pdfUrl: null,
          inDataList: false,
          dataListPCount: 0,
          pBuffer: '',
          collectP: false,
          datePublished: null,
          citation: null,
        };

        el.onEndTag(() => {
          if (!record || !record.caseId) {
            record = null;
            return;
          }

          // Member field: "Robert Davies [Employment Relations Authority - Auckland]"
          // Strip the location suffix in square brackets to get just the name.
          const memberRaw = record.memberBuffer.trim();
          const memberName = memberRaw.includes('[')
            ? memberRaw.substring(0, memberRaw.lastIndexOf('[')).trim()
            : memberRaw || null;

          cases.push({
            caseId: record.caseId,
            title: record.titleBuffer.trim(),
            caseUrl: record.caseUrl!,
            pdfUrl: record.pdfUrl,
            member: memberName || null,
            datePublished: record.datePublished?.trim() || null,
            category: record.citation?.trim() || null,
          });

          record = null;
        });
      },
    })

    // ── Title paragraph end → signals next <p> is the member paragraph ───────
    .on('p.search-results__record__title', {
      element(el) {
        el.onEndTag(() => {
          if (record) record.afterTitleP = true;
        });
      },
    })

    // ── Links: case URL and PDF URL ──────────────────────────────────────────
    .on('a[href]', {
      element(el) {
        if (!record) return;
        const href = el.getAttribute('href') ?? '';

        // Case detail link: /determination/view/12345
        const caseMatch = href.match(/\/determination\/view\/(\d+)/i);
        if (caseMatch) {
          record.caseId = caseMatch[1];
          record.caseUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
          record.inTitleLink = true;
          record.titleBuffer = '';
          el.onEndTag(() => {
            if (record) record.inTitleLink = false;
          });
          return;
        }

        // PDF link: /assets/elawpdf/...pdf
        if (href.match(/\/assets\/elawpdf\//i) || href.match(/\.pdf$/i)) {
          record.pdfUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        }
      },
      text(chunk) {
        if (record && record.inTitleLink) {
          record.titleBuffer += chunk.text;
        }
      },
    })

    // ── Data list boundary ───────────────────────────────────────────────────
    .on('ul.search-results__record__data', {
      element(el) {
        if (!record) return;
        record.inDataList = true;
        record.dataListPCount = 0;
        el.onEndTag(() => {
          if (record) record.inDataList = false;
        });
      },
    })

    // ── All <p> elements: member paragraph and data list paragraphs ──────────
    .on('p', {
      element(el) {
        if (!record) return;

        if (record.inDataList) {
          // Paragraphs inside the data list: 1st = date, 2nd = citation
          record.dataListPCount++;
          record.pBuffer = '';
          record.collectP = true;
          el.onEndTag(() => {
            if (!record) return;
            record.collectP = false;
            const text = record.pBuffer.trim();
            if (record.dataListPCount === 1) {
              record.datePublished = text;
            } else if (record.dataListPCount === 2) {
              record.citation = text;
            }
            record.pBuffer = '';
          });
        } else if (record.afterTitleP && !record.collectMember) {
          // The paragraph immediately after the title = member name + location
          record.afterTitleP = false;
          record.collectMember = true;
          record.memberBuffer = '';
          el.onEndTag(() => {
            if (record) record.collectMember = false;
          });
        }
      },
      text(chunk) {
        if (!record) return;
        if (record.collectP) {
          record.pBuffer += chunk.text;
        } else if (record.collectMember) {
          record.memberBuffer += chunk.text;
        }
      },
    });

  // Consume the response, triggering all HTMLRewriter callbacks
  await rewriter.transform(response).arrayBuffer();

  if (cases.length === 0) {
    throw new Error(
      'No cases found on the ERA recent page. The page structure may have changed.'
    );
  }

  return cases;
}


// ─── Multi-page scraper ───────────────────────────────────────────────────────

/**
 * Scrapes multiple pages of ERA recent determinations and returns a combined,
 * deduplicated list of all cases found.
 *
 * Option A — Backfill support (added 8 June 2026):
 * The ERA listing page shows cases from roughly the last 10 days spread across
 * up to 3 pages (10 cases each). By scraping all pages we can recover cases
 * that were published recently but have since been pushed off page 1.
 *
 * Deduplication is by caseId (the ERA integer ID from the case URL) so any
 * overlap between page requests is silently removed.
 *
 * @param pages      — Number of pages to fetch (1 = first 10 cases, 3 = up to 30)
 * @param sourceUrl  — Base URL of the ERA recent determinations page
 */
export async function scrapeAllPages(pages: number, sourceUrl: string): Promise<CaseListing[]> {
  const seen = new Set<string>();
  const all: CaseListing[] = [];

  for (let p = 0; p < pages; p++) {
    const offset = p * 10;
    try {
      const pageCases = await scrapeRecentPage(sourceUrl, offset);
      for (const c of pageCases) {
        const key = c.caseId;
        if (!seen.has(key)) {
          seen.add(key);
          all.push(c);
        }
      }
      console.log(`scrapeAllPages: page ${p + 1} (offset ${offset}) — ${pageCases.length} cases fetched, ${all.length} unique so far`);
    } catch (err) {
      // Log but continue — a missing page shouldn't abort the whole backfill
      console.warn(`scrapeAllPages: failed to fetch page ${p + 1} (offset ${offset}): ${err}`);
    }
  }

  return all;
}

// ─── Stub: enrichCasesWithDetails ────────────────────────────────────────────
// The ERA list page now includes PDF URLs directly, so no detail-page fetches
// are needed. This function is retained for interface compatibility but simply
// returns the input unchanged.

export async function enrichCasesWithDetails(
  cases: CaseListing[]
): Promise<CaseListing[]> {
  return cases;
}

// ─── fetchCaseDetail (retained for future use / V2) ──────────────────────────

export async function fetchCaseDetail(caseUrl: string): Promise<{
  pdfUrl: string | null;
  title: string | null;
  member: string | null;
  datePublished: string | null;
  category: string | null;
}> {
  const response = await fetch(caseUrl, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    return { pdfUrl: null, title: null, member: null, datePublished: null, category: null };
  }

  let pdfUrl: string | null = null;

  const rewriter = new HTMLRewriter()
    .on('a[href]', {
      element(el) {
        const href = el.getAttribute('href') ?? '';
        if (href.match(/\/assets\/elawpdf\//i) || href.match(/\.pdf$/i)) {
          pdfUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        }
      },
    });

  await rewriter.transform(response).arrayBuffer();

  return { pdfUrl, title: null, member: null, datePublished: null, category: null };
}
