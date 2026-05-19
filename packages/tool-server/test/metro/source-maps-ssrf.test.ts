import { describe, it, expect } from "vitest";
import { isAllowedSourceMapURL, readCappedJson } from "../../src/utils/debugger/source-maps";

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

// PR #194 follow-up F: source-map bodies are capped before JSON.parse.
describe("readCappedJson (body cap)", () => {
  it("rejects when content-length exceeds the cap", async () => {
    const res = {
      headers: { get: (n: string) => (n === "content-length" ? "999999999" : null) },
      body: null,
      json: async () => ({ should: "not reach" }),
    };
    await expect(readCappedJson(res, 1024)).rejects.toThrow(/too large/);
  });

  it("falls back to .json() when no stream body is available", async () => {
    const res = {
      headers: { get: () => null },
      body: null,
      json: async () => ({ ok: 1 }),
    };
    expect(await readCappedJson(res, 1024)).toEqual({ ok: 1 });
  });

  it("aborts a streamed body that exceeds the cap", async () => {
    const big = new Uint8Array(2048);
    let sent = false;
    const res = {
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () =>
            sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: big }),
          cancel: async () => {},
        }),
      },
      json: async () => ({ should: "not reach" }),
    };
    await expect(readCappedJson(res, 1024)).rejects.toThrow(/exceeded/);
  });
});
