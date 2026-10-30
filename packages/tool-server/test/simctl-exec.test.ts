/**
 * execSimctl against real processes: a stub `xcrun` first on PATH stands in
 * for Xcode 27.1's simctl wrapper, a bash script that can hang in a child
 * `xcodebuild -runFirstLaunch`. The point is that a timeout or abort reaps that
 * child too, not only the direct one.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSimctl, SimctlTimeoutError } from "../src/utils/simctl-exec";

let dir: string;
let originalPath: string | undefined;
const childPidFile = (): string => path.join(dir, "child.pid");

function childIsAlive(): boolean {
  const pid = Number(fs.readFileSync(childPidFile(), "utf8"));
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls rather than sleeping once: a killed child may linger briefly unreaped. */
async function waitForChildDeath(): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (childIsAlive()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

async function waitForChildPid(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(childPidFile()) || !fs.readFileSync(childPidFile(), "utf8").trim()) {
    if (Date.now() > deadline) throw new Error("stub never started its child");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-simctl-exec-"));
  // `hang` runs a background-free child like the wrapper's xcodebuild call and
  // records its pid; `fail` exits non-zero; anything else echoes its args.
  fs.writeFileSync(
    path.join(dir, "xcrun"),
    `#!/bin/bash
case "$2" in
  hang) sleep 600 & echo $! > "${dir}/child.pid"; wait ;;
  fail) echo "boom" >&2; exit 3 ;;
  *) echo "out:$*" ;;
esac
`,
    { mode: 0o755 }
  );
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
});

afterAll(() => {
  // A test that failed midway may have left its stub child behind.
  if (fs.existsSync(childPidFile())) {
    try {
      process.kill(Number(fs.readFileSync(childPidFile(), "utf8")), "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  process.env.PATH = originalPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("execSimctl", () => {
  it("resolves with stdout", async () => {
    await expect(execSimctl(["simctl", "list"])).resolves.toBe("out:simctl list\n");
  });

  it("rejects with stderr on a non-zero exit", async () => {
    await expect(execSimctl(["simctl", "fail"])).rejects.toThrow(/code 3: boom/);
  });

  it("kills the wrapper's child on timeout", async () => {
    fs.rmSync(childPidFile(), { force: true });
    // Settled-capture first, so a slow start cannot leave the rejection unobserved.
    const call = execSimctl(["simctl", "hang"], { timeoutMs: 2_000 }).catch((e: unknown) => e);
    await waitForChildPid();
    expect(await call).toBeInstanceOf(SimctlTimeoutError);
    expect(await waitForChildDeath()).toBe(true);
  });

  it("kills the wrapper's child on abort", async () => {
    fs.rmSync(childPidFile(), { force: true });
    const controller = new AbortController();
    const call = execSimctl(["simctl", "hang"], {
      timeoutMs: 60_000,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    await waitForChildPid();
    controller.abort();
    expect(String(await call)).toMatch(/aborted/);
    expect(await waitForChildDeath()).toBe(true);
  });

  it("does not spawn once already aborted", async () => {
    fs.rmSync(childPidFile(), { force: true });
    const controller = new AbortController();
    controller.abort();
    await expect(execSimctl(["simctl", "hang"], { signal: controller.signal })).rejects.toThrow(
      /aborted/
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(childPidFile())).toBe(false);
  });
});
