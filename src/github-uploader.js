/**
 * GitHub Uploader for LeetCode Backup Extension
 *
 * Uses the GitHub REST API (v2022-11-28) to commit solution code and metadata
 * directly to the user's configured repository using a fine-grained PAT.
 *
 * Employs atomic single-commit updates via the Git Data API (Blobs, Trees, Commits, Refs)
 * to completely eliminate race conditions, 409 commit conflicts, and duplicate files.
 * Overwrites existing solutions and cleans up previous files when re-submitting problems.
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
     * Encodes a repository path preserving forward slashes
     */
    _encodePath(repoPath) {
      return repoPath.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
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
        if (repoData.size === 0) {
          return {
            ok: true,
            fullName: repoData.full_name,
            defaultBranch: repoData.default_branch || this.branch,
            private: repoData.private,
            empty: true
          };
        }
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
     * Creates a git blob for the specified string content (UTF-8 safe)
     * @param {string} content
     * @returns {Promise<string>} Blob SHA
     */
    async createBlob(content) {
      const url = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/blobs`;
      const res = await fetch(url, {
        method: 'POST',
        headers: this._getHeaders(),
        body: JSON.stringify({
          content: utf8ToBase64(content || ''),
          encoding: 'base64'
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || `Failed to create git blob: HTTP ${res.status}`);
      }

      const data = await res.json();
      return data.sha;
    }

    /**
     * Commits a solution and its metadata atomically in a single Git commit.
     * Uses the Git Data API (Blobs -> Tree -> Commit -> Ref update).
     * If the problem was solved previously, overwrites the files and removes
     * any old solution file with a different extension.
     *
     * @param {Object} item - Submission item from queue
     * @param {string} commitMsg - Commit message
     * @param {number} [maxRetries=3]
     * @returns {Promise<Object>} Commit summary
     */
    async commitAtomicSubmission(item, commitMsg, maxRetries = 3) {
      this.validateConfig();

      const cleanSolPath = item.solutionPath.replace(/^\/+/, '');
      const cleanMetaPath = item.metadataPath.replace(/^\/+/, '');

      // 1. Create blobs for solution code and metadata JSON
      const [solBlobSha, metaBlobSha] = await Promise.all([
        this.createBlob(item.code),
        this.createBlob(item.metadataJson)
      ]);

      // Check if existing file on GitHub is already identical (prevents redundant commits if extension reset)
      try {
        const existingSha = await this.getFileSha(cleanSolPath);
        if (existingSha && existingSha === solBlobSha) {
          const metaSha = await this.getFileSha(cleanMetaPath);
          if (metaSha && metaSha === metaBlobSha) {
            console.log(`[git the leet] ${cleanSolPath} is already up to date on GitHub. Skipping duplicate commit.`);
            return {
              success: true,
              alreadySynced: true,
              solutionSha: solBlobSha,
              metadataSha: metaBlobSha,
              solutionPath: cleanSolPath,
              metadataPath: cleanMetaPath
            };
          }
        }
      } catch (e) {}

      let lastError = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // 2. Fetch current branch head ref
          const ts = Date.now();
          const refUrl = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/ref/heads/${encodeURIComponent(this.branch)}?_t=${ts}`;
          const refRes = await fetch(refUrl, {
            headers: {
              ...this._getHeaders(),
              'Cache-Control': 'no-cache, no-store, must-revalidate',
              'Pragma': 'no-cache'
            }
          });

          if (!refRes.ok) {
            throw new Error(`Branch head ref check failed: HTTP ${refRes.status}`);
          }

          const refData = await refRes.json();
          const latestCommitSha = refData.object.sha;

          // 3. Fetch base commit to get tree SHA
          const commitUrl = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/commits/${latestCommitSha}`;
          const commitRes = await fetch(commitUrl, {
            headers: this._getHeaders()
          });

          if (!commitRes.ok) {
            throw new Error(`Base commit retrieval failed: HTTP ${commitRes.status}`);
          }

          const commitData = await commitRes.json();
          const baseTreeSha = commitData.tree.sha;

          // 4. Construct tree entries
          const treeEntries = [
            {
              path: cleanSolPath,
              mode: '100644',
              type: 'blob',
              sha: solBlobSha
            },
            {
              path: cleanMetaPath,
              mode: '100644',
              type: 'blob',
              sha: metaBlobSha
            }
          ];

          // 5. Inspect problem folder: clean up any older solution files with different extensions
          const lastSlash = cleanSolPath.lastIndexOf('/');
          const problemFolder = lastSlash !== -1 ? cleanSolPath.substring(0, lastSlash) : '';

          if (problemFolder) {
            try {
              const folderUrl = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${this._encodePath(problemFolder)}?ref=${encodeURIComponent(this.branch)}&_t=${Date.now()}`;
              const folderRes = await fetch(folderUrl, {
                headers: {
                  ...this._getHeaders(),
                  'Cache-Control': 'no-cache, no-store, must-revalidate'
                }
              });

              if (folderRes.ok) {
                const folderItems = await folderRes.json();
                if (Array.isArray(folderItems)) {
                  for (const f of folderItems) {
                    const fPath = (f.path || '').replace(/^\/+/, '');
                    const isSolution = f.name && f.name.toLowerCase().startsWith('solution.');
                    // If an old solution file exists with a different path/extension, delete it from the tree
                    if (isSolution && fPath !== cleanSolPath) {
                      treeEntries.push({
                        path: fPath,
                        mode: '100644',
                        type: 'blob',
                        sha: null // Instructs Git to remove this file
                      });
                    }
                  }
                }
              }
            } catch (e) {
              // Folder inspection is best-effort cleanup; ignore errors
            }
          }

          // 6. Create new git tree based on baseTreeSha
          const treeUrl = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees`;
          const treeRes = await fetch(treeUrl, {
            method: 'POST',
            headers: this._getHeaders(),
            body: JSON.stringify({
              base_tree: baseTreeSha,
              tree: treeEntries
            })
          });

          if (!treeRes.ok) {
            const errData = await treeRes.json().catch(() => ({}));
            throw new Error(errData.message || `Failed to create git tree (HTTP ${treeRes.status})`);
          }

          const treeData = await treeRes.json();
          const newTreeSha = treeData.sha;

          // 7. Create commit pointing to new tree
          const newCommitUrl = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/commits`;
          const newCommitRes = await fetch(newCommitUrl, {
            method: 'POST',
            headers: this._getHeaders(),
            body: JSON.stringify({
              message: commitMsg,
              tree: newTreeSha,
              parents: [latestCommitSha]
            })
          });

          if (!newCommitRes.ok) {
            const errData = await newCommitRes.json().catch(() => ({}));
            throw new Error(errData.message || `Failed to create commit (HTTP ${newCommitRes.status})`);
          }

          const newCommitData = await newCommitRes.json();
          const newCommitSha = newCommitData.sha;

          // 8. Update branch ref
          const updateRefUrl = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/refs/heads/${encodeURIComponent(this.branch)}`;
          const updateRefRes = await fetch(updateRefUrl, {
            method: 'PATCH',
            headers: this._getHeaders(),
            body: JSON.stringify({
              sha: newCommitSha,
              force: false
            })
          });

          if (updateRefRes.ok) {
            return {
              success: true,
              commitSha: newCommitSha,
              solutionSha: solBlobSha,
              metadataSha: metaBlobSha,
              solutionPath: cleanSolPath,
              metadataPath: cleanMetaPath
            };
          }

          // If branch ref conflict (another commit landed in between), wait and retry
          const refErr = await updateRefRes.json().catch(() => ({}));
          const isConflict = updateRefRes.status === 409 || updateRefRes.status === 422;

          if (isConflict && attempt < maxRetries) {
            const waitMs = attempt * 600;
            console.warn(`[LeetCode-Backup] Branch ref conflict (attempt ${attempt}/${maxRetries}): ${refErr.message || 'ref moved'}. Retrying in ${waitMs}ms...`);
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }

          throw new Error(refErr.message || `Failed to update branch ref (HTTP ${updateRefRes.status})`);
        } catch (err) {
          lastError = err;
          if (attempt < maxRetries && (err.message.includes('409') || err.message.includes('conflict') || err.message.includes('ref'))) {
            const waitMs = attempt * 600;
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
          throw err;
        }
      }

      throw lastError || new Error('Atomic commit failed after retries.');
    }

    /**
     * Fallback sequential commit using GitHub Contents PUT API.
     * Used when repository is brand new and has no existing branch ref.
     */
    async commitSequentialSubmission(item, commitMsg) {
      const frontendId = item.frontendId || item.problemId || '0';
      const title = item.problemTitle || 'Solution';
      const lang = item.language || 'code';
      const subId = item.submissionId;

      const solutionMsg = `LeetCode #${frontendId}: ${title} (${lang}) [Submission #${subId}]`;
      const solResult = await this.putFile(item.solutionPath, item.code, solutionMsg);

      // Pacing interval to let GitHub ref settle
      await new Promise(r => setTimeout(r, 800));

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
     * Uploads a complete submission: solution file and metadata.json.
     * Automatically chooses atomic commit via Git Data API (single commit, no race conditions),
     * and seamlessly overwrites/updates if the problem was previously submitted.
     *
     * @param {Object} item - Submission item from queue
     * @returns {Promise<{ success: boolean, commitSha?: string, solutionSha: string, metadataSha: string }>}
     */
    async uploadSubmission(item) {
      this.validateConfig();

      const frontendId = item.frontendId || item.problemId || '0';
      const title = item.problemTitle || 'Solution';
      const lang = item.language || 'code';
      const subId = item.submissionId;
      const commitMsg = `LeetCode #${frontendId}: ${title} (${lang}) [Submission #${subId}]`;

      try {
        return await this.commitAtomicSubmission(item, commitMsg);
      } catch (atomicErr) {
        console.warn(`[LeetCode-Backup] Git Data API commit failed (${atomicErr.message}). Falling back to Contents PUT API...`);
        return await this.commitSequentialSubmission(item, commitMsg);
      }
    }

    /**
     * Retrieves existing file SHA if present on the target branch
     */
    async getFileSha(filePath) {
      const encodedPath = this._encodePath(filePath);
      const ts = Date.now();
      const url = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(this.branch)}&_t=${ts}`;

      const res = await fetch(url, {
        method: 'GET',
        headers: {
          ...this._getHeaders(),
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      });

      if (res.status === 200) {
        const data = await res.json();
        return data.sha || null;
      }
      if (res.status === 404) {
        return null;
      }

      const errData = await res.json().catch(() => ({}));
      throw new Error(`Failed to check file "${filePath}": ${errData.message || res.statusText}`);
    }

    /**
     * Uploads or updates a single file in the GitHub repository.
     */
    async putFile(filePath, content, commitMessage, maxRetries = 3) {
      this.validateConfig();
      const encodedPath = this._encodePath(filePath);
      const base64Content = utf8ToBase64(content);
      const url = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodedPath}`;

      let lastError = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const sha = await this.getFileSha(filePath);

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
          headers: {
            ...this._getHeaders(),
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache'
          },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          return await res.json();
        }

        const data = await res.json().catch(() => ({}));
        const status = res.status;
        const errMsg = data.message || `HTTP ${status}`;
        const isConflict = status === 409 || (status === 422 && errMsg.toLowerCase().includes('sha'));

        if (isConflict && attempt < maxRetries) {
          const waitMs = attempt * 600;
          console.warn(`[LeetCode-Backup] Git 409 Conflict for "${filePath}" (attempt ${attempt}/${maxRetries}): ${errMsg}. Retrying in ${waitMs}ms...`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }

        lastError = new Error(errMsg || `GitHub upload failed for ${filePath} (HTTP ${status})`);
        break;
      }

      throw lastError || new Error(`GitHub upload failed for ${filePath}`);
    }

    /**
     * Queries GitHub for all existing problems under leetcode_problem/
     * Uses recursive Git tree API in a single network request.
     * Parses metadata for difficulty, problem ID, and submission ID.
     *
     * @returns {Promise<Array<Object>>} Array of remote problem summaries
     */
    async fetchRemoteState(cachedMetadata = {}) {
      this.validateConfig();

      const treeUrl = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees/${encodeURIComponent(this.branch)}?recursive=1&_t=${Date.now()}`;
      const res = await fetch(treeUrl, {
        headers: {
          ...this._getHeaders(),
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
      });

      if (!res.ok) {
        if (res.status === 404) return []; // Empty repository or branch
        throw new Error(`Failed to query GitHub tree: HTTP ${res.status}`);
      }

      const data = await res.json();
      const tree = data.tree || [];

      // Group files by problem folder
      const problemFolderMap = new Map();

      for (const entry of tree) {
        if (entry.type !== 'blob') continue;
        const p = entry.path || '';
        if (!p.startsWith('leetcode_problem/')) continue;

        const parts = p.split('/');
        if (parts.length < 3) continue;
        const folderName = parts[1]; // e.g. "0061-rotate-list"
        const fileName = parts[2]; // e.g. "metadata.json" or "solution.cpp"

        if (!problemFolderMap.has(folderName)) {
          problemFolderMap.set(folderName, {
            folderName,
            files: {},
            metadataSha: null
          });
        }

        const info = problemFolderMap.get(folderName);
        info.files[fileName] = entry;
        if (fileName === 'metadata.json') {
          info.metadataSha = entry.sha;
        }
      }

      const results = [];
      const folders = Array.from(problemFolderMap.values());

      const fetchMetadata = async (item) => {
        let meta = null;
        if (cachedMetadata && cachedMetadata[item.folderName]) {
          meta = cachedMetadata[item.folderName];
        } else if (item.metadataSha) {
          try {
            const blobUrl = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/blobs/${item.metadataSha}`;
            const bRes = await fetch(blobUrl, { headers: this._getHeaders() });
            if (bRes.ok) {
              const bData = await bRes.json();
              const binary = atob(bData.content.replace(/\s+/g, ''));
              const bytes = new Uint8Array(binary.length);
              for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
              meta = JSON.parse(new TextDecoder().decode(bytes));
            }
          } catch (e) {
            // Best effort; fall back to folder name
          }
        }

        const dashIdx = item.folderName.indexOf('-');
        const parsedId = dashIdx !== -1 ? item.folderName.substring(0, dashIdx).replace(/^0+/, '') || '0' : '0';
        const parsedSlug = dashIdx !== -1 ? item.folderName.substring(dashIdx + 1) : item.folderName;
        const parsedTitle = parsedSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

        let solEntry = null;
        for (const fName in item.files) {
          if (fName.startsWith('solution.') || fName.startsWith('Solution.')) {
            solEntry = item.files[fName];
            break;
          }
        }

        const ext = solEntry ? solEntry.path.split('.').pop() : 'txt';

        return {
          folderName: item.folderName,
          submissionId: meta?.submission_id || `git_${item.folderName}`,
          frontendId: meta?.frontend_id || meta?.problem_id || parsedId,
          problemTitle: meta?.problem_title || parsedTitle,
          problemSlug: meta?.problem_slug || parsedSlug,
          difficulty: meta?.difficulty || 'Medium',
          language: meta?.language || ext,
          extension: ext,
          solutionPath: solEntry ? solEntry.path : `leetcode_problem/${item.folderName}/solution.${ext}`,
          metadataPath: `leetcode_problem/${item.folderName}/metadata.json`,
          timestamp: meta?.timestamp || Math.floor(Date.now() / 1000),
          submittedAt: meta?.submitted_at || new Date().toISOString(),
          runtime: meta?.runtime || null,
          runtimePercentile: meta?.runtime_percentile || null,
          memory: meta?.memory || null,
          memoryPercentile: meta?.memory_percentile || null,
          problemUrl: meta?.problem_url || `https://leetcode.com/problems/${parsedSlug}/`
        };
      };

      // Batch queries in sets of 15
      const BATCH_SIZE = 15;
      for (let i = 0; i < folders.length; i += BATCH_SIZE) {
        const batch = folders.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(fetchMetadata));
        results.push(...batchResults);
      }

      return results;
    }

    /**
     * Processes pending items in the local queue sequentially
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
          // Pacing interval between queued items
          await new Promise(r => setTimeout(r, 600));
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
