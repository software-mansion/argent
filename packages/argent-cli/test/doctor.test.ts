import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listBundledSkills, RULES_DIR } from "@argent/installer";
import {
  childFailureReason,
  classifyMcpEntry,
  depsProbeFailure,
  editorsSection,
  findGlobalArgent,
  globalBinDirOf,
  globalPackageManagerOf,
  isStrictJson,
  platformChecks,
  redactUrl,
  remoteCheck,
  renderDoctorReport,
  skillsSection,
  stripPackageBinDirs,
  type DoctorContext,
  type DoctorReport,
  type EntryContext,
} from "../src/doctor.js";

/**
 * `argent doctor` is only useful if its verdicts match what actually happens
 * when an editor spawns the MCP entry or a tool needs a host binary. These pin
 * the verdicts; collection itself reuses probes tested elsewhere.
 */

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-"));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function ctx(overrides: Partial<EntryContext> = {}): EntryContext {
  return {
    scope: "project",
    projectRoot,
    cwd: projectRoot,
    globalOnPath: true,
    localInstalled: false,
    argentCmd: "argent",
    installCmd: "pnpm install",
    ...overrides,
  };
}

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("classifyMcpEntry", () => {
  it("accepts bare `argent mcp` when argent is on PATH", () => {
    expect(classifyMcpEntry({ command: "argent", args: ["mcp"] }, ctx()).status).toBe("ok");
  });

  it("fails bare `argent mcp` when argent is not on PATH", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"] },
      ctx({ globalOnPath: false })
    );
    expect(result.status).toBe("error");
    expect(result.fix).toContain("argent init");
  });

  it("only warns when custom env may make `argent` resolve inside the editor", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"], env: { PATH: "/custom/bin" } },
      ctx({ globalOnPath: false })
    );
    expect(result.status).toBe("warn");
  });

  it("does not count the legacy ARGENT_MCP_LOG env as a customization", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"], env: { ARGENT_MCP_LOG: "/tmp/x.log" } },
      ctx({ globalOnPath: false })
    );
    expect(result.status).toBe("error");
  });

  it("checks a local-mode `node <path>` entry against the project root", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    const entry = { command: "node", args: [rel, "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");

    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  it("requires a local install for npx and yarn entries", () => {
    for (const entry of [
      { command: "npx", args: ["--no-install", "argent", "mcp"] },
      { command: "yarn", args: ["argent", "mcp"] },
    ]) {
      const missing = classifyMcpEntry(entry, ctx());
      expect(missing).toMatchObject({ status: "error", fix: "pnpm install" });
      expect(classifyMcpEntry(entry, ctx({ localInstalled: true })).status).toBe("ok");
    }
  });

  it("accepts an on-demand npx entry without a local install", () => {
    const entry = { command: "npx", args: ["-y", "@swmansion/argent@latest", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  it("fails entries that don't end in `mcp`", () => {
    for (const entry of [
      { command: "argent", args: [] },
      { command: "argent", args: ["server", "start"] },
      { command: "node", args: ["node_modules/@swmansion/argent/dist/cli.js"] },
      { command: "npx", args: ["--no-install", "argent"] },
    ]) {
      expect(classifyMcpEntry(entry, ctx({ localInstalled: true })).status).toBe("error");
    }
  });

  it("warns about an entry switched off in the editor", () => {
    const entry = { command: "argent", args: ["mcp"], switchedOffBy: "disabled" as const };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("warn");
  });

  it("skips node flags to find the script", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    const entry = { command: "node", args: ["--no-warnings", rel, "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  it("does not judge a path that uses an editor variable", () => {
    const entry = {
      command: "node",
      args: ["${workspaceFolder}/node_modules/@swmansion/argent/dist/cli.js", "mcp"],
    };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("info");
  });

  it("checks that an absolute command exists", () => {
    const missing = { command: path.join(projectRoot, "bin", "argent"), args: ["mcp"] };
    expect(classifyMcpEntry(missing, ctx({ globalOnPath: false })).status).toBe("error");

    fs.mkdirSync(path.join(projectRoot, "bin"));
    fs.writeFileSync(missing.command, "");
    expect(classifyMcpEntry(missing, ctx({ globalOnPath: false })).status).toBe("ok");
  });

  it("points a dead project-dependency path at the project's install command", () => {
    const entry = { command: "node", args: ["node_modules/@swmansion/argent/dist/cli.js", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).fix).toMatch(/^Point the entry/);
    fs.writeFileSync(path.join(projectRoot, "package.json"), "{}");
    expect(classifyMcpEntry(entry, ctx()).fix).toBe("pnpm install");
  });

  it("flags an unparseable entry", () => {
    expect(classifyMcpEntry({ command: "", args: [] }, ctx()).status).toBe("warn");
  });

  it("does not judge a custom command", () => {
    expect(classifyMcpEntry({ command: "argent-dev", args: [] }, ctx()).status).toBe("info");
  });
});

type HostDeps = Parameters<typeof platformChecks>[0];

function hostDeps(overrides: Partial<HostDeps> = {}): HostDeps {
  return {
    platform: "darwin",
    deps: [
      { dep: "xcrun", path: "/usr/bin/xcrun", hint: "install xcode" },
      { dep: "adb", path: "/sdk/platform-tools/adb", hint: "install adb" },
      { dep: "emulator", path: "/sdk/emulator/emulator", hint: "install emulator" },
      { dep: "vega", path: null, hint: "install vega" },
    ],
    bundled: [{ name: "simulator-server", path: "/pkg/bin/darwin/simulator-server" }],
    signing: { teamIdEnv: null, detectedTeams: 1 },
    xcode: { developerDir: "/Applications/Xcode.app/Contents/Developer", simctl: true },
    ...overrides,
  };
}

describe("platformChecks", () => {
  it("reports a missing optional toolchain as info with its install hint", () => {
    const vega = platformChecks(hostDeps(), "reinstall").find((c) => c.label.startsWith("Vega"));
    expect(vega).toMatchObject({ status: "info", fix: "install vega" });
  });

  it("warns, without failing, when only Chromium is usable", () => {
    const none = hostDeps({
      deps: [
        { dep: "xcrun", path: null, hint: "install xcode" },
        { dep: "adb", path: null, hint: "install adb" },
        { dep: "emulator", path: null, hint: "install emulator" },
        { dep: "vega", path: null, hint: "install vega" },
      ],
    });
    const checks = platformChecks(none, "reinstall");
    expect(checks[0]).toMatchObject({ status: "warn" });
    expect(checks.some((c) => c.status === "error")).toBe(false);
    expect(platformChecks(hostDeps(), "reinstall").some((c) => c.status === "warn")).toBe(false);
  });

  it("does not count the /usr/bin/xcrun shim without simctl as iOS support", () => {
    const shimOnly = hostDeps({
      deps: [
        { dep: "xcrun", path: "/usr/bin/xcrun", hint: "install xcode" },
        { dep: "adb", path: null, hint: "install adb" },
        { dep: "emulator", path: null, hint: "install emulator" },
        { dep: "vega", path: null, hint: "install vega" },
      ],
      xcode: { developerDir: "/Library/Developer/CommandLineTools", simctl: false },
    });
    const checks = platformChecks(shimOnly, "reinstall");
    expect(checks.some((c) => c.status === "ok" && c.label === "iOS simulator")).toBe(false);
    expect(checks[0]?.label).toMatch(/No mobile platform toolchain/);
  });

  it("needs adb for Vega", () => {
    const vegaOnly = (adb: string | null) =>
      hostDeps({
        platform: "linux",
        signing: null,
        xcode: null,
        deps: [
          { dep: "xcrun", path: null, hint: "install xcode" },
          { dep: "adb", path: adb, hint: "install adb" },
          { dep: "emulator", path: null, hint: "install emulator" },
          { dep: "vega", path: "/home/me/vega/bin/vega", hint: "install vega" },
        ],
      });
    const withoutAdb = platformChecks(vegaOnly(null), "reinstall");
    expect(withoutAdb.find((c) => c.label.startsWith("Vega"))).toMatchObject({
      status: "warn",
      fix: "install adb",
    });
    expect(withoutAdb[0]?.label).toMatch(/No mobile platform toolchain/);
    const withAdb = platformChecks(vegaOnly("/sdk/adb"), "reinstall");
    expect(withAdb.find((c) => c.label.startsWith("Vega"))?.status).toBe("ok");
    expect(withAdb.some((c) => c.status === "warn")).toBe(false);
  });

  it("errors when a bundled artifact is missing (a broken install)", () => {
    const broken = hostDeps({
      bundled: [{ name: "simulator-server", path: null, error: "not found" }],
    });
    const checks = platformChecks(broken, "reinstall");
    expect(checks[0]).toMatchObject({
      status: "error",
      label: "Bundled simulator-server is missing",
      fix: "reinstall",
    });
    expect(checks.some((c) => c.label === "iOS simulator")).toBe(false);
  });

  it("skips iOS off macOS", () => {
    const linux = platformChecks(
      hostDeps({ platform: "linux", signing: null, xcode: null }),
      "reinstall"
    );
    expect(linux.find((c) => c.label.startsWith("iOS"))?.status).toBe("info");
    expect(linux.some((c) => c.label.startsWith("Physical iPhone"))).toBe(false);
  });
});

describe("renderDoctorReport", () => {
  it("prints fixes for problems but not for passing checks", () => {
    const report: DoctorReport = {
      version: "1.0.0",
      node: "24.0.0",
      platform: "darwin arm64",
      projectRoot,
      errors: 1,
      warnings: 0,
      sections: [
        {
          title: "Editors (MCP config)",
          checks: [
            { status: "ok", label: "Claude Code: argent mcp", fix: "never shown" },
            { status: "error", label: "Cursor: argent mcp", fix: "argent init" },
          ],
        },
      ],
    };
    const out = renderDoctorReport(report);
    expect(out).toContain("argent init");
    expect(out).not.toContain("never shown");
    expect(out).toContain("1 error, 0 warnings");
  });
});

describe("stripPackageBinDirs", () => {
  const d = path.delimiter;

  it("drops the node_modules/.bin dirs npx and npm scripts prepend", () => {
    const input = [
      "/app/pkg/node_modules/.bin",
      "/app/node_modules/.bin/",
      "/node_modules/.bin",
      "/opt/homebrew/bin",
      "/usr/bin",
    ].join(d);
    expect(stripPackageBinDirs(input, "/app/pkg")).toBe(["/opt/homebrew/bin", "/usr/bin"].join(d));
  });

  it("keeps a global bin that happens to be a node_modules/.bin (Yarn classic)", () => {
    const yarnGlobal = "/home/me/.config/yarn/global/node_modules/.bin";
    const input = [yarnGlobal, "/app/node_modules/.bin-tools"].join(d);
    expect(stripPackageBinDirs(input, "/app")).toBe(input);
  });
});

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

describe("remoteCheck", () => {
  it("tells a rejected token apart from a dead server", () => {
    expect(remoteCheck(200, "http://h:1", "link").status).toBe("ok");
    expect(remoteCheck(401, "http://h:1", "link").label).toMatch(/rejects the token/);
    expect(remoteCheck(null, "http://h:1", "link").label).toMatch(/unreachable/);
  });

  it("doesn't suggest argent unlink when the URL comes from ARGENT_TOOLS_URL", () => {
    expect(remoteCheck(null, "http://h:1", "env").fix).toMatch(/unset ARGENT_TOOLS_URL/);
    expect(remoteCheck(null, "http://h:1", "link").fix).toMatch(/argent unlink/);
  });
});

describe("childFailureReason", () => {
  it("picks the error line out of a Node crash dump", () => {
    const stderr = [
      "node:internal/modules/cjs/loader:1228",
      "  throw err;",
      "  ^",
      "",
      "Error: Cannot find module '@argent/registry'",
      "Require stack:",
      "- /pkg/dist/tool-server.cjs",
      "",
      "Node.js v24.21.0",
    ].join("\n");
    expect(childFailureReason(stderr, "Command failed")).toBe(
      "Error: Cannot find module '@argent/registry'"
    );
  });

  it("uses a plain stderr message as is", () => {
    expect(childFailureReason("keychain locked\n", "Command failed")).toBe("keychain locked");
  });

  it("falls back to the exec error when stderr is empty", () => {
    expect(childFailureReason("", "Command failed: node x --check-deps")).toBe(
      "Command failed: node x --check-deps"
    );
  });
});

describe("classifyMcpEntry argument rules", () => {
  it("accepts arguments after `mcp`, which the CLI ignores", () => {
    expect(classifyMcpEntry({ command: "argent", args: ["mcp", "--stdio"] }, ctx()).status).toBe(
      "ok"
    );
    expect(classifyMcpEntry({ command: "argent", args: ["--x", "mcp"] }, ctx()).status).toBe(
      "error"
    );
  });

  it("fails a node entry whose existing script is not followed by `mcp`", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    expect(classifyMcpEntry({ command: "node", args: [rel] }, ctx()).status).toBe("error");
    expect(classifyMcpEntry({ command: "node", args: [rel, "server"] }, ctx()).status).toBe(
      "error"
    );
  });

  it("resolves a project entry's script against the project root, a global one against cwd", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    const cwd = path.join(projectRoot, "src");
    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    fs.mkdirSync(cwd);
    const entry = { command: "node", args: [rel, "mcp"] };
    expect(classifyMcpEntry(entry, ctx({ cwd })).status).toBe("ok");
    expect(classifyMcpEntry(entry, ctx({ cwd, scope: "global" })).status).toBe("error");
  });

  it("does not treat `npx --no-install @swmansion/argent` as fetched on demand", () => {
    for (const flag of ["--no-install", "--no"]) {
      const entry = { command: "npx", args: [flag, "@swmansion/argent", "mcp"] };
      expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
    }
  });

  it("does not treat a yarn entry as fetched on demand", () => {
    const entry = { command: "yarn", args: ["@swmansion/argent@latest", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
  });

  it("resolves a relative command path instead of looking `argent` up on PATH", () => {
    const entry = { command: "./node_modules/.bin/argent", args: ["mcp"] };
    expect(classifyMcpEntry(entry, ctx({ globalOnPath: true })).status).toBe("error");
    fs.mkdirSync(path.join(projectRoot, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "node_modules", ".bin", "argent"), "");
    expect(classifyMcpEntry(entry, ctx({ globalOnPath: false })).status).toBe("ok");
  });

  it("treats `argent.cmd` as argent only on Windows", () => {
    const entry = { command: "argent.cmd", args: ["mcp"] };
    withPlatform("linux", () => expect(classifyMcpEntry(entry, ctx()).status).toBe("info"));
    withPlatform("win32", () => expect(classifyMcpEntry(entry, ctx()).status).toBe("ok"));
  });

  it("points a broken Claude Code local-scope entry at claude mcp remove", () => {
    const result = classifyMcpEntry({ command: "argent", args: [] }, ctx({ claudeLocal: true }));
    expect(result.fix).toMatch(/claude mcp remove -s local argent/);
  });

  it("still fails a dead entry that is switched off", () => {
    const entry = { command: "argent", args: ["mcp"], switchedOffBy: "enabled" as const };
    expect(classifyMcpEntry(entry, ctx({ globalOnPath: false })).status).toBe("error");
  });

  it("names the off-PATH bin dir of a global install", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"] },
      ctx({ globalOnPath: false, offPathGlobalBin: "/opt/npm-global/bin" })
    );
    expect(result.fix).toBe("Add /opt/npm-global/bin to PATH");
  });
});

describe("platformChecks details", () => {
  const ctOnly = (xcode: HostDeps["xcode"], platform: NodeJS.Platform = "darwin") =>
    hostDeps({
      platform,
      xcode,
      deps: [
        { dep: "xcrun", path: platform === "darwin" ? "/usr/bin/xcrun" : null, hint: "x" },
        { dep: "adb", path: null, hint: "install adb" },
        { dep: "emulator", path: null, hint: "install emulator" },
        { dep: "vega", path: null, hint: "install vega" },
      ],
    });
  const clt = "/Library/Developer/CommandLineTools";

  it("reports a developer dir without simctl as info, not as an error", () => {
    const checks = platformChecks(ctOnly({ developerDir: clt, simctl: false }), "reinstall");
    expect(checks.find((c) => c.label.startsWith("iOS simulator"))?.status).toBe("info");
    expect(checks.some((c) => c.status === "error")).toBe(false);
  });

  it("does not pass a physical iPhone without full Xcode", () => {
    const checks = platformChecks(ctOnly({ developerDir: clt, simctl: false }), "reinstall");
    expect(checks.find((c) => c.label.startsWith("Physical iPhone"))).toMatchObject({
      status: "info",
      label: expect.stringMatching(/needs full Xcode/),
    });
  });

  it("blames DEVELOPER_DIR when it selects the developer dir", () => {
    const ios = platformChecks(
      ctOnly({ developerDir: clt, simctl: false, fromEnv: true }),
      "reinstall"
    ).find((c) => c.label.startsWith("iOS simulator"));
    expect(ios?.detail).toMatch(/from DEVELOPER_DIR/);
    expect(ios?.fix).toMatch(/Unset DEVELOPER_DIR/);
  });

  it("does not offer Xcode off macOS, nor Vega without adb", () => {
    const linux = platformChecks(ctOnly(null, "linux"), "reinstall")[0]!;
    expect(linux.fix).not.toMatch(/Xcode/);
    const mac = platformChecks(ctOnly({ developerDir: clt, simctl: false }), "reinstall")[0]!;
    expect(mac.fix).toMatch(/Android platform-tools \(Android, and Vega with the Vega SDK\)/);
  });

  it("lists the ports Chromium discovery probes", () => {
    const label = (ports?: number[]) =>
      platformChecks(hostDeps({ chromiumPorts: ports }), "r").find((c) =>
        c.label.startsWith("Chromium")
      )?.label;
    expect(label([9222, 9333])).toBe("Chromium: probes CDP ports 9222, 9333");
    expect(label(undefined)).toBe("Chromium: probes CDP port 9222");
  });

  it("names a bundled binary that is not executable", () => {
    const checks = platformChecks(
      hostDeps({ bundled: [{ name: "ax-service", path: null, error: "not executable: /x" }] }),
      "reinstall"
    );
    expect(checks[0]?.label).toBe("Bundled ax-service is not executable");
  });

  it("points at the Apple Development certificate step", () => {
    const checks = platformChecks(
      hostDeps({ signing: { teamIdEnv: null, detectedTeams: 0 } }),
      "r"
    );
    expect(checks.find((c) => c.label.startsWith("Physical iPhone"))?.fix).toMatch(
      /Manage Certificates > \+ > Apple Development/
    );
  });
});

describe("remote tool-server", () => {
  it("does not call a non-2xx answer reachable", () => {
    const result = remoteCheck(404, "http://h:1/", "env");
    expect(result.status).toBe("error");
    expect(result.label).toMatch(/HTTP 404/);
  });

  it("never prints a token from the URL", () => {
    expect(redactUrl("argent://secret-token@127.0.0.1:47611")).not.toContain("secret-token");
    expect(remoteCheck(null, "http://user:pw@h:1", "env").label).not.toMatch(/user|pw/);
    expect(redactUrl("http://h:1/")).toBe("http://h:1/");
  });
});

describe("depsProbeFailure", () => {
  it("reports only execFile's own kill as a timeout", () => {
    expect(depsProbeFailure({ killed: true, signal: "SIGTERM" })).toMatch(/timed out/);
    const crash = depsProbeFailure({
      killed: false,
      signal: "SIGABRT",
      stderr: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n",
    });
    expect(crash).not.toMatch(/timed out/);
    expect(crash).toMatch(/SIGABRT.*heap out of memory/);
  });
});

describe("renderDoctorReport warnings", () => {
  it("prints the fix under a warning", () => {
    const out = renderDoctorReport({
      version: "1.0.0",
      node: "24.0.0",
      platform: "darwin arm64",
      projectRoot,
      errors: 0,
      warnings: 1,
      sections: [
        {
          title: "Skills & rules",
          checks: [{ status: "warn", label: "Rules missing", fix: "do-it" }],
        },
      ],
    });
    expect(out).toContain("do-it");
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

describe("isStrictJson", () => {
  it("rejects what Claude Code can't parse, but allows a BOM", () => {
    const file = path.join(projectRoot, "x.json");
    for (const [text, ok] of [
      ['{"a":1}', true],
      ['﻿{"a":1}', true],
      ['{"a":1,}', false],
      ['{"a":1 // c\n}', false],
    ] as const) {
      fs.writeFileSync(file, text);
      expect(isStrictJson(file)).toBe(ok);
    }
  });
});

describe("editor and skill sections", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-home-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const doctorCtx = (): DoctorContext => ({
    projectRoot,
    cwd: projectRoot,
    mode: "global",
    global: { bin: "/usr/local/bin/argent", root: null, version: null },
    argentCmd: "argent",
    installCmd: "npm install",
    offPathGlobalBin: null,
  });
  const writeJson = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const localScope = (servers: unknown, extra: Record<string, unknown> = {}) =>
    writeJson(path.join(home, ".claude.json"), {
      projects: { [projectRoot]: { mcpServers: servers, ...extra } },
    });
  const argent = { command: "argent", args: ["mcp"] };

  it("judges a VS Code user-profile entry when there is no workspace entry", () => {
    const userDir =
      process.platform === "darwin"
        ? path.join(home, "Library", "Application Support", "Code", "User")
        : path.join(home, ".config", "Code", "User");
    writeJson(path.join(userDir, "mcp.json"), { servers: { argent } });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.startsWith("VS Code"))?.status).toBe("ok");
    expect(checks.some((c) => c.status === "error")).toBe(false);
  });

  it("does not fail a Claude Code project entry that a local-scope entry outranks", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), {
      mcpServers: { argent: { command: "/nonexistent/argent", args: ["mcp"] } },
    });
    localScope({ argent });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.some((c) => c.status === "error")).toBe(false);
    expect(checks.find((c) => c.label.includes("/nonexistent/argent"))?.label).toMatch(
      /unused: the local-scope entry wins/
    );
  });

  it("flags a .mcp.json Claude Code cannot parse", () => {
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      '{"mcpServers":{"argent":{"command":"argent","args":["mcp"]}},}'
    );
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.status === "error")?.label).toMatch(/not valid JSON/);
    expect(checks.some((c) => c.label === "Claude Code: argent mcp")).toBe(false);
  });

  it("ignores a leftover /mcp toggle when Claude Code has no argent entry", () => {
    writeJson(path.join(home, ".claude.json"), {
      projects: { [projectRoot]: { disabledMcpServers: ["argent"] } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.some((c) => c.label.includes("switched off"))).toBe(false);
  });

  it("ignores a switch-off key the editor does not honour", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), {
      mcpServers: { argent: { ...argent, disabled: true } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.startsWith("Claude Code"))?.status).toBe("ok");
  });

  const installSkills = (dir: string) => {
    for (const skill of listBundledSkills())
      fs.mkdirSync(path.join(dir, skill), { recursive: true });
  };

  it("finds skills for a Claude Code local-scope entry", () => {
    localScope({ argent });
    installSkills(path.join(projectRoot, ".claude", "skills"));
    const checks = skillsSection(doctorCtx(), "reinstall").checks;
    expect(checks[0]?.status).toBe("ok");
  });

  it("does not count .agents/skills for Claude Code", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent } });
    installSkills(path.join(projectRoot, ".agents", "skills"));
    const checks = skillsSection(doctorCtx(), "reinstall").checks;
    expect(checks[0]).toMatchObject({ status: "error", label: "No argent skills installed" });
  });

  it("accepts Claude Code rules from either scope", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent } });
    installSkills(path.join(home, ".claude", "skills"));
    const rules = path.join(home, ".claude", "rules");
    fs.mkdirSync(rules, { recursive: true });
    for (const f of fs.readdirSync(RULES_DIR))
      fs.copyFileSync(path.join(RULES_DIR, f), path.join(rules, f));
    const checks = skillsSection(doctorCtx(), "reinstall").checks;
    expect(checks.every((c) => c.status === "ok")).toBe(true);
  });
});
