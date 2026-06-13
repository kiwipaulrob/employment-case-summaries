/**
 * pdf.ts — PDF content retrieval for LLM summarisation.
 *
 * Two strategies:
 *
 *   Strategy A (USE_PDF_URL_PASSTHROUGH=true — DISABLED by default):
 *     Fetches the PDF as binary, base64-encodes it, and passes it directly
 *     to the LLM as a native document attachment. Designed for Claude models
 *     that support PDF input via the Anthropic document API.
 *     NOTE: This strategy was found to produce systematic LLM hallucinations
 *     (5 May 2026) — Claude via OpenRouter does not reliably read base64 PDFs
 *     and invents case content from scratch. DO NOT re-enable without testing.
 *
 *   Strategy B (default — USE_PDF_URL_PASSTHROUGH=false):
 *     Fetches the PDF binary and extracts plain text by parsing the raw PDF
 *     byte stream. This is the primary strategy. Suitable for ERA-generated
 *     PDFs (not scanned images). Uses the Workers-native DecompressionStream
 *     API to handle FlateDecode (zlib) compressed streams — the compression
 *     scheme used by all ERA PDFs. The extracted text is passed to the LLM
 *     as a plain string.
 *
 * V1.1 optimisation (noted for future work):
 *   Cache extracted PDF text in R2 so repeated runs don't re-fetch.
 *   Key: `pdf-text/{caseId}`.
 */

const USER_AGENT =
  'ERA-Digest/1.0 (automated digest; contact: digest@whenroutinebiteshard.com)';

/** URL of the pdfminer.six extraction sidecar running on Proxmox CT 104 */
const SIDECAR_URL = 'https://extractor.robertsons.cloud/extract';

// ─── Types ────────────────────────────────────────────────────────────────────

/** The result of PDF processing, ready to hand to the summariser */
export type PdfContent =
  | { strategy: 'base64'; data: string; mediaType: 'application/pdf' }
  | { strategy: 'text'; text: string };

// ─── Strategy A — base64 passthrough ─────────────────────────────────────────

/**
 * Fetches the PDF and returns it as a base64 string.
 * The summariser passes this to models that support native PDF input.
 *
 * @throws if the HTTP request fails or the response is not a PDF
 */
export async function fetchPdfAsBase64(pdfUrl: string): Promise<PdfContent> {
  console.log(`[pdf] Strategy A: fetching PDF as base64 from ${pdfUrl}`);
  const response = await fetch(pdfUrl, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`PDF fetch failed: HTTP ${response.status} for ${pdfUrl}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('pdf') && !pdfUrl.endsWith('.pdf')) {
    throw new Error(
      `Unexpected content type "${contentType}" for PDF URL: ${pdfUrl}`
    );
  }

  const bytes = await response.arrayBuffer();
  console.log(`[pdf] Strategy A: fetched ${Math.round(bytes.byteLength / 1024)} KB`);

  // ERA determination PDFs are typically 20–100 KB — well within Workers limits.
  // Log a warning if unusually large (may hit token budget).
  if (bytes.byteLength > 500_000) {
    console.warn(
      `Large PDF (${Math.round(bytes.byteLength / 1024)} KB) at ${pdfUrl} — may need truncation`
    );
  }

  const base64 = arrayBufferToBase64(bytes);
  console.log(`[pdf] Strategy A: converted to base64 (${base64.length} chars)`);
  return { strategy: 'base64', data: base64, mediaType: 'application/pdf' };
}

// ─── Strategy B — text extraction ────────────────────────────────────────────

/**
 * Fetches the PDF and extracts plain text from it.
 *
 * ERA determinations are generated PDFs (not scanned), so their text content
 * is embedded in FlateDecode-compressed streams. This extractor decompresses
 * each stream using the Workers-native DecompressionStream API, then extracts
 * text from the BT...ET blocks in the decompressed content.
 *
 * @throws if the HTTP request fails or insufficient text is extracted
 */
export async function fetchPdfAsText(pdfUrl: string): Promise<PdfContent> {
  console.log(`[pdf] Strategy B: fetching PDF for text extraction from ${pdfUrl}`);
  const response = await fetch(pdfUrl, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`PDF fetch failed: HTTP ${response.status} for ${pdfUrl}`);
  }

  const bytes = await response.arrayBuffer();
  console.log(`[pdf] Strategy B: fetched ${Math.round(bytes.byteLength / 1024)} KB`);
  
  const text = await extractTextFromPdfBytes(bytes);

  if (!text || text.trim().length < 100) {
    throw new Error(
      `PDF text extraction yielded insufficient content (${text.trim().length} chars) from ${pdfUrl}. ` +
        'The PDF may be a scanned image or use an unsupported encoding.'
    );
  }

  console.log(`[pdf] Strategy B: extracted ${text.length} chars of text`);
  return { strategy: 'text', text };
}

// ─── Strategy C — pdfminer.six sidecar ─────────────────────────────────────

/**
 * Fetches a PDF URL and extracts text via the pdfminer.six sidecar running
 * on Proxmox CT 104 at extractor.robertsons.cloud.
 *
 * The sidecar handles CID font encoding (CMap-based character mappings) used
 * by ERA determination PDFs, which the Workers-native JS extractor cannot
 * resolve. Falls back to fetchPdfAsText() if the sidecar is unreachable.
 *
 * @throws if the HTTP request fails, the sidecar returns an error, or no
 *   text is extracted
 */
async function fetchPdfViaSidecar(pdfUrl: string): Promise<PdfContent> {
  console.log(`[pdf] Sidecar: fetching PDF from ${pdfUrl}`);

  // Step 1: fetch the PDF bytes from the ERA website (same as other strategies)
  const response = await fetch(pdfUrl, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`PDF fetch failed: HTTP ${response.status} for ${pdfUrl}`);
  }

  const bytes = await response.arrayBuffer();
  console.log(`[pdf] Sidecar: fetched ${Math.round(bytes.byteLength / 1024)} KB`);

  // Step 2: POST bytes to the pdfminer.six sidecar via Cloudflare Tunnel
  const sidecarResponse = await fetch(SIDECAR_URL, {
    method: 'POST',
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });

  const result = await sidecarResponse.json() as {
    success: boolean;
    text?: string;
    text_length?: number;
    page_count?: number;
    method?: string;
    error?: string;
  };

  if (!result.success || !result.text_length) {
    throw new Error(result.error || 'Sidecar returned empty result');
  }

  console.log(
    `[pdf] Sidecar: extracted ${result.text_length} chars across ${result.page_count} pages via ${result.method}`
  );
  return { strategy: 'text', text: result.text };
}

// ─── Unified entry point ──────────────────────────────────────────────────────

/**
 * Retrieves PDF content — tries the pdfminer.six sidecar first, then falls
 * back to Workers-native text extraction if the sidecar is unreachable.
 */
export async function getPdfContent(
  pdfUrl: string
): Promise<PdfContent> {
  try {
    return await fetchPdfViaSidecar(pdfUrl);
  } catch (err) {
    console.warn(`[pdf] Sidecar failed, falling back to Workers-native extraction: ${err}`);
    return await fetchPdfAsText(pdfUrl);
  }
}

/**
 * Converts PDF bytes directly to base64.
 * Used for file uploads where we have the binary data directly.
 */
export function pdfBytesToBase64(buffer: ArrayBuffer): PdfContent {
  const base64 = arrayBufferToBase64(buffer);
  return { strategy: 'base64', data: base64, mediaType: 'application/pdf' };
}

/**
 * Extracts text from PDF bytes directly.
 * Used for file uploads where we have the binary data directly.
 */
export async function pdfBytesToText(buffer: ArrayBuffer): Promise<PdfContent> {
  console.log(`[pdf] Direct extraction: processing ${Math.round(buffer.byteLength / 1024)} KB of PDF bytes`);
  const text = await extractTextFromPdfBytes(buffer);

  if (!text || text.trim().length < 100) {
    throw new Error(
      `PDF text extraction yielded insufficient content (${text.trim().length} chars). ` +
        'The PDF may be a scanned image or use an unsupported encoding.'
    );
  }

  console.log(`[pdf] Direct extraction: extracted ${text.length} chars of text`);
  return { strategy: 'text', text };
}

/**
 * Processes PDF bytes using the configured strategy.
 * Automatically falls back to text extraction if base64 strategy fails.
 */
export async function getPdfContentFromBytes(
  buffer: ArrayBuffer,
  usePdfUrlPassthrough: boolean
): Promise<PdfContent> {
  if (usePdfUrlPassthrough) {
    try {
      return pdfBytesToBase64(buffer);
    } catch (err) {
      console.warn(
        `Base64 conversion failed: ${err}. Falling back to text extraction.`
      );
      return await pdfBytesToText(buffer);
    }
  } else {
    return await pdfBytesToText(buffer);
  }
}

// ─── Text extraction utilities ────────────────────────────────────────────────

/**
 * Extracts readable text from raw PDF bytes.
 *
 * Iterates over every stream/endstream pair in the PDF, decompresses
 * FlateDecode streams using the Workers-native DecompressionStream API,
 * then extracts text from BT...ET blocks in the decompressed content.
 *
 * Handles:
 * - FlateDecode (zlib, RFC 1950) compressed streams — used by all ERA PDFs
 * - Uncompressed text streams
 * - Parenthesised strings: (Hello World)
 * - Hex strings: <48656c6c6f>
 * - Common PDF string escape sequences
 *
 * Limitations:
 * - Does not handle Type 0 / CID fonts with multi-byte encodings
 * - Scanned-image PDFs (no embedded text) will return empty
 */
async function extractTextFromPdfBytes(buffer: ArrayBuffer): Promise<string> {
  const latin1 = new TextDecoder('latin1'); // lossless: maps each byte 0–255 to same code point
  const raw = latin1.decode(buffer);
  const bytes = new Uint8Array(buffer);

  console.log(`[pdf] Starting text extraction from ${buffer.byteLength} bytes`);

  // Check for encrypted/password-protected PDFs early
  // PDF encryption is flagged by the /Encrypt entry in the trailer or catalog.
  // This detects password-protected files before attempting extraction.
  if (/\/Encrypt\b/.test(raw)) {
    throw new Error(
      'PDF is encrypted or password-protected. Password-protected PDFs cannot be ' +
      'processed automatically — the text content is not accessible without decryption. ' +
      'Please upload an unencrypted version.'
    );
  }

  const textParts: string[] = [];
  let pos = 0;

  while (pos < raw.length) {
    // Find next '>>stream' keyword (>> marks end of stream dictionary)
    // This avoids false positives from 'stream' text embedded in compressed data
    const streamIdx = raw.indexOf('stream', pos);
    if (streamIdx === -1) break;

    // Verify it's preceded by >> (dictionary terminator)
    const hasValidDictEnd =
      streamIdx >= 2 && raw[streamIdx - 2] === '>' && raw[streamIdx - 1] === '>';

    if (!hasValidDictEnd) {
      pos = streamIdx + 6;
      continue;
    }

    // Must be followed by \n or \r\n (PDF spec requires this)
    const c6 = raw[streamIdx + 6];
    const c7 = raw[streamIdx + 7];

    let contentStart: number;
    if (c6 === '\r' && c7 === '\n') {
      contentStart = streamIdx + 8;
    } else if (c6 === '\n') {
      contentStart = streamIdx + 7;
    } else {
      pos = streamIdx + 6;
      continue;
    }

    // Find matching 'endstream'
    const endIdx = raw.indexOf('endstream', contentStart);
    if (endIdx === -1) break;

    // Strip trailing \r\n written before 'endstream'
    let contentEnd = endIdx;
    if (contentEnd > 0 && raw[contentEnd - 1] === '\n') contentEnd--;
    if (contentEnd > 0 && raw[contentEnd - 1] === '\r') contentEnd--;

    // Look back up to 1000 chars before 'stream' to find its stream dictionary
    // and check whether FlateDecode compression is applied
    const lookback = raw.substring(Math.max(0, streamIdx - 1000), streamIdx);
    const hasFlateDecode = /\/Filter\s*(\/FlateDecode|\[\s*\/FlateDecode\s*\])/.test(lookback);
    
    const streamNum = textParts.length + 1;
    console.log(`[pdf] Stream ${streamNum} at offset ${streamIdx}: FlateDecode=${hasFlateDecode}`);

    const streamBytes = bytes.slice(contentStart, contentEnd);

    let streamText: string;
    if (hasFlateDecode) {
      try {
        const decompressed = await decompressDeflate(streamBytes);
        streamText = latin1.decode(decompressed);
        console.log(`[pdf] Stream ${textParts.length}: FlateDecode decompressed ${streamBytes.length} → ${decompressed.length} bytes`);
      } catch (err) {
        console.warn(`[pdf] FlateDecode decompression failed at offset ${streamIdx}: ${err}`);
        pos = endIdx + 9;
        continue;
      }
    } else {
      streamText = raw.substring(contentStart, contentEnd);
    }

    const extracted = extractTextFromStream(streamText);
    if (extracted) {
      textParts.push(extracted);
      console.log(`[pdf] Stream ${textParts.length}: extracted ${extracted.length} chars`);
    }

    pos = endIdx + 9;
  }

  // Last-resort fallback: grep for long readable strings anywhere in the doc
  if (textParts.length === 0) {
    console.log('[pdf] No text extracted from BT...ET blocks; trying fallback parenthesis regex');
    // Loosened regex: allow more punctuation, Unicode dashes, quotes
    const parenRegex = /\(([A-Za-z0-9 ,.'":;!?\n\r\t\\\-–—"()]{8,})\)/g;
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = parenRegex.exec(raw)) !== null) {
      const candidate = decodePdfString(m[1]);
      if (candidate.trim()) textParts.push(candidate.trim());
    }
    console.log(`[pdf] Fallback regex found ${textParts.length} strings`);
  }

  const finalText = textParts
    .join('\n')
    .replace(/\s{3,}/g, '\n\n')
    .trim();
  
  console.log(`[pdf] Final extracted text: ${finalText.length} chars from ${textParts.length} parts`);
  return finalText;
}

/**
 * Decompresses FlateDecode (zlib, RFC 1950) data using the Workers-native
 * DecompressionStream API. Tries 'deflate' (zlib-wrapped) first, then
 * 'deflate-raw' as a fallback for implementations that omit the zlib header.
 */
async function decompressDeflate(compressed: Uint8Array): Promise<Uint8Array> {
  const attempts: string[] = [];
  
  for (const format of ['deflate', 'deflate-raw'] as const) {
    try {
      const ds = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();

      await writer.write(compressed);
      await writer.close();

      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      console.log(`[pdf] Decompression succeeded with '${format}': ${compressed.length} → ${totalLength} bytes`);
      return result;
    } catch (err) {
      attempts.push(`${format}: ${err}`);
      console.log(`[pdf] Decompression attempt '${format}' failed: ${err}`);
    }
  }
  throw new Error(`FlateDecode decompression failed with both formats: ${attempts.join('; ')}`);
}

/**
 * Extracts readable text from a single (decompressed) PDF content stream.
 * Looks for BT...ET blocks and pulls out parenthesised and hex strings.
 */
function extractTextFromStream(content: string): string {
  const parts: string[] = [];

  const btEtRegex = /BT[\s\S]*?ET/g;
  let btMatch: RegExpExecArray | null;
  let blockCount = 0;

  // eslint-disable-next-line no-cond-assign
  while ((btMatch = btEtRegex.exec(content)) !== null) {
    blockCount++;
    const block = btMatch[0];
    const blockParts: string[] = [];

    // Parenthesised strings: (text)
    const parenRegex = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
    let parenMatch: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((parenMatch = parenRegex.exec(block)) !== null) {
      const decoded = decodePdfString(parenMatch[1]);
      if (decoded.trim()) blockParts.push(decoded);
    }

    // Hex strings: <hexdata>
    const hexRegex = /<([0-9a-fA-F]+)>/g;
    let hexMatch: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((hexMatch = hexRegex.exec(block)) !== null) {
      const decoded = hexToString(hexMatch[1]);
      if (decoded.trim()) blockParts.push(decoded);
    }

    if (blockParts.length > 0) {
      // Join directly (no separator): spaces are already embedded in the
      // text elements themselves (e.g. ' P', ' GROUP' in TJ kerning arrays).
      // Using ' '.join() was adding spurious spaces between every glyph cluster.
      const joined = blockParts.join('');
      if (joined.trim()) parts.push(joined);
    }
  }

  console.log(`[pdf] extractTextFromStream: found ${blockCount} BT...ET blocks, extracted ${parts.length} text segments`);

  // Filter out lines that are predominantly binary / non-printable content
  // (e.g. font metric streams that happen to contain a BT...ET sequence).
  const filtered = parts.filter(p => {
    const printable = Array.from(p).filter(c => {
      const code = c.charCodeAt(0);
      return (code >= 0x20 && code < 0x7f) || code === 0x0a || code === 0x0d || code === 0x09;
    }).length;
    return printable / Math.max(p.length, 1) >= 0.5;
  });

  return filtered.join('\n');
}

/** Decodes PDF string escape sequences */
export function decodePdfString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

/** Decodes a hex-encoded PDF string */
export function hexToString(hex: string): string {
  let result = '';
  for (let i = 0; i < hex.length - 1; i += 2) {
    result += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16));
  }
  return result;
}

/** Converts an ArrayBuffer to a base64 string (Workers-compatible) */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192; // process in chunks to avoid stack overflow
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Truncates extracted text to fit within the LLM's input token budget.
 * Rough heuristic: 1 token ≈ 4 characters.
 *
 * @param text     The full extracted text
 * @param maxTokens Maximum input tokens to allow (default 12000, leaving room for prompt)
 */
export function truncateToTokenBudget(text: string, maxTokens = 12_000): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;

  console.warn(
    `Text truncated from ${text.length} chars (≈${Math.round(text.length / 4)} tokens) ` +
      `to ${maxChars} chars (≈${maxTokens} tokens)`
  );

  return (
    text.substring(0, maxChars) +
    '\n\n[NOTE: The full document was truncated to fit the model context window. ' +
    'The above represents the first portion of the determination only.]'
  );
}
