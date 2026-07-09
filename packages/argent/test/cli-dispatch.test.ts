import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// End-to-end tests for the installer-help guard in `main()`
// (packages/argent/src/cli.ts). `installerHelpRequested` itself is unit-tested
// in installer-help.test.ts, but the value with the highest regression cost is
// the WIRING: `main()` must consult the guard and return BEFORE the switch, so
// `argent uninstall --help` never reaches the real (config-deleting) installer.
// Moving that block below the switch, dropping its `return`, or removing it
// would keep every unit test green while re-opening #451 — so it needs a test
// that actually dispatches.
//
// cli.ts reads process.argv at load and self-invokes `main()`, so (as with the
// sibling dispatcher.test.ts) the only faithful way to exercise it is a real
// child process. We esbuild-transpile the real dispatcher and its runtime
// siblings into a staging dir — the workspace-package imports it carries are
// `import type` only, so they erase and no workspace build is required — then
// drop in FAKE lazily-loaded bundles. The fake installer records which entry
// point ran instead of deleting anything, so a test can assert the guard never
// reached it.

const SRC_DIR = path.resolve(import.meta.dirname, "../src");
// The dispatcher plus every sibling it imports at runtime. Their only non-node
// imports are `import type`, which esbuild strips.
const RUNTIME_SOURCES = ["cli.ts", "bundled-paths.ts", "fatal-handlers.ts", "installer-help.ts"];

let stageRoot = "";
let distDir = "";
let cliEntry = "";

// Every fake export records that it ran (and with which argv), so tests can
// assert both directions: the guard short-circuits BEFORE the installer loads,
// and non-installer commands still reach their own bundle un-intercepted.
const RECORD_SNIPPET = `
import { writeFileSync } from "node:fs";
function record(name, rest) {
  const marker = process.env.ARGENT_E2E_MARKER;
  const suffix = Array.isArray(rest) ? ":" + rest.join(" ") : "";
  if (marker) writeFileSync(marker, name + suffix);
}
`;

const FAKE_INSTALLER =
  RECORD_SNIPPET +
  ["init", "update", "uninstall"]
    .map((name) => `export function ${name}(rest) { record("${name}", rest); }`)
    .join("\n");

const FAKE_CLI_BUNDLE =
  RECORD_SNIPPET +
  [
    "startMcpServer",
    "tools",
    "run",
    "server",
    "lens",
    "link",
    "unlink",
    "enable",
    "disable",
    "flags",
    "telemetry",
  ]
    .map((name) => `export function ${name}(rest) { record("${name}", rest); }`)
    .join("\n");

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], markerPath: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: stageRoot,
      // stdin is /dev/null: a real interactive uninstall prompt would read EOF
      // here, so a regression can't silently hang the suite.
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ARGENT_E2E_MARKER: markerPath },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("exit", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

let markerCounter = 0;
/** A fresh marker path per case; the installer writes here iff it actually ran. */
function freshMarker(): string {
  markerCounter += 1;
  return path.join(stageRoot, `installer-ran-${markerCounter}`);
}

beforeAll(async () => {
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-cli-dispatch-"));
  distDir = path.join(stageRoot, "dist");
  cliEntry = path.join(distDir, "cli.js");
  fs.mkdirSync(distDir, { recursive: true });

  // A package.json so node loads dist/*.js as ESM (the package is type:module)
  // and getInstalledVersion() resolves a version two levels up from cli.js.
  fs.writeFileSync(
    path.join(stageRoot, "package.json"),
    JSON.stringify({ name: "argent-cli-dispatch-e2e", type: "module", version: "e2e-test" })
  );

  await esbuild.build({
    entryPoints: RUNTIME_SOURCES.map((f) => path.join(SRC_DIR, f)),
    outdir: distDir,
    format: "esm",
    platform: "node",
    target: "node20",
    bundle: false,
    logLevel: "silent",
  });

  fs.writeFileSync(path.join(distDir, "installer.mjs"), FAKE_INSTALLER);
  fs.writeFileSync(path.join(distDir, "mcp-server.mjs"), FAKE_CLI_BUNDLE);
  fs.writeFileSync(path.join(distDir, "cli-cmds.mjs"), FAKE_CLI_BUNDLE);
}, 60_000);

afterAll(() => {
  if (stageRoot) fs.rmSync(stageRoot, { recursive: true, force: true });
});

describe("cli dispatcher: installer-help guard", () => {
  it("control: `uninstall` (no help) DOES reach the installer", async () => {
    // Proves the fake wiring detects a real dispatch — without which the
    // guard tests below would be vacuously green.
    const marker = freshMarker();
    await runCli(["uninstall"], marker);
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(marker, "utf8")).toBe("uninstall:");
  });

  it("control: `uninstall --yes` (no help) still reaches the installer with its argv", async () => {
    // The bareword-help handling must not swallow a legitimate non-interactive
    // uninstall.
    const marker = freshMarker();
    await runCli(["uninstall", "--yes"], marker);
    expect(fs.readFileSync(marker, "utf8")).toBe("uninstall:--yes");
  });

  it("`uninstall --help` prints usage and never runs the installer", async () => {
    const marker = freshMarker();
    const { exitCode, stdout } = await runCli(["uninstall", "--help"], marker);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: argent uninstall");
    // The core guarantee: the destructive installer was never loaded/invoked.
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("`init --help` prints usage (with real options) and never runs the installer", async () => {
    const marker = freshMarker();
    const { exitCode, stdout } = await runCli(["init", "--help"], marker);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: argent init");
    expect(stdout).toContain("--from <path>");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("lenient help forms also short-circuit the destructive uninstall", async () => {
    // `--help=foo` / `--HELP` / `-help` / smart-dash `—help` / bareword `help`
    // are plausible fat-fingers on a command that deletes workspace config;
    // none may reach the installer.
    for (const args of [
      ["uninstall", "--help=foo"],
      ["uninstall", "--HELP"],
      ["uninstall", "-help"],
      ["uninstall", "—help"],
      ["uninstall", "help"],
    ]) {
      const marker = freshMarker();
      const { exitCode, stdout } = await runCli(args, marker);
      expect(exitCode, `${args.join(" ")} should exit 0`).toBe(0);
      expect(stdout, `${args.join(" ")} should print usage`).toContain("Usage: argent uninstall");
      expect(fs.existsSync(marker), `${args.join(" ")} must not run the installer`).toBe(false);
    }
  });

  it("`uninstall --yes help` prints usage instead of running a prompt-free uninstall", async () => {
    // The nastiest fallthrough: `--yes` makes the real uninstall
    // non-interactive, so before the bareword was honoured past the first
    // position this argv deleted workspace config with no prompt and no help.
    for (const args of [
      ["uninstall", "--yes", "help"],
      ["uninstall", "-y", "help"],
    ]) {
      const marker = freshMarker();
      const { exitCode, stdout } = await runCli(args, marker);
      expect(exitCode, `${args.join(" ")} should exit 0`).toBe(0);
      expect(stdout, `${args.join(" ")} should print usage`).toContain("Usage: argent uninstall");
      expect(fs.existsSync(marker), `${args.join(" ")} must not run the installer`).toBe(false);
    }
  });

  it("`init --from help` is NOT a help request — `help` is the --from value", async () => {
    const marker = freshMarker();
    const { exitCode } = await runCli(["init", "--from", "help"], marker);
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(marker, "utf8")).toBe("init:--from help");
  });

  it("`install --help` (alias) short-circuits and points at the aliased command", async () => {
    const marker = freshMarker();
    const { exitCode, stdout } = await runCli(["install", "--help"], marker);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Run `argent init --help`");
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("cli dispatcher: non-installer commands and top-level arms", () => {
  it("forwards `run <tool> --help` to the run bundle instead of intercepting it", async () => {
    // The complementary guarantee to the guard: a non-installer `--help`
    // belongs to the subcommand (`argent run <tool> --help` prints that
    // tool's flags), so the dispatcher must pass it through untouched.
    const marker = freshMarker();
    const { exitCode } = await runCli(["run", "gesture-tap", "--help"], marker);
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(marker, "utf8")).toBe("run:gesture-tap --help");
  });

  it("forwards `tools --help` to the tools bundle", async () => {
    const marker = freshMarker();
    const { exitCode } = await runCli(["tools", "--help"], marker);
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(marker, "utf8")).toBe("tools:--help");
  });

  it("top-level `--help` prints the command table without loading any bundle", async () => {
    const marker = freshMarker();
    const { exitCode, stdout } = await runCli(["--help"], marker);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: argent <command> [options]");
    // The installer rows come from INSTALLER_COMMAND_META (single source).
    expect(stdout).toContain("Initialize argent in the current workspace");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("an unknown command prints help and exits 1", async () => {
    const marker = freshMarker();
    const { exitCode, stdout } = await runCli(["frobnicate"], marker);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Usage: argent <command> [options]");
    expect(fs.existsSync(marker)).toBe(false);
  });
});
