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

          <button type="submit" class="button" id="upload-btn">Upload & Summarise</button>
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
  </div>

  <script>
    function switchTab(event, tabName) {
      event.preventDefault();
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
      document.getElementById(tabName).classList.add('active');
      event.target.classList.add('active');
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

    document.getElementById('dropzone').addEventListener('click', () => {
      document.getElementById('pdf-input').click();
    });

    document.getElementById('ec-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById('pdf-input');
      const status = document.getElementById('upload-status');
      const btn = document.getElementById('upload-btn');
      
      if (!fileInput.files.length) {
        status.className = 'upload-status show alert alert-error';
        status.textContent = '❌ Error: No file selected';
        return;
      }

      const files = Array.from(fileInput.files);
      btn.disabled = true;
      btn.textContent = 'Uploading...';
      
      const results = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const filename = file.name;
        
        try {
          status.className = 'upload-status show alert alert-info';
          status.textContent = `⏳ [${i+1}/${files.length}] Reading ${filename}...`;

          const arrayBuffer = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
          });

          const url = new URL('/admin/upload-ec-case', window.location.origin);
          url.searchParams.set('filename', filename);

          status.textContent = `⏳ [${i+1}/${files.length}] Uploading and summarising ${filename}...`;

          const response = await fetch(url.toString(), {
            method: 'POST',
            body: arrayBuffer,
            headers: { 'Content-Type': 'application/pdf' },
            credentials: 'same-origin'
          });

          if (!response.ok) {
            const error = await response.text();
            results.push(`❌ ${filename}: ${error}`);
          } else {
            results.push(`✅ ${filename}: Uploaded successfully`);
          }
        } catch (err) {
          results.push(`❌ ${filename}: ${err.message || err}`);
        }
      }

      btn.disabled = false;
      btn.textContent = 'Upload & Summarise';
      
      const succeeded = results.filter(r => r.startsWith('✅')).length;
      const failed = results.filter(r => r.startsWith('❌')).length;
      
      if (files.length === 1 && succeeded === 1) {
        // Single file success — show the nice message
        status.className = 'upload-status show alert alert-success';
        status.innerHTML = '<strong>✓ Case uploaded successfully!</strong><br>The case has been summarised and stored in the database.';
      } else {
        status.className = 'upload-status show alert ' + (failed === 0 ? 'alert-success' : 'alert-warning');
        status.innerHTML = '<strong>' + succeeded + '/' + files.length + ' cases processed</strong>' +
          (failed > 0 ? ' (' + failed + ' failed)' : '') +
          '<br><pre style="margin-top:8px;font-size:13px;white-space:pre-wrap;">' +
          results.join('\n') +
          '</pre>';
      }
      
      // Reset file input so user can re-upload
      fileInput.value = '';
      document.getElementById('file-name').textContent = 'None';
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
