/**
 * Content Script for LeetCode Backup Extension
 *
 * Runs on LeetCode pages, enforces contest guard exclusions,
 * observes submission outcomes, captures accepted solutions,
 * enqueues them locally, and initiates GitHub backup.
 */

(function () {
  'use strict';

  // Guard against double injection
  if (window.__LEETCODE_BACKUP_CONTENT_LOADED__) return;
  window.__LEETCODE_BACKUP_CONTENT_LOADED__ = true;

  // Strict contest exclusion: if URL is any contest route, immediately exit
  const curPath = (window.location.pathname || '').toLowerCase();
  const curHref = (window.location.href || '').toLowerCase();
  if (
    curPath === '/contest' ||
    curPath === '/contests' ||
    curPath.startsWith('/contest/') ||
    curPath.startsWith('/contests/') ||
    /(?:^|\/)(?:contest|contests)(?:\/|$)/i.test(curPath) ||
    /(?:^|\/)(?:contest|contests)(?:\/|$)/i.test(curHref)
  ) {
    console.log('[git the leet] Contest route detected. Extension deactivated.');
    return;
  }

  const contestGuard = window.ContestGuard || globalThis.ContestGuard;
  const SubmissionReaderClass = window.SubmissionReader || globalThis.SubmissionReader;
  const LocalQueueClass = window.LocalQueue || globalThis.LocalQueue;
  const GitHubUploaderClass = window.GitHubUploader || globalThis.GitHubUploader;

  if (!contestGuard || !SubmissionReaderClass || !LocalQueueClass || !GitHubUploaderClass) {
    console.error('[LeetCode-Backup] Required modules are missing. Content script halted.');
    return;
  }

  function isContestMode() {
    if (!contestGuard) return false;
    return contestGuard.isContestPage() || contestGuard.isContestUrl(window.location.href);
  }

  const submissionReader = new SubmissionReaderClass();
  const localQueue = new LocalQueueClass();

  let activeObserver = null;
  let lastCheckedUrl = '';
  let isProcessingSubmission = false;
  let lastProcessedSubmissionId = null;
  let urlPollInterval = null;

  // ==========================================
  // Toast Notification System (Shadow DOM)
  // ==========================================
  class ToastManager {
    constructor() {
      this.container = null;
      this.shadow = null;
      this._init();
    }

    _init() {
      const existing = document.getElementById('__leetcode_backup_root__');
      if (existing) existing.remove();

      this.container = document.createElement('div');
      this.container.id = '__leetcode_backup_root__';
      this.container.style.all = 'initial';
      this.shadow = this.container.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = `
        :host {
          --nm-bg: #e0e5ec;
          --nm-text: #2d3748;
          --nm-text-muted: #718096;
          --nm-shadow-light: #ffffff;
          --nm-shadow-dark: #a3b1c6;
          --nm-accent: #6b46c1;
        }
        @media (prefers-color-scheme: dark) {
          :host {
            --nm-bg: #24272c;
            --nm-text: #f1f5f9;
            --nm-text-muted: #9ba1a6;
            --nm-shadow-light: #2f333a;
            --nm-shadow-dark: #191b1e;
            --nm-accent: #8b5cf6;
          }
        }
        .toast-container {
          position: fixed;
          bottom: 24px;
          right: 24px;
          z-index: 2147483647;
          display: flex;
          flex-direction: column;
          gap: 12px;
          pointer-events: none;
          font-family: 'Poppins', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .toast {
          pointer-events: auto;
          min-width: 310px;
          max-width: 420px;
          padding: 14px 18px;
          border-radius: 18px;
          background-color: var(--nm-bg);
          color: var(--nm-text);
          box-shadow: 8px 8px 18px var(--nm-shadow-dark), -8px -8px 18px var(--nm-shadow-light);
          display: flex;
          align-items: center;
          gap: 14px;
          font-size: 13px;
          line-height: 1.4;
          opacity: 0;
          transform: translateY(12px);
          transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .toast.visible {
          opacity: 1;
          transform: translateY(0);
        }
        .toast-icon-wrap {
          width: 34px;
          height: 34px;
          border-radius: 50%;
          background: var(--nm-bg);
          box-shadow: inset 2px 2px 5px var(--nm-shadow-dark), inset -2px -2px 5px var(--nm-shadow-light);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .toast-body {
          flex-grow: 1;
        }
        .toast-title {
          font-weight: 700;
          color: var(--nm-text);
          margin-bottom: 2px;
          font-size: 13px;
        }
        .toast-msg {
          color: var(--nm-text-muted);
          word-break: break-word;
          font-size: 12px;
        }
        .toast.success .toast-title { color: #10b981; }
        .toast.error .toast-title { color: #ef4444; }
        .toast.info .toast-title { color: var(--nm-accent); }
        .spinner {
          width: 16px;
          height: 16px;
          border: 2px solid var(--nm-accent);
          border-top-color: transparent;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `;

      const wrapper = document.createElement('div');
      wrapper.className = 'toast-container';

      this.shadow.appendChild(style);
      this.shadow.appendChild(wrapper);
      this.wrapper = wrapper;

      if (document.body) {
        document.body.appendChild(this.container);
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          document.body.appendChild(this.container);
        });
      }
    }

    clear() {
      if (this.wrapper) {
        this.wrapper.innerHTML = '';
      }
    }

    show(type, title, message, duration = 4000) {
      if (isContestMode()) return null;
      if (!this.wrapper && document.body) this._init();
      if (!this.wrapper) return null;

      const toast = document.createElement('div');
      toast.className = `toast ${type}`;

      let iconHtml = '';
      if (type === 'loading') {
        iconHtml = '<div class="spinner"></div>';
      } else if (type === 'success') {
        iconHtml = '<span style="color:#10b981;font-weight:bold;font-size:16px;">✓</span>';
      } else if (type === 'error') {
        iconHtml = '<span style="color:#ef4444;font-weight:bold;font-size:16px;">✕</span>';
      } else {
        iconHtml = '<span style="color:#38bdf8;font-weight:bold;font-size:16px;">ℹ</span>';
      }

      toast.innerHTML = `
        <div class="toast-icon-wrap">${iconHtml}</div>
        <div class="toast-body">
          <div class="toast-title">${title}</div>
          <div class="toast-msg">${message}</div>
        </div>
      `;

      this.wrapper.appendChild(toast);

      // Trigger animation
      requestAnimationFrame(() => {
        toast.classList.add('visible');
      });

      const closeToast = () => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 250);
      };

      if (duration > 0) {
        setTimeout(closeToast, duration);
      }

      return {
        update: (newType, newTitle, newMessage, newDuration = 4000) => {
          if (isContestMode()) {
            closeToast();
            return;
          }
          toast.className = `toast ${newType} visible`;
          let newIcon = '';
          if (newType === 'loading') newIcon = '<div class="spinner"></div>';
          else if (newType === 'success') newIcon = '<span style="color:#10b981;font-weight:bold;font-size:16px;">✓</span>';
          else if (newType === 'error') newIcon = '<span style="color:#ef4444;font-weight:bold;font-size:16px;">✕</span>';
          else newIcon = '<span style="color:var(--nm-accent);font-weight:bold;font-size:16px;">ℹ</span>';

          const iconEl = toast.querySelector('.toast-icon-wrap');
          const titleEl = toast.querySelector('.toast-title');
          const msgEl = toast.querySelector('.toast-msg');
          if (iconEl) iconEl.innerHTML = newIcon;
          if (titleEl) titleEl.textContent = newTitle;
          if (msgEl) msgEl.textContent = newMessage;

          if (newDuration > 0) {
            setTimeout(closeToast, newDuration);
          }
        },
        close: closeToast
      };
    }
  }

  const toasts = new ToastManager();

  // ==========================================
  // Submission Processing Logic
  // ==========================================

  function isExtensionValid() {
    try {
      return typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function handleContextInvalidated() {
    if (urlPollInterval) {
      clearInterval(urlPollInterval);
      urlPollInterval = null;
    }
    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
      activeObservedSlug = null;
    }
    console.warn('[LeetCode-Backup] Extension context was invalidated (extension reloaded). Please refresh this page (F5) to re-enable auto-sync.');
  }

  /**
   * Retrieves GitHub configuration from storage
   */
  async function getExtensionSettings() {
    if (!isExtensionValid()) {
      handleContextInvalidated();
      return {
        githubToken: '',
        repoOwner: '',
        repoName: '',
        branch: 'main',
        syncContests: false,
        syncPaused: false,
        contextInvalidated: true
      };
    }
    try {
      const data = await chrome.storage.local.get('leetcode_backup_settings');
      return data['leetcode_backup_settings'] || {
        githubToken: '',
        repoOwner: '',
        repoName: '',
        branch: 'main',
        syncContests: false,
        syncPaused: false
      };
    } catch (e) {
      if (e.message && e.message.includes('Extension context invalidated')) {
        handleContextInvalidated();
      }
      return {
        githubToken: '',
        repoOwner: '',
        repoName: '',
        branch: 'main',
        syncContests: false,
        syncPaused: false,
        contextInvalidated: true
      };
    }
  }

  let activeObservedSlug = null;
  const processedSubmissionIds = new Set();

  /**
   * Called when a submission (Accepted or Not Accepted) is detected on the page
   * @param {string} [slug] - Optional problem slug
   * @param {string|number} [specificSubmissionId] - Optional known submission ID
   * @param {Object} [options] - Options including isAccepted and statusDisplay
   */
  async function handleSubmission(slug, specificSubmissionId, options = {}) {
    if (isContestMode()) {
      console.log('[git the leet] Contest page detected in handleSubmission. Sync aborted.');
      return;
    }
    if (isProcessingSubmission) return;
    isProcessingSubmission = true;

    try {
      if (isContestMode()) {
        isProcessingSubmission = false;
        return;
      }

      const problemSlug = slug || contestGuard.extractProblemSlug(window.location.href);
      if (!problemSlug) {
        console.warn('[LeetCode-Backup] Problem slug not available or contest page. Aborting.');
        return;
      }

      let isAccepted = options.isAccepted !== undefined ? Boolean(options.isAccepted) : true;
      let statusDisplay = options.statusDisplay || (isAccepted ? 'Accepted' : 'Not Accepted');

      console.log(`[LeetCode-Backup] Submission result "${statusDisplay}" detected for problem "${problemSlug}". Fetching details...`);

      let submission = options.submission || null;
      if (!submission && specificSubmissionId) {
        console.log(`[LeetCode-Backup] Directly fetching details for submission #${specificSubmissionId}`);
        try {
          submission = await submissionReader.getSubmissionDetails(specificSubmissionId, {
            problemSlug,
            allowNotAccepted: true,
            statusDisplay,
            isAccepted
          });
        } catch (err) {
          console.warn(`[LeetCode-Backup] Direct fetch for #${specificSubmissionId} failed, falling back:`, err.message);
        }
      }

      if (isContestMode()) {
        console.log('[git the leet] Contest route detected. Aborting submission handling.');
        return;
      }

      if (!submission) {
        // Allow brief moment for LeetCode backend to finalize
        await new Promise(r => setTimeout(r, 1200));
        if (isContestMode()) return;
        if (isAccepted) {
          submission = await submissionReader.getLatestAcceptedSubmission(problemSlug);
        } else {
          try {
            submission = await submissionReader.extractFromPageDom(specificSubmissionId, problemSlug, {
              allowNotAccepted: true,
              isAccepted,
              statusDisplay
            });
          } catch (e) {}
        }
      }

      if (!submission || !submission.submissionId || isContestMode()) {
        console.warn('[LeetCode-Backup] Could not obtain submission details or contest detected.');
        return;
      }

      // Re-verify acceptance from submission metadata if available
      if (submission.accepted !== undefined) {
        isAccepted = Boolean(submission.accepted);
      } else if (submission.result) {
        isAccepted = submission.result === 'Accepted';
      }
      statusDisplay = submission.statusDisplay || statusDisplay || (isAccepted ? 'Accepted' : 'Not Accepted');
      submission.accepted = isAccepted;
      submission.result = isAccepted ? 'Accepted' : 'Not Accepted';
      submission.statusDisplay = statusDisplay;
      if (submission.metadata) {
        submission.metadata.accepted = isAccepted;
        submission.metadata.result = submission.result;
        submission.metadata.status_display = statusDisplay;
        submission.metadataJson = JSON.stringify(submission.metadata, null, 2) + '\n';
      }

      const strSubId = String(submission.submissionId);

      if (strSubId === lastProcessedSubmissionId || processedSubmissionIds.has(strSubId)) {
        console.log(`[LeetCode-Backup] Submission #${strSubId} already handled.`);
        return;
      }

      const isDup = await localQueue.isDuplicate(strSubId);
      if (isDup) {
        console.log(`[LeetCode-Backup] Submission #${strSubId} is already in queue or synced.`);
        lastProcessedSubmissionId = strSubId;
        processedSubmissionIds.add(strSubId);
        return;
      }

      lastProcessedSubmissionId = strSubId;
      processedSubmissionIds.add(strSubId);

      // 1. Save locally as pending
      const statusTitle = isAccepted ? 'Accepted solution' : 'Submission [Not Accepted]';
      const toastHandle = toasts.show(
        'loading',
        'LeetCode Backup',
        `${statusTitle} #${strSubId} detected. Saving locally...`,
        0
      );

      const queuedItem = await localQueue.enqueue(submission);

      // 2. Check settings for immediate upload
      const settings = await getExtensionSettings();

      if (settings.contextInvalidated) {
        toastHandle.update(
          'error',
          'Refresh Required (F5)',
          `Extension was updated in browser. Please refresh this tab (F5) to upload submission #${strSubId}.`,
          8000
        );
        return;
      }

      if (settings.syncPaused) {
        toastHandle.update(
          'info',
          'Queued Locally',
          `Solution #${strSubId} saved. Sync is currently paused.`,
          5000
        );
        return;
      }

      if (!settings.githubToken || !settings.repoOwner || !settings.repoName) {
        toastHandle.update(
          'info',
          'Queued Locally',
          `Solution saved to local queue. Configure GitHub repository in extension popup to auto-upload.`,
          6000
        );
        return;
      }

      // 3. Initiate GitHub upload via background service worker (immune to page CORS/CSP restrictions)
      const uploadingTag = isAccepted ? '' : ' [Not Accepted]';
      toastHandle.update(
        'loading',
        'Backing up to GitHub...',
        `Uploading ${queuedItem.solutionPath}${uploadingTag} to ${settings.repoOwner}/${settings.repoName}...`,
        0
      );

      try {
        await localQueue.updateStatus(queuedItem.submissionId, 'syncing');

        const response = await new Promise((resolve, reject) => {
          const send = (retries = 2) => {
            try {
              chrome.runtime.sendMessage({
                type: 'UPLOAD_SUBMISSION',
                item: queuedItem
              }, (res) => {
                const err = chrome.runtime.lastError;
                if (err) {
                  if (retries > 0 && err.message && err.message.includes('Could not establish connection')) {
                    setTimeout(() => send(retries - 1), 350);
                    return;
                  }
                  return reject(new Error(err.message));
                }
                resolve(res);
              });
            } catch (sendErr) {
              if (retries > 0 && sendErr.message && sendErr.message.includes('Extension context invalidated')) {
                reject(sendErr);
              } else if (retries > 0) {
                setTimeout(() => send(retries - 1), 350);
              } else {
                reject(sendErr);
              }
            }
          };
          send();
        });

        if (response && response.success) {
          await localQueue.updateStatus(queuedItem.submissionId, 'synced');

          const committedTag = isAccepted ? '' : ' [Not Accepted]';
          toastHandle.update(
            isAccepted ? 'success' : 'info',
            isAccepted ? 'Backed Up to GitHub' : 'Backed Up to GitHub [Not Accepted]',
            `Committed: ${queuedItem.solutionPath}${committedTag}`,
            4500
          );

          // If accepted, refresh GraphQL stats in background so popup count is immediately fresh
          if (isAccepted && typeof submissionReader !== 'undefined' && submissionReader.fetchUserSolvedStats) {
            submissionReader.fetchUserSolvedStats().catch(() => {});
          }
        } else {
          const errMsg = response?.error || 'GitHub upload failed';
          throw new Error(errMsg);
        }
      } catch (uploadErr) {
        console.error('[LeetCode-Backup] Upload failed:', uploadErr);
        await localQueue.updateStatus(queuedItem.submissionId, 'failed', { error: uploadErr.message });

        // Remove from in-memory processed set so the user or page can re-attempt uploading
        processedSubmissionIds.delete(strSubId);
        if (lastProcessedSubmissionId === strSubId) {
          lastProcessedSubmissionId = null;
        }

        let displayMsg = uploadErr.message || 'Network error';
        if (displayMsg.includes('Extension context invalidated')) {
          displayMsg = 'Extension reloaded. Please refresh this tab (F5) to complete backup.';
        }

        toastHandle.update(
          'error',
          'GitHub Upload Failed',
          `${displayMsg}. Queued as pending for retry.`,
          7000
        );
      }
    } catch (err) {
      console.error('[LeetCode-Backup] Error handling submission:', err);
    } finally {
      // Release processing lock after brief cooldown
      setTimeout(() => {
        isProcessingSubmission = false;
      }, 2000);
    }
  }

  // Alias for backward compatibility
  function handleAcceptedSubmission(slug, specificSubmissionId) {
    return handleSubmission(slug, specificSubmissionId, { isAccepted: true, statusDisplay: 'Accepted' });
  }

  /**
   * Verifies whether a candidate submission ID is Accepted (via DOM or API)
   * and triggers backup if verified.
   */
  async function checkAndProcessUrlSubmission(problemSlug, submissionId) {
    if (isContestMode()) return;
    const strId = String(submissionId);
    if (processedSubmissionIds.has(strId)) return;
    if (strId === lastProcessedSubmissionId) return;

    // Check if duplicate in storage
    const isDup = await localQueue.isDuplicate(strId);
    if (isDup) {
      processedSubmissionIds.add(strId);
      lastProcessedSubmissionId = strId;
      return;
    }

    console.log(`[LeetCode-Backup] Submission #${strId} detected in URL. Verifying Accepted status...`);

    // Poll for status: check DOM first, then fallback to API
    let attempts = 0;
    const maxAttempts = 20; // 20 * 400ms = 8 seconds
    const interval = setInterval(async () => {
      if (isContestMode()) {
        clearInterval(interval);
        return;
      }
      attempts++;

      // Check DOM result
      const resultElements = document.querySelectorAll(
        '[data-e2e-locator="submission-result"], [class*="text-green"], [class*="text-olive"], [class*="text-emerald"], [class*="text-success"]'
      );
      for (const el of resultElements) {
        const txt = (el.textContent || '').trim();
        if (txt === 'Accepted' || txt.startsWith('Accepted')) {
          clearInterval(interval);
          console.log(`[LeetCode-Backup] URL submission #${strId} verified as Accepted in DOM.`);
          handleSubmission(problemSlug, strId, { isAccepted: true, statusDisplay: 'Accepted' });
          return;
        }
        if (
          txt &&
          (txt.includes('Wrong Answer') ||
            txt.includes('Time Limit') ||
            txt.includes('Runtime Error') ||
            txt.includes('Compile Error') ||
            txt.includes('Memory Limit'))
        ) {
          clearInterval(interval);
          console.log(`[LeetCode-Backup] URL submission #${strId} verified as not accepted (${txt}).`);
          handleSubmission(problemSlug, strId, { isAccepted: false, statusDisplay: txt });
          return;
        }
      }

      // If DOM hasn't resolved after ~2.4s, query authenticated API directly
      if (attempts === 6 || attempts === 12 || attempts === maxAttempts) {
        try {
          const details = await submissionReader.getSubmissionDetails(strId, { problemSlug, allowNotAccepted: true });
          if (details && details.submissionId) {
            clearInterval(interval);
            const isAccepted = details.accepted !== false && details.result === 'Accepted';
            console.log(`[LeetCode-Backup] URL submission #${strId} verified via LeetCode API (Accepted: ${isAccepted})!`);
            handleSubmission(problemSlug, strId, {
              isAccepted,
              statusDisplay: details.statusDisplay || (isAccepted ? 'Accepted' : 'Not Accepted'),
              submission: details
            });
            return;
          }
        } catch (e) {
          // Keep polling
        }
      }

      if (attempts >= maxAttempts) {
        clearInterval(interval);
      }
    }, 400);
  }

  // ==========================================
  // DOM Observers & Listeners for Submission Result
  // ==========================================

  /**
   * Scans target element for "Accepted" submission badge
   */
  function checkForAcceptedResult(node) {
    if (!node) return false;
    if (node.nodeType === 3) {
      return (node.nodeValue || '').trim() === 'Accepted';
    }
    if (node.nodeType !== 1) return false;

    // Direct element text check
    const directText = (node.textContent || '').trim();
    if (directText === 'Accepted' || (directText.startsWith('Accepted') && directText.length < 50)) {
      return true;
    }

    // Look for data-e2e-locator or standard submission result markers
    const submissionResult =
      node.querySelector?.('[data-e2e-locator="submission-result"]') ||
      (node.getAttribute?.('data-e2e-locator') === 'submission-result' ? node : null);

    if (submissionResult) {
      const text = (submissionResult.textContent || '').trim();
      if (text.includes('Accepted')) return true;
    }

    // Modern LeetCode dynamic layout result text (green "Accepted" state)
    const acceptedElements = node.querySelectorAll?.(
      '[class*="text-green"], [class*="text-olive"], [class*="text-success"], [class*="text-emerald"], [data-e2e-locator="submission-result"]'
    );
    if (acceptedElements && acceptedElements.length > 0) {
      for (const el of acceptedElements) {
        const txt = (el.textContent || '').trim();
        if (txt === 'Accepted' || txt.startsWith('Accepted')) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Scans target element for non-accepted submission markers (Wrong Answer, TLE, etc.)
   */
  function checkForNotAcceptedResult(node) {
    if (!node) return null;
    const text = (node.textContent || node.nodeValue || '').trim();
    if (!text || text.length > 200) return null;
    const candidates = ['Wrong Answer', 'Time Limit Exceeded', 'Runtime Error', 'Compile Error', 'Memory Limit Exceeded'];
    for (const c of candidates) {
      if (text.includes(c)) return c;
    }
    return null;
  }

  /**
   * Initializes DOM MutationObserver on practice problem page.
   * Does NOT disconnect existing observer if already observing the same problem slug.
   */
  function startSubmissionObserver(problemSlug) {
    if (isContestMode()) {
      stopSubmissionObserver();
      return;
    }

    if (activeObserver && activeObservedSlug === problemSlug) {
      return; // Already observing this problem slug
    }

    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
    }

    activeObservedSlug = problemSlug;
    console.log(`[LeetCode-Backup] Starting submission observer for practice problem: ${problemSlug}`);

    // Immediately inspect existing DOM in case result is already rendered!
    const existingResult = document.querySelector('[data-e2e-locator="submission-result"]');
    if (existingResult) {
      if (checkForAcceptedResult(existingResult)) {
        const urlSubId = contestGuard.extractSubmissionId(window.location.href);
        handleSubmission(problemSlug, urlSubId, { isAccepted: true, statusDisplay: 'Accepted' });
      } else {
        const notAcc = checkForNotAcceptedResult(existingResult);
        if (notAcc) {
          const urlSubId = contestGuard.extractSubmissionId(window.location.href);
          handleSubmission(problemSlug, urlSubId, { isAccepted: false, statusDisplay: notAcc });
        }
      }
    }

    activeObserver = new MutationObserver((mutations) => {
      if (isContestMode()) {
        stopSubmissionObserver();
        return;
      }
      if (isProcessingSubmission) return;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const addedNode of mutation.addedNodes) {
            if (checkForAcceptedResult(addedNode)) {
              const urlSubId = contestGuard.extractSubmissionId(window.location.href);
              handleSubmission(problemSlug, urlSubId, { isAccepted: true, statusDisplay: 'Accepted' });
              return;
            }
            const notAcc = checkForNotAcceptedResult(addedNode);
            if (notAcc) {
              const urlSubId = contestGuard.extractSubmissionId(window.location.href);
              handleSubmission(problemSlug, urlSubId, { isAccepted: false, statusDisplay: notAcc });
              return;
            }
          }
        } else if (mutation.type === 'characterData') {
          const val = (mutation.target.nodeValue || '').trim();
          if (val === 'Accepted') {
            const urlSubId = contestGuard.extractSubmissionId(window.location.href);
            handleSubmission(problemSlug, urlSubId, { isAccepted: true, statusDisplay: 'Accepted' });
            return;
          }
          const notAcc = checkForNotAcceptedResult(mutation.target);
          if (notAcc) {
            const urlSubId = contestGuard.extractSubmissionId(window.location.href);
            handleSubmission(problemSlug, urlSubId, { isAccepted: false, statusDisplay: notAcc });
            return;
          }
        }
      }
    });

    activeObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // Listen for network interception messages from src/interceptor.js
  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data) return;
    if (isContestMode()) return;

    if (event.data.type === 'LEETCODE_SUBMISSION_STARTED' && event.data.submissionId) {
      const currentUrl = window.location.href;
      const slug = contestGuard.extractProblemSlug(currentUrl);
      if (slug) {
        console.log(`[LeetCode-Backup] Submission #${event.data.submissionId} initiated. Arming verification...`);
        checkAndProcessUrlSubmission(slug, event.data.submissionId);
      }
    }

    if (event.data.type === 'LEETCODE_SUBMISSION_ACCEPTED' && event.data.submissionId) {
      const currentUrl = window.location.href;
      const settings = await getExtensionSettings();
      const guardCheck = contestGuard.shouldSync(currentUrl, settings.syncContests);
      if (!guardCheck.allowed) {
        console.log('[LeetCode-Backup] Contest guard active: ignoring submission event on contest page.');
        return;
      }
      const slug = guardCheck.slug || contestGuard.extractProblemSlug(currentUrl);
      console.log(`[LeetCode-Backup] Network interceptor captured Accepted submission #${event.data.submissionId} (source: ${event.data.source})`);
      handleSubmission(slug, event.data.submissionId, { isAccepted: true, statusDisplay: 'Accepted' });
    }

    if (event.data.type === 'LEETCODE_SUBMISSION_NOT_ACCEPTED' && event.data.submissionId) {
      const currentUrl = window.location.href;
      const settings = await getExtensionSettings();
      const guardCheck = contestGuard.shouldSync(currentUrl, settings.syncContests);
      if (!guardCheck.allowed) {
        console.log('[LeetCode-Backup] Contest guard active: ignoring submission event on contest page.');
        return;
      }
      const slug = guardCheck.slug || contestGuard.extractProblemSlug(currentUrl);
      console.log(`[LeetCode-Backup] Network interceptor captured Not Accepted submission #${event.data.submissionId} (${event.data.statusMsg})`);
      handleSubmission(slug, event.data.submissionId, { isAccepted: false, statusDisplay: event.data.statusMsg || 'Not Accepted' });
    }
  });

  // Listen for keyboard submit shortcut (Ctrl+Enter or Cmd+Enter)
  window.addEventListener('keydown', (e) => {
    if (isContestMode()) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      const slug = contestGuard.extractProblemSlug(window.location.href);
      if (slug) {
        console.log('[LeetCode-Backup] Submit shortcut (Ctrl/Cmd+Enter) detected. Arming result monitor...');
        pollForResult(slug, 25);
      }
    }
  }, true);

  // Listen for mouse click on Submit button
  document.addEventListener('click', (e) => {
    if (isContestMode()) return;
    const btn = e.target.closest('button, [role="button"]');
    if (!btn) return;
    const text = (btn.textContent || '').trim().toLowerCase();
    const isSubmitBtn =
      text === 'submit' ||
      text.includes('submit') ||
      btn.getAttribute('data-e2e-locator') === 'console-submit-button' ||
      btn.getAttribute('data-cypress') === 'SubmitCode';

    if (isSubmitBtn) {
      const slug = contestGuard.extractProblemSlug(window.location.href);
      if (slug) {
        console.log('[LeetCode-Backup] Submit button clicked. Arming result monitor...');
        pollForResult(slug, 25);
      }
    }
  }, true);

  /**
   * Periodic polling after submit to catch submission completion via URL, DOM or REST API
   */
  function pollForResult(problemSlug, remainingTries) {
    if (isContestMode()) return;
    if (remainingTries <= 0) return;
    if (isProcessingSubmission) {
      setTimeout(() => pollForResult(problemSlug, remainingTries - 1), 600);
      return;
    }

    setTimeout(async () => {
      if (isContestMode()) return;

      // 1. Check URL for submission ID
      const urlSubId = contestGuard.extractSubmissionId(window.location.href);
      if (urlSubId) {
        checkAndProcessUrlSubmission(problemSlug, urlSubId);
      }

      // 2. Scan page for Accepted / Not Accepted result
      const resultElements = document.querySelectorAll(
        '[data-e2e-locator="submission-result"], [class*="text-green"], [class*="text-olive"], [class*="text-emerald"], [class*="text-success"]'
      );
      for (const el of resultElements) {
        const txt = (el.textContent || '').trim();
        if (txt === 'Accepted' || txt.startsWith('Accepted')) {
          console.log('[LeetCode-Backup] Detected "Accepted" in DOM during poll.');
          handleSubmission(problemSlug, urlSubId, { isAccepted: true, statusDisplay: 'Accepted' });
          return;
        }
        if (
          txt &&
          (txt.includes('Wrong Answer') ||
            txt.includes('Time Limit') ||
            txt.includes('Runtime Error') ||
            txt.includes('Compile Error') ||
            txt.includes('Memory Limit'))
        ) {
          console.log(`[LeetCode-Backup] Detected "${txt}" in DOM during poll.`);
          handleSubmission(problemSlug, urlSubId, { isAccepted: false, statusDisplay: txt });
          return;
        }
      }

      // 3. Every 3rd try (every ~3s), check authenticated REST API
      if (remainingTries % 3 === 0) {
        try {
          const latest = await submissionReader.getLatestAcceptedSubmission(problemSlug, 3);
          if (latest && latest.submissionId && latest.submissionId !== lastProcessedSubmissionId) {
            console.log(`[LeetCode-Backup] Detected recent accepted submission #${latest.submissionId} during poll!`);
            handleAcceptedSubmission(problemSlug, latest.submissionId);
            return;
          }
        } catch (e) {}
      }

      pollForResult(problemSlug, remainingTries - 1);
    }, 1000);
  }

  /**
   * Stops and disconnects all observers
   */
  function stopSubmissionObserver() {
    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
      activeObservedSlug = null;
      console.log('[LeetCode-Backup] Submission observer disconnected.');
    }
  }

  // ==========================================
  // Contest Guard & URL Routing
  // ==========================================

  async function evaluateCurrentRoute() {
    if (!isExtensionValid()) {
      handleContextInvalidated();
      return;
    }

    const currentUrl = window.location.href;
    const isContest = isContestMode();

    if (isContest) {
      if (activeObserver) {
        console.log(`[git the leet] Contest page detected (${currentUrl}). Stopping all observers.`);
        stopSubmissionObserver();
      }
      isProcessingSubmission = false;
      toasts.clear();
      lastCheckedUrl = currentUrl;
      return;
    }

    if (currentUrl === lastCheckedUrl && activeObserver) {
      return;
    }
    lastCheckedUrl = currentUrl;

    const guardCheck = contestGuard.shouldSync(currentUrl);

    if (guardCheck.isContest) {
      stopSubmissionObserver();
      isProcessingSubmission = false;
      toasts.clear();
      return;
    }

    if (guardCheck.isPractice && guardCheck.slug) {
      const problemSlug = guardCheck.slug;

      // Keep observer alive; only restart if problem slug changed
      if (activeObservedSlug !== problemSlug) {
        startSubmissionObserver(problemSlug);
      }

      // Check if URL contains an explicit submission ID (/problems/<slug>/submissions/<id>/)
      const submissionId = contestGuard.extractSubmissionId(currentUrl);
      if (submissionId) {
        checkAndProcessUrlSubmission(problemSlug, submissionId);
      }
    } else {
      stopSubmissionObserver();
    }
  }

  // Hook SPA History transitions
  const origPushState = history.pushState;
  history.pushState = function () {
    const result = origPushState.apply(this, arguments);
    window.dispatchEvent(new Event('__lc_url_changed__'));
    return result;
  };

  const origReplaceState = history.replaceState;
  history.replaceState = function () {
    const result = origReplaceState.apply(this, arguments);
    window.dispatchEvent(new Event('__lc_url_changed__'));
    return result;
  };

  window.addEventListener('popstate', () => {
    evaluateCurrentRoute();
  });

  window.addEventListener('hashchange', () => {
    evaluateCurrentRoute();
  });

  window.addEventListener('__lc_url_changed__', () => {
    setTimeout(evaluateCurrentRoute, 50);
  });

  // Fail-safe URL poll for SPA changes every 500ms
  urlPollInterval = setInterval(evaluateCurrentRoute, 500);

  // Initial evaluation
  evaluateCurrentRoute();
})();
