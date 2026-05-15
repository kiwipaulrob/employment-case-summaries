/**
 * summariser.ts — OpenRouter API client and prompt construction.
 *
 * All LLM calls are isolated here. To switch to a different provider or model:
 *   - Change OPENROUTER_MODEL env var (no code change required for any OpenRouter model)
 *   - To bypass OpenRouter entirely, update the baseUrl and auth header below
 *
 * Model capability detection:
 *   - Claude models (anthropic/*): support base64 PDF input natively
 *   - All other models: receive extracted plain text
 */

import type { CaseListing, OpenRouterRequest, OpenRouterResponse, SummaryResult } from './types';
import type { PdfContent } from './pdf';
import { truncateToTokenBudget } from './pdf';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ─── System prompt ────────────────────────────────────────────────────────────

/**
 * The system prompt instructs the model on the summary format and tone.
 * This is the same regardless of model or case — edit here to change behaviour globally.
 */
const SYSTEM_PROMPT = `You are a legal analyst summarising decisions of the New Zealand Employment Relations Authority (ERA) for an audience of employment law practitioners and HR professionals.

CRITICAL: Completeness is your ABSOLUTE PRIMARY goal. You must capture EVERY legal issue addressed by the determination, including: threshold and preliminary issues, secondary or alternative claims, statutory breach claims (e.g. s.4 of the Act), procedural matters (costs, penalties, further hearing orders), issues that were dismissed or not reached, and issues where the decision was partial or conditional. Omitting any issue from the determination is a failure. Even if an issue was dismissed, it must appear in your LEGAL ISSUES section so readers have a complete picture.

For each determination you receive, produce a structured summary in EXACTLY the following format. Do not add extra sections, commentary, or preamble before or after the structured output.

---FORMAT START---

PARTIES
Applicant: [name and role, e.g. "Jane Smith (employee)"]
Respondent: [name and role, e.g. "Acme Ltd (employer)"]

REPRESENTATIVES
Applicant: [counsel or advocate name and firm, or "Self-represented", or "No appearance"]
Respondent: [counsel or advocate name and firm, or "Self-represented", or "No appearance"]
CRITICAL: Extract representative names EXACTLY as stated in the determination. If the document says "No appearance" for a party, write exactly: "No appearance". Do NOT invent or speculate about representative names if they are not explicitly stated. If representative information is genuinely missing or unclear, write "Not provided".

FACTS
[4–6 sentences. Describe: the nature and duration of the employment relationship, the key chronological events leading to the dispute, clearly distinguish undisputed facts from facts in dispute, identify any procedural history (e.g. grievance, mediation), and state the key arguments each party advanced. Use plain language. Be accurate and conservative — do not infer beyond what is stated.]

LEGAL ISSUES
[EXTRACT ALL ISSUES from the determination, preserving their numbering and sequence. Do not filter or omit any issue. For each issue, state it as a precise question or statutory test. Include preliminary, threshold, secondary, procedural, and unsuccessful issues. Flag the status of each issue in square brackets: (Established), (Dismissed), (Not reached), (Partially established), or (Conditional).]
1. [Issue 1 — status: Established/Dismissed/Not reached/etc.]
2. [Issue 2 — status]
3. [Continue for ALL issues in the determination, not just the main claims.]

HOW THE ISSUES WERE RESOLVED
[Provide a resolution for EVERY issue listed above, numbered to match. For each issue (whether successful, unsuccessful, or not reached), provide 2–4 sentences explaining: (a) the applicable statutory or common law test or principles; (b) how (or whether) the Authority applied the evidence to that test; (c) any binding authorities or precedents cited; (d) the Authority's conclusion and reasoning. For issues not reached, explain why they were not reached.]
1. [Issue 1 resolution — 2–4 sentences]
2. [Issue 2 resolution]
3. [Continue, matching the numbering above. Every legal issue must have an equally detailed resolution.]

OUTCOME
[One sentence stating the overall result — e.g. "The claim was upheld in full / dismissed / partially upheld (X issue upheld, Y issue dismissed)."]

REMEDY (if applicable)
[Itemise all remedies ordered: e.g. "Compensation: $X,XXX (lost wages); $X,XXX (personal grievance); Interest: $ X,XXX; Reinstatement: [Y/N]; Reimbursement of costs: $X,XXX; Other conditions: [describe]." If no remedy was ordered, write "None ordered." If the determination is provisional, interim, conditional, or subject to later hearing, note this explicitly.]

---FORMAT END---

DOCUMENT TYPE FLAG
Before the PARTIES section, check the document title and determine whether this is:
- [FINAL DETERMINATION] A substantive determination on the merits (normal case).
- [CONSENT ORDER] A written consent order, agreed settlement, or withdrawal (not determined on merits).
- [INTERIM/INTERLOCUTORY] An interim order, strike-out decision, or application decision (not final).
- [COSTS ORDER] A costs or interest determination separate from the main claim.
If it is NOT a [FINAL DETERMINATION], flag this at the very top, e.g.: [INTERIM/INTERLOCUTORY: This decision relates to an application for interim relief, not the merits.]

COMPLETENESS CHECK
Before submitting your response, verify:
1. ALL issues mentioned in the determination are listed (do not filter for importance or outcome).
2. Every issue includes a status flag: (Established), (Dismissed), (Not reached), (Partially established), or (Conditional).
3. Every legal issue in the LEGAL ISSUES section has a matching numbered paragraph in HOW THE ISSUES WERE RESOLVED.
4. Every resolution explains the test, how it was applied, authorities cited, and the reasoning (not just the conclusion).
5. Issues that were not reached include explicit explanation of why they were not reached.
6. The REMEDY section itemises all compensation types, amounts, conditions, interim/final status, or notes "None ordered."
7. No issue, fact, or legal holding from the determination is omitted.
8. ANTI-HALLUCINATION CHECK: For the REPRESENTATIVES section, verify that every name and title is explicitly stated in the document. If a party had "No appearance", write exactly "No appearance". Do not invent names or speculate about representation that is not clearly stated.
If you cannot achieve this due to poor document quality or if you cannot identify all issues, respond only with: SUMMARY_UNAVAILABLE

Additional instructions:
- Use plain, accessible English. Do not assume the reader is a lawyer.
- Be factually accurate. Do not speculate about facts or law not stated in the document.
- CRITICAL: Never invent or hallucinate information. If a detail is not in the document, do not guess — write "Not provided" or leave it blank. This applies especially to representative names, party details, and legal authorities.
- Keep the total summary to approximately 500–800 words (longer is acceptable if necessary for completeness).
- Prioritise completeness over brevity. Include all material issues and resolutions.
- If you cannot access or read the document, respond only with: SUMMARY_UNAVAILABLE`;

// ─── Model capability detection ───────────────────────────────────────────────

/**
 * Returns true for models known to support native PDF (base64 document) input
 * via the Anthropic messages format (passed through by OpenRouter).
 */
function modelSupportsPdfInput(model: string): boolean {
  return model.startsWith('anthropic/');
}

// ─── Message construction ─────────────────────────────────────────────────────

function buildMessages(
  caseData: CaseListing,
  pdfContent: PdfContent,
  model: string
): OpenRouterRequest['messages'] {
  const metaPreamble =
    `Case title: ${caseData.title}\n` +
    `Date: ${caseData.datePublished ?? 'Unknown'}\n` +
    `Member: ${caseData.member ?? 'Unknown'}\n` +
    `Category: ${caseData.category ?? 'Unknown'}\n` +
    `Case URL: ${caseData.caseUrl}\n\n` +
    `Please summarise this Employment Relations Authority determination using the specified structured format.\n\n`;

  // Claude via OpenRouter: pass PDF as a base64 document in the content array
  if (pdfContent.strategy === 'base64' && modelSupportsPdfInput(model)) {
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: pdfContent.mediaType,
              data: pdfContent.data,
            },
          },
          {
            type: 'text',
            text: metaPreamble,
          },
        ],
      },
    ];
  }

  // All other models: pass extracted text inline
  const textContent =
    pdfContent.strategy === 'text'
      ? truncateToTokenBudget(pdfContent.text)
      : '[PDF content could not be extracted as text for this model. Summarise based on the metadata above if possible, otherwise respond with SUMMARY_UNAVAILABLE]';

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        metaPreamble +
        'Full determination text:\n\n' +
        '---\n' +
        textContent +
        '\n---',
    },
  ];
}

// ─── API call ─────────────────────────────────────────────────────────────────

async function callOpenRouter(
  request: OpenRouterRequest,
  apiKey: string
): Promise<string> {
  const response = await fetch(OPENROUTER_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://whenroutinebiteshard.com',
      'X-Title': 'ERA Determinations Digest',
    },
    body: JSON.stringify(request),
  });

  const json = (await response.json()) as OpenRouterResponse;

  if (!response.ok || json.error) {
    throw new Error(
      `OpenRouter API error ${response.status}: ${json.error?.message ?? JSON.stringify(json)}`
    );
  }

  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenRouter returned an empty response');
  }

  return content.trim();
}

// ─── Summarise a single case ──────────────────────────────────────────────────

/**
 * Generates a structured summary for one case.
 * Retries once on failure before returning a fallback message.
 */
export async function summariseCase(
  caseData: CaseListing,
  pdfContent: PdfContent,
  apiKey: string,
  model: string
): Promise<SummaryResult> {
  const request: OpenRouterRequest = {
    model,
    messages: buildMessages(caseData, pdfContent, model),
    max_tokens: 2500, // ≈1,800–2,000 words for complex cases with many legal issues
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      let summary = await callOpenRouter(request, apiKey);

      if (summary.includes('SUMMARY_UNAVAILABLE')) {
        return {
          caseId: caseData.caseId,
          summary: `Summary unavailable — the model could not access or read the determination. [View full determination](${caseData.caseUrl})`,
          success: false,
          error: 'Model returned SUMMARY_UNAVAILABLE',
        };
      }

      // Strip LLM preambles and artifacts
      summary = stripLlmArtifacts(summary);

      return { caseId: caseData.caseId, summary, success: true };
    } catch (err) {
      if (attempt === 1) {
        console.warn(
          `Summarisation attempt 1 failed for case ${caseData.caseId}: ${err}. Retrying in 5s...`
        );
        await sleep(5000);
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`Summarisation failed for case ${caseData.caseId} after 2 attempts: ${errMsg}`);
        return {
          caseId: caseData.caseId,
          summary: `Summary unavailable — an error occurred during summarisation. [View full determination](${caseData.caseUrl})`,
          success: false,
          error: errMsg,
        };
      }
    }
  }

  // TypeScript requires a return here (unreachable)
  return {
    caseId: caseData.caseId,
    summary: `Summary unavailable. [View full determination](${caseData.caseUrl})`,
    success: false,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Strips LLM preambles and artifacts from the summary.
 * Examples of what gets removed:
 *   - "I'll analyze this determination..."
 *   - "Let me provide a structured summary..."
 *   - "[FINAL DETERMINATION]" flags
 *   - "---FORMAT START---" / "---FORMAT END---" markers
 */
function stripLlmArtifacts(text: string): string {
  let cleaned = text;

  // Remove common preambles
  cleaned = cleaned.replace(/^['"']?I['']ll\s+(analyze|summarize)\s+.*?\.?\s*\n\n/is, '');
  cleaned = cleaned.replace(/^['"']?Let\s+me\s+(provide|give)\s+.*?\.?\s*\n\n/is, '');
  cleaned = cleaned.replace(/^['"']?Here['']s\s+.*?\.?\s*\n\n/is, '');

  // Remove document type flags
  cleaned = cleaned.replace(/^\[FINAL DETERMINATION\]\s*\n\n/im, '');
  cleaned = cleaned.replace(/^\[INTERIM[^\]]*\]\s*\n\n/im, '');
  cleaned = cleaned.replace(/^\[CONSENT ORDER\]\s*\n\n/im, '');
  cleaned = cleaned.replace(/^\[COSTS ORDER\]\s*\n\n/im, '');

  // Remove format markers
  cleaned = cleaned.replace(/^---?FORMAT\s+START---?\s*\n*/im, '');
  cleaned = cleaned.replace(/\n*---?FORMAT\s+END---?\s*$/im, '');

  return cleaned.trim();
}
