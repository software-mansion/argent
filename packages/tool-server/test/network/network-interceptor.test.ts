import { isUtf8 } from "node:buffer";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, it, expect } from "vitest";
import {
  NETWORK_INTERCEPTOR_SCRIPT,
  makeNetworkLogReadScript,
  makeNetworkDetailReadScript,
} from "../../src/utils/debugger/scripts/network-interceptor";

// React Native's global fetch is this build: react-native/Libraries/Network/fetch.js requires it.
const WHATWG_FETCH = readFileSync(require.resolve("whatwg-fetch/dist/fetch.umd.js"), "utf8");
const BODY_CAP = 1024 * 1024;

/**
 * Expo's native fetch module as expo/ios/Fetch (NativeResponse.swift, ResponseSink.swift,
 * ExpoFetchModule.swift) and its Android twin run it. A NativeResponse goes from started to
 * responseReceived, then to bodyStreamingStarted, bodyCompleted, errorReceived or
 * bodyStreamingCanceled. Data received before the app reads the body waits in a sink:
 * startStreaming() emits it as didReceiveResponseData, or returns it whole once the body completed,
 * and text() and arrayBuffer() wait for the body to complete and take it, so a body is handed out
 * once. didComplete and didFailWithError are emitted only while the body streams,
 * readyForJSFinalization at the end of every request.
 *
 * Every hop to JS is a timer task. A promise waiting for a state settles a native hop after the
 * state changes, so an event sent with the change reaches JS first, as on a device. With
 * `startsAtBodyEnd`, start resolves only once the body completed, as SDK 55 does on iOS.
 * `__expoNative.requests` lists the requests started, which the test answers as the native side,
 * `calls` counts the calls that touch a body and `log` the order JS got the end events in.
 */
const EXPO_NATIVE = `(function() {
  var native = globalThis.__expoNative;
  var calls = native.calls;
  function later(fn) { setTimeout(fn, 0); }
  // Native data reaches JS as a new Uint8Array.
  function toJS(bytes) { var out = new Uint8Array(bytes.byteLength); out.set(bytes); return out; }

  // expo-modules-core's SharedObject: an emit calls the listeners of a snapshot of the list, and one
  // that throws does not stop the others.
  class SharedObject {
    constructor() { this._listeners = {}; }
    addListener(event, listener) { (this._listeners[event] = this._listeners[event] || []).push(listener); }
    removeListener(event, listener) {
      this._listeners[event] = (this._listeners[event] || []).filter(function(l) { return l !== listener; });
    }
    removeAllListeners(event) { this._listeners[event] = []; }
    emit(event, payload) {
      var self = this;
      (this._listeners[event] || []).slice().forEach(function(listener) {
        try { listener.call(self, payload); } catch (e) {}
      });
    }
  }

  class NativeResponse extends SharedObject {
    constructor() {
      super();
      this._native = { state: 'initialized', sink: [], head: null, error: null, waiting: [], bodyUsed: false };
    }
    get status() { return this._native.head ? this._native.head.status : -1; }
    get statusText() { return this._native.head ? this._native.head.statusText : ''; }
    get url() { return this._native.head ? this._native.head.url : ''; }
    get _rawHeaders() { return this._native.head ? this._native.head.headers : []; }
    get redirected() { return false; }
    get bodyUsed() { return this._native.bodyUsed; }

    startStreaming() {
      calls.startStreaming++;
      var self = this, n = this._native;
      return new Promise(function(resolve) {
        later(function() {
          var completed = null;
          if (n.state === 'responseReceived') {
            self._set('bodyStreamingStarted');
            self._send('didReceiveResponseData', self._takeSink());
          } else if (n.state === 'bodyCompleted') {
            completed = self._takeSink();
          }
          later(function() { resolve(completed); });
        });
      });
    }
    cancelStreaming(reason) {
      calls.cancelStreaming++;
      var self = this;
      return new Promise(function(resolve) {
        later(function() {
          if (self._native.state === 'bodyStreamingStarted') self._set('bodyStreamingCanceled');
          later(resolve);
        });
      });
    }
    arrayBuffer() {
      calls.arrayBuffer++;
      var self = this;
      return new Promise(function(resolve) {
        later(function() {
          self._waitFor(['bodyCompleted'], function() {
            var data = self._takeSink();
            later(function() { resolve(data.buffer); });
          });
        });
      });
    }
    // Decoded as UTF-8, a byte that is not becomes U+FFFD.
    text() {
      calls.text++;
      var self = this;
      return new Promise(function(resolve) {
        later(function() {
          self._waitFor(['bodyCompleted'], function() {
            var text = native.decode(self._takeSink());
            later(function() { resolve(text); });
          });
        });
      });
    }

    _takeSink() {
      var n = this._native, size = 0, at = 0;
      n.sink.forEach(function(chunk) { size += chunk.byteLength; });
      var data = new Uint8Array(size);
      n.sink.forEach(function(chunk) { data.set(chunk, at); at += chunk.byteLength; });
      n.sink = [];
      n.bodyUsed = true;
      return data;
    }
    _send(event, payload) {
      var self = this;
      later(function() {
        native.log.push(event);
        self.emit(event, payload);
      });
    }
    // The callbacks waiting for a state run a native hop after it changes, or right away with now.
    _set(state, now) {
      var n = this._native;
      n.state = state;
      var notify = function() { n.waiting = n.waiting.filter(function(waiter) { return !waiter(state); }); };
      if (now) notify();
      else later(notify);
    }
    _waitFor(states, callback) {
      if (states.indexOf(this._native.state) !== -1) return callback(this._native.state);
      this._native.waiting.push(function(state) {
        if (states.indexOf(state) === -1) return false;
        callback(state);
        return true;
      });
    }
    // The request fails or the app cancels it (emitRequestCanceled).
    _end(error, settleFirst) {
      var n = this._native;
      n.error = error;
      if (n.state === 'bodyStreamingStarted') this._send('didFailWithError', error.message);
      this._set('errorReceived', settleFirst);
      this._send('readyForJSFinalization');
    }
  }

  class NativeRequest extends SharedObject {
    constructor(response) {
      super();
      this.response = response;
    }
    start(url, init, body) {
      var request = this, response = this.response;
      request.url = url;
      request.init = init;
      request.body = body;
      native.requests.push(request);
      return new Promise(function(resolve, reject) {
        later(function() {
          if (response._native.state === 'initialized') response._set('started');
          var resolvesAt = native.startsAtBodyEnd ? 'bodyCompleted' : 'responseReceived';
          response._waitFor([resolvesAt, 'errorReceived'], function(state) {
            later(function() {
              native.log.push(state === 'errorReceived' ? 'start rejected' : 'start resolved');
              if (state === 'errorReceived') reject(response._native.error);
              else resolve();
            });
          });
        });
      });
    }
    cancel() {
      calls.cancel++;
      var request = this;
      request.cancelled = true;
      return new Promise(function(resolve) {
        later(function() {
          request.response._end(new Error('Fetch request has been canceled'));
          later(resolve);
        });
      });
    }

    // The native side, as the test drives it: the response head arrives.
    head(status, headers) {
      this.response._native.head = { status: status, statusText: '', url: this.url, headers: Object.entries(headers || {}) };
      this.response._set('responseReceived');
    }
    // Body data arrives: it waits in the sink until the app reads the body, and is dropped once
    // the app cancelled its stream.
    chunk(data) {
      var response = this.response, n = response._native;
      var bytes = toJS(typeof data === 'string' ? native.encode(data) : data);
      if (n.state === 'responseReceived') {
        n.sink.push(bytes);
        n.bodyUsed = true;
      } else if (n.state === 'bodyStreamingStarted') {
        response._send('didReceiveResponseData', bytes);
      }
    }
    // The body completes.
    done() {
      var response = this.response, n = response._native;
      if (['responseReceived', 'bodyStreamingStarted', 'bodyStreamingCanceled'].indexOf(n.state) === -1) return;
      if (n.state === 'bodyStreamingStarted') response._send('didComplete');
      response._set('bodyCompleted');
      response._send('readyForJSFinalization');
    }
    // The request fails. JS gets the end of the request before start rejects, or after it when the
    // rejection, sent at a higher priority, overtakes it on a busy JS thread.
    fail(message, settleFirst) {
      var n = this.response._native;
      if (['started', 'responseReceived', 'bodyStreamingStarted', 'bodyStreamingCanceled'].indexOf(n.state) === -1) return;
      this.response._end(new Error(message), settleFirst);
    }
    // Head, body and its completion: the body follows once start has resolved.
    respond(status, headers, body) {
      var request = this;
      request.head(status, headers);
      later(function() {
        later(function() {
          if (body !== undefined) request.chunk(body);
          request.done();
        });
      });
    }
  }

  globalThis.expo = { modules: { ExpoFetchModule: { NativeRequest: NativeRequest, NativeResponse: NativeResponse } } };
})()`;

/**
 * expo/fetch over that module, as expo/src/winter/fetch/fetch.ts and FetchResponse.ts write it
 * (SDK 57; SDK 55 where `sdk` says so): FetchResponse extends the native NativeResponse, its body is
 * a stream that pulls through startStreaming(), text() and arrayBuffer() read the native body (a
 * clone reads through a tee of the stream instead), json() goes through text() and blob() and
 * bytes() through arrayBuffer(), and it drops its stream listeners on readyForJSFinalization.
 * fetch() is `expoFetch` and reads NativeRequest off the module at each call. On SDK 55 a response
 * cannot clone and its text() and arrayBuffer() are the native ones.
 */
const EXPO_FETCH_JS = `(function() {
  var native = globalThis.__expoNative;
  var calls = native.calls;
  var ExpoFetchModule = globalThis.expo.modules.ExpoFetchModule;
  var NativeResponse = ExpoFetchModule.NativeResponse;

  class FetchError extends Error {
    constructor(message) { super('fetch failed: ' + message); }
  }

  function concat(chunks) {
    var size = 0, at = 0;
    chunks.forEach(function(chunk) { size += chunk.byteLength; });
    var out = new Uint8Array(size);
    chunks.forEach(function(chunk) { out.set(chunk, at); at += chunk.byteLength; });
    return out;
  }

  // The JS side of a body. After clone() each response reads its own branch of a tee.
  class Body {
    constructor(cloned) {
      this.streamingState = 'none';
      this.stream = null;
      this.cloned = cloned;
      this.consumed = false;
      this.detach = null;
    }
    get used() { return this.cloned ? this.consumed : this.consumed || this.streamingState !== 'none'; }
    async readAsBuffer() {
      if (this.stream == null) return new ArrayBuffer(0);
      var reader = this.stream.getReader(), chunks = [];
      try {
        for (;;) {
          var chunk = await reader.read();
          if (chunk.done) break;
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      return concat(chunks).buffer;
    }
  }

  // A branch of a tee that marks its body consumed on its first read.
  function wrapWithConsumption(source, body) {
    var reader = source.getReader(), marked = false, detached = false;
    function mark() { if (!marked && !detached) { marked = true; body.consumed = true; } }
    var stream = new ReadableStream({
      async pull(controller) {
        mark();
        try {
          var chunk = await reader.read();
          if (chunk.done) { controller.close(); reader.releaseLock(); } else controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
          reader.releaseLock();
        }
      },
      cancel(reason) { mark(); reader.cancel(reason).catch(function() {}); }
    }, { highWaterMark: 0 });
    return { stream: stream, detach: function() { detached = true; } };
  }

  class FetchResponse extends NativeResponse {
    constructor(abortCleanup) {
      super();
      this._body = new Body(false);
      this._metadata = null;
      this._streamClosed = false;
      this._controller = null;
      this._abortReason = undefined;
      this._abortCleanup = abortCleanup;
      this.finalize = () => {
        this.removeListener('readyForJSFinalization', this.finalize);
        this._abortCleanup();
        this.removeAllListeners('didReceiveResponseData');
        this.removeAllListeners('didComplete');
        this.removeAllListeners('didFailWithError');
      };
      this.addListener('readyForJSFinalization', this.finalize);
    }

    // Errors the body stream with the reason the app aborted with.
    abort(reason) {
      this._abortReason = reason != null ? reason : Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
      if (this._streamClosed) return;
      this._streamClosed = true;
      try { if (this._controller) this._controller.error(this._abortReason); } catch (e) {}
    }
    _close(controller) {
      if (this._streamClosed) return;
      this._streamClosed = true;
      if (controller.desiredSize == null) return;
      try { controller.close(); } catch (e) {}
    }
    _error(controller, error) {
      if (this._streamClosed) return;
      this._streamClosed = true;
      try { controller.error(error); } catch (e) {}
    }
    _enqueue(controller, data) {
      if (this._streamClosed || controller.desiredSize == null) return;
      try { controller.enqueue(data); } catch (e) {}
    }

    get _rawHeaders() { return this._metadata ? this._metadata.rawHeaders : super._rawHeaders; }
    get status() { return this._metadata ? this._metadata.status : super.status; }
    get statusText() { return this._metadata ? this._metadata.statusText : super.statusText; }
    get url() { return this._metadata ? this._metadata.url : super.url; }
    get redirected() { return this._metadata ? this._metadata.redirected : super.redirected; }
    get headers() { return new Headers(this._rawHeaders); }
    get ok() { return this.status >= 200 && this.status < 300; }

    get body() {
      calls.body++;
      var body = this._body;
      if (body.stream == null) {
        body.stream = new ReadableStream({
          start: (controller) => {
            this._controller = controller;
            if (this._abortReason !== undefined) {
              this._streamClosed = true;
              controller.error(this._abortReason);
              return;
            }
            if (body.streamingState === 'completed') return;
            this.addListener('didReceiveResponseData', (data) => { this._enqueue(controller, data); });
            this.addListener('didComplete', () => { this._close(controller); });
            this.addListener('didFailWithError', (error) => { this._error(controller, new Error(error)); });
          },
          pull: async (controller) => {
            if (body.streamingState === 'none') {
              var completed = await this.startStreaming();
              if (completed != null) {
                this._enqueue(controller, completed);
                this._close(controller);
                body.streamingState = 'completed';
              } else {
                body.streamingState = 'started';
              }
            } else if (body.streamingState === 'completed') {
              this._close(controller);
            }
          },
          cancel: (reason) => {
            this._streamClosed = true;
            this.cancelStreaming(String(reason));
          }
        }, { highWaterMark: 0 });
      }
      return body.stream;
    }
    get bodyUsed() { return this._body.used; }
    _checkUsed(method) {
      if (this._body.used || (this._body.stream && this._body.stream.locked)) {
        throw new TypeError("Failed to execute '" + method + "' on 'Response': Response body is already used.");
      }
    }

    // React Native's Blob, which Expo fills through its native blob store.
    async blob() {
      calls.blob++;
      this._checkUsed('blob');
      var type = this.headers.get('content-type') || '';
      var buffer = await this.arrayBuffer();
      return new Blob([new Uint8Array(buffer)], { type: type });
    }
    async json() {
      this._checkUsed('json');
      return JSON.parse(await this.text());
    }
    async bytes() {
      this._checkUsed('bytes');
      return new Uint8Array(await this.arrayBuffer());
    }
    async arrayBuffer() {
      this._checkUsed('arrayBuffer');
      var body = this._body;
      body.consumed = true;
      if (body.cloned) return body.readAsBuffer();
      return super.arrayBuffer();
    }
    async text() {
      this._checkUsed('text');
      var body = this._body;
      body.consumed = true;
      if (body.cloned) return new TextDecoder().decode(await body.readAsBuffer());
      return super.text();
    }
    clone() {
      calls.clone++;
      this._checkUsed('clone');
      var clone = Object.create(FetchResponse.prototype);
      clone._body = new Body(true);
      clone._metadata = {
        rawHeaders: this._rawHeaders.slice(), status: this.status, statusText: this.statusText,
        url: this.url, redirected: this.redirected
      };
      if (this.body != null) {
        if (this._body.detach) this._body.detach();
        var branches = this.body.tee();
        var own = wrapWithConsumption(branches[0], this._body);
        var sibling = wrapWithConsumption(branches[1], clone._body);
        this._body.stream = own.stream;
        this._body.detach = own.detach;
        clone._body.stream = sibling.stream;
        clone._body.detach = sibling.detach;
      }
      this._body.cloned = true;
      return clone;
    }
  }

  class FetchResponse55 extends FetchResponse {
    get bodyUsed() { return this._native.bodyUsed; }
    async json() { return JSON.parse(await this.text()); }
    async bytes() { return new Uint8Array(await this.arrayBuffer()); }
    clone() {
      calls.clone++;
      throw new Error('Not implemented');
    }
  }
  // SDK 55 inherits text() and arrayBuffer() from the native class.
  FetchResponse55.prototype.text = function() { return NativeResponse.prototype.text.apply(this, arguments); };
  FetchResponse55.prototype.arrayBuffer = function() { return NativeResponse.prototype.arrayBuffer.apply(this, arguments); };
  var Response = native.sdk === 55 ? FetchResponse55 : FetchResponse;
  native.FetchResponse = Response;

  function normalizeBody(body) {
    if (body == null) return null;
    // Copied into this realm: TextEncoder is the host's.
    if (typeof body === 'string') return new Uint8Array(new TextEncoder().encode(body));
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    throw new TypeError('Unsupported BodyInit type');
  }

  function normalizeMethod(method) {
    var upper = String(method).toUpperCase();
    return ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'].indexOf(upper) !== -1 ? upper : method;
  }

  globalThis.expoFetch = async function fetch(input, init) {
    init = init || {};
    var signal = init.signal;
    var headers = init.headers == null ? [] : Array.isArray(init.headers) ? init.headers : Object.entries(init.headers);
    var abortSubscription = null;
    var response = new Response(function() { if (abortSubscription) abortSubscription(); });
    var request = new ExpoFetchModule.NativeRequest(response);
    var requestBody = await normalizeBody(init.body);
    var nativeInit = {
      credentials: init.credentials || 'include',
      headers: headers,
      method: init.method != null ? normalizeMethod(init.method) : 'GET',
      redirect: init.redirect || 'follow'
    };
    if (signal && signal.aborted) throw new FetchError('The operation was aborted.');
    if (signal) {
      // SDK 57 errors the body stream before it cancels the native request.
      var onAbort = function() {
        if (native.sdk !== 55) response.abort(signal.reason);
        request.cancel();
      };
      signal.addEventListener('abort', onAbort);
      abortSubscription = function() { signal.removeEventListener('abort', onAbort); };
    }
    try {
      await request.start(String(input), nativeInit, requestBody);
    } catch (e) {
      throw new FetchError(e instanceof Error ? e.message : String(e));
    }
    return response;
  };
})()`;

interface CapturedRecord {
  requestId: string;
  state: string;
  resourceType: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
    postDataTruncated?: boolean;
  };
  response?: {
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
  };
  durationMs?: number;
  encodedDataLength?: number;
  errorText?: string;
  responseBody?: string;
  bodyTruncated?: boolean;
}

/** A request Expo's native module started, answered by the test as the native side. */
interface NativeRequestControl {
  body: Uint8Array | null;
  cancelled?: boolean;
  /** The NativeResponse it fills. */
  response: {
    addListener(event: string, listener: () => void): void;
    _native: { state: string };
    /** Changes the native state without sending the events that come with it. */
    _set(state: string): void;
  };
  /** The response head arrives: start resolves. */
  head(status: number, headers?: Record<string, string>): void;
  /** Body data arrives. */
  chunk(data: string | Uint8Array): void;
  /** The body completes: the request ends. */
  done(): void;
  /** The request fails; with settleFirst, start rejects before JS gets the end of the request. */
  fail(message: string, settleFirst?: boolean): void;
  /** Head, body and its completion, the body once start has resolved. */
  respond(status: number, headers?: Record<string, string>, body?: string | Uint8Array): void;
  /** NativeRequest.prototype.cancel, as expo/fetch calls it. */
  cancel(): Promise<void>;
}

/** The calls of Expo's methods that touch a body: native ones, and FetchResponse's body, clone and blob. */
interface ExpoCalls {
  text: number;
  arrayBuffer: number;
  startStreaming: number;
  cancelStreaming: number;
  cancel: number;
  body: number;
  clone: number;
  blob: number;
}

type Listener = (this: unknown) => void;

class FakeBlob {
  readonly data: Buffer;
  readonly type: string;
  closed = false;

  constructor(parts: Array<string | Uint8Array | FakeBlob> = [], options: { type?: string } = {}) {
    this.data = Buffer.concat(
      parts.map((part) =>
        part instanceof FakeBlob ? part.data : typeof part === "string" ? Buffer.from(part) : part
      )
    );
    this.type = options.type ?? "";
  }

  get size(): number {
    // React Native's Blob throws on access once it is closed.
    if (this.closed) throw new Error("Blob has been closed and is no longer available");
    return this.data.length;
  }

  slice(start = 0, end = this.size): FakeBlob {
    if (this.closed) throw new Error("Blob has been closed and is no longer available");
    return new FakeBlob([this.data.subarray(start, end)]);
  }

  close(): void {
    this.closed = true;
  }
}

/** React Native's FormData, which exposes its parts through getParts(). */
class FakeFormData {
  private readonly parts: Array<[string, unknown]> = [];

  append(name: string, value: unknown): void {
    this.parts.push([name, value]);
  }

  getParts(): Array<Record<string, unknown>> {
    return this.parts.map(([fieldName, value]) =>
      typeof value === "string"
        ? { string: value, fieldName, headers: {} }
        : { ...(value as object), fieldName, headers: {} }
    );
  }
}

interface RuntimeOptions {
  /** React Native's fetch, as the global fetch and as `rnFetch`. */
  polyfillFetch?: boolean;
  /**
   * Expo's native fetch module and expo/fetch as `expoFetch`. On SDK 57 a Response clones, on 55
   * clone() throws. `global` installs expo/fetch as the global fetch, marked as Expo's own, as
   * SDK 56+ does. `startsAtBodyEnd`: fetch resolves only after the whole body arrived and the
   * request ended, as a device showed for SDK 55 on iOS.
   */
  expo?: { sdk: 55 | 57; global?: boolean; startsAtBodyEnd?: boolean };
  /** iOS: FileReader.readAsText resolves null for bytes that are not valid UTF-8. */
  readAsTextNullOnInvalidUtf8?: boolean;
  /** event-target-shim (RN before 0.81): a listener added during dispatch runs for that event too. */
  liveDispatch?: boolean;
  /** Runs just before a FileReader read delivers its result. */
  beforeReadResult?: (blob: FakeBlob) => void;
}

/**
 * What the app's code in each context can call: `tick(value)` resolves on the next timer turn,
 * `readStream(response)` reads a body stream to its text, `countStream(response)` counts its bytes
 * and drops them, and `outcome(promise)` resolves with `{ value }` or `{ error }`.
 */
const APP_HELPERS = `
  function tick(value) { return new Promise(function(resolve) { setTimeout(function() { resolve(value); }, 0); }); }
  function readStream(response) {
    var reader = response.body.getReader(), decoder = new TextDecoder(), text = '';
    function pump() {
      return reader.read().then(function(chunk) {
        if (chunk.done) return text + decoder.decode();
        text += decoder.decode(chunk.value, { stream: true });
        return pump();
      });
    }
    return pump();
  }
  function countStream(response) {
    var reader = response.body.getReader(), size = 0;
    function pump() {
      return reader.read().then(function(chunk) {
        if (chunk.done) return size;
        size += chunk.value.byteLength;
        return pump();
      });
    }
    return pump();
  }
  function outcome(promise) {
    return promise.then(function(value) { return { value: value }; }, function(error) { return { error: error }; });
  }`;

/**
 * A JS context shaped like React Native's: its XHR, FileReader, Blob, FormData, AbortController
 * and fetch, and the app helpers above.
 */
function createRuntime({
  polyfillFetch = false,
  expo,
  readAsTextNullOnInvalidUtf8 = false,
  liveDispatch = false,
  beforeReadResult,
}: RuntimeOptions = {}) {
  const sends: FakeXMLHttpRequest[] = [];
  const reads: FakeBlob[] = [];
  const expoNative = {
    sdk: expo?.sdk,
    startsAtBodyEnd: expo?.startsAtBodyEnd ?? false,
    requests: [] as NativeRequestControl[],
    calls: {
      text: 0,
      arrayBuffer: 0,
      startStreaming: 0,
      cancelStreaming: 0,
      cancel: 0,
      body: 0,
      clone: 0,
      blob: 0,
    } satisfies ExpoCalls,
    log: [] as string[],
    encode: (text: string) => new TextEncoder().encode(text),
    // Native text() keeps a byte order mark.
    decode: (bytes: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
  };

  /** Models React Native's XMLHttpRequest: event order, responseURL timing and incremental-events flag. */
  class FakeXMLHttpRequest {
    readyState = 0;
    status = 0;
    responseType = "";
    responseURL: string | undefined = undefined;
    declare onload: Listener | null;
    declare onloadend: Listener | null;
    declare onerror: Listener | null;
    declare ontimeout: Listener | null;
    declare onabort: Listener | null;
    declare onreadystatechange: Listener | null;
    _incrementalEvents = false;

    method = "";
    url = "";
    requestHeaders: Record<string, string> = {};
    body: unknown;
    /** The incremental-events flag each send handed to the native module. */
    readonly incrementalAtSend: boolean[] = [];
    readonly listeners = new Map<string, Listener[]>();

    private sent = false;
    _aborted = false;
    _hasError = false;
    _timedOut = false;
    private responseHeaders: Record<string, string> | undefined;
    private raw: unknown = "";

    constructor() {
      // React Native registers an on<event> handler as a listener when it is first assigned,
      // so it runs in order with the listeners added before and after it.
      for (const type of ["readystatechange", "load", "loadend", "error", "timeout", "abort"]) {
        let handler: Listener | null = null;
        let registered = false;
        Object.defineProperty(this, `on${type}`, {
          get: () => handler,
          set: (value: Listener | null) => {
            handler = value;
            if (registered || !value) return;
            registered = true;
            this.addListener(type, function (this: unknown) {
              handler?.call(this);
            });
          },
        });
      }
    }

    open(method: string, url: string): void {
      if (this.readyState !== 0) throw new Error("Cannot open, already sending");
      this.method = method.toUpperCase();
      this.url = url;
      this._aborted = false;
      this.setReadyState(1);
    }

    setRequestHeader(name: string, value: unknown): void {
      if (this.readyState !== 1) throw new Error("Request has not been opened");
      this.requestHeaders[name.toLowerCase()] = String(value);
    }

    send(body?: unknown): void {
      if (this.readyState !== 1) throw new Error("Request has not been opened");
      if (this.sent) throw new Error("Request has already been sent");
      this.sent = true;
      this.body = body;
      this.incrementalAtSend.push(this._incrementalEvents || !!this.onreadystatechange);
      sends.push(this);
    }

    abort(): void {
      this._aborted = true;
      if (
        !(this.readyState === 0 || (this.readyState === 1 && !this.sent) || this.readyState === 4)
      ) {
        this.reset();
        this.setReadyState(4);
      }
      this.reset();
    }

    addEventListener(type: string, listener: Listener): void {
      if (type === "readystatechange" || type === "progress") this._incrementalEvents = true;
      this.addListener(type, listener);
    }

    removeEventListener(type: string, listener: Listener): void {
      const list = this.listeners.get(type) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    }

    private addListener(type: string, listener: Listener): void {
      const list = this.listeners.get(type);
      if (list) list.push(listener);
      else this.listeners.set(type, [listener]);
    }

    get response(): unknown {
      if (this.responseType !== "json") return this.raw;
      try {
        return JSON.parse(this.raw as string);
      } catch {
        return null;
      }
    }

    get responseText(): string {
      if (this.responseType !== "" && this.responseType !== "text") {
        throw new Error("responseText needs a text responseType");
      }
      return this.raw as string;
    }

    getAllResponseHeaders(): string | null {
      if (!this.responseHeaders) return null;
      return Object.entries(this.responseHeaders)
        .map(([name, value]) => `${name}: ${value}`)
        .join("\r\n");
    }

    /** Native side: the response headers arrive. */
    receiveHeaders(status: number, headers: Record<string, string>, responseURL = this.url): void {
      this.status = status;
      this.responseHeaders = headers;
      this.setReadyState(2);
      // Like React Native, responseURL is set only after HEADERS_RECEIVED is announced.
      this.responseURL = responseURL;
    }

    /** Native side: headers, data and completion of a response. */
    respond(
      status: number,
      headers: Record<string, string>,
      body: string | ArrayBuffer | Uint8Array,
      responseURL = this.url
    ): void {
      this.receiveHeaders(status, headers, responseURL);
      this.raw = this.responseType === "blob" ? new FakeBlob([body as string | Uint8Array]) : body;
      this.setReadyState(3);
      this.setReadyState(4);
    }

    /** Native side: the request fails or times out. */
    fail(error: string, timedOut = false): void {
      if (this.responseType === "" || this.responseType === "text") this.raw = error;
      this._hasError = true;
      this._timedOut = timedOut;
      this.setReadyState(4);
    }

    dispatch(type: string): void {
      const list = this.listeners.get(type) ?? [];
      if (liveDispatch) {
        // event-target-shim walks the live list: a listener added now runs for this event too,
        // and removing one does not skip the listener after it.
        const called = new Set<Listener>();
        let next: Listener | undefined = list[0];
        while (next) {
          called.add(next);
          next.call(this);
          next = list.find((listener) => !called.has(listener));
        }
        return;
      }
      // RN 0.81+ dispatches over a snapshot and skips listeners removed during dispatch.
      for (const listener of [...list]) if (list.includes(listener)) listener.call(this);
    }

    private setReadyState(state: number): void {
      this.readyState = state;
      this.dispatch("readystatechange");
      if (state !== 4) return;
      if (this._aborted) this.dispatch("abort");
      else if (!this._hasError) this.dispatch("load");
      else this.dispatch(this._timedOut ? "timeout" : "error");
      this.dispatch("loadend");
    }

    private reset(): void {
      this.readyState = 0;
      this.status = 0;
      this.responseHeaders = undefined;
      this.responseURL = undefined;
      this.raw = "";
      this.responseType = "";
      this.sent = false;
      this.requestHeaders = {};
      this._hasError = false;
      this._timedOut = false;
    }
  }

  class FakeFileReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    readAsText(blob: FakeBlob): void {
      reads.push(blob);
      setImmediate(() => {
        beforeReadResult?.(blob);
        this.result =
          readAsTextNullOnInvalidUtf8 && !isUtf8(blob.data) ? null : blob.data.toString("utf8");
        this.onload?.();
      });
    }
  }

  const context = createContext({
    XMLHttpRequest: FakeXMLHttpRequest,
    FileReader: FakeFileReader,
    Blob: FakeBlob,
    FormData: FakeFormData,
    AbortController,
    setTimeout,
    clearTimeout,
  });
  const run = (code: string): unknown => runInContext(code, context);
  run(APP_HELPERS);
  if (polyfillFetch) {
    run(WHATWG_FETCH);
    run("var rnFetch = fetch;");
  }
  if (expo) {
    Object.assign(context, {
      TextEncoder,
      TextDecoder,
      ReadableStream,
      Headers,
      __expoNative: expoNative,
    });
    run(EXPO_NATIVE);
    run(EXPO_FETCH_JS);
    if (expo.global) {
      run(
        `Object.defineProperty(expoFetch, Symbol.for('expo.builtin'), { value: true }); fetch = expoFetch;`
      );
    }
  }

  return {
    context,
    sends,
    reads,
    run,
    /** The requests Expo's native module started. */
    native: expoNative.requests,
    /** The calls of Expo's methods that touch a body so far. */
    expoCalls: (): ExpoCalls => ({ ...expoNative.calls }),
    /** The end events and start settlements of Expo's requests, in the order JS got them. */
    expoLog: () => expoNative.log.filter((event) => event !== "didReceiveResponseData"),
    /** The requests that left JavaScript: XHR sends and Expo native starts. */
    sent: () => sends.length + expoNative.requests.length,
    install: () => JSON.parse(run(NETWORK_INTERCEPTOR_SCRIPT) as string) as unknown,
    records: () => JSON.parse(JSON.stringify(context.__argent_network_log)) as CapturedRecord[],
    last: () => sends[sends.length - 1]!,
  };
}

type Runtime = ReturnType<typeof createRuntime>;
type FakeXhr = ReturnType<Runtime["last"]>;

/** A runtime whose app replaced the global fetch with `wrapper` at startup, before the install. */
function appWrapped(wrapper: string, options: RuntimeOptions = { polyfillFetch: true }): Runtime {
  const rt = createRuntime(options);
  rt.run(wrapper);
  rt.install();
  return rt;
}

const EXPO_GLOBAL: RuntimeOptions = { polyfillFetch: true, expo: { sdk: 57, global: true } };

// An app's own Response class over the Response it got.
const API_RESPONSE = `function ApiResponse(r) { this.raw = r; this.status = r.status; this.url = r.url; this.headers = r.headers; }
  ApiResponse.prototype.clone = function() { return new ApiResponse(this.raw.clone()); };
  ApiResponse.prototype.text = function() { return this.raw.text(); };
  Object.defineProperty(ApiResponse.prototype, 'body', { get: function() { return this.raw.body; } });`;

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Waits until Expo's native side has taken `request` to `state`. */
async function untilNativeState(request: NativeRequestControl, state: string): Promise<void> {
  for (let i = 0; i < 20 && request.response._native.state !== state; i++) await settle();
  expect(request.response._native.state).toBe(state);
}

/** `count` requests have left JavaScript (by default, however many have), and each has one record. */
function expectRecordPerRequest(rt: Runtime, count = rt.sent()): void {
  expect(rt.sent()).toBe(count);
  expect(rt.records()).toHaveLength(count);
}

/** Waits until `count` requests have left JavaScript, checking at every step that each has one record. */
async function untilSent(rt: Runtime, count: number): Promise<void> {
  expectRecordPerRequest(rt);
  for (let i = 0; i < 20 && rt.sent() < count; i++) {
    await settle();
    expectRecordPerRequest(rt);
  }
  expectRecordPerRequest(rt, count);
}

/** The name of what a promise rejected with. */
async function rejectionName(promise: Promise<unknown>): Promise<string> {
  const reason = (await promise.then(
    () => ({ name: "(resolved)" }),
    (error: unknown) => error
  )) as { name: string };
  return reason.name;
}

describe("NETWORK_INTERCEPTOR_SCRIPT", () => {
  describe("XMLHttpRequest", () => {
    it("records an axios-style XHR and leaves its response to the app", async () => {
      const rt = createRuntime();
      rt.install();
      rt.run(`
        var seen;
        var x = new XMLHttpRequest();
        x.open('get', 'https://api.test/users?page=2', true);
        x.setRequestHeader('Accept', 'application/json');
        x.onloadend = function() { seen = x.status + ' ' + x.responseText; };
        x.send(null);
      `);
      const body = '{"name":"Zoë 👋"}';
      rt.last().respond(200, { "Content-Type": "application/json; charset=utf-8" }, body);
      await settle();

      expect(rt.run("seen")).toBe(`200 ${body}`);
      expect(rt.last().incrementalAtSend).toEqual([false]);
      expect(rt.records()).toHaveLength(1);
      expect(rt.records()[0]).toMatchObject({
        requestId: "rn-net-1",
        state: "finished",
        resourceType: "XHR",
        request: {
          method: "GET",
          url: "https://api.test/users?page=2",
          headers: { accept: "application/json" },
        },
        response: {
          url: "https://api.test/users?page=2",
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
          mimeType: "application/json",
        },
        responseBody: body,
        encodedDataLength: Buffer.byteLength(body),
      });
      expect(rt.records()[0].durationMs).toEqual(expect.any(Number));
    });

    it.each([
      { responseType: "text", body: "plain", responseBody: "plain", encodedDataLength: 5 },
      {
        responseType: "json",
        body: '{ "a": [1, 2] }',
        responseBody: '{"a":[1,2]}',
        encodedDataLength: undefined,
      },
    ])(
      "reads a $responseType response body",
      ({ responseType, body, responseBody, encodedDataLength }) => {
        const rt = createRuntime();
        rt.install();
        rt.run(
          `var x = new XMLHttpRequest(); x.open('GET', 'https://api.test/t'); x.responseType = '${responseType}'; x.send();`
        );
        rt.last().respond(200, {}, body);

        expect(rt.records()[0]).toMatchObject({
          state: "finished",
          responseBody,
        });
        expect(rt.records()[0]!.encodedDataLength).toBe(encodedDataLength);
      }
    );

    it.each([
      { counter: "TextEncoder", textEncoder: true },
      { counter: "the fallback loop", textEncoder: false },
    ])("counts the UTF-8 bytes of a text body with $counter", ({ textEncoder }) => {
      const rt = createRuntime();
      if (textEncoder) rt.context.TextEncoder = TextEncoder;
      rt.install();
      rt.run(`var x = new XMLHttpRequest(); x.open('GET', 'https://api.test/u'); x.send();`);
      const body = "ascii é ✓ 👋 \ud800";
      rt.last().respond(200, {}, body);

      expect(rt.records()[0]!.encodedDataLength).toBe(Buffer.byteLength(body));
    });

    it("records only the byte length of an arraybuffer response", () => {
      const rt = createRuntime();
      rt.install();
      rt.run(
        `var x = new XMLHttpRequest(); x.open('GET', 'https://api.test/bin'); x.responseType = 'arraybuffer'; x.send();`
      );
      rt.last().respond(200, {}, new ArrayBuffer(16));

      expect(rt.records()[0]).toMatchObject({ state: "finished", encodedDataLength: 16 });
      expect(rt.records()[0].responseBody).toBeUndefined();
    });

    it.each([
      {
        outcome: "an error",
        end: (x: FakeXhr) => x.fail("Unable to resolve host"),
        errorText: "Unable to resolve host",
      },
      {
        outcome: "a timeout",
        end: (x: FakeXhr) => x.fail("timed out", true),
        errorText: "timeout",
      },
      {
        outcome: "an abort",
        end: (x: FakeXhr) => x.abort(),
        errorText: "aborted",
      },
    ])("records $outcome as a failed request", ({ end, errorText }) => {
      const rt = createRuntime();
      rt.install();
      rt.run(`var x = new XMLHttpRequest(); x.open('GET', 'https://api.test/f'); x.send();`);
      end(rt.last());

      expect(rt.records()).toHaveLength(1);
      expect(rt.records()[0]).toMatchObject({ state: "failed", errorText });
      expect(rt.records()[0].durationMs).toEqual(expect.any(Number));
    });

    it("mints a record per send on a reused XHR without stacking listeners", () => {
      const rt = createRuntime();
      rt.install();
      rt.run(`
        var x = new XMLHttpRequest();
        x.open('GET', 'https://api.test/first');
        x.send();
        x.abort();
        x.open('POST', 'https://api.test/second');
        x.setRequestHeader('X-Attempt', '2');
        x.send('retry');
      `);
      const xhr = rt.last();
      const types = ["readystatechange", "load", "error", "timeout", "abort"];
      // The aborted request removed its listeners: only the second request's remain.
      for (const type of types) expect(xhr.listeners.get(type)).toHaveLength(1);
      xhr.respond(200, {}, "done");

      for (const type of types) expect(xhr.listeners.get(type)).toHaveLength(0);
      expect(rt.sends).toHaveLength(2);
      expect(rt.sends[0]).toBe(xhr);
      expect(xhr.incrementalAtSend).toEqual([false, false]);
      const [first, second] = rt.records();
      expect(first).toMatchObject({
        requestId: "rn-net-1",
        state: "failed",
        errorText: "aborted",
        request: { method: "GET", url: "https://api.test/first", headers: {} },
      });
      expect(second).toMatchObject({
        requestId: "rn-net-2",
        state: "finished",
        request: {
          method: "POST",
          url: "https://api.test/second",
          headers: { "x-attempt": "2" },
          postData: "retry",
        },
        response: { status: 200 },
        responseBody: "done",
      });
    });

    it.each([
      { dispatch: "RN 0.81+", liveDispatch: false },
      { dispatch: "event-target-shim", liveDispatch: true },
    ])(
      "keeps each poll's record when the app reuses the XHR from its load handler ($dispatch)",
      ({ liveDispatch }) => {
        const rt = createRuntime({ liveDispatch });
        rt.install();
        rt.run(`
        var polls = 0;
        var x = new XMLHttpRequest();
        x.onload = function() {
          polls++;
          if (polls < 2) { x.abort(); x.open('GET', 'https://api.test/poll/' + polls); x.send(); }
        };
        x.open('GET', 'https://api.test/poll/0');
        x.send();
      `);
        rt.last().respond(200, {}, "zero");
        expect(rt.records()[1]).toMatchObject({ state: "pending" });
        rt.last().respond(201, {}, "one");

        expect(rt.records()).toMatchObject([
          {
            request: { url: "https://api.test/poll/0" },
            state: "finished",
            response: { status: 200 },
            responseBody: "zero",
          },
          {
            request: { url: "https://api.test/poll/1" },
            state: "finished",
            response: { status: 201 },
            responseBody: "one",
          },
        ]);
      }
    );

    it.each([
      { dispatch: "RN 0.81+", liveDispatch: false },
      { dispatch: "event-target-shim", liveDispatch: true },
    ])(
      "keeps both records when the app retries on the same XHR from its error handler ($dispatch)",
      ({ liveDispatch }) => {
        const rt = createRuntime({ liveDispatch });
        rt.install();
        rt.run(`
        var x = new XMLHttpRequest();
        x.onerror = function() { x.abort(); x.open('GET', 'https://api.test/retry'); x.send(); };
        x.open('GET', 'https://api.test/retry');
        x.send();
      `);
        rt.last().fail("offline");
        expect(rt.records()[1]).toMatchObject({ state: "pending" });
        rt.last().respond(200, {}, "ok");

        expect(rt.records()).toMatchObject([
          { state: "failed", errorText: "offline" },
          { state: "finished", response: { status: 200 }, responseBody: "ok" },
        ]);
      }
    );

    it("keeps both records when the app reuses the XHR from onreadystatechange", () => {
      const rt = createRuntime();
      rt.install();
      rt.run(`
        var polls = 0;
        var x = new XMLHttpRequest();
        x.onreadystatechange = function() {
          if (x.readyState !== 4 || polls++ > 0) return;
          x.abort();
          x.open('GET', 'https://api.test/poll/1');
          x.send();
        };
        x.open('GET', 'https://api.test/poll/0');
        x.send();
      `);
      rt.last().respond(200, {}, "zero");
      expect(rt.records()[1]).toMatchObject({ state: "pending" });
      rt.last().respond(201, {}, "one");

      expect(rt.records()).toMatchObject([
        { state: "finished", response: { status: 200 }, responseBody: "zero" },
        { state: "finished", response: { status: 201 }, responseBody: "one" },
      ]);
    });

    it("reads a blob body when the app reuses the XHR from its load handler", async () => {
      const rt = createRuntime();
      rt.install();
      rt.run(`
        var polls = 0;
        var x = new XMLHttpRequest();
        x.onload = function() {
          if (polls++ > 0) return;
          x.abort();
          x.open('GET', 'https://api.test/blob/1');
          x.responseType = 'blob';
          x.send();
        };
        x.open('GET', 'https://api.test/blob/0');
        x.responseType = 'blob';
        x.send();
      `);
      rt.last().respond(200, {}, "blob-zero");
      rt.last().respond(200, {}, "blob-one");
      await settle();

      expect(rt.records()).toMatchObject([
        { state: "finished", responseBody: "blob-zero", encodedDataLength: 9 },
        { state: "finished", responseBody: "blob-one", encodedDataLength: 8 },
      ]);
    });

    it("records an abort as aborted when the app's abort handler aborts again", () => {
      const rt = createRuntime();
      rt.install();
      rt.run(`
        var x = new XMLHttpRequest();
        x.onabort = function() { x.abort(); };
        x.open('GET', 'https://api.test/slow');
        x.send();
      `);
      rt.last().receiveHeaders(200, {});
      rt.run("x.abort()");

      expect(rt.records()).toHaveLength(1);
      expect(rt.records()[0]).toMatchObject({ state: "failed", errorText: "aborted" });
      expect(rt.records()[0]!.responseBody).toBeUndefined();
    });

    it("drops a request RN reset from under it, so it cannot take the next response", () => {
      const rt = createRuntime();
      rt.install();
      rt.run(`
        var n = 0;
        var x = new XMLHttpRequest();
        function start() { x.open('GET', 'https://api.test/poll/' + n++); x.send(); }
        // Re-sent from inside the abort's own dispatch: RN's abort then resets the XHR once more.
        x.onabort = function() { if (n === 1) { x.abort(); start(); } };
        start();
        x.abort();
        start();
      `);
      rt.last().respond(200, {}, "two");

      expect(rt.records()).toMatchObject([
        { request: { url: "https://api.test/poll/0" }, state: "failed", errorText: "aborted" },
        { request: { url: "https://api.test/poll/1" }, state: "failed", errorText: "aborted" },
        { request: { url: "https://api.test/poll/2" }, state: "finished", responseBody: "two" },
      ]);
      expect(rt.records()[1]!.response).toBeUndefined();
    });

    it("records a request the app sends from its readyState 1 handler", () => {
      const rt = createRuntime();
      rt.install();
      rt.run(`
        var x = new XMLHttpRequest();
        x.onreadystatechange = function() {
          if (x.readyState === 1) { x.setRequestHeader('X-From-Open', '1'); x.send(); }
        };
        x.open('GET', 'https://api.test/from-open');
      `);
      rt.last().respond(200, {}, "ok");

      expect(rt.records()).toHaveLength(1);
      expect(rt.records()[0]).toMatchObject({
        request: { url: "https://api.test/from-open", headers: { "x-from-open": "1" } },
        state: "finished",
        responseBody: "ok",
      });
    });

    it("ignores events that reach an XHR after its abort", () => {
      const rt = createRuntime();
      rt.install();
      rt.run(
        `var x = new XMLHttpRequest(); x.open('GET', 'https://api.test/slow'); x.send(); x.abort();`
      );
      const xhr = rt.last();
      // On iOS an abort before the request id arrives cannot cancel the native request,
      // so its response still walks the aborted object.
      xhr.receiveHeaders(200, { "content-type": "text/plain" });
      xhr.dispatch("load");

      expect(rt.records()).toHaveLength(1);
      expect(rt.records()[0]).toMatchObject({ state: "failed", errorText: "aborted" });
      expect(rt.records()[0].response).toBeUndefined();
    });

    it("records headers and summarizes FormData, Blob and binary bodies without changing the request", () => {
      const rt = createRuntime();
      rt.install();
      rt.run(`
        var form = new FormData();
        form.append('name', 'Ada');
        form.append('avatar', { uri: 'file:///tmp/a.png', name: 'a.png', type: 'image/png' });
        var up = new XMLHttpRequest();
        up.open('POST', 'https://api.test/upload');
        up.setRequestHeader('Authorization', 'Bearer t');
        up.setRequestHeader('Accept', 'text/plain');
        up.setRequestHeader('accept', 'application/json');
        up.send(form);
        var bin = new XMLHttpRequest();
        bin.open('PUT', 'https://api.test/bytes');
        bin.send(new Uint8Array(12));
        bin.setRequestHeader('X-Late', '1');
        var blobUp = new XMLHttpRequest();
        blobUp.open('POST', 'https://api.test/blob');
        blobUp.send(new Blob(['abc']));
      `);
      const [upload, binary] = rt.sends;
      const headers = { authorization: "Bearer t", accept: "application/json" };

      expect(upload!.requestHeaders).toEqual(headers);
      expect(upload!.url).toBe("https://api.test/upload");
      expect(upload!.body).toBe(rt.run("form"));
      expect((binary!.body as Uint8Array).byteLength).toBe(12);
      const [uploadRecord, binaryRecord, blobRecord] = rt.records();
      expect(uploadRecord!.request).toEqual({
        method: "POST",
        url: "https://api.test/upload",
        headers,
        postData: "[FormData] name=Ada; avatar=<file a.png image/png>",
      });
      expect(binaryRecord!.request).toEqual({
        method: "PUT",
        url: "https://api.test/bytes",
        headers: {},
        postData: "[binary 12 bytes]",
      });
      expect(blobRecord!.request.postData).toBe("[Blob 3 bytes]");
    });

    it("keeps the response headers when the app aborts from its own HEADERS_RECEIVED handler", () => {
      const rt = createRuntime();
      rt.install();
      // Set before send, as an upload that gives up on a 413 does: it runs before the interceptor's listener.
      rt.run(`
        var x = new XMLHttpRequest();
        x.open('PUT', 'https://video.test/upload');
        x.onreadystatechange = function() { if (x.readyState === 2 && x.status === 413) x.abort(); };
        x.send(new Uint8Array(4));
      `);
      rt.last().receiveHeaders(413, { "content-type": "application/json" });

      expectRecordPerRequest(rt, 1);
      expect(rt.records()[0]).toMatchObject({
        state: "failed",
        errorText: "aborted",
        response: { status: 413, mimeType: "application/json" },
      });
    });
  });

  describe("React Native's fetch", () => {
    it("records a GET once, as a Fetch, and leaves the global fetch as it is", async () => {
      const rt = createRuntime({ polyfillFetch: true });
      const fetch = rt.run("fetch");
      rt.install();
      expect(rt.run("fetch")).toBe(fetch);
      expect(rt.run("fetch.polyfill")).toBe(true);

      const pending = rt.run(
        `fetch('https://api.test/old').then(function(r) { return r.text().then(function(text) { return r.url + ' ' + text; }); })`
      ) as Promise<string>;
      expectRecordPerRequest(rt, 1);
      const body = JSON.stringify({ token: "héllo" });
      rt.last().respond(200, { "content-type": "application/json" }, body, "https://api.test/new");
      expect(await pending).toBe(`https://api.test/new ${body}`);
      await settle();

      expectRecordPerRequest(rt, 1);
      expect(rt.records()[0]).toMatchObject({
        resourceType: "Fetch",
        state: "finished",
        request: { method: "GET", url: "https://api.test/old" },
        response: { url: "https://api.test/new", status: 200, mimeType: "application/json" },
        responseBody: body,
        encodedDataLength: Buffer.byteLength(body),
      });
    });

    it("records a POST with the headers and body it sends", async () => {
      const rt = createRuntime({ polyfillFetch: true });
      rt.install();
      const pending = rt.run(`fetch('https://api.test/login', {
        method: 'post',
        headers: { 'Content-Type': 'application/json' },
        body: '{"user":"ada"}'
      })`) as Promise<unknown>;
      rt.last().respond(201, {}, "");
      await pending;
      await settle();

      expectRecordPerRequest(rt, 1);
      expect(rt.records()[0]).toMatchObject({
        state: "finished",
        request: {
          method: "POST",
          url: "https://api.test/login",
          headers: { "content-type": "application/json" },
          postData: '{"user":"ada"}',
        },
        response: { status: 201 },
      });
    });

    it.each([
      {
        outcome: "fails",
        end: (rt: Runtime) => rt.last().fail("Unable to resolve host"),
        rejection: "TypeError",
        errorText: "Network error",
      },
      {
        outcome: "is aborted",
        end: (rt: Runtime) => rt.run("controller.abort()"),
        rejection: "AbortError",
        errorText: "aborted",
      },
    ])(
      "records a fetch that $outcome as one failed request",
      async ({ end, rejection, errorText }) => {
        const rt = createRuntime({ polyfillFetch: true });
        rt.install();
        const pending = rt.run(
          `var controller = new AbortController(); fetch('https://api.test/f', { signal: controller.signal })`
        ) as Promise<unknown>;
        end(rt);

        expect(await rejectionName(pending)).toBe(rejection);
        await settle();
        expectRecordPerRequest(rt, 1);
        expect(rt.records()[0]).toMatchObject({
          resourceType: "Fetch",
          state: "failed",
          errorText,
        });
      }
    );

    it("records the URL with the cache buster React Native's fetch adds", () => {
      const rt = createRuntime({ polyfillFetch: true });
      rt.install();
      rt.run(`fetch('https://api.test/feed?page=2', { cache: 'no-store' })`);

      expectRecordPerRequest(rt, 1);
      expect(rt.last().url).toMatch(/^https:\/\/api\.test\/feed\?page=2&_=\d+$/);
      expect(rt.records()[0]!.request.url).toBe(rt.last().url);
    });

    it("records a HEAD request with its empty body, whatever its Content-Length says", async () => {
      const rt = createRuntime({ polyfillFetch: true });
      rt.install();
      const pending = rt.run(
        `fetch('https://api.test/video', { method: 'HEAD' })`
      ) as Promise<unknown>;
      rt.last().respond(200, { "content-length": "524288000" }, "");
      await pending;
      await settle();

      expectRecordPerRequest(rt, 1);
      expect(rt.records()[0]).toMatchObject({
        state: "finished",
        request: { method: "HEAD" },
        responseBody: "",
        encodedDataLength: 0,
      });
    });

    it.each([
      { request: "with an aborted signal", init: "{ signal: aborted }", rejection: "AbortError" },
      { request: "that new Request rejects", init: "{ body: 'on a GET' }", rejection: "TypeError" },
    ])("records nothing for a fetch $request, which sends nothing", async ({ init, rejection }) => {
      const rt = createRuntime({ polyfillFetch: true });
      rt.install();
      const pending = rt.run(
        `var c = new AbortController(); c.abort(); var aborted = c.signal; fetch('https://api.test/none', ${init})`
      ) as Promise<unknown>;

      expect(await rejectionName(pending)).toBe(rejection);
      expectRecordPerRequest(rt, 0);
    });
  });

  // Each wrapper replaced the global fetch at startup, before the install: the global fetch the
  // interceptor finds is the app's.
  describe("app wrappers over React Native's fetch", () => {
    it.each([
      {
        through: "a wrapper that passes the Response through, as Sentry's does",
        code: `fetch = function(u, init) { return rnFetch(u, init).then(function(r) { return r; }, function(e) { throw e; }); };`,
      },
      {
        through: "a wrapper that awaits a token before it sends",
        code: `fetch = async function(u, init) { var token = await tick('t1'); return rnFetch(u, { headers: { Authorization: 'Bearer ' + token } }); };`,
      },
      {
        through: "a wrapper that rewrites the URL",
        code: `fetch = function(path, init) { return rnFetch('https://api.test' + path, init); };`,
        call: `fetch('/me')`,
      },
      {
        through: "a wrapper that resolves parsed JSON",
        code: `fetch = async function(u, init) { return (await rnFetch(u, init)).json(); };`,
      },
      {
        through: "a wrapper that rebuilds the Response from its text",
        code: `fetch = async function(u, init) { var r = await rnFetch(u, init); return new Response(await r.text(), r); };`,
      },
      {
        through: "a wrapper that resolves its own Response class",
        code: `${API_RESPONSE} fetch = async function(u, init) { return new ApiResponse(await rnFetch(u, init)); };`,
      },
      {
        through: "React Native's fetch that a module captured before the install",
        code: `var captured = fetch; fetch = function(u, init) { return captured(u, init); };`,
        call: `captured('https://api.test/me')`,
      },
    ])(
      "records one request made through $through",
      async ({ code, call = `fetch('https://api.test/me')` }) => {
        const rt = appWrapped(code);
        const pending = rt.run(call) as Promise<unknown>;
        await untilSent(rt, 1);
        rt.last().respond(200, { "content-type": "application/json" }, '{"id":7}');
        await pending;
        await settle();

        expectRecordPerRequest(rt, 1);
        expect(rt.records()[0]).toMatchObject({
          resourceType: "Fetch",
          state: "finished",
          request: { url: "https://api.test/me" },
          responseBody: '{"id":7}',
        });
      }
    );

    const SHARED = `var inflight = {};
      function shared(u, init) {
        if (!inflight[u]) inflight[u] = rnFetch(u, init).finally(function() { delete inflight[u]; });
        return inflight[u];
      }`;

    it.each([
      { wrapper: "returns one promise to every caller", code: `${SHARED} fetch = shared;` },
      {
        wrapper: "gives every caller a clone",
        code: `${SHARED} fetch = function(u, init) { return shared(u, init).then(function(r) { return r.clone(); }); };`,
      },
      {
        wrapper: "shares it under an async auth layer",
        code: `${SHARED} fetch = async function(u, init) { await tick(); return shared(u, init); };`,
      },
      {
        wrapper: "gives every caller its own Response class",
        code: `${SHARED} ${API_RESPONSE} fetch = function(u, init) { return shared(u, init).then(function(r) { return new ApiResponse(r.clone()); }); };`,
      },
    ])("records one request for three callers of a wrapper that $wrapper", async ({ code }) => {
      const rt = appWrapped(code);
      const pending = rt.run(
        `Promise.all([fetch('https://api.test/feed'), fetch('https://api.test/feed'), fetch('https://api.test/feed')])`
      ) as Promise<Array<{ status: number }>>;
      await untilSent(rt, 1);
      rt.last().respond(200, {}, "feed");
      expect((await pending).map((r) => r.status)).toEqual([200, 200, 200]);
      await settle();

      expectRecordPerRequest(rt, 1);
      expect(rt.records()[0]).toMatchObject({ state: "finished", responseBody: "feed" });
    });

    it("records one request when a caller joins it after its XHR loaded", async () => {
      const rt = appWrapped(`${SHARED} fetch = shared;`);
      const first = rt.run(`fetch('https://api.test/feed')`) as Promise<unknown>;
      rt.last().respond(200, {}, "feed");
      // React Native's fetch resolves on the next timer turn: the request is still shared.
      const second = rt.run(`fetch('https://api.test/feed')`) as Promise<unknown>;
      expect(await second).toBe(await first);
      await settle();

      expectRecordPerRequest(rt, 1);
    });

    it("records a request a timeout gave up on before it was sent, once it is sent", async () => {
      const rt = appWrapped(`fetch = function(u, init) {
        var request = new Promise(function(resolve) { setTimeout(resolve, 10); }).then(function() { return rnFetch(u, init); });
        var timeout = new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout')); }, 0); });
        return Promise.race([request, timeout]);
      };`);
      const pending = rt.run(`fetch('https://api.test/slow')`) as Promise<unknown>;
      expect(await rejectionName(pending)).toBe("Error");
      expectRecordPerRequest(rt, 0);
      await untilSent(rt, 1);
      rt.last().respond(200, {}, "late");
      await settle();

      expectRecordPerRequest(rt, 1);
      expect(rt.records()[0]).toMatchObject({ state: "finished", responseBody: "late" });
    });

    it("records both requests when a queue sends one inside the next call", async () => {
      const rt = appWrapped(`var queued = null;
        fetch = function(u, init) {
          var previous = queued;
          queued = null;
          if (previous) previous();
          return new Promise(function(resolve, reject) {
            queued = function() { rnFetch(u, init).then(resolve, reject); };
          });
        };`);
      const first = rt.run(`fetch('https://api.test/a')`) as Promise<unknown>;
      expectRecordPerRequest(rt, 0);
      const second = rt.run(`fetch('https://api.test/b')`) as Promise<unknown>;
      rt.run(`fetch('https://api.test/c')`);
      expectRecordPerRequest(rt, 2);
      for (const xhr of rt.sends) xhr.respond(200, {}, "ok");
      await Promise.all([first, second]);
      await settle();

      // c is still queued: it has sent nothing.
      expectRecordPerRequest(rt, 2);
      expect(rt.records().map((r) => `${r.state} ${r.request.url}`)).toEqual([
        "finished https://api.test/a",
        "finished https://api.test/b",
      ]);
    });

    it("records both requests of a wrapper that retries after a 500", async () => {
      const rt = appWrapped(`fetch = async function(u, init) {
        var r = await rnFetch(u, init);
        return r.status >= 500 ? rnFetch(u, init) : r;
      };`);
      const pending = rt.run(`fetch('https://api.test/flaky')`) as Promise<{ status: number }>;
      expectRecordPerRequest(rt, 1);
      rt.last().respond(500, {}, "down");
      await untilSent(rt, 2);
      rt.last().respond(200, {}, "up");
      expect((await pending).status).toBe(200);
      await settle();

      expectRecordPerRequest(rt, 2);
      expect(rt.records().map((r) => `${r.response?.status} ${r.responseBody}`)).toEqual([
        "500 down",
        "200 up",
      ]);
    });

    it.each([
      { shape: "on its own stack", awaits: "" },
      { shape: "after an await", awaits: "await tick();" },
    ])(
      "records one request of a wrapper that re-dispatches it through the global fetch $shape",
      async ({ awaits }) => {
        // `fetch` below is the global at call time: after the install, the interceptor's wrapper.
        const rt = appWrapped(`fetch = async function(u, init) { ${awaits}
          if (u.charAt(0) === '/') return fetch('https://api.test' + u, init);
          return rnFetch(u, init);
        };`);
        const pending = rt.run(`fetch('/users')`) as Promise<unknown>;
        await untilSent(rt, 1);
        rt.last().respond(200, {}, "[]");
        await pending;
        await settle();

        expectRecordPerRequest(rt, 1);
        expect(rt.records()[0]!.request.url).toBe("https://api.test/users");
      }
    );

    it("records the fetch and the beacon XHR a wrapper sends on the same stack", async () => {
      const rt = appWrapped(`fetch = function(u, init) {
        var beacon = new XMLHttpRequest();
        beacon.open('POST', 'https://log.test/event');
        beacon.onloadend = function() {};
        beacon.send('{"event":"fetch"}');
        return rnFetch(u, init);
      };`);
      const pending = rt.run(`fetch('https://api.test/me')`) as Promise<unknown>;
      expectRecordPerRequest(rt, 2);
      for (const xhr of rt.sends) xhr.respond(204, {}, "");
      await pending;
      await settle();

      expectRecordPerRequest(rt, 2);
      expect(rt.records().map((r) => `${r.resourceType} ${r.state} ${r.request.url}`)).toEqual([
        "XHR finished https://log.test/event",
        "Fetch finished https://api.test/me",
      ]);
    });
  });

  describe("Expo's native fetch", () => {
    const EXPO_57: RuntimeOptions = { expo: { sdk: 57 } };
    const TEXT_BODY = '{"name":"Zoë 👋"}';
    const NOT_UTF8 = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    const NO_CALLS: ExpoCalls = {
      text: 0,
      arrayBuffer: 0,
      startStreaming: 0,
      cancelStreaming: 0,
      cancel: 0,
      body: 0,
      clone: 0,
      blob: 0,
    };

    /**
     * The app fetches with expo/fetch and reads the response with `read` (`r` is the response),
     * while the native side answers with `body`. Runs with the interceptor or without it, so a test
     * can compare what the app got and which methods ran.
     */
    async function appReads(
      read: string,
      body: string | Uint8Array,
      { install = true, options = EXPO_57 }: { install?: boolean; options?: RuntimeOptions } = {}
    ) {
      const rt = createRuntime(options);
      if (install) rt.install();
      const pending = rt.run(
        `expoFetch('https://api.test/me').then(function(r) { return ${read}; })`
      ) as Promise<unknown>;
      for (let i = 0; i < 20 && rt.native.length === 0; i++) await settle();
      rt.native[0]!.respond(200, { "Content-Type": "application/json" }, body);
      const value = await pending;
      await settle();
      return { rt, value, calls: rt.expoCalls() };
    }

    it("records the global expo/fetch at start and leaves the global fetch as it is", async () => {
      const rt = createRuntime(EXPO_GLOBAL);
      const fetch = rt.run("fetch");
      rt.install();
      expect(rt.run("fetch")).toBe(fetch);

      const pending = rt.run(
        `fetch('https://api.test/me', { headers: { 'X-Id': '7' } }).then(function(r) { return r.json(); })`
      ) as Promise<unknown>;
      await untilSent(rt, 1);
      expect(rt.records()[0]).toMatchObject({
        resourceType: "Fetch",
        state: "pending",
        request: { method: "GET", url: "https://api.test/me", headers: { "X-Id": "7" } },
      });
      rt.native[0]!.respond(200, { "Content-Type": "application/json" }, TEXT_BODY);
      expect(await pending).toEqual({ name: "Zoë 👋" });
      await settle();

      expectRecordPerRequest(rt, 1);
      expect(rt.records()[0]).toMatchObject({
        state: "finished",
        response: {
          url: "https://api.test/me",
          status: 200,
          headers: { "content-type": "application/json" },
          mimeType: "application/json",
        },
        responseBody: TEXT_BODY,
        encodedDataLength: Buffer.byteLength(TEXT_BODY),
      });
      expect(rt.records()[0]!.durationMs).toEqual(expect.any(Number));
    });

    it.each([
      { read: "text()", code: "r.text()", value: TEXT_BODY },
      { read: "json()", code: "r.json()", value: { name: "Zoë 👋" } },
      {
        read: "arrayBuffer()",
        code: "r.arrayBuffer().then(function(b) { return b.byteLength; })",
        value: Buffer.byteLength(TEXT_BODY),
      },
      {
        read: "bytes()",
        code: "r.bytes().then(function(b) { return b.byteLength; })",
        value: Buffer.byteLength(TEXT_BODY),
      },
      {
        read: "blob()",
        code: "r.blob().then(function(b) { return b.size; })",
        value: Buffer.byteLength(TEXT_BODY),
      },
      {
        read: "a clone and itself",
        code: "Promise.all([r.clone().text(), r.text()])",
        value: [TEXT_BODY, TEXT_BODY],
      },
    ])(
      "records the body the app reads with $read, and calls nothing of its own",
      async ({ code, value }) => {
        const without = await appReads(code, TEXT_BODY, { install: false });
        const { rt, ...observed } = await appReads(code, TEXT_BODY);

        expect(without.value).toEqual(value);
        expect(observed).toEqual({ value, calls: without.calls });
        expectRecordPerRequest(rt, 1);
        expect(rt.records()[0]).toMatchObject({
          state: "finished",
          response: { status: 200 },
          responseBody: TEXT_BODY,
          encodedDataLength: Buffer.byteLength(TEXT_BODY),
        });
        expect(rt.records()[0]!.bodyTruncated).toBeUndefined();
      }
    );

    it.each([
      { read: "arrayBuffer()", code: "r.arrayBuffer().then(function(b) { return b.byteLength; })" },
      { read: "blob()", code: "r.blob().then(function(b) { return b.size; })" },
    ])(
      "records only the size of a body that is not UTF-8 when the app reads it with $read",
      async ({ code }) => {
        const { rt, value } = await appReads(code, NOT_UTF8);

        expect(value).toBe(NOT_UTF8.byteLength);
        expect(rt.records()[0]).toMatchObject({
          state: "finished",
          encodedDataLength: NOT_UTF8.byteLength,
        });
        expect(rt.records()[0]!.responseBody).toBeUndefined();
      }
    );

    it("records no body and no size when the app never reads the body, and ends the record with the request", async () => {
      const { rt, value, calls } = await appReads("r.status", TEXT_BODY);

      expect(value).toBe(200);
      expect(calls).toEqual(NO_CALLS);
      expectRecordPerRequest(rt, 1);
      expect(rt.records()[0]).toMatchObject({ state: "finished", response: { status: 200 } });
      expect(rt.records()[0]!.durationMs).toEqual(expect.any(Number));
      expect(rt.records()[0]!.responseBody).toBeUndefined();
      expect(rt.records()[0]!.encodedDataLength).toBeUndefined();
    });

    /**
     * The app gets a response with `status` and does not read its body, until the test runs `read`
     * (`response` is the response) once the request ended. Runs with the interceptor or without it.
     */
    async function readsLater(
      status: number,
      body: string,
      read: string,
      { install = true, options = EXPO_57 }: { install?: boolean; options?: RuntimeOptions } = {}
    ) {
      const rt = createRuntime(options);
      if (install) rt.install();
      rt.run(
        `var response; expoFetch('https://api.test/signup', { method: 'POST', body: '{}' }).then(function(r) { response = r; })`
      );
      for (let i = 0; i < 20 && rt.native.length === 0; i++) await settle();
      rt.native[0]!.respond(status, { "Content-Type": "application/json" }, body);
      await settle();
      const usedBefore = rt.run("response.bodyUsed");
      // The record before the app reads the body.
      const recorded = install ? rt.records()[0] : undefined;
      // Expo's response keeps no stream listeners once the request ended.
      const listeners = rt.run(
        `['didReceiveResponseData', 'didComplete', 'didFailWithError'].map(function(e) { return (response._listeners[e] || []).length; })`
      );
      const value = await (rt.run(read) as Promise<unknown>);
      await settle();
      return {
        rt,
        value,
        recorded,
        usedBefore,
        usedAfter: rt.run("response.bodyUsed"),
        listeners,
        calls: rt.expoCalls(),
      };
    }

    it.each([
      { status: 422, read: "json()", code: "response.json()", value: { error: "email taken" } },
      { status: 500, read: "text()", code: "response.text()", value: '{"error":"email taken"}' },
      {
        status: 404,
        read: "arrayBuffer()",
        code: "response.arrayBuffer().then(function(b) { return b.byteLength; })",
        value: 23,
      },
      {
        status: 503,
        read: "its body stream",
        code: "readStream(response)",
        value: '{"error":"email taken"}',
      },
      {
        status: 400,
        read: "a clone",
        code: "response.clone().text()",
        value: '{"error":"email taken"}',
      },
    ])(
      "records the body of a $status response the app does not read, and the app still reads it with $read",
      async ({ status, code, value }) => {
        const without = await readsLater(status, '{"error":"email taken"}', code, {
          install: false,
        });
        const { rt, ...observed } = await readsLater(status, '{"error":"email taken"}', code);

        expect(without.value).toEqual(value);
        expect(observed.value).toEqual(value);
        expect(observed.usedBefore).toBe(without.usedBefore);
        expect(observed.usedAfter).toBe(without.usedAfter);
        expect(observed.listeners).toEqual(without.listeners);
        expect(observed.calls.clone).toBe(without.calls.clone);
        expectRecordPerRequest(rt, 1);
        expect(observed.recorded).toMatchObject({
          state: "finished",
          response: { status },
          responseBody: '{"error":"email taken"}',
          encodedDataLength: 23,
        });
      }
    );

    it.each([
      {
        read: "text()",
        code: "response.text().then(function(t) { return Array.from(t).map(function(c) { return c.charCodeAt(0); }); })",
      },
      {
        read: "json()",
        code: "response.json().then(function(j) { return j; }, function(e) { return e.name; })",
      },
    ])(
      "hands the app an unread error body with its byte order mark, as native $read does",
      async ({ code }) => {
        const body = "\ufeff{}";
        const without = await readsLater(400, body, code, { install: false });
        const { rt, value } = await readsLater(400, body, code);

        expect(value).toEqual(without.value);
        expect(rt.records()[0]!.encodedDataLength).toBe(5);
      }
    );

    it("leaves the app a body stream it took before the end of an error response", async () => {
      const read = `response.body.getReader().read().then(function(c) { return new TextDecoder().decode(c.value); })`;
      const takeStream = async (install: boolean) => {
        const rt = createRuntime(EXPO_57);
        if (install) rt.install();
        rt.run(
          `var response, stream; expoFetch('https://api.test/down').then(function(r) { response = r; stream = r.body; })`
        );
        for (let i = 0; i < 20 && rt.native.length === 0; i++) await settle();
        rt.native[0]!.respond(503, {}, "down");
        await settle();
        return {
          rt,
          value: await (rt.run(read.replace("response.body", "stream")) as Promise<string>),
        };
      };
      const without = await takeStream(false);
      const { rt, value } = await takeStream(true);

      expect(without.value).toBe("down");
      expect(value).toBe("down");
      expect(rt.records()[0]).toMatchObject({ state: "finished", responseBody: "down" });
    });

    it("finishes an unread error response whose body did not complete, and holds it while the app reads it later", async () => {
      // An iOS file:// URL that is missing gets a 404, then the error state; a drop gets the error
      // state after a part of the body.
      const rt = createRuntime(EXPO_57);
      rt.install();
      rt.run(`var response; expoFetch('file:///missing.json').then(function(r) { response = r; })`);
      await untilSent(rt, 1);
      const request = rt.native[0]!;
      request.head(404, {});
      await settle();
      request.fail("The file does not exist.");
      await settle();
      await settle();
      expect(rt.records()[0]).toMatchObject({ state: "finished", response: { status: 404 } });
      expect(rt.records()[0]!.responseBody).toBeUndefined();

      // Native text() waits for a body that never completes, with or without the interceptor.
      rt.run(`var got = 'nothing'; response.text().then(function(t) { got = t; })`);
      await settle();
      expect(rt.run("got")).toBe("nothing");
      expect(rt.records()[0]!.state).toBe("pending");
    });

    it("records a size of 0 for an error response with Content-Length 0 the app does not read, and reads nothing", async () => {
      // On SDK 55 bodyUsed is native: a read of an empty body would turn it true.
      const bodyUsed = async (install: boolean) => {
        const rt = createRuntime({ polyfillFetch: true, expo: { sdk: 55 } });
        if (install) rt.install();
        rt.run(
          `var response; expoFetch('https://api.test/me').then(function(r) { response = r; })`
        );
        for (let i = 0; i < 20 && rt.native.length === 0; i++) await settle();
        rt.native[0]!.respond(401, { "Content-Length": "0" });
        await settle();
        return { rt, bodyUsed: rt.run("response.bodyUsed"), calls: rt.expoCalls() };
      };
      const without = await bodyUsed(false);
      const { rt, ...observed } = await bodyUsed(true);

      expect(observed).toEqual({ bodyUsed: without.bodyUsed, calls: NO_CALLS });
      expect(rt.records()[0]).toMatchObject({
        state: "finished",
        responseBody: "",
        encodedDataLength: 0,
      });
    });

    it("leaves an error body the app reads as soon as fetch resolves to native, when the request ended first", async () => {
      // SDK 55 on iOS resolves fetch only once the request ended.
      const options: RuntimeOptions = {
        polyfillFetch: true,
        expo: { sdk: 55, startsAtBodyEnd: true },
      };
      const reads = async (install: boolean) => {
        const rt = createRuntime(options);
        if (install) rt.install();
        const text = rt.run(
          `expoFetch('https://api.test/signup').then(function(r) { return r.text(); })`
        ) as Promise<string>;
        for (let i = 0; i < 20 && rt.native.length === 0; i++) await settle();
        rt.native[0]!.respond(422, {}, "taken");
        const value = await text;
        await settle();
        return { rt, value, calls: rt.expoCalls() };
      };
      const without = await reads(false);
      const { rt, ...observed } = await reads(true);

      expect(observed).toEqual({ value: "taken", calls: without.calls });
      expect(rt.records()[0]).toMatchObject({ state: "finished", responseBody: "taken" });
    });

    it("records the body of an error response an SDK 55 app does not read, and the app still reads it", async () => {
      const options: RuntimeOptions = { polyfillFetch: true, expo: { sdk: 55 } };
      const without = await readsLater(422, "taken", "response.text()", {
        install: false,
        options,
      });
      const { value, recorded } = await readsLater(422, "taken", "response.text()", { options });

      expect(without.value).toBe("taken");
      expect(value).toBe("taken");
      expect(recorded).toMatchObject({
        state: "finished",
        response: { status: 422 },
        responseBody: "taken",
        encodedDataLength: 5,
      });
    });

    it("attaches a body the app reads after the request ended to its finished record", async () => {
      const rt = createRuntime(EXPO_57);
      rt.install();
      rt.run(`var response; expoFetch('https://api.test/me').then(function(r) { response = r; })`);
      await untilSent(rt, 1);
      rt.native[0]!.respond(200, {}, "later");
      await settle();
      expect(rt.records()[0]!.state).toBe("finished");
      expect(rt.records()[0]!.responseBody).toBeUndefined();

      expect(await (rt.run("response.text()") as Promise<string>)).toBe("later");
      await settle();
      expect(rt.records()[0]).toMatchObject({
        state: "finished",
        responseBody: "later",
        encodedDataLength: 5,
      });
    });

    it.each([
      {
        arrives: "in chunks while the app streams it",
        body: Buffer.from(TEXT_BODY),
        opensAfterEnd: false,
        responseBody: TEXT_BODY as string | undefined,
      },
      {
        arrives: "in chunks while the app streams it, not UTF-8",
        body: Buffer.from(NOT_UTF8),
        opensAfterEnd: false,
        responseBody: undefined,
      },
      {
        arrives: "whole, as the app opens its stream after the request ended",
        body: Buffer.from(TEXT_BODY),
        opensAfterEnd: true,
        responseBody: TEXT_BODY,
      },
    ])(
      "records a body the app streams, $arrives, and calls nothing of its own",
      async ({ body, opensAfterEnd, responseBody }) => {
        const streams = async (install: boolean) => {
          const rt = createRuntime(EXPO_57);
          if (install) rt.install();
          // The app opens the body stream once the test calls open().
          const text =
            rt.run(`var open, opened = new Promise(function(resolve) { open = resolve; });
            expoFetch('https://api.test/me').then(function(r) { return opened.then(function() { return readStream(r); }); })`) as Promise<string>;
          for (let i = 0; i < 20 && rt.native.length === 0; i++) await settle();
          const request = rt.native[0]!;
          request.head(200, { "Content-Type": "application/json" });
          await settle();
          if (!opensAfterEnd) {
            rt.run("open()");
            await untilNativeState(request, "bodyStreamingStarted");
          }
          // The first chunk ends inside a character.
          request.chunk(body.subarray(0, 12));
          request.chunk(body.subarray(12));
          request.done();
          await settle();
          if (opensAfterEnd) rt.run("open()");
          const value = await text;
          await settle();
          return { rt, value, calls: rt.expoCalls() };
        };
        const without = await streams(false);
        const { rt, ...observed } = await streams(true);

        expect(without.value).toBe(new TextDecoder().decode(body));
        expect(observed).toEqual({ value: without.value, calls: without.calls });
        expectRecordPerRequest(rt, 1);
        expect(rt.records()[0]).toMatchObject({
          state: "finished",
          response: { status: 200 },
          encodedDataLength: body.length,
        });
        expect(rt.records()[0]!.responseBody).toBe(responseBody);
      }
    );

    it("records a body the app streams cut at 1 MiB between characters, with the size of all of it", async () => {
      const rt = createRuntime(EXPO_57);
      rt.install();
      const text = rt.run(
        `expoFetch('https://api.test/big').then(function(r) { return readStream(r); })`
      ) as Promise<string>;
      await untilSent(rt, 1);
      const request = rt.native[0]!;
      request.head(200, { "Content-Type": "text/plain; charset=utf-8" });
      await untilNativeState(request, "bodyStreamingStarted");
      // Characters of 3 bytes after 2: the cut at 1 MiB splits one, and so do chunk edges.
      const body = Buffer.from("ab" + "你".repeat(BODY_CAP / 2));
      for (let at = 0; at < body.length; at += 65536) request.chunk(body.subarray(at, at + 65536));
      request.done();

      expect(await text).toBe(body.toString());
      await settle();
      expect(rt.records()[0]).toMatchObject({
        state: "finished",
        responseBody: "ab" + "你".repeat((BODY_CAP - 4) / 3),
        bodyTruncated: true,
        encodedDataLength: body.length,
      });
    });

    it("keeps at most 1 MiB of a 5 MiB stream for the record", async () => {
      const rt = createRuntime(EXPO_57);
      // The interceptor decodes the bytes it kept once the request ends: note what it hands over.
      const decoded: number[] = [];
      rt.context.TextDecoder = class extends TextDecoder {
        decode(...args: Parameters<TextDecoder["decode"]>): string {
          const [input] = args;
          if (input && ArrayBuffer.isView(input)) decoded.push(input.buffer.byteLength);
          return super.decode(...args);
        }
      };
      rt.install();
      const size = rt.run(
        `expoFetch('https://api.test/feed').then(function(r) { return countStream(r); })`
      ) as Promise<number>;
      await untilSent(rt, 1);
      const request = rt.native[0]!;
      request.head(200, { "Content-Type": "text/event-stream" });
      await untilNativeState(request, "bodyStreamingStarted");
      const chunk = Buffer.alloc(65536, "a");
      for (let i = 0; i < 80; i++) {
        request.chunk(chunk);
        await settle();
      }
      request.done();

      expect(await size).toBe(5 * BODY_CAP);
      await settle();
      expect(decoded).toEqual([BODY_CAP + 3]);
      expect(rt.records()[0]).toMatchObject({
        state: "finished",
        responseBody: "a".repeat(BODY_CAP),
        bodyTruncated: true,
        encodedDataLength: 5 * BODY_CAP,
      });
    });

    it.each(["text", "json", "arrayBuffer"])(
      "hands the app the value and the error that %s() gives",
      async (method) => {
        const rt = createRuntime(EXPO_57);
        // What FetchResponse's own method settles with, on each call.
        rt.run(`var own = [];
          var proto = __expoNative.FetchResponse.prototype, original = proto.${method};
          proto.${method} = function() { var p = original.apply(this, arguments); own.push(outcome(p)); return p; };`);
        rt.install();
        // The second read fails: a body is read once.
        const pending = rt.run(
          `expoFetch('https://api.test/me').then(function(r) { return Promise.all([outcome(r.${method}()), outcome(r.${method}())]); })`
        ) as Promise<Array<{ value?: unknown; error?: { name: string } }>>;
        await untilSent(rt, 1);
        rt.native[0]!.respond(200, {}, '{"id":7}');
        const [first, second] = await pending;
        const [ownFirst, ownSecond] = await (rt.run("Promise.all(own)") as Promise<
          Array<{ value?: unknown; error?: { name: string } }>
        >);
        await settle();

        expect(first!.value).toBeDefined();
        expect(first!.value).toBe(ownFirst!.value);
        expect(second!.error!.name).toBe("TypeError");
        expect(second!.error).toBe(ownSecond!.error);
        expect(rt.records()[0]).toMatchObject({ state: "finished", responseBody: '{"id":7}' });
      }
    );

    it("lets the app's cancel of its body stream reach Expo's native side", async () => {
      const cancelAfterFirstChunk = async (install: boolean) => {
        const rt = createRuntime(EXPO_57);
        if (install) rt.install();
        // Native sends what it buffered as the first chunk, empty here.
        const got = rt.run(`expoFetch('https://api.test/sse').then(function(r) {
          var reader = r.body.getReader();
          function firstData() {
            return reader.read().then(function(chunk) { return chunk.value.byteLength ? chunk : firstData(); });
          }
          return firstData().then(function(chunk) {
            return reader.cancel('enough').then(function() { return new TextDecoder().decode(chunk.value); });
          });
        })`) as Promise<string>;
        for (let i = 0; i < 20 && rt.native.length === 0; i++) await settle();
        const request = rt.native[0]!;
        request.head(200, { "Content-Type": "text/event-stream" });
        await untilNativeState(request, "bodyStreamingStarted");
        request.chunk("hello ");
        expect(await got).toBe("hello ");
        await untilNativeState(request, "bodyStreamingCanceled");
        // Native drops what arrives after the cancel.
        request.chunk("world");
        request.done();
        await settle();
        return { rt, calls: rt.expoCalls(), log: rt.expoLog() };
      };
      const without = await cancelAfterFirstChunk(false);
      const { rt, ...observed } = await cancelAfterFirstChunk(true);

      expect(without.calls.cancelStreaming).toBe(1);
      expect(observed).toEqual({ calls: without.calls, log: without.log });
      expect(rt.records()[0]).toMatchObject({
        state: "finished",
        responseBody: "hello ",
        encodedDataLength: 6,
      });
    });

    it("records a failure while the app streams the body as failed, with its response", async () => {
      const rt = createRuntime(EXPO_57);
      rt.install();
      const text = rt.run(
        `expoFetch('https://api.test/sse').then(function(r) { return readStream(r); })`
      ) as Promise<string>;
      await untilSent(rt, 1);
      const request = rt.native[0]!;
      request.head(200, { "Content-Type": "text/event-stream" });
      await untilNativeState(request, "bodyStreamingStarted");
      request.chunk("data: 1\n\n");
      request.fail("The network connection was lost.");

      expect(await rejectionName(text)).toBe("Error");
      await settle();
      expectRecordPerRequest(rt, 1);
      expect(rt.records()[0]).toMatchObject({
        state: "failed",
        errorText: "The network connection was lost.",
        response: { status: 200, mimeType: "text/event-stream" },
      });
      expect(rt.records()[0]!.durationMs).toEqual(expect.any(Number));
    });

    it("keeps a request pending when the connection drops while the app reads the body with text(), as iOS never settles that read", async () => {
      const rt = createRuntime(EXPO_57);
      rt.install();
      rt.run(
        `var got = 'nothing'; expoFetch('https://api.test/big').then(function(r) {
          return r.text().then(function(text) { got = text; }, function(error) { got = error; });
        })`
      );
      await untilSent(rt, 1);
      const request = rt.native[0]!;
      request.head(200, { "Content-Type": "application/json" });
      await settle();
      request.chunk('{"partial":');
      // Not streaming: no didFailWithError, only the end of the request.
      request.fail("The network connection was lost.");
      await settle();
      await settle();

      expect(rt.expoLog()).toEqual(["start resolved", "readyForJSFinalization"]);
      expect(rt.run("got")).toBe("nothing");
      expectRecordPerRequest(rt, 1);
      expect(rt.records()[0]).toMatchObject({ state: "pending", response: { status: 200 } });
      expect(rt.records()[0]!.errorText).toBeUndefined();
      expect(rt.records()[0]!.durationMs).toBeUndefined();
    });

    it.each([
      { read: "text()", code: "response.text()" },
      { read: "its body stream", code: "readStream(response)" },
    ])(
      "puts a record back to pending when the app starts to read the body with $read after the connection dropped",
      async ({ code }) => {
        const rt = createRuntime(EXPO_57);
        rt.install();
        rt.run(
          `var response; expoFetch('https://api.test/big').then(function(r) { response = r; })`
        );
        await untilSent(rt, 1);
        const request = rt.native[0]!;
        request.head(200, { "Content-Type": "application/json" });
        await settle();
        request.chunk('{"partial":');
        request.fail("The network connection was lost.");
        await settle();
        expect(rt.records()[0]).toMatchObject({ state: "finished", response: { status: 200 } });

        // The app reads the body only now, after other work: the read never settles.
        rt.run(
          `var got = 'nothing'; ${code}.then(function(v) { got = v; }, function(e) { got = e; })`
        );
        await settle();
        await settle();
        expect(rt.run("got")).toBe("nothing");
        expect(rt.records()[0]).toMatchObject({ state: "pending", response: { status: 200 } });
      }
    );

    it("finishes a streamed body whose startStreaming() result reaches JS after the end of the request, as SDK 55 can on Android", async () => {
      const rt = createRuntime({ polyfillFetch: true, expo: { sdk: 55 } });
      // Native answers the call on one thread while another ends the body: the answer comes last.
      rt.run(`var proto = expo.modules.ExpoFetchModule.NativeResponse.prototype, start = proto.startStreaming;
        proto.startStreaming = function() {
          return start.apply(this, arguments).then(function(data) {
            return new Promise(function(resolve) { setTimeout(function() { resolve(data); }, 20); });
          });
        };`);
      rt.install();
      const text = rt.run(
        `expoFetch('https://api.test/items').then(function(r) { return readStream(r); })`
      ) as Promise<string>;
      await untilSent(rt, 1);
      const request = rt.native[0]!;
      request.head(200, {});
      await untilNativeState(request, "bodyStreamingStarted");
      request.chunk('{"items":[1,2,3]}');
      request.done();

      expect(await text).toBe('{"items":[1,2,3]}');
      await new Promise((r) => setTimeout(r, 40));
      await settle();
      expect(rt.expoLog()).toEqual(["start resolved", "didComplete", "readyForJSFinalization"]);
      expect(rt.records()[0]).toMatchObject({
        state: "finished",
        responseBody: '{"items":[1,2,3]}',
      });
    });

    it("finishes a record once a text() read that was in flight at the end of the request settles", async () => {
      const rt = createRuntime(EXPO_57);
      rt.install();
      const text = rt.run(
        `expoFetch('https://api.test/me').then(function(r) { return r.text(); })`
      ) as Promise<string>;
      await untilSent(rt, 1);
      const request = rt.native[0]!;
      request.head(200, {});
      await settle();
      request.chunk("late");
      request.done();

      expect(await text).toBe("late");
      await settle();
      // JS got the end of the request first, then the result of the read.
      expect(rt.expoLog()).toEqual(["start resolved", "readyForJSFinalization"]);
      expect(rt.records()[0]).toMatchObject({
        state: "finished",
        responseBody: "late",
        encodedDataLength: 4,
      });
    });

    it.each([
      {
        order: "the end of the request before start rejects, as a device does",
        settleFirst: false,
        log: ["readyForJSFinalization", "start rejected"],
      },
      {
        order: "start's rejection first",
        settleFirst: true,
        log: ["start rejected", "readyForJSFinalization"],
      },
    ])(
      "records a request that fails before its response as failed, when JS gets $order",
      async ({ settleFirst, log }) => {
        const rt = createRuntime(EXPO_57);
        rt.install();
        const pending = rt.run(`expoFetch('https://nowhere.test/')`) as Promise<unknown>;
        await untilSent(rt, 1);
        rt.native[0]!.fail("A server with the specified hostname could not be found.", settleFirst);

        await expect(pending).rejects.toThrow(
          "fetch failed: A server with the specified hostname could not be found."
        );
        await settle();
        expect(rt.expoLog()).toEqual(log);
        expectRecordPerRequest(rt, 1);
        expect(rt.records()[0]).toMatchObject({
          state: "failed",
          errorText: "A server with the specified hostname could not be found.",
        });
        expect(rt.records()[0]!.durationMs).toEqual(expect.any(Number));
        expect(rt.records()[0]!.response).toBeUndefined();
      }
    );

    it.each([
      { order: "start resolves before the request ends", endsFirst: false },
      { order: "the request ends before start resolves", endsFirst: true },
    ])(
      "finishes a record with the time of the end of the request when $order",
      async ({ endsFirst }) => {
        const rt = createRuntime(EXPO_57);
        rt.run("var clock = 1000; Date.now = function() { return clock; };");
        rt.install();
        const status = rt.run(
          `expoFetch('https://api.test/me').then(function(r) { return r.status; })`
        ) as Promise<number>;
        await untilSent(rt, 1);
        const request = rt.native[0]!;
        // JS gets the end of the request at 1250, and start resolves at 1000 or 1900.
        if (endsFirst) {
          rt.run("clock = 1250");
          // Runs after the interceptor's listener, which the request added when it started.
          request.response.addListener("readyForJSFinalization", () => rt.run("clock = 1900"));
          request.head(200, {});
          request.done();
        } else {
          request.head(200, {});
          expect(await status).toBe(200);
          rt.run("clock = 1250");
          request.done();
        }

        expect(await status).toBe(200);
        await settle();
        expect(rt.expoLog()).toEqual(
          endsFirst
            ? ["readyForJSFinalization", "start resolved"]
            : ["start resolved", "readyForJSFinalization"]
        );
        expect(rt.records()[0]).toMatchObject({
          state: "finished",
          response: { status: 200 },
          durationMs: 250,
        });
      }
    );

    it("records a request the app aborts before its response as aborted, without a response", async () => {
      const rt = createRuntime(EXPO_57);
      rt.install();
      const pending = rt.run(
        `var controller = new AbortController(); expoFetch('https://api.test/slow', { signal: controller.signal })`
      ) as Promise<unknown>;
      await untilSent(rt, 1);
      rt.run("controller.abort()");

      await expect(pending).rejects.toThrow("fetch failed: Fetch request has been canceled");
      await settle();
      expectRecordPerRequest(rt, 1);
      expect(rt.native[0]!.cancelled).toBe(true);
      expect(rt.records()[0]).toMatchObject({ state: "failed", errorText: "aborted" });
      expect(rt.records()[0]!.response).toBeUndefined();
    });

    it("records a request the app aborts while it streams the body as aborted, with its response", async () => {
      const rt = createRuntime(EXPO_57);
      rt.install();
      const text = rt.run(
        `var controller = new AbortController();
        expoFetch('https://api.test/sse', { signal: controller.signal }).then(function(r) { return readStream(r); })`
      ) as Promise<string>;
      await untilSent(rt, 1);
      const request = rt.native[0]!;
      request.head(200, { "Content-Type": "text/event-stream" });
      await untilNativeState(request, "bodyStreamingStarted");
      request.chunk("data: 1\n\n");
      await settle();
      expect(rt.records()[0]).toMatchObject({ state: "pending", response: { status: 200 } });
      rt.run("controller.abort()");

      expect(await rejectionName(text)).toBe("AbortError");
      await settle();
      expectRecordPerRequest(rt, 1);
      expect(request.cancelled).toBe(true);
      expect(rt.records()[0]).toMatchObject({
        state: "failed",
        errorText: "aborted",
        response: { status: 200, mimeType: "text/event-stream" },
      });
      expect(rt.records()[0]!.responseBody).toBeUndefined();
    });

    it.each<{ sdk: string; options: RuntimeOptions }>([
      { sdk: "SDK 57", options: EXPO_57 },
      { sdk: "SDK 55 on iOS", options: { expo: { sdk: 55, startsAtBodyEnd: true } } },
    ])(
      "keeps a finished request finished when the app aborts it afterwards ($sdk)",
      async ({ options }) => {
        const rt = createRuntime(options);
        rt.install();
        const text = rt.run(
          `var controller = new AbortController();
        expoFetch('https://api.test/me', { signal: controller.signal }).then(function(r) { return r.text(); })`
        ) as Promise<string>;
        await untilSent(rt, 1);
        rt.native[0]!.respond(200, {}, "ok");
        expect(await text).toBe("ok");
        await settle();
        expect(rt.records()[0]!.state).toBe("finished");

        // Expo dropped its abort listener when the request ended: nothing is cancelled.
        rt.run("controller.abort()");
        await settle();
        expect(rt.native[0]!.cancelled).toBeUndefined();
        // Nor does a cancel that reaches the native request anyway change the record.
        await rt.native[0]!.cancel();
        await settle();

        expect(rt.records()[0]).toMatchObject({ state: "finished", responseBody: "ok" });
        expect(rt.records()[0]!.errorText).toBeUndefined();
      }
    );

    it.each<{ sdk: string; options: RuntimeOptions }>([
      { sdk: "SDK 57", options: EXPO_57 },
      { sdk: "SDK 55", options: { polyfillFetch: true, expo: { sdk: 55 } } },
    ])(
      "keeps a request finished when the app aborts it once it streamed the body to the end ($sdk)",
      async ({ options }) => {
        const rt = createRuntime(options);
        rt.install();
        // urql and graphql-sse abort as cleanup, before JS gets the end of the request.
        const text = rt.run(
          `var controller = new AbortController();
          expoFetch('https://api.test/stream', { signal: controller.signal }).then(function(r) {
            return readStream(r).then(function(text) { controller.abort(); return text; });
          })`
        ) as Promise<string>;
        await untilSent(rt, 1);
        const request = rt.native[0]!;
        request.head(200, { "Content-Type": "text/plain" });
        await untilNativeState(request, "bodyStreamingStarted");
        request.chunk("start ");
        request.chunk("end");
        request.done();

        expect(await text).toBe("start end");
        await settle();
        expect(request.cancelled).toBe(true);
        expectRecordPerRequest(rt, 1);
        expect(rt.records()[0]).toMatchObject({
          state: "finished",
          response: { status: 200 },
          responseBody: "start end",
          encodedDataLength: 9,
        });
        expect(rt.records()[0]!.errorText).toBeUndefined();
      }
    );

    it.each([
      { read: "arrayBuffer()", code: "r.arrayBuffer().then(function(b) { return b.byteLength; })" },
      { read: "blob()", code: "r.blob().then(function(b) { return b.size; })" },
    ])(
      "keeps a request finished when the app aborts it once $read resolved, before JS got the end of the request",
      async ({ code }) => {
        const rt = createRuntime(EXPO_57);
        rt.install();
        const size = rt.run(
          `var controller = new AbortController();
          expoFetch('https://api.test/file', { signal: controller.signal }).then(function(r) {
            return ${code}.then(function(value) { controller.abort(); return value; });
          })`
        ) as Promise<number>;
        await untilSent(rt, 1);
        const request = rt.native[0]!;
        request.head(200, { "Content-Type": "application/octet-stream" });
        await settle();
        request.chunk("12345");
        request.response._set("bodyCompleted");

        expect(await size).toBe(5);
        await settle();
        expect(request.cancelled).toBe(true);
        expect(rt.records()[0]).toMatchObject({ state: "finished", encodedDataLength: 5 });
        expect(rt.records()[0]!.errorText).toBeUndefined();
      }
    );

    it("keeps a request finished when the app aborts it once json() resolved, before JS got the end of the request", async () => {
      const rt = createRuntime(EXPO_57);
      rt.install();
      const json = rt.run(
        `var controller = new AbortController();
        expoFetch('https://api.test/me', { signal: controller.signal }).then(function(r) {
          return r.json().then(function(value) { controller.abort(); return value; });
        })`
      ) as Promise<unknown>;
      await untilSent(rt, 1);
      const request = rt.native[0]!;
      request.head(200, { "Content-Type": "application/json" });
      await settle();
      // On iOS the result of a body read can reach JS before the end of the request: the body
      // completes here, and the end of the request does not follow.
      request.chunk('{"id":7}');
      request.response._set("bodyCompleted");

      expect(await json).toEqual({ id: 7 });
      await settle();
      expect(request.cancelled).toBe(true);
      expectRecordPerRequest(rt, 1);
      expect(rt.records()[0]).toMatchObject({
        state: "finished",
        response: { status: 200 },
        responseBody: '{"id":7}',
        encodedDataLength: 8,
      });
      expect(rt.records()[0]!.errorText).toBeUndefined();
    });

    it.each([
      { read: "text()", code: "r.text()", value: TEXT_BODY },
      { read: "json()", code: "r.json()", value: { name: "Zoë 👋" } },
      {
        read: "arrayBuffer()",
        code: "r.arrayBuffer().then(function(b) { return b.byteLength; })",
        value: Buffer.byteLength(TEXT_BODY),
      },
    ])(
      "records the body an SDK 55 app reads with $read, where a response cannot clone",
      async ({ code, value }) => {
        // SDK 55: expo/fetch is opt-in, and the global fetch stays React Native's.
        const options: RuntimeOptions = { polyfillFetch: true, expo: { sdk: 55 } };
        const without = await appReads(code, TEXT_BODY, { install: false, options });
        const { rt, ...observed } = await appReads(code, TEXT_BODY, { options });

        expect(without.value).toEqual(value);
        expect(observed).toEqual({ value, calls: without.calls });
        expectRecordPerRequest(rt, 1);
        expect(rt.records()[0]).toMatchObject({
          state: "finished",
          responseBody: TEXT_BODY,
          encodedDataLength: Buffer.byteLength(TEXT_BODY),
        });
      }
    );

    it("records the whole body an SDK 55 app on iOS streams, where fetch resolves after the request ended", async () => {
      const rt = createRuntime({ polyfillFetch: true, expo: { sdk: 55, startsAtBodyEnd: true } });
      rt.install();
      const text = rt.run(
        `expoFetch('https://api.test/me').then(function(r) { return readStream(r); })`
      ) as Promise<string>;
      await untilSent(rt, 1);
      const request = rt.native[0]!;
      const body = Buffer.from(TEXT_BODY);
      request.head(200, { "Content-Type": "application/json" });
      request.chunk(body.subarray(0, 12));
      request.chunk(body.subarray(12));
      request.done();

      // The app opens its stream once fetch resolves: startStreaming hands it the whole body.
      expect(await text).toBe(TEXT_BODY);
      await settle();
      expect(rt.expoLog()).toEqual(["readyForJSFinalization", "start resolved"]);
      expect(rt.expoCalls()).toMatchObject({ startStreaming: 1, text: 0, arrayBuffer: 0 });
      expectRecordPerRequest(rt, 1);
      expect(rt.records()[0]).toMatchObject({
        state: "finished",
        response: { status: 200, mimeType: "application/json" },
        responseBody: TEXT_BODY,
        encodedDataLength: body.length,
      });
    });

    it.each([
      {
        reference: "expo/fetch imported while the global fetch is React Native's",
        options: { polyfillFetch: true, expo: { sdk: 57 } } as RuntimeOptions,
        capture: "expoFetch",
      },
      {
        reference: "the global expo/fetch captured before the install",
        options: EXPO_GLOBAL,
        capture: "fetch",
      },
    ])("records a call of $reference", async ({ options, capture }) => {
      const rt = createRuntime(options);
      rt.run(`var captured = ${capture};`);
      rt.install();
      const pending = rt.run(
        `captured('https://api.test/me').then(function(r) { return r.text(); })`
      ) as Promise<unknown>;
      await untilSent(rt, 1);
      rt.native[0]!.respond(200, {}, "ok");
      await pending;
      await settle();

      expectRecordPerRequest(rt, 1);
      expect(rt.records()[0]).toMatchObject({
        resourceType: "Fetch",
        state: "finished",
        responseBody: "ok",
      });
    });

    it("records one request for three callers of a wrapper that shares one promise", async () => {
      const rt = appWrapped(
        `var inner = fetch; var inflight = null;
        fetch = function(u, init) {
          if (!inflight) inflight = inner(u, init).finally(function() { inflight = null; });
          return inflight;
        };`,
        EXPO_GLOBAL
      );
      const pending = rt.run(
        `Promise.all([fetch('https://api.test/feed'), fetch('https://api.test/feed'), fetch('https://api.test/feed')])`
      ) as Promise<unknown[]>;
      await untilSent(rt, 1);
      rt.native[0]!.respond(200, {}, "feed");
      expect(new Set(await pending).size).toBe(1);
      await settle();

      expectRecordPerRequest(rt, 1);
      expect(rt.records()[0]).toMatchObject({ state: "finished", response: { status: 200 } });
    });

    it("records both requests of a wrapper that retries a failure through the fetch it captured", async () => {
      const rt = appWrapped(
        `var inner = fetch;
        fetch = function(u, init) { return inner(u, init).catch(function() { return inner(u, init); }); };`,
        EXPO_GLOBAL
      );
      const pending = rt.run(
        `fetch('https://api.test/flaky').then(function(r) { return r.text(); })`
      ) as Promise<unknown>;
      await untilSent(rt, 1);
      rt.native[0]!.fail("offline");
      await untilSent(rt, 2);
      rt.native[1]!.respond(200, {}, "ok");
      await pending;
      await settle();

      expectRecordPerRequest(rt, 2);
      expect(rt.records().map((r) => `${r.state} ${r.errorText ?? r.responseBody}`)).toEqual([
        "failed offline",
        "finished ok",
      ]);
    });

    it("records both requests a wrapper aborts with one shared reason", async () => {
      const rt = appWrapped(
        `var inner = fetch; var session = new AbortController();
        fetch = function(u, init) {
          return inner(u, Object.assign({}, init, { signal: session.signal })).catch(function(e) {
            throw session.signal.aborted ? session.signal.reason : e;
          });
        };`,
        EXPO_GLOBAL
      );
      const pending = rt.run(
        `Promise.allSettled([fetch('https://api.test/a'), fetch('https://api.test/b')])`
      ) as Promise<Array<{ reason: unknown }>>;
      await untilSent(rt, 2);
      rt.run(`session.abort(new Error('signed out'))`);
      const [a, b] = await pending;
      expect(a!.reason).toBe(b!.reason);
      await settle();

      expectRecordPerRequest(rt, 2);
      expect(rt.native.map((request) => request.cancelled)).toEqual([true, true]);
      expect(rt.records().map((r) => `${r.state} ${r.errorText}`)).toEqual([
        "failed aborted",
        "failed aborted",
      ]);
    });

    it.each([
      {
        resolves: "parsed JSON",
        code: `fetch = async function(u, init) { return (await inner(u, init)).json(); };`,
      },
      {
        resolves: "its own Response class",
        code: `${API_RESPONSE} fetch = async function(u, init) { return new ApiResponse(await inner(u, init)); };`,
      },
    ])("records one request through a wrapper that resolves $resolves", async ({ code }) => {
      const rt = appWrapped(`var inner = fetch; ${code}`, EXPO_GLOBAL);
      const pending = rt.run(
        `fetch('https://api.test/me').then(function(r) { return typeof r.text === 'function' ? r.text() : r; })`
      ) as Promise<unknown>;
      await untilSent(rt, 1);
      rt.native[0]!.respond(200, { "Content-Type": "application/json" }, '{"id":7}');
      await pending;
      await settle();

      expectRecordPerRequest(rt, 1);
      expect(rt.records()[0]).toMatchObject({ state: "finished", responseBody: '{"id":7}' });
    });

    it("records each request of a wrapper that sends some over React Native's fetch and some over Expo's", async () => {
      const rt = appWrapped(
        `fetch = function(u, init) { return u.indexOf('/stream/') !== -1 ? expoFetch(u, init) : rnFetch(u, init); };`,
        EXPO_GLOBAL
      );
      const pending = rt.run(
        `Promise.all(['/stream/1', '/users', '/stream/2', '/me'].map(function(path) {
          return fetch('https://api.test' + path).then(function(r) { return r.text(); });
        }))`
      ) as Promise<unknown>;
      await untilSent(rt, 4);
      expect(rt.sends).toHaveLength(2);
      for (const xhr of rt.sends) xhr.respond(200, {}, "xhr");
      for (const request of rt.native) request.respond(200, {}, "native");
      await pending;
      await settle();

      expectRecordPerRequest(rt, 4);
      expect(
        rt
          .records()
          .map((r) => `${r.resourceType} ${r.state} ${r.request.url} ${r.responseBody}`)
          .sort()
      ).toEqual([
        "Fetch finished https://api.test/me xhr",
        "Fetch finished https://api.test/stream/1 native",
        "Fetch finished https://api.test/stream/2 native",
        "Fetch finished https://api.test/users xhr",
      ]);
    });

    it.each([
      {
        shows: "UTF-8 bytes as their text",
        body: `'{"name":"Zoë 👋"}'`,
        postData: '{"name":"Zoë 👋"}',
        truncated: undefined,
      },
      {
        shows: "bytes that are not UTF-8 as their size",
        body: "new Uint8Array([0xff, 0xfe, 0x00, 0x01])",
        postData: "[binary 4 bytes]",
        truncated: undefined,
      },
      {
        // Characters of 3 bytes after 2: the cut at 1 MiB splits one, 2 bytes earlier it does not.
        shows: "the first 1 MiB of a longer body, cut between characters",
        body: `'ab' + '你'.repeat(${BODY_CAP / 2})`,
        postData: "ab" + "你".repeat((BODY_CAP - 4) / 3),
        truncated: true,
      },
    ])("shows $shows in an Expo request body", async ({ body, postData, truncated }) => {
      const rt = createRuntime(EXPO_57);
      rt.install();
      rt.run(
        `var sent = ${body}; expoFetch('https://api.test/upload', { method: 'POST', body: sent })`
      );
      await untilSent(rt, 1);
      expect(rt.records()[0]!.request.postData).toBe(postData);
      expect(rt.records()[0]!.request.postDataTruncated).toBe(truncated);
      // The request goes out as the app sent it.
      expect(Buffer.from(rt.native[0]!.body!)).toEqual(
        Buffer.from(
          rt.run(`typeof sent === 'string' ? new TextEncoder().encode(sent) : sent`) as Uint8Array
        )
      );
    });

    it("passes a native request constructed before the install through, unrecorded", async () => {
      const rt = createRuntime(EXPO_57);
      rt.run(`var ExpoFetchModule = expo.modules.ExpoFetchModule;
        var early = new ExpoFetchModule.NativeRequest(new ExpoFetchModule.NativeResponse());`);
      rt.install();
      const started = rt.run(
        `early.start('https://api.test/early', { method: 'GET', headers: [] }, null)`
      ) as Promise<unknown>;
      rt.native[0]!.respond(200, {}, "ok");
      await started;
      rt.run("early.cancel()");
      await settle();

      // The interceptor never saw the Response it fills.
      expect(rt.records()).toHaveLength(0);
      expect(rt.expoCalls()).toEqual({ ...NO_CALLS, cancel: 1 });
    });

    it("keeps the app working when Expo's module cannot be patched", async () => {
      const rt = createRuntime(EXPO_GLOBAL);
      rt.run("Object.freeze(expo.modules.ExpoFetchModule)");
      expect(rt.install()).toEqual({ installed: true });
      const pending = rt.run(
        `fetch('https://api.test/me').then(function(r) { return r.text(); })`
      ) as Promise<string>;
      await settle();
      rt.native[0]!.respond(200, { "Content-Type": "text/plain" }, "ok");

      expect(await pending).toBe("ok");
      expect(rt.expoCalls()).toEqual({ ...NO_CALLS, text: 1 });
      expect(rt.records()).toHaveLength(0);
    });
  });

  describe("another fetch library", () => {
    /**
     * react-native-fetch-api, as react-native-polyfill-globals installs it: a fetch over React
     * Native's native network module, and a global Response class of its own. `touched` notes every
     * touch of a body.
     */
    function libRuntime(options: RuntimeOptions = {}) {
      const rt = createRuntime(options);
      const touched: string[] = [];
      const read = (name: string) => () => {
        touched.push(name);
        return Promise.resolve("native");
      };
      class LibResponse {
        statusText = "OK";
        headers = new Map([["content-type", "text/plain; charset=utf-8"]]);
        constructor(
          readonly url: string,
          readonly status = 200
        ) {}
        get body(): object {
          touched.push("body");
          return { getReader: () => undefined };
        }
        // It shares its body stream with every clone when it streams text.
        clone(): LibResponse {
          touched.push("clone");
          return new LibResponse(this.url, this.status);
        }
        text = read("text");
        json = read("json");
        blob = read("blob");
        arrayBuffer = read("arrayBuffer");
      }
      // Kept for the tests that resolve React Native's own Response.
      rt.context.__WhatwgResponse = rt.context.Response;
      rt.context.Response = LibResponse;
      rt.context.LibResponse = LibResponse;
      return { rt, touched, LibResponse };
    }

    it("records a call once it resolves, with its status and headers but never its body", async () => {
      const { rt, touched, LibResponse } = libRuntime();
      let resolve: (response: unknown) => void = () => {};
      rt.context.fetch = () => new Promise((r) => (resolve = r));
      rt.install();
      const pending = rt.run(
        `fetch('https://api.test/native', { method: 'post', headers: { 'X-Id': '1' }, body: 'q' })`
      ) as Promise<unknown>;
      expect(rt.records()).toHaveLength(0);
      const response = new LibResponse("https://api.test/native");
      resolve(response);
      expect(await pending).toBe(response);
      await settle();

      expect(touched).toEqual([]);
      expect(rt.records()).toHaveLength(1);
      expect(rt.records()[0]).toMatchObject({
        resourceType: "Fetch",
        state: "finished",
        request: {
          method: "POST",
          url: "https://api.test/native",
          headers: { "X-Id": "1" },
          postData: "q",
        },
        response: {
          url: "https://api.test/native",
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/plain; charset=utf-8" },
          mimeType: "text/plain",
        },
      });
      expect(rt.records()[0]!.durationMs).toEqual(expect.any(Number));
      expect(rt.records()[0]!.responseBody).toBeUndefined();
      expect(rt.records()[0]!.encodedDataLength).toBeUndefined();
    });

    it("records each of several concurrent calls to different URLs once", async () => {
      const { rt, LibResponse } = libRuntime();
      rt.context.fetch = (url: string) => Promise.resolve(new LibResponse(url));
      rt.install();
      await (rt.run(
        `Promise.all(['a', 'b', 'c'].map(function(path) { return fetch('https://api.test/' + path); }))`
      ) as Promise<unknown>);
      await settle();

      expect(rt.records().map((r) => r.request.url)).toEqual([
        "https://api.test/a",
        "https://api.test/b",
        "https://api.test/c",
      ]);
    });

    it.each([
      { hands: "one Response", copy: "" },
      { hands: "a copy of one Response", copy: ".then(function(r) { return r.clone(); })" },
    ])(
      "records one request when the app's wrapper hands $hands to three callers",
      async ({ copy }) => {
        const { rt, LibResponse } = libRuntime();
        let resolve: () => void = () => {};
        let requests = 0;
        rt.context.libFetch = (url: string) => {
          requests++;
          return new Promise((r) => (resolve = () => r(new LibResponse(url))));
        };
        rt.run(`var inflight = {};
        fetch = function(u) {
          if (!inflight[u]) inflight[u] = libFetch(u).finally(function() { delete inflight[u]; });
          return inflight[u]${copy};
        };`);
        rt.install();
        const all = rt.run(
          `Promise.all([fetch('https://api.test/me'), fetch('https://api.test/me'), fetch('https://api.test/me')])`
        ) as Promise<unknown>;
        resolve();
        await all;
        await settle();

        expect(requests).toBe(1);
        expect(rt.records()).toHaveLength(1);
      }
    );

    it("records one request when the app's cache hands its stored Response to a later call", async () => {
      const { rt, LibResponse } = libRuntime();
      let requests = 0;
      rt.context.libFetch = (url: string) => {
        requests++;
        return Promise.resolve(new LibResponse(url));
      };
      rt.run(`var cache = {};
        fetch = function(u) {
          if (cache[u]) return Promise.resolve(cache[u]);
          return libFetch(u).then(function(r) { cache[u] = r; return r; });
        };`);
      rt.install();
      await (rt.run(`fetch('https://api.test/config')`) as Promise<unknown>);
      await settle();
      // Later, so the two calls do not overlap.
      await new Promise((r) => setTimeout(r, 5));
      const cached = await (rt.run(`fetch('https://api.test/config')`) as Promise<unknown>);
      await settle();

      expect(cached).toBe(rt.run("cache['https://api.test/config']"));
      expect(requests).toBe(1);
      expect(rt.records()).toHaveLength(1);
    });

    it("records both a GET and a POST sent to one URL at the same time", async () => {
      const { rt, LibResponse } = libRuntime();
      rt.context.fetch = (url: string) => Promise.resolve(new LibResponse(url));
      rt.install();
      await (rt.run(
        `Promise.all([fetch('https://api.test/items'), fetch('https://api.test/items', { method: 'POST', body: 'x' })])`
      ) as Promise<unknown>);
      await settle();

      expect(rt.records().map((r) => `${r.request.method} ${r.request.url}`)).toEqual([
        "GET https://api.test/items",
        "POST https://api.test/items",
      ]);
    });

    it("records the method, URL and headers of a Request the app passes", async () => {
      const { rt, LibResponse } = libRuntime();
      rt.context.Headers = Headers;
      rt.context.fetch = (request: { url: string }) =>
        Promise.resolve(new LibResponse(request.url));
      // react-native-fetch-api's Request: the method upper-cased, the headers a Headers object.
      rt.run(`function LibRequest(url, init) {
        this.url = url;
        this.method = String(init.method || 'GET').toUpperCase();
        this.headers = new Headers(init.headers);
      }`);
      rt.install();
      await (rt.run(
        `fetch(new LibRequest('https://api.test/items/7', { method: 'put', headers: { 'X-Id': '7' } }))`
      ) as Promise<unknown>);
      await settle();

      expect(rt.records()).toHaveLength(1);
      expect(rt.records()[0]!.request).toEqual({
        method: "PUT",
        url: "https://api.test/items/7",
        headers: { "x-id": "7" },
      });
    });

    it("records each of two calls to one URL that do not overlap", async () => {
      const { rt, LibResponse } = libRuntime();
      rt.context.fetch = (url: string) => Promise.resolve(new LibResponse(url));
      rt.install();
      await (rt.run(`fetch('https://api.test/poll')`) as Promise<unknown>);
      await settle();
      await new Promise((r) => setTimeout(r, 5));
      await (rt.run(`fetch('https://api.test/poll')`) as Promise<unknown>);
      await settle();

      expect(rt.records().map((r) => r.request.url)).toEqual([
        "https://api.test/poll",
        "https://api.test/poll",
      ]);
    });

    it.each<{ transport: string; options: RuntimeOptions; send: string }>([
      {
        transport: "an XHR",
        options: {},
        send: `var x = new XMLHttpRequest(); x.open('GET', 'https://api.test/other'); x.send();`,
      },
      {
        transport: "an Expo request",
        options: { expo: { sdk: 57 } },
        send: `expoFetch('https://api.test/other');`,
      },
    ])(
      "records no call during which $transport was sent, as the call may have run over it",
      async ({ options, send }) => {
        const { rt, LibResponse } = libRuntime(options);
        let resolve: () => void = () => {};
        rt.context.fetch = (url: string) =>
          new Promise((r) => (resolve = () => r(new LibResponse(url))));
        rt.install();
        const pending = rt.run(`fetch('https://api.test/native')`) as Promise<unknown>;
        rt.run(send);
        await untilSent(rt, 1);
        resolve();
        await pending;
        await settle();

        expect(rt.records().map((r) => r.request.url)).toEqual(["https://api.test/other"]);
      }
    );

    it("records no rejected call, and rejects the app's promise with the same error", async () => {
      const { rt } = libRuntime();
      const error = new Error("offline");
      const original = Promise.reject(error);
      original.catch(() => {});
      rt.context.fetch = () => original;
      rt.install();
      const returned = rt.run(`fetch('https://api.test/down')`) as Promise<unknown>;

      // A promise of its own: one the app never handles is still reported as unhandled.
      expect(returned).not.toBe(original);
      await expect(returned).rejects.toBe(error);
      await settle();
      expect(rt.records()).toHaveLength(0);
    });

    it.each<{ resolves: string; options: RuntimeOptions; value: string }>([
      { resolves: "a plain object", options: {}, value: "{ ok: true, status: 200 }" },
      {
        resolves: "an app's own class around a Response",
        options: {},
        value:
          "{ raw: new LibResponse('https://api.test/cached'), status: 200, clone: function() {} }",
      },
      {
        resolves: "React Native's Response",
        options: { polyfillFetch: true },
        value: "new __WhatwgResponse('cached')",
      },
      {
        resolves: "Expo's Response",
        options: { expo: { sdk: 57 } },
        value: "new __expoNative.FetchResponse()",
      },
    ])("records no call that resolves $resolves", async ({ options, value }) => {
      const { rt } = libRuntime(options);
      // A cache that answers without a request.
      rt.run(`fetch = function() { return Promise.resolve(${value}); };`);
      rt.install();
      await (rt.run(`fetch('https://api.test/cached')`) as Promise<unknown>);
      await settle();

      expect(rt.records()).toHaveLength(0);
    });

    // Both keep whatwg-fetch's global Response, so the interceptor leaves the global fetch alone.
    it.each<{ fetch: string; options: RuntimeOptions }>([
      { fetch: "React Native's fetch", options: { polyfillFetch: true } },
      { fetch: "Expo's fetch (SDK 56+)", options: EXPO_GLOBAL },
    ])("leaves the global fetch alone when it is an app wrapper over $fetch", ({ options }) => {
      const rt = createRuntime(options);
      rt.run(
        `fetch = (function(inner) { return function(u, init) { return inner(u, init); }; })(fetch);`
      );
      const wrapper = rt.run("fetch");
      rt.install();

      expect(rt.run("fetch")).toBe(wrapper);
    });
  });

  describe("limits", () => {
    it("caps a text body and a request body at 1 MiB", () => {
      const rt = createRuntime();
      rt.install();
      rt.run(
        `var x = new XMLHttpRequest(); x.open('POST', 'https://api.test/big'); x.send('p'.repeat(${BODY_CAP + 1}));`
      );
      rt.last().respond(200, {}, "a".repeat(BODY_CAP + 10));
      const [record] = rt.records();

      expect(record!.responseBody).toHaveLength(BODY_CAP);
      expect(record).toMatchObject({ bodyTruncated: true, encodedDataLength: BODY_CAP + 10 });
      expect(record!.request.postData).toHaveLength(BODY_CAP);
      expect(record!.request.postDataTruncated).toBe(true);
    });

    it("reads at most 1 MiB of a blob body and leaves the app's own read whole", async () => {
      const rt = createRuntime({ polyfillFetch: true });
      rt.install();
      const pending = rt.run(
        `fetch('https://api.test/huge').then(function(r) { return r.text(); })`
      ) as Promise<string>;
      rt.last().respond(200, {}, "z".repeat(BODY_CAP + 5));

      expect(await pending).toHaveLength(BODY_CAP + 5);
      await settle();
      expect(rt.reads.map((blob) => blob.data.length).sort()).toEqual([BODY_CAP, BODY_CAP + 5]);
      expect(rt.reads.find((blob) => blob.data.length === BODY_CAP)!.closed).toBe(true);
      const [record] = rt.records();
      expect(record!.responseBody).toHaveLength(BODY_CAP);
      expect(record).toMatchObject({ bodyTruncated: true, encodedDataLength: BODY_CAP + 5 });
    });

    it("steps back from a cut that splits a UTF-8 character when iOS reads it as null", async () => {
      const rt = createRuntime({ polyfillFetch: true, readAsTextNullOnInvalidUtf8: true });
      rt.install();
      const pending = rt.run(
        `fetch('https://api.test/cjk').then(function(r) { return r.text(); })`
      ) as Promise<string>;
      // 3-byte characters: a cut at 1 MiB splits one, a cut one byte earlier does not.
      rt.last().respond(200, {}, "你".repeat(Math.floor(BODY_CAP / 3) + 10));
      await pending;
      await settle();

      const [record] = rt.records();
      expect(record!.responseBody).toHaveLength((BODY_CAP - 1) / 3);
      expect(record!.bodyTruncated).toBe(true);
      const slices = rt.reads.filter((blob) => blob.data.length <= BODY_CAP);
      expect(slices.map((blob) => [blob.data.length, blob.closed])).toEqual([
        [BODY_CAP, true],
        [BODY_CAP - 1, true],
      ]);
    });

    it("stops stepping back after 3 bytes when iOS cannot read a cut body as text", async () => {
      const rt = createRuntime({ polyfillFetch: true, readAsTextNullOnInvalidUtf8: true });
      rt.install();
      const pending = rt.run(`fetch('https://api.test/binary')`) as Promise<unknown>;
      rt.last().respond(200, {}, Buffer.alloc(BODY_CAP + 10, 0xff));
      await pending;
      await settle();

      expect(rt.reads.map((blob) => [blob.data.length, blob.closed])).toEqual([
        [BODY_CAP, true],
        [BODY_CAP - 1, true],
        [BODY_CAP - 2, true],
        [BODY_CAP - 3, true],
      ]);
      expect(rt.records()[0]).toMatchObject({
        state: "finished",
        encodedDataLength: BODY_CAP + 10,
      });
      expect(rt.records()[0]!.responseBody).toBeUndefined();
    });

    it("gives up without a body when the app closes the blob before a shorter read", async () => {
      const app: { blob?: FakeBlob } = {};
      const rt = createRuntime({
        polyfillFetch: true,
        readAsTextNullOnInvalidUtf8: true,
        beforeReadResult: (blob) => {
          if (blob.data.length === BODY_CAP) app.blob?.close();
        },
      });
      rt.install();
      const pending = rt.run(`fetch('https://api.test/cjk')`) as Promise<unknown>;
      const size = (Math.floor(BODY_CAP / 3) + 10) * 3;
      rt.last().respond(200, {}, "你".repeat(size / 3));
      app.blob = rt.last().response as FakeBlob;
      await pending;
      await settle();

      const [record] = rt.records();
      expect(record).toMatchObject({ state: "finished", encodedDataLength: size });
      expect(record!.responseBody).toBeUndefined();
    });

    it("evicts the oldest records once the buffered bodies pass 50 MB", () => {
      const rt = createRuntime();
      rt.install();
      const body = "x".repeat(BODY_CAP);
      for (let i = 0; i < 60; i++) {
        rt.run(
          `var x = new XMLHttpRequest(); x.open('GET', 'https://api.test/big/${i}'); x.send();`
        );
        rt.last().respond(200, {}, body);
      }
      const log = rt.context.__argent_network_log as CapturedRecord[];
      const byId = rt.context.__argent_network_by_id as Record<string, CapturedRecord>;

      expect(log.reduce((sum, r) => sum + (r.responseBody?.length ?? 0), 0)).toBeLessThanOrEqual(
        50 * BODY_CAP
      );
      expect(log.length).toBeLessThan(60);
      expect(log[log.length - 1]!.request.url).toBe("https://api.test/big/59");
      expect(Object.keys(byId)).toHaveLength(log.length);
      expect(byId["rn-net-1"]).toBeUndefined();
    });

    it("keeps the most recent 2000 records", () => {
      const rt = createRuntime();
      rt.install();
      rt.run(`
        for (var i = 0; i < 2001; i++) {
          var x = new XMLHttpRequest();
          x.open('GET', 'https://api.test/n/' + i);
          x.send();
        }
      `);
      const records = rt.records();

      expect(records).toHaveLength(2000);
      expect(records[0]!.requestId).toBe("rn-net-2");
      expect(
        (rt.context.__argent_network_by_id as Record<string, unknown>)["rn-net-1"]
      ).toBeUndefined();
    });

    it("installs once per JS context", async () => {
      const rt = createRuntime({ polyfillFetch: true });
      expect(rt.install()).toEqual({ installed: true });
      const send = rt.run("XMLHttpRequest.prototype.send");
      const fetch = rt.run("fetch");
      expect(rt.install()).toEqual({ installed: false, reason: "already installed" });
      expect(rt.run("XMLHttpRequest.prototype.send")).toBe(send);
      expect(rt.run("fetch")).toBe(fetch);

      const pending = rt.run(`fetch('https://api.test/once')`) as Promise<unknown>;
      rt.last().respond(200, {}, "ok");
      await pending;
      await settle();
      expect(rt.records()).toHaveLength(1);
    });

    it("keeps the previous fetch-only script from replacing the buffer", () => {
      const rt = createRuntime();
      rt.install();
      // The previous script's guard, as an older tool-server would evaluate it.
      rt.run(`
        if (!globalThis.__argent_network_installed) {
          globalThis.__argent_network_installed = true;
          globalThis.__argent_network_log = [];
          globalThis.__argent_network_by_id = {};
        }
      `);
      rt.run(`var x = new XMLHttpRequest(); x.open('GET', 'https://api.test/after'); x.send();`);
      rt.last().respond(200, {}, "ok");

      expect(rt.records()).toHaveLength(1);
      expect(rt.records()[0]!.request.url).toBe("https://api.test/after");
    });
  });

  it("serves XHR records through the read scripts, minus Metro's own requests", () => {
    const rt = createRuntime();
    rt.install();
    rt.run(
      `var m = new XMLHttpRequest(); m.open('POST', 'http://localhost:8081/symbolicate'); m.send('{}');`
    );
    rt.last().respond(200, {}, "{}");
    rt.run(`var a = new XMLHttpRequest(); a.open('GET', 'https://api.test/me'); a.send();`);
    rt.last().respond(200, { "content-type": "application/json" }, '{"id":7}');

    const list = JSON.parse(rt.run(makeNetworkLogReadScript(0, 50, 8081)) as string) as unknown;
    expect(list).toMatchObject({
      total: 1,
      interceptorInstalled: true,
      entries: [
        {
          requestId: "rn-net-2",
          state: "finished",
          resourceType: "XHR",
          request: { method: "GET", url: "https://api.test/me" },
          response: { status: 200, mimeType: "application/json" },
        },
      ],
    });
    const detail = JSON.parse(rt.run(makeNetworkDetailReadScript("rn-net-2")) as string) as unknown;
    expect(detail).toMatchObject({ requestId: "rn-net-2", responseBody: '{"id":7}' });
  });
});

describe("makeNetworkLogReadScript", () => {
  it("returns a string containing the start and limit values", () => {
    const script = makeNetworkLogReadScript(10, 50, 8081);
    expect(script).toContain("var start = 10");
    expect(script).toContain("var limit = 50");
  });

  it("embeds the metro port for filtering", () => {
    const script = makeNetworkLogReadScript(0, 50, 8081);
    expect(script).toContain("localhost:8081");
    expect(script).toContain("127.0.0.1:8081");
  });

  it("uses different metro port values correctly", () => {
    const script3000 = makeNetworkLogReadScript(0, 50, 3000);
    expect(script3000).toContain("localhost:3000");
    expect(script3000).toContain("127.0.0.1:3000");
    expect(script3000).not.toContain("localhost:8081");
  });

  it("reads from __argent_network_log", () => {
    const script = makeNetworkLogReadScript(0, 50, 8081);
    expect(script).toContain("globalThis.__argent_network_log");
  });

  it("returns interceptorInstalled: false when no log exists", () => {
    const script = makeNetworkLogReadScript(0, 50, 8081);
    expect(script).toContain("interceptorInstalled: false");
  });

  it("strips responseBody from list view entries", () => {
    const script = makeNetworkLogReadScript(0, 50, 8081);
    // The script builds entries without responseBody to avoid large payloads
    expect(script).not.toContain("responseBody: s.responseBody");
  });

  it("is a valid IIFE", () => {
    const script = makeNetworkLogReadScript(0, 50, 8081);
    expect(script.trim()).toMatch(/^\(function\(\)/);
    expect(script.trim()).toMatch(/\)\(\)$/);
  });
});

describe("makeNetworkDetailReadScript", () => {
  it("includes the requestId in the script", () => {
    const script = makeNetworkDetailReadScript("rn-net-42");
    expect(script).toContain("rn-net-42");
  });

  it("embeds the requestId as a JSON string literal (safe against quotes/backslashes/injection)", () => {
    // The requestId is interpolated via JSON.stringify, so for any input the
    // byId lookup is exactly `byId[<json-literal>]` — no break-out is possible.
    for (const rid of ["rn-net-1", "rn-net-'q", 'rn-net-"x', "rn-net-\\b", `x"]; evil(); //`]) {
      const script = makeNetworkDetailReadScript(rid);
      expect(script).toContain(`byId[${JSON.stringify(rid)}]`);
    }
  });

  it("encodes a control character instead of injecting it raw (the hand-escaper crashed the parse)", () => {
    const script = makeNetworkDetailReadScript("rn-net-\n5");
    expect(script).toContain('byId["rn-net-\\n5"]');
    // never a raw newline inside the string literal (which would be a SyntaxError)
    expect(script).not.toMatch(/byId\["rn-net-\n/);
  });

  it("escapes standalone backslashes in requestId", () => {
    const script = makeNetworkDetailReadScript("rn-net-\\test");
    expect(script).toContain("rn-net-\\\\test");
  });

  it("reads from __argent_network_by_id", () => {
    const script = makeNetworkDetailReadScript("rn-net-1");
    expect(script).toContain("globalThis.__argent_network_by_id");
  });

  it("includes responseBody in the detail output", () => {
    const script = makeNetworkDetailReadScript("rn-net-1");
    expect(script).toContain("responseBody: entry.responseBody");
  });

  it("returns an error if interceptor is not installed", () => {
    const script = makeNetworkDetailReadScript("rn-net-1");
    expect(script).toContain("Network interceptor not installed");
  });

  it("returns an error if request is not found", () => {
    const script = makeNetworkDetailReadScript("rn-net-1");
    expect(script).toContain("Request not found");
  });

  it("is a valid IIFE", () => {
    const script = makeNetworkDetailReadScript("rn-net-1");
    expect(script.trim()).toMatch(/^\(function\(\)/);
    expect(script.trim()).toMatch(/\)\(\)$/);
  });
});
