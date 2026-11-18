import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startSuspensionWatch } from "../src/utils/macos-suspension-watch";

// The fake helper stops the target with SIGSTOP at the times of FAKE_SUSPENSIONS
// and prints what `argent-macos-helper watch-suspension` prints.
const FAKE_HELPER = path.join(__dirname, "fixtures", "macos-fake-library", "fake-helper.cjs");

let dir = "";
let helper = "";
const targets: ChildProcess[] = [];

function target(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  targets.push(child);
  return child.pid!;
}

function stopped(pid: number): boolean {
  // "T" in ps: stopped by a signal.
  return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).startsWith(
    "T"
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suspension-watch-"));
  helper = path.join(dir, "argent-macos-helper");
  fs.writeFileSync(helper, `#!${process.execPath}\nrequire(${JSON.stringify(FAKE_HELPER)});\n`, {
    mode: 0o755,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const child of targets.splice(0)) {
    try {
      process.kill(child.pid!, "SIGCONT");
      child.kill("SIGKILL");
    } catch {
      // gone
    }
  }
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("startSuspensionWatch", () => {
  it("reports each suspension, waits for the app to run, and ends with the windows", async () => {
    vi.stubEnv("FAKE_SUSPENSIONS", JSON.stringify([[150, 400]]));
    const pid = target();
    const watch = await startSuspensionWatch(helper, pid);
    expect(watch).not.toBeNull();
    expect(watch!.suspendedSince()).toBeNull();
    await expect(watch!.waitUntilRunning(10)).resolves.toBe(true);

    await sleep(300);
    const since = watch!.suspendedSince();
    expect(since).not.toBeNull();
    expect(stopped(pid)).toBe(true);
    const asked = Date.now();
    await expect(watch!.waitUntilRunning(5_000)).resolves.toBe(true);
    expect(Date.now() - asked).toBeGreaterThan(100);
    expect(watch!.suspendedSince()).toBeNull();
    expect(stopped(pid)).toBe(false);

    const windows = watch!.end();
    expect(windows).toHaveLength(1);
    const [w] = windows;
    expect(w.endMs - w.startMs).toBeGreaterThan(300);
    expect(w.endMs - w.startMs).toBeLessThan(700);
    // Clipped to the asked range.
    expect(watch!.suspendedMsBetween(w.startMs + 100, w.endMs - 100)).toBe(
      w.endMs - w.startMs - 200
    );
    expect(watch!.suspendedMsBetween(w.endMs, w.endMs + 1_000)).toBe(0);
  });

  it("counts a suspension that is still open, and gives up a wait after its timeout", async () => {
    vi.stubEnv("FAKE_SUSPENSIONS", JSON.stringify([[0, 3_000]]));
    const watch = await startSuspensionWatch(helper, target());
    await sleep(200);
    const since = watch!.suspendedSince()!;
    expect(since).not.toBeNull();
    await expect(watch!.waitUntilRunning(150)).resolves.toBe(false);
    expect(watch!.suspendedMsBetween(since, Date.now())).toBeGreaterThan(250);
    // end() closes the open window now, and the helper continues the app.
    const windows = watch!.end();
    expect(windows).toHaveLength(1);
    expect(watch!.suspendedSince()).toBeNull();
    await expect(watch!.waitUntilRunning(10)).resolves.toBe(true);
  });

  it("closes an open window when the app ends while suspended", async () => {
    vi.stubEnv("FAKE_SUSPENSIONS", JSON.stringify([[0, 10_000]]));
    const pid = target();
    const watch = await startSuspensionWatch(helper, pid);
    await sleep(200);
    expect(watch!.suspendedSince()).not.toBeNull();
    const waiting = watch!.waitUntilRunning(5_000);
    process.kill(pid, "SIGKILL");
    await expect(waiting).resolves.toBe(true);
    expect(watch!.suspendedSince()).toBeNull();
    expect(watch!.end()).toHaveLength(1);
  });

  it("returns null for a helper without the command and for a process that is gone", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubEnv("FAKE_HELPER_NO_WATCH", "1");
    await expect(startSuspensionWatch(helper, target())).resolves.toBeNull();
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain("unknown command watch-suspension");
    vi.unstubAllEnvs();
    await expect(startSuspensionWatch(helper, 99_999_999)).resolves.toBeNull();
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain("no process 99999999");
    await expect(startSuspensionWatch(path.join(dir, "missing"), target())).resolves.toBeNull();
    stderr.mockRestore();
  });
});
