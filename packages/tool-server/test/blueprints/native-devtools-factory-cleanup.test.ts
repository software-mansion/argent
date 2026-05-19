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
});
