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
