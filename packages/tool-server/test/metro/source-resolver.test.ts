import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseDebugStack,
  normalizeBundleUrl,
  createSourceResolver,
} from "../../src/utils/debugger/source-resolver";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function symbolicateResponse(frame: { file?: string; lineNumber?: number; column?: number }) {
  return new Response(JSON.stringify({ stack: [frame] }), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("parseDebugStack", () => {
  it("parses stack frames correctly", () => {
    const stack = `Error: react-stack-top-frame
    at anonymous  (http://localhost:8081/index.bundle?platform=ios&dev=true:100:20)
    at App (http://localhost:8081/index.bundle?platform=ios&dev=true:200:10)
    at react_stack_bottom_frame (native)`;

    const frames = parseDebugStack(stack);
    expect(frames).toHaveLength(3);
    expect(frames[0].fn).toBe("anonymous");
    expect(frames[0].line).toBe(100);
    expect(frames[0].col).toBe(20);

    expect(frames[1].fn).toBe("App");
    expect(frames[1].line).toBe(200);
    expect(frames[1].col).toBe(10);
  });

  it("returns frame[1] as the JSX call-site", () => {
    const stack = `Error: react-stack-top-frame
    at anonymous (http://localhost:8081/index.bundle:50:5)
    at ParentComponent (http://localhost:8081/index.bundle:120:8)`;

    const frames = parseDebugStack(stack);
    expect(frames[1].fn).toBe("ParentComponent");
    expect(frames[1].line).toBe(120);
  });
});

describe("normalizeBundleUrl", () => {
  it("normalizes iOS //& to ?", () => {
    const url = "http://localhost:8081/index.bundle//&platform=ios&dev=true";
    const result = normalizeBundleUrl(url, 8081);
    expect(result).toContain("?platform=ios");
    expect(result).not.toContain("//&");
  });

  it("rewrites Android host to localhost", () => {
    const url = "http://10.0.2.2:8081/index.bundle?platform=android&dev=true";
    const result = normalizeBundleUrl(url, 8081);
    expect(result).toContain("localhost");
    expect(result).not.toContain("10.0.2.2");
  });

  it("rewrites port to the Metro port", () => {
    const url = "http://localhost:9999/index.bundle?platform=ios";
    const result = normalizeBundleUrl(url, 8081);
    expect(result).toContain(":8081");
    expect(result).not.toContain("9999");
  });
});

describe("readSourceFragment containment + extension allowlist", () => {
  let tmpRoot: string;
  let resolver: ReturnType<typeof createSourceResolver>;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "argent-source-resolver-"));
    await fs.writeFile(
      path.join(tmpRoot, "App.tsx"),
      "line1\nline2\nline3\nline4\nline5\n",
      "utf8"
    );
    await fs.writeFile(path.join(tmpRoot, "secret.env"), "API_KEY=hunter2\n", "utf8");
    // Sibling file outside tmpRoot — used for path-traversal probes.
    await fs.writeFile(path.join(tmpRoot, "..", "outside-secret.txt"), "off-limits\n", "utf8");
    resolver = createSourceResolver(8081, tmpRoot);
  });

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.rm(path.join(tmpRoot, "..", "outside-secret.txt"), { force: true });
  });

  it("reads a source file inside the project root", async () => {
    const out = await resolver.readSourceFragment({ file: "App.tsx", line: 3, column: 0 }, 1);
    expect(out).toContain("line3");
  });

  it("rejects an absolute path to a system file (~/.zshrc-style attack)", async () => {
    const out = await resolver.readSourceFragment({ file: "/etc/hosts", line: 1, column: 0 }, 1);
    expect(out).toBeNull();
  });

  it("rejects a relative path that escapes projectRoot via `..`", async () => {
    const out = await resolver.readSourceFragment(
      { file: "../outside-secret.txt", line: 1, column: 0 },
      1
    );
    expect(out).toBeNull();
  });

  it("rejects an in-project file with a non-source extension (.env)", async () => {
    const out = await resolver.readSourceFragment({ file: "secret.env", line: 1, column: 0 }, 1);
    expect(out).toBeNull();
  });

  it("returns null for missing files instead of throwing", async () => {
    const out = await resolver.readSourceFragment(
      { file: "does-not-exist.tsx", line: 1, column: 0 },
      1
    );
    expect(out).toBeNull();
  });
});

describe("createSourceResolver — symbolicate", () => {
  const projectRoot = "/Users/dev/myapp";
  const bundleUrl = "http://localhost:8081/index.bundle?platform=ios&dev=true";

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("keeps genuinely-mapped node_modules sources", async () => {
    // A route component (expo-router / react-navigation) legitimately resolves
    // into node_modules. Metro returns a real file path — it must be kept.
    mockFetch.mockResolvedValueOnce(
      symbolicateResponse({
        file: `${projectRoot}/node_modules/expo-router/build/views/Navigator.js`,
        lineNumber: 42,
        column: 7,
      })
    );

    const resolver = createSourceResolver(8081, projectRoot);
    const result = await resolver.symbolicate(bundleUrl, 100, 20, "Navigator");

    expect(result).toEqual({
      file: "node_modules/expo-router/build/views/Navigator.js",
      line: 42,
      column: 7,
    });
  });

  it("rejects unmapped bundle URLs echoed back by Metro", async () => {
    // A failed symbolication echoes the bundle URL back unchanged.
    mockFetch.mockResolvedValueOnce(
      symbolicateResponse({ file: bundleUrl, lineNumber: 100, column: 20 })
    );

    const resolver = createSourceResolver(8081, projectRoot);
    const result = await resolver.symbolicate(bundleUrl, 100, 20, "App");

    expect(result).toBeNull();
  });

  it("maps real app source paths relative to the project root", async () => {
    mockFetch.mockResolvedValueOnce(
      symbolicateResponse({
        file: `${projectRoot}/app/index.tsx`,
        lineNumber: 12,
        column: 4,
      })
    );

    const resolver = createSourceResolver(8081, projectRoot);
    const result = await resolver.symbolicate(bundleUrl, 100, 20, "Index");

    expect(result).toEqual({ file: "app/index.tsx", line: 12, column: 4 });
  });

  it("returns null when the symbolicate request throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    const resolver = createSourceResolver(8081, projectRoot);
    const result = await resolver.symbolicate(bundleUrl, 100, 20, "App");

    expect(result).toBeNull();
  });
});
