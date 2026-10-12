/**
 * Contest Guard for LeetCode Backup Extension
 *
 * Ensures contest pages are strictly excluded by default so that
 * no observers, readers, or sync jobs run during live or virtual contests.
 */

(function (root) {
  'use strict';

  const ContestGuard = {
    /**
     * Checks if a URL points to any LeetCode contest route
     * Matches:
     * - https://leetcode.com/contest/...
     * - https://leetcode.com/contest
     * - https://leetcode.cn/contest/...
     * - Any URL with /contest/ in its path
     *
     * @param {string} url - Target URL to evaluate
     * @returns {boolean}
     */
    isContestUrl(url) {
      if (!url || typeof url !== 'string') return false;
      try {
        const parsed = new URL(url, 'https://leetcode.com');
        const pathname = parsed.pathname.toLowerCase();
        return (
          pathname === '/contest' ||
          pathname.startsWith('/contest/') ||
          pathname.includes('/contest/')
        );
      } catch (e) {
        return url.toLowerCase().includes('/contest/');
      }
    },

    /**
     * Checks if a URL is a regular practice problem page
     * Matches:
     * - https://leetcode.com/problems/<slug>/
     * - https://leetcode.cn/problems/<slug>/
     * (and excludes any contest URL)
     *
     * @param {string} url - Target URL to evaluate
     * @returns {boolean}
     */
    isPracticeProblemUrl(url) {
      if (!url || typeof url !== 'string') return false;
      if (this.isContestUrl(url)) return false;

      try {
        const parsed = new URL(url, 'https://leetcode.com');
        const pathname = parsed.pathname.toLowerCase();
        // Matches /problems/<slug> with optional sub-paths like /description, /submissions, etc.
        return /^\/problems\/[a-z0-9_-]+/i.test(pathname);
      } catch (e) {
        return /\/problems\/[a-z0-9_-]+/i.test(url);
      }
    },

    /**
     * Extracts the problem slug from a LeetCode problem URL
     *
     * @param {string} url - LeetCode problem URL
     * @returns {string|null} - Problem slug or null if not found
     */
    extractProblemSlug(url) {
      if (!url || typeof url !== 'string') return null;
      try {
        const parsed = new URL(url, 'https://leetcode.com');
        const match = parsed.pathname.match(/\/problems\/([a-zA-Z0-9_-]+)/i);
        return match ? match[1].toLowerCase() : null;
      } catch (e) {
        const match = url.match(/\/problems\/([a-zA-Z0-9_-]+)/i);
        return match ? match[1].toLowerCase() : null;
      }
    },

    /**
     * Extracts the submission ID from a LeetCode submission URL if present
     * e.g. /problems/two-sum/submissions/123456789/ or /submissions/detail/123456789/
     *
     * @param {string} url - LeetCode URL
     * @returns {string|null} - Submission ID or null
     */
    extractSubmissionId(url) {
      if (!url || typeof url !== 'string') return null;
      try {
        const parsed = new URL(url, 'https://leetcode.com');
        const match = parsed.pathname.match(/\/submissions\/(?:detail\/)?(\d+)/i);
        return match ? match[1] : null;
      } catch (e) {
        const match = url.match(/\/submissions\/(?:detail\/)?(\d+)/i);
        return match ? match[1] : null;
      }
    },

    /**
     * Verifies that the URL is strictly an allowed practice or problemset route,
     * and NOT a contest or other non-practice page.
     * @param {string} url
     * @returns {boolean}
     */
    isAllowedSiteRoute(url) {
      if (!url || typeof url !== 'string') return false;
      if (this.isContestUrl(url)) return false;
      try {
        const parsed = new URL(url, 'https://leetcode.com');
        const p = parsed.pathname.toLowerCase();
        return p.startsWith('/problems/') || p.startsWith('/problemset/');
      } catch (e) {
        const low = url.toLowerCase();
        return (low.includes('/problems/') || low.includes('/problemset/')) && !low.includes('/contest');
      }
    },

    /**
     * Determines whether syncing should be allowed for a given URL.
     * Strictly disallows contest pages unconditionally.
     * Only activates on regular practice problem pages (/problems/<slug>/).
     *
     * @param {string} url - Current page URL
     * @returns {{
     *   allowed: boolean,
     *   reason: string,
     *   isContest: boolean,
     *   isPractice: boolean,
     *   slug: string|null
     * }}
     */
    shouldSync(url) {
      const isContest = this.isContestUrl(url);
      const isPractice = this.isPracticeProblemUrl(url);
      const slug = this.extractProblemSlug(url);

      if (isContest) {
        return {
          allowed: false,
          reason: 'Contest pages are strictly prohibited and disabled.',
          isContest: true,
          isPractice: false,
          slug: null
        };
      }

      if (isPractice && slug) {
        return {
          allowed: true,
          reason: 'Regular LeetCode practice problem.',
          isContest: false,
          isPractice: true,
          slug
        };
      }

      return {
        allowed: false,
        reason: 'Not an active LeetCode practice problem URL (/problems/*).',
        isContest: false,
        isPractice: false,
        slug: null
      };
    }
  };

  root.ContestGuard = ContestGuard;
})(typeof globalThis !== 'undefined' ? globalThis : this);
