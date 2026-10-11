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
     * Checks if a submission ID has already been recorded or synced
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
        return queue.some(item => String(item.submissionId) === strId);
      } catch (e) {
        return false;
      }
    }

    /**
     * Adds an accepted submission to the queue with 'pending' status
     *
     * @param {Object} itemData - Normalized submission details
     * @returns {Promise<Object>} The enqueued item
     */
    async enqueue(itemData) {
      const submissionId = String(itemData.submissionId);
      const isDup = await this.isDuplicate(submissionId);

      const queue = await this.getQueue();

      if (isDup) {
        console.log(`[LeetCode-Backup] Submission #${submissionId} already queued or synced. Skipping duplicate.`);
        const existing = queue.find(q => String(q.submissionId) === submissionId);
        return existing || null;
      }

      const newItem = {
        submissionId,
        problemId: String(itemData.frontendId || itemData.problemId),
        frontendId: String(itemData.frontendId || itemData.problemId),
        problemTitle: itemData.problemTitle,
        problemSlug: itemData.problemSlug,
        language: itemData.language,
        extension: itemData.extension,
        code: itemData.code,
        metadataJson: itemData.metadataJson,
        solutionPath: itemData.solutionPath,
        metadataPath: itemData.metadataPath,
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
