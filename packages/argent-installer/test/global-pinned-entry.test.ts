import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PACKAGE_NAME } from "../src/constants.js";
import { getGloballyInstalledLaunchPaths } from "../src/topology.js";
import { writeMcpConfigs } from "../src/init-mcp-write.js";
import { getAdapterByName } from "../src/mcp-configs.js";

// Real `which` against a staged prefix; /usr/bin and /bin hold no argent.
const SYSTEM_PATH = `/usr/bin${path.delimiter}/bin`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-pinned-entry-")));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// `<prefix>/bin/argent` links into `<prefix>/lib/node_modules`, like npm -g.
// With `withNode`, `<prefix>/bin/node` links to a versioned keg, like Homebrew.
function stagePrefix(prefix: string, withNode: boolean): { binDir: string; cli: string } {
  const pkgRoot = path.join(prefix, "lib", "node_modules", PACKAGE_NAME);
  const binDir = path.join(prefix, "bin");
  fs.mkdirSync(path.join(pkgRoot, "dist"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgRoot, "package.json"),
    JSON.stringify({ name: PACKAGE_NAME, version: "1.0.0", bin: { argent: "dist/cli.js" } })
  );
  const cli = path.join(pkgRoot, "dist", "cli.js");
  fs.writeFileSync(cli, "#!/usr/bin/env node\n");
  fs.chmodSync(cli, 0o755);
  fs.symlinkSync(cli, path.join(binDir, "argent"));
  if (withNode) {
    const keg = path.join(prefix, "Cellar", "node", "1.0.0", "bin", "node");
    fs.mkdirSync(path.dirname(keg), { recursive: true });
    fs.writeFileSync(keg, "");
    fs.symlinkSync(keg, path.join(binDir, "node"));
  }
  return { binDir, cli };
}

describe.skipIf(process.platform === "win32")("getGloballyInstalledLaunchPaths", () => {
  it("pins the node beside the bin link without resolving it to the versioned keg", () => {
    const { binDir, cli } = stagePrefix(path.join(tmpDir, "prefix"), true);
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${SYSTEM_PATH}`);

    expect(getGloballyInstalledLaunchPaths()).toEqual({ node: path.join(binDir, "node"), cli });
  });

  it("resolves a symlinked bin dir such as an fnm multishell", () => {
    const { binDir, cli } = stagePrefix(path.join(tmpDir, "prefix"), true);
    const multishell = path.join(tmpDir, "multishell");
    fs.symlinkSync(path.dirname(binDir), multishell);
    vi.stubEnv("PATH", `${path.join(multishell, "bin")}${path.delimiter}${SYSTEM_PATH}`);

    expect(getGloballyInstalledLaunchPaths()).toEqual({ node: path.join(binDir, "node"), cli });
  });

  it("returns null when the prefix has no node of its own", () => {
    const { binDir } = stagePrefix(path.join(tmpDir, "npm-global"), false);
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${SYSTEM_PATH}`);

    expect(getGloballyInstalledLaunchPaths()).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")(
  "writeMcpConfigs with a pinnable global install",
  () => {
    const cursor = getAdapterByName("Cursor")!;

    function readEntry(file: string): unknown {
      return (JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> })
        .mcpServers.argent;
    }

    function setUp(): { home: string; project: string; binDir: string; cli: string } {
      const staged = stagePrefix(path.join(tmpDir, "prefix"), true);
      const home = path.join(tmpDir, "home");
      const project = path.join(tmpDir, "project");
      fs.mkdirSync(home);
      fs.mkdirSync(project);
      vi.stubEnv("HOME", home);
      vi.stubEnv("PATH", `${staged.binDir}${path.delimiter}${SYSTEM_PATH}`);
      return { home, project, ...staged };
    }

    it("writes the absolute node and cli.js into the global config", () => {
      const { home, project, binDir, cli } = setUp();

      writeMcpConfigs({
        selectedAdapters: [cursor],
        installMode: "global",
        scope: "global",
        effectiveRoot: project,
        projectRoot: project,
      });

      expect(readEntry(path.join(home, ".cursor", "mcp.json"))).toEqual({
        command: path.join(binDir, "node"),
        args: [cli, "mcp"],
      });
    });

    it("keeps the bare argent command in a project config", () => {
      const { project } = setUp();

      writeMcpConfigs({
        selectedAdapters: [cursor],
        installMode: "global",
        scope: "local",
        effectiveRoot: project,
        projectRoot: project,
      });

      expect(readEntry(path.join(project, ".cursor", "mcp.json"))).toEqual({
        command: "argent",
        args: ["mcp"],
      });
    });
  }
);
