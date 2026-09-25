/**
 * Injected via Runtime.evaluate: records the app's HTTP requests for the network tools.
 *
 * - `XMLHttpRequest.prototype` is patched, so axios and every other XHR user is recorded.
 *   React Native's `fetch` is a polyfill over XHR, so its requests are recorded by their XHR.
 * - `globalThis.fetch` is wrapped too. A call that sends no XHR on the same stack is a native
 *   `fetch` (Expo's, for example) and gets its own record with `via: 'fetch-native'`.
 * - Records stay in `__argent_network_log` / `__argent_network_by_id`, which the read scripts
 *   below serve. Each lifecycle step is also pushed to an `__argent_network` binding when one
 *   is defined in the JS context.
 *
 * The script never modifies a request. Idempotent per JS context.
 */
export const NETWORK_INTERCEPTOR_SCRIPT = `(function() {
  var g = globalThis;
  if (g.__argent_network_v2) return JSON.stringify({ installed: false, reason: 'already installed' });
  g.__argent_network_v2 = true;
  // The previous fetch-only script checks this flag; setting it stops an older tool-server
  // from replacing the buffer below with its own.
  g.__argent_network_installed = true;

  var MAX_ENTRIES = 2000;
  var BODY_CAP = 1048576;
  var BUFFER_CAP = 52428800;
  var PUSH_BODY_CAP = 8192;
  var hasOwn = Object.prototype.hasOwnProperty;

  var log = [];
  var byId = {};
  g.__argent_network_log = log;
  g.__argent_network_by_id = byId;
  var nextId = 1;
  var bufferedChars = 0;
  // The wrapped fetch call running on the current stack, if any.
  var activeFetch = null;

  function push(msg) {
    if (typeof g.__argent_network !== 'function') return;
    try { g.__argent_network(JSON.stringify(msg)); } catch (e) {}
  }

  function inlineBody(msg, key, text) {
    if (typeof text !== 'string') return;
    if (text.length <= PUSH_BODY_CAP) msg[key] = text;
    else msg[key + 'Deferred'] = true;
  }

  function bodyChars(entry) {
    return (entry.responseBody ? entry.responseBody.length : 0) +
      (entry.request.postData ? entry.request.postData.length : 0);
  }

  function evict() {
    while (log.length > MAX_ENTRIES || (bufferedChars > BUFFER_CAP && log.length > 0)) {
      var removed = log.shift();
      bufferedChars -= bodyChars(removed);
      delete byId[removed.requestId];
    }
  }

  function utf8Length(text) {
    var n = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  function mimeTypeOf(headers) {
    return hasOwn.call(headers, 'content-type') ? String(headers['content-type']).split(';')[0].trim() : '';
  }

  function headersObject(source) {
    var out = {};
    if (!source || typeof source !== 'object') return out;
    try {
      if (Array.isArray(source)) {
        for (var i = 0; i < source.length; i++) out[String(source[i][0])] = String(source[i][1]);
      } else if (typeof source.forEach === 'function') {
        source.forEach(function(value, name) { out[name] = String(value); });
      } else {
        for (var k in source) if (hasOwn.call(source, k)) out[k] = String(source[k]);
      }
    } catch (e) {}
    return out;
  }

  function parseHeaders(raw) {
    var out = {};
    if (typeof raw !== 'string') return out;
    var lines = raw.split(/\\r?\\n/);
    for (var i = 0; i < lines.length; i++) {
      var at = lines[i].indexOf(':');
      if (at <= 0) continue;
      var name = lines[i].slice(0, at).trim().toLowerCase();
      var value = lines[i].slice(at + 1).trim();
      out[name] = hasOwn.call(out, name) ? out[name] + ', ' + value : value;
    }
    return out;
  }

  function describeFormData(form) {
    var parts = [];
    function file(value) {
      return '<file' + (value && value.name ? ' ' + value.name : '') + (value && value.type ? ' ' + value.type : '') + '>';
    }
    // React Native's FormData lists its parts through getParts().
    var list = form.getParts();
    for (var i = 0; i < list.length; i++) {
      parts.push(list[i].fieldName + '=' + (typeof list[i].string === 'string' ? list[i].string : file(list[i])));
    }
    return '[FormData] ' + parts.join('; ');
  }

  function describeBody(body) {
    if (body == null) return undefined;
    if (typeof body === 'string') return body;
    try {
      if (typeof FormData === 'function' && body instanceof FormData) return describeFormData(body);
      if (typeof Blob === 'function' && body instanceof Blob) return '[Blob ' + body.size + ' bytes]';
      if (typeof ArrayBuffer === 'function' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) {
        return '[binary ' + body.byteLength + ' bytes]';
      }
    } catch (e) {}
    return undefined;
  }

  function createRecord(via, resourceType, method, url, headers, body, startedAt) {
    var id = nextId++;
    var entry = {
      id: id,
      requestId: 'rn-net-' + id,
      state: 'pending',
      via: via,
      resourceType: resourceType,
      request: { url: url, method: method, headers: headers },
      timestamp: startedAt / 1000,
      wallTime: startedAt / 1000
    };
    var postData = describeBody(body);
    if (postData !== undefined) {
      entry.request.postData = postData.length > BODY_CAP ? postData.slice(0, BODY_CAP) : postData;
      if (postData.length > BODY_CAP) entry.request.postDataTruncated = true;
    }
    log.push(entry);
    byId[entry.requestId] = entry;
    bufferedChars += bodyChars(entry);
    evict();
    return { entry: entry, startedAt: startedAt };
  }

  function pushStart(rec) {
    var e = rec.entry;
    var msg = {
      type: 'start', id: e.requestId, via: e.via, resourceType: e.resourceType,
      method: e.request.method, url: e.request.url, headers: e.request.headers,
      postDataTruncated: e.request.postDataTruncated, startedAt: rec.startedAt, rnRequestId: e.rnRequestId
    };
    inlineBody(msg, 'postData', e.request.postData);
    push(msg);
  }

  function setResponse(rec, url, status, statusText, headers) {
    var e = rec.entry;
    e.response = { url: url || e.request.url, status: status, statusText: statusText || '', headers: headers, mimeType: mimeTypeOf(headers) };
    return {
      type: 'headers', id: e.requestId, url: e.response.url, status: status,
      statusText: e.response.statusText, headers: headers, mimeType: e.response.mimeType
    };
  }

  // Ends a request that got a response: stores the body and pushes 'end'.
  function complete(rec, body, byteLength, truncated) {
    var e = rec.entry;
    if (typeof byteLength === 'number') e.encodedDataLength = byteLength;
    if (typeof body === 'string') {
      if (body.length > BODY_CAP) { body = body.slice(0, BODY_CAP); truncated = true; }
      e.responseBody = body;
      if (truncated) e.bodyTruncated = true;
      if (byId[e.requestId] === e) { bufferedChars += body.length; evict(); }
    }
    e.state = 'finished';
    var msg = {
      type: 'end', id: e.requestId, url: e.response && e.response.url, durationMs: e.durationMs,
      encodedDataLength: e.encodedDataLength, bodyTruncated: e.bodyTruncated
    };
    inlineBody(msg, 'body', e.responseBody);
    push(msg);
  }

  function fail(rec, errorText) {
    var e = rec.entry;
    e.state = 'failed';
    e.errorText = errorText;
    e.durationMs = Date.now() - rec.startedAt;
    push({ type: 'error', id: e.requestId, errorText: errorText, durationMs: e.durationMs });
  }

  // ── XMLHttpRequest ──
  var XHR = g.XMLHttpRequest;
  if (typeof XHR === 'function') {
    var slots = new WeakMap();
    // The end handler of each XHR's live request.
    var enders = new WeakMap();
    var proto = XHR.prototype;
    var origOpen = proto.open;
    var origSetRequestHeader = proto.setRequestHeader;
    var origSend = proto.send;
    var origAbort = proto.abort;

    var onHeaders = function(xhr, rec) {
      var raw;
      try { raw = xhr.getAllResponseHeaders(); } catch (e) {}
      var msg = setResponse(rec, xhr.responseURL, xhr.status, xhr.statusText, parseHeaders(raw));
      // RN announces HEADERS_RECEIVED only for the XHR's current request id, so this id is right
      // even when the one read at send was left behind by an earlier, aborted request.
      var id = xhr._requestId;
      if (typeof id === 'number' && id !== rec.entry.rnRequestId) {
        rec.entry.rnRequestId = id;
        msg.rnRequestId = id;
      }
      push(msg);
    };

    // iOS resolves readAsText with null when the cut splits a UTF-8 character, so step back a
    // byte at a time, at most 3 times.
    // The size is read up front: RN's Blob throws on every access once the app closes it.
    var readBlob = function(rec, blob, size, end) {
      var part = end < size ? blob.slice(0, end) : blob;
      var reader = new FileReader();
      reader.onload = function() {
        // A slice holds its own reference to the native blob: release it, so the app's close() frees it.
        if (part !== blob) part.close();
        if (typeof reader.result === 'string' || part === blob || end <= BODY_CAP - 3) {
          return complete(rec, reader.result, size, part !== blob);
        }
        // The app may have closed the blob since the first read.
        try { readBlob(rec, blob, size, end - 1); } catch (e) { complete(rec, undefined, size, false); }
      };
      reader.onerror = function() {
        if (part !== blob) part.close();
        complete(rec, undefined, size, false);
      };
      reader.readAsText(part);
    };

    var readBody = function(rec, xhr) {
      var type = xhr.responseType || '';
      if (type === '' || type === 'text') {
        var text = xhr.responseText;
        if (typeof text === 'string') return complete(rec, text, utf8Length(text), false);
      } else if (type === 'json') {
        var json = xhr.response == null ? undefined : JSON.stringify(xhr.response);
        // Re-serialized, so its length is not the size received: record no size.
        if (typeof json === 'string') return complete(rec, json, undefined, false);
      } else if (type === 'arraybuffer') {
        var buffer = xhr.response;
        return complete(rec, undefined, buffer ? buffer.byteLength : undefined, false);
      } else if (type === 'blob') {
        var blob = xhr.response;
        if (blob) return readBlob(rec, blob, blob.size, Math.min(blob.size, BODY_CAP));
      }
      complete(rec, undefined, undefined, false);
    };

    // Listeners belong to one request and are removed when it ends.
    var listen = function(xhr, rec) {
      var handlers = {
        readystatechange: function() { if (xhr.readyState === 2) onHeaders(xhr, rec); },
        load: function() { end('load'); },
        error: function() { end('error'); },
        timeout: function() { end('timeout'); },
        abort: function() { end('abort'); }
      };
      var end = function(outcome, force) {
        // An end event that finds the XHR no longer DONE belongs to a request the app has already
        // replaced, and the abort patch below recorded how that request ended.
        if (!force && xhr.readyState !== 4) return;
        for (var type in handlers) xhr.removeEventListener(type, handlers[type]);
        if (enders.get(xhr) === end) enders.delete(xhr);
        if (outcome === 'abort') return fail(rec, 'aborted');
        if (outcome === 'timeout') return fail(rec, 'timeout');
        if (outcome === 'error') {
          var text = '';
          try { if (xhr.responseType === '' || xhr.responseType === 'text') text = xhr.responseText; } catch (e) {}
          return fail(rec, text ? String(text) : 'Network error');
        }
        // RN sets responseURL only after it announces HEADERS_RECEIVED: this is the final URL.
        if (rec.entry.response && xhr.responseURL) rec.entry.response.url = xhr.responseURL;
        rec.entry.durationMs = Date.now() - rec.startedAt;
        try { readBody(rec, xhr); } catch (e) { complete(rec, undefined, undefined, false); }
      };
      enders.set(xhr, end);
      // RN switches an XHR to incremental response updates once it has a readystatechange
      // listener. Restore the flag so these listeners do not change how the app gets data.
      var incremental = xhr._incrementalEvents;
      for (var type in handlers) xhr.addEventListener(type, handlers[type]);
      if (typeof incremental === 'boolean') xhr._incrementalEvents = incremental;
    };

    proto.open = function(method, url) {
      var orphan = enders.get(this);
      var previous = slots.get(this);
      // Set before the original open, which dispatches readystatechange: a handler may send from there.
      slots.set(this, { method: String(method || 'GET').toUpperCase(), url: String(url), headers: {} });
      var result;
      try {
        result = origOpen.apply(this, arguments);
      } catch (e) {
        if (previous) slots.set(this, previous);
        else slots.delete(this);
        throw e;
      }
      // Open succeeds only on a reset XHR, so a request still listening here can never end: RN reset
      // it without an end event reaching these listeners (a re-send from inside an abort's own
      // handlers, or an app listener that stopped the event). Drop it before it takes a response.
      if (orphan) orphan('abort', true);
      return result;
    };

    proto.setRequestHeader = function(name, value) {
      var result = origSetRequestHeader.apply(this, arguments);
      var slot = slots.get(this);
      // React Native sends one value per lowercased name, the last one set. RN still accepts a
      // header after send, but it never reaches the wire, so it is not recorded.
      if (slot && slot.headers) slot.headers[String(name).toLowerCase()] = String(value);
      return result;
    };

    proto.send = function(body) {
      var slot = slots.get(this);
      var fetchCall = activeFetch;
      var startedAt = Date.now();
      var result = origSend.apply(this, arguments);
      if (!slot || !slot.headers) return result;
      // A fetch that sends its XHR on the same stack runs over XHR: this record is its only one.
      if (fetchCall) fetchCall.sentXhr = true;
      var rec = createRecord('xhr', fetchCall ? 'Fetch' : 'XHR', slot.method, slot.url, slot.headers, body, startedAt);
      slot.headers = null;
      // Android assigns RN's request id during send; iOS assigns it later (see onHeaders).
      if (typeof this._requestId === 'number') rec.entry.rnRequestId = this._requestId;
      pushStart(rec);
      listen(this, rec);
      return result;
    };

    // To reuse an XHR from its own handler, the app aborts it first, and RN runs that handler
    // before these listeners. Record a request that has already ended before abort resets the XHR.
    // RN keeps _aborted set until the next open, so an abort called from a handler of an abort
    // still counts as one.
    proto.abort = function() {
      var end = enders.get(this);
      if (end && this.readyState === 4) {
        end(this._aborted ? 'abort' : this._hasError ? (this._timedOut ? 'timeout' : 'error') : 'load');
      }
      return origAbort.apply(this, arguments);
    };
  }

  // ── fetch ──
  var origFetch = g.fetch;
  if (typeof origFetch === 'function') {
    // Returns the promise the app gets. It settles like the native one, so a rejection the app
    // never handles is still reported as unhandled.
    var observeNativeFetch = function(input, init, startedAt, promise) {
      var method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
      var url = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : String(input));
      var headers = headersObject(init && init.headers !== undefined ? init.headers : input && input.headers);
      var rec = createRecord('fetch-native', 'Fetch', String(method).toUpperCase(), url, headers, init && init.body, startedAt);
      pushStart(rec);
      return promise.then(function(response) {
        try {
          push(setResponse(rec, response.url, response.status, response.statusText, headersObject(response.headers)));
          // Blob size is the decoded entity's byte length; Content-Length is wrong for HEAD, 304 and compression.
          var sizeClone = response.clone();
          var bodyClone = response.clone();
          var sizePromise = typeof sizeClone.blob === 'function'
            ? sizeClone.blob().then(function(blob) { return blob && typeof blob.size === 'number' ? blob.size : undefined; }, function() { return undefined; })
            : Promise.resolve(undefined);
          var bodyPromise = bodyClone.text().then(null, function() { return undefined; });
          Promise.all([sizePromise, bodyPromise]).then(function(values) {
            rec.entry.durationMs = Date.now() - rec.startedAt;
            complete(rec, values[1], values[0], false);
          });
        } catch (e) {
          rec.entry.durationMs = Date.now() - rec.startedAt;
          complete(rec, undefined, undefined, false);
        }
        return response;
      }, function(err) {
        fail(rec, err ? String(err.message || err) : 'Network error');
        throw err;
      });
    };

    g.fetch = function fetch(input, init) {
      var call = { sentXhr: false };
      var outer = activeFetch;
      var startedAt = Date.now();
      activeFetch = call;
      var promise;
      try {
        promise = origFetch.apply(g, arguments);
      } finally {
        activeFetch = outer;
      }
      if (call.sentXhr || !promise || typeof promise.then !== 'function') return promise;
      try {
        return observeNativeFetch(input, init, startedAt, promise);
      } catch (e) {
        return promise;
      }
    };
  }

  return JSON.stringify({ installed: true });
})()`;

/** Reads a page of captured network logs, minus Metro's own traffic on `metroPort`. */
export function makeNetworkLogReadScript(start: number, limit: number, metroPort: number): string {
  return `(function() {
  var log = globalThis.__argent_network_log;
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

/** Reads one captured request's full details, response body included. */
export function makeNetworkDetailReadScript(requestId: string): string {
  return `(function() {
  var byId = globalThis.__argent_network_by_id;
  if (!byId) return JSON.stringify({ error: 'Network interceptor not installed' });
  var entry = byId[${JSON.stringify(requestId)}];
  if (!entry) return JSON.stringify({ error: 'Request not found' });

  return JSON.stringify({
    id: entry.id,
    requestId: entry.requestId,
    state: entry.state,
    via: entry.via,
    rnRequestId: entry.rnRequestId,
    request: entry.request,
    response: entry.response,
    resourceType: entry.resourceType,
    encodedDataLength: entry.encodedDataLength,
    timestamp: entry.timestamp,
    wallTime: entry.wallTime,
    durationMs: entry.durationMs,
    errorText: entry.errorText,
    initiator: entry.initiator,
    responseBody: entry.responseBody,
    bodyTruncated: entry.bodyTruncated
  });
})()`;
}
