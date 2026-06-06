# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed
- **EC PDF upload returning SUMMARY_UNAVAILABLE for all cases**: The upload handler was constructing `pdfContent` as `{ content: text }` instead of the correct `{ strategy: 'text', text: text }` format. The missing `strategy` field caused `summariseEmploymentCourtCase()` to fall through to a "no text available" fallback message, making the LLM return `SUMMARY_UNAVAILABLE` for every EC upload. Affected both dashboard multipart upload and raw binary curl upload.
- **Fallback text extraction silently discarding text**: When the Python sidecar fails and the code falls back to FlateDecode, `pdfContent.content` was read — but `PdfContent` uses `.text` (text mode) or `.data` (base64 mode). Fallback text was always silently discarded as empty string.
- **CID font extraction producing garbled text**: Beefed up `cleanExtractedText()` to strip C1 control characters (0x80-0x9F), BOM/non-characters, and bare backslash-escape sequences.
- **Case name showing raw filename without citation**: `parseTitleFromFilename()` now includes citation in the title (e.g. `Healey v Health New Zealand [2026] NZEmpC 98`).

### Changed
- `src/index.ts`: Import `PdfContent` type; fix EC upload `pdfContent` construction; add text cleaning and filename parsing functions.
