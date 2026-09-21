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

function hostWith(config: Record<string, unknown> | undefined): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bash-host-"));
  roots.push(dir);
  if (config) pinGlobalConfig(config);
  return dir;
}

function pinGlobalConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.join(home, ".argent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".argent", "config.json"), JSON.stringify(config), "utf8");
}

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

function emptyVersionShell(dir: string, name = "shell"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\nprintf '\\n%s%s\\n' 'argent-bash-version:' ''\n");
  fs.chmodSync(file, 0o755);
  return file;
}

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

  withBash("says so when the global document could not be parsed", async () => {
    hostWith(undefined);
    fs.mkdirSync(path.join(home, ".argent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".argent", "config.json"), '{"scripts":{"bash":"/bin/ba');

    const found = await resolveBashInterpreter();

    expect("path" in found).toBe(true);
    expect((found as { note?: string }).note).toContain("was not read");
    expect((found as { note?: string }).note).toContain("is not valid JSON");
  });

  const onUnreadable = it.skipIf(
    realPlatform === "win32" || process.getuid?.() === 0 || hostBashPath === undefined
  );
  onUnreadable("says so when the global document could not be read", async () => {
    hostWith(undefined);
    fs.mkdirSync(path.join(home, ".argent"), { recursive: true });
    const file = path.join(home, ".argent", "config.json");
    fs.writeFileSync(file, JSON.stringify({ scripts: { bash: "/nonexistent/bash" } }));
    fs.chmodSync(file, 0o000);
    try {
      const found = await resolveBashInterpreter();

      expect("path" in found).toBe(true);
      expect((found as { note?: string }).note).toContain("was not read");
      expect((found as { note?: string }).note).toContain("could not be read");
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  withBash("says nothing when the host has no global document", async () => {
    hostWith(undefined);

    const found = await resolveBashInterpreter();

    expect("path" in found).toBe(true);
    expect((found as { note?: string }).note).toBeUndefined();
  });

  withBash("ignores a value committed to the project file, with none set globally", async () => {
    const onPath = hostBash()!;
    const dir = hostWith(undefined);
    committedProjectConfig(dir, {
      scripts: { bash: "C:\\Program Files\\Git\\bin\\bash.exe" },
    });
    execFileMock.mockReturnValue({ stdout: `${onPath}\n`, stderr: "" });
    const realCwd = process.cwd();
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      expect(await resolveBashInterpreter()).toEqual({ path: onPath });
      expect(execFileMock).toHaveBeenCalled();
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

  it("refuses a configured interpreter that answers with no $BASH_VERSION", async () => {
    const root = hostWith(undefined);
    const stub = notBash(root);
    pinGlobalConfig({ scripts: { bash: stub } });

    const found = await resolveBashInterpreter();
    expect("path" in found).toBe(false);
    expect((found as { problem: string }).problem).toContain("is not a bash");
    expect((found as { problem: string }).problem).toContain(stub);
  });

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

  it("refuses the extended-length spelling of the same WSL launcher", async () => {
    setPlatform("win32");
    hostWith({
      scripts: { bash: "\\\\?\\C:\\Windows\\System32\\bash.exe" },
    });
    const found = await resolveBashInterpreter();

    expect((found as { problem: string }).problem).toContain("WSL");
  });

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
    const onPath = path.join(root, "bash");
    fs.symlinkSync(hostBash()!, onPath);
    execFileMock.mockReturnValue({ stdout: `${onPath}\n`, stderr: "" });

    expect(await resolveBashInterpreter()).toEqual({ path: onPath });
    expect(execFileMock).toHaveBeenCalledWith("/bin/sh", ["-c", "command -v bash"]);
  });

  onPosixWithBash("says so when it refused the PATH bash and ran a later one", async () => {
    setPlatform(realPlatform);
    const root = hostWith(undefined);
    const shim = path.join(root, "bash");
    fs.writeFileSync(shim, '#!/bin/sh\necho "No version is set for command bash" >&2\nexit 126\n');
    fs.chmodSync(shim, 0o755);
    execFileMock.mockReturnValue({ stdout: `${shim}\n`, stderr: "" });

    const found = (await resolveBashInterpreter()) as { path: string; note?: string };
    expect(found.path).toBe(hostBash());
    expect(found.note).toContain(`The script ran under ${hostBash()}`);
    expect(found.note).toContain(`${shim} is not a bash`);
    expect(found.note).toContain("No version is set for command bash");
  });

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

  it("derives Git's bash from a git.exe under mingw64 as well as under cmd", async () => {
    setPlatform("win32");
    execFileMock.mockImplementation((_cmd: string, args?: readonly string[]) =>
      args?.[0] === "git"
        ? { stdout: "D:\\Portable\\Git\\mingw64\\bin\\git.exe\r\n", stderr: "" }
        : new Error("not found")
    );

    expect(await bashSearchPath()).toContain("D:\\Portable\\Git\\bin\\bash.exe");
  });

  it("offers each candidate once, however many rungs name it", async () => {
    setPlatform("win32");
    const realProgramFiles = process.env.ProgramFiles;
    process.env.ProgramFiles = "c:\\program files";
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
      expect(elapsed).toBeGreaterThanOrEqual(5_000);
      expect(elapsed).toBeLessThan(20_000);
    },
    30_000
  );

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

  onPosix("runs the candidate in the directory the step runs in", async () => {
    const root = hostWith(undefined);
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bash-project-"));
    roots.push(project);
    const saw = path.join(root, "cwd.txt");
    const recorder = nodeExecutable(
      root,
      "bash",
      `require("node:fs").writeFileSync(${JSON.stringify(saw)}, process.cwd());\n` +
        'process.stdout.write("\\nargent-bash-version:5.2.37\\n");\n'
    );
    pinGlobalConfig({ scripts: { bash: recorder } });

    expect(await resolveBashInterpreter(process.env, undefined, project)).toEqual({
      path: recorder,
    });
    expect(fs.readFileSync(saw, "utf8")).toBe(fs.realpathSync(project));
  });

  onPosix("quotes the first line a refused candidate wrote to stderr", async () => {
    const root = hostWith(undefined);
    const shim = path.join(root, "bash");
    fs.writeFileSync(
      shim,
      "#!/bin/sh\n" +
        'echo "No version is set for command bash" >&2\n' +
        'echo "Consider adding one of the following versions in your config file at $PWD/.tool-versions" >&2\n' +
        'echo "bash 5.2.37" >&2\n' +
        "exit 126\n"
    );
    fs.chmodSync(shim, 0o755);
    pinGlobalConfig({ scripts: { bash: shim } });

    const found = (await resolveBashInterpreter()) as { problem: string };
    expect(found.problem).toContain("is not a bash");
    expect(found.problem).toContain("(it wrote to stderr: No version is set for command bash)");
    expect(found.problem).not.toContain("Consider adding");
  });

  onPosix("says a candidate died on its own rather than blaming the wait", async () => {
    const root = hostWith(undefined);
    const crasher = nodeExecutable(root, "bash", 'process.kill(process.pid, "SIGSEGV");\n');
    pinGlobalConfig({ scripts: { bash: crasher } });

    const startedAt = Date.now();
    const found = await resolveBashInterpreter();
    const elapsed = Date.now() - startedAt;

    expect((found as { problem: string }).problem).toContain("died from SIGSEGV");
    expect((found as { problem: string }).problem).not.toContain("seconds");
    expect(elapsed).toBeLessThan(5_000);
  });

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

  onPosix(
    "stops probing the PATH search when the request is cancelled",
    async () => {
      const root = hostWith(undefined);
      const stubborn = nodeExecutable(
        root,
        "bash",
        'process.on("SIGTERM", () => {});\nsetTimeout(() => {}, 60_000);\n'
      );
      execFileMock.mockReturnValue({ stdout: `${stubborn}\n`, stderr: "" });
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

  onPosix(
    "probes nothing at all when the request is already cancelled",
    async () => {
      const root = hostWith(undefined);
      const stubborn = nodeExecutable(
        root,
        "bash",
        'process.on("SIGTERM", () => {});\nsetTimeout(() => {}, 60_000);\n'
      );
      execFileMock.mockReturnValue({ stdout: `${stubborn}\n`, stderr: "" });
      const cancel = new AbortController();
      cancel.abort();

      const startedAt = Date.now();
      const found = await resolveBashInterpreter(process.env, cancel.signal);

      expect(found).toEqual({ cancelled: true });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(execFileMock).not.toHaveBeenCalled();
    },
    30_000
  );

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

describe("a candidate that leaves a job holding stderr", () => {
  onPosix(
    "answers when the candidate exits, not a settle later",
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

      const found = await resolveBashInterpreter();
      const answeredAt = Date.now();

      expect(found).toEqual({ path: brief });
      expect(answeredAt - Number(fs.readFileSync(stamp, "utf8"))).toBeLessThan(200);
    },
    30_000
  );

  onPosix(
    "still quotes a refused candidate's reason written after it exits",
    async () => {
      const root = hostWith(undefined);
      const late = nodeExecutable(
        root,
        "bash",
        'require("node:child_process")\n' +
          '  .spawn(process.execPath, ["-e", "setTimeout(() => process.stderr.write(\\"No version is set for command bash\\\\n\\"), 50)"], {\n' +
          '    stdio: ["ignore", "ignore", "inherit"],\n' +
          "  })\n" +
          "  .unref();\n" +
          "process.exit(126);\n"
      );
      pinGlobalConfig({ scripts: { bash: late } });

      const found = (await resolveBashInterpreter()) as { problem: string };

      expect(found.problem).toContain("is not a bash");
      expect(found.problem).toContain("(it wrote to stderr: No version is set for command bash)");
    },
    30_000
  );
});

describe("no bash anywhere", () => {
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
