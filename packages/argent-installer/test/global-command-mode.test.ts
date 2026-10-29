import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as p from "@clack/prompts";
import { getAdapterByName, resolveGlobalCommandMode } from "../src/mcp-configs.js";
import { writeMcpConfigs } from "../src/init-mcp-write.js";
import { isGloballyInstalled } from "../src/topology.js";

// A real `which argent` against a fake npm prefix put first on PATH: the entry
// a global-scope config gets (#1287) must name paths that outlive the shell.

let homedirOverride: string | undefined;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: vi.fn(() => homedirOverride ?? original.homedir()),
  };
});

let tmp: string;
let prefix: string;
let pkg: string;
let cli: string;

function prependPath(dir: string): void {
  vi.stubEnv("PATH", `${dir}${path.delimiter}${process.env.PATH}`);
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-global-mode-")));
  prefix = path.join(tmp, "prefix");
  pkg = path.join(prefix, "lib", "node_modules", "@swmansion", "argent");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "@swmansion/argent", version: "0.30.0", bin: { argent: "dist/cli.js" } })
  );
  cli = path.join(pkg, "dist", "cli.js");
  fs.writeFileSync(cli, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.mkdirSync(path.join(prefix, "bin"));
  fs.symlinkSync(
    "../lib/node_modules/@swmansion/argent/dist/cli.js",
    path.join(prefix, "bin", "argent")
  );
  prependPath(path.join(prefix, "bin"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  homedirOverride = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A runnable `node` beside the bin link. A symlink to the real binary, not an
// empty file: when `which` is itself a `#!/usr/bin/env node` script, a fake
// node first on PATH would break the probe.
function linkPrefixNode(): string {
  const node = path.join(prefix, "bin", "node");
  fs.symlinkSync(process.execPath, node);
  return node;
}

// A `node` in a dir of its own, first on PATH — the user's shell node (nvm's
// version dir, Homebrew's bin/).
function linkPathNode(): string {
  const dir = path.join(tmp, "shell-node", "bin");
  fs.mkdirSync(dir, { recursive: true });
  const node = path.join(dir, "node");
  fs.symlinkSync(process.execPath, node);
  prependPath(dir);
  return node;
}

describe.skipIf(process.platform === "win32")("resolveGlobalCommandMode", () => {
  it("falls back to the first node on PATH when the prefix has none (a custom npm prefix)", () => {
    const node = linkPathNode();
    expect(resolveGlobalCommandMode()).toEqual({ kind: "global-node", node, cli });
  });

  it("prefers the node beside the bin link over the shell's node", () => {
    linkPathNode();
    const node = linkPrefixNode();
    expect(resolveGlobalCommandMode()).toEqual({ kind: "global-node", node, cli });
  });

  it("pins the version dir behind a per-shell bin symlink (fnm multishell)", () => {
    const node = linkPrefixNode();
    const multishell = path.join(tmp, "fnm_multishells", "1214_1791814454867");
    fs.mkdirSync(multishell, { recursive: true });
    fs.symlinkSync(path.join(prefix, "bin"), path.join(multishell, "bin"));
    vi.stubEnv("PATH", `${path.join(multishell, "bin")}${path.delimiter}${process.env.PATH}`);
    expect(resolveGlobalCommandMode()).toEqual({ kind: "global-node", node, cli });
  });

  it("keeps the name of a symlinked bin dir (Homebrew opt/node@22 -> Cellar keg)", () => {
    const keg = path.join(tmp, "Cellar", "node@22", "22.1.0", "bin");
    fs.mkdirSync(keg, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(keg, "node"));
    const opt = path.join(tmp, "opt", "node@22");
    fs.mkdirSync(path.dirname(opt), { recursive: true });
    fs.symlinkSync(path.dirname(keg), opt);
    prependPath(path.join(opt, "bin"));
    expect(resolveGlobalCommandMode()).toEqual({
      kind: "global-node",
      node: path.join(opt, "bin", "node"),
      cli,
    });
  });

  it("skips a sibling node older than the package's engines range", () => {
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "@swmansion/argent",
        version: "0.30.0",
        bin: { argent: "dist/cli.js" },
        engines: { node: ">=20.12.0" },
      })
    );
    fs.writeFileSync(path.join(prefix, "bin", "node"), "#!/bin/sh\necho 18.20.8\n", {
      mode: 0o755,
    });
    const node = linkPathNode();
    expect(resolveGlobalCommandMode()).toEqual({ kind: "global-node", node, cli });
  });

  it("accepts a prerelease node that meets the engines range (nightly, rc)", () => {
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "@swmansion/argent",
        version: "0.30.0",
        bin: { argent: "dist/cli.js" },
        engines: { node: ">=20.12.0" },
      })
    );
    const node = path.join(prefix, "bin", "node");
    fs.writeFileSync(node, "#!/bin/sh\necho 24.0.0-nightly20250301abcdef\n", { mode: 0o755 });
    expect(resolveGlobalCommandMode()).toEqual({ kind: "global-node", node, cli });
  });

  it("never pins a node found through a relative PATH entry", () => {
    const node = linkPathNode();
    const relativeDir = path.join(tmp, "repo", "bin");
    fs.mkdirSync(relativeDir, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(relativeDir, "node"));
    prependPath(path.relative(process.cwd(), relativeDir));
    expect(resolveGlobalCommandMode()).toEqual({ kind: "global-node", node, cli });
  });

  it("writes bare argent for an install older than 0.27.0", () => {
    linkPrefixNode();
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "@swmansion/argent",
        version: "0.26.0",
        bin: { argent: "dist/cli.js" },
      })
    );
    expect(resolveGlobalCommandMode()).toEqual({ kind: "global" });
  });

  it("writes bare argent when no node is on PATH", () => {
    fs.rmSync(path.join(prefix, "bin", "argent"));
    const which = path.join(tmp, "which-only");
    fs.mkdirSync(which);
    fs.symlinkSync("/usr/bin/which", path.join(which, "which"));
    fs.symlinkSync(cli, path.join(which, "argent"));
    vi.stubEnv("PATH", which);
    expect(resolveGlobalCommandMode()).toEqual({ kind: "global" });
  });

  it("writes bare argent when the only node on PATH is bun's shim (bunx init)", () => {
    const bun = path.join(tmp, "bun", "bin", "bun");
    fs.mkdirSync(path.dirname(bun), { recursive: true });
    fs.writeFileSync(bun, "#!/bin/sh\necho 24.3.0\n", { mode: 0o755 });
    const shimDir = path.join(tmp, "bun-node-30e609e08");
    fs.mkdirSync(shimDir);
    fs.symlinkSync(bun, path.join(shimDir, "node"));
    const which = path.join(tmp, "which-only");
    fs.mkdirSync(which);
    fs.symlinkSync("/usr/bin/which", path.join(which, "which"));
    vi.stubEnv("PATH", [shimDir, path.join(prefix, "bin"), which].join(path.delimiter));
    expect(resolveGlobalCommandMode()).toEqual({ kind: "global" });
  });

  it("writes bare argent for a checkout outside node_modules (npm link)", () => {
    linkPrefixNode();
    const checkout = path.join(tmp, "checkout");
    fs.renameSync(pkg, checkout);
    fs.symlinkSync(checkout, pkg);
    expect(resolveGlobalCommandMode()).toEqual({ kind: "global" });
  });

  it("writes bare argent when the package has no bin entry", () => {
    linkPrefixNode();
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@swmansion/argent" }));
    expect(resolveGlobalCommandMode()).toEqual({ kind: "global" });
  });

  it("writes bare argent when the bin's target is missing (no dist/)", () => {
    linkPrefixNode();
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", bin: { argent: "dist/other.js" } })
    );
    expect(resolveGlobalCommandMode()).toEqual({ kind: "global" });
  });

  // Each runner dir holds its own copy of the package, so a pin through it
  // would name a different cli.js than the global install's.
  it.each([
    ["pnpm dlx", ["home", ".cache", "pnpm", "dlx", "abc123", "node_modules", ".bin"]],
    ["versioned bunx", ["T", "bunx-501-@swmansion+argent@latest", "node_modules", ".bin"]],
    ["project devDependency (npx from the project)", ["proj", "node_modules", ".bin"]],
  ])("skips a %s copy ahead of the global install on PATH", (_runner, segments) => {
    const runnerBin = path.join(tmp, ...segments);
    const copy = path.join(runnerBin, "..", "@swmansion", "argent");
    fs.cpSync(pkg, copy, { recursive: true });
    fs.mkdirSync(runnerBin, { recursive: true });
    fs.symlinkSync(path.join(copy, "dist", "cli.js"), path.join(runnerBin, "argent"));
    prependPath(runnerBin);
    const node = linkPrefixNode();
    expect(resolveGlobalCommandMode()).toEqual({ kind: "global-node", node, cli });
  });

  it.each([
    ["yarn berry's per-command wrapper", ["T", "xfs-346d11a9"]],
    ["a project's node package (npm exec)", ["proj", "node_modules", ".bin"]],
  ])("skips %s when picking a node from PATH", (_source, segments) => {
    const node = linkPathNode();
    const wrapperDir = path.join(tmp, ...segments);
    fs.mkdirSync(wrapperDir, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(wrapperDir, "node"));
    prependPath(wrapperDir);
    expect(resolveGlobalCommandMode()).toEqual({ kind: "global-node", node, cli });
  });
});

describe.skipIf(process.platform === "win32")("isGloballyInstalled", () => {
  it("detects a yarn v1 global whose node_modules/.bin is on PATH", () => {
    const yarnBin = path.join(tmp, "yarn-global", "node_modules", ".bin");
    fs.mkdirSync(yarnBin, { recursive: true });
    fs.symlinkSync(cli, path.join(yarnBin, "argent"));
    vi.stubEnv("PATH", `${yarnBin}${path.delimiter}/usr/bin${path.delimiter}/bin`);
    expect(isGloballyInstalled()).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("writeMcpConfigs — global install", () => {
  const cursor = getAdapterByName("Cursor")!;
  let home: string;
  let project: string;

  beforeEach(() => {
    home = path.join(tmp, "home");
    project = path.join(tmp, "project");
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    homedirOverride = home;
  });

  function cursorEntryIn(dir: string): { command: string; args: string[] } {
    const file = path.join(dir, ".cursor", "mcp.json");
    return (
      JSON.parse(fs.readFileSync(file, "utf8")) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      }
    ).mcpServers.argent;
  }

  it("pins absolute node + cli.js into the global config", () => {
    const node = linkPrefixNode();
    writeMcpConfigs({
      selectedAdapters: [cursor],
      installMode: "global",
      scope: "global",
      effectiveRoot: project,
      projectRoot: project,
    });
    expect(cursorEntryIn(home)).toEqual({ command: node, args: [cli, "mcp"] });
  });

  it("keeps bare argent in a project config", () => {
    linkPrefixNode();
    writeMcpConfigs({
      selectedAdapters: [cursor],
      installMode: "global",
      scope: "local",
      effectiveRoot: project,
      projectRoot: project,
    });
    expect(cursorEntryIn(project)).toEqual({ command: "argent", args: ["mcp"] });
  });

  it("warns when it can't pin and writes bare argent (npm link checkout)", () => {
    linkPrefixNode();
    const checkout = path.join(tmp, "checkout");
    fs.renameSync(pkg, checkout);
    fs.symlinkSync(checkout, pkg);
    const warn = vi.spyOn(p.log, "warn").mockImplementation(() => {});
    writeMcpConfigs({
      selectedAdapters: [cursor],
      installMode: "global",
      scope: "global",
      effectiveRoot: project,
      projectRoot: project,
    });
    expect(cursorEntryIn(home)).toEqual({ command: "argent", args: ["mcp"] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not resolve absolute node"));
  });

  it("does not warn when the global entry is pinned", () => {
    linkPrefixNode();
    const warn = vi.spyOn(p.log, "warn").mockImplementation(() => {});
    writeMcpConfigs({
      selectedAdapters: [cursor],
      installMode: "global",
      scope: "global",
      effectiveRoot: project,
      projectRoot: project,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("pins a write at a symlinked $HOME, where cwd is the resolved path", () => {
    const node = linkPrefixNode();
    const linkHome = path.join(tmp, "linkhome");
    fs.symlinkSync(home, linkHome);
    homedirOverride = linkHome;
    writeMcpConfigs({
      selectedAdapters: [cursor],
      installMode: "global",
      scope: "local",
      effectiveRoot: home,
      projectRoot: home,
    });
    expect(cursorEntryIn(home)).toEqual({ command: node, args: [cli, "mcp"] });
  });

  it("pins a Local-scope write at $HOME, where the project file is the global one", () => {
    const node = linkPrefixNode();
    writeMcpConfigs({
      selectedAdapters: [cursor],
      installMode: "global",
      scope: "local",
      effectiveRoot: home,
      projectRoot: home,
    });
    expect(cursorEntryIn(home)).toEqual({ command: node, args: [cli, "mcp"] });
  });
});
