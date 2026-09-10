import { runInNewContext } from "node:vm";
import { describe, it, expect } from "vitest";
import {
  NETWORK_INTERCEPTOR_SCRIPT,
  makeNetworkLogReadScript,
  makeNetworkDetailReadScript,
} from "../../src/utils/debugger/scripts/network-interceptor";

describe("NETWORK_INTERCEPTOR_SCRIPT", () => {
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
