/**
 * Background Service Worker for LeetCode to GitHub Backup Extension
 *
 * Runs in the extension background service worker context.
 * Possesses host permissions to communicate with api.github.com
 * without being restricted by web page CORS or CSP.
 */

/* global importScripts, chrome, GitHubUploader, LocalQueue */

try {
  importScripts('github-uploader.js', 'queue.js');
} catch (e) {
  console.error('[LeetCode-Backup Service Worker] Failed to importScripts:', e);
}

const localQueue = new LocalQueue();

// Sequential promise chain to strictly sequence all GitHub commits & prevent race conditions
let uploadChain = Promise.resolve();
let isProcessingQueue = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === 'UPLOAD_SUBMISSION') {
    handleUploadSubmission(message.item)
      .then(res => sendResponse(res))
      .catch(err => {
        console.error('[LeetCode-Backup Background] Upload error:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep channel open for async response
  }

  if (message.type === 'PROCESS_QUEUE') {
    handleProcessQueue(message.maxBatch)
      .then(res => sendResponse(res))
      .catch(err => {
        console.error('[LeetCode-Backup Background] Process queue error:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'TEST_GITHUB_CONNECTION') {
    handleTestConnection(message.settings)
      .then(res => sendResponse(res))
      .catch(err => {
        sendResponse({ ok: false, message: err.message });
      });
    return true;
  }

  if (message.type === 'SYNC_GITHUB_STATE') {
    handleSyncGithubState()
      .then(res => sendResponse(res))
      .catch(err => {
        console.error('[LeetCode-Backup Background] Sync GitHub state error:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'GET_DIFFICULTY_COUNTS') {
    localQueue.getDifficultyCounts()
      .then(counts => sendResponse({ success: true, counts }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_LAST_SYNCED') {
    localQueue.getLastSynced(message.limit || 10)
      .then(items => sendResponse({ success: true, items }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  return false;
});

/**
 * Retrieves configured GitHub settings from Chrome extension storage
 */
async function getStoredSettings() {
  const data = await chrome.storage.local.get('leetcode_backup_settings');
  return data['leetcode_backup_settings'] || {};
}

/**
 * Uploads a single submission item to GitHub in sequential order
 */
async function handleUploadSubmission(item) {
  if (!item || !item.submissionId) {
    throw new Error('Invalid submission item provided.');
  }

  const settings = await getStoredSettings();
  if (!settings.githubToken) {
    throw new Error('GitHub token is missing. Please configure it in extension settings.');
  }
  if (!settings.repoOwner || !settings.repoName) {
    throw new Error('GitHub repository is not configured.');
  }

  const uploader = new GitHubUploader({
    token: settings.githubToken,
    owner: settings.repoOwner,
    repo: settings.repoName,
    branch: settings.branch || 'main'
  });

  const task = async () => {
    return await uploader.uploadSubmission(item);
  };

  const chained = uploadChain.then(task, task);
  uploadChain = chained.catch(() => {});
  return await chained;
}

/**
 * Sequentially processes pending items in the local queue
 */
async function handleProcessQueue(maxBatch = 5) {
  if (isProcessingQueue) {
    return { busy: true, message: 'Queue processing is already in progress.' };
  }

  isProcessingQueue = true;
  try {
    const settings = await getStoredSettings();
    if (!settings.githubToken || !settings.repoOwner || !settings.repoName) {
      return { processed: 0, succeeded: 0, failed: 0, error: 'GitHub settings not configured.' };
    }

    const uploader = new GitHubUploader({
      token: settings.githubToken,
      owner: settings.repoOwner,
      repo: settings.repoName,
      branch: settings.branch || 'main'
    });

    const task = async () => {
      return await uploader.processQueue(localQueue, maxBatch);
    };

    const chained = uploadChain.then(task, task);
    uploadChain = chained.catch(() => {});
    return await chained;
  } finally {
    isProcessingQueue = false;
  }
}

/**
 * Tests connection to the configured GitHub repository
 */
async function handleTestConnection(providedSettings) {
  const settings = providedSettings || await getStoredSettings();
  const uploader = new GitHubUploader({
    token: settings.githubToken,
    owner: settings.repoOwner,
    repo: settings.repoName,
    branch: settings.branch || 'main'
  });

  const res = await uploader.testConnection();
  return {
    ok: true,
    message: `Connected successfully to ${res.fullName} (${res.defaultBranch})`
  };
}

/**
 * Hydrates local queue from GitHub remote tree (handles extension reset/reinstall seamlessly)
 */
async function handleSyncGithubState() {
  const settings = await getStoredSettings();
  if (!settings.githubToken || !settings.repoOwner || !settings.repoName) {
    return { success: false, error: 'GitHub settings not configured.' };
  }

  const uploader = new GitHubUploader({
    token: settings.githubToken,
    owner: settings.repoOwner,
    repo: settings.repoName,
    branch: settings.branch || 'main'
  });

  const remoteProblems = await uploader.fetchRemoteState();
  const syncResult = await localQueue.syncFromRemote(remoteProblems);
  const difficultyCounts = await localQueue.getDifficultyCounts();
  const counts = await localQueue.getCounts();
  const lastSynced = await localQueue.getLastSynced(10);

  return {
    success: true,
    imported: syncResult.imported,
    total: syncResult.total,
    counts,
    difficultyCounts,
    lastSynced
  };
}

