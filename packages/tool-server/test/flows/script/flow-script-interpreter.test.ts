import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The POSIX fixed locations, taken away: `/bin/bash` exists on any ordinary
 * POSIX host, so "no bash anywhere" is reachable no other way. A module mock
 * because `vi.spyOn` cannot reach an ESM namespace.
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
 * The `where` / `command -v` call, injected as `command-on-path.test.ts` does,
 * so the Windows rules run on POSIX CI as well as on the Windows runner.
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
 * A scratch directory for a case's fixtures, plus `config` written to the
 * global config file, the only scope `scripts.bash` is read from.
 */
function hostWith(config: Record<string, unknown> | undefined): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bash-host-"));
  roots.push(dir);
  if (config) pinGlobalConfig(config);
  return dir;
}

function globalConfigFile(): string {
  return path.join(home, ".argent", "config.json");
}

function pinGlobalConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(globalConfigFile()), { recursive: true });
  fs.writeFileSync(globalConfigFile(), JSON.stringify(config), "utf8");
}

/** The project config file a committed value would sit in, read by nothing. */
function committedProjectConfig(dir: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, ".argent"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".argent", "config.json"), JSON.stringify(config), "utf8");
}

function executable(dir: string, name: string, source: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  fs.chmodSync(file, 0o755);
  return file;
}

function notBash(dir: string): string {
  return executable(dir, "bash", "#!/bin/sh\nexit 0\n");
}

/**
 * A real bash, found without the resolver under test, which refuses a written
 * stand-in for a reason these tests are not about.
 */
function hostBash(): string | undefined {
  const candidates =
    realPlatform === "win32"
      ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]
      : ["/bin/bash", "/usr/bin/bash"];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/**
 * A missing bash skips on a developer machine and FAILS on CI, where a skip
 * would take every gated case green having asserted nothing.
 */
const hostBashPath = hostBash();
if (hostBashPath === undefined && process.env.CI) {
  throw new Error(
    "This CI host has no bash at any of the fixed locations, so every case gated on one " +
      "in this file would be skipped."
  );
}

const withBash = it.skipIf(hostBashPath === undefined);
const onPosix = it.skipIf(realPlatform === "win32");
const onPosixWithBash = it.skipIf(realPlatform === "win32" || hostBashPath === undefined);

/** Sets (or, for `undefined`, removes) environment names for `body`. */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  body: () => Promise<T>
): Promise<T> {
  const real = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(vars);
  try {
    return await body();
  } finally {
    apply(real);
  }
}

/**
 * A home directory of the test's own, so a developer's own global pin is not
 * read past the fixtures below.
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

function problemOf(found: unknown): string {
  expect(found).toHaveProperty("problem");
  return (found as { problem: string }).problem;
}

describe("scripts.bash, read from the global config file", () => {
  withBash("honours a configured path and never looks at PATH", async () => {
    const configured = hostBash()!;
    hostWith({ scripts: { bash: configured } });

    expect(await resolveBashInterpreter()).toEqual({ path: configured });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  // An unreadable document reads as an empty one, so the key looks unset and
  // the PATH bash runs; the note is what says the configuration was lost.
  const canMakeUnreadable = realPlatform !== "win32" && process.getuid?.() !== 0;
  withBash.each([
    ["could not be parsed", '{"scripts":{"bash":"/bin/ba', 0o600, "is not valid JSON"],
    ...(canMakeUnreadable
      ? [
          [
            "could not be read",
            JSON.stringify({ scripts: { bash: "/nonexistent/bash" } }),
            0o000,
            "could not be read",
          ],
        ]
      : []),
  ] as [string, string, number, string][])(
    "says so when the global document %s",
    async (_label, document, mode, says) => {
      hostWith(undefined);
      fs.mkdirSync(path.dirname(globalConfigFile()), { recursive: true });
      fs.writeFileSync(globalConfigFile(), document);
      fs.chmodSync(globalConfigFile(), mode);
      try {
        const found = (await resolveBashInterpreter()) as { path?: string; note?: string };

        expect(found.path).toBeDefined();
        expect(found.note).toContain("was not read");
        expect(found.note).toContain(says);
      } finally {
        fs.chmodSync(globalConfigFile(), 0o600);
      }
    }
  );

  // `readScopeValue` gates reads on the key's `scopes`, so a committed project
  // value is not read at all. No global value beside it, because `merge` is
  // `prioritize-global` and one would win whatever `scopes` said.
  withBash("ignores a value committed to the project file, with none set globally", async () => {
    const onPath = hostBash()!;
    const dir = hostWith(undefined);
    committedProjectConfig(dir, { scripts: { bash: "C:\\Program Files\\Git\\bin\\bash.exe" } });
    execFileMock.mockReturnValue({ stdout: `${onPath}\n`, stderr: "" });
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    expect(await resolveBashInterpreter()).toEqual({ path: onPath });
    expect(execFileMock).toHaveBeenCalled();
  });

  // A value that is READ and unusable refuses the step rather than falling
  // through to a PATH bash that happens to exist on this machine.
  const REFUSED: {
    label: string;
    win32?: true;
    posixOnly?: true;
    value: (root: string) => unknown;
    says: string[];
  }[] = [
    {
      label: "a relative value",
      value: () => "bin/bash",
      says: ["scripts.bash", "not an absolute path"],
    },
    // The schema's `parse` would hand back `undefined`, the same as an absent key.
    { label: "an empty value", value: () => "   ", says: ["is empty"] },
    {
      label: "a value that is not a string",
      value: () => 123,
      says: ["scripts.bash = 123", "not an absolute path"],
    },
    {
      label: "a path that does not exist",
      value: (root) => path.join(root, "no-such-bash"),
      says: ["does not exist", "$value"],
    },
    {
      label: "a path that is not executable",
      posixOnly: true,
      value: (root) => {
        const file = path.join(root, "readable-bash");
        fs.writeFileSync(file, "");
        fs.chmodSync(file, 0o644);
        return file;
      },
      says: ["is not executable"],
    },
    // A wrapper that forgets to forward its arguments would pass every step
    // while running none of them.
    {
      label: "an interpreter with no $BASH_VERSION",
      value: notBash,
      says: ["is not a bash", "$value"],
    },
    // zsh, ksh and dash answer the probe with the marker and nothing after it.
    {
      label: "a shell that answers the marker with an empty version",
      posixOnly: true,
      value: (root) =>
        executable(root, "shell", "#!/bin/sh\nprintf '\\n%s%s\\n' 'argent-bash-version:' ''\n"),
      says: ["printed no $BASH_VERSION"],
    },
    {
      label: "the System32 bash",
      win32: true,
      value: () => "C:\\Windows\\System32\\bash.exe",
      says: ["WSL", "scripts.bash"],
    },
    // `\\?\` is kept by `path.resolve`, so a plain string comparison missed it.
    {
      label: "the extended-length System32 bash",
      win32: true,
      value: () => "\\\\?\\C:\\Windows\\System32\\bash.exe",
      says: ["WSL"],
    },
    // `path.win32.isAbsolute` accepts both, though neither names a drive.
    {
      label: "a path rooted on no drive",
      win32: true,
      value: () => "\\Windows\\System32\\bash.exe",
      says: ["names no drive", "begins with a slash or a backslash"],
    },
    {
      label: "a POSIX path on Windows",
      win32: true,
      value: () => "/usr/bin/bash",
      says: ["names no drive", "begins with a slash or a backslash"],
    },
  ];
  it.each(REFUSED.filter((row) => !(row.posixOnly && realPlatform === "win32")))(
    "refuses $label",
    async ({ win32, value, says }) => {
      if (win32) setPlatform("win32");
      const configured = value(hostWith(undefined));
      pinGlobalConfig({ scripts: { bash: configured } });

      const problem = problemOf(await resolveBashInterpreter());
      for (const fragment of says) {
        expect(problem).toContain(fragment === "$value" ? String(configured) : fragment);
      }
      expect(execFileMock).not.toHaveBeenCalled();
    }
  );

  it("names the global file and says unsetting it falls through to PATH", async () => {
    const dir = hostWith({ scripts: { bash: path.join("bin", "bash") } });
    committedProjectConfig(dir, { scripts: { bash: "/project/bin/bash" } });

    const problem = problemOf(await resolveBashInterpreter());

    expect(problem).toContain(globalConfigFile());
    expect(problem).not.toContain(path.join(dir, ".argent", "config.json"));
    expect(problem).not.toContain("/project/bin/bash");
    expect(problem).toContain("unset it to use the one on this host's PATH");
  });

  // A wrapper prints on either side of the bash it runs, so a window on the
  // candidate's output at either end loses the answer.
  onPosixWithBash.each([
    ["greets before it execs a real bash", `printf '%s\\n' '<noise>'\nexec <bash> "$@"`],
    ["runs a real bash and prints after it", `<bash> "$@"\nst=$?\nprintf '%s' '<noise>'\nexit $st`],
  ])("reads the version of a candidate that %s", async (_shape, body) => {
    const wrapper = executable(
      hostWith(undefined),
      "wrapping-bash",
      `#!/bin/sh\n${body.replaceAll("<noise>", "B".repeat(64 * 1024)).replaceAll("<bash>", hostBashPath!)}\n`
    );
    pinGlobalConfig({ scripts: { bash: wrapper } });

    expect(await resolveBashInterpreter()).toEqual({ path: wrapper });
  });
});

describe("bash on PATH", () => {
  // The POSIX cases need a POSIX host to hold the fixture and a real bash to
  // answer the probe; the Windows rules run everywhere.
  onPosixWithBash("takes the first absolute answer on POSIX", async () => {
    const root = hostWith(undefined);
    const onPath = path.join(root, "bash");
    fs.symlinkSync(hostBash()!, onPath);
    execFileMock.mockReturnValue({ stdout: `${onPath}\n`, stderr: "" });

    expect(await resolveBashInterpreter()).toEqual({ path: onPath });
    expect(execFileMock).toHaveBeenCalledWith("/bin/sh", ["-c", "command -v bash"]);
  });

  // The search goes on to /bin/bash, Apple's 3.2 on a Mac, and the step says
  // why rather than running a bash 4 script under 3.2 in silence.
  onPosixWithBash("says so when it refused the PATH bash and ran a later one", async () => {
    const shim = executable(
      hostWith(undefined),
      "bash",
      '#!/bin/sh\necho "No version is set for command bash" >&2\nexit 126\n'
    );
    execFileMock.mockReturnValue({ stdout: `${shim}\n`, stderr: "" });

    const found = (await resolveBashInterpreter()) as { path: string; note?: string };
    expect(found.path).toBe(hostBash());
    expect(found.note).toContain(`The script ran under ${hostBash()}`);
    expect(found.note).toContain(`${shim} is not a bash`);
    expect(found.note).toContain("No version is set for command bash");
  });

  // A relative answer would be spawned against the runner's own directory.
  onPosixWithBash.each([
    ["a relative candidate", () => "bin/bash"],
    ["a candidate that does not exist", () => path.join(hostWith(undefined), "gone")],
  ])("passes over %s to the next one", async (_label, answer) => {
    hostWith(undefined);
    execFileMock.mockReturnValue({ stdout: `${answer()}\n`, stderr: "" });

    expect(await resolveBashInterpreter()).toEqual({ path: hostBash() });
  });

  // `System32\bash.exe` is the WSL launcher, early on every PATH, and runs the
  // file where the project path does not exist. `git.exe` is a shim under
  // Scoop, and under `mingw64\bin` when the server started from Git Bash.
  it.each([
    [
      "keeps the PATH answer after a System32 one",
      { bash: "C:\\Windows\\System32\\bash.exe\r\nC:\\Program Files\\Git\\bin\\bash.exe\r\n" },
      "C:\\Program Files\\Git\\bin\\bash.exe",
    ],
    [
      "derives Git's bash from a git.exe under cmd when PATH has only System32",
      { bash: "C:\\Windows\\System32\\bash.exe\r\n", git: "D:\\Tools\\Git\\cmd\\git.exe\r\n" },
      "D:\\Tools\\Git\\bin\\bash.exe",
    ],
    [
      "derives Git's bash from a git.exe under mingw64",
      { git: "D:\\Portable\\Git\\mingw64\\bin\\git.exe\r\n" },
      "D:\\Portable\\Git\\bin\\bash.exe",
    ],
    [
      "offers Scoop's own Git bash, which no shim derivation reaches",
      { git: "C:\\Users\\dev\\scoop\\shims\\git.exe\r\n" },
      "C:\\Users\\dev\\scoop\\apps\\git\\current\\bin\\bash.exe",
    ],
  ] as [string, { bash?: string; git?: string }, string][])(
    "on Windows, %s",
    async (_label, answers, expected) => {
      setPlatform("win32");
      execFileMock.mockImplementation((_cmd: string, args?: readonly string[]) => {
        const stdout = answers[args?.[0] as "bash" | "git"];
        return stdout ? { stdout, stderr: "" } : new Error("not found");
      });

      const candidates = await withEnv({ USERPROFILE: "C:\\Users\\dev" }, () => bashSearchPath());
      expect(candidates).toContain(expected);
      if (answers.bash) expect(candidates[0]).toBe(expected);
      expect(candidates.some((entry) => /system32/i.test(entry))).toBe(false);
    }
  );

  // Each install layout an environment name stands for: the three Git for
  // Windows installers and the three Scoop roots.
  const LAYOUT_NAMES = [
    "ProgramFiles",
    "ProgramFiles(x86)",
    "LOCALAPPDATA",
    "SCOOP",
    "SCOOP_GLOBAL",
    "ProgramData",
    "USERPROFILE",
  ];
  it.each([
    ["ProgramFiles", "C:\\Program Files", "C:\\Program Files\\Git\\bin\\bash.exe"],
    ["ProgramFiles(x86)", "C:\\Program Files (x86)", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"],
    [
      "LOCALAPPDATA",
      "C:\\Users\\dev\\AppData\\Local",
      "C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
    ],
    ["SCOOP", "D:\\scoop", "D:\\scoop\\apps\\git\\current\\bin\\bash.exe"],
    [
      "SCOOP_GLOBAL",
      "C:\\ProgramData\\scoop",
      "C:\\ProgramData\\scoop\\apps\\git\\current\\bin\\bash.exe",
    ],
    ["ProgramData", "C:\\ProgramData", "C:\\ProgramData\\scoop\\apps\\git\\current\\bin\\bash.exe"],
  ])("offers the bash the %s layout puts there", async (name, value, expected) => {
    setPlatform("win32");
    execFileMock.mockReturnValue(new Error("not found"));
    const env = Object.fromEntries(LAYOUT_NAMES.map((key) => [key, undefined]));

    expect(await withEnv({ ...env, [name]: value }, () => bashSearchPath())).toEqual([expected]);
  });

  // The git-derived path and the `%ProgramFiles%` rung are one file spelled
  // two ways, and a refused candidate would be probed twice.
  it("offers each candidate once, however many rungs name it", async () => {
    setPlatform("win32");
    execFileMock.mockImplementation((_cmd: string, args?: readonly string[]) =>
      args?.[0] === "git"
        ? { stdout: "C:\\Program Files\\Git\\cmd\\git.exe\r\n", stderr: "" }
        : new Error("not found")
    );

    const candidates = await withEnv({ ProgramFiles: "c:\\program files" }, () => bashSearchPath());
    const derived = candidates.filter(
      (entry) => entry.toLowerCase() === "c:\\program files\\git\\bin\\bash.exe"
    );
    expect(derived).toHaveLength(1);
  });
});

/**
 * A Node program named `bash`. The lookup runs before the step forks anything,
 * so the step's own time limit is not there to end a candidate that will not
 * answer.
 */
function nodeExecutable(dir: string, name: string, body: string): string {
  return executable(dir, name, `#!${process.execPath}\n${body}`);
}

const STUBBORN = 'process.on("SIGTERM", () => {});\nsetTimeout(() => {}, 60_000);\n';

describe("a candidate that will not answer", () => {
  // `spawn`'s own `timeout` sends one SIGTERM and never escalates. The group
  // is stopped, so a job the candidate started is not left re-parented to 1.
  onPosix(
    "stops a candidate that ignores SIGTERM, and what it started",
    async () => {
      const root = hostWith(undefined);
      const marker = path.join(root, "grandchild.pid");
      const stubborn = nodeExecutable(
        root,
        "bash",
        'const child = require("node:child_process").spawn(process.execPath,\n' +
          '  ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore", detached: false });\n' +
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(child.pid));\n` +
          STUBBORN
      );
      pinGlobalConfig({ scripts: { bash: stubborn } });

      const startedAt = Date.now();
      const found = await resolveBashInterpreter();
      const elapsed = Date.now() - startedAt;

      expect(problemOf(found)).toContain("SIGKILL");
      // The five-second wait plus the grace, not the sixty it asked for.
      expect(elapsed).toBeGreaterThanOrEqual(5_000);
      expect(elapsed).toBeLessThan(20_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const grandchild = Number(fs.readFileSync(marker, "utf8"));
      expect(Number.isFinite(grandchild)).toBe(true);
      expect(() => process.kill(grandchild, 0)).toThrow();
    },
    30_000
  );

  // The probe asks the question the step asks, so in the step's environment
  // (no `BASH_ENV`, no secrets) and in the step's directory (a version-manager
  // shim picks its bash from there).
  onPosix("runs the candidate in the environment and directory the step gives bash", async () => {
    const root = hostWith(undefined);
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bash-project-"));
    roots.push(project);
    const saw = path.join(root, "saw.json");
    const recorder = nodeExecutable(
      root,
      "bash",
      `require("node:fs").writeFileSync(${JSON.stringify(saw)}, JSON.stringify({ env: process.env, cwd: process.cwd() }));\n` +
        'process.stdout.write("\\nargent-bash-version:5.2.37\\n");\n'
    );
    pinGlobalConfig({ scripts: { bash: recorder } });

    await withEnv(
      { ARGENT_SECRET_DEMO: "s3cr3t", BASH_ENV: path.join(root, "never-read.sh") },
      async () => {
        expect(
          await resolveBashInterpreter({ PATH: process.env.PATH }, undefined, project)
        ).toEqual({
          path: recorder,
        });
      }
    );

    const { env, cwd } = JSON.parse(fs.readFileSync(saw, "utf8")) as {
      env: Record<string, string>;
      cwd: string;
    };
    expect(env.ARGENT_SECRET_DEMO).toBeUndefined();
    expect(env.BASH_ENV).toBeUndefined();
    expect(cwd).toBe(fs.realpathSync(project));
  });

  // A shim says on stderr why it ran no bash, reason first and its versions
  // after; a wrapper behind `tee` writes it after it is gone.
  onPosix.each([
    [
      "as it exits",
      "#!/bin/sh\n" +
        'echo "No version is set for command bash" >&2\n' +
        'echo "Consider adding one of the following versions in your config file" >&2\n' +
        'echo "bash 5.2.37" >&2\n' +
        "exit 126\n",
    ],
    [
      "after it exits",
      `#!${process.execPath}\n` +
        'require("node:child_process")\n' +
        '  .spawn(process.execPath, ["-e", "setTimeout(() => process.stderr.write(\\"No version is set for command bash\\\\n\\"), 50)"], {\n' +
        '    stdio: ["ignore", "ignore", "inherit"],\n' +
        "  })\n" +
        "  .unref();\n" +
        "process.exit(126);\n",
    ],
  ])(
    "quotes the first line a refused candidate wrote to stderr %s",
    async (_when, source) => {
      const shim = executable(hostWith(undefined), "bash", source);
      pinGlobalConfig({ scripts: { bash: shim } });

      const problem = problemOf(await resolveBashInterpreter());
      expect(problem).toContain("is not a bash");
      expect(problem).toContain("(it wrote to stderr: No version is set for command bash)");
      expect(problem).not.toContain("Consider adding");
    },
    30_000
  );

  // Nothing stopped it, so a sentence about the five-second wait is false.
  onPosix("says a candidate died on its own rather than blaming the wait", async () => {
    const crasher = nodeExecutable(
      hostWith(undefined),
      "bash",
      'process.kill(process.pid, "SIGSEGV");\n'
    );
    pinGlobalConfig({ scripts: { bash: crasher } });

    const startedAt = Date.now();
    const problem = problemOf(await resolveBashInterpreter());

    expect(problem).toContain("died from SIGSEGV");
    expect(problem).not.toContain("seconds");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  // The abort reaches the probe of a configured candidate and the PATH
  // search's loop alike, instead of waiting out about six seconds each.
  onPosix.each([
    ["configured", true],
    ["found on PATH", false],
  ] as [string, boolean][])(
    "stops probing a %s candidate when the request is cancelled",
    async (_label, configured) => {
      const stubborn = nodeExecutable(hostWith(undefined), "bash", STUBBORN);
      if (configured) pinGlobalConfig({ scripts: { bash: stubborn } });
      else execFileMock.mockReturnValue({ stdout: `${stubborn}\n`, stderr: "" });
      const cancel = new AbortController();
      setTimeout(() => cancel.abort(), 300);

      const startedAt = Date.now();
      const found = await resolveBashInterpreter(process.env, cancel.signal);

      expect(found).toEqual({ cancelled: true });
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    },
    30_000
  );

  onPosix("probes nothing at all when the request is already cancelled", async () => {
    const stubborn = nodeExecutable(hostWith(undefined), "bash", STUBBORN);
    execFileMock.mockReturnValue({ stdout: `${stubborn}\n`, stderr: "" });
    const cancel = new AbortController();
    cancel.abort();

    const startedAt = Date.now();
    const found = await resolveBashInterpreter(process.env, cancel.signal);

    expect(found).toEqual({ cancelled: true });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  // A job the candidate leaves holding its stdout must not hold the answer.
  onPosix(
    "answers when the candidate exits, not when the last holder of its pipe does",
    async () => {
      const brief = nodeExecutable(
        hostWith(undefined),
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
      expect(await resolveBashInterpreter()).toEqual({ path: brief });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    },
    30_000
  );

  // stderr is piped only for a refusal to quote, so a job holding it must not
  // delay an answer: it comes at the candidate's exit, not a settle later.
  onPosix(
    "answers when the candidate exits, not a settle after a job holding stderr",
    async () => {
      const root = hostWith(undefined);
      const stamp = path.join(root, "exited-at");
      const brief = nodeExecutable(
        root,
        "bash",
        'require("node:child_process")\n' +
          '  .spawn(process.execPath, ["-e", "setTimeout(() => {}, 1_000)"], {\n' +
          '    stdio: ["ignore", "ignore", "inherit"],\n' +
          "  })\n" +
          "  .unref();\n" +
          'process.stdout.write("\\nargent-bash-version:5.2.37\\n");\n' +
          `require("node:fs").writeFileSync(${JSON.stringify(stamp)}, String(Date.now()));\n` +
          "process.exit(0);\n"
      );
      pinGlobalConfig({ scripts: { bash: brief } });

      expect(await resolveBashInterpreter()).toEqual({ path: brief });
      // The settle is 250 ms.
      expect(Date.now() - Number(fs.readFileSync(stamp, "utf8"))).toBeLessThan(200);
    },
    30_000
  );
});

describe("no bash anywhere", () => {
  onPosix("names PATH and both fixed locations, and says to install bash", async () => {
    hostWith(undefined);
    execFileMock.mockReturnValue(new Error("command -v found nothing"));
    hideFixedLocations = true;

    const problem = problemOf(await resolveBashInterpreter());
    expect(problem).toContain("PATH, /bin/bash and /usr/bin/bash");
    expect(problem).toContain("Install bash");
    expect(problem).not.toContain("Git for Windows");
  });

  // A host that HAS a bash failing the probe is told what was refused, not
  // to install one.
  onPosix(
    "names the candidate it refused rather than telling the host to install bash",
    async () => {
      const stub = notBash(hostWith(undefined));
      execFileMock.mockReturnValue({ stdout: `${stub}\n`, stderr: "" });
      hideFixedLocations = true;

      const problem = problemOf(await resolveBashInterpreter());
      expect(problem).toContain(stub);
      expect(problem).toContain("is not a bash");
      expect(problem).not.toContain("Install bash");
    }
  );

  it("reports a spawn refusal naming what it looked at and each remedy", async () => {
    setPlatform("win32");
    hostWith(undefined);
    execFileMock.mockReturnValue(new Error("INFO: Could not find files"));
    // No Git for Windows layout either, even on a runner that has one installed.
    const noLayouts = Object.fromEntries(
      [
        "ProgramFiles",
        "ProgramFiles(x86)",
        "LOCALAPPDATA",
        "SCOOP",
        "SCOOP_GLOBAL",
        "ProgramData",
      ].map((name) => [name, undefined])
    );

    const problem = problemOf(await withEnv(noLayouts, () => resolveBashInterpreter()));
    expect(problem).toContain("No bash was found");
    expect(problem).toContain("Git for Windows");
    expect(problem).toContain("scripts.bash");
    expect(problem).toContain("snapshot");
  });
});
