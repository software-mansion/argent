/**
 * Injected via Runtime.evaluate: records the app's HTTP requests for the network tools.
 *
 * Each request is recorded where it leaves JavaScript, so a request has one record whatever the
 * app's own wrappers of `fetch` do with it:
 * - `XMLHttpRequest.prototype` is patched: axios and every other XHR user, and React Native's
 *   `fetch`, which is a polyfill over XHR.
 * - Expo's native `fetch` (`expo/fetch`, the global `fetch` on Expo SDK 56+) sends each request
 *   through a `NativeRequest` of its native module, which is patched too.
 * - A fetch library that calls React Native's network module itself (react-native-fetch-api)
 *   sends neither. That module's `sendRequest` is patched, found in the module list of Metro's
 *   development build: requests an XHR does not send there are recorded.
 * - Records stay in `__argent_network_log` / `__argent_network_by_id`, which the read scripts
 *   below serve.
 *
 * The script never modifies a request. Idempotent per JS context.
 */
export const NETWORK_INTERCEPTOR_SCRIPT = `(function() {
  var g = globalThis;
  if (g.__argent_network_v2) return JSON.stringify({ installed: false, reason: 'already installed' });
  g.__argent_network_v2 = true;
  // The previous fetch-only script, injected by an older tool-server before an upgrade, stays
  // installed until the app reloads. Its fetch wrapper keeps the buffers below in a closure, so
  // empty them and stop them from growing: it then still reads each response, but keeps nothing.
  if (g.__argent_network_installed && Array.isArray(g.__argent_network_log)) {
    var oldLog = g.__argent_network_log;
    oldLog.length = 0;
    oldLog.push = function() { return 0; };
    var oldById = g.__argent_network_by_id;
    if (oldById && typeof oldById === 'object') {
      for (var oldKey in oldById) delete oldById[oldKey];
      Object.freeze(oldById);
    }
  }
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
  // Above zero while an XHR is sent: the request React Native's network module gets then is the
  // XHR's, which has its record.
  var xhrSending = 0;

  function bodyChars(entry) {
    return (entry.responseBody ? entry.responseBody.length : 0) +
      (entry.request.postData ? entry.request.postData.length : 0) +
      (entry.bodyBytes ? entry.bodyBytes.byteLength : 0) + (entry.postBytes ? entry.postBytes.byteLength : 0) +
      (entry.bodyBase64 ? entry.bodyBase64.length : 0);
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

  // The UTF-8 size of a text body the interceptor keeps whole. A longer body is cut, and its size
  // is recorded in characters (bodyLength) instead: counting its bytes would take the app's JS
  // thread a time that grows with the body.
  function textSize(text) {
    return text.length > BODY_CAP ? undefined : utf8Length(text);
  }

  // A body of one of these types is not text: its size is recorded and it is not read as text.
  var BINARY_TYPES = /^(image\\/(?!svg)|audio\\/|video\\/|font\\/|application\\/(octet-stream|pdf|zip|gzip|wasm|x-protobuf)$)/;
  function isBinaryType(mime) {
    return typeof mime === 'string' && BINARY_TYPES.test(mime.toLowerCase());
  }

  function mimeTypeOf(headers) {
    return hasOwn.call(headers, 'content-type') ? String(headers['content-type']).split(';')[0].trim() : '';
  }

  // The headers of every HeadersInit form: [name, value] pairs (an array or another iterable), a
  // Headers or Map, or a plain object. A name given twice keeps both values.
  function headersObject(source) {
    var out = {};
    if (!source || typeof source !== 'object') return out;
    var add = function(name, value) {
      name = String(name);
      out[name] = hasOwn.call(out, name) ? out[name] + ', ' + String(value) : String(value);
    };
    try {
      // A Headers and a Map iterate as pairs too.
      if (Array.isArray(source) || (typeof Symbol === 'function' && typeof source[Symbol.iterator] === 'function')) {
        var pairs = Array.from(source);
        for (var i = 0; i < pairs.length; i++) {
          if (pairs[i] && typeof pairs[i] === 'object' && pairs[i].length === 2) add(pairs[i][0], pairs[i][1]);
        }
      } else if (typeof source.forEach === 'function') {
        source.forEach(function(value, name) { add(name, value); });
      } else {
        for (var k in source) if (hasOwn.call(source, k)) add(k, source[k]);
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

  // The bytes of base64 text, which a response of React Native's network module can come as.
  var base64Values = null;
  function base64Bytes(text) {
    if (!base64Values) {
      base64Values = {};
      var digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      for (var d = 0; d < 64; d++) base64Values[digits.charAt(d)] = d;
    }
    var out = new Uint8Array(Math.floor(text.length * 3 / 4));
    var n = 0, bits = 0, acc = 0;
    for (var i = 0; i < text.length; i++) {
      var v = base64Values[text.charAt(i)];
      if (v === undefined) continue;
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[n++] = (acc >> bits) & 0xff;
        acc &= (1 << bits) - 1;
      }
    }
    return out.subarray(0, n);
  }

  function decodeBodies(entry) {
    if (!entry.postBytes && !entry.bodyBytes && entry.bodyBase64 === undefined) return;
    var before = bodyChars(entry);
    if (entry.bodyBase64 !== undefined) {
      entry.bodyBytes = base64Bytes(entry.bodyBase64);
      delete entry.bodyBase64;
    }
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
      } else if (typeof TextDecoder === 'function') {
        // Bytes that are not UTF-8.
        entry.bodyOmitted = true;
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

  // A response header, by its name in lower case.
  function headerValue(response, wanted) {
    var headers = response && response.headers;
    if (!headers) return undefined;
    for (var name in headers) {
      if (hasOwn.call(headers, name) && name.toLowerCase() === wanted) return String(headers[name]);
    }
    return undefined;
  }

  // The Content-Length of a response, when it gives the size of the body the app gets. With a
  // Content-Encoding (gzip, br) it is the compressed size, which iOS keeps on the decoded response.
  function contentLength(response) {
    var encoding = headerValue(response, 'content-encoding');
    if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity' && encoding.trim() !== '') return undefined;
    var value = headerValue(response, 'content-length');
    var n = Number(value);
    return value !== undefined && value !== '' && n >= 0 && Math.floor(n) === n ? n : undefined;
  }

  function isBinaryResponse(rec) {
    return !!rec.entry.response && isBinaryType(rec.entry.response.mimeType);
  }

  // The size of a text body, unless the body is binary: its text is then not stored (see storeBody).
  function textSizeOf(rec, text) {
    return isBinaryResponse(rec) ? undefined : textSize(text);
  }

  // Records a body that is not kept, once: the details show its size instead.
  function omitBody(rec, byteLength) {
    var e = rec.entry;
    if (e.responseBody !== undefined || e.encodedDataLength !== undefined || e.bodyOmitted) return;
    e.bodyOmitted = true;
    if (typeof byteLength === 'number') e.encodedDataLength = byteLength;
  }

  // Stores the body of a response, once: text, or bytes that keepBytes cut.
  function storeBody(rec, body, byteLength, truncated) {
    var e = rec.entry;
    if (e.responseBody !== undefined || e.encodedDataLength !== undefined || e.bodyOmitted) return;
    if (typeof body === 'string' && isBinaryResponse(rec)) {
      // A binary body read as text (an XHR's default responseType, Expo's text()) is not that text.
      // Its size is the one the server gave, else the length of the text, close to it: a byte that is
      // not UTF-8 reads as one character.
      var declared = e.state === 'failed' ? undefined : contentLength(e.response);
      omitBody(rec, declared);
      if (declared === undefined) e.bodyLength = body.length;
      return;
    }
    if (body instanceof Uint8Array && isBinaryResponse(rec)) return omitBody(rec, byteLength);
    if (typeof byteLength === 'number') e.encodedDataLength = byteLength;
    if (body instanceof Uint8Array) {
      e.bodyBytes = body;
      if (byId[e.requestId] === e) { bufferedChars += body.byteLength; evict(); }
    } else if (typeof body === 'string') {
      if (body.length > BODY_CAP) {
        // A cut body is not counted (see textSize): its size is the one the server gave, if any.
        e.bodyLength = body.length;
        if (e.encodedDataLength === undefined) e.encodedDataLength = contentLength(e.response);
        body = body.slice(0, BODY_CAP);
        truncated = true;
      }
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

    // React Native's fetch is whatwg-fetch over XHR. Each call builds a Request of whatwg-fetch, whose
    // constructor ends with _initBody, and then, in the same synchronous run, opens its XHR with that
    // Request's method and URL. Its Request class is the global one, so wrapping _initBody marks the
    // Request of each call, also of a fetch the app captured before the install, and the next open
    // that matches it, before the run ends, is the call's XHR. Any other XHR is the app's own, even
    // one that reads its response as a blob.
    var fetchRequest = null;
    var knowsFetch = false;
    try {
      var requestProto = typeof g.Request === 'function' && g.Request.prototype;
      if (requestProto && hasOwn.call(requestProto, '_initBody') && typeof requestProto._initBody === 'function' &&
        typeof Promise === 'function') {
        var origInitBody = requestProto._initBody;
        var markFetch = function() {
          fetchRequest = this;
          var marked = this;
          Promise.resolve().then(function() { if (fetchRequest === marked) fetchRequest = null; });
          return origInitBody.apply(this, arguments);
        };
        requestProto._initBody = markFetch;
        knowsFetch = requestProto._initBody === markFetch;
      }
    } catch (e) {}
    // Without that Request class, an XHR shaped as React Native's fetch sends it: it reads every
    // response as a blob (as an arraybuffer where Blob is unavailable) and sets these handlers.
    // axios sets onloadend, not onload.
    var isFetchXhr = function(xhr, slot) {
      if (knowsFetch) return slot.fetch;
      return (xhr.responseType === 'blob' || xhr.responseType === 'arraybuffer') && typeof xhr.onload === 'function' &&
        typeof xhr.onabort === 'function' && typeof xhr.ontimeout === 'function';
    };

    var isBinaryBlob = function(rec, blob) {
      var mime = rec.entry.response && rec.entry.response.mimeType;
      try { if (!mime) mime = blob.type; } catch (e) {}
      return isBinaryType(mime);
    };

    // iOS resolves readAsText with null when the cut splits a UTF-8 character, so step back a
    // byte at a time, at most 3 times.
    // The size is read up front: RN's Blob throws on every access once the app closes it.
    // cutOf(end), when given, makes the start of the blob that is read instead of a slice.
    var readBlob = function(rec, blob, size, end, cutOf) {
      if (end === Math.min(size, BODY_CAP) && isBinaryBlob(rec, blob)) {
        omitBody(rec, size);
        return complete(rec, undefined, size, false);
      }
      var part = end < size ? (cutOf ? cutOf(end) : blob.slice(0, end)) : blob;
      // A slice holds its own reference to the native blob: release it, so the app's close() frees it.
      var release = function() { if (part !== blob && !cutOf) part.close(); };
      var reader = new FileReader();
      reader.onload = function() {
        release();
        if (typeof reader.result === 'string' || part === blob || end <= BODY_CAP - 3) {
          return complete(rec, reader.result, size, part !== blob);
        }
        // The app may have closed the blob since the first read.
        try { readBlob(rec, blob, size, end - 1, cutOf); } catch (e) { complete(rec, undefined, size, false); }
      };
      reader.onerror = function() {
        release();
        complete(rec, undefined, size, false);
      };
      reader.readAsText(part);
    };

    var readBody = function(rec, xhr) {
      var type = xhr.responseType || '';
      if (type === '' || type === 'text') {
        var text = xhr.responseText;
        if (typeof text === 'string') return complete(rec, text, textSizeOf(rec, text), false);
      } else if (type === 'json') {
        // React Native keeps the text it received, which spares a serialization of the whole object.
        var raw = xhr._response;
        if (typeof raw === 'string') return complete(rec, raw, textSize(raw), false);
        var json = xhr.response == null ? undefined : JSON.stringify(xhr.response);
        // Re-serialized, so its length is not the size received: record no size.
        if (typeof json === 'string') return complete(rec, json, undefined, false);
      } else if (type === 'arraybuffer') {
        // Kept as bytes like Expo's bodies, and decoded when the agent reads the record.
        var buffer = xhr.response;
        if (buffer && typeof buffer.byteLength === 'number') return complete(rec, keepBytes(new Uint8Array(buffer)), buffer.byteLength);
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
          return fail(rec, text ? String(text) : 'Network request failed');
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
      var request = fetchRequest;
      fetchRequest = null;
      var slot = { method: String(method || 'GET').toUpperCase(), url: String(url), headers: {}, fetch: false };
      // whatwg-fetch opens '' as the page's URL, which React Native does not have.
      slot.fetch = !!request && String(request.method).toUpperCase() === slot.method && (String(request.url) === slot.url || request.url === '');
      // Set before the original open, which dispatches readystatechange: a handler may send from there.
      slots.set(this, slot);
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
      if (slot && slot.headers) {
        name = String(name).toLowerCase();
        value = String(value);
        // whatwg-fetch sets headers given as [name, value] pairs as if they were an object: each pair
        // as '0': 'name,value' and so on, then 'length', then each pair again under its own name. The
        // pair is recorded under its own name, so a redacted header stays redacted.
        var comma = value.indexOf(',');
        if (/^\\d+$/.test(name) && comma > 0) {
          slot.pairs = true;
          name = value.slice(0, comma).trim().toLowerCase();
          value = value.slice(comma + 1);
        } else if (name === 'length' && slot.pairs) {
          return result;
        }
        slot.headers[name] = value;
      }
      return result;
    };

    proto.send = function(body) {
      var slot = slots.get(this);
      var startedAt = Date.now();
      var result;
      xhrSending++;
      try {
        result = origSend.apply(this, arguments);
      } finally {
        xhrSending--;
      }
      if (!slot || !slot.headers) return result;
      var rec = createRecord(isFetchXhr(this, slot) ? 'Fetch' : 'XHR', slot.method, slot.url, slot.headers, body, startedAt);
      slot.headers = null;
      listen(this, rec);
      return result;
    };

    // To reuse an XHR from its own handler, the app aborts it first, and RN runs that handler
    // before these listeners. Record a request that has already ended before abort resets the XHR.
    // RN keeps _aborted set until the next open, so an abort called from a handler of an abort
    // still counts as one. An app can also abort from its own handler of HEADERS_RECEIVED, which
    // runs before the listener that records the headers: keep them.
    // RN clears the response before it announces the abort, so the text an XHR has received while it
    // streams (react-native-sse aborts to close) is taken first. The request stays failed: the body
    // is only the part that arrived.
    proto.abort = function() {
      var request = live.get(this);
      if (request && this.readyState >= 2 && !request.rec.entry.response) onHeaders(this, request.rec);
      if (request && this.readyState === 4) {
        request.end(this._aborted ? 'abort' : this._hasError ? (this._timedOut ? 'timeout' : 'error') : 'load');
      }
      var partial;
      if (request && this.readyState === 3) {
        try { if (this.responseType === '' || this.responseType === 'text') partial = this.responseText; } catch (e) {}
      }
      var result = origAbort.apply(this, arguments);
      if (typeof partial === 'string' && partial && request.rec.entry.state === 'failed') {
        storeBody(request.rec, partial, textSizeOf(request.rec, partial), false);
      }
      return result;
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
      if (typeof text === 'string' && rec.entry.state !== 'failed') storeBody(rec, text, textSizeOf(rec, text), false);
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
            lowerCaseHeaders(init && init.headers), body, startedAt);
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

  // ── React Native's network module ──
  // A fetch library can send through React Native's network module (RCTNetworking) itself, not
  // through an XHR: react-native-fetch-api, which react-native-polyfill-globals installs as the global
  // fetch. Each request such a library sends there is recorded, so it has one record whatever the
  // app's wrappers do, and whenever the library was installed. The module is not global: it is found
  // in the module list of Metro's development build (__r.getModules()). A request that an XHR sends
  // (xhrSending) has its record from the XHR.
  // The native module answers by request id, with events of the module: the response, its data
  // (text, base64 text or a native blob, as the sender asked) or the parts of a text it streams, and
  // the end of the request. An aborted request gets no end event on iOS.
  var NETWORKING_PATH = /(^|[\\\\/])Libraries[\\\\/]Network[\\\\/]RCTNetworking(\\.[a-z]+)?\\.js$/;
  function findNetworking() {
    var modules;
    try { modules = typeof g.__r === 'function' && typeof g.__r.getModules === 'function' ? g.__r.getModules() : null; } catch (e) {}
    if (!modules || typeof modules !== 'object') return null;
    var matches = [];
    var check = function(mod, id) {
      if (mod && typeof mod.verboseName === 'string' && NETWORKING_PATH.test(mod.verboseName)) matches.push({ mod: mod, id: Number(id) });
    };
    if (typeof modules.forEach === 'function') modules.forEach(check);
    else for (var key in modules) if (hasOwn.call(modules, key)) check(modules[key], key);
    // A module the app has not loaded yet is loaded here, as its first request would.
    matches.sort(function(a, b) { return (b.mod.isInitialized ? 1 : 0) - (a.mod.isInitialized ? 1 : 0); });
    for (var i = 0; i < matches.length; i++) {
      var exports;
      try {
        exports = matches[i].mod.isInitialized ? matches[i].mod.publicModule && matches[i].mod.publicModule.exports : g.__r(matches[i].id);
      } catch (e) {}
      var api = exports && typeof exports === 'object' && exports.default ? exports.default : exports;
      if (api && typeof api.sendRequest === 'function' && typeof api.abortRequest === 'function' &&
        typeof api.addListener === 'function') return api;
    }
    return null;
  }

  function lowerCaseHeaders(source) {
    var headers = headersObject(source);
    var out = {};
    for (var name in headers) {
      if (!hasOwn.call(headers, name)) continue;
      var lower = name.toLowerCase();
      out[lower] = hasOwn.call(out, lower) ? out[lower] + ', ' + headers[name] : headers[name];
    }
    return out;
  }

  // A Blob of the native blob a response came as, for FileReader only: it does not count as a
  // reference to the native blob, so the app's own Blob of it still frees it, and nothing here closes it.
  function blobOf(data, size) {
    var copy = {};
    for (var key in data) if (hasOwn.call(data, key)) copy[key] = data[key];
    copy.size = size;
    var blob = Object.create(Blob.prototype);
    blob.data = copy;
    return blob;
  }

  // Records one request sent through the module. Returns the request's watcher, which gets the
  // request id once the module hands it back.
  function watchRequest(networking, method, url, headers, data, responseType) {
    var rec = createRecord('Fetch', String(method || 'GET').toUpperCase(), String(url), lowerCaseHeaders(headers), data, Date.now());
    var requestId;
    var subscriptions = [];
    var received;
    // The text received so far of a response streamed in parts, up to one character past the cut.
    var streamed = '';
    var streamedChars = 0;
    var streamedBytes = 0;
    var stop = function() {
      for (var i = 0; i < subscriptions.length; i++) {
        try { subscriptions[i].remove(); } catch (e) {}
      }
      subscriptions = [];
      if (requestId !== undefined && watched[requestId] === watcher) delete watched[requestId];
    };
    var storeStreamed = function() {
      if (!streamedChars) return;
      var cut = streamedChars > BODY_CAP;
      storeBody(rec, streamed, cut ? undefined : streamedBytes, false);
      if (cut) rec.entry.bodyLength = streamedChars;
    };
    var handlers = {
      didReceiveNetworkResponse: function(args) {
        setResponse(rec, args[3], args[1], '', lowerCaseHeaders(args[2]));
      },
      didReceiveNetworkData: function(args) { received = args[1]; },
      didReceiveNetworkIncrementalData: function(args) {
        var text = args[1];
        if (typeof text !== 'string' || !text) return;
        streamedChars += text.length;
        if (streamedChars <= BODY_CAP) streamedBytes += utf8Length(text);
        if (streamed.length <= BODY_CAP) streamed += text.slice(0, BODY_CAP + 1 - streamed.length);
      },
      didCompleteNetworkResponse: function(args) {
        stop();
        if (rec.entry.state !== 'pending') return;
        if (args[2]) return fail(rec, 'timeout');
        if (args[1]) {
          storeStreamed();
          return fail(rec, String(args[1]));
        }
        rec.entry.durationMs = Date.now() - rec.startedAt;
        if (typeof received === 'string') {
          if (responseType !== 'base64') return complete(rec, received, textSizeOf(rec, received), false);
          var n = received.length;
          var padding = received.charAt(n - 1) === '=' ? (received.charAt(n - 2) === '=' ? 2 : 1) : 0;
          var size = Math.max(0, Math.floor(n * 3 / 4) - padding);
          // A binary body keeps no bytes (see storeBody).
          if (isBinaryResponse(rec)) {
            omitBody(rec, size);
            return complete(rec, undefined, size, false);
          }
          // Decoded when the agent reads the record, as bytes are.
          rec.entry.bodyBase64 = received.slice(0, Math.ceil((BODY_CAP + 3) / 3) * 4);
          if (byId[rec.entry.requestId] === rec.entry) { bufferedChars += rec.entry.bodyBase64.length; evict(); }
          return complete(rec, undefined, size, false);
        }
        if (received && typeof received === 'object' && typeof received.blobId === 'string') {
          var blobSize = Number(received.size) || 0;
          if (typeof Blob === 'function' && typeof FileReader === 'function' && typeof readBlob === 'function') {
            try {
              return readBlob(rec, blobOf(received, blobSize), blobSize, Math.min(blobSize, BODY_CAP), function(end) { return blobOf(received, end); });
            } catch (e) {}
          }
          if (isBinaryResponse(rec)) omitBody(rec, blobSize);
          return complete(rec, undefined, blobSize, false);
        }
        storeStreamed();
        complete(rec, undefined, undefined, false);
      }
    };
    var watcher = {
      sent: function(id) {
        requestId = id;
        watched[id] = watcher;
      },
      // The app aborted the request: what it streamed so far stays with the failed record.
      abort: function() {
        stop();
        if (rec.entry.state !== 'pending') return;
        storeStreamed();
        fail(rec, 'aborted');
      },
      // The module did not take the request: its send threw before it handed back an id.
      drop: function() {
        if (requestId !== undefined) return;
        stop();
        var at = log.lastIndexOf(rec.entry);
        if (at === -1) return;
        log.splice(at, 1);
        delete byId[rec.entry.requestId];
        bufferedChars -= bodyChars(rec.entry);
      }
    };
    // Each event carries the request id, which the module hands back only after the request starts.
    try {
      for (var event in handlers) {
        (function(handler) {
          subscriptions.push(networking.addListener(event, function(args) {
            if (requestId === undefined || !args || args[0] !== requestId) return;
            try { handler(args); } catch (e) {}
          }));
        })(handlers[event]);
      }
    } catch (e) {
      watcher.drop();
      return null;
    }
    return watcher;
  }

  // The watcher of each request in flight, by request id.
  var watched = {};
  var networking = findNetworking();
  if (networking) {
    var origSendRequest = networking.sendRequest;
    var origAbortRequest = networking.abortRequest;
    networking.sendRequest = function(method, trackingName, url, headers, data, responseType, incrementalUpdates, timeout, callback) {
      if (xhrSending || typeof callback !== 'function') return origSendRequest.apply(this, arguments);
      var watcher = null;
      try { watcher = watchRequest(networking, method, url, headers, data, responseType); } catch (e) {}
      if (!watcher) return origSendRequest.apply(this, arguments);
      var args = Array.prototype.slice.call(arguments);
      args[8] = function(requestId) {
        try { if (typeof requestId === 'number' || typeof requestId === 'string') watcher.sent(requestId); } catch (e) {}
        return callback.apply(this, arguments);
      };
      try {
        return origSendRequest.apply(this, args);
      } catch (e) {
        watcher.drop();
        throw e;
      }
    };
    networking.abortRequest = function(requestId) {
      var watcher = hasOwn.call(watched, requestId) ? watched[requestId] : null;
      if (watcher) {
        try { watcher.abort(); } catch (e) {}
      }
      return origAbortRequest.apply(this, arguments);
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
      response: s.response ? { url: s.response.url, status: s.response.status, statusText: s.response.statusText, mimeType: s.response.mimeType } : undefined,
      resourceType: s.resourceType,
      encodedDataLength: s.encodedDataLength,
      bodyLength: s.bodyLength,
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
    bodyTruncated: entry.bodyTruncated,
    bodyLength: entry.bodyLength,
    bodyOmitted: entry.bodyOmitted
  });
})()`;
}
