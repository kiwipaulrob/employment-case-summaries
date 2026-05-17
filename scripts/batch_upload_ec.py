#!/usr/bin/env python3
"""
Batch upload EC case PDFs to the era-digest-worker.
Extracts text locally with pdfminer and posts JSON to /admin/upload-ec-case-text.
"""
import json
import time
import urllib.request
import urllib.error
import sys
import os

try:
    from pdfminer.high_level import extract_text
except ImportError:
    print("Installing pdfminer.six...")
    os.system("pip install -q pdfminer.six")
    from pdfminer.high_level import extract_text

WORKER_URL = "https://whenroutinebiteshard.com/admin/upload-ec-case-text"

# FIX: Pull admin secret from environment variable to prevent hardcoding in script
ADMIN_SECRET = os.environ.get("ERA_ADMIN_SECRET")
if not ADMIN_SECRET:
    raise ValueError("CRITICAL: ERA_ADMIN_SECRET environment variable is not set. Run: export ERA_ADMIN_SECRET='your_password'")

UPLOADS_DIR = "/agent/uploads"

# All 20 new EC cases to process (skip FHE-73 duplicate)
FILES = [
    "2026-NZEmpC-55-A-Labour-Inspector-v-Solar-Energy-Pacific-Limited-previously-named-Eldercare-Services-2013-Limited.pdf",
    "2026-NZEmpC-56-Edgecumbe-Supermarket-v-Peterson.pdf",
    "2026-NZEmpC-57-Kour-v-Naidu.pdf",
    "2026-NZEmpC-58-Harte-v-MERAS-Judgment-of-Chief-Judge-Christina-Inglis-26-March-2026.pdf",
    "2026-NZEmpC-59-Wu-v-Ling-2026-NZEmpC-59-Judgment-of-Chief-Judge-Christina-Inglis-31-March-2026.pdf",
    "2026-NZEmpC-61-Satija-v-Epiphany-Donuts-Ltd-Ors-Judgment-of-Chief-Judge-Christina-Inglis-1-April-2026.pdf",
    "2026-NZEmpC-62-Modern-Auto-Repair-Centre-and-others-v-Nair-Judgment-of-Judge-Helen-Doyle-2-April-2026.pdf",
    "2026-NZEmpC-63-Seneviratne-v-Karunatillake-Interlocutory-judgment-of-Judge-Beck-2-April-2026.pdf",
    "2026-NZEmpC-65-Wilson-Parking-New-Zealand-Limited-v-Turner-and-others-Interlocutory-Judgment-No-6-of-Judge-Helen-Doyle-14-April-2026.pdf",
    "2026-NZEmpC-66-Fleming-v-CE-of-MSD-Anor-Interlocutory-Judgment-of-Chief-Judge-Inglis-14-April-2026.pdf",
    "2026-NZEmpC-68-Manawatu-Motors-1970-Ltd-v-Renner.pdf",
    "2026-NZEmpC-70-New-Zealand-Air-Line-Pilots-Association-Inc-v-Air-New-Zealand-Ltd.pdf",
    "2026-NZEmpC-71-Making-v-Windle.pdf",
    "2026-NZEmpC-72-VSL-v-ZSM-Limited-Oral-Judgment-of-Chief-Judge-Christina-Inglis-21-April-2026.pdf",
    "2026-NZEmpC-74-Du-Fall-v-The-Mokoia-Intermediate-School-Board.pdf",
    "2026-NZEmpC-75-Secretary-for-Education-v-New-Zealand-Post-Primary-Teachers-Assoc-Inc-Te-Wehengarua.pdf",
    "2026-NZEmpC-77-Prakash-v-Coca-Cola-Europacific-Partners-Interlocutory-Judgment.pdf",
    "EMPC-335-2025-Jenner-v-Corrections-Assoc-of-New-Zealand-Inc-Costs.pdf",
    "EMPC-289-2024-Faitala-Vea-v-The-Pacific-Island-Business-Development-Trust-Judgment.pdf",
    "2026-NZEmpC-82-Jung-v-Asian-Savour-World-Pty-Ltd.pdf",
]

results = {"success": [], "failed": []}

for i, filename in enumerate(FILES):
    path = os.path.join(UPLOADS_DIR, filename)
    print(f"\n[{i+1}/{len(FILES)}] Processing: {filename}")
    
    # Extract text
    try:
        text = extract_text(path)
        print(f"  Extracted {len(text)} chars")
        if len(text) < 100:
            print(f"  WARNING: Very short text ({len(text)} chars), skipping")
            results["failed"].append({"file": filename, "reason": f"insufficient text: {len(text)} chars"})
            continue
    except Exception as e:
        print(f"  ERROR extracting text: {e}")
        results["failed"].append({"file": filename, "reason": f"text extraction error: {e}"})
        continue
    
    # POST to worker
    payload = json.dumps({"filename": filename, "text": text}).encode("utf-8")
    req = urllib.request.Request(
        WORKER_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {ADMIN_SECRET}",
            "User-Agent": "Mozilla/5.0 (compatible; era-digest-uploader/1.0)",
        },
        method="POST",
    )
    
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read().decode("utf-8")
            data = json.loads(body)
            print(f"  ✅ Success: {data.get('title', filename)}")
            results["success"].append(filename)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        print(f"  ❌ HTTP {e.code}: {body[:300]}")
        results["failed"].append({"file": filename, "reason": f"HTTP {e.code}: {body[:200]}"})
    except Exception as e:
        print(f"  ❌ Error: {e}")
        results["failed"].append({"file": filename, "reason": str(e)})
    
    # Brief pause between uploads
    if i < len(FILES) - 1:
        time.sleep(3)

print(f"\n{'='*60}")
print(f"DONE: {len(results['success'])} succeeded, {len(results['failed'])} failed")
if results["failed"]:
    print("\nFailed cases:")
    for f in results["failed"]:
        print(f"  - {f['file']}: {f['reason']}")

# Save results
with open("/agent/home/batch_upload_results.json", "w") as f:
    json.dump(results, f, indent=2)
print("\nResults saved to /agent/home/batch_upload_results.json")
