import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSourceResolver } from "../../src/utils/debugger/source-resolver";

// discoverMetro no longer hard-fails when Metro omits X-React-Native-Project-Root
// (RN 0.72 / Vega never sends it), so `projectRoot` can now legitimately be "".
// Every source-resolution path must cope with that:
//
//  - readSourceFragment must fail closed. fs.realpath("") does NOT throw, it
//    resolves to the tool-server's cwd — so without an explicit guard the
//    containment check is performed against the tool-server's own working
//    directory and happily reads source files out of it.
//  - symbolicate must not corrupt the path. `file.replace(projectRoot + "/", "")`
//    degrades to `.replace("/", "")` on an empty root, which strips the first
//    slash *anywhere* in the string.

describe("source-resolver with no project root (RN 0.72 / Vega Metro)", () => {
  let fakeCwd: string;
  let originalCwd: string;

  beforeAll(() => {
    originalCwd = process.cwd();
    fakeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolserver-cwd-"));
    fs.writeFileSync(path.join(fakeCwd, "not-the-app.js"), "const SECRET = 'TOOL_SERVER_CWD';\n");
    // Stand in for the tool-server's working directory.
    process.chdir(fakeCwd);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    fs.rmSync(fakeCwd, { recursive: true, force: true });
  });

  it("readSourceFragment must not read files out of the tool-server cwd", async () => {
    const r = createSourceResolver(8081, "");
    const out = await r.readSourceFragment({ file: "not-the-app.js", line: 1, column: 0 });
    expect(out).toBeNull();
  });

  it("readSourceFragment must not read an absolute path under the tool-server cwd", async () => {
    const r = createSourceResolver(8081, "");
    const out = await r.readSourceFragment({
      file: path.join(fakeCwd, "not-the-app.js"),
      line: 1,
      column: 0,
    });
    expect(out).toBeNull();
  });

  it("symbolicate must not strip an interior slash from a relative path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ stack: [{ file: "src/screens/Home.tsx", lineNumber: 12, column: 3 }] })
      )
    );
    const r = createSourceResolver(8081, "");
    const loc = await r.symbolicate("http://localhost:8081/index.bundle", 1, 1);
    expect(loc?.file).toBe("src/screens/Home.tsx");
    vi.unstubAllGlobals();
  });

  it("symbolicate must not mangle an absolute path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          stack: [{ file: "/Users/me/app/src/App.tsx", lineNumber: 12, column: 3 }],
        })
      )
    );
    const r = createSourceResolver(8081, "");
    const loc = await r.symbolicate("http://localhost:8081/index.bundle", 1, 1);
    expect(loc?.file).toBe("/Users/me/app/src/App.tsx");
    vi.unstubAllGlobals();
  });

  it("still resolves normally when Metro does report a project root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "real-app-"));
    fs.writeFileSync(path.join(root, "App.js"), "const OK = 'IN_PROJECT';\n");
    const r = createSourceResolver(8081, root);
    const out = await r.readSourceFragment({ file: "App.js", line: 1, column: 0 });
    expect(out).toContain("IN_PROJECT");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
