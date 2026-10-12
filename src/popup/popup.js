/**
 * Popup Controller for "git the leet"
 *
 * Implements:
 * - 4-tab Navigation: Home, Recent, Backfill, Settings
 * - Live Last Sync Timestamp under Active status in Header
 * - LeetCode Donut Chart & Progress Stats
 * - Dedicated Recent Tab with Difficulty Filtering & Click-to-Open
 * - Resilient Background Messaging with Cold-Start Recovery
 * - Automatic GitHub Remote State Hydration
 */

(function () {
  'use strict';

  // Instantiate component classes
  const settingsManager = new SettingsManager();
  const localQueue = new LocalQueue();
  const submissionReader = new SubmissionReader();

  // State
  let isBackfillRunning = false;
  let backfillPaused = false;
  let scannedSubmissionsToBackfill = [];
  let currentRecentFilter = 'all';
  let hangingScrollbar = null;

  // DOM Elements - Navigation
  const tabs = document.querySelectorAll('.tab-btn');
  const panes = document.querySelectorAll('.tab-pane');
  const queueBadge = document.getElementById('tab-queue-badge');

  // DOM Elements - Header Sync Status & Timestamp
  const btnToggleSync = document.getElementById('btn-toggle-sync');
  const syncIndicator = document.getElementById('sync-indicator');
  const syncStatusText = document.getElementById('sync-status-text');
  const lastSyncTimeEl = document.getElementById('last-sync-time');

  // DOM Elements - Home
  const statSynced = document.getElementById('stat-synced-count');
  const statPending = document.getElementById('stat-pending-count');
  const statFailed = document.getElementById('stat-failed-count');
  const btnSyncNow = document.getElementById('btn-sync-now');
  const btnSyncText = document.getElementById('btn-sync-text');
  const btnRetryAll = document.getElementById('btn-retry-all');

  // DOM Elements - Donut Chart
  const donutEasy = document.getElementById('donut-easy');
  const donutMedium = document.getElementById('donut-medium');
  const donutHard = document.getElementById('donut-hard');
  const chartTotalCount = document.getElementById('chart-total-count');
  const legendEasyCount = document.getElementById('legend-easy-count');
  const legendMediumCount = document.getElementById('legend-medium-count');
  const legendHardCount = document.getElementById('legend-hard-count');


  // DOM Elements - Recent Tab
  const recentList = document.getElementById('recent-list');
  const recentCountTag = document.getElementById('recent-count-tag');
  const filterChips = document.querySelectorAll('.filter-chip');

  // DOM Elements - Backfill
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

  // DOM Elements - Settings
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

  // Circumference for r=52 SVG circle (2 * PI * 52)
  const CIRCUMFERENCE = 2 * Math.PI * 52; // ~326.726

  // ==========================================
  // Tab Switching
  // ==========================================
  function activateTab(tabName) {
    tabs.forEach(t => t.classList.remove('active'));
    panes.forEach(p => p.classList.remove('active'));

    const tabBtn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    const pane = document.getElementById(`pane-${tabName}`);

    if (tabBtn) tabBtn.classList.add('active');
    if (pane) pane.classList.add('active');

    window.scrollTo(0, 0);
    document.body.scrollTop = 0;

    if (tabName === 'home') {
      refreshHomeView();
    } else if (tabName === 'recent') {
      refreshRecentView();
    }

    if (hangingScrollbar) {
      setTimeout(() => hangingScrollbar.update(), 50);
    }
  }

  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      activateTab(targetTab);
    });
  });


  // ==========================================
  // Last Synced Timestamp Formatting & Display
  // ==========================================
  function formatLastSyncTime(ts) {
    if (!ts) return '(last sync: never)';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '(last sync: never)';

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[d.getMonth()];
    const day = d.getDate();
    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;

    return `(last sync: ${month} ${day}, ${hours}:${minutes} ${ampm})`;
  }

  async function updateLastSyncUI() {
    if (!lastSyncTimeEl) return;
    try {
      const data = await chrome.storage.local.get('leetcode_backup_last_sync');
      let ts = data?.leetcode_backup_last_sync;

      if (!ts) {
        // Fallback: examine last synced item from queue
        const lastSynced = await localQueue.getLastSynced(1);
        if (lastSynced && lastSynced.length > 0) {
          ts = lastSynced[0].syncedAt || (lastSynced[0].timestamp ? lastSynced[0].timestamp * 1000 : null);
        }
      }

      lastSyncTimeEl.textContent = formatLastSyncTime(ts);
    } catch (e) {
      lastSyncTimeEl.textContent = '(last sync: never)';
    }
  }

  async function setLastSyncTimestamp(ts = Date.now()) {
    try {
      await chrome.storage.local.set({ leetcode_backup_last_sync: ts });
    } catch (e) {}
    await updateLastSyncUI();
  }

  // ==========================================
  // Sync Pause / Active Toggle
  // ==========================================
  async function updateSyncStatusUI() {
    const isPaused = await localQueue.isSyncPaused();
    if (isPaused) {
      btnToggleSync.classList.add('is-paused');
      syncStatusText.textContent = 'Paused';
      btnToggleSync.title = 'Syncing paused. Click to activate.';
    } else {
      btnToggleSync.classList.remove('is-paused');
      syncStatusText.textContent = 'Active';
      btnToggleSync.title = 'Syncing active. Click to pause.';
    }
    await updateLastSyncUI();
  }

  btnToggleSync.addEventListener('click', async () => {
    const isPaused = await localQueue.isSyncPaused();
    await localQueue.setSyncPaused(!isPaused);
    await updateSyncStatusUI();

    if (isPaused) {
      triggerSyncNow();
    }
  });

  // ==========================================
  // Donut Chart Renderer
  // ==========================================
  function renderDonutChart(counts) {
    const easy = counts.easy || 0;
    const medium = counts.medium || 0;
    const hard = counts.hard || 0;
    const total = counts.total || (easy + medium + hard);

    chartTotalCount.textContent = total;
    legendEasyCount.textContent = easy;
    legendMediumCount.textContent = medium;
    legendHardCount.textContent = hard;

    if (total === 0) {
      donutEasy.style.strokeDasharray = `0 ${CIRCUMFERENCE}`;
      donutMedium.style.strokeDasharray = `0 ${CIRCUMFERENCE}`;
      donutHard.style.strokeDasharray = `0 ${CIRCUMFERENCE}`;
      return;
    }

    const easyLen = (easy / total) * CIRCUMFERENCE;
    const medLen = (medium / total) * CIRCUMFERENCE;
    const hardLen = (hard / total) * CIRCUMFERENCE;

    donutEasy.style.strokeDasharray = `${easyLen} ${CIRCUMFERENCE - easyLen}`;
    donutEasy.style.strokeDashoffset = '0';

    donutMedium.style.strokeDasharray = `${medLen} ${CIRCUMFERENCE - medLen}`;
    donutMedium.style.strokeDashoffset = `-${easyLen}`;

    donutHard.style.strokeDasharray = `${hardLen} ${CIRCUMFERENCE - hardLen}`;
    donutHard.style.strokeDashoffset = `-${easyLen + medLen}`;
  }

  // ==========================================
  // Recent Tab: Filter Chips & Renderer
  // ==========================================
  filterChips.forEach(chip => {
    chip.addEventListener('click', () => {
      filterChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentRecentFilter = chip.getAttribute('data-filter') || 'all';
      refreshRecentView();
    });
  });

  async function refreshRecentView() {
    const allSynced = await localQueue.getLastSynced(30);

    let filtered = allSynced;
    if (currentRecentFilter !== 'all') {
      filtered = allSynced.filter(item => (item.difficulty || '').toLowerCase() === currentRecentFilter);
    }

    if (recentCountTag) {
      recentCountTag.textContent = `${filtered.length} ${currentRecentFilter === 'all' ? 'items' : currentRecentFilter}`;
    }

    if (!filtered || filtered.length === 0) {
      recentList.innerHTML = `
        <div class="empty-state">
          <div class="empty-text">No ${currentRecentFilter === 'all' ? '' : currentRecentFilter + ' '}synced submissions found.</div>
          <div class="empty-sub">Solve practice problems on LeetCode to auto-backup.</div>
        </div>
      `;
      if (hangingScrollbar) {
        setTimeout(() => hangingScrollbar.update(), 50);
      }
      return;
    }

    recentList.innerHTML = '';
    for (const item of filtered) {
      const el = document.createElement('div');
      el.className = 'recent-item';

      const frontendId = item.frontendId || item.problemId || '?';
      const title = item.problemTitle || 'Solution';
      const diff = (item.difficulty || 'Medium').toLowerCase();
      const diffLabel = diff.charAt(0).toUpperCase() + diff.slice(1);
      const diffClass = diff === 'easy' ? 'diff-easy' : diff === 'hard' ? 'diff-hard' : 'diff-medium';
      const lang = item.language || item.extension || 'code';
      const timeStr = item.timestamp ? formatRelativeTime(item.timestamp * 1000) : (item.addedAt ? formatRelativeTime(item.addedAt) : 'Synced');

      el.innerHTML = `
        <div class="recent-item-top">
          <span class="recent-item-title" title="${escapeHtml(title)}">
            #${frontendId} ${escapeHtml(title)}
          </span>
          <span class="diff-badge ${diffClass}">${diffLabel}</span>
        </div>
        <div class="recent-item-bottom">
          <span class="lang-pill">${escapeHtml(lang)}</span>
          ${item.runtime ? `<span>${escapeHtml(item.runtime)}</span>` : ''}
          <span class="recent-time">${timeStr}</span>
        </div>
      `;

      el.style.cursor = 'pointer';
      el.title = `Click to open #${frontendId} ${title} on LeetCode`;
      el.addEventListener('click', () => {
        const url = item.problemUrl || (item.problemSlug ? `https://leetcode.com/problems/${item.problemSlug}/` : null);
        if (url) {
          if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
            chrome.tabs.create({ url });
          } else {
            window.open(url, '_blank');
          }
        }
      });

      recentList.appendChild(el);
    }

    if (hangingScrollbar) {
      setTimeout(() => hangingScrollbar.update(), 50);
    }
  }

  // ==========================================
  // Home View Refresh
  // ==========================================
  async function refreshHomeView() {
    const [counts, difficultyCounts, latestItem] = await Promise.all([
      localQueue.getCounts(),
      localQueue.getDifficultyCounts(),
      localQueue.getLastSynced(1)
    ]);

    // 1. Stats strip
    statSynced.textContent = counts.synced;
    statPending.textContent = counts.pending;
    statFailed.textContent = counts.failed;

    // Update tab badge if there are pending or failed items
    const activeAlertCount = counts.pending + counts.failed;
    if (activeAlertCount > 0) {
      queueBadge.style.display = 'inline-block';
      queueBadge.textContent = activeAlertCount;
      queueBadge.className = counts.failed > 0 ? 'tab-badge badge-red' : 'tab-badge badge-amber';
    } else {
      queueBadge.style.display = 'none';
    }

    // Toggle "Retry Failed" visibility
    btnRetryAll.style.display = counts.failed > 0 ? 'inline-flex' : 'none';

    // 2. LeetCode circular chart
    renderDonutChart(difficultyCounts);


    // 4. Update last sync time
    await updateLastSyncUI();
  }

  // ==========================================
  // Resilient Background Messaging
  // ==========================================
  function sendBackgroundMessage(message, retries = 2) {
    return new Promise((resolve, reject) => {
      const send = (attemptsLeft) => {
        try {
          chrome.runtime.sendMessage(message, (res) => {
            const err = chrome.runtime.lastError;
            if (err) {
              if (attemptsLeft > 0 && err.message && err.message.includes('Could not establish connection')) {
                setTimeout(() => send(attemptsLeft - 1), 300);
                return;
              }
              return reject(new Error(err.message));
            }
            resolve(res);
          });
        } catch (e) {
          if (attemptsLeft > 0) {
            setTimeout(() => send(attemptsLeft - 1), 300);
          } else {
            reject(e);
          }
        }
      };
      send(retries);
    });
  }

  // ==========================================
  // "Sync Now" & Queue Processing
  // ==========================================
  async function triggerSyncNow() {
    btnSyncNow.disabled = true;
    btnSyncText.textContent = 'Syncing...';

    try {
      const settings = await settingsManager.getSettings();
      if (!settings.githubToken || !settings.repoOwner || !settings.repoName) {
        // Guide user to settings tab
        activateTab('settings');
        showSettingsAlert('error', 'Please configure your GitHub token and repository first.');
        return;
      }

      // First hydrate from GitHub remote state
      try {
        await sendBackgroundMessage({ type: 'SYNC_GITHUB_STATE' });
      } catch (e) {
        console.warn('[LeetCode-Backup] Sync state message warning:', e);
      }

      // Then process any pending queue items
      try {
        await sendBackgroundMessage({ type: 'PROCESS_QUEUE' });
      } catch (e) {
        console.warn('[LeetCode-Backup] Process queue warning:', e);
      }

      await setLastSyncTimestamp(Date.now());
      await refreshHomeView();
      await refreshRecentView();
    } finally {
      btnSyncNow.disabled = false;
      btnSyncText.textContent = 'Sync Now';
    }
  }

  btnSyncNow.addEventListener('click', () => {
    triggerSyncNow();
  });

  // Retry failed items
  btnRetryAll.addEventListener('click', async () => {
    btnRetryAll.disabled = true;
    await localQueue.retryAllFailed();
    await refreshHomeView();
    await triggerSyncNow();
    btnRetryAll.disabled = false;
  });

  // ==========================================
  // Historical Backfill Workflow
  // ==========================================
  btnScanBackfill.addEventListener('click', async () => {
    btnScanBackfill.disabled = true;
    btnScanBackfill.textContent = 'Scanning Submissions...';

    try {
      let offset = 0;
      const limit = 20;
      let hasMore = true;
      let allFound = [];
      let pages = 0;
      const MAX_PAGES = 10;

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

      const uniqueFoundMap = new Map();
      allFound.forEach(s => {
        if (s.id && !uniqueFoundMap.has(String(s.id))) {
          uniqueFoundMap.set(String(s.id), s);
        }
      });
      const uniqueFound = Array.from(uniqueFoundMap.values());

      const syncedIds = await localQueue.getSyncedIds();
      const existingQueue = await localQueue.getQueue();
      const existingQueueIds = new Set(existingQueue.map(q => String(q.submissionId)));

      const unbacked = uniqueFound.filter(s => {
        const strId = String(s.id);
        return !syncedIds.includes(strId) && !existingQueueIds.has(strId);
      });

      scannedSubmissionsToBackfill = unbacked;

      scanSummaryWrap.style.display = 'block';
      backfillFoundCount.textContent = uniqueFound.length;
      backfillSyncedCount.textContent = uniqueFound.length - unbacked.length;
      backfillNeededCount.textContent = unbacked.length;

      if (hangingScrollbar) {
        setTimeout(() => hangingScrollbar.update(), 50);
      }

      if (unbacked.length > 0) {
        btnStartBackfill.style.display = 'block';
        btnStartBackfill.textContent = `Start Backfill (${unbacked.length})`;
      } else {
        btnStartBackfill.style.display = 'none';
        btnScanBackfill.textContent = 'All Found Submissions Backed Up';
      }
    } catch (err) {
      console.error('Scan error:', err);
      btnScanBackfill.textContent = 'Scan Failed (Check LeetCode Login)';
      setTimeout(() => {
        btnScanBackfill.textContent = 'Scan Submissions';
      }, 4000);
    } finally {
      btnScanBackfill.disabled = false;
      if (btnScanBackfill.textContent.startsWith('Scanning')) {
        btnScanBackfill.textContent = 'Scan Submissions';
      }
    }
  });

  btnStartBackfill.addEventListener('click', async () => {
    const settings = await settingsManager.getSettings();
    const validation = settingsManager.validate(settings);
    if (!validation.valid) {
      activateTab('settings');
      showSettingsAlert('error', `Cannot start backfill: ${validation.errors.join(' ')}`);
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
        const details = await submissionReader.getSubmissionDetails(sub.id, {
          title: sub.title,
          problemSlug: sub.titleSlug,
          lang: sub.lang
        });

        const queuedItem = await localQueue.enqueue(details);
        await localQueue.updateStatus(queuedItem.submissionId, 'syncing');
        await uploader.uploadSubmission(queuedItem);
        await localQueue.updateStatus(queuedItem.submissionId, 'synced');

        completed++;
      } catch (err) {
        console.error(`Backfill failed for submission #${sub.id}:`, err);
        await localQueue.updateStatus(sub.id, 'failed', { error: err.message });
      }

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
      backfillProgressStatus.textContent = `Backfill complete! Processed ${total} submissions.`;
      await localQueue.resetBackfillState();
      scannedSubmissionsToBackfill = [];
    } else if (backfillPaused) {
      backfillProgressStatus.textContent = `Paused at ${completed}/${total} submissions.`;
      btnStartBackfill.style.display = 'block';
      btnStartBackfill.textContent = 'Resume Backfill';
    }

    await setLastSyncTimestamp(Date.now());
    refreshHomeView();
    refreshRecentView();
  });

  btnPauseBackfill.addEventListener('click', () => {
    backfillPaused = true;
    isBackfillRunning = false;
    btnPauseBackfill.style.display = 'none';
    btnStartBackfill.style.display = 'block';
    btnStartBackfill.textContent = 'Resume Backfill';
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
    btnTestConnection.textContent = 'Testing...';

    const testConfig = {
      githubToken: settingToken.value,
      repoOwner: settingOwner.value,
      repoName: settingRepo.value,
      branch: settingBranch.value || 'main',
      syncContests: settingContests.checked
    };

    const res = await settingsManager.testConnection(testConfig);
    btnTestConnection.disabled = false;
    btnTestConnection.textContent = 'Test Connection';

    if (res.ok) {
      showSettingsAlert('success', res.message);
    } else {
      showSettingsAlert('error', res.message);
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
    showSettingsAlert('success', 'Settings saved successfully.');

    // Hydrate state from GitHub with new settings
    triggerSyncNow();
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
  // Hanging Jane Custom Scrollbar Controller
  // ==========================================
  class HangingJaneScrollbar {
    constructor() {
      this.track = document.getElementById('hanging-track');
      this.carriage = document.getElementById('clinging-carriage');
      this.img = document.getElementById('jane-clinging');
      if (!this.track || !this.carriage || !this.img) return;

      this.currentFrame = 1;
      this.frameCount = 4;
      this.frameDelay = 200;
      this.frameBaseUrl = '../../res/chibi_jane/clinging/';
      this.cache = [];
      this.animInterval = null;
      this.isDragging = false;
      this.dragGrabOffsetY = 0;

      this._preloadFrames();
      this._startAnimation();
      this._initScrollTracking();
    }

    _preloadFrames() {
      for (let i = 1; i <= this.frameCount; i++) {
        const image = new Image();
        image.src = `${this.frameBaseUrl}${i}.png`;
        this.cache.push(image);
      }
    }

    _startAnimation() {
      if (this.animInterval) clearInterval(this.animInterval);
      this.animInterval = setInterval(() => {
        this.currentFrame = (this.currentFrame % this.frameCount) + 1;
        if (this.cache[this.currentFrame - 1]) {
          this.img.src = this.cache[this.currentFrame - 1].src;
        }
      }, this.frameDelay);
    }

    _getScrollMetrics() {
      const trackRect = this.track.getBoundingClientRect();
      const carriageHeight = this.carriage.offsetHeight || 40;
      const maxTravel = Math.max(1, trackRect.height - carriageHeight);

      const docHeight = document.documentElement.scrollHeight || 0;
      const bodyHeight = document.body.scrollHeight || 0;
      const scrollHeight = Math.max(docHeight, bodyHeight);

      const docClient = document.documentElement.clientHeight || 0;
      const bodyClient = document.body.clientHeight || window.innerHeight || 0;
      const clientHeight = Math.max(docClient, bodyClient);

      const rawMaxScroll = scrollHeight - clientHeight;
      const needsScroll = rawMaxScroll > 6;

      return {
        trackRect,
        carriageHeight,
        maxTravel,
        maxScroll: Math.max(1, rawMaxScroll),
        needsScroll
      };
    }

    _getScrollTop() {
      return document.body.scrollTop || window.scrollY || document.documentElement.scrollTop || 0;
    }

    _setScrollTop(val) {
      document.body.scrollTop = val;
      document.documentElement.scrollTop = val;
      window.scrollTo(0, val);
    }

    _updateCarriagePosition() {
      const metrics = this._getScrollMetrics();
      if (!metrics.needsScroll) {
        this.track.style.display = 'none';
        return;
      }
      this.track.style.display = 'flex';

      if (this.isDragging) return;
      const currentScroll = this._getScrollTop();
      const ratio = metrics.maxScroll > 0 ? Math.min(1, Math.max(0, currentScroll / metrics.maxScroll)) : 0;
      const topPos = ratio * metrics.maxTravel;
      this.carriage.style.top = `${topPos}px`;
    }

    _setScrollFromThumb(thumbTop, metrics) {
      const clampedTop = Math.max(0, Math.min(metrics.maxTravel, thumbTop));
      this.carriage.style.top = `${clampedTop}px`;
      const scrollRatio = clampedTop / metrics.maxTravel;
      const targetScroll = Math.round(scrollRatio * metrics.maxScroll);
      this._setScrollTop(targetScroll);
    }

    _initScrollTracking() {
      const onScroll = () => this._updateCarriagePosition();
      window.addEventListener('scroll', onScroll, { passive: true });
      document.body.addEventListener('scroll', onScroll, { passive: true });
      document.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);

      // Pointer drag on carriage
      this.carriage.addEventListener('pointerdown', (e) => {
        const metrics = this._getScrollMetrics();
        if (!metrics.needsScroll) return;
        this.isDragging = true;
        this.carriage.setPointerCapture(e.pointerId);
        this.carriage.classList.add('is-dragging');
        const carriageRect = this.carriage.getBoundingClientRect();
        this.dragGrabOffsetY = e.clientY - carriageRect.top;
        document.body.style.userSelect = 'none';
        e.preventDefault();
        e.stopPropagation();
      });

      this.carriage.addEventListener('pointermove', (e) => {
        if (!this.isDragging) return;
        const metrics = this._getScrollMetrics();
        const thumbTop = e.clientY - metrics.trackRect.top - this.dragGrabOffsetY;
        this._setScrollFromThumb(thumbTop, metrics);
      });

      const endDrag = (e) => {
        if (this.isDragging) {
          this.isDragging = false;
          try { this.carriage.releasePointerCapture(e.pointerId); } catch (_) {}
          this.carriage.classList.remove('is-dragging');
          document.body.style.userSelect = '';
        }
      };

      this.carriage.addEventListener('pointerup', endDrag);
      this.carriage.addEventListener('pointercancel', endDrag);

      // Click track outside carriage
      this.track.addEventListener('pointerdown', (e) => {
        if (e.target.closest('#clinging-carriage')) return;
        const metrics = this._getScrollMetrics();
        const targetTop = e.clientY - metrics.trackRect.top - (metrics.carriageHeight / 2);
        this._setScrollFromThumb(targetTop, metrics);
      });

      setTimeout(() => this._updateCarriagePosition(), 80);
    }

    update() {
      this._updateCarriagePosition();
    }
  }

  // ==========================================
  // Initial Page Load & Auto-Hydration
  // ==========================================
  async function init() {
    hangingScrollbar = new HangingJaneScrollbar();

    await Promise.all([
      updateSyncStatusUI(),
      refreshHomeView(),
      refreshRecentView(),
      loadSettingsIntoForm()
    ]);

    // Auto-hydrate state from GitHub if configured
    const settings = await settingsManager.getSettings();
    if (settings.githubToken && settings.repoOwner && settings.repoName) {
      try {
        const res = await sendBackgroundMessage({ type: 'SYNC_GITHUB_STATE' });
        if (res && res.success) {
          await setLastSyncTimestamp(Date.now());
          refreshHomeView();
          refreshRecentView();
        }
      } catch (e) {}
    }
  }

  // Real-time UI updates when queue or settings change in background
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes['leetcode_backup_queue']) {
          refreshHomeView();
          refreshRecentView();
        }
        if (changes['leetcode_backup_settings']) {
          updateSyncStatusUI();
        }
        if (changes['leetcode_backup_last_sync']) {
          updateLastSyncUI();
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
