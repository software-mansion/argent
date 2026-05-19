/**
 * `nativeDevtoolsBlueprint.factory` used to throw when `ensureEnv` failed.
 * That meant: the agent saw a wrapped ToolExecutionError instead of a
 * structured `init_failed`, and — because the throw happened AFTER
 * `server.listen` — the `net.Server` and on-disk socket leaked per failed
 * attempt (the registry's `_teardown` skips dispose when `node.instance` was
 * never set).
 *
 * The factory now tolerates env-init failure: it records state on the api
 * (`getInitFailure()`) and returns. Tools precheck via the api like they do
 * for `requiresAppRestart`. This test asserts the new contract:
 *   - factory does not throw when ensureEnv fails
 *   - api.getInitFailure() reports the failure with attempts=1
 *   - retrying via api.ensureEnvReady() walks attempts up to the cap, then
 *     flips `givenUp` to true and silently no-ops
 *   - the resulting api can still be disposed cleanly (no leaks)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";

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
      if (result instanceof Error) {
        const e = result as Error & { stderr?: string; stdout?: string };
        callback(e, { stdout: e.stdout ?? "", stderr: e.stderr ?? "" });
      } else {
        callback(null, result ?? { stdout: "", stderr: "" });
      }
    },
  };
});

import type { DeviceInfo } from "@argent/registry";
import {
  MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
  nativeDevtoolsBlueprint,
} from "../../src/blueprints/native-devtools";

const UDID = "FACTORY1-1111-1111-1111-111111111111";
const device: DeviceInfo = { id: UDID, platform: "ios", kind: "simulator" };
const SOCKET_PATH = `/tmp/argent-nd-${UDID.slice(0, 8)}.sock`;

beforeEach(() => {
  execFileMock.mockReset();
  // Silence the blueprint's per-failure stderr log so test output stays clean.
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    /* expected when dispose already unlinked */
  }
  vi.restoreAllMocks();
});

describe("nativeDevtoolsBlueprint factory — failure tolerance", () => {
  it("tolerates ensureEnv failure and records it on the api", async () => {
    execFileMock.mockImplementation((cmd: string, args: readonly string[]) => {
      if (cmd !== "xcrun") return { stdout: "", stderr: "" };
      // launchctl getenv returns empty; the subsequent setenv fails.
      if (args.includes("getenv")) return { stdout: "", stderr: "" };
      return new Error("simctl spawn failed: CoreSimulatorService unreachable");
    });

    const instance = await nativeDevtoolsBlueprint.factory({}, UDID, { device });

    // The api is usable even though env-init failed.
    const failure = instance.api.getInitFailure();
    expect(failure).not.toBeNull();
    expect(failure?.attempts).toBe(1);
    expect(failure?.givenUp).toBe(false);
    expect(failure?.lastError).toContain("simctl spawn failed");

    // Driving more attempts walks toward the cap and then flips givenUp.
    for (let i = 2; i <= MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS; i++) {
      await expect(instance.api.ensureEnvReady()).rejects.toThrow(/simctl spawn failed/);
      expect(instance.api.getInitFailure()?.attempts).toBe(i);
    }
    expect(instance.api.getInitFailure()?.givenUp).toBe(true);

    // Past the cap, ensureEnvReady is a silent no-op — callers should precheck
    // getInitFailure() to surface init_failed.
    const callCountBefore = execFileMock.mock.calls.length;
    await expect(instance.api.ensureEnvReady()).resolves.toBeUndefined();
    expect(execFileMock.mock.calls.length).toBe(callCountBefore);

    await instance.dispose();
    expect(fs.existsSync(SOCKET_PATH)).toBe(false);
  });

  it("collapses overlapping ensureEnvReady calls onto a single in-flight attempt", async () => {
    // Hang-mode failure shape: each simctl spawn hangs until the execFile
    // timeout fires (~10 s in production). The watcher polls every 10 s, so
    // without an in-flight guard each poll would launch its own ensureEnv
    // during the prior attempt, each completion would increment `attempts`,
    // and the counter would overshoot MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS. The
    // guard collapses concurrent callers onto the same promise so `attempts`
    // strictly equals the number of completed ensureEnv invocations.

    // Phase 1: let factory init complete with a fast failure so the api is
    // available before we begin the overlap.
    execFileMock.mockImplementation((cmd: string, args: readonly string[]) => {
      if (cmd !== "xcrun") return { stdout: "", stderr: "" };
      if (args.includes("getenv")) return { stdout: "", stderr: "" };
      return new Error("simctl spawn failed: factory-init phase");
    });
    const instance = await nativeDevtoolsBlueprint.factory({}, UDID, { device });
    expect(instance.api.getInitFailure()?.attempts).toBe(1);

    // Phase 2: swap to a deferred-rejection mock. The setenv promise stays
    // pending until we explicitly reject it — modelling a hang. The mock
    // wrapper passes whatever execFileMock returns to the promisified
    // execFile's callback; awaiting that Promise inside ensureEnv suspends
    // until the inner Promise settles.
    let setenvCallCount = 0;
    let rejectSetenv: ((err: Error) => void) | null = null;
    execFileMock.mockImplementation((cmd: string, args: readonly string[]) => {
      if (cmd !== "xcrun") return { stdout: "", stderr: "" };
      if (args.includes("getenv")) return { stdout: "", stderr: "" };
      setenvCallCount++;
      return new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
        rejectSetenv = reject;
      });
    });

    // Three overlapping callers must all share the same in-flight attempt.
    const p1 = instance.api.ensureEnvReady();
    const p2 = instance.api.ensureEnvReady();
    const p3 = instance.api.ensureEnvReady();

    // Let microtasks drain so the first attempt reaches the suspended setenv.
    await new Promise<void>((r) => setImmediate(r));
    expect(setenvCallCount).toBe(1);

    // Reject the pending setenv. All three callers share the rejection;
    // `attempts` ticks from 1 to 2 exactly once.
    expect(rejectSetenv).not.toBeNull();
    rejectSetenv!(new Error("simctl spawn failed: hang-mode timeout"));
    const settled = await Promise.allSettled([p1, p2, p3]);
    expect(settled.every((r) => r.status === "rejected")).toBe(true);

    expect(instance.api.getInitFailure()?.attempts).toBe(2);
    expect(setenvCallCount).toBe(1);

    await instance.dispose();
  });
});
