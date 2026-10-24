import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAdapterByName, resolveGlobalCommandMode } from "../src/mcp-configs.js";
import { writeMcpConfigs } from "../src/init-mcp-write.js";

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
    JSON.stringify({ name: "@swmansion/argent", bin: { argent: "dist/cli.js" } })
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

  it("writes bare argent when no node is on PATH (bunx init)", () => {
    fs.rmSync(path.join(prefix, "bin", "argent"));
    const which = path.join(tmp, "which-only");
    fs.mkdirSync(which);
    fs.symlinkSync("/usr/bin/which", path.join(which, "which"));
    fs.symlinkSync(cli, path.join(which, "argent"));
    vi.stubEnv("PATH", which);
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

  it.each([
    ["pnpm dlx", ["home", ".cache", "pnpm", "dlx", "abc123", "node_modules", ".bin"]],
    ["versioned bunx", ["T", "bunx-501-@swmansion+argent@latest", "node_modules", ".bin"]],
    ["project devDependency (npx from the project)", ["proj", "node_modules", ".bin"]],
  ])("skips a %s copy ahead of the global install on PATH", (_runner, segments) => {
    const runnerBin = path.join(tmp, ...segments);
    fs.mkdirSync(runnerBin, { recursive: true });
    fs.symlinkSync(cli, path.join(runnerBin, "argent"));
    prependPath(runnerBin);
    const node = linkPrefixNode();
    expect(resolveGlobalCommandMode()).toEqual({ kind: "global-node", node, cli });
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
