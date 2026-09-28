import { isUtf8 } from "node:buffer";
import { readFileSync } from "node:fs";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { describe, it, expect } from "vitest";
import {
  NETWORK_INTERCEPTOR_SCRIPT,
  makeNetworkLogReadScript,
  makeNetworkDetailReadScript,
} from "../../src/utils/debugger/scripts/network-interceptor";

// React Native's global fetch is this build: react-native/Libraries/Network/fetch.js requires it.
const WHATWG_FETCH = readFileSync(require.resolve("whatwg-fetch/dist/fetch.umd.js"), "utf8");
const BODY_CAP = 1024 * 1024;

interface CapturedRecord {
  id: number;
  requestId: string;
  state: string;
  via: string;
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
  polyfillFetch?: boolean;
  /** iOS: FileReader.readAsText resolves null for bytes that are not valid UTF-8. */
  readAsTextNullOnInvalidUtf8?: boolean;
  /** event-target-shim (RN before 0.81): a listener added during dispatch runs for that event too. */
  liveDispatch?: boolean;
  /** Runs just before a FileReader read delivers its result. */
  beforeReadResult?: (blob: FakeBlob) => void;
}

/** A JS context shaped like React Native's: its XHR, FileReader, Blob, FormData and fetch. */
function createRuntime({
  polyfillFetch = false,
  readAsTextNullOnInvalidUtf8 = false,
  liveDispatch = false,
  beforeReadResult,
}: RuntimeOptions = {}) {
  const sends: FakeXMLHttpRequest[] = [];
  const reads: FakeBlob[] = [];

  /** Models React Native's XMLHttpRequest: event order, responseURL timing and incremental-events flag. */
  class FakeXMLHttpRequest {
    readyState = 0;
    status = 0;
    responseType = "";
    responseURL: string | undefined = undefined;
    withCredentials = false;
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
    setTimeout,
    clearTimeout,
  });
  if (polyfillFetch) runInContext(WHATWG_FETCH, context);
  const run = (code: string): unknown => runInContext(code, context);

  return {
    context,
    sends,
    reads,
    run,
    install: () => JSON.parse(run(NETWORK_INTERCEPTOR_SCRIPT) as string) as unknown,
    records: () => JSON.parse(JSON.stringify(context.__argent_network_log)) as CapturedRecord[],
    last: () => sends[sends.length - 1]!,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
        via: "xhr",
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
        end: (x: ReturnType<ReturnType<typeof createRuntime>["last"]>) =>
          x.fail("Unable to resolve host"),
        errorText: "Unable to resolve host",
      },
      {
        outcome: "a timeout",
        end: (x: ReturnType<ReturnType<typeof createRuntime>["last"]>) => x.fail("timed out", true),
        errorText: "timeout",
      },
      {
        outcome: "an abort",
        end: (x: ReturnType<ReturnType<typeof createRuntime>["last"]>) => x.abort(),
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
  });

  describe("fetch", () => {
    it("records a fetch once, through its XHR, with the blob body read as text", async () => {
      const rt = createRuntime({ polyfillFetch: true });
      rt.install();
      const pending = rt.run(`
        fetch('https://api.test/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"user":"ada"}'
        }).then(function(r) { return r.text(); })
      `) as Promise<string>;

      expect(rt.sends).toHaveLength(1);
      const xhr = rt.last();
      expect(xhr.responseType).toBe("blob");
      expect(xhr.requestHeaders).toEqual({ "content-type": "application/json" });
      const body = JSON.stringify({ token: "héllo" });
      xhr.respond(200, { "content-type": "application/json" }, body);
      expect(await pending).toBe(body);
      await settle();

      expect(rt.records()).toHaveLength(1);
      expect(rt.records()[0]).toMatchObject({
        via: "xhr",
        resourceType: "Fetch",
        state: "finished",
        request: {
          method: "POST",
          url: "https://api.test/login",
          headers: { "content-type": "application/json" },
          postData: '{"user":"ada"}',
        },
        response: { status: 200, mimeType: "application/json" },
        responseBody: body,
        encodedDataLength: Buffer.byteLength(body),
      });
    });

    it("records the final URL of a redirected fetch", async () => {
      const rt = createRuntime({ polyfillFetch: true });
      rt.install();
      const pending = rt.run(
        `fetch('https://api.test/old').then(function(r) { return r.url; })`
      ) as Promise<string>;
      rt.last().respond(200, {}, "moved", "https://api.test/new");

      expect(await pending).toBe("https://api.test/new");
      await settle();
      expect(rt.records()[0]!.request.url).toBe("https://api.test/old");
      expect(rt.records()[0]!.response!.url).toBe("https://api.test/new");
    });

    it("records a failed fetch once, through its XHR", async () => {
      const rt = createRuntime({ polyfillFetch: true });
      rt.install();
      const pending = rt.run(`fetch('https://api.test/offline')`) as Promise<unknown>;
      rt.last().fail("Unable to resolve host");

      await expect(pending).rejects.toThrow("Network request failed");
      await settle();
      expect(rt.records()).toHaveLength(1);
      expect(rt.records()[0]).toMatchObject({
        via: "xhr",
        resourceType: "Fetch",
        state: "failed",
        errorText: "Network error",
      });
    });

    it("gives a native fetch with no XHR below it a record of its own", async () => {
      const rt = createRuntime();
      rt.context.fetch = async () => ({
        url: "https://api.test/native",
        status: 200,
        statusText: "OK",
        headers: new Map([["content-type", "text/plain"]]),
        body: { getReader: () => undefined },
        clone: () => ({ text: async () => "native", blob: async () => ({ size: 6 }) }),
      });
      rt.install();
      await (rt.run(
        `fetch('https://api.test/native', { method: 'post', headers: { 'X-Id': '1' }, body: 'q' })`
      ) as Promise<unknown>);
      await settle();

      expect(rt.sends).toHaveLength(0);
      expect(rt.records()).toHaveLength(1);
      expect(rt.records()[0]).toMatchObject({
        via: "fetch-native",
        resourceType: "Fetch",
        state: "finished",
        request: {
          method: "POST",
          url: "https://api.test/native",
          headers: { "X-Id": "1" },
          postData: "q",
        },
        response: { status: 200, statusText: "OK", mimeType: "text/plain" },
        responseBody: "native",
        encodedDataLength: 6,
      });
    });

    it("records a failed native fetch and still rejects the app's promise", async () => {
      const rt = createRuntime();
      rt.context.fetch = () => Promise.reject(new Error("offline"));
      rt.install();

      await expect(
        rt.run(`fetch('https://api.test/down', { headers: [['X-Id', '2']] })`) as Promise<unknown>
      ).rejects.toThrow("offline");
      await settle();
      expect(rt.records()).toHaveLength(1);
      expect(rt.records()[0]).toMatchObject({
        via: "fetch-native",
        state: "failed",
        errorText: "offline",
        request: { headers: { "X-Id": "2" } },
      });
    });

    it("hands the app its own promise for a native fetch, so a rejection nobody handles stays unhandled", async () => {
      const rt = createRuntime();
      const original = Promise.reject(new Error("offline"));
      original.catch(() => {});
      rt.context.fetch = () => original;
      rt.install();
      const returned = rt.run(`fetch('https://api.test/beacon')`) as Promise<unknown>;

      // The interceptor's own handler marks the native promise handled; the app's copy still rejects.
      expect(returned).not.toBe(original);
      await expect(returned).rejects.toThrow("offline");
    });

    it.each(["before", "after"])(
      "records one request through a synchronous fetch wrapper installed %s the interceptor",
      async (order) => {
        const rt = createRuntime({ polyfillFetch: true });
        const wrap = `var inner = fetch; fetch = function(input, init) { return inner(input, init).then(function(r) { return r; }); };`;
        if (order === "before") rt.run(wrap);
        rt.install();
        if (order === "after") rt.run(wrap);

        const pending = rt.run(`fetch('https://api.test/wrapped')`) as Promise<unknown>;
        rt.last().respond(200, {}, "ok");
        await pending;
        await settle();

        expect(rt.records()).toHaveLength(1);
        expect(rt.records()[0]).toMatchObject({
          via: "xhr",
          resourceType: "Fetch",
          responseBody: "ok",
        });
      }
    );

    describe("through a wrapper that awaits before it calls fetch", () => {
      const ASYNC_WRAP = `var inner = fetch; fetch = async function(input, init) { await new Promise(function(r) { setTimeout(r, 0); }); return inner(input, init); };`;

      async function sent(rt: ReturnType<typeof createRuntime>, count: number): Promise<void> {
        for (let i = 0; i < 20 && rt.sends.length < count; i++) await settle();
        expect(rt.sends).toHaveLength(count);
      }

      it("records the request once, through its XHR", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        rt.run(ASYNC_WRAP);
        rt.install();
        const pending = rt.run(
          `fetch('https://api.test/wrapped', { method: 'POST', body: 'q' })`
        ) as Promise<unknown>;
        expect(rt.records()).toMatchObject([{ via: "fetch-native", state: "pending" }]);
        await sent(rt, 1);

        // Matched at send: the fetch record went before the XHR record started.
        expect(rt.records()).toMatchObject([
          { requestId: "rn-net-2", via: "xhr", state: "pending" },
        ]);
        rt.last().respond(200, {}, "ok");
        await pending;
        await settle();
        expect(rt.records()).toHaveLength(1);
        expect(rt.records()[0]).toMatchObject({
          requestId: "rn-net-2",
          via: "xhr",
          resourceType: "Fetch",
          state: "finished",
          request: { method: "POST", url: "https://api.test/wrapped", postData: "q" },
          responseBody: "ok",
        });
        expect(rt.run("__argent_network_by_id['rn-net-1']")).toBeUndefined();
      });

      it("records the request once when the wrapper changes the URL", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        rt.run(
          `var inner = fetch; fetch = async function(path, init) { var token = await Promise.resolve('t1'); return inner('https://api.test' + path + '?token=' + token, init); };`
        );
        rt.install();
        const pending = rt.run(`fetch('/me')`) as Promise<unknown>;
        await sent(rt, 1);
        rt.last().respond(200, {}, "ok");
        await pending;
        await settle();

        expect(rt.records()).toHaveLength(1);
        expect(rt.records()[0]).toMatchObject({
          via: "xhr",
          resourceType: "Fetch",
          request: { url: "https://api.test/me?token=t1" },
        });
      });

      it("records a failed request once", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        rt.run(ASYNC_WRAP);
        rt.install();
        const pending = rt.run(`fetch('https://api.test/offline')`) as Promise<unknown>;
        await sent(rt, 1);
        rt.last().fail("Unable to resolve host");

        await expect(pending).rejects.toThrow("Network request failed");
        await settle();
        expect(rt.records()).toHaveLength(1);
        expect(rt.records()[0]).toMatchObject({ via: "xhr", state: "failed" });
      });

      it("matches the URL React Native's fetch adds a cache buster to", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        rt.run(ASYNC_WRAP);
        rt.install();
        const pending = rt.run(`Promise.all([
          fetch('https://api.test/nc', { cache: 'no-store' }),
          fetch('https://api.test/nc?a=1&_=5', { method: 'HEAD', cache: 'no-cache' })
        ])`) as Promise<unknown>;
        await sent(rt, 2);
        for (const xhr of rt.sends) xhr.respond(200, {}, "");
        await pending;
        await settle();

        expect(rt.records().map((r) => r.request.url)).toEqual([
          expect.stringMatching(/^https:\/\/api\.test\/nc\?_=\d+$/),
          expect.stringMatching(/^https:\/\/api\.test\/nc\?a=1&_=\d+$/),
        ]);
      });

      it("records each of several concurrent requests to one URL once", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        // Awaits only for the first call, as a wrapper that refreshes an expired token does.
        rt.run(
          `var inner = fetch; var calls = 0; fetch = function(input, init) { if (calls++ > 0) return inner(input, init); return Promise.resolve().then(function() { return inner(input, init); }); };`
        );
        rt.install();
        const pending = rt.run(
          `Promise.all([fetch('https://api.test/same'), fetch('https://api.test/same'), fetch('https://api.test/same')])`
        ) as Promise<unknown>;
        await sent(rt, 3);
        for (const xhr of rt.sends) xhr.respond(200, {}, "ok");
        await pending;
        await settle();

        expect(rt.records()).toHaveLength(3);
        for (const record of rt.records()) {
          expect(record).toMatchObject({ via: "xhr", state: "finished" });
        }
      });

      it("keeps both records when a queue sends one request's XHR inside the next call", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        rt.run(`var inner = fetch; var queued = null;
          fetch = function(input, init) {
            var previous = queued;
            queued = null;
            if (previous) previous();
            return new Promise(function(resolve, reject) {
              queued = function() { inner(input, init).then(resolve, reject); };
            });
          };`);
        rt.install();
        const first = rt.run(`fetch('https://api.test/a')`) as Promise<unknown>;
        const second = rt.run(`fetch('https://api.test/b')`) as Promise<unknown>;
        rt.run(`fetch('https://api.test/c')`);
        expect(rt.sends).toHaveLength(2);
        for (const xhr of rt.sends) xhr.respond(200, {}, "ok");
        await Promise.all([first, second]);
        await settle();

        // c is still queued: it sent nothing, and b's XHR ran on its stack.
        expect(rt.records().map((r) => `${r.via} ${r.state} ${r.request.url}`)).toEqual([
          "xhr finished https://api.test/a",
          "xhr finished https://api.test/b",
        ]);
      });
    });

    it.each([
      {
        sender: "axios",
        xhr: `x.responseType = 'blob'; x.onloadend = x.onabort = x.onerror = x.ontimeout = function() {};`,
        settledFirst: false,
      },
      {
        sender: "a blob XHR after a native response",
        xhr: `x.responseType = 'blob'; x.onload = x.onabort = x.onerror = x.ontimeout = function() {};`,
        settledFirst: true,
      },
    ])(
      "keeps a pending native fetch when $sender requests the same URL",
      async ({ xhr, settledFirst }) => {
        const rt = createRuntime();
        // Each call gets a Response of its own, as from a native fetch.
        const nativeResponse = (url: string) => ({
          url,
          status: 200,
          statusText: "OK",
          headers: new Map(),
          body: { getReader: () => undefined },
          clone: () => ({ text: async () => "native", blob: async () => ({ size: 6 }) }),
        });
        let finish: () => void = () => {};
        rt.context.fetch = (input: string) =>
          input.endsWith("/first")
            ? Promise.resolve(nativeResponse(input))
            : new Promise((resolve) => (finish = () => resolve(nativeResponse(input))));
        rt.install();
        if (settledFirst) await (rt.run(`fetch('https://api.test/first')`) as Promise<unknown>);
        const pending = rt.run(`fetch('https://api.test/same')`) as Promise<unknown>;
        rt.run(
          `var x = new XMLHttpRequest(); x.open('GET', 'https://api.test/same'); ${xhr} x.send();`
        );
        rt.last().respond(200, {}, "xhr");
        finish();
        await pending;
        await settle();

        expect(
          rt
            .records()
            .filter((r) => r.request.url.endsWith("/same"))
            .map((r) => `${r.via} ${r.state} ${r.responseBody}`)
        ).toEqual(["fetch-native finished native", "xhr finished xhr"]);
      }
    );

    it("keeps a settled native fetch when an XHR requests the same URL later", async () => {
      const rt = createRuntime({ polyfillFetch: true });
      rt.run(
        `var inner = fetch; fetch = function(input, init) { return Promise.resolve(new Response('cached', { status: 200 })); }; var real = inner;`
      );
      rt.install();
      await (rt.run(`fetch('https://api.test/cached')`) as Promise<unknown>);
      const pending = rt.run(`real('https://api.test/cached')`) as Promise<unknown>;
      rt.last().respond(200, {}, "fresh");
      await pending;
      await settle();

      expect(rt.records().map((r) => `${r.via} ${r.responseBody}`)).toEqual([
        "fetch-native cached",
        "xhr fresh",
      ]);
    });

    describe("when its XHR was not matched at send", () => {
      const AWAIT_THEN = `await new Promise(function(r) { setTimeout(r, 0); });`;
      // A Response that React Native's fetch did not build (it streams its body): it marks fetch as native.
      const NATIVE_LIKE = `{ url: 'https://api.test/native', status: 200, statusText: 'OK', headers: new Map(), body: { getReader: function() {} }, clone: function() { return { text: async function() { return 'native'; }, blob: async function() { return { size: 6 }; } }; } }`;

      async function sent(rt: ReturnType<typeof createRuntime>, count: number): Promise<void> {
        for (let i = 0; i < 20 && rt.sends.length < count; i++) await settle();
        expect(rt.sends).toHaveLength(count);
      }

      it.each([
        // The first call sends its XHR on its own stack, so only the second call has a fetch record.
        { shape: "returns the in-flight request", awaits: "", xhrId: "rn-net-1" },
        // Both calls await first, so both have a fetch record; the XHR takes the first at send.
        {
          shape: "awaits, then returns the in-flight request",
          awaits: AWAIT_THEN,
          xhrId: "rn-net-3",
        },
      ])(
        "records a request a wrapper shares with a second caller once ($shape)",
        async ({ awaits, xhrId }) => {
          const rt = createRuntime({ polyfillFetch: true });
          rt.run(`var inner = fetch; var inflight = {};
          fetch = async function(u, init) { ${awaits}
            if (!inflight[u]) inflight[u] = inner(u, init).finally(function() { delete inflight[u]; });
            return inflight[u];
          };`);
          rt.install();
          const pending = rt.run(
            `Promise.all([fetch('https://api.test/shared'), fetch('https://api.test/shared')])`
          ) as Promise<unknown>;
          await sent(rt, 1);
          rt.last().respond(200, {}, "once");
          await pending;
          await settle();

          expect(rt.records()).toHaveLength(1);
          expect(rt.records()[0]).toMatchObject({
            requestId: xhrId,
            via: "xhr",
            resourceType: "Fetch",
            state: "finished",
            responseBody: "once",
          });
          expect(rt.run(`Object.keys(__argent_network_by_id)`)).toEqual([xhrId]);
        }
      );

      it("records a request a wrapper shares by returning one promise once, in flight too", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        rt.run(`var inner = fetch; var inflight = {};
          fetch = function(u, init) {
            if (!inflight[u]) inflight[u] = inner(u, init).finally(function() { delete inflight[u]; });
            return inflight[u];
          };`);
        rt.install();
        const pending = rt.run(
          `Promise.all([fetch('https://api.test/shared'), fetch('https://api.test/shared')])`
        ) as Promise<unknown>;
        expect(rt.records().map((r) => `${r.via} ${r.state}`)).toEqual(["xhr pending"]);
        rt.last().respond(200, {}, "once");
        await pending;
        await settle();

        expect(rt.records().map((r) => `${r.via} ${r.state}`)).toEqual(["xhr finished"]);
      });

      it.each([
        {
          outcome: "resolves",
          end: (x: ReturnType<ReturnType<typeof createRuntime>["last"]>) =>
            x.respond(200, {}, "ok"),
          state: "finished",
        },
        {
          outcome: "fails",
          end: (x: ReturnType<ReturnType<typeof createRuntime>["last"]>) => x.fail("offline"),
          state: "failed",
        },
      ])(
        "records a request once after the wrapper resolved a Response it did not get from React Native, when the request $outcome",
        async ({ end, state }) => {
          const rt = createRuntime({ polyfillFetch: true });
          rt.run(`var inner = fetch; var calls = 0;
            fetch = async function(u, init) { ${AWAIT_THEN} if (calls++ === 0) return ${NATIVE_LIKE}; return inner(u, init); };`);
          rt.install();
          await (rt.run(`fetch('https://api.test/native')`) as Promise<unknown>);
          await settle();
          const pending = rt.run(`fetch('https://api.test/then')`) as Promise<unknown>;
          await sent(rt, 1);
          // Its record was not matched at send: a native Response has been seen.
          expect(rt.records().filter((r) => r.request.url.endsWith("/then"))).toHaveLength(2);
          end(rt.last());
          await pending.catch(() => undefined);
          await settle();

          expect(rt.records().map((r) => `${r.via} ${r.state} ${r.request.url}`)).toEqual([
            "fetch-native finished https://api.test/native",
            `xhr ${state} https://api.test/then`,
          ]);
          expect(rt.records()[1]!.resourceType).toBe("Fetch");
        }
      );

      it("does not take a plain object the wrapper resolved for a native Response", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        rt.run(`var inner = fetch; var calls = 0;
          fetch = async function(u, init) { ${AWAIT_THEN} if (calls++ === 0) return { ok: true, status: 200 }; return inner(u, init); };`);
        rt.install();
        await (rt.run(`fetch('https://api.test/plain')`) as Promise<unknown>);
        await settle();
        const pending = rt.run(`fetch('https://api.test/then')`) as Promise<unknown>;
        await sent(rt, 1);
        // Matched at send: the fetch record went before the XHR record started.
        expect(rt.records().filter((r) => r.request.url.endsWith("/then"))).toHaveLength(1);
        rt.last().respond(200, {}, "ok");
        await pending;
        await settle();

        expect(rt.records().map((r) => `${r.requestId} ${r.via} ${r.state}`)).toEqual([
          "rn-net-1 fetch-native finished",
          "rn-net-3 xhr finished",
        ]);
      });

      it("matches the XHR of a fetch that reads an arraybuffer where Blob is unavailable", async () => {
        const rt = createRuntime();
        rt.run("delete globalThis.Blob");
        rt.run(WHATWG_FETCH);
        rt.run(
          `var inner = fetch; fetch = async function(u, init) { ${AWAIT_THEN} return inner(u, init); };`
        );
        rt.install();
        const pending = rt.run(`fetch('https://api.test/ab')`) as Promise<unknown>;
        await sent(rt, 1);
        expect(rt.last().responseType).toBe("arraybuffer");
        expect(rt.records()).toHaveLength(1);
        rt.last().respond(200, {}, new TextEncoder().encode("bytes"));
        await pending;
        await settle();

        expect(rt.records()).toHaveLength(1);
        expect(rt.records()[0]).toMatchObject({
          via: "xhr",
          state: "finished",
          encodedDataLength: 5,
        });
      });

      it("keeps a Response the wrapper built itself while an XHR to another URL is in flight", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        rt.run(`var inner = fetch;
          fetch = async function(u, init) { ${AWAIT_THEN} return u.indexOf('/mocked') !== -1 ? new Response('mock', { status: 200 }) : inner(u, init); };`);
        rt.install();
        const pending = rt.run(
          `Promise.all([fetch('https://api.test/real'), fetch('https://api.test/mocked')])`
        ) as Promise<unknown>;
        await sent(rt, 1);
        await settle();
        rt.last().respond(200, {}, "real");
        await pending;
        await settle();

        // The mocked call's fetch record came before the real call's XHR record.
        expect(rt.records().map((r) => `${r.via} ${r.state} ${r.responseBody}`)).toEqual([
          "fetch-native finished mock",
          "xhr finished real",
        ]);
      });

      it.each([
        { shape: "returns the in-flight request", awaits: "" },
        { shape: "awaits, then returns the in-flight request", awaits: AWAIT_THEN },
      ])(
        "records a request a wrapper shares as parsed JSON with a second caller once ($shape)",
        async ({ awaits }) => {
          const rt = createRuntime({ polyfillFetch: true });
          rt.run(`var inner = fetch; var inflight = {};
            fetch = async function(u, init) { ${awaits}
              if (!inflight[u]) inflight[u] = inner(u, init).then(function(r) { return r.json(); }).finally(function() { delete inflight[u]; });
              return inflight[u];
            };`);
          rt.install();
          const pending = rt.run(
            `Promise.all([fetch('https://api.test/shared'), fetch('https://api.test/shared')])`
          ) as Promise<unknown>;
          await sent(rt, 1);
          rt.last().respond(200, { "content-type": "application/json" }, '{"a":1}');
          await pending;
          await settle();

          expect(rt.records().map((r) => `${r.via} ${r.state} ${r.responseBody}`)).toEqual([
            'xhr finished {"a":1}',
          ]);
        }
      );

      it("records a request once after the wrapper resolved a value that is no Response, after a native Response was seen", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        rt.run(`var inner = fetch;
          fetch = async function(u, init) { ${AWAIT_THEN}
            if (u.indexOf('/stream') !== -1) return ${NATIVE_LIKE};
            inner(u, init).then(null, function() {});
            return undefined;
          };`);
        rt.install();
        await (rt.run(`fetch('https://api.test/stream')`) as Promise<unknown>);
        await settle();
        await (rt.run(
          `fetch('https://api.test/beacon', { method: 'POST', body: 'b' })`
        ) as Promise<unknown>);
        await sent(rt, 1);
        rt.last().respond(204, {}, "");
        await settle();

        expect(rt.records().map((r) => `${r.via} ${r.state} ${r.request.url}`)).toEqual([
          "fetch-native finished https://api.test/stream",
          "xhr finished https://api.test/beacon",
        ]);
      });

      it("records each request once through a wrapper that returns its own Response class", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        rt.run(`var inner = fetch;
          function ApiResponse(r) { this.raw = r; this.status = r.status; this.url = r.url; this.headers = r.headers; this.ok = r.ok; }
          ApiResponse.prototype.clone = function() { return new ApiResponse(this.raw.clone()); };
          ApiResponse.prototype.text = function() { return this.raw.text(); };
          fetch = async function(u, init) { ${AWAIT_THEN} var r = await inner(u, init); return new ApiResponse(r); };`);
        rt.install();
        for (const path of ["one", "two"]) {
          const pending = rt.run(`fetch('https://api.test/${path}')`) as Promise<unknown>;
          await sent(rt, path === "one" ? 1 : 2);
          rt.last().respond(200, {}, path);
          await pending;
          await settle();
        }

        expect(rt.records().map((r) => `${r.via} ${r.state} ${r.responseBody}`)).toEqual([
          "xhr finished one",
          "xhr finished two",
        ]);
      });

      it("keeps a pending native fetch when a React Native fetch to its URL is sent inside a fetch call", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        let finish: () => void = () => {};
        rt.context.nativeFetch = () =>
          new Promise((_, reject) => (finish = () => reject(new TypeError("stream closed"))));
        // A router that awaits nothing: React Native's fetch sends its XHR inside the wrapped call.
        rt.run(`var inner = fetch;
          fetch = function(u, init) { if (init && init.headers && init.headers['x-stream']) return nativeFetch(u); return inner(u, init); };`);
        rt.install();
        const stream = rt.run(
          `fetch('https://api.test/graphql', { method: 'POST', body: 'subscription', headers: { 'x-stream': '1' } })`
        ) as Promise<unknown>;
        const query = rt.run(
          `fetch('https://api.test/graphql', { method: 'POST', body: 'query' })`
        ) as Promise<unknown>;
        expect(rt.records()).toHaveLength(2);
        rt.last().respond(200, {}, "data");
        await query;
        finish();
        await stream.catch(() => undefined);
        await settle();

        expect(
          rt
            .records()
            .map(
              (r) => `${r.via} ${r.state} ${r.request.postData} ${r.responseBody ?? r.errorText}`
            )
        ).toEqual(["fetch-native failed subscription stream closed", "xhr finished query data"]);
      });

      it("tells a native Response by its body stream without reading the body", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        // Expo SDK 55: reading `body` starts the native stream, and clone() is not implemented.
        rt.run(`var inner = fetch;
          function NativeResponse(url) { this.url = url; this.status = 200; this.statusText = 'OK'; this.headers = new Map(); }
          Object.defineProperty(NativeResponse.prototype, 'body', { get: function() { globalThis.bodyRead = true; return {}; } });
          NativeResponse.prototype.clone = function() { throw new Error('Not implemented'); };
          fetch = async function(u, init) { ${AWAIT_THEN} return u.indexOf('/native') !== -1 ? new NativeResponse(u) : inner(u, init); };`);
        rt.install();
        const native = rt.run(`fetch('https://api.test/native')`) as Promise<unknown>;
        await settle();
        // A fetch-shaped XHR of the app takes the pending record; the native Response brings it back.
        rt.run(`var x = new XMLHttpRequest(); x.open('GET', 'https://cdn.test/file.bin');
          x.responseType = 'blob'; x.onload = x.onerror = x.ontimeout = x.onabort = function() {}; x.send();`);
        rt.last().respond(200, {}, "bytes");
        await native;
        await settle();

        expect(rt.run("globalThis.bodyRead")).toBeUndefined();
        expect(rt.records().map((r) => `${r.via} ${r.state} ${r.request.url}`)).toEqual([
          "fetch-native finished https://api.test/native",
          "xhr finished https://cdn.test/file.bin",
        ]);
        // A native Response was seen: a later fetch-shaped XHR takes no pending record.
        const later = rt.run(`fetch('https://api.test/native-2')`) as Promise<unknown>;
        await settle();
        rt.run(`var y = new XMLHttpRequest(); y.open('GET', 'https://cdn.test/other.bin');
          y.responseType = 'blob'; y.onload = y.onerror = y.ontimeout = y.onabort = function() {}; y.send();`);
        expect(rt.records()).toHaveLength(4);
        rt.last().respond(200, {}, "more");
        await later;
        await settle();
        expect(rt.records()).toHaveLength(4);
      });

      it("keeps a native fetch record when the wrapper sends a log XHR on the same stack", async () => {
        const rt = createRuntime();
        rt.context.nativeFetch = () =>
          Promise.resolve(
            rt.run(`(${NATIVE_LIKE.replace("'https://api.test/native'", "'https://api.test/n1'")})`)
          );
        rt.run(`fetch = function(u, init) {
          var x = new XMLHttpRequest(); x.open('POST', 'https://log.test/event'); x.responseType = 'json';
          x.onloadend = function() {}; x.send('e');
          return nativeFetch(u, init);
        };`);
        rt.install();
        const pending = rt.run(`fetch('https://api.test/n1')`) as Promise<unknown>;
        rt.last().respond(204, {}, "");
        await pending;
        await settle();

        expect(
          rt.records().map((r) => `${r.via} ${r.resourceType} ${r.state} ${r.request.url}`)
        ).toEqual([
          "xhr XHR finished https://log.test/event",
          "fetch-native Fetch finished https://api.test/n1",
        ]);
      });

      it.each([
        { below: "React Native's fetch", native: false, end: "fails", records: ["xhr failed"] },
        {
          below: "a native fetch",
          native: true,
          end: "resolves",
          records: ["fetch-native finished"],
        },
      ])(
        "records a request once through a wrapper that calls the global fetch again, over $below",
        async ({ native, records }) => {
          const rt = createRuntime({ polyfillFetch: !native });
          if (native) {
            rt.context.fetch = (url: string) =>
              Promise.resolve(
                rt.run(`(${NATIVE_LIKE.replace("'https://api.test/native'", JSON.stringify(url))})`)
              );
          }
          // Written with the global name: after the install, the inner call runs the interceptor again.
          rt.run(`var inner = fetch;
            fetch = function(u, init) { if (u.charAt(0) === '/') return fetch('https://api.test' + u, init); return inner(u, init); };`);
          rt.install();
          const pending = rt.run(`fetch('/users')`) as Promise<unknown>;
          if (!native) rt.last().fail("offline");
          await pending.catch(() => undefined);
          await settle();

          expect(rt.records().map((r) => `${r.via} ${r.state}`)).toEqual(records);
          expect(rt.records()[0]!.request.url).toBe("https://api.test/users");
        }
      );

      it("records a request once through a wrapper that changes the method", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        rt.run(`var inner = fetch;
          fetch = async function(u, init) { ${AWAIT_THEN}
            var method = String((init && init.method) || 'GET').toUpperCase();
            if (method !== 'PATCH') return inner(u, init);
            return inner(u, Object.assign({}, init, { method: 'POST', headers: { 'X-HTTP-Method-Override': 'PATCH' } }));
          };`);
        rt.install();
        const pending = rt.run(
          `fetch('https://api.test/items/1', { method: 'PATCH', body: '{"a":1}' })`
        ) as Promise<unknown>;
        await sent(rt, 1);
        rt.last().respond(200, {}, "patched");
        await pending;
        await settle();

        expect(rt.records()).toHaveLength(1);
        expect(rt.records()[0]).toMatchObject({
          via: "xhr",
          resourceType: "Fetch",
          request: { method: "POST", headers: { "x-http-method-override": "PATCH" } },
          responseBody: "patched",
        });
      });

      // A failed request through this wrapper keeps two records: a rejection carries no body to
      // match, and a native Response seen earlier stops the match at send.
      it("records a request once through a wrapper that changes the URL after a native Response was seen", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        rt.run(`var inner = fetch;
          fetch = async function(path, init) { ${AWAIT_THEN}
            if (path === '/stream') return ${NATIVE_LIKE};
            return inner('https://api.test' + path, init);
          };`);
        rt.install();
        await (rt.run(`fetch('/stream')`) as Promise<unknown>);
        await settle();
        const pending = rt.run(`fetch('/users')`) as Promise<unknown>;
        await sent(rt, 1);
        rt.last().respond(200, {}, "[]");
        await pending;
        await settle();

        expect(rt.records().map((r) => `${r.via} ${r.state} ${r.request.url}`)).toEqual([
          "fetch-native finished /stream",
          "xhr finished https://api.test/users",
        ]);
      });

      it("records a request once when a queue sends it inside the next call and the wrapper changes the URL", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        rt.run(`var inner = fetch; var queued = null;
          fetch = function(path, init) {
            var previous = queued; queued = null; if (previous) previous();
            return new Promise(function(resolve, reject) {
              queued = function() { inner('https://api.test' + path, init).then(resolve, reject); };
            });
          };`);
        rt.install();
        const first = rt.run(`fetch('/a')`) as Promise<unknown>;
        rt.run(`fetch('/b')`);
        expect(rt.sends).toHaveLength(1);
        rt.last().respond(200, {}, "a-body");
        await first;
        await settle();

        expect(rt.records().map((r) => `${r.via} ${r.state} ${r.request.url}`)).toEqual([
          "xhr finished https://api.test/a",
        ]);
      });

      describe("puts a native fetch record back", () => {
        // A wrapper that serves some calls from a native fetch and the rest from React Native's.
        function mixed(routeNative: string): ReturnType<typeof createRuntime> {
          const rt = createRuntime({ polyfillFetch: true });
          rt.context.finishers = [] as Array<() => void>;
          rt.run(`var inner = fetch;
            function nativeLike(url) { return ${NATIVE_LIKE.replace("'https://api.test/native'", "url")}; }
            function nativeFetch(url) { return new Promise(function(resolve) { finishers.push(function() { resolve(nativeLike(url)); }); }); }
            fetch = async function(u, init) { ${AWAIT_THEN} if (${routeNative}) return nativeFetch(u); return inner(u, init); };`);
          rt.install();
          return rt;
        }
        const finish = (rt: ReturnType<typeof createRuntime>) =>
          (rt.context.finishers as Array<() => void>).shift()!();

        it("when a React Native fetch to the same URL took it", async () => {
          const rt = mixed("init && init.headers && init.headers['x-stream']");
          const stream = rt.run(
            `fetch('https://api.test/graphql', { method: 'POST', body: 'subscription', headers: { 'x-stream': '1' } })`
          ) as Promise<unknown>;
          await settle();
          const query = rt.run(
            `fetch('https://api.test/graphql', { method: 'POST', body: 'query' })`
          ) as Promise<unknown>;
          await sent(rt, 1);
          // The XHR took the older, native record.
          expect(rt.records().map((r) => r.request.postData)).toEqual(["query", "query"]);
          rt.last().respond(200, {}, "data");
          await query;
          finish(rt);
          await stream;
          await settle();

          expect(
            rt.records().map((r) => `${r.via} ${r.state} ${r.request.postData} ${r.responseBody}`)
          ).toEqual(["fetch-native finished subscription native", "xhr finished query data"]);
        });

        it("when a React Native fetch to another URL took it", async () => {
          const rt = mixed("u.indexOf('/stream') !== -1");
          const stream = rt.run(`fetch('https://api.test/stream')`) as Promise<unknown>;
          await settle();
          const users = rt.run(`fetch('https://api.test/users')`) as Promise<unknown>;
          await sent(rt, 1);
          rt.last().respond(200, {}, "[]");
          await users;
          finish(rt);
          await stream;
          await settle();

          expect(rt.records().map((r) => `${r.via} ${r.state} ${r.request.url}`)).toEqual([
            "fetch-native finished https://api.test/stream",
            "xhr finished https://api.test/users",
          ]);
        });

        it("when an XHR of the app took it before any native Response was seen", async () => {
          const rt = mixed("true");
          const pending = rt.run(`fetch('https://api.test/native-first')`) as Promise<unknown>;
          await settle();
          rt.run(`var x = new XMLHttpRequest(); x.open('GET', 'https://cdn.test/file.bin');
            x.responseType = 'blob'; x.onload = x.onerror = x.ontimeout = x.onabort = function() {}; x.send();`);
          expect(rt.records()).toHaveLength(1);
          rt.last().respond(200, {}, "bytes");
          finish(rt);
          await pending;
          await settle();

          expect(rt.records().map((r) => `${r.via} ${r.state} ${r.request.url}`)).toEqual([
            "fetch-native finished https://api.test/native-first",
            "xhr finished https://cdn.test/file.bin",
          ]);
        });
      });

      it.each([
        {
          outcome: "succeeded",
          end: (x: ReturnType<ReturnType<typeof createRuntime>["last"]>) =>
            x.respond(200, {}, '{"data":1}'),
          state: "finished",
        },
        {
          outcome: "failed",
          end: (x: ReturnType<ReturnType<typeof createRuntime>["last"]>) => x.fail("offline"),
          state: "failed",
        },
      ])(
        "keeps a failed native fetch when an axios request to its URL $outcome meanwhile",
        async ({ end, state }) => {
          const rt = createRuntime();
          let finish: () => void = () => {};
          rt.context.fetch = () =>
            new Promise(
              (_, reject) => (finish = () => reject(new TypeError("Network request failed")))
            );
          rt.install();
          const pending = rt.run(
            `fetch('https://api.test/graphql', { method: 'POST', body: '{}' })`
          ) as Promise<unknown>;
          rt.run(`var x = new XMLHttpRequest(); x.open('POST', 'https://api.test/graphql');
          x.responseType = 'json'; x.onloadend = function() {}; x.send('{}');`);
          end(rt.last());
          finish();
          await pending.catch(() => undefined);
          await settle();

          expect(rt.records().map((r) => `${r.via} ${r.resourceType} ${r.state}`)).toEqual([
            "fetch-native Fetch failed",
            `xhr XHR ${state}`,
          ]);
        }
      );

      it("keeps a native fetch the wrapper resolves as parsed JSON next to an axios request to its URL", async () => {
        const rt = createRuntime();
        rt.context.nativeFetch = () =>
          Promise.resolve(
            rt.run(`(${NATIVE_LIKE.replace("'https://api.test/native'", "'https://api.test/me'")})`)
          );
        rt.run(
          `fetch = async function(u, init) { ${AWAIT_THEN} await nativeFetch(u, init); return { parsed: true }; };`
        );
        rt.install();
        const pending = rt.run(`fetch('https://api.test/me')`) as Promise<unknown>;
        rt.run(`var x = new XMLHttpRequest(); x.open('GET', 'https://api.test/me');
          x.responseType = 'json'; x.onloadend = function() {}; x.send();`);
        await pending;
        rt.last().respond(200, {}, "{}");
        await settle();

        expect(rt.records().map((r) => `${r.via} ${r.state}`)).toEqual([
          "fetch-native finished",
          "xhr finished",
        ]);
      });

      it.each([
        { shape: "on its own stack", awaits: "", outcome: "resolves", state: "finished" },
        { shape: "after an await", awaits: AWAIT_THEN, outcome: "resolves", state: "finished" },
        { shape: "on its own stack", awaits: "", outcome: "rejects", state: "failed" },
        { shape: "after an await", awaits: AWAIT_THEN, outcome: "rejects", state: "failed" },
      ])(
        "records a native request once when the wrapper sends it on through the global fetch under another URL ($shape, $outcome)",
        async ({ awaits, outcome, state }) => {
          const rt = createRuntime();
          let finish: () => void = () => {};
          rt.context.nativeFetch = (url: string) =>
            new Promise((resolve, reject) => {
              finish =
                outcome === "resolves"
                  ? () =>
                      resolve(
                        rt.run(
                          `(${NATIVE_LIKE.replace("'https://api.test/native'", JSON.stringify(url))})`
                        )
                      )
                  : () => reject(new TypeError("Network request failed"));
            });
          // fetch below resolves to the wrapped global fetch at call time, as in the app.
          rt.run(`fetch = async function(u, init) { ${awaits}
            if (u[0] === '/') return fetch('https://api.test' + u, init);
            return nativeFetch(u, init);
          };`);
          rt.install();
          const pending = rt.run(`fetch('/users')`) as Promise<unknown>;
          pending.catch(() => undefined);
          for (let i = 0; i < 5; i++) await settle();
          finish();
          await pending.catch(() => undefined);
          await settle();

          expect(rt.records().map((r) => `${r.via} ${r.state} ${r.request.url}`)).toEqual([
            `fetch-native ${state} https://api.test/users`,
          ]);
        }
      );

      it("records each native request of a wrapper that answers from its last promise and still sends", async () => {
        const rt = createRuntime();
        let sent = 0;
        rt.context.nativeFetch = (url: string) => {
          sent++;
          return Promise.resolve(
            rt.run(`(${NATIVE_LIKE.replace("'https://api.test/native'", JSON.stringify(url))})`)
          );
        };
        // Stale-while-revalidate: every call sends, a repeated call gets the earlier promise.
        rt.run(`var memo = {};
          fetch = function(u) { var fresh = nativeFetch(u); if (memo[u]) return memo[u]; memo[u] = fresh; return fresh; };`);
        rt.install();
        await (rt.run(`fetch('https://api.test/swr')`) as Promise<unknown>);
        await settle();
        await new Promise((resolve) => setTimeout(resolve, 5));
        await (rt.run(`fetch('https://api.test/swr')`) as Promise<unknown>);
        await settle();

        expect(sent).toBe(2);
        expect(rt.records().map((r) => `${r.via} ${r.state}`)).toEqual([
          "fetch-native finished",
          "fetch-native finished",
        ]);
      });

      it("hands back what a fetch below returns that is a thenable with no chained promise", () => {
        const rt = createRuntime();
        rt.run(
          `fetch = function() { return { then: function(resolve) { resolve({ status: 200 }); } }; };`
        );
        rt.install();

        expect(rt.run(`fetch('https://api.test/odd')`)).toBeUndefined();
      });

      it("forgets a pending fetch record once the log evicted it", async () => {
        const rt = createRuntime();
        rt.context.fetch = () => new Promise(() => undefined);
        rt.install();
        rt.run(`for (var i = 0; i < 2001; i++) fetch('https://api.test/hung/' + i);`);
        expect(rt.run("__argent_network_by_id['rn-net-1']")).toBeUndefined();
        // A fetch-shaped XHR takes the oldest pending record that is still in the log.
        rt.run(`var x = new XMLHttpRequest(); x.open('GET', 'https://api.test/other');
          x.responseType = 'blob'; x.onload = x.onerror = x.ontimeout = x.onabort = function() {}; x.send();`);

        expect(rt.run("__argent_network_by_id['rn-net-2']")).toBeUndefined();
        expect(rt.run("__argent_network_by_id['rn-net-3']")).toBeDefined();
      });

      it("keeps a Response served from a cache after an earlier request to its URL ended", async () => {
        const rt = createRuntime({ polyfillFetch: true });
        rt.run(`var inner = fetch; var cache = null;
          fetch = async function(u, init) { ${AWAIT_THEN} if (cache) return cache.clone(); var r = await inner(u, init); cache = r.clone(); return r; };`);
        rt.install();
        const first = rt.run(`fetch('https://api.test/poll')`) as Promise<unknown>;
        await sent(rt, 1);
        rt.last().respond(200, {}, "fresh");
        await first;
        await settle();
        await new Promise((resolve) => setTimeout(resolve, 5));
        await (rt.run(`fetch('https://api.test/poll')`) as Promise<unknown>);
        await settle();

        expect(rt.records().map((r) => `${r.via} ${r.state} ${r.responseBody}`)).toEqual([
          "xhr finished fresh",
          "fetch-native finished fresh",
        ]);
      });

      it.each([
        { resolves: "the Response", resolve: "return r;", body: "shared" },
        { resolves: "parsed JSON", resolve: "return { a: 1 };", body: undefined },
      ])(
        "records a native request a wrapper shares with three callers once, when it resolves $resolves",
        async ({ resolve, body }) => {
          const rt = createRuntime();
          rt.run(`var shared = ${NATIVE_LIKE.replace("'native'", "'shared'")};
          var native = function() { return new Promise(function(done) { setTimeout(function() { done(shared); }, 5); }); };
          var inflight = null;
          fetch = async function(u, init) { ${AWAIT_THEN}
            if (!inflight) inflight = native(u, init).then(function(r) { ${resolve} }).finally(function() { inflight = null; });
            return inflight;
          };`);
          rt.install();
          const values = (await (rt.run(
            `Promise.all([fetch('https://api.test/shared'), fetch('https://api.test/shared'), fetch('https://api.test/shared')])`
          ) as Promise<unknown[]>)) as unknown[];
          await settle();

          expect(values[0]).toBe(values[1]);
          expect(values[1]).toBe(values[2]);
          expect(rt.records()).toHaveLength(1);
          expect(rt.records()[0]).toMatchObject({
            requestId: "rn-net-1",
            via: "fetch-native",
            state: "finished",
          });
          expect(rt.records()[0]!.responseBody).toBe(body);
          expect(rt.run(`Object.keys(__argent_network_by_id)`)).toEqual(["rn-net-1"]);
        }
      );

      it("keeps a record for a Response the wrapper serves again from its cache", async () => {
        const rt = createRuntime();
        rt.run(`var shared = ${NATIVE_LIKE};
          var cached = null;
          fetch = async function(u, init) { ${AWAIT_THEN} if (cached) return cached; cached = shared; return cached; };`);
        rt.install();
        await (rt.run(`fetch('https://api.test/cached')`) as Promise<unknown>);
        await settle();
        await new Promise((resolve) => setTimeout(resolve, 5));
        await (rt.run(`fetch('https://api.test/cached')`) as Promise<unknown>);
        await settle();

        expect(rt.records().map((r) => `${r.via} ${r.state}`)).toEqual([
          "fetch-native finished",
          "fetch-native finished",
        ]);
      });

      it.each([
        {
          resolves: "parsed JSON",
          value: "{ message: 'parsed' }",
          expected: { message: "parsed" },
        },
        { resolves: "undefined", value: "undefined", expected: undefined },
      ])(
        "finishes a native fetch record without a response when the wrapper resolves $resolves",
        async ({ value, expected }) => {
          const rt = createRuntime();
          rt.run(`var native = function() { return Promise.resolve(${NATIVE_LIKE}); };
          fetch = async function(u, init) { ${AWAIT_THEN} await native(u, init); return ${value}; };`);
          rt.install();
          const resolved = await (rt.run(`fetch('https://api.test/json')`) as Promise<unknown>);
          await settle();

          expect(resolved).toEqual(expected);
          expect(rt.records()).toHaveLength(1);
          expect(rt.records()[0]).toMatchObject({ via: "fetch-native", state: "finished" });
          expect(rt.records()[0]!.response).toBeUndefined();
          expect(rt.records()[0]!.durationMs).toBeTypeOf("number");
        }
      );
    });

    describe("when the global fetch is Expo's own", () => {
      // expo/fetch as Expo installs it: marked, and one native request per call.
      function expoRuntime() {
        const rt = createRuntime();
        rt.run(`var calls = [];
          fetch = function(u, init) { return new Promise(function(resolve, reject) { calls.push({ resolve: resolve, reject: reject }); }); };
          Object.defineProperty(fetch, Symbol.for('expo.builtin'), { value: true });`);
        return rt;
      }

      it.each([
        {
          sender: "axios",
          xhr: `x.open('POST', 'https://api.test/graphql'); x.responseType = 'json'; x.onloadend = function() {};`,
        },
        {
          sender: "React Native's fetch",
          xhr: `x.open('GET', 'https://cdn.test/file'); x.responseType = 'blob'; x.onload = x.onerror = x.ontimeout = x.onabort = function() {};`,
        },
      ])("keeps a failed request when $sender fails at the same time", async ({ xhr }) => {
        const rt = expoRuntime();
        rt.install();
        const pending = rt.run(
          `fetch('https://api.test/graphql', { method: 'POST', body: 'q' })`
        ) as Promise<unknown>;
        rt.run(`var x = new XMLHttpRequest(); ${xhr} x.send();`);
        expect(rt.records()).toHaveLength(2);
        rt.last().fail("offline");
        rt.run(`calls[0].reject(new TypeError('Network request failed'))`);
        await pending.catch(() => undefined);
        await settle();

        expect(rt.records().map((r) => `${r.via} ${r.state}`)).toEqual([
          "fetch-native failed",
          "xhr failed",
        ]);
      });
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

describe("NETWORK_INTERCEPTOR_SCRIPT native fetch sizes", () => {
  async function interceptResponse({
    body,
    mimeType,
    byteLength,
    contentLength,
    method = "GET",
    status = 200,
    blobFails = false,
  }: {
    body: string | undefined;
    mimeType: string;
    byteLength?: number;
    contentLength?: number;
    method?: string;
    status?: number;
    blobFails?: boolean;
  }) {
    const response = {
      url: "https://example.test/data",
      status,
      statusText: "OK",
      headers: {
        forEach: (callback: (value: string, key: string) => void) => {
          callback(mimeType, "content-type");
          if (contentLength !== undefined) callback(String(contentLength), "content-length");
        },
      },
      clone: () => ({
        text: async () => body,
        blob: async () => {
          if (blobFails) throw new Error("Blob unavailable");
          return { size: byteLength };
        },
      }),
    };
    const sandbox: Record<string, unknown> = {
      fetch: async () => response,
    };

    runInNewContext(NETWORK_INTERCEPTOR_SCRIPT, sandbox);
    await (sandbox.fetch as (_input: string, init: { method: string }) => Promise<unknown>)(
      response.url,
      { method }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    return (
      sandbox.__argent_network_log as Array<{
        encodedDataLength?: number;
        responseBody?: string;
      }>
    )[0];
  }

  it("records decoded entity bytes instead of JavaScript string length", async () => {
    const body = JSON.stringify({ message: "你好 👋" });
    const byteLength = Buffer.byteLength(body, "utf8");
    const entry = await interceptResponse({ body, byteLength, mimeType: "application/json" });

    expect(entry?.encodedDataLength).toBe(byteLength);
    expect(entry?.encodedDataLength).not.toBe(body.length);
  });

  it("records zero bytes for HEAD even when Content-Length describes a GET body", async () => {
    const entry = await interceptResponse({
      body: "",
      byteLength: 0,
      contentLength: 524_288_000,
      method: "HEAD",
      mimeType: "application/octet-stream",
    });

    expect(entry?.encodedDataLength).toBe(0);
  });

  it("records zero bytes for a 304 cached response", async () => {
    const entry = await interceptResponse({
      body: "",
      byteLength: 0,
      contentLength: 4096,
      mimeType: "application/json",
      status: 304,
    });

    expect(entry?.encodedDataLength).toBe(0);
  });

  it("does not re-encode replacement characters from a non-UTF-8 response", async () => {
    const body = "Caf\uFFFD na\uFFFDve r\uFFFDsum\uFFFD";
    const entry = await interceptResponse({
      body,
      byteLength: 17,
      mimeType: "text/plain; charset=iso-8859-1",
    });

    expect(entry?.encodedDataLength).toBe(17);
    expect(entry?.encodedDataLength).not.toBe(Buffer.byteLength(body, "utf8"));
  });

  it("uses decoded body bytes instead of compressed Content-Length", async () => {
    const entry = await interceptResponse({
      body: "x".repeat(6308),
      byteLength: 6308,
      contentLength: 1510,
      mimeType: "application/json",
    });

    expect(entry?.encodedDataLength).toBe(6308);
  });

  it("records binary bytes when no text body is exposed", async () => {
    const entry = await interceptResponse({
      body: undefined,
      byteLength: 16,
      mimeType: "image/png",
    });

    expect(entry?.encodedDataLength).toBe(16);
    expect(entry?.responseBody).toBeUndefined();
  });

  it("leaves size unknown when Blob conversion is unavailable", async () => {
    const entry = await interceptResponse({
      body: "hello",
      blobFails: true,
      mimeType: "text/plain",
    });

    expect(entry?.encodedDataLength).toBeUndefined();
    expect(entry?.responseBody).toBe("hello");
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
