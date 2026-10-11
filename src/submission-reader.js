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
        solutionPath: `leetcode_problem/${folderName}/solution.${ext}`,
        metadataPath: `leetcode_problem/${folderName}/metadata.json`,
        extension: ext
      };
    }

    /**
     * Extracts problem slug from current window location if available
     */
    extractSlugFromUrl() {
      if (typeof window === 'undefined' || !window.location) return null;
      const match = window.location.href.match(/\/problems\/([a-zA-Z0-9_-]+)/i);
      return match ? match[1].toLowerCase() : null;
    }

    /**
     * Sends authenticated GraphQL request to LeetCode
     */
    async _graphqlQuery(query, variables = {}, operationName = null) {
      const csrfToken = this.getCsrfToken();
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      };

      if (csrfToken) {
        headers['x-csrftoken'] = csrfToken;
      }

      const bodyObj = { query, variables };
      if (operationName) {
        bodyObj.operationName = operationName;
      }

      const response = await fetch(this.graphqlUrl, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(bodyObj)
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
     * Public GraphQL query for question details (does not require session auth)
     */
    async fetchQuestionDetails(titleSlug) {
      if (!titleSlug) return null;
      const query = `
        query questionTitle($titleSlug: String!) {
          question(titleSlug: $titleSlug) {
            questionId
            questionFrontendId
            title
            titleSlug
          }
        }
      `;
      try {
        const data = await this._graphqlQuery(query, { titleSlug }, 'questionTitle');
        return data?.question || null;
      } catch (e) {
        console.warn('[LeetCode-Backup] fetchQuestionDetails query failed:', e.message);
        return null;
      }
    }

    /**
     * Queries recent submissions for a specific problem to get the latest accepted submission ID
     *
     * @param {string} problemSlug - Problem title slug (e.g. "two-sum")
     * @param {number} limit - Number of submissions to fetch (default: 5)
     * @returns {Promise<Object|null>}
     */
    async getLatestAcceptedSubmission(problemSlug, limit = 5) {
      // 1. Primary: Use authenticated REST API /api/submissions/ (proven reliable on US and CN)
      try {
        const history = await this.fetchSubmissionHistory(0, limit);
        if (history && history.submissions && history.submissions.length > 0) {
          const nowSeconds = Math.floor(Date.now() / 1000);
          // Look for an accepted submission that matches the problem slug or is recent
          const accepted = history.submissions.find(s => {
            if (s.statusDisplay !== 'Accepted') return false;
            if (problemSlug && s.titleSlug) {
              const cleanA = problemSlug.toLowerCase().replace(/[^a-z0-9]/g, '');
              const cleanB = s.titleSlug.toLowerCase().replace(/[^a-z0-9]/g, '');
              return cleanA === cleanB || cleanA.includes(cleanB) || cleanB.includes(cleanA);
            }
            return s.timestamp && (nowSeconds - s.timestamp < 900);
          });

          if (accepted) {
            console.log(`[LeetCode-Backup] Found latest accepted submission #${accepted.id} via /api/submissions/`);
            return await this.getSubmissionDetails(accepted.id, {
              problemSlug: problemSlug || accepted.titleSlug,
              title: accepted.title,
              statusDisplay: accepted.statusDisplay,
              lang: accepted.lang
            });
          }
        }
      } catch (restErr) {
        console.warn('[LeetCode-Backup] REST getLatestAcceptedSubmission check failed:', restErr.message);
      }

      // 2. Secondary fallback: GraphQL submissionList query
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
        const accepted = list.find(s => s.statusDisplay === 'Accepted' && !s.isPending);
        if (accepted) {
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
            statusDisplay
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

      // 1. Try US GraphQL submissionDetails query
      try {
        const data = await this._graphqlQuery(queryUS, { submissionId: numId }, 'submissionDetails');
        const details = data?.submissionDetails;
        if (details && details.code) {
          const normalized = this.normalizeDetails(details, submissionId, fallbackMeta);
          if (normalized) return normalized;
        }
      } catch (e) {
        console.warn('[LeetCode-Backup] Primary submissionDetails query failed:', e.message);
      }

      // 2. Fallback query for LeetCode CN or alternative schema
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
        const dataCN = await this._graphqlQuery(queryCN, { id: String(submissionId) }, 'mySubmissionDetail');
        const detailsCN = dataCN?.submissionDetail;
        if (detailsCN && detailsCN.code) {
          const normalized = this.normalizeDetailsCN(detailsCN, submissionId, fallbackMeta);
          if (normalized) return normalized;
        }
      } catch (e) {
        console.warn('[LeetCode-Backup] Fallback CN submissionDetail query failed:', e.message);
      }

      // 3. Fallback: Extract directly from page DOM (foolproof when viewing the submission page!)
      const targetSlug = fallbackMeta.problemSlug || this.extractSlugFromUrl();
      try {
        const domDetails = await this.extractFromPageDom(submissionId, targetSlug, fallbackMeta);
        if (domDetails && domDetails.code) {
          console.log(`[LeetCode-Backup] Successfully extracted submission #${submissionId} details directly from page DOM.`);
          return domDetails;
        }
      } catch (domErr) {
        console.warn('[LeetCode-Backup] DOM extraction fallback error:', domErr.message);
      }

      // 4. Fallback: REST check endpoint
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
     * Extracts submission code and metadata directly from the active LeetCode webpage DOM.
     * Serves as an infallible fallback if GraphQL is unavailable or restricted.
     */
    async extractFromPageDom(submissionId, problemSlug, fallbackMeta = {}) {
      if (typeof document === 'undefined') return null;

      // 1. Extract submitted source code
      let code = '';

      // Check Monaco editor DOM lines
      const monacoEditor = document.querySelector('.monaco-editor');
      if (monacoEditor) {
        const viewLines = monacoEditor.querySelectorAll('.view-line');
        if (viewLines.length > 0) {
          code = Array.from(viewLines).map(l => l.textContent || '').join('\n');
        }
      }

      // Check <code> or <pre> elements
      if (!code || code.trim().length === 0) {
        const codeElements = document.querySelectorAll('code, pre');
        for (const el of codeElements) {
          const txt = (el.textContent || '').trim();
          if (txt.length > code.length && !txt.includes('Accepted') && !txt.includes('Runtime:')) {
            code = el.textContent || '';
          }
        }
      }

      if (!code || code.trim().length === 0) {
        return null;
      }

      // 2. Extract programming language
      let lang = fallbackMeta.lang || '';
      if (!lang) {
        const monaco = document.querySelector('[data-mode-id]');
        if (monaco) {
          lang = monaco.getAttribute('data-mode-id') || '';
        }
      }
      if (!lang) {
        const langBtn = document.querySelector('button[id^="headlessui-listbox-button"], [data-cy="lang-select"]');
        if (langBtn) {
          lang = (langBtn.textContent || '').trim().toLowerCase();
        }
      }
      if (!lang) {
        lang = 'python3';
      }

      // 3. Extract problem metadata using public question query or document.title
      const slug = problemSlug || fallbackMeta.problemSlug || this.extractSlugFromUrl();
      let questionData = null;
      if (slug) {
        try {
          questionData = await this.fetchQuestionDetails(slug);
        } catch (e) {}
      }

      let frontendId = questionData?.questionFrontendId || questionData?.questionId || fallbackMeta.frontendId;
      let title = questionData?.title || fallbackMeta.title;

      if (!frontendId || !title) {
        const docTitle = document.title || '';
        const titleMatch = docTitle.match(/^(\d+)\.\s*(.+?)(?:\s*-\s*|\s*\|)/);
        if (titleMatch) {
          frontendId = frontendId || titleMatch[1];
          title = title || titleMatch[2];
        } else {
          title = title || (slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'LeetCode Problem');
          frontendId = frontendId || '0';
        }
      }

      // 4. Extract runtime and memory stats from DOM text
      let runtime = null;
      let memory = null;
      let runtimePercentile = null;
      let memoryPercentile = null;

      const statText = document.body ? document.body.innerText : '';
      const runtimeMatch = statText.match(/(\d+(?:\.\d+)?\s*ms)/i);
      if (runtimeMatch) runtime = runtimeMatch[1];
      const memMatch = statText.match(/(\d+(?:\.\d+)?\s*MB)/i);
      if (memMatch) memory = memMatch[1];
      const percMatches = statText.match(/Beats\s+(\d+(?:\.\d+)?%)/gi);
      if (percMatches && percMatches.length > 0) {
        runtimePercentile = percMatches[0].replace(/Beats\s+/i, '');
        if (percMatches.length > 1) {
          memoryPercentile = percMatches[1].replace(/Beats\s+/i, '');
        }
      }

      const paths = this.buildPaths(frontendId, slug, lang);
      const timestamp = Math.floor(Date.now() / 1000);

      const metadata = {
        submission_id: String(submissionId),
        problem_id: String(frontendId),
        frontend_id: String(frontendId),
        problem_title: title,
        problem_slug: slug,
        language: lang,
        timestamp,
        submitted_at: new Date(timestamp * 1000).toISOString(),
        result: 'Accepted',
        runtime: runtime || null,
        runtime_percentile: runtimePercentile || null,
        memory: memory || null,
        memory_percentile: memoryPercentile || null,
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

      // Only process Accepted submissions
      const statusCode = details.statusCode;
      const statusDisplay = details.statusDisplay || fallbackMeta.statusDisplay;
      if (statusCode && statusCode !== 10) {
        console.log(`[LeetCode-Backup] Submission #${submissionId} statusCode is ${statusCode} (not Accepted). Skipping.`);
        return null;
      }
      if (statusDisplay && statusDisplay !== 'Accepted') {
        console.log(`[LeetCode-Backup] Submission #${submissionId} status is "${statusDisplay}" (not Accepted). Skipping.`);
        return null;
      }

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
