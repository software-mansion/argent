import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { execFileSync } from "node:child_process";
import { resolveInstallableUpdateTarget } from "@argent/installer";
import {
  collectDoctorReport,
  doctor,
  doctorExitCode,
  globalReinstallCommand,
  renderDoctorReport,
  stripPackageBinDirs,
  updateCommand,
} from "../src/doctor.js";
import { localReinstallCommand } from "../src/doctor-install.js";
import { type DoctorReport, permissionFix } from "../src/doctor-shared.js";

vi.mock("@argent/installer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/installer")>()),
  resolveInstallableUpdateTarget: vi.fn(async () => null),
}));

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
    expect(out).toContain("v1.0.0 · node v24.0.0 · darwin arm64");
    expect(out.split("\n")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Editors (MCP config)"),
        expect.stringMatching(/^ {2}\S*✓\S* Claude Code: argent mcp$/),
        expect.stringMatching(/^ {2}\S*✗\S* Cursor: argent mcp$/),
      ])
    );
  });

  it("escapes control characters that come from editor configs", () => {
    const out = renderDoctorReport({
      version: "1.0.0",
      node: "24.0.0",
      platform: "darwin arm64",
      projectRoot,
      errors: 0,
      warnings: 0,
      sections: [
        {
          title: "Tool-server",
          checks: [
            {
              status: "error",
              label: "Linked to http://h/x\r\u001b[2K  ✓ fake row\nnext",
              detail: "\u001b[8m",
              fix: "a\u009bb",
            },
          ],
        },
      ],
    });
    for (const raw of ["\r", "\u009b", "\u001b[2K", "\u001b[8m"]) {
      expect(out).not.toContain(raw);
    }
    expect(out).toContain("http://h/x\\x0d\\x1b[2K  ✓ fake row\\x0anext");
  });
});

describe("doctorExitCode", () => {
  it("fails only on errors, as the help promises warnings don't affect it", () => {
    expect(doctorExitCode({ errors: 0, warnings: 3 })).toBe(0);
    expect(doctorExitCode({ errors: 1, warnings: 0 })).toBe(1);
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

  it("drops a Windows-style node_modules\\.bin", () => {
    // No drive letter: its colon is POSIX's PATH delimiter.
    const input = ["\\proj\\node_modules\\.bin", "/usr/bin"].join(d);
    expect(stripPackageBinDirs(input, "\\proj")).toBe("/usr/bin");
  });

  it("keeps a global bin that happens to be a node_modules/.bin (Yarn classic)", () => {
    const yarnGlobal = "/home/me/.config/yarn/global/node_modules/.bin";
    const input = [yarnGlobal, "/app/node_modules/.bin-tools"].join(d);
    expect(stripPackageBinDirs(input, "/app")).toBe(input);
  });
});

describe.skipIf(process.platform === "win32")("permissionFix", () => {
  it("only chmods a path the user owns, and quotes it", () => {
    const file = path.join(projectRoot, "My Proj", ".mcp.json");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "{}", { mode: 0o000 });
    expect(permissionFix(file, "u+r")).toBe(`chmod u+r '${file}'`);
  });

  it("chowns a path someone else owns before the chmod", () => {
    expect(permissionFix("/", "u+rwx", { recursive: true })).toBe(
      `sudo chown -R "$USER" '/' && chmod u+rwx '/'`
    );
  });
});

describe("reinstall commands", () => {
  it("forces the install where a plain one skips a damaged package dir", () => {
    const local = (pm: "npm" | "pnpm" | "yarn" | "bun") =>
      localReinstallCommand(pm, projectRoot, "/proj/node_modules/@swmansion/argent", "x install");
    expect(local("pnpm")).toBe("pnpm install --force");
    expect(local("bun")).toBe("bun install --force");
    expect(local("yarn")).toBe("yarn install --force");
    expect(local("npm")).toBe("delete /proj/node_modules/@swmansion/argent, then x install");
    fs.writeFileSync(path.join(projectRoot, ".yarnrc.yml"), "nodeLinker: node-modules\n");
    expect(local("yarn")).toMatch(/^delete .*, then x install$/);
  });

  it("forces bun's global reinstall", () => {
    expect(globalReinstallCommand("bun")).toBe("bun add -g @swmansion/argent --force");
    expect(globalReinstallCommand("npm")).toBe("npm install -g @swmansion/argent");
  });
});

describe("updateCommand", () => {
  it("uses the owning package manager for a non-npm global install", () => {
    expect(updateCommand(false, "pnpm", "argent")).toMatch(
      /^pnpm add -g @swmansion\/argent@latest/
    );
    expect(updateCommand(false, "npm", "argent")).toBe("argent update");
    expect(updateCommand(true, "pnpm", "npx argent")).toBe("npx argent update");
  });
});

describe("collectDoctorReport", () => {
  let home: string;
  let originalCwd: string;
  let server: http.Server | null = null;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-home-"));
    originalCwd = process.cwd();
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubEnv("ARGENT_TOOLS_URL", "");
    fs.mkdirSync(path.join(projectRoot, ".git"));
    process.chdir(projectRoot);
  });

  afterEach(() => {
    server?.close();
    server = null;
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const collect = (
    installKind?: "local" | "global",
    { pkg = path.join(home, "pkg"), offline = true } = {}
  ) =>
    collectDoctorReport({
      paths: {
        bundlePath: path.join(pkg, "dist", "tool-server.cjs"),
        simulatorServerDir: path.join(pkg, "bin"),
        nativeDevtoolsDir: path.join(pkg, "dylibs"),
        version: "1.0.0",
        installKind,
      },
      offline,
    });
  const section = (report: DoctorReport, title: string) =>
    report.sections.find((s) => s.title === title)!.checks;
  const toolServer = async () => section(await collect(), "Tool-server");
  const depsCheckFix = (report: DoctorReport) =>
    section(report, "Platforms").find((c) => /dependency check/.test(c.label))?.fix;
  const writeShim = (dir: string, body: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "argent"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  const gitInit = (dir: string) =>
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  const declareArgent = () =>
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ devDependencies: { "@swmansion/argent": "0.30.0" } })
    );

  it("does not take ~ for the project just because ~/.claude exists", async () => {
    fs.rmSync(path.join(projectRoot, ".git"), { recursive: true });
    const app = path.join(home, "work", "myapp");
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(path.join(home, ".claude"));
    process.chdir(app);
    expect((await collect()).projectRoot).toBe(fs.realpathSync(app));
  });

  it("does not take ~ for the project when ~ is itself a git repo", async () => {
    fs.rmSync(path.join(projectRoot, ".git"), { recursive: true });
    gitInit(home);
    const app = path.join(home, "work", "myapp");
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(path.join(home, ".claude"));
    process.chdir(app);
    expect((await collect()).projectRoot).toBe(fs.realpathSync(app));
  });

  it("reports this run's version, Node, platform, project and every section", async () => {
    const report = await collect();
    expect(report).toMatchObject({
      version: "1.0.0",
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
      projectRoot: fs.realpathSync(projectRoot),
    });
    expect(report.sections.map((s) => s.title)).toEqual([
      "Install",
      "Editors (MCP config)",
      "Skills & rules",
      "Tool-server",
      "Platforms",
      "Other",
    ]);
  });

  it("looks up Claude Code's and Codex's project config at the git root above a package", async () => {
    fs.rmSync(path.join(projectRoot, ".git"), { recursive: true });
    gitInit(projectRoot);
    const root = fs.realpathSync(projectRoot);
    const pkg = path.join(root, "packages", "app");
    fs.mkdirSync(path.join(pkg, ".vscode"), { recursive: true });
    fs.mkdirSync(path.join(pkg, "src"));
    const argent = { command: "argent", args: ["mcp"] };
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ projects: { [root]: { mcpServers: { argent } } } })
    );
    fs.mkdirSync(path.join(root, ".codex"));
    fs.writeFileSync(
      path.join(root, ".codex", "config.toml"),
      '[mcp_servers.argent]\ncommand = "argent"\nargs = ["mcp"]\n'
    );
    process.chdir(path.join(pkg, "src"));
    const report = await collect();
    expect(report.projectRoot).toBe(pkg);
    expect(section(report, "Editors (MCP config)").map((c) => c.label)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Claude Code: argent mcp/),
        expect.stringMatching(/^Codex: argent mcp/),
      ])
    );
  });

  it.skipIf(process.platform === "win32")(
    "does not take the project's own node_modules/.bin argent for a global install",
    async () => {
      const projectBin = path.join(fs.realpathSync(projectRoot), "node_modules", ".bin");
      writeShim(projectBin, "echo 9.9.9");
      vi.stubEnv("PATH", `${projectBin}:/usr/bin:/bin`);
      const report = await collect();
      expect(section(report, "Install").map((c) => c.label)).toContain("No global install on PATH");
      expect(
        section(report, "Editors (MCP config)").find((c) => /not configured/.test(c.label))?.fix
      ).toBe("npx @swmansion/argent init");
    }
  );

  it.skipIf(process.platform === "win32")(
    "runs a global shim from the project root, on the PATH an editor sees",
    async () => {
      const shims = path.join(home, "shims");
      const root = fs.realpathSync(projectRoot);
      writeShim(
        shims,
        `case "$PATH" in *node_modules/.bin*) exit 1 ;; esac\n[ "$(pwd -P)" = "${root}" ] && echo 2.0.0 || exit 2`
      );
      vi.stubEnv("PATH", `${path.join(root, "node_modules", ".bin")}:${shims}:/usr/bin:/bin`);
      fs.mkdirSync(path.join(projectRoot, "src"));
      process.chdir(path.join(projectRoot, "src"));
      const labels = section(await collect(), "Install").map((c) => c.label);
      expect(labels).toContain("Global install v2.0.0 on PATH");
    }
  );

  it.skipIf(process.platform !== "darwin")(
    "notes a global bin dir that apps started from the Dock don't get",
    async () => {
      const shims = path.join(home, "shims");
      writeShim(shims, "echo 2.0.0");
      vi.stubEnv("PATH", `${shims}:/usr/bin:/bin`);
      const labels = section(await collect(), "Install").map((c) => c.label);
      expect(labels).toContain("Apps started from the Dock don't get this shell's PATH");
    }
  );

  it("spells fixes as `yarn argent` in a Yarn PnP project", async () => {
    fs.writeFileSync(path.join(projectRoot, ".pnp.cjs"), "");
    declareArgent();
    const fixes = (await collect()).sections.flatMap((s) => s.checks.map((c) => c.fix ?? ""));
    expect(fixes).toContain("yarn argent init");
    expect(fixes.filter((f) => f.startsWith("npx "))).toEqual([]);
  });

  it("asks a pnpm project that declares argent to install it with pnpm", async () => {
    fs.writeFileSync(path.join(projectRoot, "pnpm-lock.yaml"), "");
    declareArgent();
    expect(
      section(await collect(), "Install").find((c) => /not installed/.test(c.label))
    ).toMatchObject({ status: "error", fix: "pnpm install" });
  });

  it("reinstalls the running copy where it lives, with the package manager that owns it", async () => {
    expect(depsCheckFix(await collect("local"))).toBe(
      "Reinstall argent: delete ~/pkg, then npm install"
    );
    const pnpmGlobal = path.join(home, "Library", "pnpm", "global", "5", "node_modules");
    expect(
      depsCheckFix(await collect("global", { pkg: path.join(pnpmGlobal, "@swmansion", "argent") }))
    ).toBe("Reinstall argent: pnpm add -g @swmansion/argent");
  });

  it("checks for updates with the package manager that owns the running copy", async () => {
    fs.writeFileSync(path.join(projectRoot, "pnpm-lock.yaml"), "");
    await collect("local", { offline: false });
    expect(vi.mocked(resolveInstallableUpdateTarget)).toHaveBeenLastCalledWith(
      "pnpm",
      "1.0.0",
      expect.anything()
    );
    const bunGlobal = path.join(home, ".bun", "install", "global", "node_modules");
    await collect("global", { pkg: path.join(bunGlobal, "@swmansion", "argent"), offline: false });
    expect(vi.mocked(resolveInstallableUpdateTarget)).toHaveBeenLastCalledWith(
      "bun",
      "1.0.0",
      expect.anything()
    );
  });

  it("checks the tool-server an entry points at through its own env", async () => {
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          argent: {
            command: "argent",
            args: ["mcp"],
            env: { ARGENT_TOOLS_URL: "http://127.0.0.1:1" },
          },
        },
      })
    );
    const checks = await toolServer();
    expect(checks.find((c) => c.label.startsWith("Claude Code entry"))).toMatchObject({
      status: "error",
      label: expect.stringMatching(/unreachable/),
    });
  });

  it("skips Platforms when every entry the editors start points at a remote tool-server", async () => {
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          argent: {
            command: "argent",
            args: ["mcp"],
            env: { ARGENT_TOOLS_URL: "http://127.0.0.1:1" },
          },
        },
      })
    );
    const platforms = (await collect()).sections.find((s) => s.title === "Platforms")!;
    expect(platforms.checks).toEqual([
      expect.objectContaining({ status: "info", label: expect.stringMatching(/^Skipped/) }),
    ]);
  });

  it("keeps Platforms when another editor still starts the local tool-server", async () => {
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          argent: {
            command: "argent",
            args: ["mcp"],
            env: { ARGENT_TOOLS_URL: "http://127.0.0.1:1" },
          },
        },
      })
    );
    fs.mkdirSync(path.join(projectRoot, ".cursor"));
    fs.writeFileSync(
      path.join(projectRoot, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { argent: { command: "argent", args: ["mcp"] } } })
    );
    const platforms = section(await collect(), "Platforms");
    expect(platforms.map((c) => c.label)).not.toContainEqual(expect.stringMatching(/^Skipped/));
  });

  it("vouches for a `yarn dlx` entry only when packageManager names Yarn 2 or later", async () => {
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: { argent: { command: "yarn", args: ["dlx", "@swmansion/argent", "mcp"] } },
      })
    );
    const dlxEntry = async (packageManager: string) => {
      fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ packageManager }));
      return section(await collect(), "Editors (MCP config)").find((c) =>
        c.label.startsWith("Claude Code: yarn dlx")
      );
    };
    expect((await dlxEntry("yarn@1.22.22"))?.status).toBe("info");
    expect((await dlxEntry("yarn@4.5.0"))?.status).toBe("ok");
  });

  it("prints the usage instead of the report for an unknown option", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
    try {
      process.exitCode = undefined;
      const pkg = path.join(home, "pkg");
      const paths = {
        bundlePath: path.join(pkg, "dist", "tool-server.cjs"),
        simulatorServerDir: path.join(pkg, "bin"),
        nativeDevtoolsDir: path.join(pkg, "dylibs"),
        version: "1.0.0",
      };
      await doctor(["--josn"], { paths });
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/^Unknown option: --josn\n/));
      expect(log).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it("exits 1 on a failed check and on an unknown option", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
    const pkg = path.join(home, "pkg");
    const paths = {
      bundlePath: path.join(pkg, "dist", "tool-server.cjs"),
      simulatorServerDir: path.join(pkg, "bin"),
      nativeDevtoolsDir: path.join(pkg, "dylibs"),
      version: "1.0.0",
    };
    try {
      process.exitCode = undefined;
      await doctor(["--bogus"], { paths });
      expect(process.exitCode).toBe(1);

      process.exitCode = undefined;
      await doctor(["--offline", "--json"], { paths });
      const report = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as DoctorReport;
      expect(report.errors).toBeGreaterThan(0);
      expect(process.exitCode).toBe(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      process.exitCode = undefined;
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it("rejects an argent:// pairing string in ARGENT_TOOLS_URL", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", "argent://pair?token=x");
    expect((await toolServer())[0]).toMatchObject({
      status: "error",
      label: expect.stringMatching(/pairing string/),
      fix: "Unset ARGENT_TOOLS_URL and run npx @swmansion/argent link <the argent:// string>",
    });
  });

  it("rejects an entry's ARGENT_TOOLS_URL the tools client can't fetch from", async () => {
    const entryUrls = [
      ["argent://tok@127.0.0.1:47999", /pairing string/],
      ["127.0.0.1:47999", /not an http/],
      ["http://user:secret@127.0.0.1:47999", /carries credentials/],
    ] as const;
    for (const [url, reason] of entryUrls) {
      fs.writeFileSync(
        path.join(projectRoot, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            argent: { command: "argent", args: ["mcp"], env: { ARGENT_TOOLS_URL: url } },
          },
        })
      );
      const entry = (await toolServer()).find((c) => c.label.startsWith("Claude Code entry"));
      expect(entry).toMatchObject({ status: "error", label: expect.stringMatching(reason) });
      expect(entry?.detail).not.toMatch(/tok|secret/);
    }
  });

  it("probes a linked URL without its trailing slash, like the tools client", async () => {
    server = http.createServer((req, res) => {
      res.statusCode = req.url === "/tools" ? 200 : 404;
      res.end("[]");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    vi.stubEnv("ARGENT_TOOLS_URL", `http://127.0.0.1:${port}/`);
    expect((await toolServer())[0]?.label).toMatch(/, reachable$/);
  });

  it("offers pnpm's forced reinstall for a broken local install in a pnpm project", async () => {
    fs.writeFileSync(path.join(projectRoot, "pnpm-lock.yaml"), "");
    const report = await collect("local");
    const failed = report.sections
      .find((s) => s.title === "Platforms")!
      .checks.find((c) => /dependency check/.test(c.label));
    expect(failed?.fix).toBe("Reinstall argent: pnpm install --force");
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
