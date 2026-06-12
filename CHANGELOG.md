# Changelog

## [Unreleased]

### Added
- **Notice banner admin UI** (issue #44): Textarea on dashboard to set email notice banners without raw SQL.
- **Loading spinners + confirmation dialogs** (issues #25, #17): Buttons disable and show spinners during async operations. Confirm dialogs before destructive rescan actions.
- **Digest schedule on dashboard** (issue #16): Shows "Daily at 8am NZT (dual cron for DST)" and timezone in System Status.
- **`summary_version` column** (issue #29): Migration 0013 tracks which prompt version generated each case summary.
- **Encrypted PDF detection** (issue #43): Detects `/Encrypt` marker and throws a clear error before attempting extraction.
- **Prompt injection wrapper** (issue #27): PDF content wrapped in `<document>` tags before LLM processing.
- **Rate limiting** (issue #31): 20 req/min/IP on `/subscribe`, 10 req/min/IP on `/admin` login. Returns HTTP 429.
- **Timing-safe password comparison** (issue #28): XOR-based constant-time comparison for admin auth.
- **Relative timestamps** (issue #23): Dashboard shows "Xm ago", "Xh ago", "Yesterday" etc. instead of absolute timestamps.
- **99 unit tests** across utils, emailer, pdf, and rate-limiter modules.

### Fixed
- **`sleep()` deduplicated** into shared utils.ts (was duplicated in both summarisers).
- **Dynamic import replaced**: `db.ts` now calls `crypto.randomUUID()` directly instead of dynamic import.
- **Double-encoding guardrail**: `validateSummaryNotDoubleEncoded()` prevents corrupted summaries from entering the DB.
- **Email notice banner timing**: Notice is only cleared AFTER successful email dispatch, not before.
- **`/admin/errors` now functional**: Queries `config:last_error` instead of returning hardcoded `[]`.
- **`/admin/clear-seen` requires confirmation**: Sending `{'confirm': true}` prevents accidental data loss.
- **Pipeline errors logged**: Fatal errors in `runDigest()` are stored to `config:last_error` for retrieval.
- **Case processing is per-case**: One bad PDF no longer crashes the entire daily digest batch.

### Changed
- **README.md** (issue #37): Updated model name, deployment method, migration table, API endpoints, docs links.
- **DEPLOYMENT.md** (issue #38): Browser Paste method replaced with GitHub Actions as primary.
- **`.env.example`** (issue #40): Hardcoded D1 database ID replaced with placeholder.

## [Unreleased]

### Fixed
- **Case names showing `& & Anor` duplication**: `toTitleCase()` and `toTitleCaseSimple()` in `src/utils.ts` and `src/index.ts` now use a negative lookbehind `(?<!& )` to avoid prepending `& ` before `Anor` when `&` is already present. Fixes cases like `Byungok Jung & Anor ... & Anor [2026] NZEmpC 82` from being rendered with doubled ampersands.
- **EC PDF upload returning SUMMARY_UNAVAILABLE for all cases**: The upload handler was constructing `pdfContent` as `{ content: text }` instead of the correct `{ strategy: 'text', text: text }` format. The missing `strategy` field caused `summariseEmploymentCourtCase()` to fall through to a "no text available" fallback message, making the LLM return `SUMMARY_UNAVAILABLE` for every EC upload. Affected both dashboard multipart upload and raw binary curl upload.
- **Fallback text extraction silently discarding text**: When the Python sidecar fails and the code falls back to FlateDecode, `pdfContent.content` was read — but `PdfContent` uses `.text` (text mode) or `.data` (base64 mode). Fallback text was always silently discarded as empty string.
- **CID font extraction producing garbled text**: Beefed up `cleanExtractedText()` to strip C1 control characters (0x80-0x9F), BOM/non-characters, and bare backslash-escape sequences.
- **Case name showing raw filename without citation**: `parseTitleFromFilename()` now includes citation in the title (e.g. `Healey v Health New Zealand [2026] NZEmpC 98`).

### Changed
- `src/index.ts`: Import `PdfContent` type; fix EC upload `pdfContent` construction; add text cleaning and filename parsing functions.
- **Case titles now derived from LLM summary PARTIES section** — far more accurate than filename parsing. Falls back to filename if extraction fails. Applied to both EC uploads and ERA daily pipeline.

### Added
- **Case classification tags**: ERA and EC summariser prompts now tag cases as `[COSTS ONLY]` (costs-only decisions) or `[CONSENT]` (consent orders) on the first line of the summary.
- **Landing page filters**: Two checkboxes ("Show costs decisions", "Show consent orders") let casual readers toggle visibility. Default: both hidden.
- **Subscriber preferences**: New `preferences` column on subscribers table (JSON: `show_costs`, `show_consent`). Both default to `false` (hidden). Checkboxes on the sign-up form let new subscribers opt in.
- **Preferences page**: Email links now go to `/preferences?token=X` where subscribers can toggle their preferences or unsubscribe entirely.
- **Email filtering**: Per-subscriber preferences applied before sending — only matching cases are included in the digest.
- **Migration 0008**: `ALTER TABLE subscribers ADD COLUMN preferences TEXT`. Run `npm run db:migrate` to apply.
