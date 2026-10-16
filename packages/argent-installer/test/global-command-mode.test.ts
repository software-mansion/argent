import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveGlobalCommandMode } from "../src/mcp-configs.js";

// A real `which argent` against a fake npm prefix put first on PATH: the entry
// a global-scope config gets (#1287) must name paths that outlive the shell.

let prefix: string;
let cli: string;

beforeEach(() => {
  prefix = fs.mkdtempSync(path.join(os.tmpdir(), "argent-global-mode-"));
  const pkg = path.join(prefix, "lib", "node_modules", "@swmansion", "argent");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "@swmansion/argent", bin: { argent: "dist/cli.js" } })
  );
  cli = fs.realpathSync(path.join(pkg, "dist")) + path.sep + "cli.js";
  fs.writeFileSync(cli, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.mkdirSync(path.join(prefix, "bin"));
  fs.symlinkSync(
    "../lib/node_modules/@swmansion/argent/dist/cli.js",
    path.join(prefix, "bin", "argent")
  );
  vi.stubEnv("PATH", `${path.join(prefix, "bin")}${path.delimiter}${process.env.PATH}`);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(prefix, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("resolveGlobalCommandMode", () => {
  it("falls back to the running node when the prefix has none (a custom npm prefix)", () => {
    expect(resolveGlobalCommandMode()).toEqual({
      kind: "global-node",
      node: process.execPath,
      cli,
    });
  });

  it("prefers the node beside the bin link over a resolved (Homebrew Cellar) execPath", () => {
    const node = path.join(prefix, "bin", "node");
    fs.writeFileSync(node, "", { mode: 0o755 });
    expect(resolveGlobalCommandMode()).toEqual({ kind: "global-node", node, cli });
  });
});
