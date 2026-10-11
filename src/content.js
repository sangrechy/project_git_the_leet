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

  const contestGuard = window.ContestGuard || globalThis.ContestGuard;
  const SubmissionReaderClass = window.SubmissionReader || globalThis.SubmissionReader;
  const LocalQueueClass = window.LocalQueue || globalThis.LocalQueue;
  const GitHubUploaderClass = window.GitHubUploader || globalThis.GitHubUploader;

  if (!contestGuard || !SubmissionReaderClass || !LocalQueueClass || !GitHubUploaderClass) {
    console.error('[LeetCode-Backup] Required modules are missing. Content script halted.');
    return;
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

    show(type, title, message, duration = 4000) {
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

  /**
   * Retrieves GitHub configuration from storage
   */
  async function getExtensionSettings() {
    const data = await chrome.storage.local.get('leetcode_backup_settings');
    return data['leetcode_backup_settings'] || {
      githubToken: '',
      repoOwner: '',
      repoName: '',
      branch: 'main',
      syncContests: false,
      syncPaused: false
    };
  }

  /**
   * Called when an "Accepted" submission is detected on the page
   * @param {string} [slug] - Optional problem slug
   * @param {string|number} [specificSubmissionId] - Optional known submission ID
   */
  async function handleAcceptedSubmission(slug, specificSubmissionId) {
    if (isProcessingSubmission) return;
    isProcessingSubmission = true;

    try {
      const problemSlug = slug || contestGuard.extractProblemSlug(window.location.href);
      console.log(`[LeetCode-Backup] Accepted result detected for problem "${problemSlug || 'unknown'}". Fetching details...`);

      let submission = null;
      if (specificSubmissionId) {
        console.log(`[LeetCode-Backup] Directly fetching details for intercepted submission #${specificSubmissionId}`);
        try {
          submission = await submissionReader.getSubmissionDetails(specificSubmissionId, {
            problemSlug
          });
        } catch (err) {
          console.warn(`[LeetCode-Backup] Direct fetch for #${specificSubmissionId} failed, falling back:`, err.message);
        }
      }

      if (!submission) {
        // Allow brief moment for LeetCode backend to finalize
        await new Promise(r => setTimeout(r, 1200));
        submission = await submissionReader.getLatestAcceptedSubmission(problemSlug);
      }

      if (!submission || !submission.submissionId) {
        console.warn('[LeetCode-Backup] Could not obtain accepted submission details.');
        return;
      }

      if (submission.submissionId === lastProcessedSubmissionId) {
        console.log(`[LeetCode-Backup] Submission #${submission.submissionId} already handled.`);
        return;
      }

      const isDup = await localQueue.isDuplicate(submission.submissionId);
      if (isDup) {
        console.log(`[LeetCode-Backup] Submission #${submission.submissionId} is already in queue or synced.`);
        lastProcessedSubmissionId = submission.submissionId;
        return;
      }

      lastProcessedSubmissionId = submission.submissionId;

      // 1. Save locally as pending
      const toastHandle = toasts.show(
        'loading',
        'LeetCode Backup',
        `Accepted solution #${submission.submissionId} detected. Saving locally...`,
        0
      );

      const queuedItem = await localQueue.enqueue(submission);

      // 2. Check settings for immediate upload
      const settings = await getExtensionSettings();

      if (settings.syncPaused) {
        toastHandle.update(
          'info',
          'Queued Locally',
          `Solution #${submission.submissionId} saved. Sync is currently paused.`,
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

      // 3. Initiate GitHub upload
      toastHandle.update(
        'loading',
        'Backing up to GitHub...',
        `Uploading ${queuedItem.solutionPath} to ${settings.repoOwner}/${settings.repoName}...`,
        0
      );

      const uploader = new GitHubUploaderClass({
        token: settings.githubToken,
        owner: settings.repoOwner,
        repo: settings.repoName,
        branch: settings.branch || 'main'
      });

      try {
        await localQueue.updateStatus(queuedItem.submissionId, 'syncing');
        await uploader.uploadSubmission(queuedItem);
        await localQueue.updateStatus(queuedItem.submissionId, 'synced');

        toastHandle.update(
          'success',
          'Backed Up to GitHub',
          `Committed: ${queuedItem.solutionPath}`,
          4500
        );
      } catch (uploadErr) {
        console.error('[LeetCode-Backup] Upload failed:', uploadErr);
        await localQueue.updateStatus(queuedItem.submissionId, 'failed', { error: uploadErr.message });
        toastHandle.update(
          'error',
          'GitHub Upload Failed',
          `${uploadErr.message}. Queued as pending for retry.`,
          6000
        );
      }
    } catch (err) {
      console.error('[LeetCode-Backup] Error handling accepted submission:', err);
    } finally {
      // Release processing lock after brief cooldown
      setTimeout(() => {
        isProcessingSubmission = false;
      }, 2500);
    }
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
    const submissionResult = node.querySelector?.('[data-e2e-locator="submission-result"]') ||
      (node.getAttribute?.('data-e2e-locator') === 'submission-result' ? node : null);

    if (submissionResult) {
      const text = (submissionResult.textContent || '').trim();
      if (text.includes('Accepted')) return true;
    }

    // Modern LeetCode dynamic layout result text (green "Accepted" state)
    const acceptedElements = node.querySelectorAll?.('[class*="text-green"], [class*="text-olive"], [class*="text-success"], [class*="text-emerald"], [data-e2e-locator="submission-result"]');
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
   * Initializes DOM MutationObserver on practice problem page
   */
  function startSubmissionObserver(problemSlug) {
    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
    }

    console.log(`[LeetCode-Backup] Starting submission observer for practice problem: ${problemSlug}`);

    activeObserver = new MutationObserver((mutations) => {
      if (isProcessingSubmission) return;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const addedNode of mutation.addedNodes) {
            if (checkForAcceptedResult(addedNode)) {
              handleAcceptedSubmission(problemSlug);
              return;
            }
          }
        } else if (mutation.type === 'characterData') {
          if ((mutation.target.nodeValue || '').trim() === 'Accepted') {
            handleAcceptedSubmission(problemSlug);
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
      handleAcceptedSubmission(slug, event.data.submissionId);
    }
  });

  // Listen for keyboard submit shortcut (Ctrl+Enter or Cmd+Enter)
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      const slug = contestGuard.extractProblemSlug(window.location.href);
      if (slug) {
        console.log('[LeetCode-Backup] Submit shortcut (Ctrl/Cmd+Enter) detected. Arming result monitor...');
        pollForResult(slug, 20);
      }
    }
  }, true);

  // Listen for mouse click on Submit button
  document.addEventListener('click', (e) => {
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
        pollForResult(slug, 20);
      }
    }
  }, true);

  /**
   * Periodic polling after submit to catch submission completion via DOM or REST API
   */
  function pollForResult(problemSlug, remainingTries) {
    if (remainingTries <= 0 || isProcessingSubmission) return;

    setTimeout(async () => {
      if (isProcessingSubmission) return;

      // 1. Scan page for Accepted
      const resultElements = document.querySelectorAll(
        '[data-e2e-locator="submission-result"], [class*="text-green"], [class*="text-olive"], [class*="text-emerald"], [class*="text-success"]'
      );
      for (const el of resultElements) {
        const txt = (el.textContent || '').trim();
        if (txt === 'Accepted' || txt.startsWith('Accepted')) {
          console.log('[LeetCode-Backup] Detected "Accepted" in DOM during poll.');
          handleAcceptedSubmission(problemSlug);
          return;
        }
      }

      // 2. Every 3rd try (every ~4.5s), check authenticated REST API
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
    }, 1500);
  }

  /**
   * Stops and disconnects all observers
   */
  function stopSubmissionObserver() {
    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
      console.log('[LeetCode-Backup] Submission observer disconnected.');
    }
  }

  // ==========================================
  // Contest Guard & URL Routing
  // ==========================================

  async function evaluateCurrentRoute() {
    const currentUrl = window.location.href;
    if (currentUrl === lastCheckedUrl) return;
    lastCheckedUrl = currentUrl;

    const settings = await getExtensionSettings();
    const guardCheck = contestGuard.shouldSync(currentUrl, settings.syncContests);

    if (guardCheck.isContest && !settings.syncContests) {
      console.log(`[LeetCode-Backup] Contest guard active: URL is a contest page (${currentUrl}). All sync & observers stopped.`);
      stopSubmissionObserver();
      return;
    }

    if (guardCheck.isPractice && guardCheck.slug) {
      startSubmissionObserver(guardCheck.slug);
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

  window.addEventListener('__lc_url_changed__', () => {
    setTimeout(evaluateCurrentRoute, 100);
  });

  // Fail-safe URL poll for SPA changes every 1.5s
  urlPollInterval = setInterval(evaluateCurrentRoute, 1500);

  // Initial evaluation
  evaluateCurrentRoute();
})();
