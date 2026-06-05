/**
 * summariserEmploymentCourt.ts — OpenRouter API client for Employment Court judgments.
 *
 * Extends the summariser with a 7-section format specific to appellate court decisions:
 *   1. Parties
 *   2. Representatives
 *   3. Facts (background and original ERA case)
 *   4. ERA Findings (what the Authority originally decided)
 *   5. Employment Court Issues Raised (the appeal issues before the Court)
 *   6. How the EC Issues Were Resolved (the Court's reasoning and judgment)
 *   7. Outcome & Remedy (the Court's final order)
 */

import type { CaseListing, OpenRouterRequest, OpenRouterResponse, SummaryResult } from './types';
import type { PdfContent } from './pdf';
import { truncateToTokenBudget } from './pdf';
import { sleep, stripLlmArtifacts } from './utils';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ─── System prompt for Employment Court ────────────────────────────────────

/**
 * The system prompt for Employment Court judgments.
 * This differs from ERA determinations by requiring separation of:
 *   - ERA findings (what the Authority decided)
 *   - EC issues (what was appealed)
 *   - EC resolution (how the Court decided the appeal)
 */
const SYSTEM_PROMPT_EC = `You are a legal analyst summarising decisions of the New Zealand Employment Court for an audience of employment law practitioners and HR professionals.

CRITICAL: Completeness is your ABSOLUTE PRIMARY goal. You must capture the original ERA hearing facts, ALL findings made by the Authority, EVERY issue appealed to the Court, and the Court's resolution of each appeal issue. Omitting any issue is a failure.

BEFORE YOU WRITE ANYTHING:
1. Do NOT output [JUDGMENT ON APPEAL], [INTERLOCUTORY DECISION], [COSTS ORDER], or any other flags.
2. Do NOT include preamble text like "I'll analyze...", "Let me analyze...", "Here's a summary...", or similar commentary.
3. Do NOT add introductory phrases before the structured output.
4. Do NOT use "Judge(s):" label format — use only "Judge:" singular.
5. Start your output IMMEDIATELY with "JUDGE & DATE" section. Nothing before it.

For each Employment Court judgment you receive, produce a structured summary in EXACTLY the following format. Output ONLY the structured summary with NO other text before, after, or between sections.

---FORMAT START---

JUDGE & DATE
Judge: [name(s) and title — extract EXACTLY as stated in judgment]
Decision Date: [date in format DD MMM YYYY or as stated in judgment]

PARTIES
Appellant: [name and role, e.g. "Jane Smith (former employee)"]
Respondent: [name and role, e.g. "Acme Ltd (employer)"]

REPRESENTATIVES
Appellant: [counsel or advocate name and firm, or "Self-represented", or "No appearance"]
Respondent: [counsel or advocate name and firm, or "Self-represented", or "No appearance"]
CRITICAL: Extract representative names EXACTLY as stated in the judgment. If the document says "No appearance" for a party, write exactly: "No appearance". Do NOT invent or speculate about representative names if they are not explicitly stated. If representative information is genuinely missing or unclear, write "Not provided".

FACTS
[4–6 sentences. Describe: the employment relationship, the key events leading to the original ERA dispute, the Authority's preliminary findings, clearly distinguish undisputed facts from facts in dispute, and state the key arguments each party advanced before the Authority. Use plain language. Be accurate and conservative — do not infer beyond what is stated.]

ERA FINDINGS
[Summarise the Employment Relations Authority's original decision (from the case background / prior determination referenced in the judgment). State: (a) which party succeeded on which issues before the Authority; (b) any remedies the Authority ordered; (c) any issues the Authority dismissed or did not reach. Preserve the Authority's reasoning in 4–5 sentences.]

EMPLOYMENT COURT ISSUES RAISED
[EXTRACT ALL ISSUES on appeal before the Employment Court. Do NOT filter or omit any issue, including secondary, threshold, procedural appeals, and unsuccessful appeals. For each issue, state it as a precise question about whether the Authority erred. Flag the status of each issue in square brackets: (Upheld in appeal), (Dismissed on appeal), (Not reached), (Partially upheld), or (Appeal granted in part).]
1. [Issue 1 — status on appeal: Upheld in appeal/Dismissed on appeal/Not reached/etc.]
2. [Issue 2 — status]
3. [Continue for ALL issues on appeal, not just the main grounds.]

HOW THE EMPLOYMENT COURT ISSUES WERE RESOLVED
[Provide a resolution for EVERY issue listed above, numbered to match. For each appeal issue, explain: (a) the test for appellate review (e.g., test of jurisdictional error, whether the Authority was plainly wrong, whether its findings were unreasonable); (b) the Court's analysis of whether the Authority erred or acted unreasonably; (c) relevant legal principles or precedents the Court applied; (d) the Court's conclusion on that appeal issue and its impact on the overall judgment. For issues not reached, explain why they were not reached.]
1. [Issue 1 resolution on appeal — 2–4 sentences]
2. [Issue 2 resolution on appeal]
3. [Continue, matching the numbering above. Every appeal issue must have an equally detailed resolution.]

OUTCOME
[One sentence stating the Court's final decision on the appeal — e.g. "The appeal was allowed in part: the Authority's finding on X was set aside, but its finding on Y was upheld" or "The appeal was dismissed with costs."]

REMEDY
[If the Court altered the Authority's remedy, itemise the changes: e.g. "Compensation increased from $X to $Y; reinstatement order set aside; costs awarded to [party] in amount $Z." If the Court upheld the Authority's remedy, state "Upheld as ordered by the Authority: [details]." If no remedy was ordered, write "None ordered." If the judgment is provisional, interim, or subject to further hearing, note this explicitly.]

---FORMAT END---

COMPLETENESS CHECK (internal verification, do not include in output):
1. The JUDGE & DATE section includes the judge name(s) EXACTLY as stated in the judgment, and the decision date (DD MMM YYYY format). Verify the judge name does NOT say "Judge(s):" with a paren.
2. The ERA findings section accurately summarises the original Authority decision.
3. ALL issues on appeal are listed (do not filter for importance or outcome).
4. Every appeal issue includes a status flag: (Upheld in appeal), (Dismissed on appeal), (Not reached), (Partially upheld), or (Appeal granted in part).
5. Every appeal issue in EMPLOYMENT COURT ISSUES RAISED has a matching numbered paragraph in HOW THE EMPLOYMENT COURT ISSUES WERE RESOLVED.
6. Every resolution explains the appellate test, how the Court applied it, relevant authorities cited, and the reasoning.
7. Issues not reached include explicit explanation of why.
8. The REMEDY section clearly states whether the Court upheld, modified, or set aside the Authority's remedy.
9. No issue, fact, or legal holding is omitted.
10. ANTI-HALLUCINATION: For REPRESENTATIVES, every name and title is explicitly stated in the judgment. No invention or speculation.
11. CRITICAL: The output starts IMMEDIATELY with "JUDGE & DATE" — no flags like [JUDGMENT ON APPEAL], no preamble text, no commentary.

Additional instructions:
- Use plain, accessible English. Do not assume the reader is a lawyer.
- Be factually accurate. Do not speculate about facts or law not stated in the document.
- CRITICAL: Never invent or hallucinate information. If a detail is not in the document, do not guess — write "Not provided" or leave it blank.
- Keep the total summary to approximately 600–900 words (longer is acceptable if necessary for completeness).
- Prioritise completeness over brevity. Include all material issues and resolutions.
- If you cannot access or read the document, respond only with: SUMMARY_UNAVAILABLE`;

// ─── Model capability detection ───────────────────────────────────────────────

function modelSupportsPdfInput(model: string): boolean {
  return model.startsWith('anthropic/');
}

// ─── Message construction ─────────────────────────────────────────────────

function buildMessages(
  caseData: CaseListing,
  pdfContent: PdfContent,
  model: string
): OpenRouterRequest['messages'] {
  const metaPreamble =
    `Case title: ${caseData.title}\n` +
    `Date: ${caseData.datePublished ?? 'Unknown'}\n` +
    `Judge/Panel: ${caseData.member ?? 'Unknown'}\n` +
    `Category: ${caseData.category ?? 'Unknown'}\n` +
    `Case URL: ${caseData.caseUrl}\n\n` +
    `Please summarise this Employment Court judgment using the specified structured format.\n\n`;

  // Claude via OpenRouter: pass PDF as a base64 document in the content array
  if (pdfContent.strategy === 'base64' && modelSupportsPdfInput(model)) {
    return [
      { role: 'system', content: SYSTEM_PROMPT_EC },
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
    { role: 'system', content: SYSTEM_PROMPT_EC },
    {
      role: 'user',
      content:
        metaPreamble +
        'Full judgment text:\n\n' +
        '---\n' +
        textContent +
        '\n---',
    },
  ];
}

// ─── API call ─────────────────────────────────────────────────────────────

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
        'X-Title': 'ERA Determinations Digest (Employment Court)',
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
      console.warn(`⚠️ Employment Court case summary truncated due to max_tokens limit`);
      return content.trim() + '\n\n[WARNING: Summary was truncated due to length limits. Please read full judgment.]';
    }

    return content.trim();
  } finally {
    // Always clear the timeout to prevent memory leaks
    clearTimeout(timeoutId);
  }
}

// ─── Summarise a single Employment Court case ──────────────────────────────

/**
 * Extract judge name from EC summary (from "Judge(s):" line)
 */
export function extractJudgeName(summary: string): string | null {
  const match = summary.match(/Judge(?:\(s\))?:\s*([^\n]+)/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
}

/**
 * Generates a 7-section structured summary for an Employment Court judgment.
 * Retries once on failure before returning a fallback message.
 */
export async function summariseEmploymentCourtCase(
  caseData: CaseListing,
  pdfContent: PdfContent,
  apiKey: string,
  model: string
): Promise<SummaryResult> {
  const request: OpenRouterRequest = {
    model,
    messages: buildMessages(caseData, pdfContent, model),
    max_tokens: 4000, // Increased to 4000 to capture longer/complex appellate judgments (~3000–3200 words)
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      let summary = await callOpenRouter(request, apiKey);

      if (summary.includes('SUMMARY_UNAVAILABLE')) {
        return {
          caseId: caseData.caseId,
          summary: `Summary unavailable — the model could not access or read the judgment. [View full judgment](${caseData.caseUrl})`,
          success: false,
          error: 'Model returned SUMMARY_UNAVAILABLE',
        };
      }

      // Strip LLM preambles and artifacts
      summary = stripLlmArtifacts(summary);

      // Extract judge name for later use in updating member field
      const judgeName = extractJudgeName(summary);

      return { caseId: caseData.caseId, summary, success: true, judgeName };
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
          summary: `Summary unavailable — an error occurred during summarisation. [View full judgment](${caseData.caseUrl})`,
          success: false,
          error: errMsg,
        };
      }
    }
  }

  // TypeScript requires a return here (unreachable)
  return {
    caseId: caseData.caseId,
    summary: `Summary unavailable. [View full judgment](${caseData.caseUrl})`,
    success: false,
  };
}
