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
export async function scrapeRecentPage(sourceUrl: string): Promise<CaseListing[]> {
  const response = await fetch(sourceUrl, {
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
