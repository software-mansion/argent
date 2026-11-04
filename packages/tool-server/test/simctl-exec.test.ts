/**
 * execSimctl against real processes: a stub `xcrun` first on PATH stands in
 * for Xcode's simctl wrapper, a bash script that can hang in a child
 * `xcodebuild -runFirstLaunch`. The point is that a timeout or abort reaps that
 * child too, not only the direct one, and that a call which already settled
 * kills nothing.
 */
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

// A pass-through spy: the kill still lands, so the reaping tests see real
// deaths, and the settled-call tests can see a kill that should not happen.
vi.mock("../src/utils/process-kill", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/process-kill")>();
  return { ...actual, signalGroup: vi.fn(actual.signalGroup) };
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { signalGroup } from "../src/utils/process-kill";
import { SIMCTL_SPAWN_TIMEOUT_MS } from "../src/utils/simctl-config";
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

// Captured before any test fakes timers, so the waits below keep the real clock
// while execSimctl's deadline runs on the fake one.
const realSetTimeout = setTimeout;
const pause = (ms: number): Promise<void> => new Promise((r) => realSetTimeout(r, ms));

/** Polls rather than sleeping once: a killed child may linger briefly unreaped. */
async function waitForChildDeath(): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (childIsAlive()) {
    if (Date.now() > deadline) return false;
    await pause(20);
  }
  return true;
}

async function waitForChildPid(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(childPidFile()) || !fs.readFileSync(childPidFile(), "utf8").trim()) {
    if (Date.now() > deadline) throw new Error("stub never started its child");
    await pause(20);
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
  beforeEach(() => {
    vi.mocked(signalGroup).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  // Once the call answered, its child has exited and the group id is free for
  // the OS to reuse, so a late kill could land on an unrelated process.
  it("kills nothing when the deadline passes after the call answered", async () => {
    // Only the deadline is faked; the child and its pipes still run for real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await expect(execSimctl(["simctl", "list"], { timeoutMs: 1_000 })).resolves.toBe(
      "out:simctl list\n"
    );
    vi.advanceTimersByTime(1_000);
    expect(signalGroup).not.toHaveBeenCalled();
  });

  it("kills nothing when the signal aborts after the call answered", async () => {
    const controller = new AbortController();
    await expect(execSimctl(["simctl", "list"], { signal: controller.signal })).resolves.toBe(
      "out:simctl list\n"
    );
    controller.abort();
    expect(signalGroup).not.toHaveBeenCalled();
  });

  it("gives up after SIMCTL_SPAWN_TIMEOUT_MS when the caller sets no deadline", async () => {
    fs.rmSync(childPidFile(), { force: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let outcome: unknown = "pending";
    void execSimctl(["simctl", "hang"]).then(
      () => (outcome = "resolved"),
      (e: unknown) => (outcome = e)
    );
    await waitForChildPid();

    await vi.advanceTimersByTimeAsync(SIMCTL_SPAWN_TIMEOUT_MS - 1);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(SimctlTimeoutError);
    expect(signalGroup).toHaveBeenCalledWith(expect.any(Number), "SIGKILL");
    expect(await waitForChildDeath()).toBe(true);
  });
});
