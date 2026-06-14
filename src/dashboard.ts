/**
 * dashboard.ts - HTML dashboard page template
 * Served from /admin/dashboard after cookie-based login
 */

export function getDashboardHtml(status: {
  total_subscribers: number;
  active_subscribers: number;
  subscribers?: Array<{ id: number; email: string; name: string; confirmed: number }>;
  last_run_at: string | null;
  is_paused: boolean;
  total_cases: number;
  era_cases: number;
  ec_cases: number;
}): string {
  const subscriberRows = (status.subscribers || []).map(sub => `
    <div class="subscriber-row">
      <div class="subscriber-info">
        <div class="subscriber-name">${escapeHtml(sub.name || 'No Name Provided')}</div>
        <div class="subscriber-email">${escapeHtml(sub.email)}</div>
        <div class="subscriber-status">${sub.confirmed ? '✓ Confirmed' : '⏳ Pending'}</div>
      </div>
      <form method="POST" action="/admin/delete-subscriber" onsubmit="return confirm('Delete ${escapeHtml(sub.email)}?');" style="display:inline; margin:0;">
        <input type="hidden" name="id" value="${sub.id}">
        <button type="submit" class="button button-delete">Delete</button>
      </form>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ERA Admin Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      color: #1a1a1a;
    }
    .navbar {
      background: #fff;
      border-bottom: 1px solid #ddd;
      padding: 1.5rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 2px 4px rgba(0,0,0,0.05);
    }
    .navbar h1 { font-size: 1.5rem; color: #4f6f52; }
    .logout-form { display: inline; }
    .logout-btn {
      background: #ff7f50;
      color: white;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.9rem;
      transition: background 0.3s;
    }
    .logout-btn:hover { background: #e56a3a; }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem;
    }
    .tabs {
      display: flex;
      gap: 1rem;
      border-bottom: 2px solid #ddd;
      margin-bottom: 2rem;
      overflow-x: auto;
    }
    .tab-btn {
      padding: 0.75rem 1.5rem;
      border: none;
      background: none;
      cursor: pointer;
      font-size: 1rem;
      color: #666;
      border-bottom: 3px solid transparent;
      transition: all 0.3s;
      margin-bottom: -2px;
      white-space: nowrap;
    }
    .tab-btn.active {
      color: #4f6f52;
      border-bottom-color: #4f6f52;
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    .card {
      background: white;
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .card-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: #1a1a1a;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .stat-item {
      background: #f9f9f9;
      padding: 1rem;
      border-radius: 6px;
      border-left: 4px solid #4f6f52;
    }
    .stat-label {
      font-size: 0.85rem;
      color: #666;
      margin-bottom: 0.5rem;
    }
    .stat-value {
      font-size: 1.75rem;
      font-weight: 700;
      color: #4f6f52;
    }
    .button {
      background: #4f6f52;
      color: white;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 4px;
      cursor: pointer;
      font-size: 1rem;
      transition: background 0.3s;
    }
    .button:hover { background: #3d5640; }
    .button.secondary { background: #ff7f50; }
    .button.secondary:hover { background: #e56a3a; }
    .button.button-delete { background: #c00; padding: 0.5rem 1rem; font-size: 0.9rem; }
    .button.button-delete:hover { background: #900; }
    .button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .alert {
      padding: 1rem;
      border-radius: 4px;
      margin-bottom: 1rem;
    }
    .alert-error {
      background: #fee;
      border: 1px solid #fcc;
      color: #c00;
    }
    .alert-success {
      background: #efe;
      border: 1px solid #cfc;
      color: #060;
    }
    .alert-info {
      background: #eef;
      border: 1px solid #ccf;
      color: #00c;
    }
    .form-group {
      margin-bottom: 1.5rem;
    }
    .form-group label {
      display: block;
      margin-bottom: 0.5rem;
      font-weight: 500;
    }
    .form-group input,
    .form-group textarea {
      width: 100%;
      padding: 0.75rem;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 1rem;
      font-family: inherit;
    }
    .pause-state {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #f9f9f9;
      padding: 1rem;
      border-radius: 6px;
    }
    .pause-state.paused {
      background: #fff3cd;
      border: 1px solid #ffc107;
    }
    .pause-state.running {
      background: #d4edda;
      border: 1px solid #28a745;
    }
    .dropzone {
      border: 2px dashed #4f6f52;
      border-radius: 6px;
      padding: 2rem;
      text-align: center;
      background: #f9f9f9;
      cursor: pointer;
      transition: all 0.3s;
    }
    .dropzone:hover {
      background: #f0f5f2;
      border-color: #3d5640;
    }
    .dropzone.dragover {
      background: #e8f0e9;
      border-color: #2d4430;
    }
    .dropzone p {
      margin: 0.5rem 0;
      color: #666;
    }
    .subscriber-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem;
      border-bottom: 1px solid #eee;
    }
    .subscriber-row:last-child {
      border-bottom: none;
    }
    .subscriber-info {
      flex: 1;
    }
    .subscriber-name {
      font-weight: 600;
      margin-bottom: 0.25rem;
    }
    .subscriber-email {
      color: #666;
      font-size: 0.9rem;
      margin-bottom: 0.25rem;
    }
    .subscriber-status {
      color: #999;
      font-size: 0.85rem;
    }
    .email-preview {
      background: #f9f9f9;
      border: 1px solid #ddd;
      border-radius: 6px;
      padding: 1.5rem;
      margin-top: 1rem;
      max-height: 600px;
      overflow-y: auto;
    }
    .spinner {
      border: 3px solid #f3f3f3;
      border-top: 3px solid #4f6f52;
      border-radius: 50%;
      width: 20px;
      height: 20px;
      animation: spin 1s linear infinite;
      display: inline-block;
      margin-right: 8px;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .upload-status {
      margin-top: 1rem;
      padding: 1rem;
      border-radius: 4px;
      display: none;
    }
    .upload-status.show {
      display: block;
    }
  </style>
</head>
<body>
  <div class="navbar">
    <h1>ERA Admin Dashboard</h1>
    <form method="GET" action="/admin/logout" class="logout-form">
      <button type="submit" class="logout-btn">Logout</button>
    </form>
  </div>

  <div class="container">
    <div class="tabs">
      <button class="tab-btn active" type="button" onclick="switchTab(event, 'digest')">Digest Controls</button>
      <button class="tab-btn" type="button" onclick="switchTab(event, 'ec-upload')">EC Case Upload</button>
      <button class="tab-btn" type="button" onclick="switchTab(event, 'subscribers')">Subscribers</button>
      <button class="tab-btn" type="button" onclick="switchTab(event, 'analytics')">Analytics</button>
      <button class="tab-btn" type="button" onclick="switchTab(event, 'prompts')">Prompts</button>
      <button class="tab-btn" type="button" onclick="switchTab(event, 'rescan')">Rescan</button>
      <button class="tab-btn" type="button" onclick="switchTab(event, 'scraper')">📡 ERA Scraper</button>
      <button class="tab-btn" type="button" onclick="switchTab(event, 'diagnostics')">Diagnostics</button>
      <button class="tab-btn" type="button" onclick="switchTab(event, 'errors')">Error Log</button>
    </div>

    <!-- Digest Controls Tab -->
    <div id="digest" class="tab-content active">
      <div class="card">
        <div class="card-title">System Status</div>
        <div class="stats-grid">
          <div class="stat-item">
            <div class="stat-label">Last Run</div>
            <div class="stat-value">${status.last_run_at ? new Date(status.last_run_at).toLocaleString() : 'Never'}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Total Cases</div>
            <div class="stat-value">${status.total_cases}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Active Subscribers</div>
            <div class="stat-value">${status.active_subscribers}/${status.total_subscribers}</div>
          </div>
        </div>

        <div class="pause-state ${status.is_paused ? 'paused' : 'running'}">
          <div>
            <strong>${status.is_paused ? 'System Paused' : 'System Running'}</strong><br>
            <small>${status.is_paused ? 'Cron digest is paused' : 'Cron digest is active'}</small>
          </div>
          <form method="POST" action="/admin/set-pause" style="display:inline; margin:0;">
            <input type="hidden" name="paused" value="${status.is_paused ? '0' : '1'}">
            <button type="submit" class="button ${status.is_paused ? 'secondary' : ''}">
              ${status.is_paused ? 'Resume' : 'Pause'}
            </button>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Send Digest Now</div>
        <form id="digest-form">
          <div class="form-group">
            <label for="digest-limit">Limit to most recent cases</label>
            <input type="number" id="digest-limit" name="limit" min="1" max="50" value="10">
            <small>Default: 10. Shows how many cases to include.</small>
          </div>
          <button type="submit" class="button">Preview Email</button>
        </form>

        <div id="preview-section" style="display:none; margin-top: 1.5rem;">
          <div class="alert alert-info">
            <strong>Email Preview</strong> - This will be sent to ${status.active_subscribers} subscriber${status.active_subscribers !== 1 ? 's' : ''}.
          </div>
          <div id="preview-loading" style="display:none; text-align: center; padding: 2rem;">
            <div class="spinner"></div> Loading preview...
          </div>
          <div id="preview-content" class="email-preview"></div>
          <div style="margin-top: 1rem; display: flex; gap: 1rem;">
            <form method="POST" action="/admin/send-digest" id="send-form" style="display:inline;">
              <input type="hidden" name="limit" id="send-limit" value="10">
              <button type="submit" class="button">Send Now</button>
            </form>
            <button type="button" class="button" style="background: #999;" onclick="cancelPreview()">Cancel</button>
          </div>
        </div>
      </div>
    </div>

    <!-- EC Case Upload Tab -->
    <div id="ec-upload" class="tab-content">
      <div class="card">
        <div class="card-title">Upload Employment Court Case</div>
        <form id="ec-form" enctype="multipart/form-data">
          <div class="form-group">
            <label>PDF File</label>
            <div class="dropzone" id="dropzone" ondragover="dragOver(event)" ondragleave="dragLeave(event)" ondrop="drop(event)">
              <p>📄 Drag and drop your PDF here</p>
              <p style="font-size: 0.9rem; color: #999;">or click to browse</p>
              <input type="file" id="pdf-input" name="file" accept=".pdf" multiple style="display:none;" onchange="fileSelected()">
            </div>
            <small style="display: block; margin-top: 0.5rem;">Selected: <span id="file-name">None</span></small>
            <small style="display: block; margin-top: 0.25rem; color: #888;">PDF URL is auto-derived from the filename (employmentcourt.govt.nz/assets/Documents/Decisions/…)</small>
          </div>

          <button type="submit" class="button">Upload & Summarise</button>
          <div id="upload-status" class="upload-status"></div>
        </form>
      </div>
    </div>

    <!-- Subscribers Tab -->
    <div id="subscribers" class="tab-content">
      <div class="card">
        <div class="card-title">Subscribers (${status.active_subscribers})</div>
        ${subscriberRows ? `<div>${subscriberRows}</div>` : '<p style="color: #666; padding: 1rem;">No subscribers found.</p>'}
      </div>
    </div>

    <!-- Analytics Tab -->
    <div id="analytics" class="tab-content">
      <div class="card">
        <div class="card-title">System Analytics</div>
        <div class="stats-grid">
          <div class="stat-item">
            <div class="stat-label">Total Cases Processed</div>
            <div class="stat-value">${status.total_cases}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">ERA Cases</div>
            <div class="stat-value">${status.era_cases}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">EC Cases</div>
            <div class="stat-value">${status.ec_cases}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Total Subscribers</div>
            <div class="stat-value">${status.total_subscribers}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Prompts Tab -->
    <div id="prompts" class="tab-content">
      <div class="card">
        <div class="card-title">LLM System Prompts</div>
        <p style="color: #666; margin-bottom: 1.5rem;">Edit the system prompts used by the LLM for summarization. Changes take effect immediately on the next case processed.</p>
        
        <form id="prompts-form">
          <div class="form-group">
            <label for="prompt-era"><strong>ERA Determinations Prompt</strong></label>
            <textarea id="prompt-era" name="prompt_era" style="min-height: 300px; font-family: monospace; font-size: 0.9rem; padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px; width: 100%; box-sizing: border-box;"></textarea>
            <div style="margin-top: 0.5rem; padding: 1rem; background: #f0f5f2; border-left: 4px solid #4f6f52; border-radius: 4px;">
              <strong>📋 Prompt Structure Reference</strong>
              <p style="margin: 0.5rem 0 0 0; font-size: 13px; color: #555;">This shows the expected section format the LLM should output. Your prompt should instruct the model to produce summaries in this structure.</p>
              <ul style="margin: 0.5rem 0 0 0; padding-left: 1.5rem;">
                <li>PARTIES, REPRESENTATIVES, FACTS, LEGAL ISSUES, HOW THE ISSUES WERE RESOLVED, OUTCOME, REMEDY</li>
                <li>Numbered lists for issues and resolutions (1., 2., 3.)</li>
                <li>Include status flags per issue: (Established), (Dismissed), (Not reached)</li>
                <li>Anti-hallucination rule: representative names must be exact from document</li>
                <li>Completeness check before submitting: verify all issues captured</li>
              </ul>
            </div>
          </div>

          <div class="form-group" style="margin-top: 2rem;">
            <label for="prompt-ec"><strong>Employment Court Judgments Prompt</strong></label>
            <textarea id="prompt-ec" name="prompt_ec" style="min-height: 300px; font-family: monospace; font-size: 0.9rem; padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px; width: 100%; box-sizing: border-box;"></textarea>
            <div style="margin-top: 0.5rem; padding: 1rem; background: #f0f5f2; border-left: 4px solid #4f6f52; border-radius: 4px;">
              <strong>📋 Prompt Structure Reference</strong>
              <p style="margin: 0.5rem 0 0 0; font-size: 13px; color: #555;">This shows the expected section format the LLM should output. Your prompt should instruct the model to produce summaries in this structure.</p>
              <ul style="margin: 0.5rem 0 0 0; padding-left: 1.5rem;">
                <li>JUDGE & DATE, PARTIES, REPRESENTATIVES, FACTS, ERA FINDINGS, EMPLOYMENT COURT ISSUES RAISED, HOW THE EMPLOYMENT COURT ISSUES WERE RESOLVED, OUTCOME & REMEDY</li>
                <li>Do NOT include [JUDGMENT ON APPEAL] or similar flags</li>
                <li>No preamble text before structured output</li>
                <li>Start immediately with JUDGE & DATE</li>
                <li>Include status flags per issue: (Upheld in appeal), (Dismissed on appeal), (Not reached)</li>
              </ul>
            </div>
          </div>

          <button type="submit" class="button" style="margin-top: 1.5rem;">Save Prompts</button>
        </form>
        <div id="prompts-status"></div>
      </div>
    </div>

    <!-- Rescan Tab -->
    <div id="rescan" class="tab-content">
      <div class="card">
        <div class="card-title">Rescan Cases</div>
        <p style="color: #666; margin-bottom: 1.5rem;">Re-process previously stored cases with updated LLM prompts. This is useful after modifying the prompts above.</p>
        
        <div>
          <div class="form-group">
            <label for="rescan-limit">Number of cases to rescan</label>
            <input type="number" id="rescan-limit" name="limit" min="1" max="50" value="5">
            <small>Rescans the most recent N cases. Default: 5.</small>
          </div>

          <div style="display: flex; gap: 1rem; margin-top: 1.5rem;">
            <button type="button" class="button" onclick="rescanSilently()">Rescan Silently</button>
            <button type="button" class="button" onclick="rescanAndSendEmail()">Rescan & Send Email</button>
          </div>

          <div id="rescan-status"></div>
        </div>
      </div>
    </div>

    <!-- Diagnostics Tab -->
    <div id="diagnostics" class="tab-content">
      <div class="card">
        <div class="card-title">System Diagnostics</div>
        <p style="color: #666; margin-bottom: 1.5rem;">Run targeted tests to isolate which layer of the summarisation pipeline is failing.</p>

        <div style="display: flex; flex-direction: column; gap: 1rem;">

          <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong>🟢 Cloudflare Environment</strong>
                <div style="font-size: 12px; color: #666;">Worker readiness, D1 connectivity, env vars</div>
              </div>
              <button class="button" onclick="runDiag('ping')" id="diag-ping-btn">Run</button>
            </div>
            <div id="diag-ping-result" style="margin-top: 0.5rem; font-size: 13px;"></div>
          </div>

          <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong>🔵 OpenRouter Connectivity</strong>
                <div style="font-size: 12px; color: #666;">Network reach, auth validity, model availability</div>
              </div>
              <button class="button" onclick="runDiag('openrouter-connectivity')" id="diag-openrouter-btn">Run</button>
            </div>
            <div id="diag-openrouter-result" style="margin-top: 0.5rem; font-size: 13px;"></div>
          </div>

          <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong>🟡 Full Summary Test</strong>
                <div style="font-size: 12px; color: #666;">End-to-end summary on a known good ERA PDF</div>
              </div>
              <button class="button" onclick="runDiag('openrouter-summary')" id="diag-summary-btn">Run</button>
            </div>
            <div id="diag-summary-result" style="margin-top: 0.5rem; font-size: 13px;"></div>
          </div>

          <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong>🟣 PDF Extraction</strong>
                <div style="font-size: 12px; color: #666;">Test text extraction from ERA PDFs</div>
              </div>
              <button class="button" onclick="runDiag('pdf-extraction')" id="diag-pdf-btn">Run</button>
            </div>
            <div id="diag-pdf-result" style="margin-top: 0.5rem; font-size: 13px;"></div>
          </div>

          <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong>🟠 Time Budget Breakdown</strong>
                <div style="font-size: 12px; color: #666;">Time each pipeline stage separately</div>
              </div>
              <button class="button" onclick="runDiag('time-budget')" id="diag-time-btn">Run</button>
            </div>
            <div id="diag-time-result" style="margin-top: 0.5rem; font-size: 13px;"></div>
          </div>

          <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong>🔴 End-to-End Single Case</strong>
                <div style="font-size: 12px; color: #666;">Full pipeline: scrape → PDF → LLM → store</div>
              </div>
              <button class="button" onclick="runDiag('end-to-end')" id="diag-e2e-btn">Run</button>
            </div>
            <div id="diag-e2e-result" style="margin-top: 0.5rem; font-size: 13px;"></div>
          </div>

          <div style="border: 2px solid #4f6f52; border-radius: 8px; padding: 1rem; background: #f6f9f6;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong>▶ Run All Tests</strong>
                <div style="font-size: 12px; color: #666;">Run every diagnostic in sequence (may take 2+ minutes)</div>
              </div>
              <button class="button" style="background: #4f6f52; color: white;" onclick="runDiag('all')" id="diag-all-btn">Run All</button>
            </div>
            <div id="diag-all-result" style="margin-top: 0.5rem; font-size: 13px;"></div>
          </div>

        </div>
      </div>
    </div>

    <!-- ERA Scraper Tab -->
    <div id="scraper" class="tab-content">
      <!-- Stats Bar -->
      <div class="card">
        <div class="card-title">📊 Current State</div>
        <div class="stats-grid" id="scraper-stats">
          <div class="stat-item">
            <div class="stat-label">Latest ERA ID</div>
            <div class="stat-value" id="stat-last-id">—</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Latest Case</div>
            <div class="stat-value" id="stat-latest-case" style="font-size:13px; line-height:1.3;">—</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Total Cases</div>
            <div class="stat-value" id="stat-total-cases">—</div>
          </div>
        </div>
      </div>

      <!-- ID Range Scrape -->
      <div class="card">
        <div class="card-title">🔢 Scrape by ERA ID</div>
        <p style="color:#666;font-size:13px;margin-bottom:12px;">Probes the ERA internal index. Set same start & end ID to scrape a single case.</p>
        <div class="form-group" style="display:flex;gap:12px;align-items:flex-end;">
          <div style="flex:1;">
            <label>Start ID</label>
            <input type="number" id="scrape-id-start" value="21300" min="1">
          </div>
          <div style="flex:1;">
            <label>End ID</label>
            <input type="number" id="scrape-id-end" value="21300" min="1">
          </div>
          <button class="button" onclick="scrapeIdRange()" id="scrape-id-btn">Scrape</button>
        </div>
        <div id="scrape-id-status" class="upload-status" style="margin-top:12px;"></div>
      </div>

      <!-- Date Range Scrape -->
      <div class="card">
        <div class="card-title">📅 Scrape by Date Range</div>
        <p style="color:#666;font-size:13px;margin-bottom:12px;">Scans the ERA recent listing pages for cases within a date window.</p>
        <div class="form-group" style="display:flex;gap:12px;align-items:flex-end;">
          <div style="flex:1;">
            <label>From</label>
            <input type="date" id="scrape-date-from">
          </div>
          <div style="flex:1;">
            <label>To</label>
            <input type="date" id="scrape-date-to">
          </div>
          <button class="button" onclick="scrapeDateRange()" id="scrape-date-btn">Scrape</button>
        </div>
        <div id="scrape-date-status" class="upload-status" style="margin-top:12px;"></div>
      </div>

      <!-- URL Upload -->
      <div class="card">
        <div class="card-title">🔗 Upload ERA Case by URL</div>
        <p style="color:#666;font-size:13px;margin-bottom:12px;">Paste an ERA determination PDF URL to summarise it.</p>
        <div class="form-group" style="display:flex;gap:12px;align-items:flex-end;">
          <div style="flex:1;">
            <input type="text" id="era-url-input" placeholder="https://determinations.era.govt.nz/assets/elawpdf/2026/2026-NZERA-XXX.pdf">
          </div>
          <button class="button" onclick="uploadEraUrl()" id="era-url-btn">Summarise</button>
        </div>
        <div id="era-url-status" class="upload-status" style="margin-top:12px;"></div>
      </div>

      <!-- Bulk PDF Upload -->
      <div class="card">
        <div class="card-title">📁 Bulk ERA PDF Upload</div>
        <p style="color:#666;font-size:13px;margin-bottom:12px;">Upload ERA PDF files directly. Metadata is extracted from the filename.</p>
        <div id="era-dropzone" style="border:2px dashed #ccc;border-radius:8px;padding:24px;text-align:center;background:#fff;cursor:pointer;" onclick="document.getElementById('era-pdf-input').click()">
          <div style="font-size:32px;color:#999;">📄</div>
          <p><strong>Click to select ERA PDF files</strong><br>or drag and drop here</p>
          <p style="font-size:11px;color:#bbb;margin-top:4px;">Accepts .pdf files — processed sequentially</p>
        </div>
        <input type="file" id="era-pdf-input" accept=".pdf" multiple style="display:none;" onchange="handleEraPdfFiles()">
        <div id="era-upload-status" class="upload-status" style="margin-top:12px;"></div>
      </div>
    </div>

    <!-- Error Log Tab -->
    <div id="errors" class="tab-content">
      <div class="card">
        <div class="card-title" style="display: flex; justify-content: space-between; align-items: center;">
          <span>Error Log</span>
          <span style="font-size: 0.85rem; color: #666;">
            <span id="error-loading" class="spinner" style="display:none;"></span>
            <button class="button" style="padding: 0.4rem 1rem; font-size: 0.85rem;" onclick="loadErrors()">Refresh</button>
          </span>
        </div>
        <p style="color: #666; margin-bottom: 1.5rem; font-size: 0.9rem;">
          Recent pipeline and system errors. Shows up to 50 most recent entries.
        </p>
        <div id="error-log-container">
          <p style="color: #999;">Load errors by clicking "Refresh" or opening this tab.</p>
        </div>
      </div>
    </div>
  </div>

  <script>
    function switchTab(event, tabName) {
      event.preventDefault();
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
      const tab = document.getElementById(tabName);
      if (tab) tab.classList.add('active');
      event.target.classList.add('active');
      // Auto-load content when specific tabs are opened
      if (tabName === 'errors') loadErrors();
      if (tabName === 'scraper') loadScraperStats();
    }

    function dragOver(event) {
      event.preventDefault();
      document.getElementById('dropzone').classList.add('dragover');
    }

    function dragLeave(event) {
      event.preventDefault();
      document.getElementById('dropzone').classList.remove('dragover');
    }

    function drop(event) {
      event.preventDefault();
      document.getElementById('dropzone').classList.remove('dragover');
      const files = event.dataTransfer.files;
      if (files.length > 0) {
        document.getElementById('pdf-input').files = files;
        fileSelected();
      }
    }

    function fileSelected() {
      const input = document.getElementById('pdf-input');
      const fileName = document.getElementById('file-name');
      if (input.files.length > 0) {
        fileName.textContent = input.files.length === 1
          ? input.files[0].name
          : input.files.length + ' files selected';
      } else {
        fileName.textContent = 'None';
      }
    }

    const dropzone = document.getElementById('dropzone');
    if (dropzone) {
      dropzone.addEventListener('click', () => {
        document.getElementById('pdf-input').click();
      });
    }

    const eraDropzone = document.getElementById('era-dropzone');
    if (eraDropzone) {
      eraDropzone.addEventListener('dragover', (e) => { e.preventDefault(); eraDropzone.style.borderColor = '#4f6f52'; eraDropzone.style.background = '#f6f9f6'; });
      eraDropzone.addEventListener('dragleave', () => { eraDropzone.style.borderColor = '#ccc'; eraDropzone.style.background = '#fff'; });
      eraDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        eraDropzone.style.borderColor = '#ccc'; eraDropzone.style.background = '#fff';
        if (e.dataTransfer.files.length > 0) {
          document.getElementById('era-pdf-input').files = e.dataTransfer.files;
          handleEraPdfFiles();
        }
      });
    }

    document.getElementById('ec-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById('pdf-input');
      const status = document.getElementById('upload-status');
      
      if (!fileInput.files.length) {
        status.className = 'upload-status show alert alert-error';
        status.textContent = '❌ Error: No file selected';
        return;
      }

      const totalFiles = fileInput.files.length;
      for (let f = 0; f < totalFiles; f++) {
        const file = fileInput.files[f];
        const filename = file.name;
        let lastError = null;
      
        try {
          status.className = 'upload-status show alert alert-info';
          status.textContent = '⏳ [' + (f+1) + '/' + totalFiles + '] Reading ' + filename + '...';

          // Read file as ArrayBuffer
          const arrayBuffer = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
          });

          // Determine endpoint based on file type
          const url = new URL('/admin/upload-ec-case', window.location.origin);
          url.searchParams.set('filename', filename);

          status.textContent = '⏳ [' + (f+1) + '/' + totalFiles + '] Summarising ' + filename + '...';

          const response = await fetch(url.toString(), {
            method: 'POST',
            body: arrayBuffer,
            headers: {
              'Content-Type': 'application/pdf',
            },
            credentials: 'same-origin'
          });

          if (!response.ok) {
            const error = await response.text();
            throw new Error(error || 'Upload failed');
          }

          const result = await response.json();
          if (f === totalFiles - 1) {
            status.className = 'upload-status show alert alert-success';
            status.innerHTML = '<strong>✓ ' + (totalFiles > 1 ? filename : 'Case') + ' uploaded successfully!</strong><br>The case has been summarised and stored in the database.';
          }
          
          if (totalFiles > 1) {
            status.className = 'upload-status show alert alert-info';
          }
        } catch (err) {
          lastError = err;
          status.className = 'upload-status show alert alert-error';
          status.textContent = '❌ [' + (f+1) + '/' + totalFiles + '] ' + filename + ': ' + err.message;
        }
        
        // Final status after all files
        if (f === totalFiles - 1) {
          if (lastError) {
            status.className = 'upload-status show alert alert-error';
            status.textContent = '❌ Error: ' + lastError.message;
          } else if (totalFiles > 1) {
            status.className = 'upload-status show alert alert-success';
            status.innerHTML = '<strong>✓ All ' + totalFiles + ' cases uploaded successfully!</strong>';
          }
        }
      }
    });

    document.getElementById('digest-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const limit = document.getElementById('digest-limit').value;
      document.getElementById('send-limit').value = limit;
      
      const previewSection = document.getElementById('preview-section');
      const previewLoading = document.getElementById('preview-loading');
      const previewContent = document.getElementById('preview-content');
      
      previewSection.style.display = 'block';
      previewLoading.style.display = 'block';
      previewContent.innerHTML = '';

      try {
        const response = await fetch(\`/admin/preview-digest?limit=\${limit}\`, {
          credentials: 'same-origin'
        });
        if (!response.ok) throw new Error('Failed to load preview');
        
        const html = await response.text();
        previewContent.innerHTML = html;
      } catch (err) {
        previewContent.innerHTML = '<div class="alert alert-error">Error loading preview: ' + err.message + '</div>';
      } finally {
        previewLoading.style.display = 'none';
      }
    });

    function cancelPreview() {
      document.getElementById('preview-section').style.display = 'none';
    }

    // Auto-load scraper stats when the scraper tab is shown
    async function loadScraperStats() {
      const lastIdEl = document.getElementById('stat-last-id');
      const caseEl = document.getElementById('stat-latest-case');
      const totalEl = document.getElementById('stat-total-cases');
      try {
        const resp = await fetch('/admin/status', { credentials: 'same-origin' });
        if (resp.ok) {
          const data = await resp.json();
          if (totalEl) totalEl.textContent = data.total_cases ?? '—';
        }
      } catch {}
      try {
        const resp = await fetch('/admin/seen-cases?limit=1', { credentials: 'same-origin' });
        if (resp.ok) {
          const data = await resp.json();
          if (data.cases?.[0]) {
            const c = data.cases[0];
            if (lastIdEl) {
              const idMatch = c.case_url?.match(/\/view\/(\d+)/);
              lastIdEl.textContent = idMatch ? idMatch[1] : '—';
            }
            if (caseEl) caseEl.textContent = c.title?.substring(0, 60) + (c.title?.length > 60 ? '…' : '') || '—';
          }
        }
      } catch {}
    }

    async function scrapeIdRange() {
      const start = document.getElementById('scrape-id-start')?.value;
      const end = document.getElementById('scrape-id-end')?.value;
      const btn = document.getElementById('scrape-id-btn');
      const status = document.getElementById('scrape-id-status');
      if (!start || !end || !btn || !status) return;
      btn.disabled = true; btn.textContent = '⏳ Scraping...';
      status.className = 'upload-status show alert alert-info';
      status.textContent = '⏳ Probing ERA IDs ' + start + '–' + end + '...';
      try {
        const resp = await fetch('/admin/dashboard/scrape-id-range?start_id=' + start + '&end_id=' + end, { credentials: 'same-origin' });
        const data = await resp.json();
        if (data.success) {
          const parts = [];
          if (data.processed > 0) parts.push('✅ Processed ' + data.processed + ' case(s)');
          if (data.failed > 0) parts.push('❌ ' + data.failed + ' failed');
          if (data.found > 0 && data.processed === 0) parts.push('📡 Found ' + data.new + ' new case(s) — already at processing limit');
          if (data.found === 0) parts.push('📭 No cases found in that range');
          status.className = 'upload-status show alert ' + (data.processed > 0 ? 'alert-success' : 'alert-info');
          status.innerHTML = parts.join('<br>') + '<br><small>' + data.message + '</small>';
        } else {
          status.className = 'upload-status show alert alert-error';
          status.textContent = '❌ Error: ' + (data.error || 'Unknown');
        }
      } catch (err) {
        status.className = 'upload-status show alert alert-error';
        status.textContent = '❌ Request failed: ' + err.message;
      }
      btn.disabled = false; btn.textContent = 'Scrape';
    }

    async function scrapeDateRange() {
      const dateFrom = document.getElementById('scrape-date-from')?.value;
      const dateTo = document.getElementById('scrape-date-to')?.value;
      const btn = document.getElementById('scrape-date-btn');
      const status = document.getElementById('scrape-date-status');
      if (!btn || !status) return;
      btn.disabled = true; btn.textContent = '⏳ Scraping...';
      status.className = 'upload-status show alert alert-info';
      status.textContent = '⏳ Scanning ERA listing pages...';
      try {
        let url = '/admin/dashboard/scrape-date-range';
        const params = [];
        if (dateFrom) params.push('date_from=' + encodeURIComponent(dateFrom));
        if (dateTo) params.push('date_to=' + encodeURIComponent(dateTo));
        if (params.length) url += '?' + params.join('&');
        const resp = await fetch(url, { credentials: 'same-origin' });
        const data = await resp.json();
        if (data.success) {
          const parts = [];
          parts.push('📡 Scanned ' + data.scraped + ' cases, ' + data.in_range + ' in date range');
          if (data.processed > 0) parts.push('✅ Processed ' + data.processed + ' case(s)');
          if (data.failed > 0) parts.push('❌ ' + data.failed + ' failed');
          if (data.new > 0 && data.processed === 0) parts.push('⚠️ Found ' + data.new + ' new case(s) — at processing limit');
          status.className = 'upload-status show alert ' + (data.processed > 0 ? 'alert-success' : 'alert-info');
          status.innerHTML = parts.join('<br>');
        } else {
          status.className = 'upload-status show alert alert-error';
          status.textContent = '❌ Error: ' + (data.error || 'Unknown');
        }
      } catch (err) {
        status.className = 'upload-status show alert alert-error';
        status.textContent = '❌ Request failed: ' + err.message;
      }
      btn.disabled = false; btn.textContent = 'Scrape';
    }

    async function uploadEraUrl() {
      const urlInput = document.getElementById('era-url-input');
      const btn = document.getElementById('era-url-btn');
      const status = document.getElementById('era-url-status');
      if (!urlInput || !btn || !status) return;
      const pdfUrl = urlInput.value.trim();
      if (!pdfUrl) { status.className = 'upload-status show alert alert-error'; status.textContent = '❌ Please enter a PDF URL'; return; }
      btn.disabled = true; btn.textContent = '⏳ Summarising...';
      status.className = 'upload-status show alert alert-info';
      status.textContent = '⏳ Processing...';
      try {
        const resp = await fetch('/admin/dashboard/upload-era-url', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pdfUrl }),
        });
        const data = await resp.json();
        if (data.success) {
          status.className = 'upload-status show alert alert-success';
          status.textContent = '✅ ' + (data.message || 'Case summarised successfully');
        } else {
          status.className = 'upload-status show alert alert-error';
          status.textContent = '❌ ' + (data.error || data.message || 'Upload failed');
        }
      } catch (err) {
        status.className = 'upload-status show alert alert-error';
        status.textContent = '❌ Request failed: ' + err.message;
      }
      btn.disabled = false; btn.textContent = 'Summarise';
    }

    async function handleEraPdfFiles() {
      const input = document.getElementById('era-pdf-input');
      const status = document.getElementById('era-upload-status');
      if (!input || !input.files.length || !status) return;
      const totalFiles = input.files.length;
      status.className = 'upload-status show alert alert-info';
      status.textContent = '⏳ Uploading ' + totalFiles + ' file(s)...';
      try {
        const formData = new FormData();
        for (const file of input.files) {
          formData.append('files', file);
        }
        const resp = await fetch('/admin/dashboard/upload-era-pdf', {
          method: 'POST', credentials: 'same-origin',
          body: formData,
        });
        const data = await resp.json();
        if (data.success) {
          const details = data.details || [];
          const successCount = details.filter(d => d.success).length;
          const failCount = details.filter(d => !d.success).length;
          let html = '';
          if (successCount > 0) html += '✅ ' + successCount + ' processed<br>';
          if (failCount > 0) html += '❌ ' + failCount + ' failed<br>';
          html += '<div style="font-size:12px;margin-top:8px;max-height:200px;overflow-y:auto;">';
          for (const d of details) {
            html += '<div style="padding:4px 0;border-bottom:1px solid #eee;">';
            html += d.success ? '✅ ' : '❌ ';
            html += esc(d.filename);
            if (d.title) html += '<br><span style="color:#666;">' + esc(d.title) + '</span>';
            if (d.error) html += '<br><span style="color:#c00;">' + esc(d.error) + '</span>';
            html += '</div>';
          }
          html += '</div>';
          status.className = 'upload-status show alert ' + (failCount === 0 ? 'alert-success' : 'alert-info');
          status.innerHTML = html;
        } else {
          status.className = 'upload-status show alert alert-error';
          status.textContent = '❌ Error: ' + (data.error || 'Upload failed');
        }
      } catch (err) {
        status.className = 'upload-status show alert alert-error';
        status.textContent = '❌ Request failed: ' + err.message;
      }
      input.value = '';
    }

    // Load error log entries
    async function loadErrors() {
      const container = document.getElementById('error-log-container');
      const loading = document.getElementById('error-loading');
      if (!container) return;
      loading.style.display = 'inline-block';
      container.innerHTML = '<p style="color: #999;">Loading...</p>';
      try {
        const response = await fetch('/admin/errors', { credentials: 'same-origin' });
        if (!response.ok) {
          if (response.status === 401) {
            container.innerHTML = '<div class="alert alert-error">Unauthorized — please log in again.</div>';
          } else {
            container.innerHTML = '<div class="alert alert-error">HTTP ' + response.status + '</div>';
          }
          return;
        }
        const data = await response.json();
        const errors = data.errors || [];
        if (errors.length === 0) {
          container.innerHTML = '<p style="color: #999; text-align: center; padding: 2rem;">No errors logged yet — the pipeline is running clean.</p>';
          return;
        }
        // Browser-safe HTML escape
        function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
        let html = '<table style="width:100%; border-collapse: collapse; font-size: 0.9rem;">';
        html += '<thead><tr style="background: #f5f5f5;">';
        html += '<th style="padding: 0.6rem; text-align: left; border-bottom: 2px solid #ddd;">Time</th>';
        html += '<th style="padding: 0.6rem; text-align: left; border-bottom: 2px solid #ddd;">Level</th>';
        html += '<th style="padding: 0.6rem; text-align: left; border-bottom: 2px solid #ddd;">Source</th>';
        html += '<th style="padding: 0.6rem; text-align: left; border-bottom: 2px solid #ddd;">Message</th>';
        html += '<th style="padding: 0.6rem; text-align: left; border-bottom: 2px solid #ddd;">Case</th>';
        html += '</tr></thead><tbody>';
        for (const err of errors) {
          const levelClass = err.level === 'error' ? 'color: #c00;' : err.level === 'warn' ? 'color: #c80;' : 'color: #36c;';
          html += '<tr style="border-bottom: 1px solid #eee;">';
          html += '<td style="padding: 0.5rem 0.6rem; white-space: nowrap;">' + (err.created_at ? new Date(err.created_at + 'Z').toLocaleString() : '—') + '</td>';
          html += '<td style="padding: 0.5rem 0.6rem;"><span style="' + levelClass + ' font-weight: 600;">' + esc(err.level || '—') + '</span></td>';
          html += '<td style="padding: 0.5rem 0.6rem;">' + esc(err.source || '—') + '</td>';
          html += '<td style="padding: 0.5rem 0.6rem; max-width: 400px; overflow: hidden; text-overflow: ellipsis;" title="' + esc(err.message) + '">' + esc(err.message || '—') + '</td>';
          html += '<td style="padding: 0.5rem 0.6rem;">' + (err.case_id ? esc(err.case_id) : '—') + '</td>';
          html += '</tr>';
        }
        html += '</tbody></table>';
        container.innerHTML = html;
      } catch (err) {
        container.innerHTML = '<div class="alert alert-error">Failed to load errors: ' + esc(err.message) + '</div>';
      } finally {
        loading.style.display = 'none';
      }
    }

    // Load prompts on page load
    async function loadPrompts() {
      try {
        const response = await fetch('/admin/dashboard/get-prompts', {
          credentials: 'same-origin'
        });
        if (!response.ok) throw new Error('Failed to load prompts');
        const data = await response.json();
        document.getElementById('prompt-era').value = data.prompt_era || '';
        document.getElementById('prompt-ec').value = data.prompt_ec || '';
      } catch (err) {
        console.error('Error loading prompts:', err);
      }
    }

    // Handle prompts form submission
    document.getElementById('prompts-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const statusEl = document.getElementById('prompts-status');
      statusEl.innerHTML = '⏳ Saving prompts...';
      statusEl.className = '';

      try {
        const formData = new FormData(document.getElementById('prompts-form'));
        const response = await fetch('/admin/dashboard/update-prompts', {
          method: 'POST',
          credentials: 'same-origin',
          body: formData
        });

        if (!response.ok) throw new Error(await response.text());
        
        statusEl.className = 'alert alert-success';
        statusEl.innerHTML = '<strong>✓ Prompts saved successfully!</strong> Changes will apply to the next case processed.';
        setTimeout(() => {
          statusEl.innerHTML = '';
          statusEl.className = '';
        }, 5000);
      } catch (err) {
        statusEl.className = 'alert alert-error';
        statusEl.innerHTML = '<strong>❌ Error:</strong> ' + err.message;
      }
    });

    // Handle rescan silently
    async function rescanSilently() {
      const statusEl = document.getElementById('rescan-status');
      const limit = document.getElementById('rescan-limit').value;
      statusEl.innerHTML = '⏳ Rescanning ' + limit + ' cases...';
      statusEl.className = '';

      try {
        const response = await fetch('/admin/dashboard/rescan-cases?limit=' + limit, {
          method: 'POST',
          credentials: 'same-origin',
          body: JSON.stringify({ send_email: false })
        });

        if (!response.ok) throw new Error(await response.text());
        
        statusEl.className = 'alert alert-success';
        statusEl.innerHTML = '<strong>✓ Rescan complete!</strong> ' + limit + ' cases have been re-processed with the current prompts.';
        setTimeout(() => {
          statusEl.innerHTML = '';
          statusEl.className = '';
        }, 5000);
      } catch (err) {
        statusEl.className = 'alert alert-error';
        statusEl.innerHTML = '<strong>❌ Error:</strong> ' + err.message;
      }
    }

    // Handle rescan & send email
    async function rescanAndSendEmail() {
      const statusEl = document.getElementById('rescan-status');
      const limit = document.getElementById('rescan-limit').value;
      statusEl.innerHTML = '⏳ Rescanning ' + limit + ' cases and preparing email...';
      statusEl.className = '';

      try {
        const response = await fetch('/admin/dashboard/rescan-cases?limit=' + limit, {
          method: 'POST',
          credentials: 'same-origin',
          body: JSON.stringify({ send_email: true })
        });

        if (!response.ok) throw new Error(await response.text());
        
        statusEl.className = 'alert alert-success';
        statusEl.innerHTML = '<strong>✓ Rescan complete and email sent!</strong> Updated summaries for ' + limit + ' cases have been emailed to subscribers.';
        setTimeout(() => {
          statusEl.innerHTML = '';
          statusEl.className = '';
        }, 5000);
      } catch (err) {
        statusEl.className = 'alert alert-error';
        statusEl.innerHTML = '<strong>❌ Error:</strong> ' + err.message;
      }
    }

    // Load prompts when page loads
    document.addEventListener('DOMContentLoaded', loadPrompts);

    // ─── Diagnostics ───────────────────────────────────────────────────────
    async function runDiag(testName) {
      const btnId = testName === 'all' ? 'diag-all-btn' : 'diag-' + testName.split('-').pop() + '-btn';
      const resultId = testName === 'all' ? 'diag-all-result' : 'diag-' + testName.split('-').pop() + '-result';
      const btn = document.getElementById(btnId);
      const resultEl = document.getElementById(resultId);
      const originalText = btn.textContent;
      btn.textContent = '⏳ Running...';
      btn.disabled = true;
      resultEl.innerHTML = '';
      resultEl.style.color = '#666';

      try {
        const url = '/admin/diagnostics?test=' + encodeURIComponent(testName);
        const response = await fetch(url, { credentials: 'same-origin' });

        // If 401, try with Bearer token from a hidden input or prompt
        if (response.status === 401) {
          const password = prompt('Enter admin password for diagnostics:');
          if (!password) { btn.textContent = originalText; btn.disabled = false; return; }
          const authResp = await fetch(url, {
            headers: { 'Authorization': 'Bearer ' + password }
          });
          if (!authResp.ok) {
            resultEl.style.color = '#c0392b';
            resultEl.innerHTML = '❌ Auth failed — wrong password?';
            btn.textContent = originalText;
            btn.disabled = false;
            return;
          }
          const data = await authResp.json();
          renderDiagResults(resultEl, data);
        } else if (response.ok) {
          const data = await response.json();
          renderDiagResults(resultEl, data);
        } else {
          const text = await response.text();
          resultEl.style.color = '#c0392b';
          resultEl.innerHTML = '❌ HTTP ' + response.status + ': ' + text.slice(0, 200);
        }
      } catch (err) {
        resultEl.style.color = '#c0392b';
        resultEl.innerHTML = '❌ Error: ' + err.message;
      }

      btn.textContent = originalText;
      btn.disabled = false;
    }

    function renderDiagResults(container, data) {
      const tests = data.tests || [data];
      let html = '';

      for (const t of tests) {
        const total = t.summary.pass + t.summary.fail + t.summary.warn;
        const icon = t.summary.fail > 0 ? '🔴' : t.summary.warn > 0 ? '🟡' : '🟢';
        html += '<div style="margin: 0.5rem 0; padding: 0.5rem; background: #f9f9f9; border-radius: 4px;">';
        html += '<div style="font-weight: bold;">' + icon + ' ' + t.label + ' — ' + t.summary.pass + '/' + total + ' passed</div>';
        html += '<table style="width:100%; border-collapse: collapse; margin-top: 0.3rem; font-size: 12px;">';
        html += '<tr style="border-bottom: 1px solid #e0e0e0;"><th style="text-align:left; padding: 2px 4px;">Check</th><th style="text-align:left; padding: 2px 4px;">Result</th><th style="text-align:right; padding: 2px 4px;">Time</th></tr>';
        for (const r of t.results) {
          const statusIcon = r.status === 'pass' ? '✅' : r.status === 'warn' ? '⚠️' : '❌';
          html += '<tr><td style="padding: 2px 4px;">' + statusIcon + ' ' + r.label + '</td>';
          html += '<td style="padding: 2px 4px; color: ' + (r.status === 'fail' ? '#c0392b' : r.status === 'warn' ? '#e67e22' : '#27ae60') + ';">' + escapeHtmlDiag(r.detail) + '</td>';
          html += '<td style="padding: 2px 4px; text-align: right; color: #999;">' + r.duration_ms + 'ms</td></tr>';
        }
        html += '</table></div>';
      }

      container.innerHTML = html;
      container.style.color = '#333';
    }

    function escapeHtmlDiag(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
