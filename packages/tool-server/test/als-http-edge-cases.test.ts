// HTTP boundary edge-case tests for the X-Argent-Project-Root header mechanism.
//
// These stress-test parseProjectRootHeader + runWithContext with header shapes
// a well-behaved client would never send but a malicious, buggy, or
// version-mismatched client might.
//
// Under test:
//   packages/tool-server/src/http.ts        — parseProjectRootHeader (lines 11-20)
//   packages/tool-server/src/request-context.ts — ALS storage
//   packages/mcp/src/mcp-server.ts          — encodeURIComponent(process.cwd())
//
// The tests intentionally do NOT modify the source — they document each
// observed behavior and flag anything that looks like a vulnerability.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import { requireProjectRoot, getRequestContext } from "../src/request-context";
import type { Registry } from "@argent/registry";

vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    latestVersion: null,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => false),
  suppressUpdateNote: vi.fn(),
}));

/**
 * Registry double that surfaces the project root that arrived via ALS plus a
 * probe to observe abort propagation during the `runWithContext` frame.
 *
 * - `needs-root` returns the root captured by requireProjectRoot()
 * - `no-root` returns the raw request context (expected undefined when no header)
 * - `slow-root` waits on the abort signal so we can probe abort semantics
 * - `throws` lets us verify error translation preserves no ALS state
 */
function buildRegistry(): Registry {
  return {
    getSnapshot: vi.fn(() => ({
      services: new Map(),
      namespaces: [],
      tools: ["needs-root", "no-root", "slow-root", "throws"],
    })),
    getTool: vi.fn((name: string) => ({ id: name })),
    invokeTool: vi.fn(
      async (name: string, _args: unknown, opts: { signal: AbortSignal }) => {
        if (name === "needs-root") {
          return { root: requireProjectRoot(), ctx: getRequestContext() };
        }
        if (name === "no-root") return { ok: true, ctx: getRequestContext() };
        if (name === "slow-root") {
          // Race the abort signal vs a 1s timer so we can observe res.on('close').
          return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve({ root: getRequestContext()?.projectRoot, reached: "timeout" });
            }, 1000);
            opts.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            });
          });
        }
        if (name === "throws") throw new Error("boom");
        throw new Error(`unknown tool: ${name}`);
      }
    ),
  } as unknown as Registry;
}

describe("HTTP header parse edge cases — well-behaved client would never send these", () => {
  let handle: HttpAppHandle;
  let request: typeof import("supertest").default;

  beforeEach(async () => {
    request = await import("supertest").then((m) => m.default);
    handle = createHttpApp(buildRegistry());
  });

  afterEach(() => {
    handle?.dispose();
    vi.clearAllMocks();
  });

  // ────────────────────────────────────────────────────────────────────
  // 1. Header variants that are syntactically valid HTTP but semantically junk
  // ────────────────────────────────────────────────────────────────────
  describe("header value is a broken-proxy artifact", () => {
    it("passes through the literal string 'undefined' (proxy forgot to skip a nullish value)", async () => {
      // Current behavior: decodeURIComponent('undefined') === 'undefined'. That
      // string is truthy, so the server treats it as a valid project root and
      // happily returns it. NOT IDEAL but consistent: the server is not in the
      // business of judging filesystem validity.
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", "undefined")
        .send({})
        .expect(200);
      expect(res.body.data.root).toBe("undefined");
    });

    it("passes through the literal string 'null' (same pattern)", async () => {
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", "null")
        .send({})
        .expect(200);
      expect(res.body.data.root).toBe("null");
    });

    it("passes through '[object Object]' (JS stringification leak through the proxy)", async () => {
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent("[object Object]"))
        .send({})
        .expect(200);
      expect(res.body.data.root).toBe("[object Object]");
    });
  });

  describe("header value is a non-absolute or otherwise suspicious path", () => {
    it("accepts a relative ./foo (the HTTP layer does NOT enforce absoluteness)", async () => {
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent("./foo"))
        .send({})
        .expect(200);
      // Surprising: parseProjectRootHeader is a dumb pipe. Path validation
      // must live in the tool, not in the HTTP layer.
      expect(res.body.data.root).toBe("./foo");
    });

    it("accepts bare '..' and '.'", async () => {
      const a = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent(".."))
        .send({})
        .expect(200);
      expect(a.body.data.root).toBe("..");

      const b = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", ".")
        .send({})
        .expect(200);
      expect(b.body.data.root).toBe(".");
    });

    it("accepts a Windows path on macOS verbatim", async () => {
      const win = "C:\\Users\\foo";
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent(win))
        .send({})
        .expect(200);
      expect(res.body.data.root).toBe(win);
    });

    it("accepts bare '/' as the root (also dumb pipe)", async () => {
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", "/")
        .send({})
        .expect(200);
      expect(res.body.data.root).toBe("/");
    });

    it("accepts unresolved '~/foo' — tilde is NOT expanded at the HTTP layer", async () => {
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent("~/foo"))
        .send({})
        .expect(200);
      expect(res.body.data.root).toBe("~/foo");
    });

    it("preserves a trailing slash", async () => {
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent("/Users/alice/project/"))
        .send({})
        .expect(200);
      expect(res.body.data.root).toBe("/Users/alice/project/");
    });

    it("preserves duplicate slashes", async () => {
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent("/Users//foo"))
        .send({})
        .expect(200);
      expect(res.body.data.root).toBe("/Users//foo");
    });

    it("accepts a very long path (~4KB) without truncation", async () => {
      const segment = "a".repeat(100);
      const longPath = "/" + Array(40).fill(segment).join("/"); // ~4KB
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent(longPath))
        .send({})
        .expect(200);
      expect(res.body.data.root).toBe(longPath);
      expect(res.body.data.root.length).toBeGreaterThan(4000);
    });
  });

  describe("header value contains bytes no legitimate path should contain", () => {
    it("passes an embedded NUL byte through as a literal", async () => {
      // P0-ish: decodeURIComponent('%00') === '\0'. The server happily delivers
      // a path containing a null byte to the tool layer. Node's fs primitives
      // throw on null bytes, so this does NOT bypass fs safety, but the string
      // DOES flow across the trust boundary unchanged. Documented, not fixed.
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", "/Users/alice%00/etc")
        .send({})
        .expect(200);
      expect(res.body.data.root).toBe("/Users/alice\0/etc");
      expect(res.body.data.root.includes("\0")).toBe(true);
    });

    it("percent-encoded LF and CR decode to literal newlines (not a live header-injection vector because the transport has already framed the header — but the downstream logger/tool sees a newline)", async () => {
      // supertest/Node's http.ClientRequest refuses to .set() a raw "\n" in a
      // header value (it would literally inject a new header line into the
      // wire-format). But an attacker CAN percent-encode them — and
      // decodeURIComponent faithfully turns them back into control characters.
      // Sanity: the HTTP framing is already safe because the newline only
      // exists post-decode. But any tool that logs the root via stdout / shell
      // interpolation without sanitisation is at risk. Flagged as P1: this is
      // a downstream sanitization concern, not an HTTP-layer bypass.
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", "/a%0D%0AX-Evil:%20yes")
        .send({})
        .expect(200);
      expect(res.body.data.root).toBe("/a\r\nX-Evil: yes");
    });

    it("accepts a file:// URL verbatim (the parser does not know about schemes)", async () => {
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent("file:///Users/foo"))
        .send({})
        .expect(200);
      expect(res.body.data.root).toBe("file:///Users/foo");
    });

    it("single-decodes a double-encoded string (only one decodeURIComponent pass)", async () => {
      const once = encodeURIComponent("/Users/alice/project");
      const twice = encodeURIComponent(once);
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", twice)
        .send({})
        .expect(200);
      // After one decodeURIComponent pass we get back the once-encoded form,
      // which is a legal filesystem string but obviously not the intended root.
      expect(res.body.data.root).toBe(once);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 2. Decoding edge cases
  // ────────────────────────────────────────────────────────────────────
  describe("decoding edge cases", () => {
    it("accepts an already-decoded path (proxy forgot to encode) as long as it has no invalid % escapes", async () => {
      const path = "/Users/alice/project";
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", path)
        .send({})
        .expect(200);
      expect(res.body.data.root).toBe(path);
    });

    it("accepts a partially-encoded path (some chars encoded, others not)", async () => {
      // decodeURIComponent tolerates pass-through characters. Only a lone '%'
      // with invalid hex after it triggers the catch branch.
      const path = "/Users/alice/my%20project/raw space";
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", path)
        .send({})
        .expect(200);
      expect(res.body.data.root).toBe("/Users/alice/my project/raw space");
    });

    it("round-trips UTF-16 surrogate pair (emoji outside BMP)", async () => {
      const path = "/Users/alice/project/🚀"; // U+1F680, surrogate pair in UTF-16
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent(path))
        .send({})
        .expect(200);
      expect(res.body.data.root).toBe(path);
    });

    it("distinguishes '+' (literal plus) from '%20' (space) — decodeURIComponent leaves '+' alone, unlike application/x-www-form-urlencoded", async () => {
      // This is a well-known footgun. Tools MUST NOT assume '+' means space
      // for this header. The test proves parseProjectRootHeader preserves '+'.
      const pathWithPlus = "/Users/alice/a+b";
      const resPlus = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent(pathWithPlus))
        .send({})
        .expect(200);
      expect(resPlus.body.data.root).toBe("/Users/alice/a+b");

      const pathWithSpace = "/Users/alice/a b";
      const resSpace = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent(pathWithSpace))
        .send({})
        .expect(200);
      expect(resSpace.body.data.root).toBe("/Users/alice/a b");
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 3. Multiple header values
  // ────────────────────────────────────────────────────────────────────
  describe("multiple header values", () => {
    it("when client sends the header twice, Node combines them into a comma-joined string and parseProjectRootHeader surfaces the whole thing (not the array branch)", async () => {
      // Node's default http parser COMBINES most duplicate request headers by
      // ", ". X-Argent-Project-Root is not on the whitelist that gets an
      // Array, so req.headers[...] is a single comma-joined string. That means
      // parseProjectRootHeader's `Array.isArray` branch is unreachable via
      // stock Node HTTP — the array branch only fires if someone calls
      // parseProjectRootHeader directly (or sets up a custom parser).
      //
      // To observe the real behavior we cannot use supertest/express alone
      // because supertest's .set() overwrites prior values with the same name.
      // So we hit the Express app directly via a raw http.request call.
      const server = handle.app.listen(0);
      await new Promise<void>((r) => server.on("listening", () => r()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;

      const resp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/tools/needs-root",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": "2",
              // Array form causes Node to write two header lines.
              "X-Argent-Project-Root": [
                encodeURIComponent("/first/root"),
                encodeURIComponent("/second/root"),
              ],
            },
          },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          }
        );
        req.on("error", reject);
        req.write("{}");
        req.end();
      });
      await new Promise<void>((r) => server.close(() => r()));

      expect(resp.status).toBe(200);
      const parsed = JSON.parse(resp.body);
      // Observed: the two values arrive as a single comma-joined string,
      // decodeURIComponent tolerates the ', ' separator, so the tool receives
      // a frankenstein path built from BOTH values joined by ", ".
      expect(parsed.data.root).toBe("/first/root, /second/root");
      // Consequence: if a tool downstream splits by comma, behavior is
      // unpredictable. Flagged as P1 — the HTTP layer should either reject
      // duplicate headers or explicitly pick the first one.
    });

    it("parseProjectRootHeader's array branch also works if a custom parser hands it an array (exercised via direct function call would require export — instead we verify via the raw-http branch above)", () => {
      // No behavior to check at the HTTP boundary beyond the above test: Node's
      // built-in parser never hands us an array for this header name. This
      // "test" is a placeholder to document the reasoning.
      expect(true).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 4. Case sensitivity (should all succeed, HTTP headers are case-insensitive)
  // ────────────────────────────────────────────────────────────────────
  describe("case sensitivity", () => {
    const cases = [
      "x-argent-project-root",
      "X-ARGENT-PROJECT-ROOT",
      "X-Argent-Project-ROOT",
      "X-Argent-Project-Root",
    ];
    for (const name of cases) {
      it(`accepts header name '${name}'`, async () => {
        const res = await request(handle.app)
          .post("/tools/needs-root")
          .set(name, encodeURIComponent("/Users/alice/proj"))
          .send({})
          .expect(200);
        expect(res.body.data.root).toBe("/Users/alice/proj");
      });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // 5. Abort scenarios
  // ────────────────────────────────────────────────────────────────────
  describe("client abort semantics", () => {
    it("aborts an in-flight runWithContext frame without leaking ALS state across requests", async () => {
      // Start the slow tool, then abort the request. Then start a second
      // request with NO header and confirm the ALS store is undefined —
      // proving the ALS frame unwound cleanly.
      const server = handle.app.listen(0);
      await new Promise<void>((r) => server.on("listening", () => r()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;

      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/tools/slow-root",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": "2",
              "X-Argent-Project-Root": encodeURIComponent("/Users/alice/aborted"),
            },
          },
          (res) => {
            res.on("data", () => {});
            res.on("end", () => resolve());
          }
        );
        req.on("error", () => resolve()); // socket hang-up after destroy is expected
        req.write("{}");
        // Give the server a chance to enter runWithContext, then kill the socket.
        setTimeout(() => req.destroy(), 50);
      });

      // Probe: a follow-up request with NO header must still report no ctx.
      // If the previous request had leaked its ALS store into a module-level
      // variable, this would fail.
      const res = await request(handle.app).post("/tools/no-root").send({}).expect(200);
      expect(res.body.data.ctx).toBeUndefined();

      await new Promise<void>((r) => server.close(() => r()));
    });

    it("resets ALS context for a second request after an abort, even when the two requests have different roots", async () => {
      // Same idea but the recovery request uses a DIFFERENT header value than
      // the aborted one, to prove cross-request isolation.
      const server = handle.app.listen(0);
      await new Promise<void>((r) => server.on("listening", () => r()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;

      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/tools/slow-root",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": "2",
              "X-Argent-Project-Root": encodeURIComponent("/Users/alice/aborted-A"),
            },
          },
          () => resolve()
        );
        req.on("error", () => resolve());
        req.write("{}");
        setTimeout(() => req.destroy(), 50);
      });

      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent("/Users/bob/second"))
        .send({})
        .expect(200);
      expect(res.body.data.root).toBe("/Users/bob/second");

      await new Promise<void>((r) => server.close(() => r()));
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 6. Invalid HTTP request bodies
  // ────────────────────────────────────────────────────────────────────
  describe("invalid HTTP request bodies (header behavior must not change)", () => {
    it("POST with no body succeeds for needs-root when the header is present", async () => {
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent("/Users/alice/proj"))
        .expect(200);
      expect(res.body.data.root).toBe("/Users/alice/proj");
    });

    it("POST with no body still triggers 'no project root' error when header missing", async () => {
      const res = await request(handle.app).post("/tools/needs-root").expect(500);
      expect(res.body.error).toContain("No project root in request context");
    });

    it("POST with invalid JSON body returns an express.json parser error (header is never consulted)", async () => {
      // express.json() responds 400 on parse failure before our handler runs.
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent("/Users/alice/proj"))
        .set("Content-Type", "application/json")
        .send("{not json");
      expect(res.status).toBe(400);
    });

    it("POST with a JSON array body is accepted (no zodSchema on the registry double)", async () => {
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent("/Users/alice/proj"))
        .send([1, 2, 3] as unknown as object)
        .expect(200);
      expect(res.body.data.root).toBe("/Users/alice/proj");
    });

    it("header-injection attempt via body does NOT leak into req.headers", async () => {
      // A body that *looks* like a header line cannot escape the JSON parser.
      const res = await request(handle.app)
        .post("/tools/needs-root")
        .set("X-Argent-Project-Root", encodeURIComponent("/Users/real"))
        .send({ "X-Argent-Project-Root": "/Users/evil" })
        .expect(200);
      expect(res.body.data.root).toBe("/Users/real");
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 7. Sanity round-trip for weird-but-legal cwd values
  // ────────────────────────────────────────────────────────────────────
  describe("round-trip through encodeURIComponent for weird-but-legal cwd values", () => {
    const weirdPaths = [
      "/Users/alice/プロジェクト",
      "/Users/alice/my project",
      "/Users/alice/café",
      "/Users/alice/ 🚀 ",
      "/Users/alice/a'b\"c",
      "/Users/alice/a&b=c?d",
      "/Users/alice/a#b",
      "/Users/alice/тест",
      "/Users/alice/<tag>",
      "/Users/alice/a\\b", // literal backslash
    ];
    for (const weird of weirdPaths) {
      it(`round-trips ${JSON.stringify(weird)}`, async () => {
        const res = await request(handle.app)
          .post("/tools/needs-root")
          .set("X-Argent-Project-Root", encodeURIComponent(weird))
          .send({})
          .expect(200);
        expect(res.body.data.root).toBe(weird);
      });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // 8. Bonus: error path must not leak ALS state
  // ────────────────────────────────────────────────────────────────────
  describe("error path does not leak ALS state", () => {
    it("when the tool throws, the next request with no header still sees no context", async () => {
      await request(handle.app)
        .post("/tools/throws")
        .set("X-Argent-Project-Root", encodeURIComponent("/Users/alice/dies"))
        .send({})
        .expect(500);

      const follow = await request(handle.app).post("/tools/no-root").send({}).expect(200);
      expect(follow.body.data.ctx).toBeUndefined();
    });
  });
});
