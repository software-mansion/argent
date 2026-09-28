/**
 * Injected via Runtime.evaluate: records the app's HTTP requests for the network tools.
 *
 * Each request is recorded where it leaves JavaScript, so a request of XHR or of React Native's or
 * Expo's `fetch` has one record whatever the app's own wrappers of `fetch` do with it:
 * - `XMLHttpRequest.prototype` is patched: axios and every other XHR user, and React Native's
 *   `fetch`, which is a polyfill over XHR.
 * - Expo's native `fetch` (`expo/fetch`, the global `fetch` on Expo SDK 56+) sends each request
 *   through a `NativeRequest` of its native module, which is patched too.
 * - A fetch library that calls React Native's native network module itself (react-native-fetch-api)
 *   sends neither. It also installs its own global Response class, and only then is
 *   `globalThis.fetch` wrapped: each call is recorded, and the record goes again when the call
 *   turns out to be no request of its own.
 * - Records stay in `__argent_network_log` / `__argent_network_by_id`, which the read scripts
 *   below serve.
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
  var hasOwn = Object.prototype.hasOwnProperty;

  var log = [];
  var byId = {};
  g.__argent_network_log = log;
  g.__argent_network_by_id = byId;
  var nextId = 1;
  var bufferedChars = 0;
  // XHRs and Expo requests sent so far. While calls of a fetch library (below) are in flight, the
  // method, URL and text body of each send are noted too.
  var transportSends = 0;
  var lastSends = [];
  var inFlight = [];

  function noteSend(method, url, body) {
    transportSends++;
    if (!inFlight.length) return;
    lastSends.push({ n: transportSends, method: method, url: url, body: typeof body === 'string' ? bodyKey(body) : undefined });
    if (lastSends.length > 500) lastSends.shift();
  }

  // Tells request bodies apart without keeping them: a text up to 4096 characters as it is, a longer
  // one by its length, its start and end and 128 short pieces spread over it, and an object by a
  // number of its own.
  var bodyIds = new WeakMap();
  var nextBodyId = 1;
  function bodyKey(body) {
    if (body == null) return undefined;
    if (typeof body === 'object' || typeof body === 'function') {
      var id = bodyIds.get(body);
      if (!id) { id = nextBodyId++; bodyIds.set(body, id); }
      return id;
    }
    var text = String(body);
    if (text.length <= 4096) return text;
    var key = text.length + ':' + text.slice(0, 512) + text.slice(-512);
    var step = Math.floor((text.length - 1024) / 128);
    for (var i = 0, at = 512; i < 128; i++, at += step) key += text.substr(at, 8);
    return key;
  }

  function bodyChars(entry) {
    return (entry.responseBody ? entry.responseBody.length : 0) +
      (entry.request.postData ? entry.request.postData.length : 0) +
      (entry.bodyBytes ? entry.bodyBytes.byteLength : 0) + (entry.postBytes ? entry.postBytes.byteLength : 0);
  }

  function evict() {
    while (log.length > MAX_ENTRIES || (bufferedChars > BUFFER_CAP && log.length > 0)) {
      var removed = log.shift();
      bufferedChars -= bodyChars(removed);
      delete byId[removed.requestId];
    }
  }

  // Runs on the app's JS thread for every text response. The loop costs about 200 ms per MiB in
  // Hermes with a debugger attached, so the native checks go first.
  function utf8Length(text) {
    try {
      if (/^[\\x00-\\x7f]*$/.test(text)) return text.length;
      if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
    } catch (e) {}
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

  // The text of UTF-8 bytes, cut at BODY_CAP on a character boundary; undefined when they are not
  // UTF-8 or no decoder exists (React Native has none; Expo installs one).
  function utf8Text(bytes) {
    if (typeof TextDecoder !== 'function') return undefined;
    var end = Math.min(bytes.byteLength, BODY_CAP);
    if (end < bytes.byteLength) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)); } catch (e) { return undefined; }
  }

  // Bodies of bytes are kept as bytes, 3 past the cap to let utf8Text step back to a character
  // boundary, and decoded only when the agent reads the record: Expo SDK 54 and 55 install a
  // TextDecoder written in JS, which would stop the app's JS thread for each request.
  // A copy even of a subclass whose slice() returns a view (the Buffer of the buffer package).
  function keepBytes(bytes) {
    return Uint8Array.prototype.slice.call(bytes, 0, BODY_CAP + 3);
  }

  function decodeBodies(entry) {
    if (!entry.postBytes && !entry.bodyBytes) return;
    var before = bodyChars(entry);
    if (entry.postBytes) {
      // Expo hands its native request the body as bytes: they show as text when they are UTF-8.
      var post = utf8Text(entry.postBytes);
      entry.request.postData = post === undefined ? '[binary ' + entry.postSize + ' bytes]' : post;
      if (post !== undefined && entry.postSize > BODY_CAP) entry.request.postDataTruncated = true;
      delete entry.postBytes;
      delete entry.postSize;
    }
    if (entry.bodyBytes) {
      var body = utf8Text(entry.bodyBytes);
      if (body !== undefined) {
        entry.responseBody = body;
        if (entry.encodedDataLength > BODY_CAP) entry.bodyTruncated = true;
      }
      delete entry.bodyBytes;
    }
    bufferedChars += bodyChars(entry) - before;
    evict();
  }
  g.__argent_network_decode = decodeBodies;

  // What a request body shows, and whether that is only its start.
  function describeBody(body) {
    var text;
    try {
      if (body == null) return undefined;
      if (typeof body === 'string') text = body;
      else if (typeof FormData === 'function' && body instanceof FormData) text = describeFormData(body);
      else if (typeof Blob === 'function' && body instanceof Blob) text = '[Blob ' + body.size + ' bytes]';
      else if (typeof Uint8Array === 'function' && body instanceof Uint8Array) return { bytes: keepBytes(body), size: body.byteLength };
      else if (typeof ArrayBuffer === 'function' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) {
        text = '[binary ' + body.byteLength + ' bytes]';
      }
    } catch (e) {}
    if (text === undefined) return undefined;
    return text.length > BODY_CAP ? { text: text.slice(0, BODY_CAP), cut: true } : { text: text, cut: false };
  }

  function createRecord(resourceType, method, url, headers, body, startedAt) {
    var id = nextId++;
    var entry = {
      id: id,
      requestId: 'rn-net-' + id,
      state: 'pending',
      resourceType: resourceType,
      request: { url: url, method: method, headers: headers },
      timestamp: startedAt / 1000
    };
    var postData = describeBody(body);
    if (postData && postData.bytes) {
      entry.postBytes = postData.bytes;
      entry.postSize = postData.size;
    } else if (postData) {
      entry.request.postData = postData.text;
      if (postData.cut) entry.request.postDataTruncated = true;
    }
    log.push(entry);
    byId[entry.requestId] = entry;
    bufferedChars += bodyChars(entry);
    evict();
    return { entry: entry, startedAt: startedAt };
  }

  function setResponse(rec, url, status, statusText, headers) {
    var e = rec.entry;
    e.response = { url: url || e.request.url, status: status, statusText: statusText || '', headers: headers, mimeType: mimeTypeOf(headers) };
  }

  // Stores the body of a response, once: text, or bytes that keepBytes cut.
  function storeBody(rec, body, byteLength, truncated) {
    var e = rec.entry;
    if (e.responseBody !== undefined || e.encodedDataLength !== undefined) return;
    if (typeof byteLength === 'number') e.encodedDataLength = byteLength;
    if (body instanceof Uint8Array) {
      e.bodyBytes = body;
      if (byId[e.requestId] === e) { bufferedChars += body.byteLength; evict(); }
    } else if (typeof body === 'string') {
      if (body.length > BODY_CAP) { body = body.slice(0, BODY_CAP); truncated = true; }
      e.responseBody = body;
      if (truncated) e.bodyTruncated = true;
      if (byId[e.requestId] === e) { bufferedChars += body.length; evict(); }
    }
  }

  // Ends a request that got a response and stores its body. A request that failed meanwhile (the
  // app aborted it while its body was read) stays failed.
  function complete(rec, body, byteLength, truncated) {
    if (rec.entry.state === 'failed') return;
    storeBody(rec, body, byteLength, truncated);
    rec.entry.state = 'finished';
  }

  function fail(rec, errorText) {
    var e = rec.entry;
    e.state = 'failed';
    e.errorText = errorText;
    e.durationMs = Date.now() - rec.startedAt;
  }

  // ── XMLHttpRequest ──
  var XHR = g.XMLHttpRequest;
  if (typeof XHR === 'function') {
    var slots = new WeakMap();
    // The record and the end handler of each XHR's live request.
    var live = new WeakMap();
    var proto = XHR.prototype;
    var origOpen = proto.open;
    var origSetRequestHeader = proto.setRequestHeader;
    var origSend = proto.send;
    var origAbort = proto.abort;

    var onHeaders = function(xhr, rec) {
      var raw;
      try { raw = xhr.getAllResponseHeaders(); } catch (e) {}
      setResponse(rec, xhr.responseURL, xhr.status, xhr.statusText, parseHeaders(raw));
    };

    // An XHR that React Native's fetch sends: it reads every response as a blob (as an arraybuffer
    // where Blob is unavailable) and sets these handlers. axios sets onloadend, not onload.
    var isFetchXhr = function(xhr) {
      return (xhr.responseType === 'blob' || xhr.responseType === 'arraybuffer') && typeof xhr.onload === 'function' &&
        typeof xhr.onabort === 'function' && typeof xhr.ontimeout === 'function';
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
        if (live.has(xhr) && live.get(xhr).end === end) live.delete(xhr);
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
      live.set(xhr, { rec: rec, end: end });
      // RN switches an XHR to incremental response updates once it has a readystatechange
      // listener. Restore the flag so these listeners do not change how the app gets data.
      var incremental = xhr._incrementalEvents;
      for (var type in handlers) xhr.addEventListener(type, handlers[type]);
      if (typeof incremental === 'boolean') xhr._incrementalEvents = incremental;
    };

    proto.open = function(method, url) {
      var orphan = live.get(this);
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
      if (orphan) orphan.end('abort', true);
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
      var startedAt = Date.now();
      var result = origSend.apply(this, arguments);
      if (!slot || !slot.headers) return result;
      var rec = createRecord(isFetchXhr(this) ? 'Fetch' : 'XHR', slot.method, slot.url, slot.headers, body, startedAt);
      noteSend(slot.method, slot.url, body);
      slot.headers = null;
      listen(this, rec);
      return result;
    };

    // To reuse an XHR from its own handler, the app aborts it first, and RN runs that handler
    // before these listeners. Record a request that has already ended before abort resets the XHR.
    // RN keeps _aborted set until the next open, so an abort called from a handler of an abort
    // still counts as one. An app can also abort from its own handler of HEADERS_RECEIVED, which
    // runs before the listener that records the headers: keep them.
    proto.abort = function() {
      var request = live.get(this);
      if (request && this.readyState >= 2 && !request.rec.entry.response) onHeaders(this, request.rec);
      if (request && this.readyState === 4) {
        request.end(this._aborted ? 'abort' : this._hasError ? (this._timedOut ? 'timeout' : 'error') : 'load');
      }
      return origAbort.apply(this, arguments);
    };
  }

  // ── Expo's native fetch ──
  // expo/fetch builds each request as new NativeRequest(response) and sends it with start(url, init,
  // body), whether the app calls it as the global fetch or imports it. The app gets that response
  // once start resolves.
  var expoFetch;
  try { expoFetch = g.expo && g.expo.modules && g.expo.modules.ExpoFetchModule; } catch (e) {}
  // Takes the whole body of a response from native, for the app to get at its first read. It stays
  // null when Expo's module cannot hand a body back (see below).
  var takeBody = null;

  // Hands each result of an object's method to tap as well. track(1) runs when a call starts and
  // track(-1) once its promise settles. The caller gets a promise that settles like the original, so
  // a rejection it never handles is still reported as unhandled.
  function tapMethod(target, name, tap, track) {
    var method = target[name];
    if (typeof method !== 'function') return;
    target[name] = function() {
      var result = method.apply(this, arguments);
      if (!result || typeof result.then !== 'function') return result;
      track(1);
      return result.then(function(value) {
        try { tap(value); } catch (e) {}
        track(-1);
        return value;
      }, function(error) {
        track(-1);
        throw error;
      });
    };
  }

  // Native Expo hands a body out once, so reading it here while the request runs, or through a clone,
  // would take it from the app or make it wait. The body is taken as the app reads it: its text() or
  // arrayBuffer() (json(), blob() and bytes() go through them), or the chunks of its body stream. A
  // 2xx body the app never reads is not recorded. The native side announces the end of every request with
  // readyForJSFinalization, a failed one too, and that event can come before start rejects: the
  // record ends only once start resolved. The body can be complete before JS gets that event: a
  // whole body the app reads, or didComplete after the chunks it streams, ends the record too. So an
  // app that aborts once it has the body (urql, graphql-sse) does not make the request fail. A read
  // of the app still in flight holds the record: on iOS, when the connection drops in the middle of
  // the body, the event can say nothing of the drop, and the read then never settles. The record
  // stays pending, as the app's read does.
  // Apps often do not read the body of an error response (if (!response.ok) throw ...), and that
  // body is what the agent needs. Once the request has ended, and the app has not started to read
  // the body in the turn after, such a body is taken from native. The app gets it at its first read.
  function observeExpoResponse(rec, response, started) {
    var chunks = [];
    var kept = 0;
    var streamed = 0;
    var endedAt = 0;
    var responded = false;
    var reading = 0;
    var read = false;
    var finalized = false;
    var stalled = false;
    var completed = false;
    // Keeps as many bytes of the chunks as keepBytes keeps of a whole body.
    var take = function(data) {
      if (!data || typeof data.byteLength !== 'number') return;
      var view = ArrayBuffer.isView(data) ? data : new Uint8Array(data);
      streamed += view.byteLength;
      if (kept >= BODY_CAP + 3) return;
      chunks.push(new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + Math.min(view.byteLength, BODY_CAP + 3 - kept))));
      kept += chunks[chunks.length - 1].byteLength;
    };
    // A whole body, which can come after the request ended.
    var takeWhole = function(data) {
      if (!data || typeof data.byteLength !== 'number' || rec.entry.state === 'failed') return;
      var bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      storeBody(rec, keepBytes(bytes), bytes.byteLength);
    };
    var onData = function(data) { take(data); };
    var onFail = function(error) { if (rec.entry.state === 'pending') fail(rec, String(error)); };
    // Returns whether it holds the record for a take of the body.
    var tried = false;
    var takeUnread = function() {
      if (tried) return false;
      tried = true;
      var status = rec.entry.response.status;
      if (rec.entry.request.method === 'HEAD' || status === 204 || status === 205 || status === 304 ||
        rec.entry.response.headers['content-length'] === '0') {
        storeBody(rec, '', 0, false);
        return false;
      }
      if ((status >= 200 && status < 300) || !takeBody) return false;
      var release = function() {
        reading--;
        finish();
      };
      // The app gets a turn to start its own read: on iOS, SDK 55 resolves fetch only once the request
      // ended.
      reading++;
      setTimeout(function() {
        var body = read ? undefined : takeBody(response);
        if (!body) return release();
        body.then(function(data) {
          if (data != null) takeWhole(data);
          release();
        }, release);
      }, 0);
      return true;
    };
    var finish = function() {
      if (!endedAt || !responded || reading || stalled || rec.entry.state !== 'pending') return;
      if (!read && !streamed && takeUnread()) return;
      rec.entry.durationMs = endedAt - rec.startedAt;
      if (!streamed) return complete(rec, undefined, undefined, false);
      var bytes = new Uint8Array(kept);
      for (var i = 0, at = 0; i < chunks.length; at += chunks[i].byteLength, i++) bytes.set(chunks[i], at);
      complete(rec, bytes, streamed);
    };
    var bodyEnded = function() {
      if (!endedAt) endedAt = Date.now();
    };
    var ended = function() {
      bodyEnded();
      finish();
    };
    var track = function(step) {
      read = true;
      // A read that starts once the record ended without a body can hang too, and holds it again.
      if (step > 0 && rec.entry.state === 'finished' && rec.entry.encodedDataLength === undefined) rec.entry.state = 'pending';
      reading += step;
      finish();
    };
    var onEnd = function() {
      try { response.removeListener('readyForJSFinalization', onEnd); } catch (e) {}
      finalized = true;
      ended();
    };
    // Expo drops the stream listeners itself when the request ends.
    response.addListener('didReceiveResponseData', onData);
    response.addListener('didComplete', function() {
      completed = true;
      ended();
    });
    response.addListener('didFailWithError', onFail);
    response.addListener('readyForJSFinalization', onEnd);
    // startStreaming returns the whole body when it completed before the app opened its stream (on
    // iOS, SDK 55 resolves fetch only then), else null and the chunks follow as events.
    tapMethod(response, 'startStreaming', function(data) {
      // Once the request ended, native answers null only when the body did not complete: the app's
      // stream then never ends, and the record stays pending. On Android, SDK 55 can deliver the null
      // of a stream it started after the stream's didComplete and the end: that stream is whole.
      if (data == null) {
        if (finalized && !completed) stalled = true;
        return;
      }
      takeWhole(data);
      bodyEnded();
    }, track);
    tapMethod(response, 'arrayBuffer', function(data) {
      takeWhole(data);
      bodyEnded();
    }, track);
    tapMethod(response, 'text', function(text) {
      if (typeof text === 'string' && rec.entry.state !== 'failed') storeBody(rec, text, utf8Length(text), false);
      bodyEnded();
    }, track);
    started.then(function() {
      if (rec.entry.state === 'failed') return;
      setResponse(rec, response.url, response.status, response.statusText, headersObject(response.headers));
      responded = true;
      finish();
    }, function(err) {
      if (rec.entry.state === 'pending') fail(rec, err ? String(err.message || err) : 'Network error');
    });
  }

  if (expoFetch && typeof expoFetch.NativeRequest === 'function' && typeof expoFetch.NativeRequest.prototype.start === 'function' &&
    typeof Proxy === 'function' && typeof Reflect === 'object') {
    var NativeRequest = expoFetch.NativeRequest;
    var nativeProto = NativeRequest.prototype;
    var origStart = nativeProto.start;
    var origCancel = nativeProto.cancel;
    // The response each request fills, and the record of each request sent.
    var responses = new WeakMap();
    var nativeRecords = new WeakMap();
    try {
      expoFetch.NativeRequest = new Proxy(NativeRequest, {
        construct: function(target, args, newTarget) {
          var request = Reflect.construct(target, args, newTarget);
          if (args[0] && typeof args[0] === 'object') responses.set(request, args[0]);
          return request;
        }
      });
    } catch (e) {}
    if (expoFetch.NativeRequest !== NativeRequest) {
      nativeProto.start = function(url, init, body) {
        var startedAt = Date.now();
        var promise = origStart.apply(this, arguments);
        var response = responses.get(this);
        if (!response || !promise || typeof promise.then !== 'function') return promise;
        try {
          var rec = createRecord('Fetch', String((init && init.method) || 'GET').toUpperCase(), String(url),
            headersObject(init && init.headers), body, startedAt);
          noteSend(rec.entry.request.method, rec.entry.request.url, body);
          nativeRecords.set(this, rec);
          observeExpoResponse(rec, response, promise);
        } catch (e) {}
        return promise;
      };
      // expo/fetch cancels the request when the app aborts it, also while the app reads the body.
      if (typeof origCancel === 'function') {
        nativeProto.cancel = function() {
          var rec = nativeRecords.get(this);
          if (rec && rec.entry.state === 'pending') fail(rec, 'aborted');
          return origCancel.apply(this, arguments);
        };
      }
      // Native hands a body out once. A body taken for the record goes to the first read of the app
      // instead, through the native methods that expo/fetch reads with. Expo's own response, its
      // listeners and its body stream stay as they are.
      var responseProto = expoFetch.NativeResponse && expoFetch.NativeResponse.prototype;
      if (responseProto && typeof responseProto.arrayBuffer === 'function' && typeof responseProto.text === 'function' &&
        typeof responseProto.startStreaming === 'function' && typeof TextDecoder === 'function') {
        var takenBodies = new WeakMap();
        var origStartStreaming = responseProto.startStreaming;
        var handBack = function(name, convert) {
          var original = responseProto[name];
          var patched = function() {
            var body = takenBodies.get(this);
            if (!body) return original.apply(this, arguments);
            takenBodies.delete(this);
            var self = this, args = arguments;
            // Nothing taken (the body did not complete): native answers as it would have.
            return body.then(function(data) { return data == null ? original.apply(self, args) : convert(data); });
          };
          try { responseProto[name] = patched; } catch (e) {}
          return responseProto[name] === patched;
        };
        var handed = [
          handBack('arrayBuffer', function(data) {
            return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer :
              data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          }),
          handBack('startStreaming', function(data) { return data; }),
          // As native text(): a byte order mark stays, and bytes that are not UTF-8 become U+FFFD. This
          // decode runs on the app's JS thread, only for an error body the app reads a turn or more
          // after the request ended.
          handBack('text', function(data) { return new TextDecoder('utf-8', { ignoreBOM: true }).decode(data); })
        ];
        if (handed[0] && handed[1] && handed[2]) {
          // Once the request ended, native startStreaming returns the whole body, or null when the body
          // did not complete, and does not wait.
          takeBody = function(response) {
            var body = origStartStreaming.call(response);
            if (!body || typeof body.then !== 'function') return undefined;
            takenBodies.set(response, body);
            return body;
          };
        }
      }
    }
  }

  // ── Another fetch library ──
  // react-native-fetch-api (installed by react-native-polyfill-globals) calls React Native's native
  // network module itself, so it sends neither an XHR nor an Expo request. It replaces the global
  // Response class too, while React Native and Expo keep whatwg-fetch's (it has _initBody). Only then
  // is the global fetch wrapped. Each call gets a record when the app makes it. The record goes again
  // when the call turns out to be no request of its own: it resolves with no Response of that class
  // (an app's cache, or its own class around the Response of React Native's or Expo's fetch), or it
  // settles with what another call already got.
  var LibResponse = g.Response;
  var origFetch = g.fetch;
  var libFetch = false;
  try {
    libFetch = typeof origFetch === 'function' && typeof LibResponse === 'function' && !!LibResponse.prototype &&
      !('_initBody' in LibResponse.prototype);
  } catch (e) {}
  if (libFetch) {
    // A Response copied from another shares its body source with it: the blob data of the library's
    // default Response, or the stream or bytes of its body. A call that resolves with the source of a
    // recorded call got a copy of that call's Response from the app's wrapper or cache, and gets no
    // record of its own. Separate requests have sources of their own, so each keeps its record.
    // A Response without such a source falls back on the calls recorded: a call with the same method,
    // URL and body that was in flight with one of them is taken as such a copy. Calls are ordered by a
    // counter, not the clock: a call the app sends from the handler of a response (a retry, a poll)
    // starts after that response, in the same millisecond. A recorded call leaves that list once no
    // call in flight started before it ended.
    var libCalls = [];
    var recorded = new WeakSet();
    var libSteps = 0;
    var sourceOf = function(response) {
      var source = response._blobData || (response._body && response._body._bodyInit);
      return source && typeof source === 'object' ? source : null;
    };
    var settled = function(call) {
      var at = inFlight.indexOf(call);
      if (at !== -1) inFlight.splice(at, 1);
      var first = inFlight.length ? inFlight[0].start : libSteps + 1;
      while (libCalls.length && libCalls[0].end < first) libCalls.shift();
      var firstSent = inFlight.length ? inFlight[0].sentBefore : transportSends;
      while (lastSends.length && lastSends[0].n <= firstSent) lastSends.shift();
    };
    var dropRecord = function(entry) {
      var at = log.lastIndexOf(entry);
      if (at === -1) return;
      log.splice(at, 1);
      delete byId[entry.requestId];
      bufferedChars -= bodyChars(entry);
    };
    g.fetch = function fetch(input, init) {
      var call, rec, promise;
      try {
        var method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
        var url = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : String(input));
        // A Request the app passes holds its own body.
        var body = init && init.body !== undefined ? init.body : input && typeof input === 'object' && input._body ? input._body._bodyInit : undefined;
        call = { startedAt: Date.now(), start: ++libSteps, sentBefore: transportSends, method: method, url: url, body: bodyKey(body) };
        rec = createRecord('Fetch', method, url, headersObject(init && init.headers !== undefined ? init.headers : input && input.headers),
          body, call.startedAt);
        // In flight before the library runs: a wrapper over React Native's fetch sends its XHR at once,
        // inside the call.
        inFlight.push(call);
      } catch (e) {}
      try {
        promise = origFetch.apply(g, arguments);
      } catch (e) {
        // A call that throws (an aborted signal) sent nothing.
        if (rec) {
          dropRecord(rec.entry);
          settled(call);
        }
        throw e;
      }
      if (!rec || !promise || typeof promise.then !== 'function') {
        if (rec) {
          dropRecord(rec.entry);
          settled(call);
        }
        return promise;
      }
      // The app gets a promise that settles like the original, so a rejection it never handles is
      // still reported as unhandled.
      return promise.then(function(response) {
        try { settleLibFetch(call, rec, response, false); } catch (e) {}
        settled(call);
        return response;
      }, function(error) {
        try { settleLibFetch(call, rec, error, true); } catch (e) {}
        settled(call);
        throw error;
      });
    };
    var settleLibFetch = function(call, rec, outcome, failed) {
      if (!failed && !(outcome instanceof LibResponse)) return dropRecord(rec.entry);
      var shared = !!outcome && typeof outcome === 'object';
      var source = failed ? null : sourceOf(outcome);
      if ((shared && recorded.has(outcome)) || (source && recorded.has(source))) return dropRecord(rec.entry);
      if (shared) recorded.add(outcome);
      if (source) recorded.add(source);
      // An XHR or Expo request with the same method and URL, sent during the call, may be the request
      // of the call (an app wrapper that builds this Response from React Native's fetch), and that
      // request has its record. Text bodies that differ tell two requests apart. Other requests the
      // app sends meanwhile do not matter.
      for (var j = lastSends.length - 1; j >= 0 && lastSends[j].n > call.sentBefore; j--) {
        var send = lastSends[j];
        if (send.method === call.method && send.url === call.url &&
          !(typeof send.body === 'string' && typeof call.body === 'string' && send.body !== call.body)) return dropRecord(rec.entry);
      }
      call.endedAt = Date.now();
      call.end = ++libSteps;
      // A failure is its own: callers that share one failure got the same error, above. It does not
      // take the place of a call that starts after it, such as the call an app makes again right after
      // it aborted one.
      if (failed) return fail(rec, outcome && outcome.message ? String(outcome.message) : String(outcome));
      if (!source) {
        for (var i = libCalls.length - 1; i >= 0; i--) {
          var other = libCalls[i];
          if (other.method === call.method && other.url === call.url && other.body === call.body && other.start < call.end && call.start < other.end) {
            return dropRecord(rec.entry);
          }
        }
        libCalls.push(call);
        if (libCalls.length > 50) libCalls.shift();
      }
      setResponse(rec, outcome.url, outcome.status, outcome.statusText, headersObject(outcome.headers));
      rec.entry.durationMs = call.endedAt - call.startedAt;
      // The library's default Response holds the body as a blob, which a read leaves to the app as
      // well. A Response that streams text shares its stream with every clone, and a read would take
      // it from the app: that body is not read.
      var blob = outcome._body && outcome._body._bodyBlob;
      if (typeof Blob === 'function' && blob instanceof Blob && typeof readBlob === 'function' && typeof FileReader === 'function') {
        var size = blob.size;
        return readBlob(rec, blob, size, Math.min(size, BODY_CAP));
      }
      complete(rec, undefined, undefined, false);
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
  if (typeof globalThis.__argent_network_decode === 'function') globalThis.__argent_network_decode(entry);

  return JSON.stringify({
    id: entry.id,
    requestId: entry.requestId,
    state: entry.state,
    request: entry.request,
    response: entry.response,
    resourceType: entry.resourceType,
    encodedDataLength: entry.encodedDataLength,
    timestamp: entry.timestamp,
    durationMs: entry.durationMs,
    errorText: entry.errorText,
    responseBody: entry.responseBody,
    bodyTruncated: entry.bodyTruncated
  });
})()`;
}
