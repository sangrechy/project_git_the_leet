/**
 * GitHub Uploader for LeetCode Backup Extension
 *
 * Uses the GitHub REST API (v2022-11-28) to commit solution code and metadata
 * directly to the user's configured repository using a fine-grained PAT.
 * Retries safely by resolving file SHAs to avoid conflicts.
 */

(function (root) {
  'use strict';

  /**
   * Safely converts any UTF-8 string (including multi-byte characters and symbols) to base64
   */
  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  class GitHubUploader {
    /**
     * @param {Object} config
     * @param {string} config.token - GitHub Personal Access Token
     * @param {string} config.owner - Repository owner (user or org)
     * @param {string} config.repo - Repository name
     * @param {string} [config.branch] - Target branch (default: "main")
     */
    constructor(config = {}) {
      this.token = (config.token || '').trim();
      this.owner = (config.owner || '').trim();
      this.repo = (config.repo || '').trim();
      this.branch = (config.branch || 'main').trim();
      this.apiBase = 'https://api.github.com';
    }

    _getHeaders() {
      return {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      };
    }

    /**
     * Validates that the configuration contains necessary credentials
     */
    validateConfig() {
      if (!this.token) throw new Error('GitHub token is missing. Please configure it in extension settings.');
      if (!this.owner) throw new Error('Repository owner is missing.');
      if (!this.repo) throw new Error('Repository name is missing.');
      return true;
    }

    /**
     * Tests connectivity to the repository and branch
     * @returns {Promise<{ ok: boolean, fullName: string, defaultBranch: string, private: boolean }>}
     */
    async testConnection() {
      this.validateConfig();

      const repoUrl = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
      const res = await fetch(repoUrl, {
        method: 'GET',
        headers: this._getHeaders()
      });

      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Invalid or expired GitHub token. Please verify your token.');
        }
        if (res.status === 404) {
          throw new Error(`Repository "${this.owner}/${this.repo}" not found or token lacks access to it.`);
        }
        if (res.status === 403) {
          const body = await res.json().catch(() => ({}));
          throw new Error(`Access forbidden (403): ${body.message || 'Token lacks Contents:Read/Write permission or rate limited.'}`);
        }
        throw new Error(`GitHub API check failed with status ${res.status}`);
      }

      const repoData = await res.json();

      // Check if branch exists
      const branchUrl = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/branches/${encodeURIComponent(this.branch)}`;
      const branchRes = await fetch(branchUrl, {
        method: 'GET',
        headers: this._getHeaders()
      });

      if (!branchRes.ok && branchRes.status === 404) {
        // If specified branch not found, inform about default branch
        throw new Error(`Branch "${this.branch}" does not exist in repository "${this.owner}/${this.repo}". Default branch is "${repoData.default_branch}".`);
      }

      return {
        ok: true,
        fullName: repoData.full_name,
        defaultBranch: repoData.default_branch,
        private: repoData.private
      };
    }

    /**
     * Retrieves existing file SHA if present on the target branch
     *
     * @param {string} filePath - Path in repository (e.g. "leetcode_problem/0001-two-sum/solution.py")
     * @returns {Promise<string|null>} File SHA or null if not found
     */
    async getFileSha(filePath) {
      const cleanPath = filePath.replace(/^\/+/, '');
      const url = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${cleanPath}?ref=${encodeURIComponent(this.branch)}`;

      const res = await fetch(url, {
        method: 'GET',
        headers: this._getHeaders()
      });

      if (res.status === 200) {
        const data = await res.json();
        return data.sha || null;
      }
      if (res.status === 404) {
        return null;
      }

      const errData = await res.json().catch(() => ({}));
      throw new Error(`Failed to check file "${cleanPath}": ${errData.message || res.statusText}`);
    }

    /**
     * Uploads or updates a file in the GitHub repository
     *
     * @param {string} filePath - File path in repo
     * @param {string} content - Raw text content
     * @param {string} commitMessage - Commit message
     * @returns {Promise<Object>} Commit response
     */
    async putFile(filePath, content, commitMessage) {
      this.validateConfig();
      const cleanPath = filePath.replace(/^\/+/, '');
      const sha = await this.getFileSha(cleanPath);
      const base64Content = utf8ToBase64(content);

      const url = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${cleanPath}`;
      const payload = {
        message: commitMessage,
        content: base64Content,
        branch: this.branch
      };

      if (sha) {
        payload.sha = sha;
      }

      const res = await fetch(url, {
        method: 'PUT',
        headers: this._getHeaders(),
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || `GitHub upload failed for ${cleanPath} (HTTP ${res.status})`);
      }

      return data;
    }

    /**
     * Uploads a complete submission: solution file and metadata.json
     *
     * @param {Object} item - Submission item from queue
     * @returns {Promise<{ success: boolean, solutionSha: string, metadataSha: string }>}
     */
    async uploadSubmission(item) {
      this.validateConfig();

      const frontendId = item.frontendId || item.problemId || '0';
      const title = item.problemTitle || 'Solution';
      const lang = item.language || 'code';
      const subId = item.submissionId;

      // 1. Upload solution file
      const solutionMsg = `LeetCode #${frontendId}: ${title} (${lang}) [Submission #${subId}]`;
      const solResult = await this.putFile(item.solutionPath, item.code, solutionMsg);

      // 2. Upload metadata.json
      const metaMsg = `LeetCode #${frontendId}: ${title} metadata [Submission #${subId}]`;
      const metaResult = await this.putFile(item.metadataPath, item.metadataJson, metaMsg);

      return {
        success: true,
        solutionSha: solResult?.content?.sha,
        metadataSha: metaResult?.content?.sha,
        solutionPath: item.solutionPath,
        metadataPath: item.metadataPath
      };
    }

    /**
     * Processes pending items in the local queue
     *
     * @param {LocalQueue} localQueue
     * @param {number} [maxBatch=5] - Maximum items to process in one run
     * @returns {Promise<{ processed: number, succeeded: number, failed: number }>}
     */
    async processQueue(localQueue, maxBatch = 5) {
      const isPaused = await localQueue.isSyncPaused();
      if (isPaused) {
        console.log('[LeetCode-Backup] Sync is currently paused. Skipping queue processing.');
        return { processed: 0, succeeded: 0, failed: 0, paused: true };
      }

      const queue = await localQueue.getQueue();
      const pendingItems = queue.filter(item => item.status === 'pending').slice(0, maxBatch);

      if (pendingItems.length === 0) {
        return { processed: 0, succeeded: 0, failed: 0 };
      }

      let succeeded = 0;
      let failed = 0;

      for (const item of pendingItems) {
        try {
          await localQueue.updateStatus(item.submissionId, 'syncing');
          await this.uploadSubmission(item);
          await localQueue.updateStatus(item.submissionId, 'synced');
          succeeded++;
          console.log(`[LeetCode-Backup] Successfully backed up submission #${item.submissionId} to GitHub.`);
        } catch (err) {
          console.error(`[LeetCode-Backup] Failed to backup submission #${item.submissionId}:`, err);
          await localQueue.updateStatus(item.submissionId, 'failed', { error: err.message });
          failed++;
        }
      }

      return {
        processed: pendingItems.length,
        succeeded,
        failed
      };
    }
  }

  root.GitHubUploader = GitHubUploader;
})(typeof globalThis !== 'undefined' ? globalThis : this);
