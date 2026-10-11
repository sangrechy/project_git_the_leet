/**
 * Settings Manager for LeetCode Backup Extension
 *
 * Handles persistent storage of configuration parameters in chrome.storage.local,
 * token validation, repository verification, and connectivity testing.
 */

(function (root) {
  'use strict';

  const SETTINGS_KEY = 'leetcode_backup_settings';

  const DEFAULT_SETTINGS = {
    githubToken: '',
    repoOwner: '',
    repoName: '',
    branch: 'main',
    syncContests: false,
    syncPaused: false
  };

  class SettingsManager {
    constructor() {
      this.storage = chrome.storage.local;
    }

    /**
     * Loads settings from local storage, merging with defaults
     * @returns {Promise<Object>}
     */
    async getSettings() {
      const data = await this.storage.get(SETTINGS_KEY);
      return {
        ...DEFAULT_SETTINGS,
        ...(data[SETTINGS_KEY] || {})
      };
    }

    /**
     * Saves updated settings to local storage
     * @param {Object} newSettings
     * @returns {Promise<Object>}
     */
    async saveSettings(newSettings) {
      const current = await this.getSettings();
      const updated = {
        ...current,
        githubToken: (newSettings.githubToken !== undefined ? newSettings.githubToken : current.githubToken).trim(),
        repoOwner: (newSettings.repoOwner !== undefined ? newSettings.repoOwner : current.repoOwner).trim(),
        repoName: (newSettings.repoName !== undefined ? newSettings.repoName : current.repoName).trim(),
        branch: (newSettings.branch !== undefined ? newSettings.branch : current.branch).trim() || 'main',
        syncContests: Boolean(newSettings.syncContests !== undefined ? newSettings.syncContests : current.syncContests),
        syncPaused: Boolean(newSettings.syncPaused !== undefined ? newSettings.syncPaused : current.syncPaused)
      };

      await this.storage.set({ [SETTINGS_KEY]: updated });
      return updated;
    }

    /**
     * Updates a single setting field
     * @param {string} key
     * @param {*} value
     */
    async setSetting(key, value) {
      const current = await this.getSettings();
      current[key] = value;
      await this.storage.set({ [SETTINGS_KEY]: current });
      return current;
    }

    /**
     * Validates settings completeness
     */
    validate(settings) {
      const errors = [];
      if (!settings.githubToken) {
        errors.push('GitHub Personal Access Token is required.');
      }
      if (!settings.repoOwner) {
        errors.push('Repository Owner is required.');
      }
      if (!settings.repoName) {
        errors.push('Repository Name is required.');
      }
      return {
        valid: errors.length === 0,
        errors
      };
    }

    /**
     * Tests connectivity to the configured GitHub repository
     * @param {Object} [overrideSettings]
     * @returns {Promise<{ ok: boolean, message: string, details?: Object }>}
     */
    async testConnection(overrideSettings) {
      const settings = overrideSettings || (await this.getSettings());
      const validation = this.validate(settings);
      if (!validation.valid) {
        return {
          ok: false,
          message: validation.errors.join(' ')
        };
      }

      const GitHubUploaderClass = root.GitHubUploader;
      if (!GitHubUploaderClass) {
        return {
          ok: false,
          message: 'GitHub Uploader module is not loaded.'
        };
      }

      try {
        const uploader = new GitHubUploaderClass({
          token: settings.githubToken,
          owner: settings.repoOwner,
          repo: settings.repoName,
          branch: settings.branch || 'main'
        });

        const result = await uploader.testConnection();
        return {
          ok: true,
          message: `Connected successfully to ${result.fullName} on branch "${settings.branch || 'main'}".`,
          details: result
        };
      } catch (err) {
        return {
          ok: false,
          message: err.message
        };
      }
    }
  }

  root.SettingsManager = SettingsManager;
  root.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
