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
      overflow-x: auto; overflow-y: hidden;
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
  <div style="display:flex;gap:16px;align-items:center;font-size:13px;">
  <a href="/" style="color:#666;text-decoration:none;">Front Page</a>
  <a href="/awards" style="color:#666;text-decoration:none;">Awards</a>
  <form method="GET" action="/admin/logout" class="logout-form" style="margin:0;">
  <button type="submit" class="logout-btn">Logout</button>
  </form>
  </div>
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
      <button class="tab-btn" type="button" onclick="switchTab(event, 'diagnostics')">🔧 Diagnostics & Errors</button>
    </div>

    <!-- Digest Controls Tab -->
    <div id="digest" class="tab-content active">
      <!-- ⏰ Cron Schedule -->
      <div class="card">
        <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;">
          <span>⏰ Cron Schedule</span>
          <span id="cron-badge" class="button" style="font-size:11px;padding:4px 12px;background:${status.is_paused ? '#ff7f50' : '#4f6f52'};cursor:default;">${status.is_paused ? 'Paused' : 'Active'}</span>
        </div>
        <div class="pause-state ${status.is_paused ? 'paused' : 'running'}">
          <div>
            <strong>${status.is_paused ? '🟡 System Paused' : '🟢 System Running'}</strong><br>
            <small>${status.is_paused ? 'Cron digest is paused — no emails sent' : 'Daily at 8:00 AM NZT (next: ~' + new Date(Date.now() + 86400000).toLocaleDateString() + ' 8:00 AM NZT)'}</small>
          </div>
          <form method="POST" action="/admin/set-pause" style="display:inline;margin:0;" id="pause-form">
            <input type="hidden" name="paused" value="${status.is_paused ? '0' : '1'}">
            <button type="submit" class="button ${status.is_paused ? 'secondary' : ''}" style="padding:8px 16px;">${status.is_paused ? '▶ Resume' : '⏸ Pause'}</button>
          </form>
        </div>
      </div>

      <!-- 📬 Digest State & Range -->
      <div class="card">
        <div class="card-title">📬 Digest State & Range</div>
        <div style="display:flex;gap:10px;margin-bottom:16px;">
          <div style="flex:1;background:white;border:1px solid #e0e0e0;border-radius:6px;padding:12px;">
            <div style="font-size:11px;color:#888;">Latest Case Sent</div>
            <div style="font-size:13px;font-weight:600;color:#333;margin-top:4px;" id="latest-sent-case">Loading...</div>
            <div style="font-size:11px;color:#888;margin-top:2px;" id="latest-sent-id">—</div>
          </div>
          <div style="flex:1;background:white;border:1px solid #e0e0e0;border-radius:6px;padding:12px;">
            <div style="font-size:11px;color:#888;">Latest Case Available</div>
            <div style="font-size:13px;font-weight:600;color:#333;margin-top:4px;" id="latest-avail-case">Loading...</div>
            <div style="font-size:11px;color:#888;margin-top:2px;" id="latest-avail-id">—</div>
          </div>
        </div>
        <p style="font-size:12px;color:#666;margin-bottom:12px;">Controls which cases the next email includes. Override applies to the <strong>next single run only</strong>, then resets.</p>
        <div style="display:flex;gap:12px;align-items:flex-end;">
          <div style="flex:1;">
            <label style="display:block;font-size:12px;font-weight:500;color:#555;margin-bottom:4px;">Include from ERA ID</label>
            <input type="number" id="digest-range-start" style="width:100%;padding:10px 12px;border:1px solid #ccc;border-radius:6px;font-size:14px;">
          </div>
          <div style="flex:1;">
            <label style="display:block;font-size:12px;font-weight:500;color:#555;margin-bottom:4px;">Max cases</label>
            <input type="number" id="digest-range-max" value="10" min="1" max="50" style="width:100%;padding:10px 12px;border:1px solid #ccc;border-radius:6px;font-size:14px;">
          </div>
          <button class="button" onclick="saveDigestRange()" id="range-btn" style="white-space:nowrap;">Apply Range</button>
        </div>
        <div id="range-status" style="font-size:12px;color:#888;margin-top:8px;"></div>
      </div>

      <!-- 👁️ Preview Next Email -->
      <div class="card">
        <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;">
          <span>👁️ Preview — Cases for Next Email</span>
          <span>
            <button class="button" style="padding:6px 14px;font-size:12px;margin-right:6px;" onclick="loadDigestPreview()">Refresh</button>
            <button class="button secondary" style="padding:6px 14px;font-size:12px;" onclick="sendDigestNow()" id="send-now-btn">Send Now</button>
          </span>
        </div>
        <div id="digest-preview-list">
          <p style="color:#999;">Click "Refresh" to load preview.</p>
        </div>
        <p style="font-size:12px;color:#999;margin-top:10px;" id="preview-meta"></p>
        <div id="digest-send-status" class="upload-status" style="margin-top:8px;"></div>
      </div>

      <!-- ✏️ Email Templates -->
      <div class="card">
        <div class="card-title">✏️ Email Templates</div>
        <p style="font-size:12px;color:#666;margin-bottom:14px;">
          Template variables:
          <code style="background:#e8f0e8;padding:2px 6px;border-radius:3px;">{num_cases}</code> — number of cases
          <code style="background:#e8f0e8;padding:2px 6px;border-radius:3px;">{date}</code> — today's date
          <code style="background:#e8f0e8;padding:2px 6px;border-radius:3px;">{id_first}</code> — first case ID
          <code style="background:#e8f0e8;padding:2px 6px;border-radius:3px;">{id_last}</code> — last case ID
        </p>
        <div style="margin-bottom:14px;">
          <label style="display:block;font-size:12px;font-weight:500;color:#555;margin-bottom:4px;">Email Subject Line</label>
          <input type="text" id="email-subject" value="ERA Digest — {num_cases} new cases ({date})" style="width:100%;padding:10px 12px;border:1px solid #ccc;border-radius:6px;font-size:14px;">
        </div>
        <div style="display:flex;gap:12px;margin-bottom:14px;">
          <div style="flex:1;">
            <label style="display:block;font-size:12px;font-weight:500;color:#555;margin-bottom:4px;">Default Banner <span style="font-weight:400;color:#888;">(every digest)</span></label>
            <textarea id="email-banner-default" style="width:100%;min-height:60px;padding:10px 12px;border:1px solid #ccc;border-radius:6px;font-size:13px;font-family:inherit;resize:vertical;" placeholder="Optional — shown at top of every email"></textarea>
          </div>
          <div style="flex:1;">
            <label style="display:block;font-size:12px;font-weight:500;color:#555;margin-bottom:4px;">One-off Banner <span style="font-weight:400;color:#ff7f50;">next run only</span></label>
            <textarea id="email-banner-onetime" style="width:100%;min-height:60px;padding:10px 12px;border:1px solid #ff7f50;border-radius:6px;font-size:13px;font-family:inherit;resize:vertical;" placeholder="Leave blank to use default"></textarea>
          </div>
        </div>
        <div style="display:flex;gap:12px;margin-bottom:16px;">
          <div style="flex:1;">
            <label style="display:block;font-size:12px;font-weight:500;color:#555;margin-bottom:4px;">Default Footer</label>
            <textarea id="email-footer-default" style="width:100%;min-height:50px;padding:10px 12px;border:1px solid #ccc;border-radius:6px;font-size:13px;font-family:inherit;resize:vertical;">You received this because you subscribed at whenroutinebiteshard.com. Unsubscribe or manage preferences.</textarea>
          </div>
          <div style="flex:1;">
            <label style="display:block;font-size:12px;font-weight:500;color:#555;margin-bottom:4px;">One-off Footer <span style="font-weight:400;color:#ff7f50;">next run only</span></label>
            <textarea id="email-footer-onetime" style="width:100%;min-height:50px;padding:10px 12px;border:1px solid #ff7f50;border-radius:6px;font-size:13px;font-family:inherit;resize:vertical;" placeholder="Leave blank to use default"></textarea>
          </div>
        </div>
        <div style="display:flex;gap:10px;">
          <button class="button" onclick="saveEmailTemplates()">Save Templates</button>
          <button class="button secondary" onclick="resetEmailTemplates()">Reset to Defaults</button>
        </div>
        <div id="templates-status" class="upload-status" style="margin-top:8px;"></div>
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
        <div class="card-title">Rescan Cases by ERA ID</div>
        <p style="color: #666; margin-bottom: 1.5rem;">Delete and re-summarise specific cases by their ERA website ID (the number after /view/ in the URL).</p>
        <div>
          <div class="form-group">
            <label for="rescan-ids">ERA ID(s)</label>
            <textarea id="rescan-ids" style="width:100%;min-height:80px;padding:10px;border:1px solid #ccc;border-radius:6px;font-size:13px;font-family:monospace;" placeholder="e.g. 21324, 21325, 21326&#10;One ID per line, or comma-separated"></textarea>
            <small>Enter one or more ERA determination IDs. Existing summaries will be deleted and regenerated.</small>
          </div>
          <button type="button" class="button" onclick="rescanByIds()">Rescan ID(s)</button>
          <div id="rescan-ids-status" style="margin-top:12px;font-size:13px;"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Rescan Recent Cases</div>
        <p style="color: #666; margin-bottom: 1.5rem;">Re-process previously stored cases with updated LLM prompts.</p>
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
        <div class="card-title">🔧 System Diagnostics</div>
        <p style="color: #666; margin-bottom: 1.5rem;">
          Click a test button below. Results appear inline beneath each test.
          Use <strong>▶ Run All Tests</strong> to run the full suite.
          The error log at the bottom shows recent pipeline errors — click <strong>Refresh</strong> to load.
        </p>

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

      <!-- Error Log (inline within Diagnostics) -->
      <div class="card">
        <div class="card-title" style="display: flex; justify-content: space-between; align-items: center;">
          <span>📋 Error Log</span>
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
            <div class="stat-label">Latest Case (highest ID)</div>
            <div class="stat-value" id="stat-latest-case" style="font-size:12px; line-height:1.3;">—</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Oldest Case (lowest ID)</div>
            <div class="stat-value" id="stat-oldest-case" style="font-size:12px; line-height:1.3;">—</div>
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
  </div>

  <script>
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function switchTab(event, tabName) {
      event.preventDefault();
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
      const tab = document.getElementById(tabName);
      if (tab) tab.classList.add('active');
      event.target.classList.add('active');
      // Auto-load content when specific tabs are opened
      if (tabName === 'diagnostics') { loadErrors(); }
      if (tabName === 'scraper') loadScraperStats();
      if (tabName === 'digest') { loadDigestConfig(); loadDigestPreview(); }
      if (tabName === 'prompts') loadPrompts();
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

    // ═══ Digest Tab JS ═══════════════════════════════════════════════════════

    async function loadDigestConfig() {
      try {
        const resp = await fetch('/admin/dashboard/digest-config', { credentials: 'same-origin' });
        if (!resp.ok) return;
        const d = await resp.json();
        if (d.email_subject) document.getElementById('email-subject').value = d.email_subject;
        if (d.email_banner_default) document.getElementById('email-banner-default').value = d.email_banner_default;
        if (d.email_banner_onetime) document.getElementById('email-banner-onetime').value = d.email_banner_onetime;
        if (d.email_footer_default) document.getElementById('email-footer-default').value = d.email_footer_default;
        if (d.email_footer_onetime) document.getElementById('email-footer-onetime').value = d.email_footer_onetime;
        if (d.digest_range_start) document.getElementById('digest-range-start').value = d.digest_range_start;
        if (d.digest_range_max) document.getElementById('digest-range-max').value = d.digest_range_max;

        const sentEl = document.getElementById('latest-sent-case');
        const sentIdEl = document.getElementById('latest-sent-id');
        if (d.last_sent) {
          sentEl.textContent = d.last_sent.title?.substring(0, 55) || '—';
          sentIdEl.textContent = 'Processed: ' + (d.last_sent.processed_at ? new Date(d.last_sent.processed_at).toLocaleString() : '—');
        } else {
          sentEl.textContent = 'No cases sent yet';
        }

        const availEl = document.getElementById('latest-avail-case');
        const availIdEl = document.getElementById('latest-avail-id');
        if (d.latest_avail) {
          availEl.textContent = d.latest_avail.title?.substring(0, 55) || '—';
          availIdEl.textContent = 'ERA ID: ' + (d.latest_avail.era_id || '—');
        } else {
          availEl.textContent = 'No cases available';
        }
      } catch {}
    }

    async function loadDigestPreview() {
      const list = document.getElementById('digest-preview-list');
      const meta = document.getElementById('preview-meta');
      list.innerHTML = '<p style="color:#999;">Loading...</p>';
      try {
        const rangeStart = document.getElementById('digest-range-start').value;
        const params = new URLSearchParams();
        if (rangeStart) params.set('start_id', rangeStart);
        params.set('limit', '10');
        const resp = await fetch('/admin/seen-cases?' + params.toString(), { credentials: 'same-origin' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        const cases = data.cases || [];
        if (cases.length === 0) {
          list.innerHTML = '<p style="color:#999;">No cases found.</p>';
          meta.textContent = '';
          return;
        }
        let html = '';
        let unseenCount = 0;
        for (const c of cases.slice(0, 10)) {
          // Extract ERA ID from case_url
          const urlParts = (c.case_url || '').split('/');
          const lastSeg = urlParts[urlParts.length - 1];
          const eraId = /^\d+$/.test(lastSeg) ? lastSeg : (c.case_id || '—');
          html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:white;border:1px solid #e0e0e0;border-radius:4px;margin-bottom:6px;">';
          html += '<span style="font-size:13px;flex:1;">' + esc(c.title || '—') + '</span>';
          html += '<span style="font-size:11px;color:#888;margin-left:8px;white-space:nowrap;">ID ' + eraId + '</span>';
          html += '</div>';
          unseenCount++;
        }
        list.innerHTML = html;
        meta.textContent = 'Showing ' + Math.min(cases.length, 10) + ' cases from seen_cases (most recent first). Total seen: ' + data.count;
      } catch (err) {
        list.innerHTML = '<div class="alert alert-error" style="font-size:13px;">❌ ' + esc(err.message) + '</div>';
      }
    }

    async function saveDigestRange() {
      const startId = document.getElementById('digest-range-start').value;
      const maxCases = document.getElementById('digest-range-max').value;
      const btn = document.getElementById('range-btn');
      const status = document.getElementById('range-status');
      btn.disabled = true; btn.textContent = 'Saving...';
      try {
        const body = {};
        if (startId) body.start_id = parseInt(startId, 10);
        body.max_cases = parseInt(maxCases, 10) || 10;
        const resp = await fetch('/admin/dashboard/set-digest-range', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await resp.json();
        status.textContent = d.success ? '✅ ' + d.message : '❌ ' + (d.error || 'Error');
        status.style.color = d.success ? '#060' : '#c00';
      } catch (err) {
        status.textContent = '❌ ' + err.message;
        status.style.color = '#c00';
      }
      btn.disabled = false; btn.textContent = 'Apply Range';
    }

    async function saveEmailTemplates() {
      const btn = event?.target || document.querySelector('[onclick="saveEmailTemplates()"]');
      const status = document.getElementById('templates-status');
      status.className = 'upload-status show alert alert-info';
      status.textContent = 'Saving...';
      try {
        const body = {
          subject: document.getElementById('email-subject').value,
          banner_default: document.getElementById('email-banner-default').value,
          banner_onetime: document.getElementById('email-banner-onetime').value,
          footer_default: document.getElementById('email-footer-default').value,
          footer_onetime: document.getElementById('email-footer-onetime').value,
        };
        const resp = await fetch('/admin/dashboard/save-email-template', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await resp.json();
        status.className = 'upload-status show alert ' + (d.success ? 'alert-success' : 'alert-error');
        status.textContent = d.success ? '✅ Templates saved' : '❌ ' + (d.error || 'Error');
      } catch (err) {
        status.className = 'upload-status show alert alert-error';
        status.textContent = '❌ ' + err.message;
      }
    }

    async function resetEmailTemplates() {
      if (!confirm('Reset all email templates to default values?')) return;
      const status = document.getElementById('templates-status');
      document.getElementById('email-subject').value = 'ERA Digest — {num_cases} new cases ({date})';
      document.getElementById('email-banner-default').value = '';
      document.getElementById('email-banner-onetime').value = '';
      document.getElementById('email-footer-default').value = 'You received this because you subscribed at whenroutinebiteshard.com. Unsubscribe or manage preferences.';
      document.getElementById('email-footer-onetime').value = '';
      // Save the reset values
      await saveEmailTemplates();
    }

    async function sendDigestNow() {
      if (!confirm('Send digest email now to all active subscribers?')) return;
      const btn = document.getElementById('send-now-btn');
      const status = document.getElementById('digest-send-status');
      btn.disabled = true; btn.textContent = 'Sending...';
      status.className = 'upload-status show alert alert-info';
      status.textContent = 'Sending digest...';
      try {
        const resp = await fetch('/admin/send-digest?limit=10&preview=false', {
          method: 'POST', credentials: 'same-origin',
        });
        const d = await resp.json();
        status.className = 'upload-status show alert ' + (d.success ? 'alert-success' : 'alert-error');
        status.textContent = d.success ? '✅ Sent to ' + (d.sent || 0) + ' subscriber(s)' : '❌ ' + (d.error || 'Send failed');
      } catch (err) {
        status.className = 'upload-status show alert alert-error';
        status.textContent = '❌ ' + err.message;
      }
      btn.disabled = false; btn.textContent = 'Send Now';
    }

    // ═══ End Digest Tab JS ═══════════════════════════════════════════════════

    // Auto-load scraper stats when the scraper tab is shown
    async function loadScraperStats() {
      const lastIdEl = document.getElementById('stat-last-id');
      const caseEl = document.getElementById('stat-latest-case');
      const totalEl = document.getElementById('stat-total-cases');
      const oldestEl = document.getElementById('stat-oldest-case');
      try {
        const resp = await fetch('/admin/dashboard/scraper-stats', { credentials: 'same-origin' });
        if (resp.ok) {
          const d = await resp.json();
          if (lastIdEl) lastIdEl.textContent = d.last_era_id ?? '—';
          if (caseEl) caseEl.textContent = d.latest
            ? (d.latest.title?.substring(0, 55) || '—') + ' · ID ' + (d.latest.era_id || d.latest.pdf_filename?.replace('.pdf','') || '—')
            : '—';
          if (oldestEl) oldestEl.textContent = d.oldest
            ? (d.oldest.title?.substring(0, 55) || '—') + ' · ID ' + (d.oldest.era_id || d.oldest.pdf_filename?.replace('.pdf','') || '—')
            : '—';
          if (totalEl) totalEl.textContent = d.total_cases ?? '—';
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
        const resp = await fetch('/admin/dashboard/scrape-id-range?start_id=' + start + '&end_id=' + end, { method: 'POST', credentials: 'same-origin' });
        if (resp.status === 401) {
          status.className = 'upload-status show alert alert-error';
          status.innerHTML = '🔑 Session expired. <a href="/admin" style="color:#c00;">Please log in again</a>.';
          btn.disabled = false; btn.textContent = 'Scrape'; return;
        }
        const data = await resp.json();
        if (data.success) {
          const parts = [];
          if (data.processed > 0) parts.push('✅ Processed ' + data.processed + ' case(s)');
          if (data.failed > 0) parts.push('❌ ' + data.failed + ' failed');
          if (data.found > 0 && data.processed === 0) parts.push('📡 Found ' + data.new + ' new case(s) — at processing limit');
          if (data.found > 0 && data.cases) {
            parts.push('<div style="font-size:12px;margin-top:8px;max-height:200px;overflow-y:auto;">');
            for (const c of data.cases) {
              parts.push('<div style="padding:4px 0;border-bottom:1px solid #eee;">' + esc(c.title || c.era_id) + ' <span style="color:#888;">(ID ' + c.era_id + ')</span></div>');
            }
            parts.push('</div>');
          }
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
        const resp = await fetch(url, { method: 'POST', credentials: 'same-origin' });
        if (resp.status === 401) {
          status.className = 'upload-status show alert alert-error';
          status.innerHTML = '🔑 Session expired. <a href="/admin" style="color:#c00;">Please log in again</a>.';
          btn.disabled = false; btn.textContent = 'Scrape'; return;
        }
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
        if (resp.status === 401) {
          status.className = 'upload-status show alert alert-error';
          status.innerHTML = '🔑 Session expired. <a href="/admin" style="color:#c00;">Please log in again</a>.';
          btn.disabled = false; btn.textContent = 'Summarise'; return;
        }
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

    // Handle rescan by specific ERA IDs
    async function rescanByIds() {
      const input = document.getElementById('rescan-ids');
      const status = document.getElementById('rescan-ids-status');
      if (!input || !status) return;
      // Parse IDs: comma or newline separated, trimmed, non-empty, numeric
      const raw = input.value.trim();
      const ids = raw.split(',').map(s => s.trim()).filter(s => s && !isNaN(parseInt(s, 10)) && parseInt(s, 10) > 0);
      if (ids.length === 0) { status.innerHTML = '❌ No valid numeric ERA IDs found.'; return; }
      if (ids.length > 20) { status.innerHTML = '❌ Maximum 20 IDs at a time.'; return; }
      status.innerHTML = '⏳ Deleting ' + ids.length + ' case(s) and triggering reprocess...';
      try {
        const resp = await fetch('/admin/dashboard/rescan-by-ids?ids=' + ids.join(','), {
          method: 'POST', credentials: 'same-origin',
        });
        const d = await resp.json();
        if (d.success) {
          status.innerHTML = '✅ ' + d.message;
          input.value = '';
        } else {
          status.innerHTML = '❌ ' + (d.error || 'Rescan failed');
        }
      } catch (err) {
        status.innerHTML = '❌ ' + err.message;
      }
    }

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
      resultEl.innerHTML = '<p style="color:#999;">Running test...</p>';
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

      // Show pass/fail badge on button
      const passed = data.summary?.fail === 0;
      btn.textContent = (passed ? '✅ ' : '❌ ') + originalText;
      btn.style.background = passed ? '#4f6f52' : '#c0392b';
      btn.disabled = false;
      setTimeout(() => { btn.textContent = originalText; btn.style.background = ''; }, 4000);
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
