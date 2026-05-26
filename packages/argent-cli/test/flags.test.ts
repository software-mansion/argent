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
});

describe("setFlag / readFlags", () => {
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
});

describe("isFlagEnabled", () => {
  it("returns false for an unknown flag", () => {
    expect(isFlagEnabled("unknown")).toBe(false);
  });

  it("project value overrides global value", () => {
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

// ── CLI ──────────────────────────────────────────────────────────────────────

interface CapturedConsole {
  stdout: string;
  stderr: string;
}

function captureConsole(fn: () => void): CapturedConsole {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  let stdout = "";
  let stderr = "";
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
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
  return { stdout, stderr };
}

function expectExit(code: number, fn: () => void): CapturedConsole {
  // Can't use captureConsole + expect().toThrow() — the assignment never
  // completes when the right-hand side throws, leaving `captured` undefined.
  // Inline the capture so we always get the buffered stdout/stderr back.
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  let stdout = "";
  let stderr = "";
  console.log = ((...args: unknown[]) => {
    stdout += args.join(" ") + "\n";
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    stderr += args.join(" ") + "\n";
  }) as typeof console.error;
  process.exit = ((c?: number) => {
    throw new Error(`__test_exit_${c ?? 0}`);
  }) as typeof process.exit;
  try {
    expect(fn).toThrow(`__test_exit_${code}`);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
  return { stdout, stderr };
}

describe("enable / disable CLI", () => {
  it("enable writes flag=true globally by default", () => {
    const out = captureConsole(() => enable(["my-feature-flag"]));
    expect(out.stdout).toContain('Enabled flag "my-feature-flag" (global)');
    expect(readFlags("global")).toEqual({ "my-feature-flag": true });
    expect(readFlags("project")).toEqual({});
  });

  it("disable writes flag=false globally by default", () => {
    const out = captureConsole(() => disable(["my-feature-flag"]));
    expect(out.stdout).toContain('Disabled flag "my-feature-flag" (global)');
    expect(readFlags("global")).toEqual({ "my-feature-flag": false });
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

  it("toggling disable after enable in the same scope flips the boolean", () => {
    captureConsole(() => enable(["x"]));
    captureConsole(() => disable(["x"]));
    expect(readFlags("global")).toEqual({ x: false });
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
