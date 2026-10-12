/**
 * Interceptor for LeetCode Backup Extension (Runs in MAIN World)
 *
 * Hooks into page-level fetch and XMLHttpRequest to detect submission events,
 * capturing the exact submission ID and "Accepted" status directly from
 * LeetCode's network traffic without relying solely on DOM changes.
 */

(function () {
  'use strict';

  if (window.__LEETCODE_BACKUP_INTERCEPTOR_LOADED__) return;
  window.__LEETCODE_BACKUP_INTERCEPTOR_LOADED__ = true;

  function isCurrentRouteContest() {
    const curPath = (window.location.pathname || '').toLowerCase();
    const curHref = (window.location.href || '').toLowerCase();
    return curPath === '/contest' || curPath.startsWith('/contest/') || curHref.includes('/contest');
  }

  // Strict contest exclusion: completely inactive on any contest page
  if (isCurrentRouteContest()) {
    return;
  }

  function notifyAccepted(submissionId, source) {
    if (!submissionId || isCurrentRouteContest()) return;
    try {
      window.postMessage({
        type: 'LEETCODE_SUBMISSION_ACCEPTED',
        submissionId: String(submissionId),
        source: source || 'interceptor',
        timestamp: Date.now()
      }, '*');
    } catch (e) {}
  }

  function notifyStarted(submissionId, source) {
    if (!submissionId || isCurrentRouteContest()) return;
    try {
      window.postMessage({
        type: 'LEETCODE_SUBMISSION_STARTED',
        submissionId: String(submissionId),
        source: source || 'interceptor',
        timestamp: Date.now()
      }, '*');
    } catch (e) {}
  }

  // ==========================================
  // Hook window.fetch
  // ==========================================
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      if (isCurrentRouteContest()) return response;

      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');

      // 1. Intercept /problems/<slug>/submit/ endpoint (returns submission_id)
      if (url.includes('/submit/') || url.endsWith('/submit')) {
        response.clone().json().then(data => {
          const subId = data?.submission_id || data?.submissionId;
          if (subId) {
            notifyStarted(subId, 'fetch_submit');
          }
        }).catch(() => {});
      }

      // 2. Intercept /submissions/detail/<id>/check/ polling endpoint
      const checkMatch = url.match(/\/submissions\/detail\/(\d+)\/check\//);
      if (checkMatch) {
        const submissionId = checkMatch[1];
        response.clone().json().then(data => {
          if (data) {
            const isAccepted =
              data.status_msg === 'Accepted' ||
              data.status_code === 10 ||
              ((data.state === 'SUCCESS' || data.run_success) && data.status_msg === 'Accepted');
            if (isAccepted) {
              notifyAccepted(submissionId, 'fetch_check');
            }
          }
        }).catch(() => {});
      }

      // 3. Intercept GraphQL endpoints
      if (url.includes('/graphql')) {
        const bodyStr = typeof args[1]?.body === 'string' ? args[1].body : '';
        if (
          bodyStr.includes('submissionDetails') ||
          bodyStr.includes('submissionDetail') ||
          bodyStr.includes('submitSolution') ||
          bodyStr.includes('checkSubmission')
        ) {
          response.clone().json().then(data => {
            // Check submit mutation
            const submitData = data?.data?.submitSolution;
            if (submitData?.submissionId || submitData?.id) {
              notifyStarted(submitData.submissionId || submitData.id, 'graphql_submit');
            }

            // Check submission details / result
            const details = data?.data?.submissionDetails || data?.data?.submissionDetail || data?.data?.checkSubmission;
            if (details) {
              const status = details.statusDisplay || details.status_msg || details.statusCode;
              const isAccepted = status === 'Accepted' || status === 10 || details.statusCode === 10;
              const subId = details.id || details.submissionId || details.submission_id;
              if (isAccepted && subId) {
                notifyAccepted(subId, 'graphql_details');
              }
            }
          }).catch(() => {});
        }
      }
    } catch (e) {
      // Ignore interception errors to never disrupt page operation
    }
    return response;
  };

  // ==========================================
  // Hook XMLHttpRequest
  // ==========================================
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._lc_url = url;
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        if (isCurrentRouteContest()) return;

        const url = this._lc_url || '';

        // Check submit endpoint
        if (url.includes('/submit/') || url.endsWith('/submit')) {
          const data = JSON.parse(this.responseText);
          const subId = data?.submission_id || data?.submissionId;
          if (subId) {
            notifyStarted(subId, 'xhr_submit');
          }
        }

        // Check detail polling
        const checkMatch = url.match(/\/submissions\/detail\/(\d+)\/check\//);
        if (checkMatch && this.responseText) {
          const submissionId = checkMatch[1];
          const data = JSON.parse(this.responseText);
          if (data) {
            const isAccepted =
              data.status_msg === 'Accepted' ||
              data.status_code === 10 ||
              ((data.state === 'SUCCESS' || data.run_success) && data.status_msg === 'Accepted');
            if (isAccepted) {
              notifyAccepted(submissionId, 'xhr_check');
            }
          }
        }
      } catch (e) {}
    });
    return originalSend.apply(this, args);
  };
})();
