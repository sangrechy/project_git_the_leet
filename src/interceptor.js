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

  function notifyAccepted(submissionId, source) {
    if (!submissionId) return;
    try {
      window.postMessage({
        type: 'LEETCODE_SUBMISSION_ACCEPTED',
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
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');

      // 1. Intercept /submissions/detail/<id>/check/ polling endpoint
      const checkMatch = url.match(/\/submissions\/detail\/(\d+)\/check\//);
      if (checkMatch) {
        const submissionId = checkMatch[1];
        response.clone().json().then(data => {
          if (data && (data.state === 'SUCCESS' || data.run_success) && data.status_msg === 'Accepted') {
            notifyAccepted(submissionId, 'fetch_check');
          }
        }).catch(() => {});
      }

      // 2. Intercept GraphQL endpoints
      if (url.includes('/graphql') && args[1] && typeof args[1].body === 'string') {
        const bodyStr = args[1].body;
        if (
          bodyStr.includes('submissionDetails') ||
          bodyStr.includes('submissionDetail') ||
          bodyStr.includes('submitSolution')
        ) {
          response.clone().json().then(data => {
            const details = data?.data?.submissionDetails || data?.data?.submissionDetail;
            if (details) {
              const status = details.statusDisplay || details.statusCode;
              const isAccepted = status === 'Accepted' || status === 10 || details.statusCode === 10;
              const subId = details.id || details.submissionId;
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
        const url = this._lc_url || '';
        const checkMatch = url.match(/\/submissions\/detail\/(\d+)\/check\//);
        if (checkMatch && this.responseText) {
          const submissionId = checkMatch[1];
          const data = JSON.parse(this.responseText);
          if (data && (data.state === 'SUCCESS' || data.run_success) && data.status_msg === 'Accepted') {
            notifyAccepted(submissionId, 'xhr_check');
          }
        }
      } catch (e) {}
    });
    return originalSend.apply(this, args);
  };
})();
