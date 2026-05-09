"""
PDF Parser Python Sidecar Worker
Cloudflare Workers Python runtime
Extracts text from Employment Court PDFs with CID fonts using pypdf
"""

from pypdf import PdfReader
import json
from io import BytesIO


async def on_request(request):
    """Extract text from PDF bytes."""
    try:
        # Read PDF from request body
        pdf_bytes = await request.bytes()
        if not pdf_bytes:
            return Response(
                json.dumps({"error": "No PDF bytes provided", "success": False}),
                status=400,
                headers={"Content-Type": "application/json"}
            )
        
        pdf_file = BytesIO(pdf_bytes)
        
        # Extract text using pypdf
        reader = PdfReader(pdf_file)
        text_parts = []
        for page in reader.pages:
            extracted = page.extract_text()
            if extracted:
                text_parts.append(extracted)
        
        full_text = "\n".join(text_parts)
        
        return Response(
            json.dumps({
                "text": full_text,
                "page_count": len(reader.pages),
                "success": True,
                "extraction_method": "pypdf",
                "text_length": len(full_text)
            }),
            status=200,
            headers={"Content-Type": "application/json"}
        )
    except Exception as e:
        import traceback
        return Response(
            json.dumps({
                "error": str(e),
                "traceback": traceback.format_exc(),
                "success": False
            }),
            status=500,
            headers={"Content-Type": "application/json"}
        )
