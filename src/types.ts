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
}

export interface DbSubscriber {
  id: number;
  email: string;
  name: string | null;
  active: number;      // 1=active, 0=unsubscribed
  confirmed: number;   // 1=confirmed email, 0=pending confirmation
  created_at: string;
  unsubscribe_token: string | null;
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

  // OpenRouter
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;        // e.g. "anthropic/claude-3.5-sonnet"

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
}

// ─── OpenRouter API ───────────────────────────────────────────────────────────

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | OpenRouterContentPart[];
}

export interface OpenRouterContentPart {
  type: 'text' | 'document';
  text?: string;
  source?: {
    type: 'base64';
    media_type: 'application/pdf';
    data: string;
  };
}

export interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  max_tokens?: number;
}

export interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  error?: {
    message: string;
    code?: number;
  };
}

// ─── Result types ─────────────────────────────────────────────────────────────

export interface SummaryResult {
  caseId: string;
  summary: string;
  success: boolean;
  error?: string;
  judgeName?: string | null;  // Extracted judge name for EC cases
}
