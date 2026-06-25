import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { disable, enable, flags as flagsCmd } from "../src/flags.js";
import {
  getFlagsPath,
  isFlagEnabled,
  readFlags,
  setFlag,
  type FlagDefinition,
} from "@argent/configuration-core";

// Hermetic registry for the CLI tests so they never depend on which flags ship
// in the production FLAG_REGISTRY. enable()/flags() take an injectable registry
// for exactly this reason.
const TEST_REGISTRY: readonly FlagDefinition[] = [
  { name: "my-feature-flag", description: "Primary test flag." },
  { name: "proj-flag", description: "Project-scoped test flag." },
  { name: "g", description: "Global explicit-scope test flag." },
  { name: "after-dashdash", description: "Enabled after the -- separator." },
  { name: "x", description: "Round-trip test flag." },
  { name: "a", description: "Listing flag A." },
  { name: "b", description: "Listing flag B." },
];

// All tests redirect global+project storage into tmp dirs by mutating
// process.env.HOME (consumed by os.homedir()) and process.cwd().

let tmpHome: string;
let tmpProject: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalCwd: string;

beforeEach(() => {
  // realpath unwraps macOS's /var → /private/var tmpdir symlink so the path
  // we hand back from getFlagsPath matches what process.cwd() reports after
  // chdir().
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-flags-home-")));
  tmpProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-flags-proj-")));
  // Drop a marker so resolveProjectRoot stops here instead of walking up to
  // the actual user's repo and writing into it.
  fs.writeFileSync(path.join(tmpProject, "package.json"), "{}");

  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalCwd = process.cwd();
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.chdir(tmpProject);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpProject, { recursive: true, force: true });
});

interface CapturedConsole {
  stdout: string;
  stderr: string;
}

// Replaces console.log / console.error / process.exit with capturing stubs
// for the duration of `fn`. If `fn` throws (the process.exit stub throws
// `__test_exit_<code>` to escape the call site without killing the test
// runner), `expectExit` propagates the throw through `expect(...).toThrow`
// — the captured streams are returned either way.
function withMockedConsole(fn: () => void): { stdout: string; stderr: string; threw: unknown } {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  let stdout = "";
  let stderr = "";
  let threw: unknown = undefined;
  console.log = ((...args: unknown[]) => {
    stdout += args.join(" ") + "\n";
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    stderr += args.join(" ") + "\n";
  }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`__test_exit_${code ?? 0}`);
  }) as typeof process.exit;
  try {
    fn();
  } catch (err) {
    threw = err;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
  return { stdout, stderr, threw };
}

function captureConsole(fn: () => void): CapturedConsole {
  const { stdout, stderr, threw } = withMockedConsole(fn);
  if (threw !== undefined) throw threw as Error;
  return { stdout, stderr };
}

function expectExit(code: number, fn: () => void): CapturedConsole {
  const { stdout, stderr, threw } = withMockedConsole(fn);
  expect(threw).toBeInstanceOf(Error);
  expect((threw as Error).message).toBe(`__test_exit_${code}`);
  return { stdout, stderr };
}

describe("enable / disable CLI", () => {
  it("enable writes flag=true globally by default", () => {
    const out = captureConsole(() => enable(["my-feature-flag"], TEST_REGISTRY));
    expect(out.stdout).toContain('Enabled flag "my-feature-flag" (global)');
    expect(readFlags("global")).toEqual({ "my-feature-flag": true });
    expect(readFlags("project")).toEqual({});
  });

  it("disable removes the flag entry from the chosen scope", () => {
    setFlag("my-feature-flag", true, "global");
    const out = captureConsole(() => disable(["my-feature-flag"]));
    expect(out.stdout).toContain('Disabled flag "my-feature-flag" (global)');
    expect(readFlags("global")).toEqual({});
  });

  it("disable on an unset flag is a no-op (still succeeds)", () => {
    const out = captureConsole(() => disable(["never-set"]));
    expect(out.stdout).toContain('Disabled flag "never-set" (global)');
    expect(readFlags("global")).toEqual({});
  });

  it("--scope project targets project storage", () => {
    captureConsole(() => enable(["proj-flag", "--scope", "project"], TEST_REGISTRY));
    expect(readFlags("project")).toEqual({ "proj-flag": true });
    expect(readFlags("global")).toEqual({});
  });

  it("supports --scope=project syntax", () => {
    captureConsole(() => enable(["proj-flag", "--scope=project"], TEST_REGISTRY));
    expect(readFlags("project")).toEqual({ "proj-flag": true });
  });

  it("supports --scope=global syntax (explicit)", () => {
    captureConsole(() => enable(["g", "--scope=global"], TEST_REGISTRY));
    expect(readFlags("global")).toEqual({ g: true });
  });

  it("-- ends flag parsing and treats the next token as the flag name", () => {
    captureConsole(() => enable(["--", "after-dashdash"], TEST_REGISTRY));
    expect(readFlags("global")).toEqual({ "after-dashdash": true });
  });

  it("-- with no following positional still surfaces the usage error", () => {
    const out = expectExit(2, () => enable(["--"]));
    expect(out.stderr).toContain("Usage: argent enable <flag-name>");
  });

  it("rejects an invalid scope value", () => {
    const out = expectExit(2, () => enable(["x", "--scope", "everywhere"]));
    expect(out.stderr).toContain('--scope must be "project" or "global"');
  });

  it("requires a flag name", () => {
    const out = expectExit(2, () => enable([]));
    expect(out.stderr).toContain("Usage: argent enable <flag-name>");
  });

  it("rejects invalid flag names", () => {
    const out = expectExit(2, () => enable(["1-bad"]));
    expect(out.stderr).toContain('Invalid flag name "1-bad"');
  });

  it("rejects unknown flags", () => {
    const out = expectExit(2, () => enable(["good", "--bogus"]));
    expect(out.stderr).toContain("Unknown flag: --bogus");
  });

  it("rejects extra positional arguments", () => {
    const out = expectExit(2, () => enable(["a", "b"]));
    expect(out.stderr).toContain('Unexpected extra argument: "b"');
  });

  it("--help prints usage without writing anything", () => {
    const out = captureConsole(() => enable(["--help"]));
    expect(out.stdout).toContain("Usage: argent enable");
    expect(readFlags("global")).toEqual({});
  });

  it("--help lists every available flag with its description", () => {
    const out = captureConsole(() => enable(["--help"], TEST_REGISTRY));
    expect(out.stdout).toContain("Available flags:");
    expect(out.stdout).toContain("my-feature-flag");
    expect(out.stdout).toContain("Primary test flag.");
    expect(out.stdout).toContain("proj-flag");
    expect(out.stdout).toContain("Project-scoped test flag.");
    // -h is an alias for --help and shows the same listing.
    const short = captureConsole(() => disable(["-h"], TEST_REGISTRY));
    expect(short.stdout).toContain("Available flags:");
    expect(short.stdout).toContain("Listing flag A.");
    expect(readFlags("global")).toEqual({});
  });

  it("enable → disable round trip leaves a clean tree (no stub entry)", () => {
    captureConsole(() => enable(["x"], TEST_REGISTRY));
    captureConsole(() => disable(["x"]));
    expect(readFlags("global")).toEqual({});
    expect(fs.existsSync(getFlagsPath("global"))).toBe(false);
    expect(isFlagEnabled("x")).toBe(false);
  });

  it("rejects enabling a flag that is not in the registry", () => {
    const out = expectExit(2, () => enable(["not-registered"], TEST_REGISTRY));
    expect(out.stderr).toContain('Unknown feature flag "not-registered"');
    expect(out.stderr).toContain("argent flags");
    expect(readFlags("global")).toEqual({});
  });

  it("rejects enabling the legacy auto-shutdown flag name (never wired)", () => {
    // ARGENT_AUTO_SHUTDOWN stayed an env var (renamed), so `auto-shutdown` was
    // never added to the registry — `argent enable auto-shutdown` must fail.
    const out = expectExit(2, () => enable(["auto-shutdown"]));
    expect(out.stderr).toContain("Unknown feature flag");
    expect(readFlags("global")).toEqual({});
  });

  it("disable stays lenient — clears a stored flag that is not in the registry", () => {
    // Simulates a flag that was enabled once and later removed from the registry.
    setFlag("legacy", true, "global");
    const out = captureConsole(() => disable(["legacy"]));
    expect(out.stdout).toContain('Disabled flag "legacy" (global)');
    expect(readFlags("global")).toEqual({});
  });
});

describe("flags (list) CLI", () => {
  it("ships the argent-lens flag in the production registry", () => {
    // Guards the gate: setup-registry.ts reads isFlagEnabled("argent-lens"),
    // so that exact name must stay registered (and discoverable via `argent flags`).
    const out = captureConsole(() => flagsCmd([]));
    expect(out.stdout).toContain("argent-lens");
    expect(out.stdout).not.toContain("No feature flags are defined.");
  });

  it("lists every registry flag with its description and effective scope", () => {
    setFlag("a", true, "global");
    setFlag("b", true, "global");
    setFlag("b", false, "project");
    const out = captureConsole(() => flagsCmd([], TEST_REGISTRY));
    expect(out.stdout).toContain("Feature flags");
    // value + winning scope
    expect(out.stdout).toMatch(/a\s+enabled\s+\(global\)/);
    expect(out.stdout).toMatch(/b\s+disabled\s+\(project\)/);
    // descriptions are shown
    expect(out.stdout).toContain("Listing flag A.");
    expect(out.stdout).toContain("Listing flag B.");
  });

  it("shows unset registry flags as disabled (with no scope)", () => {
    // Nothing stored; every registry flag should still be listed as disabled.
    const out = captureConsole(() => flagsCmd([], TEST_REGISTRY));
    expect(out.stdout).toMatch(/my-feature-flag\s+disabled/);
    expect(out.stdout).toContain("Primary test flag.");
    expect(out.stdout).not.toContain("(global)");
    expect(out.stdout).not.toContain("(project)");
  });

  it("--json emits the raw scopes plus the registry view with descriptions", () => {
    setFlag("a", true, "global");
    setFlag("a", false, "project");
    const out = captureConsole(() => flagsCmd(["--json"], TEST_REGISTRY));
    const parsed = JSON.parse(out.stdout);
    // raw scope maps preserved for back-compat
    expect(parsed.global).toEqual({ a: true });
    expect(parsed.project).toEqual({ a: false });
    expect(parsed.effective).toEqual({ a: { value: false, scope: "project" } });
    expect(parsed.paths.global).toBe(getFlagsPath("global"));
    expect(parsed.paths.project).toBe(getFlagsPath("project"));
    // registry view carries description + resolved state
    const a = parsed.flags.find((f: { name: string }) => f.name === "a");
    expect(a).toEqual({
      name: "a",
      description: "Listing flag A.",
      enabled: false,
      scope: "project",
    });
    const unset = parsed.flags.find((f: { name: string }) => f.name === "my-feature-flag");
    expect(unset).toMatchObject({ enabled: false, scope: null });
  });

  it("--help prints usage", () => {
    const out = captureConsole(() => flagsCmd(["--help"]));
    expect(out.stdout).toContain("Usage: argent flags");
  });

  it("--help lists every available flag with its description", () => {
    const out = captureConsole(() => flagsCmd(["--help"], TEST_REGISTRY));
    expect(out.stdout).toContain("Available flags:");
    expect(out.stdout).toContain("my-feature-flag");
    expect(out.stdout).toContain("Primary test flag.");
    expect(out.stdout).toContain("Listing flag B.");
  });
});

describe("deprecating a flag (removed from FLAG_REGISTRY)", () => {
  // A flag that was enabled before being deprecated still lives in flags.json
  // but is absent from the registry. Loading/reading it must never throw.

  it("`argent flags` lists a deprecated stored flag under 'unrecognized' (no throw)", () => {
    setFlag("deprecated-flag", true, "global");
    let out!: CapturedConsole;
    expect(() => {
      out = captureConsole(() => flagsCmd([], TEST_REGISTRY));
    }).not.toThrow();
    expect(out.stdout).toContain("Stored but no longer recognized");
    expect(out.stdout).toMatch(/deprecated-flag\s+enabled\s+\(global\)/);
  });

  it("--json surfaces it under `unrecognized` and keeps it out of the registry view", () => {
    setFlag("deprecated-flag", true, "global");
    const out = captureConsole(() => flagsCmd(["--json"], TEST_REGISTRY));
    const parsed = JSON.parse(out.stdout);
    expect(parsed.unrecognized).toEqual([
      { name: "deprecated-flag", enabled: true, scope: "global" },
    ]);
    expect(parsed.global).toEqual({ "deprecated-flag": true });
    expect(
      parsed.flags.find((f: { name: string }) => f.name === "deprecated-flag")
    ).toBeUndefined();
  });

  it("an empty registry with stored flags still loads cleanly (nothing crashes or is hidden)", () => {
    setFlag("legacy-a", true, "global");
    setFlag("legacy-b", false, "project");
    const out = captureConsole(() => flagsCmd([], []));
    expect(out.stdout).toContain("No feature flags are defined.");
    expect(out.stdout).toContain("Stored but no longer recognized");
    expect(out.stdout).toMatch(/legacy-a\s+enabled\s+\(global\)/);
    expect(out.stdout).toMatch(/legacy-b\s+disabled\s+\(project\)/);
  });

  it("disable cleans up a deprecated flag and it leaves the listing", () => {
    setFlag("deprecated-flag", true, "global");
    captureConsole(() => disable(["deprecated-flag"])); // lenient — no registry needed
    expect(readFlags("global")).toEqual({});
    const out = captureConsole(() => flagsCmd([], TEST_REGISTRY));
    expect(out.stdout).not.toContain("deprecated-flag");
  });

  it("a deprecated flag with a prototype-style name still loads without error", () => {
    setFlag("toString", true, "global"); // valid per FLAG_NAME_RE, also on Object.prototype
    expect(() => captureConsole(() => flagsCmd([], TEST_REGISTRY))).not.toThrow();
    expect(isFlagEnabled("toString")).toBe(true);
    const out = captureConsole(() => flagsCmd(["--json"], TEST_REGISTRY));
    const parsed = JSON.parse(out.stdout);
    expect(parsed.unrecognized).toContainEqual({
      name: "toString",
      enabled: true,
      scope: "global",
    });
  });
});
