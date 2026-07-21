/**
 * DRAFT — Data Block Extraction System
 * 
 * Adds multi-block extraction to the existing backfill-awards endpoint.
 * Single LLM call per case extracts awards + legal issues + parties + key dates.
 * 
 * Requires:
 *   1. Add these query functions to src/db.ts
 *   2. Replace the backfill endpoint in src/index.ts (lines 1183-1316)
 *   3. Add a dashboard button text in src/dashboard.ts
 *   4. Optionally: migration for new tables
 */

// ═══════════════════════════════════════════════════════════════════
// PART 1: src/db.ts — New query functions
// ═══════════════════════════════════════════════════════════════════

// --- Data block types ---

export interface ExtractedData {
  // Awards (existing, consolidated)
  hhd_amount: number | null;
  lost_wages: number | null;
  weekly_wage: number | null;
  lost_wages_weeks: number | null;
  costs_awarded: number | null;
  costs_awarded_text: string | null;
  reinstatement: boolean | null;
  reinstatement_sought: boolean | null;
  employee_status: boolean | null;
  outcome: string | null;
  extraction_method: string | null;
  decision_date: string | null;
  employment_tenure: string | null;
  contribution_applied: boolean | null;
  contribution_reduction: string | null;
  contribution_conduct: string | null;
  penalties: number | null;

  // New: Legal issues (semicolon-separated)
  legal_issues: string | null;       // e.g. "unjustified dismissal; unjustified disadvantage; constructive dismissal"
  legal_issues_applicant_won: string | null;     // subset that succeeded for applicant
  legal_issues_respondent_won: string | null;    // subset that were dismissed

  // New: Parties metadata
  party_applicant: string | null;
  party_respondent: string | null;
  representative_applicant: string | null;
  representative_respondent: string | null;

  // New: Key dates
  employment_start: string | null;   // YYYY-MM-DD
  dismissal_date: string | null;     // YYYY-MM-DD
  grievance_raised: string | null;   // YYYY-MM-DD

  // New: Keywords / tags
  keywords: string | null;           // semicolon-separated e.g. "reinstatement;interim;public interest"
}

/**
 * Updates a case_awards row with all extracted data blocks.
 * Creates the row if it doesn't exist (upsert).
 */
export async function upsertExtractedData(
  db: D1Database,
  pdfFilename: string,
  source: string,
  data: ExtractedData,
  extractionMethod: string
): Promise<void> {
  await db.prepare(
    `INSERT OR REPLACE INTO case_awards
     (pdf_filename, source,
      hhd_amount, lost_wages, lost_wages_weeks, weekly_wage,
      costs_awarded, costs_awarded_text, reinstatement, reinstatement_sought,
      employee_status, outcome, extraction_method, decision_date, employment_tenure,
      contribution_applied, contribution_reduction, contribution_conduct, penalties,
      legal_issues, legal_issues_applicant_won, legal_issues_respondent_won,
      party_applicant, party_respondent,
      representative_applicant, representative_respondent,
      employment_start, dismissal_date, grievance_raised,
      keywords)
     VALUES (?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    pdfFilename, source,
    data.hhd_amount ?? null,
    data.lost_wages ?? null,
    data.lost_wages_weeks ?? null,
    data.weekly_wage ?? null,
    data.costs_awarded ?? null,
    data.costs_awarded_text ?? null,
    data.reinstatement ?? null,
    data.reinstatement_sought ?? null,
    data.employee_status ?? null,
    data.outcome ?? null,
    extractionMethod,
    data.decision_date ?? null,
    data.employment_tenure ?? null,
    data.contribution_applied ?? null,
    data.contribution_reduction ?? null,
    data.contribution_conduct ?? null,
    data.penalties ?? null,
    data.legal_issues ?? null,
    data.legal_issues_applicant_won ?? null,
    data.legal_issues_respondent_won ?? null,
    data.party_applicant ?? null,
    data.party_respondent ?? null,
    data.representative_applicant ?? null,
    data.representative_respondent ?? null,
    data.employment_start ?? null,
    data.dismissal_date ?? null,
    data.grievance_raised ?? null,
    data.keywords ?? null,
  ).run();
}

// ═══════════════════════════════════════════════════════════════════
// PART 2: src/index.ts — Replace the existing backfill-awards endpoint
// ═══════════════════════════════════════════════════════════════════

/*
 * Replace lines 1183-1316 with this:

    // POST /admin/dashboard/backfill-awards
    //
    // Extracts structured data blocks from existing ERA summaries.
    // One LLM call per case collects: awards, legal issues, parties, key dates, keywords.
    // Uses upsert — safe to call multiple times.
    //
    // Query params:
    //   limit  — Max cases per call (default 50, max 200)
    //
    // ──────────────────────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/admin/dashboard/backfill-awards') {
      if (!isAuthenticated(request, env)) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
        const cases = await getCasesWithoutAwards(env.DB, 'ERA');
        const toProcess = cases.slice(0, limit);

        if (toProcess.length === 0) {
          return jsonResponse({ success: true, processed: 0, failed: 0, message: 'All ERA cases already have awards data extracted.' });
        }

        const EXTRACTION_PROMPT = `You are a legal data extractor. From the employment case summary below, extract structured data in exactly this JSON format.

Return ONLY a raw JSON object (no markdown fences, no other text) with these exact keys:

{
  "hhd_amount": null or integer (NZD for hurt/humiliation/distress),
  "lost_wages": null or integer (NZD total lost wages),
  "weekly_wage": null or integer (NZD weekly wage if stated),
  "lost_wages_weeks": null or number (weeks represented if stated),
  "costs_awarded": null or integer (NZD costs order),
  "reinstatement": false or true,
  "reinstatement_sought": false or true,
  "employee_status": null or "employee" or "contractor",
  "outcome": "applicant" or "respondent" or "mixed" or "none",
  "decision_date": null or YYYY-MM-DD,
  "employment_tenure": null or string e.g. "2.5 years",
  "contribution_applied": false or true,
  "contribution_reduction": null or string e.g. "25%",
  "contribution_conduct": null or string,
  "penalties": null or integer (total NZD),

  "legal_issues": null or semicolon-separated list of legal issues raised,
  "legal_issues_applicant_won": null or subset list applicant succeeded on,
  "legal_issues_respondent_won": null or subset list dismissed,

  "party_applicant": null or name of applicant/employee,
  "party_respondent": null or name of respondent/employer,
  "representative_applicant": null or name of applicant's counsel,
  "representative_respondent": null or name of respondent's counsel,

  "employment_start": null or YYYY-MM-DD,
  "dismissal_date": null or YYYY-MM-DD,
  "grievance_raised": null or YYYY-MM-DD,

  "keywords": null or semicolon-separated keywords (topics, industry, etc.)
}

Rules:
- HHD = hurt, humiliation, distress (aka personal grievance compensation)
- outcome: applicant = employee succeeded; respondent = employer succeeded
- Legal issues: extract from the LEGAL ISSUES & RESOLUTIONS or ISSUES sections
- Keywords: extract from case context — e.g. "school principal;constructive dismissal;reinstatement"
- Use null (not 0) for amounts that are not awarded/nil/not stated
- Numbers: plain integers, no $ signs, no commas
- Return ONLY the raw JSON object`;

        let processed = 0;
        let failed = 0;

        for (const c of toProcess) {
          try {
            const pdfFilename = c.pdf_filename;
            if (!pdfFilename || !c.summary) { failed++; continue; }

            // Call Cloudflare AI
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000);
            let jsonText: string;
            try {
              const response = await (env.AI as any).run('anthropic/claude-sonnet-4.6', {
                messages: [{ role: 'user', content: c.summary }],
                system: EXTRACTION_PROMPT,
                max_tokens: 600,
              }, {
                gateway: { id: 'default' },
                signal: controller.signal,
              });
              clearTimeout(timeoutId);
              const body = response?.result?.content?.[0]?.text ?? response?.content?.[0]?.text;
              if (!body) throw new Error(response?.error?.message ?? 'No response');
              jsonText = body.trim();
            } finally {
              clearTimeout(timeoutId);
            }

            const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON found');
            const data = JSON.parse(jsonMatch[0]);

            // Derive weeks if not stated but both salary figures available
            let weeksCalc = (typeof data.lost_wages_weeks === 'number') ? data.lost_wages_weeks : null;
            if (!weeksCalc && data.lost_wages && data.weekly_wage && data.weekly_wage > 0) {
              weeksCalc = Math.round((data.lost_wages / data.weekly_wage) * 10) / 10;
            }

            await upsertExtractedData(env.DB, pdfFilename, 'ERA', {
              hhd_amount: data.hhd_amount ?? null,
              lost_wages: data.lost_wages ?? null,
              weekly_wage: data.weekly_wage ?? null,
              lost_wages_weeks: weeksCalc,
              costs_awarded: data.costs_awarded ?? null,
              costs_awarded_text: null,
              reinstatement: data.reinstatement === true,
              reinstatement_sought: data.reinstatement_sought === true,
              employee_status: data.employee_status ?? null,
              outcome: data.outcome ?? null,
              extraction_method: 'llm_backfill_v2',
              decision_date: data.decision_date ?? null,
              employment_tenure: data.employment_tenure ?? null,
              contribution_applied: data.contribution_applied === true,
              contribution_reduction: data.contribution_reduction ?? null,
              contribution_conduct: data.contribution_conduct ?? null,
              penalties: data.penalties ?? null,
              legal_issues: data.legal_issues ?? null,
              legal_issues_applicant_won: data.legal_issues_applicant_won ?? null,
              legal_issues_respondent_won: data.legal_issues_respondent_won ?? null,
              party_applicant: data.party_applicant ?? null,
              party_respondent: data.party_respondent ?? null,
              representative_applicant: data.representative_applicant ?? null,
              representative_respondent: data.representative_respondent ?? null,
              employment_start: data.employment_start ?? null,
              dismissal_date: data.dismissal_date ?? null,
              grievance_raised: data.grievance_raised ?? null,
              keywords: data.keywords ?? null,
            }, 'llm_backfill_v2');

            processed++;
            console.log(`Data backfill: extracted all blocks for ${pdfFilename}`);
          } catch (err) {
            console.error(`Data backfill: failed for ${c.pdf_filename}: ${err}`);
            failed++;
          }
        }

        return jsonResponse({
          success: true,
          found: cases.length,
          processed,
          failed,
          message: processed > 0
            ? `Extracted data for ${processed} case(s). ${failed > 0 ? `${failed} failed.` : ''}`
            : `No cases processed. ${failed > 0 ? `${failed} failed.` : ''}`,
        });
      } catch (err) {
        console.error(`Data backfill error: ${err}`);
        return jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

 */

// ═══════════════════════════════════════════════════════════════════
// PART 3: src/dashboard.ts — Add button in scraper tab
// ═══════════════════════════════════════════════════════════════════

/*
 * Add this button to the ERA Scraper tab, near the existing scrape controls:
 * (around line 760, before the upload section)

          <div class="card">
            <div class="card-title">🔄 Awards & Data Backfill</div>
            <div style="padding:8px 0;">
              <p style="font-size:13px;color:#666;margin-bottom:8px;">
                Extracts awards, legal issues, parties, and keywords from existing
                summaries. Skips cases already processed. Max 50 per run.
              </p>
              <div style="display:flex;gap:8px;align-items:center;">
                <input type="number" id="backfill-limit" value="50" min="1" max="200"
                       style="width:80px;font-size:13px;padding:4px 8px;border:1px solid #ccc;border-radius:4px;">
                <button class="button" onclick="backfillAwards()"
                        style="padding:8px 16px;font-size:13px;">Run Backfill</button>
                <span id="backfill-status" style="font-size:12px;color:#666;"></span>
              </div>
            </div>
          </div>

 * Add this JS function inside the <script> block:

    async function backfillAwards() {
      const limit = document.getElementById('backfill-limit').value || 50;
      const btn = event?.target || document.querySelector('[onclick="backfillAwards()"]');
      const status = document.getElementById('backfill-status');
      btn.disabled = true; btn.textContent = 'Processing...';
      status.textContent = 'Extracting data blocks...';
      try {
        const resp = await fetch('/admin/dashboard/backfill-awards?limit=' + limit, {
          method: 'POST', credentials: 'same-origin',
        });
        const d = await resp.json();
        status.textContent = d.success
          ? '✅ ' + (d.message || done)
          : '❌ ' + (d.error || 'Failed');
        status.style.color = d.success ? '#060' : '#c00';
      } catch (err) {
        status.textContent = '❌ ' + err.message;
        status.style.color = '#c00';
      }
      btn.disabled = false; btn.textContent = 'Run Backfill';
    }

 */

// ═══════════════════════════════════════════════════════════════════
// PART 4: Database migration — Add new columns to case_awards
// ═══════════════════════════════════════════════════════════════════

/*
 * migrations/0019_add_data_blocks.sql

ALTER TABLE case_awards ADD COLUMN legal_issues TEXT;
ALTER TABLE case_awards ADD COLUMN legal_issues_applicant_won TEXT;
ALTER TABLE case_awards ADD COLUMN legal_issues_respondent_won TEXT;
ALTER TABLE case_awards ADD COLUMN party_applicant TEXT;
ALTER TABLE case_awards ADD COLUMN party_respondent TEXT;
ALTER TABLE case_awards ADD COLUMN representative_applicant TEXT;
ALTER TABLE case_awards ADD COLUMN representative_respondent TEXT;
ALTER TABLE case_awards ADD COLUMN employment_start TEXT;
ALTER TABLE case_awards ADD COLUMN dismissal_date TEXT;
ALTER TABLE case_awards ADD COLUMN grievance_raised TEXT;
ALTER TABLE case_awards ADD COLUMN keywords TEXT;
 */

// ═══════════════════════════════════════════════════════════════════
// PART 5: Import the new function in src/index.ts
// ═══════════════════════════════════════════════════════════════════

/*
 * Near line 43, add:
 *   upsertExtractedData,
 */

