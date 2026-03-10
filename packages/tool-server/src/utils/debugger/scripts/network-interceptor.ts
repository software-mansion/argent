/**
 * JS script injected via Runtime.evaluate to intercept network requests.
 * Monkey-patches globalThis.fetch and XMLHttpRequest to capture request/response
 * metadata and store them in globalThis.__radon_network_log.
 *
 * The network tools read this array via Runtime.evaluate to fetch captured logs.
 * Each entry follows the NetworkLogEntry shape used by the tools.
 *
 * Designed to be idempotent — calling it twice won't double-patch.
 */
export const NETWORK_INTERCEPTOR_SCRIPT = `(function() {
  if (globalThis.__radon_network_installed) return JSON.stringify({ installed: false, reason: 'already installed' });
  globalThis.__radon_network_installed = true;

  var log = [];
  globalThis.__radon_network_log = log;
  var byId = {};
  globalThis.__radon_network_by_id = byId;
  var nextReqId = 1;
  var MAX_ENTRIES = 2000;
  function genId() { return 'rn-net-' + (nextReqId++); }
  function ts() { return Date.now() / 1000; }

  function getOrCreate(reqId) {
    if (byId[reqId]) return byId[reqId];
    var entry = {
      id: log.length,
      requestId: reqId,
      state: 'pending'
    };
    log.push(entry);
    byId[reqId] = entry;
    if (log.length > MAX_ENTRIES) {
      var removed = log.splice(0, log.length - MAX_ENTRIES);
      for (var i = 0; i < removed.length; i++) {
        delete byId[removed[i].requestId];
      }
    }
    return entry;
  }

  // ── Patch fetch ──
  var origFetch = globalThis.fetch;
  if (origFetch) {
    globalThis.fetch = function(input, init) {
      var reqId = genId();
      var method = (init && init.method) ? init.method.toUpperCase() : 'GET';
      var url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
      var headers = {};
      if (init && init.headers) {
        if (typeof init.headers.forEach === 'function') {
          init.headers.forEach(function(v, k) { headers[k] = v; });
        } else if (typeof init.headers === 'object') {
          var ks = Object.keys(init.headers);
          for (var i = 0; i < ks.length; i++) { headers[ks[i]] = String(init.headers[ks[i]]); }
        }
      }
      var postData = (init && init.body && typeof init.body === 'string') ? init.body : undefined;
      var t = ts();

      var entry = getOrCreate(reqId);
      entry.request = { url: url, method: method, headers: headers, postData: postData };
      entry.timestamp = t;
      entry.wallTime = t;
      entry.resourceType = 'Fetch';

      return origFetch.apply(globalThis, arguments).then(function(response) {
        var respHeaders = {};
        if (response.headers && typeof response.headers.forEach === 'function') {
          response.headers.forEach(function(v, k) { respHeaders[k] = v; });
        }
        var contentType = respHeaders['content-type'] || '';
        var mimeType = contentType.split(';')[0].trim();

        entry.response = {
          url: response.url || url,
          status: response.status,
          statusText: response.statusText || '',
          headers: respHeaders,
          mimeType: mimeType
        };

        var cloned = response.clone();
        cloned.text().then(function(body) {
          entry.state = 'finished';
          entry.encodedDataLength = body.length;
          entry.durationMs = Math.round((ts() - t) * 1000);
          entry.responseBody = body;
        }).catch(function() {
          entry.state = 'finished';
          entry.encodedDataLength = 0;
          entry.durationMs = Math.round((ts() - t) * 1000);
        });

        return response;
      }).catch(function(err) {
        entry.state = 'failed';
        entry.errorText = err ? (err.message || String(err)) : 'Network error';
        entry.durationMs = Math.round((ts() - t) * 1000);
        throw err;
      });
    };
  }

  // Note: XHR is intentionally NOT patched. In React Native, fetch() is built
  // on top of XMLHttpRequest internally, so patching both would double-count
  // every request. Since virtually all RN code uses fetch(), patching only
  // fetch captures all meaningful traffic without duplicates.

  return JSON.stringify({ installed: true });
})()`;

/**
 * Script to read captured network logs from the JS runtime.
 * Returns JSON with the entries array and total count.
 * Accepts optional start index and limit for pagination.
 */
export function makeNetworkLogReadScript(
  start: number,
  limit: number,
  metroPort: number,
): string {
  return `(function() {
  var log = globalThis.__radon_network_log;
  if (!log) return JSON.stringify({ entries: [], total: 0, interceptorInstalled: false });

  // Filter out requests to the Metro server
  var filtered = [];
  for (var i = 0; i < log.length; i++) {
    var e = log[i];
    if (e.request && e.request.url) {
      try {
        var u = e.request.url;
        if ((u.indexOf('://localhost:${metroPort}') !== -1 || u.indexOf('://127.0.0.1:${metroPort}') !== -1)) continue;
      } catch(ex) {}
    }
    filtered.push(e);
  }

  var total = filtered.length;
  var start = ${start};
  var limit = ${limit};
  var slice = filtered.slice(start, start + limit);

  // Strip responseBody from list view (too large)
  var entries = [];
  for (var j = 0; j < slice.length; j++) {
    var s = slice[j];
    entries.push({
      id: s.id,
      requestId: s.requestId,
      state: s.state,
      request: s.request ? { url: s.request.url, method: s.request.method } : undefined,
      response: s.response ? { status: s.response.status, statusText: s.response.statusText, mimeType: s.response.mimeType } : undefined,
      resourceType: s.resourceType,
      encodedDataLength: s.encodedDataLength,
      timestamp: s.timestamp,
      durationMs: s.durationMs,
      errorText: s.errorText
    });
  }

  return JSON.stringify({ entries: entries, total: total, interceptorInstalled: true });
})()`;
}

/**
 * Script to read a single network request's full details from the JS runtime.
 */
export function makeNetworkDetailReadScript(
  requestId: string,
  metroPort: number,
): string {
  return `(function() {
  var byId = globalThis.__radon_network_by_id;
  if (!byId) return JSON.stringify({ error: 'Network interceptor not installed' });
  var entry = byId['${requestId.replace(/'/g, "\\'")}'];
  if (!entry) return JSON.stringify({ error: 'Request not found' });

  return JSON.stringify({
    id: entry.id,
    requestId: entry.requestId,
    state: entry.state,
    request: entry.request,
    response: entry.response,
    resourceType: entry.resourceType,
    encodedDataLength: entry.encodedDataLength,
    timestamp: entry.timestamp,
    wallTime: entry.wallTime,
    durationMs: entry.durationMs,
    errorText: entry.errorText,
    initiator: entry.initiator,
    responseBody: entry.responseBody
  });
})()`;
}
