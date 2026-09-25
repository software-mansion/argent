import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// The resolver scans the real filesystem; only the offline probe spawns a
// process, so child_process is mocked for isSkillsCliCached.
const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: { ...actual, execFileSync: execFileSyncMock },
    execFileSync: execFileSyncMock,
  };
});

import { isSkillsCliCached, resolveSkillsRunner, skillsCommand } from "../src/skills-runner.js";
import { withNpmForce } from "../src/utils.js";

// Fake-executable fixtures live under per-test temp dirs on an injected PATH,
// so these tests never depend on the real PATH, which may lack npx entirely
// when pnpm manages Node (#1206).
const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-skills-runner-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writePosixExecutable(filePath: string): void {
  fs.writeFileSync(filePath, "#!/bin/sh\n");
  fs.chmodSync(filePath, 0o755);
}

afterEach(() => {
  // Runs even when an assertion above threw, so a failing test never strands
  // a temp dir.
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveSkillsRunner", () => {
  it("prefers npx (with --force args) when both npx and pnpm are on PATH", () => {
    const bin = makeTmpDir();
    writePosixExecutable(path.join(bin, "npx"));
    writePosixExecutable(path.join(bin, "pnpm"));

    const runner = resolveSkillsRunner({ PATH: bin }, "linux")!;

    expect(runner.kind).toBe("npx");
    expect(runner.bin).toBe(path.join(bin, "npx"));
    expect(runner.label).toBe("npx");
    expect(runner.buildArgs(["skills", "add", "x"])).toEqual(withNpmForce(["skills", "add", "x"]));
  });

  it("falls back to `pnpm dlx` when only pnpm is on PATH (#1206)", () => {
    const bin = makeTmpDir();
    writePosixExecutable(path.join(bin, "pnpm"));

    const runner = resolveSkillsRunner({ PATH: bin }, "linux")!;

    expect(runner.kind).toBe("pnpm");
    expect(runner.bin).toBe(path.join(bin, "pnpm"));
    expect(runner.label).toBe("pnpm dlx");
    expect(runner.buildArgs(["skills", "add", "x"])).toEqual(["dlx", "skills", "add", "x"]);
  });

  it("returns null when neither npx nor pnpm is on PATH", () => {
    // A bare `npx` would let cmd.exe pick up an npx.cmd from the working
    // directory, so there is no fallback runner.
    const bin = makeTmpDir();

    expect(resolveSkillsRunner({ PATH: bin }, "linux")).toBeNull();
  });

  // NTFS doesn't gate execution on the POSIX mode bits this test flips, so it
  // only means something run on a POSIX filesystem.
  it.skipIf(process.platform === "win32")(
    "ignores a non-executable file on POSIX and keeps looking",
    () => {
      const bin = makeTmpDir();
      // Present but not runnable — must not be mistaken for a usable npx.
      fs.writeFileSync(path.join(bin, "npx"), "not actually runnable");
      fs.chmodSync(path.join(bin, "npx"), 0o644);
      writePosixExecutable(path.join(bin, "pnpm"));

      const runner = resolveSkillsRunner({ PATH: bin }, "linux")!;

      expect(runner.bin).toBe(path.join(bin, "pnpm"));
    }
  );

  it("finds pnpm.CMD via an injected PATHEXT on win32", () => {
    const bin = makeTmpDir();
    fs.writeFileSync(path.join(bin, "pnpm.CMD"), "@echo off\n");

    const runner = resolveSkillsRunner({ PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32")!;

    // The full path, extension included: cmd.exe then never searches the
    // working directory for a same-named shim.
    expect(runner.bin).toBe(path.join(bin, "pnpm.CMD"));
    expect(runner.label).toBe("pnpm dlx");
  });

  it("falls back to the default PATHEXT list on win32 when PATHEXT is unset", () => {
    const bin = makeTmpDir();
    fs.writeFileSync(path.join(bin, "pnpm.CMD"), "@echo off\n");

    const runner = resolveSkillsRunner({ PATH: bin }, "win32")!;

    expect(runner.bin).toBe(path.join(bin, "pnpm.CMD"));
  });

  it("skips relative PATH entries, which resolve against the working directory", () => {
    const cwd = makeTmpDir();
    fs.mkdirSync(path.join(cwd, "rel"));
    writePosixExecutable(path.join(cwd, "rel", "pnpm"));
    const originalCwd = process.cwd();
    process.chdir(cwd);
    try {
      expect(resolveSkillsRunner({ PATH: "rel" }, "linux")).toBeNull();
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("skillsCommand", () => {
  const pnpmDlx = {
    kind: "pnpm" as const,
    bin: "pnpm",
    buildArgs: (args: string[]) => ["dlx", ...args],
    label: "pnpm dlx",
  };

  it("passes argv straight through on POSIX", () => {
    expect(skillsCommand(pnpmDlx, ["skills", "add", "/a b", "--skill", "*"], "linux")).toEqual({
      file: "pnpm",
      args: ["dlx", "skills", "add", "/a b", "--skill", "*"],
      shell: false,
    });
  });

  it("builds one quoted command line for cmd.exe on win32", () => {
    // .cmd shims only start through a shell, which joins argv unescaped.
    expect(
      skillsCommand(
        pnpmDlx,
        ["skills", "add", "C:\\Users\\Jane Doe\\argent\\skills", "--skill", "*", "-y"],
        "win32"
      )
    ).toEqual({
      file: 'pnpm dlx skills add "C:\\Users\\Jane Doe\\argent\\skills" --skill * -y',
      args: [],
      shell: true,
    });
  });

  it("quotes a resolved runner path that holds a space on win32", () => {
    const npx = {
      kind: "npx" as const,
      bin: "C:\\Program Files\\nodejs\\npx.cmd",
      buildArgs: (args: string[]) => ["--force", ...args],
      label: "npx",
    };
    expect(skillsCommand(npx, ["skills", "add", "x"], "win32").file).toBe(
      '"C:\\Program Files\\nodejs\\npx.cmd" --force skills add x'
    );
  });

  it("quotes cmd.exe metacharacters on win32", () => {
    const { file } = skillsCommand(pnpmDlx, ["a&b", "c|d"], "win32");
    expect(file).toBe('pnpm dlx "a&b" "c|d"');
  });

  it.each(["argent-%PATH%", "argent-!X!", 'say "hi"', "a\nb"])(
    "refuses %j on win32, which cmd.exe would expand or unquote",
    (arg) => {
      expect(() => skillsCommand(pnpmDlx, ["skills", "remove", arg], "win32")).toThrow(/cmd\.exe/);
    }
  );

  it("passes the same characters through untouched on POSIX, where no shell is involved", () => {
    const { args } = skillsCommand(pnpmDlx, ["argent-%PATH%", 'say "hi"'], "linux");
    expect(args).toEqual(["dlx", "argent-%PATH%", 'say "hi"']);
  });
});

describe("isSkillsCliCached", () => {
  const npx = {
    kind: "npx" as const,
    bin: "/usr/local/bin/npx",
    buildArgs: (args: string[]) => ["--force", ...args],
    label: "npx",
  };

  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it("probes the resolved npx with --force --no-install and returns true on success", () => {
    execFileSyncMock.mockReturnValue(Buffer.from("0.1.0\n"));

    expect(isSkillsCliCached(npx, "linux")).toBe(true);
    const [file, args, opts] = execFileSyncMock.mock.calls[0]! as [
      string,
      string[],
      { stdio?: unknown; timeout?: number; shell?: boolean },
    ];
    expect(file).toBe("/usr/local/bin/npx");
    // `--force` softens the host project's npm engine gate (#298).
    expect(args).toEqual(["--force", "--no-install", "skills", "--version"]);
    // Silent, and bounded so a wedged npx cannot hang init.
    expect(opts.stdio).toEqual(["ignore", "ignore", "ignore"]);
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.shell).toBe(false);
  });

  it("returns false when the probe fails (skills CLI not in the npx cache)", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("command failed");
    });

    expect(isSkillsCliCached(npx, "linux")).toBe(false);
  });

  it("returns false for pnpm dlx without spawning anything, as it has no offline mode", () => {
    const pnpmDlx = {
      kind: "pnpm" as const,
      bin: "/usr/local/bin/pnpm",
      buildArgs: (a: string[]) => ["dlx", ...a],
      label: "pnpm dlx",
    };

    expect(isSkillsCliCached(pnpmDlx, "linux")).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
