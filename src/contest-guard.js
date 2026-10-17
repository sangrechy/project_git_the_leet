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
     * - https://leetcode.com/contest
     * - https://leetcode.com/contest/
     * - https://leetcode.com/contests
     * - https://leetcode.com/contests/
     * - https://leetcode.com/contest/<contest-name>/...
     * - https://leetcode.com/contest/<contest-name>/problems/<slug>/...
     * - https://leetcode.cn/contest/...
     * - Any URL with /contest/ or /contests/ in its path
     * - URLs with contest or virtual query parameters
     *
     * @param {string} url - Target URL to evaluate
     * @returns {boolean}
     */
    isContestUrl(url) {
      if (!url || typeof url !== 'string') {
        if (typeof window !== 'undefined' && window.location) {
          url = window.location.href;
        } else {
          return false;
        }
      }

      try {
        const parsed = new URL(url, 'https://leetcode.com');
        const pathname = parsed.pathname.toLowerCase();

        // 1. Path segment checks: matches /contest, /contests, /contest/*, /contests/*
        if (
          pathname === '/contest' ||
          pathname === '/contests' ||
          pathname.startsWith('/contest/') ||
          pathname.startsWith('/contests/') ||
          /(?:^|\/)(?:contest|contests)(?:\/|$)/i.test(pathname)
        ) {
          return true;
        }

        // 2. Query parameter checks: e.g. ?contest=... or ?type=contest / virtual
        if (parsed.searchParams) {
          if (parsed.searchParams.has('contest')) return true;
          const type = (parsed.searchParams.get('type') || '').toLowerCase();
          if (type === 'contest' || type === 'virtual') return true;
        }
      } catch (e) {
        // Fallback for malformed URLs
        const low = url.toLowerCase();
        if (/(?:^|\/)(?:contest|contests)(?:\/|$)/i.test(low)) return true;
      }

      // 3. Fallback: check window.location if running in browser
      if (typeof window !== 'undefined' && window.location) {
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
          return true;
        }
      }

      return false;
    },

    /**
     * Checks if current browser environment is on any contest route
     * or contains active contest indicators in DOM
     * @returns {boolean}
     */
    isContestPage() {
      if (typeof window === 'undefined') return false;
      if (this.isContestUrl(window.location.href)) return true;
      if (this.isContestUrl(window.location.pathname)) return true;

      // Secondary check: DOM indicators for contest environment
      try {
        if (
          document.querySelector('#contest-app') ||
          document.querySelector('[data-contest]') ||
          document.querySelector('meta[name="contest"]') ||
          (document.title && document.title.toLowerCase().includes('contest - leetcode'))
        ) {
          return true;
        }
      } catch (e) {}

      return false;
    },

    /**
     * Checks if a URL is a regular practice problem page
     * Matches:
     * - https://leetcode.com/problems/<slug>/
     * - https://leetcode.cn/problems/<slug>/
     * (and strictly excludes any contest URL)
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
        // Strictly must start with /problems/<slug>
        return /^\/problems\/[a-z0-9_-]+/i.test(pathname);
      } catch (e) {
        return /^\/problems\/[a-z0-9_-]+/i.test(url);
      }
    },

    /**
     * Extracts the problem slug from a regular LeetCode practice problem URL.
     * Returns null for any contest URL.
     *
     * @param {string} url - LeetCode problem URL
     * @returns {string|null} - Problem slug or null if contest or not found
     */
    extractProblemSlug(url) {
      if (!url || typeof url !== 'string') return null;
      if (this.isContestUrl(url)) return null;

      try {
        const parsed = new URL(url, 'https://leetcode.com');
        const pathname = parsed.pathname.toLowerCase();
        const match = pathname.match(/^\/problems\/([a-z0-9_-]+)/i);
        return match ? match[1].toLowerCase() : null;
      } catch (e) {
        const match = url.match(/^\/problems\/([a-z0-9_-]+)/i);
        return match ? match[1].toLowerCase() : null;
      }
    },

    /**
     * Extracts the submission ID from a LeetCode submission URL if present.
     * Returns null for any contest URL.
     *
     * @param {string} url - LeetCode URL
     * @returns {string|null} - Submission ID or null
     */
    extractSubmissionId(url) {
      if (!url || typeof url !== 'string') return null;
      if (this.isContestUrl(url)) return null;

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

      if (isContest) {
        return {
          allowed: false,
          reason: 'Contest pages are strictly prohibited and disabled.',
          isContest: true,
          isPractice: false,
          slug: null
        };
      }

      const isPractice = this.isPracticeProblemUrl(url);
      const slug = this.extractProblemSlug(url);

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
