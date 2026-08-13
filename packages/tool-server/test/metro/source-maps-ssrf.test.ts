import { describe, it, expect, vi, afterEach } from "vitest";
import {
  drainCappedBody,
  isAllowedSourceMapURL,
  SourceMapsRegistry,
} from "../../src/utils/debugger/source-maps";

describe("isAllowedSourceMapURL", () => {
  it("accepts a Metro localhost URL", () => {
    expect(isAllowedSourceMapURL("http://localhost:8081/index.map")).toBe(true);
  });

  it("accepts http://127.0.0.1", () => {
    expect(isAllowedSourceMapURL("http://127.0.0.1:8082/foo.map")).toBe(true);
  });

  it("accepts http://[::1]", () => {
    expect(isAllowedSourceMapURL("http://[::1]:8081/foo.map")).toBe(true);
  });

  it("accepts https on loopback", () => {
    expect(isAllowedSourceMapURL("https://localhost:8443/foo.map")).toBe(true);
  });

  it("rejects an attacker-controlled public host", () => {
    expect(isAllowedSourceMapURL("http://attacker.example/leak")).toBe(false);
  });

  it("rejects the AWS metadata endpoint", () => {
    expect(isAllowedSourceMapURL("http://169.254.169.254/latest/meta-data/")).toBe(false);
  });

  it("rejects a private-network host that is not loopback", () => {
    expect(isAllowedSourceMapURL("http://10.0.0.1/secret.map")).toBe(false);
    expect(isAllowedSourceMapURL("http://192.168.1.1/secret.map")).toBe(false);
  });

  it("rejects file:// URLs", () => {
    expect(isAllowedSourceMapURL("file:///etc/passwd")).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isAllowedSourceMapURL("not a url")).toBe(false);
    expect(isAllowedSourceMapURL("")).toBe(false);
  });

  it("rejects an unbracketed IPv6 typo", () => {
    expect(isAllowedSourceMapURL("http://::1:8081/")).toBe(false);
  });

  // PR #194 follow-up G: require a `.map` path so an attacker-set
  // sourceMapURL can't make us GET an arbitrary loopback endpoint.
  it("rejects a loopback URL whose path is not *.map", () => {
    expect(isAllowedSourceMapURL("http://127.0.0.1:8081/json")).toBe(false);
    expect(isAllowedSourceMapURL("http://localhost:8081/shutdown")).toBe(false);
    expect(isAllowedSourceMapURL("http://localhost:8081/")).toBe(false);
  });

  it("still accepts a loopback *.map path (incl. with a query string)", () => {
    expect(isAllowedSourceMapURL("http://localhost:8081/index.bundle.map")).toBe(true);
    expect(isAllowedSourceMapURL("http://127.0.0.1:8081/index.bundle.map?platform=ios")).toBe(true);
  });
});

// PR #194 follow-up F: source-map bodies are read under a cap.
describe("drainCappedBody (body cap)", () => {
  it("rejects when content-length exceeds the cap", async () => {
    const res = {
      headers: { get: (n: string) => (n === "content-length" ? "999999999" : null) },
      body: null,
    };
    await expect(drainCappedBody(res, 1024)).rejects.toThrow(/too large/);
  });

  it("returns without reading when no stream body is available", async () => {
    const res = { headers: { get: () => null }, body: null };
    await expect(drainCappedBody(res, 1024)).resolves.toBeUndefined();
  });

  it("aborts a streamed body that exceeds the cap", async () => {
    const big = new Uint8Array(2048);
    let sent = false;
    const cancel = vi.fn(async () => {});
    const res = {
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () =>
            sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: big }),
          cancel,
        }),
      },
    };
    await expect(drainCappedBody(res, 1024)).rejects.toThrow(/exceeded/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  // The whole point of the rewrite: the bytes are counted, never accumulated
  // and never parsed. A body that is not JSON at all must still drain clean,
  // which is what tells a reader the parse is gone rather than just moved.
  it("drains a body that is not JSON, under the cap", async () => {
    const chunks = [new Uint8Array(400), new Uint8Array(400)];
    let i = 0;
    const res = {
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length
              ? { done: false, value: chunks[i++] }
              : { done: true, value: undefined },
          cancel: async () => {},
        }),
      },
    };
    await expect(drainCappedBody(res, 1024)).resolves.toBeUndefined();
    expect(i).toBe(chunks.length);
  });
});

// The tests above prove `isAllowedSourceMapURL` classifies correctly, but not
// that the fetch path asks it. Delete the guard from `doRegister` and every one
// of them still passes, so nothing pinned the call itself. These two do: the
// first fails if the guard goes, the second fails if it ever rejects the URLs
// Metro really emits.
describe("doRegister consults the allowlist", () => {
  afterEach(() => vi.restoreAllMocks());

  function stubFetch() {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version: 3, sources: [], mappings: "" }), {
        headers: { "content-type": "application/json" },
      })
    );
  }

  it("never fetches a sourceMapURL the allowlist rejects", async () => {
    const fetchSpy = stubFetch();
    const reg = new SourceMapsRegistry();
    for (const url of [
      "http://127.0.0.2:8081/evil.map", // loopback range, but not an allowed host
      "http://169.254.169.254/latest.map", // cloud metadata, named in this file's header
      "http://attacker.example/leak.map",
      "http://localhost:8081/shutdown", // loopback, but not a *.map path
    ]) {
      reg.registerFromScriptParsed("http://localhost:8081/index.bundle", "1", url);
    }
    await reg.waitForPending();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // `sourceMapURL` is a bare cast over socket JSON — cdp-client reads
  // `params.sourceMapURL as string | undefined` off a Debugger.scriptParsed
  // frame and js-runtime-debugger forwards it unchecked, so a CDP peer can put
  // a number there. Everything doRegister does with it must therefore sit
  // inside the try. Hoisting the `data:` test out of it (866d90ce) let the
  // TypeError escape as a rejected promise nothing awaits before the next
  // tick, which index.ts turns into crashShutdown.
  //
  // The tick matters: waitForPending() attaches allSettled synchronously, so
  // calling it straight after register hides the bug. Production has a real
  // gap — scriptParsed fires during CDP message handling, the wait comes much
  // later — which the timeout below reproduces.
  it("skips a non-string sourceMapURL instead of rejecting out of doRegister", async () => {
    const fetchSpy = stubFetch();
    const reg = new SourceMapsRegistry();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      reg.registerFromScriptParsed(
        "http://localhost:8081/index.bundle",
        "1",
        12345 as unknown as string
      );
      await new Promise((r) => setTimeout(r, 10));
      await reg.waitForPending();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still fetches the loopback *.map URL Metro emits", async () => {
    const fetchSpy = stubFetch();
    const reg = new SourceMapsRegistry();
    reg.registerFromScriptParsed(
      "http://localhost:8081/index.bundle",
      "1",
      "http://localhost:8081/index.bundle.map"
    );
    await reg.waitForPending();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("http://localhost:8081/index.bundle.map");
  });
});
