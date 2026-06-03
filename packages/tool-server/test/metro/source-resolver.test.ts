import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseDebugStack,
  normalizeBundleUrl,
  createSourceResolver,
} from "../../src/utils/debugger/source-resolver";

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
