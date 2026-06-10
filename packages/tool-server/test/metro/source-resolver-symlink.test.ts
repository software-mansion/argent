import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSourceResolver } from "../../src/utils/debugger/source-resolver";

// Repro for PR #194 review Issues 4 & 5:
//  4. isInsideProject() is purely lexical (path.resolve/path.relative, no
//     fs.realpath) but fs.readFile follows symlinks, so a .js symlink INSIDE
//     projectRoot pointing OUTSIDE is read -> arbitrary file read.
//  5. ".json" is in the extension allowlist, so an attacker-controlled
//     location.file can read any in-project .json (service-account keys,
//     firebase-adminsdk.json, eas.json with secrets, ...).

describe("source-resolver containment (PR #194 Issues 4 & 5)", () => {
  let root: string;
  let outsideSecret: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pr194-proj-"));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr194-out-"));
    outsideSecret = path.join(outDir, "outside-secret.txt");
    fs.writeFileSync(outsideSecret, "OUTSIDE_SECRET_PR194\n");
    fs.writeFileSync(path.join(root, "real.js"), "const REAL = 'OK_PR194';\n");
    fs.writeFileSync(
      path.join(root, "secrets.json"),
      JSON.stringify({ private_key: "FAKE_SA_KEY_PR194" }) + "\n"
    );
    // symlink inside projectRoot -> outside file, with an allowed extension
    fs.symlinkSync(outsideSecret, path.join(root, "evil.js"));
    fs.symlinkSync("/etc/passwd", path.join(root, "passwd.js"));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.dirname(outsideSecret), { recursive: true, force: true });
  });

  it("control: a real in-project .js source is readable", async () => {
    const r = createSourceResolver(8081, root);
    const out = await r.readSourceFragment({ file: "real.js", line: 1, column: 0 });
    expect(out).toContain("OK_PR194");
  });

  it("Issue 4: must NOT read an outside file via an in-project .js symlink", async () => {
    const r = createSourceResolver(8081, root);
    const out = await r.readSourceFragment({ file: "evil.js", line: 1, column: 0 });
    expect(out).toBeNull();
  });

  it("Issue 4: must NOT read /etc/passwd via an in-project .js symlink", async () => {
    const r = createSourceResolver(8081, root);
    const out = await r.readSourceFragment({ file: "passwd.js", line: 1, column: 0 });
    expect(out).toBeNull();
  });

  it("Issue 5: must NOT read an in-project secrets .json", async () => {
    const r = createSourceResolver(8081, root);
    const out = await r.readSourceFragment({ file: "secrets.json", line: 1, column: 0 });
    expect(out).toBeNull();
  });
});
