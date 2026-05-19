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

// Stub the dylib resolver so the test runs on CI runners where the signed
// native binaries are not downloaded. The path value is never read — ensureEnv
// only feeds it to the (mocked) simctl spawn invocation.
vi.mock("@argent/native-devtools-ios", async () => {
  const actual =
    await vi.importActual<typeof import("@argent/native-devtools-ios")>(
      "@argent/native-devtools-ios"
    );
  return {
    ...actual,
    bootstrapDylibPath: () => "/tmp/fake-bootstrap.dylib",
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
      if (args.includes("getenv")) return { stdout: "", stderr: "" };
      return new Error("simctl spawn failed: CoreSimulatorService unreachable");
    });

    const instance = await nativeDevtoolsBlueprint.factory({}, UDID, { device });

    const failure = instance.api.getInitFailure();
    expect(failure).not.toBeNull();
    expect(failure?.attempts).toBe(1);
    expect(failure?.givenUp).toBe(false);
    expect(failure?.lastError).toContain("simctl spawn failed");

    for (let i = 2; i <= MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS; i++) {
      await expect(instance.api.ensureEnvReady()).rejects.toThrow(/simctl spawn failed/);
      expect(instance.api.getInitFailure()?.attempts).toBe(i);
    }
    expect(instance.api.getInitFailure()?.givenUp).toBe(true);

    // Past the cap ensureEnvReady is a silent no-op.
    const callCountBefore = execFileMock.mock.calls.length;
    await expect(instance.api.ensureEnvReady()).resolves.toBeUndefined();
    expect(execFileMock.mock.calls.length).toBe(callCountBefore);

    await instance.dispose();
    expect(fs.existsSync(SOCKET_PATH)).toBe(false);
  });

  it("collapses overlapping ensureEnvReady calls onto a single in-flight attempt", async () => {
    // Phase 1: fast failure so the factory completes and the api is available.
    execFileMock.mockImplementation((cmd: string, args: readonly string[]) => {
      if (cmd !== "xcrun") return { stdout: "", stderr: "" };
      if (args.includes("getenv")) return { stdout: "", stderr: "" };
      return new Error("simctl spawn failed: factory-init phase");
    });
    const instance = await nativeDevtoolsBlueprint.factory({}, UDID, { device });
    expect(instance.api.getInitFailure()?.attempts).toBe(1);

    // Phase 2: setenv hangs until we reject it — models the simctl-hang case
    // the in-flight guard exists to handle.
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

    const p1 = instance.api.ensureEnvReady();
    const p2 = instance.api.ensureEnvReady();
    const p3 = instance.api.ensureEnvReady();

    await new Promise<void>((r) => setImmediate(r));
    expect(setenvCallCount).toBe(1);

    expect(rejectSetenv).not.toBeNull();
    rejectSetenv!(new Error("simctl spawn failed: hang-mode timeout"));
    const settled = await Promise.allSettled([p1, p2, p3]);
    expect(settled.every((r) => r.status === "rejected")).toBe(true);

    expect(instance.api.getInitFailure()?.attempts).toBe(2);
    expect(setenvCallCount).toBe(1);

    await instance.dispose();
  });
});
