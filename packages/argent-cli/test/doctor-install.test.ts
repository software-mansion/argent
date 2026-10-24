import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findGlobalArgent,
  globalBinDirOf,
  globalPackageManagerOf,
  installSection,
  probeProjectInstall,
  runGlobalShim,
} from "../src/doctor-install.js";
import { collectDoctorReport } from "../src/doctor.js";
import { globalBehindCheck } from "../src/doctor-other.js";
import { type DoctorContext } from "../src/doctor-shared.js";

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-"));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("findGlobalArgent", () => {
  const writeBin = (dir: string, body: string): string => {
    fs.mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, "argent");
    fs.writeFileSync(bin, body, { mode: 0o755 });
    return bin;
  };

  it("accepts a script shim (pnpm, Yarn) without resolving its version", () => {
    const bin = writeBin(path.join(projectRoot, "pnpm"), '#!/bin/sh\nexec node x "$@"\n');
    expect(findGlobalArgent(path.dirname(bin))).toEqual({ bin, root: null, version: null });
  });

  it("reads the version through an npm bin symlink", () => {
    const pkg = path.join(projectRoot, "lib", "node_modules", "@swmansion", "argent");
    fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "1.2.3" })
    );
    fs.writeFileSync(path.join(pkg, "dist", "cli.js"), "", { mode: 0o755 });
    const binDir = path.join(projectRoot, "bin");
    fs.mkdirSync(binDir);
    fs.symlinkSync(path.join(pkg, "dist", "cli.js"), path.join(binDir, "argent"));
    expect(findGlobalArgent(binDir)).toMatchObject({ version: "1.2.3" });
  });

  it("skips npx caches and missing dirs", () => {
    const npx = writeBin(path.join(projectRoot, "_npx", "abc", "node_modules", ".bin"), "");
    const dirs = [path.join(projectRoot, "nope"), path.dirname(npx)].join(path.delimiter);
    expect(findGlobalArgent(dirs)).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("runGlobalShim", () => {
  const shim = (body: string): string => {
    const bin = path.join(projectRoot, "shims", "argent");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return bin;
  };
  const run = (bin: string, pathValue = "/usr/bin:/bin", timeoutMs?: number) =>
    runGlobalShim({ bin, root: null, version: null }, projectRoot, pathValue, timeoutMs);

  it("reads a script shim's version by running it", async () => {
    const bin = shim("echo 1.2.3");
    expect(await run(bin)).toEqual({ bin, root: null, version: "1.2.3" });
  });

  it("reports a version-manager shim that fails in this project", async () => {
    const bin = shim('echo "mise ERROR No version is set for shim: argent" >&2; exit 1');
    expect(await run(bin)).toMatchObject({
      runError: "mise ERROR No version is set for shim: argent",
    });
  });

  it("picks mise's error line over its progress banner", async () => {
    const bin = shim(
      'echo "mise by @jdx – installing 1 tool" >&2; echo "mise ERROR failed to install node" >&2; exit 1'
    );
    expect((await run(bin)).runError).toBe("mise ERROR failed to install node");
  });

  it("runs the shim from the project, as an editor does", async () => {
    const bin = shim(`[ "$(pwd -P)" = "${fs.realpathSync(projectRoot)}" ] && echo 1.0.0 || exit 3`);
    expect((await run(bin)).version).toBe("1.0.0");
  });

  it("turns off mise's auto-install, so doctor installs nothing", async () => {
    const bin = shim('[ "$MISE_AUTO_INSTALL" = false ] && echo 1.0.0 || exit 4');
    expect((await run(bin)).version).toBe("1.0.0");
  });

  it("runs the shim on the PATH it was found on", async () => {
    const bin = shim('echo "$PATH" >&2; exit 1');
    expect((await run(bin, "/stripped/bin:/usr/bin:/bin")).runError).toBe(
      "/stripped/bin:/usr/bin:/bin"
    );
  });

  it("kills the shim and its children on timeout", async () => {
    // sleep inherits stdout: killing only the shim would leave the pipe open.
    const bin = shim("sleep 30");
    const started = Date.now();
    expect((await run(bin, undefined, 200)).runError).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not run an install whose package root is known", async () => {
    const bin = shim("exit 1");
    const global = { bin, root: projectRoot, version: "1.0.0" };
    expect(await runGlobalShim(global, projectRoot, "")).toBe(global);
  });
});

describe.skipIf(process.platform === "win32")("collectDoctorReport with a failing shim", () => {
  let home: string;
  let originalCwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-home-"));
    originalCwd = process.cwd();
    const shims = path.join(home, "shims");
    fs.mkdirSync(shims);
    fs.writeFileSync(
      path.join(shims, "argent"),
      '#!/bin/sh\necho "mise ERROR No version is set for shim: argent" >&2\nexit 1\n',
      { mode: 0o755 }
    );
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", `${shims}:/usr/bin:/bin`);
    fs.mkdirSync(path.join(projectRoot, ".git"));
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { argent: { command: "argent", args: ["mcp"] } } })
    );
    process.chdir(projectRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("fails the install and the entry, and never offers the failing `argent` as a fix", async () => {
    const pkg = path.join(home, "pkg");
    const report = await collectDoctorReport({
      paths: {
        bundlePath: path.join(pkg, "dist", "tool-server.cjs"),
        simulatorServerDir: path.join(pkg, "bin"),
        nativeDevtoolsDir: path.join(pkg, "dylibs"),
        version: "1.0.0",
      },
      offline: true,
    });
    const checks = (title: string) => report.sections.find((s) => s.title === title)!.checks;
    expect(checks("Install").find((c) => /fails to run/.test(c.label))?.status).toBe("error");
    const entry = checks("Editors (MCP config)").find((c) => c.label.startsWith("Claude Code"));
    expect(entry?.status).toBe("error");
    expect(entry?.detail).toContain("mise ERROR No version is set for shim: argent");
    const fixes = report.sections.flatMap((s) => s.checks.map((c) => c.fix ?? ""));
    expect(fixes.filter((f) => /^argent /.test(f))).toEqual([]);
  });
});

describe("installSection", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("does not offer an install for a leftover install record with no dependency", () => {
    vi.stubEnv("HOME", projectRoot);
    fs.mkdirSync(path.join(projectRoot, ".argent"));
    fs.writeFileSync(path.join(projectRoot, ".argent", "install.json"), '{"mode":"local"}');
    fs.writeFileSync(path.join(projectRoot, "package.json"), '{"name":"app"}');
    const pkg = path.join(projectRoot, "pkg");
    const section = installSection(
      {
        projectRoot,
        cwd: projectRoot,
        mode: "local",
        global: null,
        argentCmd: "npx argent",
        installCmd: "npm install",
        offPathGlobalBin: null,
      },
      "1.0.0",
      {
        bundlePath: path.join(pkg, "dist", "t.cjs"),
        simulatorServerDir: pkg,
        nativeDevtoolsDir: pkg,
      }
    );
    expect(section.checks.find((c) => /not installed/.test(c.label))?.fix).toMatch(
      /delete .argent\/install.json/
    );
  });

  const pkgPaths = () => {
    const pkg = path.join(projectRoot, "pkg");
    return {
      bundlePath: path.join(pkg, "dist", "t.cjs"),
      simulatorServerDir: pkg,
      nativeDevtoolsDir: pkg,
    };
  };
  const localCtx = (overrides: Partial<DoctorContext> = {}): DoctorContext => ({
    projectRoot,
    cwd: projectRoot,
    mode: "local",
    global: null,
    argentCmd: "npx argent",
    installCmd: "npm install",
    offPathGlobalBin: null,
    ...overrides,
  });

  it("does not ask for ~/.argent/cli.json under Yarn PnP, which never writes it", () => {
    vi.stubEnv("HOME", projectRoot);
    fs.writeFileSync(path.join(projectRoot, ".pnp.cjs"), "");
    const section = installSection(localCtx(), "1.0.0", pkgPaths());
    expect(section.checks.find((c) => c.label.includes("cli.json"))?.status).toBe("info");
  });

  it("notes when the global install is not on the PATH apps started from the Dock get", () => {
    vi.stubEnv("HOME", projectRoot);
    const global = { bin: "/Users/me/.nvm/bin/argent", root: null, version: "1.0.0" };
    const off = installSection(
      localCtx({ mode: "global", global, guiPath: "/usr/bin:/bin" }),
      "1.0.0",
      pkgPaths()
    );
    expect(off.checks.some((c) => /Dock/.test(c.label))).toBe(true);
    const on = installSection(
      localCtx({ mode: "global", global, guiPath: "/Users/me/.nvm/bin:/usr/bin" }),
      "1.0.0",
      pkgPaths()
    );
    expect(on.checks.some((c) => /Dock/.test(c.label))).toBe(false);
  });

  it("names a global install whose bin dir is not on PATH", () => {
    vi.stubEnv("HOME", projectRoot);
    const section = installSection(
      localCtx({ mode: "global", offPathGlobalBin: "/opt/argent/bin" }),
      "1.0.0",
      pkgPaths()
    );
    expect(section.checks.find((c) => /not on PATH/.test(c.label))).toMatchObject({
      status: "warn",
      fix: "Add /opt/argent/bin to PATH",
    });
  });

  it("only warns about a failing global shim in local mode, which doesn't use it", () => {
    vi.stubEnv("HOME", projectRoot);
    const pkg = path.join(projectRoot, "pkg");
    const section = installSection(
      {
        projectRoot,
        cwd: projectRoot,
        mode: "local",
        global: { bin: "/shims/argent", root: null, version: null, runError: "mise ERROR" },
        argentCmd: "npx argent",
        installCmd: "npm install",
        offPathGlobalBin: null,
      },
      "1.0.0",
      {
        bundlePath: path.join(pkg, "dist", "tool-server.cjs"),
        simulatorServerDir: pkg,
        nativeDevtoolsDir: pkg,
      }
    );
    expect(section.checks.find((c) => /fails to run/.test(c.label))?.status).toBe("warn");
  });
});

describe("probeProjectInstall", () => {
  const installAt = (dir: string): void => {
    const pkg = path.join(dir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "1.0.0" })
    );
  };
  const app = (): string => {
    const dir = path.join(projectRoot, "app");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app" }));
    return dir;
  };

  it("accepts the project's own node_modules", () => {
    const dir = app();
    installAt(dir);
    expect(probeProjectInstall(dir)).toMatchObject({ installed: true, version: "1.0.0" });
  });

  it("does not count a stray copy in an ancestor's node_modules", () => {
    installAt(projectRoot);
    expect(probeProjectInstall(app())).toMatchObject({ installed: false });
  });

  it("does not count a stray `npm i` in ~, which writes a package.json there", () => {
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ dependencies: { "@swmansion/argent": "^1.0.0" } })
    );
    installAt(projectRoot);
    expect(probeProjectInstall(app())).toMatchObject({ installed: false });
  });

  it("accepts a copy hoisted to a pnpm workspace root", () => {
    fs.writeFileSync(path.join(projectRoot, "pnpm-workspace.yaml"), "packages: [app]\n");
    installAt(projectRoot);
    expect(probeProjectInstall(app())).toMatchObject({ installed: true });
  });

  it("goes by the manifest under Yarn PnP, even with a stray copy above", () => {
    installAt(projectRoot);
    const dir = app();
    fs.writeFileSync(path.join(dir, ".pnp.cjs"), "");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", devDependencies: { "@swmansion/argent": "0.30.0" } })
    );
    expect(probeProjectInstall(dir)).toEqual({ installed: true, version: "0.30.0" });
  });

  it("accepts a copy hoisted to a workspace root", () => {
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "ws", workspaces: ["app"] })
    );
    installAt(projectRoot);
    expect(probeProjectInstall(app())).toMatchObject({ installed: true });
  });
});

describe("findGlobalArgent edge cases", () => {
  const writeBin = (dir: string, mode = 0o755): string => {
    fs.mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, "argent");
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode });
    return bin;
  };

  it("skips a file that is not executable", () => {
    const bin = writeBin(path.join(projectRoot, "bin"), 0o644);
    expect(findGlobalArgent(path.dirname(bin))).toBeNull();
  });

  it("skips pnpm dlx, bunx and Yarn Berry script dirs", () => {
    for (const dir of [
      path.join(projectRoot, "pnpm", "dlx", "abc", "1", "node_modules", ".bin"),
      path.join(projectRoot, "bunx-501-argent", "node_modules", ".bin"),
      path.join(projectRoot, "xfs-02f1a466"),
    ]) {
      writeBin(dir);
      expect(findGlobalArgent(dir)).toBeNull();
    }
  });

  it("stops at the first package.json up the tree", () => {
    const pkg = path.join(projectRoot, "tool");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "other" }));
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "9.9.9" })
    );
    writeBin(path.join(pkg, "bin"));
    expect(findGlobalArgent(path.join(pkg, "bin"))).toMatchObject({ root: null, version: null });
  });

  it("reads the version of a Windows npm install from its prefix", () => {
    const prefix = path.join(projectRoot, "npm");
    const pkg = path.join(prefix, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "1.2.3" })
    );
    fs.writeFileSync(path.join(prefix, "argent"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(prefix, "argent.CMD"), "@echo off\n");
    vi.stubEnv("PATHEXT", ".COM;.EXE;.BAT;.CMD");
    try {
      withPlatform("win32", () =>
        expect(findGlobalArgent(prefix)).toMatchObject({
          bin: path.join(prefix, "argent.CMD"),
          version: "1.2.3",
        })
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("global install helpers", () => {
  it("finds the bin dir of an npm prefix", () => {
    const prefix = path.join(projectRoot, ".npm-global");
    const pkg = path.join(prefix, "lib", "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkg, { recursive: true });
    fs.mkdirSync(path.join(prefix, "bin"));
    expect(globalBinDirOf(pkg)).toBeNull();
    fs.writeFileSync(path.join(prefix, "bin", "argent"), "", { mode: 0o755 });
    expect(globalBinDirOf(pkg)).toBe(path.join(prefix, "bin"));
  });

  it("recognises a pnpm global under ~/.pnpm", () => {
    expect(globalPackageManagerOf("/home/me/.pnpm/global/5/node_modules/@swmansion/argent")).toBe(
      "pnpm"
    );
  });

  it("warns when the global install the entries start is behind npm latest", () => {
    const global = {
      bin: "/g/bin/argent",
      root: "/g/lib/node_modules/@swmansion/argent",
      version: "0.26.0",
    };
    expect(globalBehindCheck(global, "0.30.1", "0.30.1")).toMatchObject({
      status: "warn",
      fix: expect.stringContaining("@swmansion/argent@latest"),
    });
    expect(globalBehindCheck({ ...global, version: "0.30.1" }, "0.30.1", "0.30.1")).toBeNull();
    expect(globalBehindCheck(null, "0.30.1", "0.30.1")).toBeNull();
  });

  it("tells which package manager owns a global install", () => {
    expect(
      globalPackageManagerOf("/Users/me/.bun/install/global/node_modules/@swmansion/argent")
    ).toBe("bun");
    expect(
      globalPackageManagerOf("/Users/me/Library/pnpm/global/5/node_modules/@swmansion/argent")
    ).toBe("pnpm");
    expect(
      globalPackageManagerOf("/Users/me/.config/yarn/global/node_modules/@swmansion/argent")
    ).toBe("yarn");
    expect(globalPackageManagerOf("/opt/homebrew/lib/node_modules/@swmansion/argent")).toBe("npm");
  });
});
