/**
 * Local Queue for LeetCode Backup Extension
 *
 * Persists submissions in Chrome extension local storage before upload,
 * tracks sync lifecycle states (pending, syncing, synced, failed),
 * detects duplicates, and maintains backfill resumption state.
 */

(function (root) {
  'use strict';

  const STORAGE_KEYS = {
    QUEUE: 'leetcode_backup_queue',
    SYNCED_IDS: 'leetcode_synced_ids',
    SETTINGS: 'leetcode_backup_settings',
    BACKFILL_STATE: 'leetcode_backfill_state'
  };

  class LocalQueue {
    constructor() {
      this.storage = typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null;
    }

    _isContextValid() {
      try {
        return typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id);
      } catch (e) {
        return false;
      }
    }

    /**
     * Reads all items currently in the queue
     * @returns {Promise<Array>}
     */
    async getQueue() {
      if (!this._isContextValid() || !this.storage) return [];
      try {
        const data = await this.storage.get(STORAGE_KEYS.QUEUE);
        return Array.isArray(data[STORAGE_KEYS.QUEUE]) ? data[STORAGE_KEYS.QUEUE] : [];
      } catch (e) {
        return [];
      }
    }

    /**
     * Reads list of confirmed synced submission IDs
     * @returns {Promise<string[]>}
     */
    async getSyncedIds() {
      if (!this._isContextValid() || !this.storage) return [];
      try {
        const data = await this.storage.get(STORAGE_KEYS.SYNCED_IDS);
        return Array.isArray(data[STORAGE_KEYS.SYNCED_IDS]) ? data[STORAGE_KEYS.SYNCED_IDS] : [];
      } catch (e) {
        return [];
      }
    }

    /**
     * Checks if a submission ID has already been recorded and successfully synced or currently syncing.
     * Items that previously failed or are pending retry are NOT considered duplicates.
     * @param {string|number} submissionId
     * @returns {Promise<boolean>}
     */
    async isDuplicate(submissionId) {
      if (!submissionId || !this._isContextValid()) return false;
      const strId = String(submissionId);

      try {
        const [syncedIds, queue] = await Promise.all([
          this.getSyncedIds(),
          this.getQueue()
        ]);

        if (syncedIds.includes(strId)) return true;
        return queue.some(item => String(item.submissionId) === strId && (item.status === 'synced' || item.status === 'syncing'));
      } catch (e) {
        return false;
      }
    }

    /**
     * Adds an accepted submission to the queue with 'pending' status.
     * If the submission or problem was previously in the queue (e.g. failed or pending),
     * updates it with the latest code, resets status to pending, and moves it to the front.
     *
     * @param {Object} itemData - Normalized submission details
     * @returns {Promise<Object>} The enqueued item
     */
    async enqueue(itemData) {
      const submissionId = String(itemData.submissionId);
      const isDup = await this.isDuplicate(submissionId);

      const queue = await this.getQueue();

      if (isDup) {
        console.log(`[LeetCode-Backup] Submission #${submissionId} already synced or syncing. Skipping duplicate.`);
        const existing = queue.find(q => String(q.submissionId) === submissionId);
        return existing || null;
      }

      // Check if this exact submission ID already exists (e.g. was previously failed)
      const existingIdx = queue.findIndex(q => String(q.submissionId) === submissionId);
      if (existingIdx !== -1) {
        const existing = queue[existingIdx];
        existing.code = itemData.code;
        existing.metadataJson = itemData.metadataJson;
        existing.solutionPath = itemData.solutionPath;
        existing.metadataPath = itemData.metadataPath;
        existing.language = itemData.language;
        existing.extension = itemData.extension;
        existing.accepted = itemData.accepted !== false && itemData.result !== 'Not Accepted';
        existing.result = itemData.result || (existing.accepted ? 'Accepted' : 'Not Accepted');
        existing.statusDisplay = itemData.statusDisplay || (existing.accepted ? 'Accepted' : 'Not Accepted');
        existing.status = 'pending';
        existing.lastError = null;
        existing.addedAt = Date.now();
        // Move to front
        queue.splice(existingIdx, 1);
        queue.unshift(existing);

        if (this.storage && this._isContextValid()) {
          try {
            await this.storage.set({ [STORAGE_KEYS.QUEUE]: queue });
          } catch (e) {}
        }
        console.log(`[LeetCode-Backup] Updated previously failed submission #${submissionId} to pending.`);
        return existing;
      }

      // If an earlier submission for the same problem was pending or failed, remove it so the new one supersedes it
      const prevProblemIdx = queue.findIndex(q =>
        (q.status === 'pending' || q.status === 'failed') &&
        ((itemData.problemSlug && q.problemSlug === itemData.problemSlug) ||
         (itemData.frontendId && q.frontendId === String(itemData.frontendId)))
      );
      if (prevProblemIdx !== -1) {
        console.log(`[LeetCode-Backup] Removing earlier un-synced submission #${queue[prevProblemIdx].submissionId} superseded by #${submissionId}`);
        queue.splice(prevProblemIdx, 1);
      }

      const isAccepted = itemData.accepted !== false && itemData.result !== 'Not Accepted';
      const newItem = {
        submissionId,
        problemId: String(itemData.frontendId || itemData.problemId),
        frontendId: String(itemData.frontendId || itemData.problemId),
        problemTitle: itemData.problemTitle,
        problemSlug: itemData.problemSlug,
        difficulty: itemData.difficulty || 'Medium',
        language: itemData.language,
        extension: itemData.extension,
        code: itemData.code,
        metadataJson: itemData.metadataJson,
        solutionPath: itemData.solutionPath,
        metadataPath: itemData.metadataPath,
        accepted: isAccepted,
        result: itemData.result || (isAccepted ? 'Accepted' : 'Not Accepted'),
        statusDisplay: itemData.statusDisplay || itemData.metadata?.status_display || (isAccepted ? 'Accepted' : 'Not Accepted'),
        timestamp: itemData.timestamp || Math.floor(Date.now() / 1000),
        submittedAt: itemData.metadata?.submitted_at || new Date().toISOString(),
        runtime: itemData.metadata?.runtime || null,
        runtimePercentile: itemData.metadata?.runtime_percentile || null,
        memory: itemData.metadata?.memory || null,
        memoryPercentile: itemData.metadata?.memory_percentile || null,
        problemUrl: itemData.metadata?.problem_url || null,
        status: 'pending', // 'pending' | 'syncing' | 'synced' | 'failed'
        addedAt: Date.now(),
        syncedAt: null,
        lastError: null,
        retryCount: 0
      };

      // Add to front of queue
      queue.unshift(newItem);
      if (this.storage && this._isContextValid()) {
        try {
          await this.storage.set({ [STORAGE_KEYS.QUEUE]: queue });
        } catch (e) {}
      }

      console.log(`[LeetCode-Backup] Queued submission #${submissionId} (${newItem.solutionPath}) as pending.`);
      return newItem;
    }

    /**
     * Updates an item's status in the queue
     *
     * @param {string|number} submissionId
     * @param {'pending'|'syncing'|'synced'|'failed'} status
     * @param {Object} [extra] - Extra info like error message
     */
    async updateStatus(submissionId, status, extra = {}) {
      const strId = String(submissionId);
      const queue = await this.getQueue();
      const itemIndex = queue.findIndex(q => String(q.submissionId) === strId);

      if (itemIndex === -1) return null;

      const item = queue[itemIndex];
      item.status = status;

      if (status === 'synced') {
        item.syncedAt = Date.now();
        item.lastError = null;

        // Add to permanent synced IDs list
        const syncedIds = await this.getSyncedIds();
        if (!syncedIds.includes(strId)) {
          syncedIds.push(strId);
          if (this.storage && this._isContextValid()) {
            try {
              await this.storage.set({ [STORAGE_KEYS.SYNCED_IDS]: syncedIds });
            } catch (e) {}
          }
        }
      } else if (status === 'failed') {
        item.lastError = extra.error || 'Upload failed';
        item.retryCount = (item.retryCount || 0) + 1;
      } else if (status === 'pending') {
        item.lastError = null;
      }

      if (this.storage && this._isContextValid()) {
        try {
          await this.storage.set({ [STORAGE_KEYS.QUEUE]: queue });
        } catch (e) {}
      }
      return item;
    }

    /**
     * Marks a failed submission for retry
     * @param {string|number} submissionId
     */
    async markForRetry(submissionId) {
      return await this.updateStatus(submissionId, 'pending');
    }

    /**
     * Marks all failed items for retry
     * @returns {Promise<number>} Number of items reset to pending
     */
    async retryAllFailed() {
      const queue = await this.getQueue();
      let count = 0;
      for (const item of queue) {
        if (item.status === 'failed') {
          item.status = 'pending';
          item.lastError = null;
          count++;
        }
      }
      if (count > 0) {
        await this.storage.set({ [STORAGE_KEYS.QUEUE]: queue });
      }
      return count;
    }

    /**
     * Removes an item from the queue
     * @param {string|number} submissionId
     */
    async removeItem(submissionId) {
      const strId = String(submissionId);
      const queue = await this.getQueue();
      const filtered = queue.filter(q => String(q.submissionId) !== strId);
      await this.storage.set({ [STORAGE_KEYS.QUEUE]: filtered });
      return filtered;
    }

    /**
     * Calculates summary counts across the queue
     * @returns {Promise<{ total: number, pending: number, syncing: number, synced: number, failed: number }>}
     */
    async getCounts() {
      const queue = await this.getQueue();
      const counts = {
        total: queue.length,
        pending: 0,
        syncing: 0,
        synced: 0,
        failed: 0
      };

      for (const item of queue) {
        if (counts[item.status] !== undefined) {
          counts[item.status]++;
        }
      }

      return counts;
    }

    /**
     * Retrieves the last N synced items sorted by timestamp descending
     * @param {number} [limit=10]
     * @returns {Promise<Array>}
     */
    async getLastSynced(limit = 10) {
      const queue = await this.getQueue();
      return queue
        .filter(item => item.status === 'synced')
        .sort((a, b) => (b.timestamp || b.addedAt || 0) - (a.timestamp || a.addedAt || 0))
        .slice(0, limit);
    }

    /**
     * Calculates difficulty breakdown (easy, medium, hard, total) across all synced problems
     * @returns {Promise<{ easy: number, medium: number, hard: number, total: number }>}
     */
    async getDifficultyCounts() {
      const queue = await this.getQueue();
      const synced = queue.filter(item => item.status === 'synced' && item.accepted !== false && item.result !== 'Not Accepted');
      const seenProblems = new Set();
      const counts = { easy: 0, medium: 0, hard: 0, total: 0 };

      for (const item of synced) {
        const pKey = String(item.frontendId || item.problemId || item.problemSlug);
        if (seenProblems.has(pKey)) continue;
        seenProblems.add(pKey);

        const diff = (item.difficulty || '').toLowerCase();
        if (diff === 'easy') counts.easy++;
        else if (diff === 'hard') counts.hard++;
        else counts.medium++;
        counts.total++;
      }

      return counts;
    }

    /**
     * Syncs remote problem state from GitHub into local storage and queue.
     * Prevents re-uploading problems that already exist on GitHub even after an extension reset.
     *
     * @param {Array<Object>} remoteProblems - Array of problem summaries from GitHub
     * @returns {Promise<{ imported: number, total: number }>}
     */
    async syncFromRemote(remoteProblems = []) {
      if (!Array.isArray(remoteProblems) || remoteProblems.length === 0) return { imported: 0, total: 0 };
      if (!this._isContextValid() || !this.storage) return { imported: 0, total: 0 };

      const [existingQueue, existingSyncedIds] = await Promise.all([
        this.getQueue(),
        this.getSyncedIds()
      ]);

      const syncedIdsSet = new Set(existingSyncedIds);
      const queueMap = new Map();
      existingQueue.forEach(item => {
        queueMap.set(String(item.submissionId), item);
      });

      let imported = 0;
      for (const rp of remoteProblems) {
        const subId = String(rp.submissionId || rp.submission_id || '');
        if (subId) syncedIdsSet.add(subId);

        const pId = String(rp.frontendId || rp.frontend_id || rp.problemId || '0');
        const existingItem = subId ? queueMap.get(subId) : null;

        if (!existingItem) {
          const item = {
            submissionId: subId || `git_${rp.folderName || pId}`,
            problemId: pId,
            frontendId: pId,
            problemTitle: rp.problemTitle || rp.problem_title || rp.title || rp.folderName || 'Solution',
            problemSlug: rp.problemSlug || rp.problem_slug || '',
            difficulty: rp.difficulty || 'Medium',
            language: rp.language || 'code',
            extension: rp.extension || 'txt',
            code: rp.code || '',
            metadataJson: rp.metadataJson || '',
            solutionPath: rp.solutionPath || '',
            metadataPath: rp.metadataPath || '',
            timestamp: rp.timestamp || Math.floor(Date.now() / 1000),
            submittedAt: rp.submittedAt || rp.submitted_at || new Date().toISOString(),
            runtime: rp.runtime || null,
            runtimePercentile: rp.runtimePercentile || rp.runtime_percentile || null,
            memory: rp.memory || null,
            memoryPercentile: rp.memoryPercentile || rp.memory_percentile || null,
            problemUrl: rp.problemUrl || rp.problem_url || null,
            status: 'synced',
            accepted: rp.accepted !== false && rp.result !== 'Not Accepted',
            result: rp.result || (rp.accepted !== false ? 'Accepted' : 'Not Accepted'),
            statusDisplay: rp.statusDisplay || (rp.accepted !== false ? 'Accepted' : 'Not Accepted'),
            addedAt: (rp.timestamp ? rp.timestamp * 1000 : Date.now()),
            syncedAt: Date.now(),
            lastError: null,
            retryCount: 0
          };
          queueMap.set(String(item.submissionId), item);
          imported++;
        } else {
          existingItem.status = 'synced';
          if (rp.difficulty) existingItem.difficulty = rp.difficulty;
          if (rp.accepted !== undefined) existingItem.accepted = rp.accepted;
          if (rp.result) existingItem.result = rp.result;
          if (rp.statusDisplay) existingItem.statusDisplay = rp.statusDisplay;
        }
      }

      const mergedQueue = Array.from(queueMap.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      await Promise.all([
        this.storage.set({ [STORAGE_KEYS.QUEUE]: mergedQueue }),
        this.storage.set({ [STORAGE_KEYS.SYNCED_IDS]: Array.from(syncedIdsSet) })
      ]);

      console.log(`[git the leet] Synced ${imported} remote problems into local queue.`);
      return { imported, total: mergedQueue.length };
    }

    /**
     * Checks if syncing is currently paused by the user
     * @returns {Promise<boolean>}
     */
    async isSyncPaused() {
      const data = await this.storage.get(STORAGE_KEYS.SETTINGS);
      const settings = data[STORAGE_KEYS.SETTINGS] || {};
      return Boolean(settings.syncPaused);
    }

    /**
     * Sets sync paused flag
     * @param {boolean} paused
     */
    async setSyncPaused(paused) {
      const data = await this.storage.get(STORAGE_KEYS.SETTINGS);
      const settings = data[STORAGE_KEYS.SETTINGS] || {};
      settings.syncPaused = Boolean(paused);
      await this.storage.set({ [STORAGE_KEYS.SETTINGS]: settings });
      return settings.syncPaused;
    }

    /**
     * Retrieves stored backfill state for resuming progress
     */
    async getBackfillState() {
      const data = await this.storage.get(STORAGE_KEYS.BACKFILL_STATE);
      return data[STORAGE_KEYS.BACKFILL_STATE] || {
        inProgress: false,
        totalFound: 0,
        processedCount: 0,
        lastOffset: 0,
        hasMore: true,
        isPaused: false,
        lastUpdated: null
      };
    }

    /**
     * Updates backfill progress state
     */
    async setBackfillState(state) {
      const current = await this.getBackfillState();
      const updated = {
        ...current,
        ...state,
        lastUpdated: Date.now()
      };
      await this.storage.set({ [STORAGE_KEYS.BACKFILL_STATE]: updated });
      return updated;
    }

    /**
     * Resets backfill state
     */
    async resetBackfillState() {
      const emptyState = {
        inProgress: false,
        totalFound: 0,
        processedCount: 0,
        lastOffset: 0,
        hasMore: false,
        isPaused: false,
        lastUpdated: Date.now()
      };
      await this.storage.set({ [STORAGE_KEYS.BACKFILL_STATE]: emptyState });
      return emptyState;
    }
  }

  root.LocalQueue = LocalQueue;
  root.LOCAL_QUEUE_KEYS = STORAGE_KEYS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
