import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  disable,
  enable,
  flags as flagsCmd,
  getFlagsPath,
  isFlagEnabled,
  readFlags,
  resolveProjectRoot,
  setFlag,
  unsetFlag,
} from "../src/flags.js";

// All tests redirect global+project storage into tmp dirs by mutating
// process.env.HOME (consumed by os.homedir()) and process.cwd().

let tmpHome: string;
let tmpProject: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalCwd: string;

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

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

describe("getFlagsPath", () => {
  it("defaults global path under ~/.argent/flags.json", () => {
    expect(getFlagsPath("global")).toBe(path.join(tmpHome, ".argent", "flags.json"));
  });

  it("project path lives at <project-root>/.argent/flags.json", () => {
    expect(getFlagsPath("project")).toBe(path.join(tmpProject, ".argent", "flags.json"));
  });

  it("respects explicit cwd / homeDir overrides", () => {
    const altHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "argent-flags-alt-home-"))
    );
    const altProj = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "argent-flags-alt-proj-"))
    );
    fs.writeFileSync(path.join(altProj, "package.json"), "{}");
    try {
      expect(getFlagsPath("global", { homeDir: altHome })).toBe(
        path.join(altHome, ".argent", "flags.json")
      );
      expect(getFlagsPath("project", { cwd: altProj })).toBe(
        path.join(altProj, ".argent", "flags.json")
      );
    } finally {
      fs.rmSync(altHome, { recursive: true, force: true });
      fs.rmSync(altProj, { recursive: true, force: true });
    }
  });
});

describe("resolveProjectRoot", () => {
  it("walks up to the nearest marker", () => {
    const nested = path.join(tmpProject, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveProjectRoot(nested)).toBe(tmpProject);
  });

  it("returns startDir when no marker exists in ancestry", () => {
    // A bare tmpdir guaranteed to have no project markers between it and /
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-flags-noroot-")));
    try {
      expect(resolveProjectRoot(bare)).toBe(bare);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it("treats existing .argent as a marker", () => {
    fs.rmSync(path.join(tmpProject, "package.json"));
    const argentDir = path.join(tmpProject, ".argent");
    fs.mkdirSync(argentDir);
    const nested = path.join(tmpProject, "sub");
    fs.mkdirSync(nested);
    expect(resolveProjectRoot(nested)).toBe(tmpProject);
  });

  it("treats existing .git as a marker", () => {
    fs.rmSync(path.join(tmpProject, "package.json"));
    fs.mkdirSync(path.join(tmpProject, ".git"));
    const nested = path.join(tmpProject, "sub");
    fs.mkdirSync(nested);
    expect(resolveProjectRoot(nested)).toBe(tmpProject);
  });
});

describe("setFlag / unsetFlag / readFlags", () => {
  it("writes the flag to disk and reads it back", () => {
    setFlag("alpha", true, "global");
    expect(readFlags("global")).toEqual({ alpha: true });

    const file = readJsonFile(getFlagsPath("global"));
    expect(file).toEqual({ flags: { alpha: true } });
  });

  it("preserves other flags when setting one", () => {
    setFlag("alpha", true, "global");
    setFlag("beta", false, "global");
    expect(readFlags("global")).toEqual({ alpha: true, beta: false });
  });

  it("overwrites a flag with a new value", () => {
    setFlag("alpha", true, "global");
    setFlag("alpha", false, "global");
    expect(readFlags("global")).toEqual({ alpha: false });
  });

  it("unsetFlag removes the entry and reports whether it existed", () => {
    setFlag("alpha", true, "global");
    setFlag("beta", true, "global");
    expect(unsetFlag("alpha", "global")).toBe(true);
    expect(readFlags("global")).toEqual({ beta: true });
    expect(unsetFlag("missing", "global")).toBe(false);
  });

  it("removes the file (and empty .argent dir) when the last flag is unset", () => {
    setFlag("alpha", true, "global");
    unsetFlag("alpha", "global");
    expect(fs.existsSync(getFlagsPath("global"))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, ".argent"))).toBe(false);
  });

  it("keeps the .argent dir when sibling state lives next to flags.json", () => {
    setFlag("alpha", true, "global");
    const sibling = path.join(tmpHome, ".argent", "tool-server.json");
    fs.writeFileSync(sibling, "{}");
    unsetFlag("alpha", "global");
    expect(fs.existsSync(getFlagsPath("global"))).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, ".argent"))).toBe(true);
  });

  it("project + global live in separate files", () => {
    setFlag("alpha", true, "global");
    setFlag("alpha", false, "project");
    expect(readFlags("global")).toEqual({ alpha: true });
    expect(readFlags("project")).toEqual({ alpha: false });
  });

  it("recovers from malformed JSON by treating storage as empty", () => {
    const file = getFlagsPath("global");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not json");
    expect(readFlags("global")).toEqual({});
    setFlag("alpha", true, "global");
    expect(readFlags("global")).toEqual({ alpha: true });
  });

  it("ignores non-boolean values in the stored flags object", () => {
    const file = getFlagsPath("global");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ flags: { real: true, bogus: "yes", numeric: 1, nested: {} } })
    );
    expect(readFlags("global")).toEqual({ real: true });
  });

  it("treats missing .argent dir as empty without throwing", () => {
    expect(readFlags("global")).toEqual({});
    expect(readFlags("project")).toEqual({});
  });

  it("writes are atomic — no .tmp leftover in the .argent dir", () => {
    setFlag("alpha", true, "global");
    setFlag("beta", true, "global");
    const dir = path.join(tmpHome, ".argent");
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("isFlagEnabled", () => {
  it("returns false for an unknown flag", () => {
    expect(isFlagEnabled("unknown")).toBe(false);
  });

  it("project value overrides global value (explicit false masks global true)", () => {
    setFlag("alpha", true, "global");
    setFlag("alpha", false, "project");
    expect(isFlagEnabled("alpha")).toBe(false);

    setFlag("beta", false, "global");
    setFlag("beta", true, "project");
    expect(isFlagEnabled("beta")).toBe(true);
  });

  it("falls through to global when project does not set it", () => {
    setFlag("alpha", true, "global");
    expect(isFlagEnabled("alpha")).toBe(true);
  });

  it("falls through to project-only when global is unset", () => {
    setFlag("alpha", true, "project");
    expect(isFlagEnabled("alpha")).toBe(true);
  });
});

describe("prototype-named flags (Object.prototype keys)", () => {
  // FLAG_NAME_RE allows names like "toString"/"constructor"/"valueOf", which
  // also exist on Object.prototype. A naive `name in obj` check would treat
  // these as set (returning a truthy prototype member) even when storage is
  // empty — these guard that hasOwn semantics are used throughout.
  const protoNames = ["toString", "constructor", "valueOf", "hasOwnProperty"];

  for (const name of protoNames) {
    it(`isFlagEnabled("${name}") is false (and a real boolean) when unset`, () => {
      const result = isFlagEnabled(name);
      expect(result).toBe(false);
      expect(typeof result).toBe("boolean");
    });

    it(`unsetFlag("${name}") on storage without it returns false and is a no-op`, () => {
      setFlag("real", true, "global");
      expect(unsetFlag(name, "global")).toBe(false);
      expect(readFlags("global")).toEqual({ real: true });
    });

    it(`enable/disable round trip works for a flag literally named "${name}"`, () => {
      setFlag(name, true, "global");
      expect(readFlags("global")).toEqual({ [name]: true });
      expect(isFlagEnabled(name)).toBe(true);
      expect(unsetFlag(name, "global")).toBe(true);
      expect(isFlagEnabled(name)).toBe(false);
    });
  }
});

// ── CLI ──────────────────────────────────────────────────────────────────────

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
  if (threw !== undefined) throw threw;
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
    const out = captureConsole(() => enable(["my-feature-flag"]));
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
    captureConsole(() => enable(["proj-flag", "--scope", "project"]));
    expect(readFlags("project")).toEqual({ "proj-flag": true });
    expect(readFlags("global")).toEqual({});
  });

  it("supports --scope=project syntax", () => {
    captureConsole(() => enable(["proj-flag", "--scope=project"]));
    expect(readFlags("project")).toEqual({ "proj-flag": true });
  });

  it("supports --scope=global syntax (explicit)", () => {
    captureConsole(() => enable(["g", "--scope=global"]));
    expect(readFlags("global")).toEqual({ g: true });
  });

  it("-- ends flag parsing and treats the next token as the flag name", () => {
    captureConsole(() => enable(["--", "after-dashdash"]));
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

  it("enable → disable round trip leaves a clean tree (no stub entry)", () => {
    captureConsole(() => enable(["x"]));
    captureConsole(() => disable(["x"]));
    expect(readFlags("global")).toEqual({});
    expect(fs.existsSync(getFlagsPath("global"))).toBe(false);
    expect(isFlagEnabled("x")).toBe(false);
  });
});

describe("flags (list) CLI", () => {
  it("prints a friendly empty message when nothing is set", () => {
    const out = captureConsole(() => flagsCmd([]));
    expect(out.stdout).toContain("No flags set.");
    expect(out.stdout).toContain(getFlagsPath("global"));
    expect(out.stdout).toContain(getFlagsPath("project"));
  });

  it("lists effective values with the winning scope", () => {
    setFlag("a", true, "global");
    setFlag("b", true, "global");
    setFlag("b", false, "project");
    const out = captureConsole(() => flagsCmd([]));
    expect(out.stdout).toContain("Effective flags");
    expect(out.stdout).toMatch(/a\s+enabled\s+\(global\)/);
    expect(out.stdout).toMatch(/b\s+disabled\s+\(project\)/);
  });

  it("--json emits structured data with both scopes", () => {
    setFlag("a", true, "global");
    setFlag("a", false, "project");
    setFlag("c", true, "project");
    const out = captureConsole(() => flagsCmd(["--json"]));
    const parsed = JSON.parse(out.stdout);
    expect(parsed.global).toEqual({ a: true });
    expect(parsed.project).toEqual({ a: false, c: true });
    expect(parsed.effective).toEqual({
      a: { value: false, scope: "project" },
      c: { value: true, scope: "project" },
    });
    expect(parsed.paths.global).toBe(getFlagsPath("global"));
    expect(parsed.paths.project).toBe(getFlagsPath("project"));
  });

  it("--help prints usage", () => {
    const out = captureConsole(() => flagsCmd(["--help"]));
    expect(out.stdout).toContain("Usage: argent flags");
  });
});
