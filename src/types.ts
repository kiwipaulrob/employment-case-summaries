/**
 * types.ts — Shared TypeScript types for the ERA Digest Worker
 */

// ─── Case data ────────────────────────────────────────────────────────────────

/** A case as scraped from the ERA recent determinations page */
export interface CaseListing {
  caseId: string;        // e.g. "21178"
  title: string;         // e.g. "Robertson v Acme Ltd"
  caseUrl: string;       // e.g. "https://determinations.era.govt.nz/determination/view/21178"
  pdfUrl: string | null; // PDF download URL
  member: string | null; // Adjudicating member name
  datePublished: string | null; // e.g. "14 Apr 2026"
  category: string | null;      // e.g. "Unjustified dismissal"
}

/** A case that has been processed (summarised and stored) */
export interface ProcessedCase extends CaseListing {
  summary: string;       // The LLM-generated structured summary
  processedAt: string;   // ISO 8601 UTC timestamp
  source: string;        // 'ERA' or 'EMPLOYMENT_COURT'
  summaryVersion?: string | null; // Prompt version used to generate this summary (updated_at timestamp)
  paragraphCount?: number | null;
}

// ─── Database rows ────────────────────────────────────────────────────────────

export interface DbSeenCase {
  source: string;            // 'ERA' or 'EMPLOYMENT_COURT' (composite PK part 1)
  pdf_filename: string;      // e.g. "2026-NZERA-225.pdf" (composite PK part 2)
  case_id: string | null;    // Non-unique (ERA reassigns these; null for EC)
  title: string;
  case_url: string;
  pdf_url: string | null;
  date_published: string;
  member: string | null;
  category: string | null;
  summary: string | null;
  processed_at: string;
  summary_version: string | null;
  paragraph_count: number | null;
}

export interface DbSubscriber {
  id: number;
  email: string;
  name: string | null;
  active: number;      // 1=active, 0=unsubscribed
  confirmed: number;   // 1=confirmed email, 0=pending confirmation
  created_at: string;
  confirmed_at?: string;
  unsubscribe_token: string | null;
  preferences: string | null;
}

export interface DbConfig {
  key: string;
  value: string;
  updated_at: string;
}

// ─── Worker environment ───────────────────────────────────────────────────────

export interface Env {
  // Cloudflare bindings
  DB: D1Database;
  EMAIL: SendEmail;
  PDF_PARSER: Fetcher;  // Service binding to pdf-parser-python worker
  AI: any;              // Cloudflare Unified Inference Layer

  // PDF strategy
  USE_PDF_URL_PASSTHROUGH: string; // "true" | "false"

  // Source
  SOURCE_URL: string;              // https://determinations.era.govt.nz/determinations/recent

  // Email
  ADMIN_EMAIL: string;             // Receives error alerts
  SENDING_ADDRESS: string;         // digest@whenroutinebiteshard.com

  // Timezone for display
  TIMEZONE: string;                // "Pacific/Auckland"

  // Trigger mode
  TRIGGER_MODE: string;            // "scheduled" | "change_detection"

  // Public site URL (used for confirmation + unsubscribe links)
  SITE_URL: string;            // https://whenroutinebiteshard.com

  // HTTP handler auth
  ADMIN_SECRET: string;

  // Cron schedule for display
  CRON_SCHEDULE: string;           // e.g. "Daily at 8am NZT (dual cron for DST)"

  // Turnstile bot protection (subscribe form, added 22 Jul 2026)
  TURNSTILE_SITE_KEY?: string;     // Public site key (non-secret, var)
  TURNSTILE_SECRET_KEY?: string;   // Secret — set via wrangler secret put
}

// ─── Multi-block extraction (Jul 2026) ────────────────────────────────────────

export interface ExtractedData {
  hhd_amount: number | null;
  lost_wages: number | null;
  lost_wages_weeks: number | null;
  weekly_wage: number | null;
  costs_awarded: number | null;
  costs_awarded_text: string | null;
  reinstatement: boolean;
  reinstatement_sought: boolean;
  employee_status: string | null;
  outcome: string | null;
  extraction_method: string;
  decision_date: string | null;
  employment_tenure: string | null;
  contribution_applied: boolean;
  contribution_reduction: string | null;
  contribution_conduct: string | null;
  penalties: number | null;
  legal_issues: string | null;
  legal_issues_applicant_won: string | null;
  legal_issues_respondent_won: string | null;
  party_applicant: string | null;
  party_respondent: string | null;
  representative_applicant: string | null;
  representative_respondent: string | null;
  employment_start: string | null;
  dismissal_date: string | null;
  grievance_raised: string | null;
  keywords: string | null;
}

// ─── Cloudflare AI / Unified Inference ────────────────────────────────────────

export interface CloudflareAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CloudflareAIRequest {
  messages: CloudflareAIMessage[];
  max_tokens?: number;
}

export interface CloudflareAIResponse {
  result?: {
    content?: Array<{ text?: string }>;
    finish_reason?: string;
  };
  content?: Array<{ text?: string }>;
  error?: { message: string; code?: number };
}

// ─── Result types ─────────────────────────────────────────────────────────────

export interface SummaryResult {
  caseId: string;
  summary: string;
  success: boolean;
  error?: string;
  judgeName?: string | null;  // Extracted judge name for EC cases
  paragraphCount?: number | null;  // Count of [N] paragraph markers in the PDF
}
