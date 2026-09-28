/**
 * Injected via Runtime.evaluate: records the app's HTTP requests for the network tools.
 *
 * - `XMLHttpRequest.prototype` is patched, so axios and every other XHR user is recorded.
 *   React Native's `fetch` is a polyfill over XHR, so its requests are recorded by their XHR.
 * - `globalThis.fetch` is wrapped too. A call that sends no XHR on the same stack is a native
 *   `fetch` (Expo's, for example) and gets its own record with `via: 'fetch-native'`. When the
 *   global fetch is Expo's own, that is the whole story. Only an app wrapper below this one needs
 *   matching: a wrapper that awaits before it calls React Native's fetch sends the XHR later, and
 *   that XHR removes the pending record of its fetch, so the request still has one record. When
 *   the XHR was not matched at send (a wrapper that returns one in-flight request to several
 *   callers, for example), the fetch record is removed once it settles and an XHR record of the
 *   same request ran while it was pending.
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
  // The wrapped fetch call running on the current stack, if any.
  var activeFetch = null;
  // Native-fetch records whose promise has not settled. A fetch wrapper that awaits before it
  // calls React Native's fetch sends the XHR from a later stack, and that XHR takes the record over.
  var pendingNative = [];
  // Set once a fetch resolves with a Response that React Native's fetch did not build: fetch is
  // native here, so an XHR never belongs to a fetch record.
  var nativeFetchSeen = false;
  // The XHR record of each response object (Blob or ArrayBuffer) an XHR produced. React Native's
  // fetch builds its Response around that object, which ties the fetch to its XHR.
  var xhrByBody = new WeakMap();
  // The native-fetch record that first resolved with each value. A wrapper that hands one
  // in-flight request to several callers resolves them all with one object: one record.
  var nativeByValue = new WeakMap();
  // For each XHR record: whether React Native's fetch sent it, and the wrapped fetch call it was
  // sent in (null outside any).
  var xhrSource = new WeakMap();

  function bodyChars(entry) {
    return (entry.responseBody ? entry.responseBody.length : 0) +
      (entry.request.postData ? entry.request.postData.length : 0);
  }

  function forgetPending(entry) {
    for (var i = 0; i < pendingNative.length; i++) {
      if (pendingNative[i].entry === entry) { pendingNative.splice(i, 1); return; }
    }
  }

  function evict() {
    while (log.length > MAX_ENTRIES || (bufferedChars > BUFFER_CAP && log.length > 0)) {
      var removed = log.shift();
      bufferedChars -= bodyChars(removed);
      delete byId[removed.requestId];
      // A fetch whose promise never settles must not keep its record, nor a place in the list.
      if (removed.via === 'fetch-native') forgetPending(removed);
    }
  }

  // Puts back a record a claim removed: its fetch turned out not to run over that XHR.
  function restore(rec) {
    var entry = rec.entry;
    if (byId[entry.requestId] === entry) return;
    var at = log.length;
    while (at > 0 && log[at - 1].id > entry.id) at--;
    log.splice(at, 0, entry);
    byId[entry.requestId] = entry;
    bufferedChars += bodyChars(entry);
    evict();
  }

  // Removes a record that another record turned out to cover.
  function discard(entry) {
    var at = log.indexOf(entry);
    if (at === -1) return;
    log.splice(at, 1);
    bufferedChars -= bodyChars(entry);
    delete byId[entry.requestId];
  }

  // React Native's fetch sets the '_' query parameter of a GET or HEAD with cache 'no-store' or 'no-cache'.
  function withoutCacheBuster(url) {
    return url.replace(/([?&])_=[^&]*/, '$1_=');
  }

  function withCacheBuster(url) {
    return /[?&]_=/.test(url) ? withoutCacheBuster(url) : url + (url.indexOf('?') === -1 ? '?' : '&') + '_=';
  }

  // Whether an XHR's method and URL are those of a fetch record, once React Native's fetch has
  // added its cache buster to the URL.
  function sameRequest(entry, method, url) {
    if (entry.request.method !== method) return false;
    if (entry.request.url === url) return true;
    return (method === 'GET' || method === 'HEAD') && withCacheBuster(entry.request.url) === withoutCacheBuster(url);
  }

  // Whether an XHR is one React Native's fetch sends: it reads every response as a blob (as an
  // arraybuffer where Blob is unavailable) and sets these handlers. axios sets onloadend, not onload.
  function isPolyfillXhr(xhr) {
    return (xhr.responseType === 'blob' || xhr.responseType === 'arraybuffer') && typeof xhr.onload === 'function' &&
      typeof xhr.onabort === 'function' && typeof xhr.ontimeout === 'function';
  }

  // Finds the pending native-fetch record of the fetch that sent this XHR, and removes it. The
  // record comes back (restore) if its fetch then resolves with a Response no XHR produced.
  // Called for an XHR of React Native's fetch sent outside any wrapped fetch call, which is where
  // a pending fetch record sends its XHR; an XHR sent inside a fetch call is that call's own.
  function claimNativeFetch(method, url) {
    if (nativeFetchSeen || !pendingNative.length) return false;
    var pick = -1;
    var sameMethod = -1;
    var oldest = -1;
    for (var i = 0; i < pendingNative.length; i++) {
      var e = pendingNative[i].entry;
      if (sameRequest(e, method, url)) { pick = i; break; }
      // A wrapper can also change the URL, or the method: the oldest record with this method
      // stands in, else the oldest record.
      if (sameMethod === -1 && e.request.method === method) sameMethod = i;
      if (oldest === -1) oldest = i;
    }
    if (pick === -1) pick = sameMethod !== -1 ? sameMethod : oldest;
    if (pick === -1) return false;
    var rec = pendingNative.splice(pick, 1)[0];
    rec.claimed = true;
    discard(rec.entry);
    return true;
  }

  // Finds an XHR record that was in flight at some point while this fetch was pending and is of
  // the same request: the XHR of the fetch itself, or the one in-flight request a wrapper handed
  // to several callers. The XHR that produced the body of the Response React Native's fetch built
  // is that XHR whatever the wrapper did to the URL or the method. Any other XHR must be one React
  // Native's fetch sent, or one sent inside this very fetch call (a fetch built on its own XHR):
  // an axios request to the same URL at the same time is a request of its own. The XHR record
  // stands for the request; the fetch record goes.
  function coveredByXhr(rec, settledAt, failedOnly, response) {
    var e = rec.entry;
    var body = response ? response._bodyInit : undefined;
    var owner = body && typeof body === 'object' ? xhrByBody.get(body) : undefined;
    for (var i = log.length - 1; i >= 0; i--) {
      var x = log[i];
      if (x.via !== 'xhr' || (failedOnly && x.state !== 'failed')) continue;
      var started = x.timestamp * 1000;
      if (started > settledAt + 1) continue;
      var ended = x.state === 'pending' || typeof x.durationMs !== 'number' ? Infinity : started + x.durationMs;
      if (ended < rec.startedAt - 1) continue;
      if (x !== owner) {
        var source = xhrSource.get(x);
        if (!source || !(source.polyfill || source.call === rec.call)) continue;
        if (!sameRequest(e, x.request.method, x.request.url)) continue;
      }
      x.resourceType = 'Fetch';
      discard(e);
      return true;
    }
    return false;
  }

  // Whether another fetch call, pending at the same time, already resolved with this very value:
  // the app's wrapper shared one request between them. A value served again later, from a cache,
  // is the later call's own. A native Response comes from one request whatever URL each call
  // named (a wrapper that sends '/me' on as 'https://api.test/me' through the global fetch); a
  // value such as parsed JSON must also come from the same request.
  function sharedValue(rec, value, kind) {
    if (!value || typeof value !== 'object') return false;
    var owner = nativeByValue.get(value);
    if (owner === undefined) { nativeByValue.set(value, rec); return false; }
    if (owner === rec) return false;
    if (kind !== 'native' && !sameRequest(owner.entry, rec.entry.request.method, rec.entry.request.url)) return false;
    var ownerEnded = owner.entry.state === 'pending' || typeof owner.entry.durationMs !== 'number'
      ? Infinity : owner.startedAt + owner.entry.durationMs;
    if (ownerEnded < rec.startedAt - 1) return false;
    discard(rec.entry);
    return true;
  }

  // 'polyfill': React Native's fetch built it (whatwg-fetch sets _bodyInit). 'native': a Response
  // from another fetch. 'other': a value that says nothing about the fetch.
  function responseKind(response) {
    try {
      if (!response || typeof response !== 'object') return 'other';
      if ('_bodyInit' in response) return 'polyfill';
      // A native Response streams its body (Expo's does; whatwg-fetch has no body stream). A class an
      // app wraps React Native's Response in has clone() too, so clone() alone says nothing.
      return typeof response.clone === 'function' && hasBodyStream(response) ? 'native' : 'other';
    } catch (e) { return 'other'; }
  }

  // Whether a Response has a body stream, without reading body: on Expo SDK 55 and older, reading
  // it starts the native stream, and the app then reads an empty body.
  function hasBodyStream(response) {
    var depth = 0;
    for (var o = response; o && depth < 10; o = Object.getPrototypeOf(o), depth++) {
      var d = Object.getOwnPropertyDescriptor(o, 'body');
      if (!d) continue;
      if (typeof d.get === 'function') return true;
      return !!d.value && typeof d.value === 'object' && typeof d.value.getReader === 'function';
    }
    return false;
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

  function setResponse(rec, url, status, statusText, headers) {
    var e = rec.entry;
    e.response = { url: url || e.request.url, status: status, statusText: statusText || '', headers: headers, mimeType: mimeTypeOf(headers) };
  }

  // Ends a request that got a response and stores its body.
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
      setResponse(rec, xhr.responseURL, xhr.status, xhr.statusText, parseHeaders(raw));
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
        if (buffer && typeof buffer === 'object') xhrByBody.set(buffer, rec.entry);
        return complete(rec, undefined, buffer ? buffer.byteLength : undefined, false);
      } else if (type === 'blob') {
        var blob = xhr.response;
        if (blob && typeof blob === 'object') xhrByBody.set(blob, rec.entry);
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
      // A fetch that sends React Native's XHR on the same stack runs over XHR: this record is its
      // only one. Another XHR sent there (a log beacon of a wrapper, say) is not the fetch's.
      var polyfillXhr = isPolyfillXhr(this);
      if (fetchCall && polyfillXhr) fetchCall.sentXhr = true;
      var ofFetch = fetchCall ? polyfillXhr : polyfillXhr && claimNativeFetch(slot.method, slot.url);
      var rec = createRecord('xhr', ofFetch ? 'Fetch' : 'XHR', slot.method, slot.url, slot.headers, body, startedAt);
      xhrSource.set(rec.entry, { polyfill: polyfillXhr, call: fetchCall });
      slot.headers = null;
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
    // Expo marks the fetch it installs as the global one. With no wrapper of the app below this
    // one, each call is one native request with no XHR under it, so a record needs no matching.
    var expoGlobalFetch = false;
    try { expoGlobalFetch = origFetch[Symbol.for('expo.builtin')] === true; } catch (e) {}

    // Returns the promise the app gets. It settles like the native one, so a rejection the app
    // never handles is still reported as unhandled.
    var observeNativeFetch = function(input, init, startedAt, promise, call) {
      var method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
      var url = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : String(input));
      var headers = headersObject(init && init.headers !== undefined ? init.headers : input && input.headers);
      var rec = createRecord('fetch-native', 'Fetch', String(method).toUpperCase(), url, headers, init && init.body, startedAt);
      rec.call = call;
      if (!expoGlobalFetch) pendingNative.push(rec);
      // Returns true when an XHR took the record over.
      function settle() {
        var at = pendingNative.indexOf(rec);
        if (at !== -1) pendingNative.splice(at, 1);
        return rec.claimed === true;
      }
      return promise.then(function(response) {
        var kind = responseKind(response);
        if (!expoGlobalFetch) {
          if (settle()) {
            if (kind !== 'native') return response;
            // The XHR that took this record was another fetch's: the record is back.
            restore(rec);
          } else if (sharedValue(rec, response, kind)) {
            return response;
          } else if (kind !== 'native') {
            // This fetch may have run over an XHR after all, one that was not matched at send. A
            // value that is no Response (a wrapper returning parsed JSON, say) carries no body to match.
            if (coveredByXhr(rec, Date.now(), false, kind === 'polyfill' ? response : undefined)) return response;
          }
        }
        if (kind === 'native') nativeFetchSeen = true;
        if (response == null || typeof response.status !== 'number') {
          // The wrapper resolved a value that is no Response (parsed JSON, say): the request ran,
          // but nothing of its response can be read.
          rec.entry.durationMs = Date.now() - rec.startedAt;
          complete(rec, undefined, undefined, false);
          return response;
        }
        try {
          setResponse(rec, response.url, response.status, response.statusText, headersObject(response.headers));
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
        // A rejection carries no Response to tell React Native's fetch from a native one, so a
        // failed XHR of the same request that overlapped this fetch is taken as its own. A native
        // fetch and an XHR to one URL at one time, both failing, then count once. Two calls that
        // reject with one error object shared one request, like two calls resolving one Response.
        if (expoGlobalFetch || (!settle() && !sharedValue(rec, err, 'native') && !coveredByXhr(rec, Date.now(), true))) {
          fail(rec, err ? String(err.message || err) : 'Network error');
        }
        throw err;
      });
    };

    // The promises of calls that React Native's fetch recorded by their XHR. A wrapper of the app
    // that hands one of them to a later call, which sends no XHR, shares that request. A promise of
    // a native fetch proves nothing: the later call may still have sent a request of its own.
    var xhrPromises = new WeakSet();

    g.fetch = function fetch(input, init) {
      var call = { sentXhr: false, nested: null };
      var outer = activeFetch;
      var startedAt = Date.now();
      activeFetch = call;
      var promise;
      try {
        promise = origFetch.apply(g, arguments);
      } finally {
        activeFetch = outer;
      }
      if (!promise || typeof promise.then !== 'function') return promise;
      var result = promise;
      if (call.sentXhr) {
        try { xhrPromises.add(promise); } catch (e) {}
      } else if (!xhrPromises.has(promise) && (call.nested === null || call.nested.indexOf(promise) === -1)) {
        // A wrapper that returns the promise of a call it made through the global fetch on this
        // stack (this function again) made one request, which that call recorded.
        try { result = observeNativeFetch(input, init, startedAt, promise, call); } catch (e) {}
      }
      if (outer) (outer.nested || (outer.nested = [])).push(result);
      return result;
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
