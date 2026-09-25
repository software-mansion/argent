import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSkillsRunner, skillsCommand } from "../src/skills-runner.js";
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

    const runner = resolveSkillsRunner({ PATH: bin }, "linux");

    expect(runner.kind).toBe("npx");
    expect(runner.bin).toBe(path.join(bin, "npx"));
    expect(runner.label).toBe("npx");
    expect(runner.buildArgs(["skills", "add", "x"])).toEqual(withNpmForce(["skills", "add", "x"]));
  });

  it("falls back to `pnpm dlx` when only pnpm is on PATH (#1206)", () => {
    const bin = makeTmpDir();
    writePosixExecutable(path.join(bin, "pnpm"));

    const runner = resolveSkillsRunner({ PATH: bin }, "linux");

    expect(runner.kind).toBe("pnpm");
    expect(runner.bin).toBe(path.join(bin, "pnpm"));
    expect(runner.label).toBe("pnpm dlx");
    expect(runner.buildArgs(["skills", "add", "x"])).toEqual(["dlx", "skills", "add", "x"]);
  });

  it("falls back to npx's unchanged failure mode when neither npx nor pnpm is on PATH", () => {
    const bin = makeTmpDir();

    const runner = resolveSkillsRunner({ PATH: bin }, "linux");

    expect(runner.bin).toBe("npx");
    expect(runner.label).toBe("npx");
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

      const runner = resolveSkillsRunner({ PATH: bin }, "linux");

      expect(runner.bin).toBe(path.join(bin, "pnpm"));
    }
  );

  it("finds pnpm.CMD via an injected PATHEXT on win32", () => {
    const bin = makeTmpDir();
    fs.writeFileSync(path.join(bin, "pnpm.CMD"), "@echo off\n");

    const runner = resolveSkillsRunner({ PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32");

    // The full path, extension included: cmd.exe then never searches the
    // working directory for a same-named shim.
    expect(runner.bin).toBe(path.join(bin, "pnpm.CMD"));
    expect(runner.label).toBe("pnpm dlx");
  });

  it("falls back to the default PATHEXT list on win32 when PATHEXT is unset", () => {
    const bin = makeTmpDir();
    fs.writeFileSync(path.join(bin, "pnpm.CMD"), "@echo off\n");

    const runner = resolveSkillsRunner({ PATH: bin }, "win32");

    expect(runner.bin).toBe(path.join(bin, "pnpm.CMD"));
  });

  it("skips relative PATH entries, which resolve against the working directory", () => {
    const cwd = makeTmpDir();
    fs.mkdirSync(path.join(cwd, "rel"));
    writePosixExecutable(path.join(cwd, "rel", "pnpm"));
    const originalCwd = process.cwd();
    process.chdir(cwd);
    try {
      const runner = resolveSkillsRunner({ PATH: "rel" }, "linux");

      expect(runner.kind).toBe("npx");
      expect(runner.bin).toBe("npx");
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

  it("quotes cmd.exe metacharacters and doubles embedded quotes on win32", () => {
    const { file } = skillsCommand(pnpmDlx, ["a&b", 'say "hi"'], "win32");
    expect(file).toBe('pnpm dlx "a&b" "say ""hi"""');
  });
});
