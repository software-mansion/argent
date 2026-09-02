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
 * A project root of its own, with the `.argent` marker `resolveProjectRoot`
 * stops at — so the read lands on this file and not on whatever project the
 * temporary directory happens to sit inside.
 */
function projectWith(config: Record<string, unknown> | undefined): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bash-project-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".argent"), { recursive: true });
  if (config) {
    fs.writeFileSync(path.join(root, ".argent", "config.json"), JSON.stringify(config), "utf8");
  }
  return root;
}

function notBash(dir: string, name = "bash"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
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
 * BOTH scopes, and `test/setup/clear-argent-env.ts` strips `ARGENT_*` variables
 * and not `~/.argent/config.json` — so on a machine that took this PR's own
 * advice and pinned a bash globally, the fixtures below were read past and two
 * of these tests failed. The global scope lives under the home directory, which
 * is the one place a test can move it.
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

describe("scripts.bash, read against the flow's own project", () => {
  withBash("honours a configured path and never looks at PATH", async () => {
    const configured = hostBash()!;
    const root = projectWith({ scripts: { bash: configured } });

    expect(await resolveBashInterpreter(root)).toEqual({ path: configured });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  // `getConfigValue` resolves the project scope from the cwd it is given, and
  // the tool server's own cwd is whatever the editor that spawned it chose —
  // so the bare call would read another project's file, or none.
  withBash("reads the flow's project, not the tool server's working directory", async () => {
    const configured = hostBash()!;
    const flowProject = projectWith({ scripts: { bash: configured } });
    const serverCwd = projectWith({ scripts: { bash: "/nowhere/else/bash" } });
    const realCwd = process.cwd();
    vi.spyOn(process, "cwd").mockReturnValue(serverCwd);
    try {
      expect(await resolveBashInterpreter(flowProject)).toEqual({ path: configured });
    } finally {
      vi.spyOn(process, "cwd").mockReturnValue(realCwd);
    }
  });

  it("refuses a relative value rather than falling through to PATH", async () => {
    const root = projectWith({ scripts: { bash: "bin/bash" } });
    const found = await resolveBashInterpreter(root);

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
    const root = projectWith({ scripts: { bash: "   " } });
    const found = await resolveBashInterpreter(root);

    expect("path" in found).toBe(false);
    expect((found as { problem: string }).problem).toContain("is empty");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("refuses a value that is not a string, naming what it found", async () => {
    const root = projectWith({ scripts: { bash: 123 } });
    const found = await resolveBashInterpreter(root);

    expect((found as { problem: string }).problem).toContain("scripts.bash = 123");
    expect((found as { problem: string }).problem).toContain("not an absolute path");
  });

  it("names the file the value came from, not the project it ran in", async () => {
    const root = projectWith({ scripts: { bash: "bin/bash" } });
    const found = await resolveBashInterpreter(root);

    expect((found as { problem: string }).problem).toContain(
      path.join(root, ".argent", "config.json")
    );
  });

  // The other half of `configuredIn`. `getConfigValue` merges the two scopes, so
  // a stale GLOBAL value refuses every `.sh` step in every project on the
  // machine — and a message naming a project file the value is not in sends the
  // author to the wrong file.
  it("names the global file when the value came from there", async () => {
    const root = projectWith(undefined);
    fs.mkdirSync(path.join(home, ".argent"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".argent", "config.json"),
      JSON.stringify({ scripts: { bash: path.join(home, "no-such-global-bash") } })
    );

    const found = await resolveBashInterpreter(root);
    const problem = (found as { problem: string }).problem;
    expect(problem).toContain(path.join(home, ".argent", "config.json"));
    expect(problem).not.toContain(path.join(root, ".argent", "config.json"));
  });

  it("refuses a configured path that does not exist", async () => {
    const root = projectWith(undefined);
    const missing = path.join(root, "no-such-bash");
    fs.writeFileSync(
      path.join(root, ".argent", "config.json"),
      JSON.stringify({ scripts: { bash: missing } })
    );
    const found = await resolveBashInterpreter(root);

    expect((found as { problem: string }).problem).toContain("does not exist");
    expect((found as { problem: string }).problem).toContain(missing);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a configured path that is not executable",
    async () => {
      const root = projectWith(undefined);
      const file = path.join(root, "readable-bash");
      fs.writeFileSync(file, "");
      fs.chmodSync(file, 0o644);
      fs.writeFileSync(
        path.join(root, ".argent", "config.json"),
        JSON.stringify({ scripts: { bash: file } })
      );

      const found = await resolveBashInterpreter(root);
      expect((found as { problem: string }).problem).toContain("is not executable");
    }
  );

  // Every static check passes for an executable file that is not a shell, and
  // the three properties after them hide it: the parent seeds $ARGENT_OUTPUT,
  // the child's output is discarded, and an exit code of 0 is a pass. So a
  // wrapper that forgets to forward its arguments would report every `.sh` step
  // green while running none of them.
  it("refuses a configured interpreter that answers with no $BASH_VERSION", async () => {
    const root = projectWith(undefined);
    const stub = notBash(root);
    fs.writeFileSync(
      path.join(root, ".argent", "config.json"),
      JSON.stringify({ scripts: { bash: stub } })
    );

    const found = await resolveBashInterpreter(root);
    expect("path" in found).toBe(false);
    expect((found as { problem: string }).problem).toContain("is not a bash");
    expect((found as { problem: string }).problem).toContain(stub);
  });

  // The guard is a comparison of strings, and Windows gives one file several
  // names. `\\?\` is the extended-length prefix, which `path.resolve` keeps —
  // so the resolved path never matched the plain `%SystemRoot%`.
  it("refuses the extended-length spelling of the same WSL launcher", async () => {
    setPlatform("win32");
    const root = projectWith({
      scripts: { bash: "\\\\?\\C:\\Windows\\System32\\bash.exe" },
    });
    const found = await resolveBashInterpreter(root);

    expect((found as { problem: string }).problem).toContain("WSL");
  });

  // `path.win32.isAbsolute` accepts a path with no drive, and the two processes
  // that read it are not on the same one: the tool server stats it against its
  // own working directory, and the runner spawns it against project_root.
  it("refuses a path that names no drive", async () => {
    setPlatform("win32");
    const root = projectWith({ scripts: { bash: "\\Windows\\System32\\bash.exe" } });
    const found = await resolveBashInterpreter(root);

    expect((found as { problem: string }).problem).toContain("names no drive");
  });

  it("refuses a configured System32 bash, naming WSL", async () => {
    setPlatform("win32");
    const root = projectWith({
      scripts: { bash: "C:\\Windows\\System32\\bash.exe" },
    });
    const found = await resolveBashInterpreter(root);

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
    const root = projectWith(undefined);
    // A path of its own that is really a bash, so the answer is distinguishable
    // from the fixed location the resolver would otherwise fall through to.
    const onPath = path.join(root, "bash");
    fs.symlinkSync(hostBash()!, onPath);
    execFileMock.mockReturnValue({ stdout: `${onPath}\n`, stderr: "" });

    expect(await resolveBashInterpreter(root)).toEqual({ path: onPath });
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
    const root = projectWith(undefined);
    // A relative PATH entry gives `command -v` a relative answer, which `spawn`
    // would resolve against the runner's own working directory.
    execFileMock.mockReturnValue({ stdout: "bin/bash\n", stderr: "" });

    expect(await resolveBashInterpreter(root)).toEqual({ path: hostBash() });
  });

  onPosixWithBash(
    "takes the first candidate that exists, not the first that was listed",
    async () => {
      setPlatform(realPlatform);
      const root = projectWith(undefined);
      execFileMock.mockReturnValue({ stdout: `${path.join(root, "gone")}\n`, stderr: "" });

      expect(await resolveBashInterpreter(root)).toEqual({ path: hostBash() });
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
      const root = projectWith(undefined);
      const stubborn = nodeExecutable(
        root,
        "bash",
        'process.on("SIGTERM", () => {});\nsetTimeout(() => {}, 60_000);\n'
      );
      fs.writeFileSync(
        path.join(root, ".argent", "config.json"),
        JSON.stringify({ scripts: { bash: stubborn } })
      );

      const startedAt = Date.now();
      const found = await resolveBashInterpreter(root);
      const elapsed = Date.now() - startedAt;

      expect((found as { problem: string }).problem).toContain("SIGKILL");
      // The five second wait plus the grace, and nothing like the sixty the
      // candidate asked for.
      expect(elapsed).toBeGreaterThanOrEqual(5_000);
      expect(elapsed).toBeLessThan(20_000);
    },
    30_000
  );

  onPosix(
    "answers when the candidate exits, not when the last holder of its pipe does",
    async () => {
      const root = projectWith(undefined);
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
      fs.writeFileSync(
        path.join(root, ".argent", "config.json"),
        JSON.stringify({ scripts: { bash: brief } })
      );

      const startedAt = Date.now();
      const found = await resolveBashInterpreter(root);
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
      const root = projectWith(undefined);
      execFileMock.mockReturnValue(new Error("command -v found nothing"));
      hideFixedLocations = true;

      const problem = (await resolveBashInterpreter(root)) as { problem: string };
      expect(problem.problem).toContain("PATH, /bin/bash and /usr/bin/bash");
      expect(problem.problem).toContain("Install bash");
      expect(problem.problem).not.toContain("Git for Windows");
    }
  );

  it("reports a spawn refusal naming what it looked at and each remedy", async () => {
    setPlatform("win32");
    const root = projectWith(undefined);
    execFileMock.mockReturnValue(new Error("INFO: Could not find files"));

    const found = await resolveBashInterpreter(root);
    const problem = (found as { problem: string }).problem;

    expect(problem).toContain("No bash was found");
    expect(problem).toContain("Git for Windows");
    expect(problem).toContain("scripts.bash");
    expect(problem).toContain("snapshot");
  });
});
