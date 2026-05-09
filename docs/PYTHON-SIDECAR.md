# Python Sidecar Worker (pdf-parser-python)

## Overview

The `pdf-parser-python` worker is a Cloudflare Workers service deployed independently from the main TypeScript worker. Its purpose is to extract text from Employment Court PDF files that use CID font encoding (glyph indices).

**Why needed?** 
- **ERA PDFs** use simple Latin-1 font encoding → JavaScript extraction works fine
- **EC PDFs** use CID fonts with ToUnicode mappings → JavaScript can't resolve glyph indices

The Python sidecar worker handles CID fonts natively via `pypdf==4.2.0`.

## Architecture

```
Main Worker (TypeScript)
    ↓
extractTextWithPython(pdfBytes)
    ↓
PDF_PARSER service binding (routes to pdf-parser-python)
    ↓
Python Sidecar Worker
    ├─ Receives: raw PDF bytes via HTTP POST
    ├─ Process: pypdf.PdfReader → extract_text()
    └─ Returns: JSON { text: "extracted content" }
```

## Setup Instructions

### Step 1: Create the Python Worker

In Cloudflare Workers & Pages dashboard:

1. **Create new Worker**
   - Name: `pdf-parser-python`
   - Runtime: Python

2. **Replace file contents**
   
   Create/edit `main.py`:
   ```python
   from pypdf import PdfReader
   import json
   from io import BytesIO

   async def on_request(request):
       """Extract text from PDF bytes."""
       try:
           # Read PDF from request body
           pdf_bytes = await request.bytes()
           pdf_file = BytesIO(pdf_bytes)
           
           # Extract text using pypdf
           reader = PdfReader(pdf_file)
           text_parts = []
           for page in reader.pages:
               text_parts.append(page.extract_text())
           
           full_text = "\n".join(text_parts)
           
           return Response(
               json.dumps({
                   "text": full_text,
                   "page_count": len(reader.pages),
                   "success": True
               }),
               status=200,
               headers={"Content-Type": "application/json"}
           )
       except Exception as e:
           return Response(
               json.dumps({
                   "error": str(e),
                   "success": False
               }),
               status=500,
               headers={"Content-Type": "application/json"}
           )
   ```

   Create/edit `requirements.txt`:
   ```
   pypdf==4.2.0
   ```

3. **Deploy**
   - Click "Save and Deploy"
   - Note the worker subdomain (e.g., `pdf-parser-python.{account}.workers.dev`)

### Step 2: Add Service Binding to Main Worker

In your main worker's `wrangler.jsonc`:

```jsonc
{
  "env": {
    "production": {
      "service_bindings": [
        {
          "binding": "PDF_PARSER",
          "service": "pdf-parser-python"
        }
      ]
    }
  }
}
```

### Step 3: Update TypeScript Env Interface

In `src/types.ts`:

```typescript
export interface Env {
  // ... existing bindings ...
  PDF_PARSER: Fetcher;  // Service binding to Python sidecar
}
```

### Step 4: Use in Main Worker

In `src/index.ts`:

```typescript
async function extractTextWithPython(pdfBytes: ArrayBuffer, env: Env): Promise<string> {
  const response = await env.PDF_PARSER.fetch('http://pdf-parser.local/', {
    method: 'POST',
    body: pdfBytes,
    headers: { 'Content-Type': 'application/pdf' },
  });

  if (!response.ok) {
    const errorData: any = await response.json();
    throw new Error(`PDF Extraction Failed: ${errorData.error}`);
  }

  const result: any = await response.json();
  return result.text || '';
}
```

## Testing

### Test via cURL

```bash
# Test the Python sidecar directly
curl -X POST \
  -H "Content-Type: application/pdf" \
  --data-binary @path/to/test.pdf \
  https://pdf-parser-python.{account}.workers.dev/
```

### Test via EC Upload Endpoint

Upload an EC PDF via the admin dashboard:

1. Go to `https://whenroutinebiteshard.com/admin`
2. Click "Employment Court Cases" tab
3. Drag & drop a PDF
4. Check response for `pdfStrategy: "python-sidecar"` and `pdfTextLength > 0`

## Deployment Checklist

- [ ] Python worker created as `pdf-parser-python`
- [ ] `main.py` and `requirements.txt` deployed
- [ ] Service binding `PDF_PARSER` added to main worker `wrangler.jsonc`
- [ ] `Env` interface includes `PDF_PARSER: Fetcher`
- [ ] Main worker deployed with updated code
- [ ] Test EC PDF upload succeeds with `pdfStrategy: "python-sidecar"`

## Fallback Behavior

If the Python sidecar fails (network error, timeout, extraction error):

1. Main worker logs warning: `"Python extraction failed, falling back to FlateDecode"`
2. Falls back to `getPdfContentFromBytes()` (FlateDecode extraction)
3. For EC PDFs with CID fonts, FlateDecode extraction yields empty text
4. Summariser receives `text: ""` and returns `SUMMARY_UNAVAILABLE`

**To recover:**
- Check Python worker logs in Cloudflare dashboard
- Verify service binding is wired correctly
- Re-upload the EC case PDF

## Upgrading pypdf

To upgrade from `pypdf==4.2.0` to a newer version:

1. Edit `requirements.txt` in the Python worker
2. Click "Save and Deploy"
3. Re-upload EC PDFs to test

Recommended: Test with a single PDF first before bulk uploads.

## Known Issues

- **Long PDFs (>100 pages)**: May hit worker timeout (default 30s). Consider implementing page chunking if needed.
- **Scanned images**: pypdf can extract metadata but not image-based text. Users must use OCR separately.
- **Encrypted PDFs**: pypdf will fail on password-protected PDFs. Users must decrypt first.

## References

- [pypdf Documentation](https://pypdf.readthedocs.io/)
- [Cloudflare Workers Python Runtime](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Service Bindings](https://developers.cloudflare.com/workers/platform/services/bindings/)
