import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSkillsRunner } from "../src/skills-runner.js";
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

    expect(runner.bin).toBe("npx");
    expect(runner.label).toBe("npx");
    expect(runner.buildArgs(["skills", "add", "x"])).toEqual(withNpmForce(["skills", "add", "x"]));
  });

  it("falls back to `pnpm dlx` when only pnpm is on PATH (#1206)", () => {
    const bin = makeTmpDir();
    writePosixExecutable(path.join(bin, "pnpm"));

    const runner = resolveSkillsRunner({ PATH: bin }, "linux");

    expect(runner.bin).toBe("pnpm");
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

      expect(runner.bin).toBe("pnpm");
    }
  );

  it("finds pnpm.CMD via an injected PATHEXT on win32", () => {
    const bin = makeTmpDir();
    fs.writeFileSync(path.join(bin, "pnpm.CMD"), "@echo off\n");

    const runner = resolveSkillsRunner({ PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32");

    expect(runner.bin).toBe("pnpm");
    expect(runner.label).toBe("pnpm dlx");
  });

  it("falls back to the default PATHEXT list on win32 when PATHEXT is unset", () => {
    const bin = makeTmpDir();
    fs.writeFileSync(path.join(bin, "pnpm.CMD"), "@echo off\n");

    const runner = resolveSkillsRunner({ PATH: bin }, "win32");

    expect(runner.bin).toBe("pnpm");
  });
});
