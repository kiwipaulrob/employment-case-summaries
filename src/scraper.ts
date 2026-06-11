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
 */

import type { CaseListing } from './types';

const BASE_URL = 'https://determinations.era.govt.nz';
const USER_AGENT =
  'ERA-Digest/1.0 (automated digest; contact: digest@whenroutinebiteshard.com)';

// ─── Recent page scraper ──────────────────────────────────────────────────────

/**
 * Fetches a single page of recent ERA determinations.
 * @param sourceUrl   — Base URL of the ERA recent determinations page
 * @param startOffset — Pagination offset (0 = first page, 10 = second, etc.)
 */
export async function scrapeRecentPage(sourceUrl: string, startOffset = 0): Promise<CaseListing[]> {
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

    .on('li.search-results__record', {
      element(el) {
        record = {
          caseId: null, caseUrl: null, titleBuffer: '', inTitleLink: false,
          afterTitleP: false, memberBuffer: '', collectMember: false,
          pdfUrl: null, inDataList: false, dataListPCount: 0,
          pBuffer: '', collectP: false, datePublished: null, citation: null,
        };
        el.onEndTag(() => {
          if (!record || !record.caseId) { record = null; return; }
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

    .on('p.search-results__record__title', {
      element(el) {
        el.onEndTag(() => { if (record) record.afterTitleP = true; });
      },
    })

    .on('a[href]', {
      element(el) {
        if (!record) return;
        const href = el.getAttribute('href') ?? '';
        const caseMatch = href.match(/\/determination\/view\/(\d+)/i);
        if (caseMatch) {
          record.caseId = caseMatch[1];
          record.caseUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
          record.inTitleLink = true;
          record.titleBuffer = '';
          el.onEndTag(() => { if (record) record.inTitleLink = false; });
          return;
        }
        if (href.match(/\/assets\/elawpdf\//i) || href.match(/\.pdf$/i)) {
          record.pdfUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        }
      },
      text(chunk) {
        if (record && record.inTitleLink) record.titleBuffer += chunk.text;
      },
    })

    .on('ul.search-results__record__data', {
      element(el) {
        if (!record) return;
        record.inDataList = true;
        record.dataListPCount = 0;
        el.onEndTag(() => { if (record) record.inDataList = false; });
      },
    })

    .on('p', {
      element(el) {
        if (!record) return;
        if (record.inDataList) {
          record.dataListPCount++;
          record.pBuffer = '';
          record.collectP = true;
          el.onEndTag(() => {
            if (!record) return;
            record.collectP = false;
            const text = record.pBuffer.trim();
            if (record.dataListPCount === 1) record.datePublished = text;
            else if (record.dataListPCount === 2) record.citation = text;
            record.pBuffer = '';
          });
        } else if (record.afterTitleP && !record.collectMember) {
          record.afterTitleP = false;
          record.collectMember = true;
          record.memberBuffer = '';
          el.onEndTag(() => { if (record) record.collectMember = false; });
        }
      },
      text(chunk) {
        if (!record) return;
        if (record.collectP) record.pBuffer += chunk.text;
        else if (record.collectMember) record.memberBuffer += chunk.text;
      },
    });

  await rewriter.transform(response).arrayBuffer();

  if (cases.length === 0) {
    throw new Error('No cases found on the ERA recent page. The page structure may have changed.');
  }
  return cases;
}

// ─── Multi-page scraper ───────────────────────────────────────────────────────

/**
 * Scrapes multiple pages of ERA recent determinations and returns a combined,
 * deduplicated list.
 */
export async function scrapeAllPages(pages: number, sourceUrl: string): Promise<CaseListing[]> {
  const seen = new Set<string>();
  const all: CaseListing[] = [];
  for (let p = 0; p < pages; p++) {
    const offset = p * 10;
    try {
      const pageCases = await scrapeRecentPage(sourceUrl, offset);
      for (const c of pageCases) {
        if (!seen.has(c.caseId)) { seen.add(c.caseId); all.push(c); }
      }
      console.log(`scrapeAllPages: page ${p + 1} (offset ${offset}) — ${pageCases.length} cases fetched, ${all.length} unique so far`);
    } catch (err) {
      console.warn(`scrapeAllPages: failed to fetch page ${p + 1} (offset ${offset}): ${err}`);
    }
  }
  return all;
}

// ─── enrichCasesWithDetails (retained for interface compatibility) ─────────────

export async function enrichCasesWithDetails(cases: CaseListing[]): Promise<CaseListing[]> {
  return cases;
}

// ─── fetchCaseDetail (retained for future use) ────────────────────────────────

export async function fetchCaseDetail(caseUrl: string): Promise<{
  pdfUrl: string | null;
  title: string | null;
  member: string | null;
  datePublished: string | null;
  category: string | null;
}> {
  const response = await fetch(caseUrl, { headers: { 'User-Agent': USER_AGENT } });
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
