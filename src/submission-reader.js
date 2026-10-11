/**
 * Submission Reader for LeetCode Backup Extension
 *
 * Isolated module responsible for interacting with LeetCode's logged-in
 * GraphQL / REST APIs and DOM to extract submission details, source code,
 * language, problem metadata, and submission history.
 */

(function (root) {
  'use strict';

  const LANGUAGE_EXTENSIONS = {
    python: 'py',
    python3: 'py',
    pythondata: 'py',
    cpp: 'cpp',
    'c++': 'cpp',
    c: 'c',
    csharp: 'cs',
    'c#': 'cs',
    java: 'java',
    javascript: 'js',
    js: 'js',
    typescript: 'ts',
    ts: 'ts',
    php: 'php',
    swift: 'swift',
    kotlin: 'kt',
    golang: 'go',
    go: 'go',
    ruby: 'rb',
    rb: 'rb',
    scala: 'scala',
    rust: 'rs',
    racket: 'rkt',
    erlang: 'erl',
    elixir: 'ex',
    dart: 'dart',
    mysql: 'sql',
    mssql: 'sql',
    oraclesql: 'sql',
    postgresql: 'sql',
    bash: 'sh'
  };

  class SubmissionReader {
    constructor() {
      this.domain = this._detectDomain();
      this.graphqlUrl = `https://${this.domain}/graphql/`;
      this.apiBaseUrl = `https://${this.domain}`;
    }

    /**
     * Determines whether user is on leetcode.com or leetcode.cn
     */
    _detectDomain() {
      if (typeof window !== 'undefined' && window.location && window.location.hostname) {
        if (window.location.hostname.endsWith('leetcode.cn')) {
          return 'leetcode.cn';
        }
      }
      return 'leetcode.com';
    }

    /**
     * Extracts CSRF token from cookies if available
     */
    getCsrfToken() {
      if (typeof document === 'undefined') return '';
      const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    }

    /**
     * Map language identifier to appropriate file extension
     */
    getFileExtension(lang) {
      if (!lang) return 'txt';
      const normalized = String(lang).trim().toLowerCase();
      return LANGUAGE_EXTENSIONS[normalized] || 'txt';
    }

    /**
     * Format problem frontend ID with 4-digit zero-padding
     * e.g. 1 -> "0001", 42 -> "0042", 1234 -> "1234"
     */
    padProblemId(id) {
      if (id === null || id === undefined) return '0000';
      const clean = String(id).trim();
      return clean.length < 4 ? clean.padStart(4, '0') : clean;
    }

    /**
     * Builds standardized directory and file paths
     */
    buildPaths(frontendId, problemSlug, language) {
      const paddedId = this.padProblemId(frontendId);
      const folderName = `${paddedId}-${problemSlug}`;
      const ext = this.getFileExtension(language);
      return {
        folderName,
        solutionPath: `submissions/${folderName}/solution.${ext}`,
        metadataPath: `submissions/${folderName}/metadata.json`,
        extension: ext
      };
    }

    /**
     * Sends authenticated GraphQL request to LeetCode
     */
    async _graphqlQuery(query, variables = {}) {
      const csrfToken = this.getCsrfToken();
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      };

      if (csrfToken) {
        headers['x-csrftoken'] = csrfToken;
      }

      const response = await fetch(this.graphqlUrl, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ query, variables })
      });

      if (!response.ok) {
        throw new Error(`LeetCode GraphQL request failed with status: ${response.status}`);
      }

      const data = await response.json();
      if (data.errors && data.errors.length > 0) {
        throw new Error(`LeetCode GraphQL Error: ${data.errors[0].message}`);
      }

      return data.data;
    }

    /**
     * Queries recent submissions for a specific problem to get the latest accepted submission ID
     *
     * @param {string} problemSlug - Problem title slug (e.g. "two-sum")
     * @param {number} limit - Number of submissions to fetch (default: 5)
     * @returns {Promise<Object|null>}
     */
    async getLatestAcceptedSubmission(problemSlug, limit = 10) {
      const query = `
        query submissionList($offset: Int!, $limit: Int!, $lastKey: String, $questionSlug: String!) {
          submissionList(offset: $offset, limit: $limit, lastKey: $lastKey, questionSlug: $questionSlug) {
            lastKey
            hasNext
            submissions {
              id
              statusDisplay
              lang
              runtime
              timestamp
              url
              isPending
              title
              memory
            }
          }
        }
      `;

      try {
        const data = await this._graphqlQuery(query, {
          offset: 0,
          limit,
          lastKey: null,
          questionSlug: problemSlug
        });

        const list = data?.submissionList?.submissions || [];
        // Find the most recent accepted submission
        const accepted = list.find(s => s.statusDisplay === 'Accepted' && !s.isPending);
        if (accepted) {
          // Fetch full submission details (including code)
          return await this.getSubmissionDetails(accepted.id, {
            problemSlug,
            title: accepted.title,
            statusDisplay: accepted.statusDisplay
          });
        }
        return null;
      } catch (err) {
        console.warn('[LeetCode-Backup] GraphQL submissionList failed, trying fallback:', err);
        return null;
      }
    }

    /**
     * Retrieves full submission details (code, language, runtime, problem info) by submission ID
     *
     * @param {string|number} submissionId - LeetCode submission ID
     * @param {Object} [fallbackMeta] - Extra metadata if available
     * @returns {Promise<Object>} Normalized submission payload
     */
    async getSubmissionDetails(submissionId, fallbackMeta = {}) {
      const numId = parseInt(submissionId, 10);
      const queryUS = `
        query submissionDetails($submissionId: Int!) {
          submissionDetails(submissionId: $submissionId) {
            runtime
            runtimeDisplay
            runtimePercentile
            memory
            memoryDisplay
            memoryPercentile
            code
            timestamp
            statusCode
            lang {
              name
              verboseName
            }
            question {
              questionId
              questionFrontendId
              title
              titleSlug
              translatedTitle
            }
            notes
            topicTags {
              name
              slug
            }
          }
        }
      `;

      try {
        const data = await this._graphqlQuery(queryUS, { submissionId: numId });
        const details = data?.submissionDetails;
        if (details && details.code) {
          return this.normalizeDetails(details, submissionId, fallbackMeta);
        }
      } catch (e) {
        console.warn('[LeetCode-Backup] Primary submissionDetails query failed:', e.message);
      }

      // Fallback query for LeetCode CN or alternative schema
      const queryCN = `
        query mySubmissionDetail($id: ID!) {
          submissionDetail(submissionId: $id) {
            id
            code
            runtime
            memory
            statusDisplay
            timestamp
            lang
            question {
              questionId
              questionFrontendId
              titleSlug
              title
              translatedTitle
            }
          }
        }
      `;

      try {
        const dataCN = await this._graphqlQuery(queryCN, { id: String(submissionId) });
        const detailsCN = dataCN?.submissionDetail;
        if (detailsCN && detailsCN.code) {
          return this.normalizeDetailsCN(detailsCN, submissionId, fallbackMeta);
        }
      } catch (e) {
        console.warn('[LeetCode-Backup] Fallback CN submissionDetail query failed:', e.message);
      }

      // If GraphQL failed to provide code, attempt REST submission detail endpoint
      try {
        const restUrl = `${this.apiBaseUrl}/submissions/detail/${submissionId}/check/`;
        const res = await fetch(restUrl, { credentials: 'include' });
        if (res.ok) {
          const restData = await res.json();
          if (restData.code || restData.submission_code) {
            return this.normalizeRestDetails(restData, submissionId, fallbackMeta);
          }
        }
      } catch (e) {
        console.warn('[LeetCode-Backup] REST check endpoint failed:', e.message);
      }

      throw new Error(`Unable to retrieve code and details for submission ID ${submissionId}`);
    }

    /**
     * Normalizes US GraphQL submissionDetails response
     */
    normalizeDetails(details, submissionId, fallbackMeta) {
      const q = details.question || {};
      const frontendId = q.questionFrontendId || q.questionId || fallbackMeta.frontendId || '0';
      const title = q.title || fallbackMeta.title || 'Untitled Problem';
      const slug = q.titleSlug || fallbackMeta.problemSlug || 'unknown-problem';
      const lang = details.lang?.name || details.lang?.verboseName || fallbackMeta.lang || 'python3';
      const timestamp = details.timestamp || Math.floor(Date.now() / 1000);
      const paths = this.buildPaths(frontendId, slug, lang);

      const metadata = {
        submission_id: String(submissionId),
        problem_id: String(q.questionId || frontendId),
        frontend_id: String(frontendId),
        problem_title: title,
        problem_slug: slug,
        language: lang,
        timestamp: timestamp,
        submitted_at: new Date(timestamp * 1000).toISOString(),
        result: 'Accepted',
        runtime: details.runtimeDisplay || (details.runtime ? `${details.runtime} ms` : null),
        runtime_percentile: details.runtimePercentile ? `${Number(details.runtimePercentile).toFixed(1)}%` : null,
        memory: details.memoryDisplay || (details.memory ? `${(details.memory / (1024 * 1024)).toFixed(1)} MB` : null),
        memory_percentile: details.memoryPercentile ? `${Number(details.memoryPercentile).toFixed(1)}%` : null,
        problem_url: `https://${this.domain}/problems/${slug}/`
      };

      return {
        submissionId: String(submissionId),
        frontendId: String(frontendId),
        problemTitle: title,
        problemSlug: slug,
        language: lang,
        code: details.code,
        extension: paths.extension,
        folderName: paths.folderName,
        solutionPath: paths.solutionPath,
        metadataPath: paths.metadataPath,
        metadata,
        metadataJson: JSON.stringify(metadata, null, 2) + '\n'
      };
    }

    /**
     * Normalizes CN GraphQL submissionDetail response
     */
    normalizeDetailsCN(details, submissionId, fallbackMeta) {
      const q = details.question || {};
      const frontendId = q.questionFrontendId || q.questionId || fallbackMeta.frontendId || '0';
      const title = q.title || fallbackMeta.title || 'Untitled Problem';
      const slug = q.titleSlug || fallbackMeta.problemSlug || 'unknown-problem';
      const lang = details.lang || fallbackMeta.lang || 'python3';
      const timestamp = details.timestamp || Math.floor(Date.now() / 1000);
      const paths = this.buildPaths(frontendId, slug, lang);

      const metadata = {
        submission_id: String(submissionId),
        problem_id: String(q.questionId || frontendId),
        frontend_id: String(frontendId),
        problem_title: title,
        problem_slug: slug,
        language: lang,
        timestamp: timestamp,
        submitted_at: new Date(timestamp * 1000).toISOString(),
        result: 'Accepted',
        runtime: details.runtime || null,
        runtime_percentile: null,
        memory: details.memory || null,
        memory_percentile: null,
        problem_url: `https://${this.domain}/problems/${slug}/`
      };

      return {
        submissionId: String(submissionId),
        frontendId: String(frontendId),
        problemTitle: title,
        problemSlug: slug,
        language: lang,
        code: details.code,
        extension: paths.extension,
        folderName: paths.folderName,
        solutionPath: paths.solutionPath,
        metadataPath: paths.metadataPath,
        metadata,
        metadataJson: JSON.stringify(metadata, null, 2) + '\n'
      };
    }

    /**
     * Normalizes REST submission details response
     */
    normalizeRestDetails(details, submissionId, fallbackMeta) {
      const code = details.code || details.submission_code || '';
      const lang = details.lang || fallbackMeta.lang || 'python3';
      const frontendId = details.question_id || fallbackMeta.frontendId || '0';
      const title = details.title || fallbackMeta.title || 'Untitled Problem';
      const slug = fallbackMeta.problemSlug || 'unknown-problem';
      const timestamp = details.timestamp || Math.floor(Date.now() / 1000);
      const paths = this.buildPaths(frontendId, slug, lang);

      const metadata = {
        submission_id: String(submissionId),
        problem_id: String(frontendId),
        frontend_id: String(frontendId),
        problem_title: title,
        problem_slug: slug,
        language: lang,
        timestamp: timestamp,
        submitted_at: new Date(timestamp * 1000).toISOString(),
        result: 'Accepted',
        runtime: details.status_runtime || null,
        runtime_percentile: null,
        memory: details.status_memory || null,
        memory_percentile: null,
        problem_url: `https://${this.domain}/problems/${slug}/`
      };

      return {
        submissionId: String(submissionId),
        frontendId: String(frontendId),
        problemTitle: title,
        problemSlug: slug,
        language: lang,
        code,
        extension: paths.extension,
        folderName: paths.folderName,
        solutionPath: paths.solutionPath,
        metadataPath: paths.metadataPath,
        metadata,
        metadataJson: JSON.stringify(metadata, null, 2) + '\n'
      };
    }

    /**
     * Fetches user's submission history page by page for backfill
     *
     * @param {number} offset - Offset index
     * @param {number} limit - Batch limit
     * @returns {Promise<{ submissions: Array, hasMore: boolean, total: number }>}
     */
    async fetchSubmissionHistory(offset = 0, limit = 20) {
      // Primary: authenticated REST API endpoint
      const url = `${this.apiBaseUrl}/api/submissions/?offset=${offset}&limit=${limit}`;
      const csrf = this.getCsrfToken();
      const headers = { 'Accept': 'application/json' };
      if (csrf) headers['x-csrftoken'] = csrf;

      try {
        const response = await fetch(url, {
          headers,
          credentials: 'include'
        });

        if (response.ok) {
          const data = await response.json();
          const rawList = data.submissions_dump || [];
          const hasMore = Boolean(data.has_next);

          const submissions = rawList.map(item => {
            // URL format in dump is usually "/submissions/detail/12345678/"
            const urlMatch = (item.url || '').match(/\/submissions\/detail\/(\d+)\//);
            const id = item.id || (urlMatch ? urlMatch[1] : null);
            return {
              id: String(id),
              title: item.title,
              titleSlug: (item.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
              statusDisplay: item.status_display,
              lang: item.lang,
              timestamp: item.timestamp,
              runtime: item.runtime,
              memory: item.memory
            };
          });

          return {
            submissions,
            hasMore,
            total: submissions.length
          };
        }
      } catch (err) {
        console.warn('[LeetCode-Backup] REST submissions dump failed:', err.message);
      }

      return {
        submissions: [],
        hasMore: false,
        total: 0
      };
    }
  }

  root.SubmissionReader = SubmissionReader;
})(typeof globalThis !== 'undefined' ? globalThis : this);
