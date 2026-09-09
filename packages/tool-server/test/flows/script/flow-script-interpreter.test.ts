import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The POSIX fixed locations, taken away. Both exist on an ordinary POSIX host,
 * so the "no bash anywhere" message can be reached no other way — and
 * `vi.spyOn` cannot reach an ESM namespace, which is why this is a module mock
 * rather than a spy.
 */
let hideFixedLocations = false;
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const statSync = ((target: fs.PathLike, options?: unknown) => {
    if (hideFixedLocations && (target === "/bin/bash" || target === "/usr/bin/bash")) {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    }
    return (actual.statSync as (t: fs.PathLike, o?: unknown) => fs.Stats)(target, options);
  }) as typeof actual.statSync;
  return { ...actual, statSync, default: { ...actual, statSync } };
});

/**
 * Finding bash, on every host. The `where` / `command -v` call is injected the
 * way `command-on-path.test.ts` injects it, so the Windows rules — the WSL
 * launcher under `%SystemRoot%`, the Git-derived fallback — are exercised on
 * POSIX CI as well as natively on the Windows runner.
 */
const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const result = execFileMock(cmd, args);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bashSearchPath,
  resolveBashInterpreter,
} from "../../../src/tools/flows/script/flow-script-interpreter";

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

const roots: string[] = [];

/**
 * A scratch directory for whatever fixtures a case writes — a fake bash, a
 * shim, a directory to put on PATH — plus `config` written to the GLOBAL config
 * file inside this test's own home.
 *
 * The global file, because `scripts.bash` takes that scope alone: the project a
 * flow sits in has no say in which bash runs it, so there is no project config
 * for the resolver to read and no anchor for it to read one against.
 */
function hostWith(config: Record<string, unknown> | undefined): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bash-host-"));
  roots.push(dir);
  if (config) pinGlobalConfig(config);
  return dir;
}

/** Write `config` to the global config file inside this test's own home. */
function pinGlobalConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.join(home, ".argent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".argent", "config.json"), JSON.stringify(config), "utf8");
}

/** The project config file a committed value would sit in — read by nothing. */
function committedProjectConfig(dir: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, ".argent"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".argent", "config.json"), JSON.stringify(config), "utf8");
}

function notBash(dir: string, name = "bash"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
  return file;
}

/**
 * A shell that is not bash, answering the probe the way zsh, ksh and dash do:
 * the marker, and an empty `$BASH_VERSION` after it. Written rather than taken
 * from the host, because which of those three a machine has varies and the
 * answer under test does not.
 */
function emptyVersionShell(dir: string, name = "shell"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\nprintf '\\n%s%s\\n' 'argent-bash-version:' ''\n");
  fs.chmodSync(file, 0o755);
  return file;
}

/**
 * A real bash, found without the resolver under test. The resolver runs each
 * candidate once and refuses one that prints no `$BASH_VERSION`, so a written
 * stand-in would be refused for a reason the tests below are not about.
 */
function hostBash(): string | undefined {
  const candidates =
    realPlatform === "win32"
      ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]
      : ["/bin/bash", "/usr/bin/bash"];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/**
 * The same line `test/helpers/host-bash.ts` draws, drawn here separately
 * because the helper asks the resolver under test and this file may not. A
 * missing bash is a skip on a developer machine and a FAILURE on CI: `skipIf`
 * reports skipped and exits 0, so a runner that found none would take the five
 * cases below green having asserted nothing — on Windows, the platform they
 * were listed for.
 */
const hostBashPath = hostBash();
if (hostBashPath === undefined && process.env.CI) {
  throw new Error(
    "This CI host has no bash at any of the fixed locations, so every case gated on one " +
      "in this file would be skipped."
  );
}

const withBash = it.skipIf(hostBashPath === undefined);

/**
 * A home directory of the test's own. The resolver reads `scripts.bash` from
 * the global scope, and `test/setup/clear-argent-env.ts` strips `ARGENT_*`
 * variables and not `~/.argent/config.json` — so on a machine whose owner took
 * this feature's own advice and pinned a bash globally, the fixtures below were
 * read past and two of these tests failed. The global scope lives under the
 * home directory, which is the one place a test can move it.
 */
let home: string;
let realHome: { HOME?: string; USERPROFILE?: string };

beforeEach(() => {
  execFileMock.mockReset();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bash-home-"));
  realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  hideFixedLocations = false;
  for (const [name, value] of Object.entries(realHome)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
  setPlatform(realPlatform);
  vi.restoreAllMocks();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("scripts.bash, read from the global config file", () => {
  withBash("honours a configured path and never looks at PATH", async () => {
    const configured = hostBash()!;
    hostWith({ scripts: { bash: configured } });

    expect(await resolveBashInterpreter()).toEqual({ path: configured });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  // The value is an absolute path judged against `process.platform`, so no one
  // spelling suits a mixed-OS team. Read from a project file it travelled to a
  // host that cannot spawn it: with a Windows teammate's committed value, every
  // `.sh` step on a Mac refused with "is not an absolute path" and there was no
  // PATH fallback, because the key was set. `readScopeValue` gates reads on a
  // key's `scopes`, so the file below is not read at all.
  withBash("ignores a value committed to the project file", async () => {
    const configured = hostBash()!;
    const dir = hostWith({ scripts: { bash: configured } });
    committedProjectConfig(dir, {
      scripts: { bash: "C:\\Program Files\\Git\\bin\\bash.exe" },
    });
    const realCwd = process.cwd();
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      expect(await resolveBashInterpreter()).toEqual({ path: configured });
    } finally {
      vi.spyOn(process, "cwd").mockReturnValue(realCwd);
    }
  });

  it("refuses a relative value rather than falling through to PATH", async () => {
    hostWith({ scripts: { bash: "bin/bash" } });
    const found = await resolveBashInterpreter();

    expect("path" in found).toBe(false);
    expect((found as { problem: string }).problem).toContain("scripts.bash");
    expect((found as { problem: string }).problem).toContain("not an absolute path");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  // `readScopeValue` hands back `undefined` for a value its `parse` rejected,
  // which is indistinguishable from an absent key — so a value the schema threw
  // away would fall through to PATH and run the step under a bash that happens
  // to exist on this machine, which is the outcome `scripts.bash` exists to
  // prevent.
  it("refuses an empty value rather than reading it as an absent key", async () => {
    hostWith({ scripts: { bash: "   " } });
    const found = await resolveBashInterpreter();

    expect("path" in found).toBe(false);
    expect((found as { problem: string }).problem).toContain("is empty");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("refuses a value that is not a string, naming what it found", async () => {
    hostWith({ scripts: { bash: 123 } });
    const found = await resolveBashInterpreter();

    expect((found as { problem: string }).problem).toContain("scripts.bash = 123");
    expect((found as { problem: string }).problem).toContain("not an absolute path");
  });

  it("names the global file, never the project the step ran in", async () => {
    const dir = hostWith({ scripts: { bash: "bin/bash" } });
    committedProjectConfig(dir, { scripts: { bash: "bin/bash" } });
    const found = await resolveBashInterpreter();

    expect((found as { problem: string }).problem).toContain(
      path.join(home, ".argent", "config.json")
    );
    expect((found as { problem: string }).problem).not.toContain(
      path.join(dir, ".argent", "config.json")
    );
  });

  // One scope, so unsetting the file the message names really does fall through
  // to PATH. While the key took both, that advice was true only where a single
  // scope held a value: over a global pin, following it swapped the interpreter
  // silently and the next failure no longer mentioned `scripts.bash` at all.
  it("says unsetting it falls through to PATH, with no second file to name", async () => {
    const dir = hostWith({ scripts: { bash: path.join("bin", "bash") } });
    committedProjectConfig(dir, { scripts: { bash: "/project/bin/bash" } });

    const problem = (await resolveBashInterpreter()) as { problem: string };

    expect(problem.problem).toContain("unset it to use the one on this host's PATH");
    expect(problem.problem).not.toContain("unset it in both files");
    expect(problem.problem).not.toContain("/project/bin/bash");
  });

  it("names the global file when the value came from there", async () => {
    const root = hostWith(undefined);
    fs.mkdirSync(path.join(home, ".argent"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".argent", "config.json"),
      JSON.stringify({ scripts: { bash: path.join(home, "no-such-global-bash") } })
    );

    const found = await resolveBashInterpreter();
    const problem = (found as { problem: string }).problem;
    expect(problem).toContain(path.join(home, ".argent", "config.json"));
    expect(problem).not.toContain(path.join(root, ".argent", "config.json"));
  });

  it("refuses a configured path that does not exist", async () => {
    const root = hostWith(undefined);
    const missing = path.join(root, "no-such-bash");
    pinGlobalConfig({ scripts: { bash: missing } });
    const found = await resolveBashInterpreter();

    expect((found as { problem: string }).problem).toContain("does not exist");
    expect((found as { problem: string }).problem).toContain(missing);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a configured path that is not executable",
    async () => {
      const root = hostWith(undefined);
      const file = path.join(root, "readable-bash");
      fs.writeFileSync(file, "");
      fs.chmodSync(file, 0o644);
      pinGlobalConfig({ scripts: { bash: file } });

      const found = await resolveBashInterpreter();
      expect((found as { problem: string }).problem).toContain("is not executable");
    }
  );

  // Every static check passes for an executable file that is not a shell, and
  // the three properties after them hide it: the parent seeds $ARGENT_OUTPUT,
  // the child's output is discarded, and an exit code of 0 is a pass. So a
  // wrapper that forgets to forward its arguments would report every `.sh` step
  // green while running none of them.
  it("refuses a configured interpreter that answers with no $BASH_VERSION", async () => {
    const root = hostWith(undefined);
    const stub = notBash(root);
    pinGlobalConfig({ scripts: { bash: stub } });

    const found = await resolveBashInterpreter();
    expect("path" in found).toBe(false);
    expect((found as { problem: string }).problem).toContain("is not a bash");
    expect((found as { problem: string }).problem).toContain(stub);
  });

  // The version after the marker is the whole of what separates bash from the
  // shells that would run the file with different word-splitting and array
  // semantics. They answer the probe with the marker and nothing after it, and
  // accepting one would report every `.sh` step green while running none of
  // them: it never reads the file, so the parent reads back the document it
  // seeded and the exit code is 0.
  it.skipIf(realPlatform === "win32")(
    "refuses a shell that answers the marker with an empty version",
    async () => {
      const root = hostWith(undefined);
      const shell = emptyVersionShell(root);
      pinGlobalConfig({ scripts: { bash: shell } });

      const found = await resolveBashInterpreter();
      expect("path" in found).toBe(false);
      expect((found as { problem: string }).problem).toContain("printed no $BASH_VERSION");
    }
  );

  // A window on the candidate's output is a window the answer falls out of,
  // whichever end it is on, and a wrapper prints on both: one that greets
  // before `exec`ing a real bash, and one that RUNS bash and then prints - to
  // clean up, or to exit with bash's own status. A head window lost the first
  // past 4 KiB; a tail window lost the second at 4059 trailing characters and
  // took 4058, deterministically.
  const onWrapper = it.skipIf(realPlatform === "win32" || hostBashPath === undefined);
  const WRAPPERS = [
    ["greets before it execs a real bash", `printf '%s\\n' '<noise>'\nexec <bash> "$@"`],
    ["runs a real bash and prints after it", `<bash> "$@"\nst=$?\nprintf '%s' '<noise>'\nexit $st`],
  ] as const;
  for (const [at, [shape, body]] of WRAPPERS.entries()) {
    onWrapper(`reads the version of a candidate that ${shape}`, async () => {
      const root = hostWith(undefined);
      const wrapper = path.join(root, `wrapping-bash-${at}`);
      fs.writeFileSync(
        wrapper,
        `#!/bin/sh\n${body.replaceAll("<noise>", "B".repeat(64 * 1024)).replaceAll("<bash>", hostBashPath!)}\n`
      );
      fs.chmodSync(wrapper, 0o755);
      pinGlobalConfig({ scripts: { bash: wrapper } });

      expect(await resolveBashInterpreter()).toEqual({ path: wrapper });
    });
  }

  // The guard is a comparison of strings, and Windows gives one file several
  // names. `\\?\` is the extended-length prefix, which `path.resolve` keeps —
  // so the resolved path never matched the plain `%SystemRoot%`.
  it("refuses the extended-length spelling of the same WSL launcher", async () => {
    setPlatform("win32");
    hostWith({
      scripts: { bash: "\\\\?\\C:\\Windows\\System32\\bash.exe" },
    });
    const found = await resolveBashInterpreter();

    expect((found as { problem: string }).problem).toContain("WSL");
  });

  // `path.win32.isAbsolute` accepts a path with no drive, and the two processes
  // that read it are not on the same one: the tool server stats it against its
  // own working directory, and the runner spawns it against project_root.
  // A POSIX path is the value this branch sees most often - it is what `argent
  // config set` stored before the write gate applied the same rule - so the
  // sentence has to describe the leading forward slash as well as the backslash.
  it.each([
    ["a path rooted on no drive", "\\Windows\\System32\\bash.exe"],
    ["a POSIX path", "/usr/bin/bash"],
  ])("refuses %s, naming the character it begins with", async (_label, configured) => {
    setPlatform("win32");
    hostWith({ scripts: { bash: configured } });
    const found = await resolveBashInterpreter();

    const problem = (found as { problem: string }).problem;
    expect(problem).toContain("names no drive");
    expect(problem).toContain("begins with a slash or a backslash");
  });

  it("refuses a configured System32 bash, naming WSL", async () => {
    setPlatform("win32");
    hostWith({
      scripts: { bash: "C:\\Windows\\System32\\bash.exe" },
    });
    const found = await resolveBashInterpreter();

    expect((found as { problem: string }).problem).toContain("WSL");
    expect((found as { problem: string }).problem).toContain("scripts.bash");
  });
});

describe("bash on PATH", () => {
  // The three cases that fake a POSIX platform need a POSIX host to hold the
  // fixture: a `C:\…` path is not posix-absolute, and there is no /bin/bash
  // behind it to fall through to. They also need a real bash, because the
  // resolver runs each candidate before it takes it. The Windows rules below
  // run everywhere.
  const onPosixWithBash = it.skipIf(realPlatform === "win32" || hostBash() === undefined);

  onPosixWithBash("takes the first absolute answer on POSIX", async () => {
    setPlatform(realPlatform);
    const root = hostWith(undefined);
    // A path of its own that is really a bash, so the answer is distinguishable
    // from the fixed location the resolver would otherwise fall through to.
    const onPath = path.join(root, "bash");
    fs.symlinkSync(hostBash()!, onPath);
    execFileMock.mockReturnValue({ stdout: `${onPath}\n`, stderr: "" });

    expect(await resolveBashInterpreter()).toEqual({ path: onPath });
    expect(execFileMock).toHaveBeenCalledWith("/bin/sh", ["-c", "command -v bash"]);
  });

  // `System32\bash.exe` is the WSL launcher, and it is early on every PATH: it
  // runs the file inside a Linux distribution where the project path and
  // $ARGENT_OUTPUT do not exist. Pinned on the candidate list rather than on the
  // resolved path, because no `C:\…` file exists on a POSIX host to be found —
  // and on the Windows runner this is the same list the resolver then stats.
  it("drops a System32 match from the Windows candidates and keeps the next one", async () => {
    setPlatform("win32");
    execFileMock.mockImplementation((_cmd: string, args?: readonly string[]) =>
      args?.[0] === "bash"
        ? {
            stdout: "C:\\Windows\\System32\\bash.exe\r\nC:\\Program Files\\Git\\bin\\bash.exe\r\n",
            stderr: "",
          }
        : new Error("not found")
    );

    const candidates = await bashSearchPath();
    expect(candidates[0]).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(candidates.some((entry) => /system32/i.test(entry))).toBe(false);
  });

  // `git.exe` on PATH is a SHIM under Scoop and Chocolatey, and two levels above
  // a shim there is no `bin\\bash.exe`. Chocolatey installs Git for Windows
  // itself, so `ProgramFiles` covers it; Scoop keeps its own tree.
  it("offers Scoop's own Git bash, which no shim derivation reaches", async () => {
    setPlatform("win32");
    const realProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = "C:\\Users\\dev";
    execFileMock.mockImplementation((_cmd: string, args?: readonly string[]) =>
      args?.[0] === "git"
        ? { stdout: "C:\\Users\\dev\\scoop\\shims\\git.exe\r\n", stderr: "" }
        : new Error("not found")
    );

    try {
      const candidates = await bashSearchPath();
      expect(candidates).toContain("C:\\Users\\dev\\scoop\\apps\\git\\current\\bin\\bash.exe");
    } finally {
      if (realProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = realProfile;
    }
  });

  // Three of the four Windows rungs are environment names rather than a
  // derivation, and each one is a whole install layout: the 64-bit installer,
  // the 32-bit one, and the per-user one that needs no administrator.
  it.each([
    ["ProgramFiles", "C:\\Program Files", "C:\\Program Files\\Git\\bin\\bash.exe"],
    ["ProgramFiles(x86)", "C:\\Program Files (x86)", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"],
    [
      "LOCALAPPDATA",
      "C:\\Users\\dev\\AppData\\Local",
      "C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
    ],
  ])("offers the Git for Windows under %s", async (name, value, expected) => {
    setPlatform("win32");
    const real = { ...process.env };
    for (const key of [
      "ProgramFiles",
      "ProgramFiles(x86)",
      "LOCALAPPDATA",
      "SCOOP",
      "SCOOP_GLOBAL",
      "ProgramData",
      "USERPROFILE",
    ]) {
      delete process.env[key];
    }
    process.env[name] = value;
    execFileMock.mockReturnValue(new Error("not found"));

    try {
      expect(await bashSearchPath()).toEqual([expected]);
    } finally {
      for (const key of [
        "ProgramFiles",
        "ProgramFiles(x86)",
        "LOCALAPPDATA",
        "SCOOP",
        "SCOOP_GLOBAL",
        "ProgramData",
        "USERPROFILE",
      ]) {
        if (real[key] === undefined) delete process.env[key];
        else process.env[key] = real[key];
      }
    }
  });

  it("derives Git for Windows' bash from git.exe when PATH has only the WSL launcher", async () => {
    setPlatform("win32");
    execFileMock.mockImplementation((_cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "bash") {
        return { stdout: "C:\\Windows\\System32\\bash.exe\r\n", stderr: "" };
      }
      if (args?.[0] === "git") return { stdout: "D:\\Tools\\Git\\cmd\\git.exe\r\n", stderr: "" };
      return new Error("not found");
    });

    const candidates = await bashSearchPath();
    expect(candidates[0]).toBe("D:\\Tools\\Git\\bin\\bash.exe");
  });

  // `where git` answers `<Git>\mingw64\bin\git.exe` when the tool server was
  // started from a Git Bash terminal, or from an editor whose default shell is
  // one. That sits THREE levels above `bin\bash.exe`, not two, so the two-level
  // derivation named a `mingw64\bin\bash.exe` that does not exist — masked
  // wherever Git is at the default location, and not for a portable install or
  // one on another drive.
  it("derives Git's bash from a git.exe under mingw64 as well as under cmd", async () => {
    setPlatform("win32");
    execFileMock.mockImplementation((_cmd: string, args?: readonly string[]) =>
      args?.[0] === "git"
        ? { stdout: "D:\\Portable\\Git\\mingw64\\bin\\git.exe\r\n", stderr: "" }
        : new Error("not found")
    );

    expect(await bashSearchPath()).toContain("D:\\Portable\\Git\\bin\\bash.exe");
  });

  // Each candidate costs a run of it, and in the default layout the git-derived
  // path and the `%ProgramFiles%` rung are the same file.
  it("offers each candidate once, however many rungs name it", async () => {
    setPlatform("win32");
    const realProgramFiles = process.env.ProgramFiles;
    process.env.ProgramFiles = "C:\\Program Files";
    execFileMock.mockImplementation((_cmd: string, args?: readonly string[]) =>
      args?.[0] === "git"
        ? { stdout: "C:\\Program Files\\Git\\cmd\\git.exe\r\n", stderr: "" }
        : new Error("not found")
    );

    try {
      const candidates = await bashSearchPath();
      const derived = candidates.filter(
        (entry) => entry.toLowerCase() === "c:\\program files\\git\\bin\\bash.exe"
      );
      expect(derived).toHaveLength(1);
    } finally {
      if (realProgramFiles === undefined) delete process.env.ProgramFiles;
      else process.env.ProgramFiles = realProgramFiles;
    }
  });

  onPosixWithBash("never offers a relative candidate, whatever the source", async () => {
    setPlatform(realPlatform);
    hostWith(undefined);
    // A relative PATH entry gives `command -v` a relative answer, which `spawn`
    // would resolve against the runner's own working directory.
    execFileMock.mockReturnValue({ stdout: "bin/bash\n", stderr: "" });

    expect(await resolveBashInterpreter()).toEqual({ path: hostBash() });
  });

  onPosixWithBash(
    "takes the first candidate that exists, not the first that was listed",
    async () => {
      setPlatform(realPlatform);
      const root = hostWith(undefined);
      execFileMock.mockReturnValue({ stdout: `${path.join(root, "gone")}\n`, stderr: "" });

      expect(await resolveBashInterpreter()).toEqual({ path: hostBash() });
    }
  );
});

/**
 * A candidate that runs but never answers. Both shapes below defeated the
 * `timeout` option `spawn` offers — it sends one SIGTERM and never escalates,
 * and it is the CLOSE of the candidate's pipes that used to settle the probe,
 * which is the last of everything the candidate started rather than the
 * candidate itself. This lookup runs before the step forks anything, so neither
 * the step's own time limit nor the request's abort was there to end it.
 */
const onPosix = it.skipIf(realPlatform === "win32");

function nodeExecutable(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`);
  fs.chmodSync(file, 0o755);
  return file;
}

describe("a candidate that will not answer", () => {
  onPosix(
    "stops a candidate that ignores SIGTERM instead of waiting on it",
    async () => {
      const root = hostWith(undefined);
      const stubborn = nodeExecutable(
        root,
        "bash",
        'process.on("SIGTERM", () => {});\nsetTimeout(() => {}, 60_000);\n'
      );
      pinGlobalConfig({ scripts: { bash: stubborn } });

      const startedAt = Date.now();
      const found = await resolveBashInterpreter();
      const elapsed = Date.now() - startedAt;

      expect((found as { problem: string }).problem).toContain("SIGKILL");
      // The five second wait plus the grace, and nothing like the sixty the
      // candidate asked for.
      expect(elapsed).toBeGreaterThanOrEqual(5_000);
      expect(elapsed).toBeLessThan(20_000);
    },
    30_000
  );

  // The probe asks the candidate the same question the step asks it, so it has
  // to ask it in the same environment. Inheriting the tool server's diverged in
  // both directions: `BASH_ENV` is outside the step allowlist, so a host that
  // exported it had every candidate refused over a file the step's bash could
  // never read; and the candidate is an arbitrary executable named `bash`,
  // which was handed the token, the port and every `ARGENT_SECRET_*` value the
  // allowlist exists to keep out of a script's reach.
  onPosix("runs the candidate in the environment the step gives bash", async () => {
    const root = hostWith(undefined);
    const saw = path.join(root, "saw.json");
    const recorder = nodeExecutable(
      root,
      "bash",
      `require("node:fs").writeFileSync(${JSON.stringify(saw)}, JSON.stringify(process.env));\n` +
        'process.stdout.write("\\nargent-bash-version:5.2.37\\n");\n'
    );
    pinGlobalConfig({ scripts: { bash: recorder } });
    process.env.ARGENT_SECRET_DEMO = "s3cr3t";
    process.env.BASH_ENV = path.join(root, "never-read.sh");

    expect(await resolveBashInterpreter({ PATH: process.env.PATH })).toEqual({
      path: recorder,
    });

    try {
      const env = JSON.parse(fs.readFileSync(saw, "utf8")) as Record<string, string>;
      expect(env.ARGENT_SECRET_DEMO).toBeUndefined();
      expect(env.BASH_ENV).toBeUndefined();
    } finally {
      delete process.env.ARGENT_SECRET_DEMO;
      delete process.env.BASH_ENV;
    }
  });

  // The other way a probed candidate dies by a signal. It answers in
  // milliseconds and nothing here stopped it, so the sentence about a
  // five-second wait was false about it - and it sent an operator whose pinned
  // bash is crashing looking for a slow one.
  onPosix("says a candidate died on its own rather than blaming the wait", async () => {
    const root = hostWith(undefined);
    const crasher = nodeExecutable(root, "bash", 'process.kill(process.pid, "SIGSEGV");\n');
    pinGlobalConfig({ scripts: { bash: crasher } });

    const startedAt = Date.now();
    const found = await resolveBashInterpreter();
    const elapsed = Date.now() - startedAt;

    expect((found as { problem: string }).problem).toContain("died from SIGSEGV");
    expect((found as { problem: string }).problem).not.toContain("seconds");
    // The probe waits five seconds before it stops a candidate itself.
    expect(elapsed).toBeLessThan(5_000);
  });

  // This lookup is the one place a `.sh` step waits before it has a process to
  // time out, so an abort raised across it was not observed for the probe's own
  // timeout plus its force grace - about six seconds per candidate, whatever
  // the step declared. A flow of N bash steps was un-cancellable for 6N
  // seconds, against a 30 s client budget.
  onPosix(
    "stops probing when the request is cancelled",
    async () => {
      const root = hostWith(undefined);
      const stubborn = nodeExecutable(
        root,
        "bash",
        'process.on("SIGTERM", () => {});\nsetTimeout(() => {}, 60_000);\n'
      );
      pinGlobalConfig({ scripts: { bash: stubborn } });
      const cancel = new AbortController();
      setTimeout(() => cancel.abort(), 300);

      const startedAt = Date.now();
      const found = await resolveBashInterpreter(process.env, cancel.signal);
      const elapsed = Date.now() - startedAt;

      expect(found).toEqual({ cancelled: true });
      expect(elapsed).toBeLessThan(3_000);
    },
    30_000
  );

  // The candidate is stopped with everything it started. A shim that
  // backgrounds a job left that job re-parented to pid 1 and running after the
  // call returned - and after the flow run, and after the tool server.
  onPosix(
    "stops what the candidate started, not only the candidate",
    async () => {
      const root = hostWith(undefined);
      const marker = path.join(root, "grandchild.pid");
      const shim = nodeExecutable(
        root,
        "bash",
        'const child = require("node:child_process").spawn(process.execPath,\n' +
          '  ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore", detached: false });\n' +
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(child.pid));\n` +
          'process.on("SIGTERM", () => {});\nsetTimeout(() => {}, 60_000);\n'
      );
      pinGlobalConfig({ scripts: { bash: shim } });

      await resolveBashInterpreter();
      await new Promise((resolve) => setTimeout(resolve, 500));

      const grandchild = Number(fs.readFileSync(marker, "utf8"));
      expect(Number.isFinite(grandchild)).toBe(true);
      expect(() => process.kill(grandchild, 0)).toThrow();
    },
    30_000
  );

  onPosix(
    "answers when the candidate exits, not when the last holder of its pipe does",
    async () => {
      const root = hostWith(undefined);
      const brief = nodeExecutable(
        root,
        "bash",
        'require("node:child_process")\n' +
          '  .spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {\n' +
          '    stdio: ["ignore", "inherit", "ignore"],\n' +
          "  })\n" +
          "  .unref();\n" +
          'process.stdout.write("\\nargent-bash-version:5.2.37\\n");\n' +
          "process.exit(0);\n"
      );
      pinGlobalConfig({ scripts: { bash: brief } });

      const startedAt = Date.now();
      const found = await resolveBashInterpreter();
      const elapsed = Date.now() - startedAt;

      expect(found).toEqual({ path: brief });
      expect(elapsed).toBeLessThan(5_000);
    },
    30_000
  );
});

describe("no bash anywhere", () => {
  // The POSIX arm of the same message. Both fixed locations exist on an
  // ordinary POSIX host, so the only way to reach it is to take them away.
  it.skipIf(realPlatform === "win32")(
    "names PATH and both fixed locations, and says to install bash",
    async () => {
      hostWith(undefined);
      execFileMock.mockReturnValue(new Error("command -v found nothing"));
      hideFixedLocations = true;

      const problem = (await resolveBashInterpreter()) as { problem: string };
      expect(problem.problem).toContain("PATH, /bin/bash and /usr/bin/bash");
      expect(problem.problem).toContain("Install bash");
      expect(problem.problem).not.toContain("Git for Windows");
    }
  );

  // A host that HAS a bash which fails the probe reached the same "Install
  // bash" sentence, while `which bash` answered on it. Both calls in the search
  // loop compute a sentence, and both were used as predicates and thrown away.
  it.skipIf(realPlatform === "win32")(
    "names the candidate it refused rather than telling the host to install bash",
    async () => {
      const root = hostWith(undefined);
      const stub = notBash(root);
      execFileMock.mockReturnValue({ stdout: `${stub}\n`, stderr: "" });
      hideFixedLocations = true;

      const problem = (await resolveBashInterpreter()) as { problem: string };

      expect(problem.problem).toContain(stub);
      expect(problem.problem).toContain("is not a bash");
      expect(problem.problem).not.toContain("Install bash");
    }
  );

  it("reports a spawn refusal naming what it looked at and each remedy", async () => {
    setPlatform("win32");
    hostWith(undefined);
    execFileMock.mockReturnValue(new Error("INFO: Could not find files"));

    const found = await resolveBashInterpreter();
    const problem = (found as { problem: string }).problem;

    expect(problem).toContain("No bash was found");
    expect(problem).toContain("Git for Windows");
    expect(problem).toContain("scripts.bash");
    expect(problem).toContain("snapshot");
  });
});
