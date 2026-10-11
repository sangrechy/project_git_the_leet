/**
 * Popup Controller for LeetCode Backup Extension
 *
 * Handles tab switching, queue rendering and filtering, retry triggers,
 * settings management, connectivity diagnostics, and the multi-step
 * historical backfill workflow.
 */

(function () {
  'use strict';

  // Instantiate component classes
  const settingsManager = new SettingsManager();
  const localQueue = new LocalQueue();
  const submissionReader = new SubmissionReader();

  // State
  let currentFilter = 'all';
  let isBackfillRunning = false;
  let backfillPaused = false;
  let scannedSubmissionsToBackfill = [];

  // DOM Elements
  const tabs = document.querySelectorAll('.tab-btn');
  const panes = document.querySelectorAll('.tab-pane');
  const queueBadge = document.getElementById('tab-queue-badge');

  const btnToggleSync = document.getElementById('btn-toggle-sync');
  const syncIndicator = document.getElementById('sync-indicator');
  const syncStatusText = document.getElementById('sync-status-text');

  const statSynced = document.getElementById('stat-synced-count');
  const statPending = document.getElementById('stat-pending-count');
  const statFailed = document.getElementById('stat-failed-count');

  const filterChips = document.querySelectorAll('.chip-btn');
  const queueList = document.getElementById('queue-list');
  const btnRetryAll = document.getElementById('btn-retry-all');
  const btnSyncNow = document.getElementById('btn-sync-now');

  // Backfill Elements
  const btnScanBackfill = document.getElementById('btn-scan-backfill');
  const scanSummaryWrap = document.getElementById('backfill-scan-summary');
  const backfillFoundCount = document.getElementById('backfill-found-count');
  const backfillSyncedCount = document.getElementById('backfill-synced-count');
  const backfillNeededCount = document.getElementById('backfill-needed-count');
  const btnStartBackfill = document.getElementById('btn-start-backfill');
  const btnPauseBackfill = document.getElementById('btn-pause-backfill');
  const backfillProgressWrap = document.getElementById('backfill-progress-wrap');
  const backfillProgressBar = document.getElementById('backfill-progress-bar');
  const backfillProgressStatus = document.getElementById('backfill-progress-status');
  const backfillProgressPct = document.getElementById('backfill-progress-pct');

  // Settings Elements
  const formSettings = document.getElementById('form-settings');
  const settingToken = document.getElementById('setting-token');
  const settingOwner = document.getElementById('setting-owner');
  const settingRepo = document.getElementById('setting-repo');
  const settingBranch = document.getElementById('setting-branch');
  const settingContests = document.getElementById('setting-contests');
  const cardToggleContests = document.getElementById('card-toggle-contests');
  const switchContests = document.getElementById('switch-contests');
  const btnToggleToken = document.getElementById('btn-toggle-token');
  const btnTestConnection = document.getElementById('btn-test-connection');
  const settingsAlert = document.getElementById('settings-alert');

  // ==========================================
  // Tab Switching
  // ==========================================
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');

      tabs.forEach(t => t.classList.remove('active'));
      panes.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetPane = document.getElementById(`pane-${targetTab}`);
      if (targetPane) targetPane.classList.add('active');

      if (targetTab === 'queue') {
        refreshQueueView();
      }
    });
  });

  // ==========================================
  // Sync Pause / Active Toggle
  // ==========================================
  async function updateSyncStatusUI() {
    const isPaused = await localQueue.isSyncPaused();
    if (isPaused) {
      btnToggleSync.classList.add('is-paused');
      syncIndicator.style.color = '#f59e0b';
      syncStatusText.textContent = 'Paused';
      btnToggleSync.title = 'Syncing is paused. Click to resume automatic sync.';
    } else {
      btnToggleSync.classList.remove('is-paused');
      syncIndicator.style.color = '#10b981';
      syncStatusText.textContent = 'Active';
      btnToggleSync.title = 'Syncing is active. Click to pause automatic sync.';
    }
  }

  btnToggleSync.addEventListener('click', async () => {
    const isPaused = await localQueue.isSyncPaused();
    await localQueue.setSyncPaused(!isPaused);
    await updateSyncStatusUI();

    if (isPaused) {
      // User just unpaused: trigger sync
      triggerQueueProcessing();
    }
  });

  // ==========================================
  // Queue Rendering & Management
  // ==========================================
  async function refreshQueueView() {
    const [counts, queue] = await Promise.all([
      localQueue.getCounts(),
      localQueue.getQueue()
    ]);

    // Update stats counters
    statSynced.textContent = counts.synced;
    statPending.textContent = counts.pending;
    statFailed.textContent = counts.failed;

    // Update tab badge
    const activeCount = counts.pending + counts.failed;
    if (activeCount > 0) {
      queueBadge.style.display = 'inline-block';
      queueBadge.textContent = activeCount;
      if (counts.failed > 0) {
        queueBadge.className = 'tab-badge badge-red';
      } else {
        queueBadge.className = 'tab-badge badge-amber';
      }
    } else {
      queueBadge.style.display = 'none';
    }

    // Toggle "Retry All" visibility
    btnRetryAll.style.display = counts.failed > 0 ? 'inline-flex' : 'none';

    // Filter queue
    let filtered = queue;
    if (currentFilter !== 'all') {
      filtered = queue.filter(item => item.status === currentFilter);
    }

    if (filtered.length === 0) {
      let emptyMsg = 'No submissions in queue yet.';
      if (currentFilter === 'pending') emptyMsg = 'No pending submissions.';
      else if (currentFilter === 'failed') emptyMsg = 'No failed submissions.';
      else if (currentFilter === 'synced') emptyMsg = 'No synced submissions yet.';

      queueList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📦</div>
          <div>${emptyMsg}</div>
          <div style="font-size: 11px; margin-top: 4px;">Solve practice problems on LeetCode to auto-backup!</div>
        </div>
      `;
      return;
    }

    queueList.innerHTML = '';
    for (const item of filtered) {
      const el = document.createElement('div');
      el.className = `queue-item status-${item.status}`;

      const dateStr = item.addedAt ? formatRelativeTime(item.addedAt) : 'Recently';
      const statusLabel = item.status === 'synced' ? 'Synced' :
        item.status === 'pending' ? 'Pending' :
        item.status === 'syncing' ? 'Syncing...' : 'Failed';

      const tagClass = `tag-${item.status}`;
      const frontendId = item.frontendId || item.problemId || '?';
      const title = item.problemTitle || 'LeetCode Problem';
      const lang = item.language || 'code';

      let errorHtml = '';
      if (item.status === 'failed') {
        errorHtml = `
          <div class="queue-error-banner">
            <span>${escapeHtml(item.lastError || 'Upload failed')}</span>
            <button class="btn-retry-item" data-id="${item.submissionId}">Retry</button>
          </div>
        `;
      }

      el.innerHTML = `
        <div class="queue-item-header">
          <div class="queue-title" title="${escapeHtml(title)}">
            #${frontendId} ${escapeHtml(title)}
          </div>
          <span class="queue-status-tag ${tagClass}">${statusLabel}</span>
        </div>
        <div class="queue-item-meta">
          <span class="lang">${escapeHtml(lang)}</span>
          <span>#${item.submissionId}</span>
          ${item.runtime ? `<span>${escapeHtml(item.runtime)}</span>` : ''}
          <span style="margin-left: auto;">${dateStr}</span>
        </div>
        ${errorHtml}
      `;

      queueList.appendChild(el);
    }

    // Attach individual retry handlers
    queueList.querySelectorAll('.btn-retry-item').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.getAttribute('data-id');
        await localQueue.markForRetry(id);
        await refreshQueueView();
        triggerQueueProcessing();
      });
    });
  }

  // Filter chips click handler
  filterChips.forEach(chip => {
    chip.addEventListener('click', () => {
      filterChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentFilter = chip.getAttribute('data-filter');
      refreshQueueView();
    });
  });

  // Retry all failed
  btnRetryAll.addEventListener('click', async () => {
    btnRetryAll.disabled = true;
    await localQueue.retryAllFailed();
    await refreshQueueView();
    await triggerQueueProcessing();
    btnRetryAll.disabled = false;
  });

  // Sync now button
  btnSyncNow.addEventListener('click', async () => {
    btnSyncNow.disabled = true;
    btnSyncNow.textContent = 'Syncing...';
    try {
      await triggerQueueProcessing();
    } finally {
      btnSyncNow.disabled = false;
      btnSyncNow.textContent = 'Sync Now';
    }
  });

  async function triggerQueueProcessing() {
    const settings = await settingsManager.getSettings();
    if (!settings.githubToken || !settings.repoOwner || !settings.repoName) {
      return;
    }

    try {
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'PROCESS_QUEUE' }, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(res);
        });
      });
    } catch (e) {
      // Fallback: run directly in popup if background message fails
      const uploader = new GitHubUploader({
        token: settings.githubToken,
        owner: settings.repoOwner,
        repo: settings.repoName,
        branch: settings.branch || 'main'
      });
      await uploader.processQueue(localQueue);
    }
    await refreshQueueView();
  }

  // ==========================================
  // Historical Backfill Workflow
  // ==========================================
  btnScanBackfill.addEventListener('click', async () => {
    btnScanBackfill.disabled = true;
    btnScanBackfill.textContent = '⏳ Scanning LeetCode History...';

    try {
      let offset = 0;
      const limit = 20;
      let hasMore = true;
      let allFound = [];
      let pages = 0;
      const MAX_PAGES = 10; // Scan up to 200 submissions in preview scan

      while (hasMore && pages < MAX_PAGES) {
        const res = await submissionReader.fetchSubmissionHistory(offset, limit);
        if (!res.submissions || res.submissions.length === 0) break;

        const acceptedOnly = res.submissions.filter(s => s.statusDisplay === 'Accepted');
        allFound = allFound.concat(acceptedOnly);

        hasMore = res.hasMore;
        offset += limit;
        pages++;
        if (!hasMore) break;
      }

      // Deduplicate found by ID
      const uniqueFoundMap = new Map();
      allFound.forEach(s => {
        if (s.id && !uniqueFoundMap.has(String(s.id))) {
          uniqueFoundMap.set(String(s.id), s);
        }
      });
      const uniqueFound = Array.from(uniqueFoundMap.values());

      // Compare with synced IDs and queue
      const syncedIds = await localQueue.getSyncedIds();
      const existingQueue = await localQueue.getQueue();
      const existingQueueIds = new Set(existingQueue.map(q => String(q.submissionId)));

      const unbacked = uniqueFound.filter(s => {
        const strId = String(s.id);
        return !syncedIds.includes(strId) && !existingQueueIds.has(strId);
      });

      scannedSubmissionsToBackfill = unbacked;

      // Update UI
      scanSummaryWrap.style.display = 'block';
      backfillFoundCount.textContent = uniqueFound.length;
      backfillSyncedCount.textContent = uniqueFound.length - unbacked.length;
      backfillNeededCount.textContent = unbacked.length;

      if (unbacked.length > 0) {
        btnStartBackfill.style.display = 'block';
        btnStartBackfill.textContent = `🚀 Backfill ${unbacked.length} Submissions`;
      } else {
        btnStartBackfill.style.display = 'none';
        btnScanBackfill.textContent = '✓ All Found Submissions Backed Up';
      }
    } catch (err) {
      alert(`Failed to scan submissions: ${err.message}`);
    } finally {
      btnScanBackfill.disabled = false;
      if (btnScanBackfill.textContent.startsWith('⏳')) {
        btnScanBackfill.textContent = '🔍 Scan Accepted Submissions';
      }
    }
  });

  btnStartBackfill.addEventListener('click', async () => {
    const settings = await settingsManager.getSettings();
    const validation = settingsManager.validate(settings);
    if (!validation.valid) {
      alert(`Cannot start backfill: ${validation.errors.join(' ')}\nPlease configure settings first.`);
      return;
    }

    if (scannedSubmissionsToBackfill.length === 0) return;

    isBackfillRunning = true;
    backfillPaused = false;
    btnStartBackfill.style.display = 'none';
    btnPauseBackfill.style.display = 'block';
    backfillProgressWrap.style.display = 'block';

    const uploader = new GitHubUploader({
      token: settings.githubToken,
      owner: settings.repoOwner,
      repo: settings.repoName,
      branch: settings.branch || 'main'
    });

    const total = scannedSubmissionsToBackfill.length;
    let completed = 0;

    await localQueue.setBackfillState({
      inProgress: true,
      totalFound: total,
      processedCount: 0,
      isPaused: false
    });

    for (const sub of scannedSubmissionsToBackfill) {
      if (!isBackfillRunning || backfillPaused) {
        break;
      }

      backfillProgressStatus.textContent = `Processing #${sub.id} (${sub.title || 'Solution'})...`;
      const pct = Math.round((completed / total) * 100);
      backfillProgressBar.style.width = `${pct}%`;
      backfillProgressPct.textContent = `${pct}% (${completed}/${total})`;

      try {
        // Fetch full submission details
        const details = await submissionReader.getSubmissionDetails(sub.id, {
          title: sub.title,
          problemSlug: sub.titleSlug,
          lang: sub.lang
        });

        // Enqueue item
        const queuedItem = await localQueue.enqueue(details);

        // Upload to GitHub
        await localQueue.updateStatus(queuedItem.submissionId, 'syncing');
        await uploader.uploadSubmission(queuedItem);
        await localQueue.updateStatus(queuedItem.submissionId, 'synced');

        completed++;
      } catch (err) {
        console.error(`Backfill failed for submission #${sub.id}:`, err);
        await localQueue.updateStatus(sub.id, 'failed', { error: err.message });
      }

      // Update state for resumption
      await localQueue.setBackfillState({
        processedCount: completed
      });

      // Pacing delay (750ms) to respect GitHub & LeetCode limits
      await new Promise(r => setTimeout(r, 750));
    }

    isBackfillRunning = false;
    btnPauseBackfill.style.display = 'none';

    if (completed === total) {
      backfillProgressBar.style.width = '100%';
      backfillProgressPct.textContent = `100% (${total}/${total})`;
      backfillProgressStatus.textContent = `✓ Backfill complete! Processed ${total} submissions.`;
      await localQueue.resetBackfillState();
      scannedSubmissionsToBackfill = [];
    } else if (backfillPaused) {
      backfillProgressStatus.textContent = `Paused at ${completed}/${total} submissions.`;
      btnStartBackfill.style.display = 'block';
      btnStartBackfill.textContent = '▶ Resume Backfill';
    }

    refreshQueueView();
  });

  btnPauseBackfill.addEventListener('click', () => {
    backfillPaused = true;
    isBackfillRunning = false;
    btnPauseBackfill.style.display = 'none';
    btnStartBackfill.style.display = 'block';
    btnStartBackfill.textContent = '▶ Resume Backfill';
    backfillProgressStatus.textContent = 'Pausing backfill...';
  });

  // ==========================================
  // Settings View & Connectivity Testing
  // ==========================================
  async function loadSettingsIntoForm() {
    const settings = await settingsManager.getSettings();
    settingToken.value = settings.githubToken || '';
    settingOwner.value = settings.repoOwner || '';
    settingRepo.value = settings.repoName || '';
    settingBranch.value = settings.branch || 'main';
    settingContests.checked = Boolean(settings.syncContests);
    if (switchContests) {
      switchContests.classList.toggle('checked', settingContests.checked);
    }
  }

  if (cardToggleContests && switchContests) {
    cardToggleContests.addEventListener('click', () => {
      settingContests.checked = !settingContests.checked;
      switchContests.classList.toggle('checked', settingContests.checked);
    });
  }

  btnToggleToken.addEventListener('click', () => {
    if (settingToken.type === 'password') {
      settingToken.type = 'text';
      btnToggleToken.textContent = 'Hide';
    } else {
      settingToken.type = 'password';
      btnToggleToken.textContent = 'Show';
    }
  });

  function showSettingsAlert(type, message) {
    settingsAlert.className = `alert alert-${type}`;
    settingsAlert.textContent = message;
    settingsAlert.style.display = 'flex';
  }

  btnTestConnection.addEventListener('click', async () => {
    settingsAlert.style.display = 'none';
    btnTestConnection.disabled = true;
    btnTestConnection.textContent = '⏳ Testing Connection...';

    const testConfig = {
      githubToken: settingToken.value,
      repoOwner: settingOwner.value,
      repoName: settingRepo.value,
      branch: settingBranch.value || 'main',
      syncContests: settingContests.checked
    };

    const res = await settingsManager.testConnection(testConfig);
    btnTestConnection.disabled = false;
    btnTestConnection.textContent = '🔌 Test GitHub Connection';

    if (res.ok) {
      showSettingsAlert('success', `✓ ${res.message}`);
    } else {
      showSettingsAlert('error', `✕ ${res.message}`);
    }
  });

  formSettings.addEventListener('submit', async (e) => {
    e.preventDefault();
    settingsAlert.style.display = 'none';

    const newSettings = {
      githubToken: settingToken.value,
      repoOwner: settingOwner.value,
      repoName: settingRepo.value,
      branch: settingBranch.value || 'main',
      syncContests: settingContests.checked
    };

    const validation = settingsManager.validate(newSettings);
    if (!validation.valid) {
      showSettingsAlert('error', validation.errors.join(' '));
      return;
    }

    await settingsManager.saveSettings(newSettings);
    showSettingsAlert('success', '✓ Settings saved successfully.');

    // If there are pending items, attempt processing now
    triggerQueueProcessing();
  });

  // ==========================================
  // Helper Utilities
  // ==========================================
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatRelativeTime(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ==========================================
  // Initial Page Load & Live Sync Listeners
  // ==========================================
  async function init() {
    await Promise.all([
      updateSyncStatusUI(),
      refreshQueueView(),
      loadSettingsIntoForm()
    ]);
  }

  // Real-time UI updates when queue or settings change in background
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes['leetcode_backup_queue']) {
          refreshQueueView();
        }
        if (changes['leetcode_backup_settings']) {
          updateSyncStatusUI();
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
