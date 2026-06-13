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
import { sleep, stripLlmArtifacts } from './utils';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ─── System prompt ────────────────────────────────────────────────────────────

/**
 * The system prompt instructs the model on the summary format and tone.
 * This is the same regardless of model or case — edit here to change behaviour globally.
 */
const SYSTEM_PROMPT = `CLASSIFICATION TAG (FIRST LINE ONLY): If this case is solely about fixing or apportioning costs, begin your summary with [COSTS ONLY] as the very first line. If it is an order or decision made by consent of both parties, begin with [CONSENT] as the very first line. Otherwise begin with no tag. The tag must be on its own line with no other text on that line.

You are a legal analyst summarising decisions of the New Zealand Employment Relations Authority (ERA) for an audience of employment law practitioners and HR professionals.

CRITICAL: Completeness is your ABSOLUTE PRIMARY goal. You must capture EVERY legal issue addressed by the determination, including: threshold and preliminary issues, secondary or alternative claims, statutory breach claims (e.g. s.4 of the Act), procedural matters (costs, penalties, further hearing orders), issues that were dismissed or not reached, and issues where the decision was partial or conditional. Omitting any issue from the determination is a failure. Even if an issue was dismissed, it must appear in your LEGAL ISSUES section so readers have a complete picture.

For each determination you receive, produce a structured summary in EXACTLY the following format. Do not add extra sections, commentary, or preamble before or after the structured output.

---FORMAT START---

PARTIES
Applicant: [name and role, e.g. "Jane Smith (employee)"]
Respondent: [name and role, e.g. "Acme Ltd (employer)"]
CRITICAL — PARTIES must name the actual parties to the dispute: the employee (applicant) by their own personal name, and the employer entity (respondent) by its legal name. Never list a lawyer, counsel, or legal representative as a party. ERA case headings and registry titles sometimes carry a counsel's name — disregard the title entirely and extract the real party names from the body of the determination (e.g., the Background or "The parties" section).

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

|REMEDY
[Itemise all remedies ordered: e.g. "Compensation: $X,XXX (lost wages); $X,XXX (personal grievance); Interest: $ X,XXX; Reinstatement: [Y/N]; Reimbursement of costs: $X,XXX; Other conditions: [describe]." If no remedy was ordered, write "None ordered." If the determination is provisional, interim, conditional, or subject to later hearing, note this explicitly.]

---FORMAT END---

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
- If you cannot access or read the document, respond only with: SUMMARY_UNAVAILABLE

AWARDS DATA EXTRACTION (append this block at the very end of your response, after the REMEDY section)
After you finish the REMEDY section, output the following structured block verbatim — it is stripped before display and used only for analytics. Use "nil" for any field that is not awarded, not stated, or not applicable.

AWARDS_DATA
HHD: [dollar amount of hurt/humiliation/distress award, e.g. $12,500 — or nil]
Lost wages: [total dollar amount of lost wages/wage compensation ordered, e.g. $8,400 — or nil]
Weekly wage: [weekly wage of the claimant if stated anywhere in the determination, e.g. $950 — or nil]
Lost wages weeks: [number of weeks the lost wages figure represents, e.g. 8.8 — or nil if cannot be calculated]
Costs: [dollar amount of any costs order, e.g. $2,500 — or nil]
Reinstatement: [yes or no]
Outcome: [applicant if the employee/applicant succeeded; respondent if the employer/respondent succeeded; mixed if partial; none if no determination on merits]
AWARDS_DATA_END`;

// ─── Model capability detection ───────────────────────────────────────────────

/**
 * Returns true for models known to support native PDF (base64 document) input
 * via the Anthropic messages format (passed through by OpenRouter).
 */
function modelSupportsPdfInput(model: string): boolean {
  return model.startsWith('anthropic/');
}

// ─── Dynamic prompt resolution ────────────────────────────────────────────────

/**
 * Returns the active ERA system prompt.
 * Prefers the version stored in D1 (editable via admin UI) over the hardcoded constant.
 * Falls back to the hardcoded SYSTEM_PROMPT if D1 is unavailable or empty.
 */
async function resolveEraPrompt(db?: D1Database): Promise<string> {
  if (db) {
    try {
      const row = await db
        .prepare("SELECT value FROM config WHERE key = 'prompt_era'")
        .first<{ value: string }>();
      if (row?.value?.trim()) return row.value.trim();
    } catch {
      console.warn('ERA Digest: Could not read prompt_era from D1, using hardcoded fallback');
    }
  }
  return SYSTEM_PROMPT;
}

// ─── Message construction ─────────────────────────────────────────────────────

function buildMessages(
  caseData: CaseListing,
  pdfContent: PdfContent,
  model: string,
  systemPrompt: string
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
      { role: 'system', content: systemPrompt },
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
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content:
        metaPreamble +
        'Full determination text:\n\n' +
        '<document>\n' +
        textContent +
        '\n</document>',
    },
  ];
}

// ─── API call ─────────────────────────────────────────────────────────────────

async function callOpenRouter(
  request: OpenRouterRequest,
  apiKey: string
): Promise<string> {
  // Create an AbortController with a 45-second timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch(OPENROUTER_BASE_URL, {
      method: 'POST',
      signal: controller.signal,
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

    const message = json.choices?.[0];
    const content = message?.message?.content;
    if (!content) {
      throw new Error('OpenRouter returned an empty response');
    }

    // Check if the response was truncated due to token limit
    if (message?.finish_reason === 'length') {
      console.warn(`⚠️ ERA case summary truncated due to max_tokens limit`);
      return content.trim() + '\n\n[WARNING: Summary was truncated due to length limits. Please read full PDF.]';
    }

    return content.trim();
  } finally {
    // Always clear the timeout to prevent memory leaks
    clearTimeout(timeoutId);
  }
}

// ─── Summarise a single case ──────────────────────────────────────────────────

/**
 * Generates a structured summary for one case.
 * Retries once on failure before returning a fallback message.
 *
 * @param db  Optional D1 database — if provided, the active prompt is read from the
 *            `prompt_era` config key so edits in the admin UI take effect without redeploying.
 *            Falls back to the hardcoded SYSTEM_PROMPT if D1 is unavailable or empty.
 */
export async function summariseCase(
  caseData: CaseListing,
  pdfContent: PdfContent,
  apiKey: string,
  model: string,
  db?: D1Database
): Promise<SummaryResult> {
  // Resolve the active prompt — D1 first, hardcoded constant as fallback
  const systemPrompt = await resolveEraPrompt(db);

  const request: OpenRouterRequest = {
    model,
    messages: buildMessages(caseData, pdfContent, model, systemPrompt),
    max_tokens: 4000, // 4000 tokens to capture longer/complex cases with many legal issues (~3000–3200 words)
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

// sleep is imported from ./utils (shared with EC summariser)
