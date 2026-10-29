import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addToPathFix,
  findGlobalArgent,
  globalBinDirOf,
  globalPackageManagerOf,
  installSection,
  probeProjectInstall,
  runGlobalShim,
} from "../src/doctor-install.js";
import { collectDoctorReport } from "../src/doctor.js";
import { globalBehindCheck } from "../src/doctor-other.js";
import { type DoctorCheck, type DoctorContext } from "../src/doctor-shared.js";

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

  it("gives up on a hanging shim after 5s by default", async () => {
    const bin = shim("sleep 30");
    expect((await run(bin)).runError).toBe("`argent --version` timed out after 5s");
  }, 15_000);

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

  const collect = () => {
    const pkg = path.join(home, "pkg");
    return collectDoctorReport({
      paths: {
        bundlePath: path.join(pkg, "dist", "tool-server.cjs"),
        simulatorServerDir: path.join(pkg, "bin"),
        nativeDevtoolsDir: path.join(pkg, "dylibs"),
        version: "1.0.0",
      },
      offline: true,
    });
  };

  it("does not let `npx --no-install argent` fall back to the failing `argent`", async () => {
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: { argent: { command: "npx", args: ["--no-install", "argent", "mcp"] } },
      })
    );
    const report = await collect();
    const entry = report.sections
      .find((s) => s.title === "Editors (MCP config)")!
      .checks.find((c) => c.label.startsWith("Claude Code"));
    expect(entry).toMatchObject({
      status: "error",
      label: expect.stringContaining("no local @swmansion/argent to run"),
    });
  });

  it("fails the install and the entry, and never offers the failing `argent` as a fix", async () => {
    const report = await collect();
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
      localCtx({ mode: "global", global, guiPath: "/gui/a:/gui/b" }),
      "1.0.0",
      pkgPaths()
    );
    const note = off.checks.find((c) => /Dock/.test(c.label));
    const nodeDir = path.dirname(process.execPath);
    expect(note?.fix).toContain(`"PATH": "/Users/me/.nvm/bin:${nodeDir}:/gui/a:/gui/b"`);
    const on = installSection(
      localCtx({ mode: "global", global, guiPath: `/Users/me/.nvm/bin:${nodeDir}:/gui/a` }),
      "1.0.0",
      pkgPaths()
    );
    expect(on.checks.some((c) => /Dock/.test(c.label))).toBe(false);
  });

  it("notes when node is not on the PATH apps started from the Dock get", () => {
    vi.stubEnv("HOME", projectRoot);
    const nodeDir = path.dirname(process.execPath);
    const section = installSection(localCtx({ guiPath: "/gui/a:/gui/b" }), "1.0.0", pkgPaths());
    const note = section.checks.find((c) => /Dock/.test(c.label));
    expect(note?.detail).toContain(nodeDir);
    expect(note?.fix).toContain(`"PATH": "${nodeDir}:/gui/a:/gui/b"`);
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

  it("counts nothing as installed under Yarn PnP once the dependency is removed", () => {
    const dir = app();
    fs.writeFileSync(path.join(dir, ".pnp.cjs"), "");
    fs.mkdirSync(path.join(dir, ".argent"));
    fs.writeFileSync(path.join(dir, ".argent", "install.json"), '{"mode":"local"}');
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"app"}');
    expect(probeProjectInstall(dir)).toEqual({ installed: false, version: null });
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

describe("findGlobalArgent: PATH order and layouts", () => {
  const npmGlobal = (prefix: string, version: string): string => {
    const pkg = path.join(prefix, "lib", "node_modules", "@swmansion", "argent");
    fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version })
    );
    fs.writeFileSync(path.join(pkg, "dist", "cli.js"), "", { mode: 0o755 });
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.symlinkSync(path.join(pkg, "dist", "cli.js"), path.join(prefix, "bin", "argent"));
    return pkg;
  };

  it("reports the first argent on PATH, the one editors start", () => {
    npmGlobal(path.join(projectRoot, "a"), "0.29.0");
    npmGlobal(path.join(projectRoot, "b"), "0.30.1");
    const pathValue = [path.join(projectRoot, "a", "bin"), path.join(projectRoot, "b", "bin")].join(
      path.delimiter
    );
    expect(findGlobalArgent(pathValue)?.version).toBe("0.29.0");
  });

  it("keeps the package root of an npm global, so it is not taken for a script shim", () => {
    const pkg = npmGlobal(path.join(projectRoot, "g"), "1.2.3");
    expect(findGlobalArgent(path.join(projectRoot, "g", "bin"))?.root).toBe(fs.realpathSync(pkg));
  });

  it("does not take a package.json it can't parse for argent's", () => {
    const tool = path.join(projectRoot, "tool");
    fs.mkdirSync(path.join(tool, "bin"), { recursive: true });
    fs.writeFileSync(path.join(tool, "package.json"), "{ not json");
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "9.9.9" })
    );
    fs.writeFileSync(path.join(tool, "bin", "argent"), "#!/bin/sh\n", { mode: 0o755 });
    expect(findGlobalArgent(path.join(tool, "bin"))).toMatchObject({ root: null, version: null });
  });

  it("strips the double quotes Windows tolerates around a PATH entry", () => {
    const prefix = path.join(projectRoot, "npm");
    fs.mkdirSync(prefix);
    fs.writeFileSync(path.join(prefix, "argent.CMD"), "@echo off\n");
    vi.stubEnv("PATHEXT", ".CMD");
    try {
      withPlatform("win32", () =>
        expect(findGlobalArgent(`"${prefix}"`)?.bin).toBe(path.join(prefix, "argent.CMD"))
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("globalBinDirOf layouts", () => {
  const writeArgent = (dir: string, name = "argent"): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), "", { mode: 0o755 });
  };

  it("finds a Windows npm global's bin dir, which is the prefix itself", () => {
    const prefix = path.join(projectRoot, "AppData", "Roaming", "npm");
    const pkg = path.join(prefix, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkg, { recursive: true });
    writeArgent(prefix, "argent.CMD");
    vi.stubEnv("PATHEXT", ".CMD");
    try {
      withPlatform("win32", () => expect(globalBinDirOf(pkg)).toBe(prefix));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("finds bun's global bin dir", () => {
    const bun = path.join(projectRoot, ".bun");
    const pkg = path.join(bun, "install", "global", "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkg, { recursive: true });
    writeArgent(path.join(bun, "bin"));
    expect(globalBinDirOf(pkg)).toBe(path.join(bun, "bin"));
  });

  it("finds pnpm's global bin dir, PNPM_HOME or its bin subdir", () => {
    const pnpmHome = path.join(projectRoot, "Library", "pnpm");
    const pkg = path.join(pnpmHome, "global", "5", "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkg, { recursive: true });
    writeArgent(path.join(pnpmHome, "bin"));
    expect(globalBinDirOf(pkg)).toBe(path.join(pnpmHome, "bin"));
    writeArgent(pnpmHome);
    expect(globalBinDirOf(pkg)).toBe(pnpmHome);
  });

  it("finds Yarn classic's global bin dir", () => {
    vi.stubEnv("HOME", projectRoot);
    try {
      const pkg = path.join(
        projectRoot,
        ".config",
        "yarn",
        "global",
        "node_modules",
        "@swmansion",
        "argent"
      );
      fs.mkdirSync(pkg, { recursive: true });
      writeArgent(path.join(projectRoot, ".yarn", "bin"));
      expect(globalBinDirOf(pkg)).toBe(path.join(projectRoot, ".yarn", "bin"));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("addToPathFix", () => {
  it("prints the full dir on Windows, which does not expand ~ in PATH", () => {
    const dir = path.join(os.homedir(), "AppData", "Roaming", "npm");
    withPlatform("win32", () => expect(addToPathFix(dir)).toBe(`Add ${dir} to PATH`));
    expect(addToPathFix(dir)).toMatch(/^Add ~/);
  });
});

describe.skipIf(process.platform === "win32")("runGlobalShim lifecycle", () => {
  const shim = (body: string, shebang = "#!/bin/sh"): string => {
    const bin = path.join(projectRoot, "shims", "argent");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, `${shebang}\n${body}\n`, { mode: 0o755 });
    return bin;
  };
  const run = (bin: string, timeoutMs?: number) =>
    runGlobalShim({ bin, root: null, version: null }, projectRoot, "/usr/bin:/bin", timeoutMs);
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitForFile = async (file: string): Promise<string> => {
    while (!fs.existsSync(file) || fs.readFileSync(file, "utf8").trim() === "") {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return fs.readFileSync(file, "utf8").trim();
  };

  afterEach(() => vi.restoreAllMocks());

  it("reports a shim whose interpreter is gone instead of crashing", async () => {
    const bin = shim("echo 1.0.0", "#!/nonexistent/interpreter");
    expect((await run(bin)).runError).toBeTruthy();
  });

  it("kills a shim that ignores SIGTERM", async () => {
    const bin = shim('trap "" TERM\nsleep 30');
    const started = Date.now();
    expect((await run(bin, 200)).runError).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops the kill timer once the shim answers", async () => {
    const kill = vi.spyOn(process, "kill");
    await run(shim("echo 1.0.0"), 1_000);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const groupKills = kill.mock.calls.filter(([pid]) => typeof pid === "number" && pid < 0);
    expect(groupKills).toEqual([]);
  });

  it("takes the shim's process group down when doctor is interrupted", async () => {
    const pidFile = path.join(projectRoot, "sleep.pid");
    const bin = shim(`sleep 30 &\necho $! > "${pidFile}"\nwait`);
    const keepAlive = () => {};
    process.on("SIGINT", keepAlive);
    const baseline = process.listenerCount("SIGINT");
    try {
      const result = run(bin, 20_000);
      const sleepPid = Number(await waitForFile(pidFile));
      process.emit("SIGINT", "SIGINT");
      await result;
      await vi.waitFor(() => expect(isAlive(sleepPid)).toBe(false));
      expect(process.listenerCount("SIGINT")).toBe(baseline);
    } finally {
      process.off("SIGINT", keepAlive);
    }
  });
});

describe("installSection verdicts", () => {
  const pkgRoot = () => path.join(projectRoot, "pkg");
  const pkgPaths = (installKind?: "global" | "local") => ({
    bundlePath: path.join(pkgRoot(), "dist", "tool-server.cjs"),
    simulatorServerDir: pkgRoot(),
    nativeDevtoolsDir: pkgRoot(),
    ...(installKind ? { installKind } : {}),
  });
  const ctx = (overrides: Partial<DoctorContext> = {}): DoctorContext => ({
    projectRoot,
    cwd: projectRoot,
    mode: "global",
    global: null,
    argentCmd: "argent",
    installCmd: "pnpm install",
    offPathGlobalBin: null,
    ...overrides,
  });
  const section = (c: DoctorContext, running = "1.0.0", installKind?: "global" | "local") =>
    installSection(c, running, pkgPaths(installKind)).checks;
  const find = (checks: DoctorCheck[], re: RegExp) => checks.find((c) => re.test(c.label));
  const writeCliRecord = (record: Record<string, string>): void => {
    fs.mkdirSync(path.join(projectRoot, ".argent"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".argent", "cli.json"), JSON.stringify(record));
  };
  const writeFile = (rel: string): string => {
    const p = path.join(projectRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "");
    return p;
  };
  const installLocal = (dir: string, version: string): void => {
    const pkg = path.join(dir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version })
    );
  };

  beforeEach(() => vi.stubEnv("HOME", projectRoot));
  afterEach(() => vi.unstubAllEnvs());

  it("names the running install's kind and checks its engines", () => {
    fs.mkdirSync(pkgRoot(), { recursive: true });
    fs.writeFileSync(
      path.join(pkgRoot(), "package.json"),
      JSON.stringify({ name: "@swmansion/argent", engines: { node: ">=1" } })
    );
    const checks = section(ctx(), "1.0.0", "local");
    expect(checks[0]?.label).toBe("Running v1.0.0 (local install)");
    expect(find(checks, /^Node v/)).toMatchObject({ status: "ok" });
  });

  it("states each global install verdict", () => {
    expect(find(section(ctx()), /^No global install/)).toMatchObject({
      status: "info",
      label: "No global install on PATH",
    });
    const npm = {
      bin: "/g/bin/argent",
      root: "/g/lib/node_modules/@swmansion/argent",
      version: "1.0.0",
    };
    expect(find(section(ctx({ global: npm })), /Global install/)).toMatchObject({ status: "ok" });
    const failing = { bin: "/shims/argent", root: null, version: null, runError: "mise ERROR" };
    expect(find(section(ctx({ global: failing })), /fails to run/)).toMatchObject({
      status: "error",
      detail: "/shims/argent: mise ERROR",
      fix: expect.stringMatching(/npm i -g @swmansion\/argent/),
    });
  });

  it("skips the Dock note without launchd's PATH", () => {
    const global = { bin: "/Users/me/.nvm/bin/argent", root: null, version: "1.0.0" };
    expect(find(section(ctx({ global, guiPath: null })), /Dock/)).toBeUndefined();
    expect(find(section(ctx({ global, guiPath: "/usr/bin" })), /Dock/)?.status).toBe("info");
  });

  it("fails a declared local install that is not installed, with the project's install command", () => {
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      "﻿" + JSON.stringify({ devDependencies: { "@swmansion/argent": "0.30.0" } })
    );
    expect(find(section(ctx({ mode: "local" })), /not installed/)).toMatchObject({
      status: "error",
      fix: "pnpm install",
    });
  });

  it("does not count a stray copy above the project as its local install", () => {
    const app = path.join(projectRoot, "app");
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "app" }));
    installLocal(projectRoot, "1.0.0");
    const checks = installSection(
      ctx({ mode: "local", projectRoot: app }),
      "1.0.0",
      pkgPaths()
    ).checks;
    expect(find(checks, /not installed/)?.status).toBe("error");
  });

  it("warns about an older local install and passes a current one", () => {
    installLocal(projectRoot, "0.9.0");
    expect(find(section(ctx({ mode: "local" })), /local install/)).toMatchObject({
      status: "warn",
      label: "Project's local install v0.9.0 is older than v1.0.0",
    });
    expect(find(section(ctx({ mode: "local" }), "0.8.0"), /local install/)).toMatchObject({
      status: "ok",
      label: "Project local install v0.9.0 (package.json)",
    });
  });

  it("states each ~/.argent/cli.json verdict", () => {
    const missing = find(section(ctx({ mode: "local" })), /cli\.json/);
    expect(missing).toMatchObject({
      status: "warn",
      fix: "argent update (or start the MCP server once)",
    });

    const cli = writeFile("pkg/dist/cli.js");
    const node = writeFile("bin/node");
    writeCliRecord({ cli, node, version: "1.0.0", mode: "global" });
    expect(find(section(ctx()), /cli\.json/)).toMatchObject({
      status: "ok",
      label: "~/.argent/cli.json → v1.0.0",
    });

    const goneNode = path.join(projectRoot, ".nvm", "versions", "node", "v20.19.0", "bin", "node");
    writeCliRecord({ cli, node: goneNode, version: "1.0.0", mode: "global" });
    expect(find(section(ctx()), /cli\.json/)).toMatchObject({
      status: "warn",
      label: "~/.argent/cli.json points at a path that no longer exists",
      detail: "~/.nvm/versions/node/v20.19.0/bin/node",
      fix: "argent update (or start the MCP server once)",
    });
  });
});

describe("globalBehindCheck owners and modes", () => {
  it("names the package manager that owns a script shim", () => {
    const pnpm = { bin: "/Users/me/Library/pnpm/argent", root: null, version: "0.28.0" };
    expect(globalBehindCheck(pnpm, "0.30.1", "0.30.1")?.fix).toMatch(/^pnpm /);
  });
});
