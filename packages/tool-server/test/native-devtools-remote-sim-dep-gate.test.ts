/**
 * The native-devtools tools (native-describe-screen, native-find-views, …)
 * support both local iOS simulators (driven via `xcrun simctl spawn`) and
 * REMOTE iOS simulators (routed through `sim-remote`, no local xcrun needed) —
 * their capability declares `appleRemote: { simulator: true }`.
 *
 * A regression once put a *global* `requires: ["xcrun"]` on these tools. The
 * HTTP dispatcher probes `ToolDefinition.requires` unconditionally (before
 * execution, regardless of the resolved device), so a remote sim on an
 * xcrun-less host got a bogus 424 Failed Dependency even though it never needs
 * xcrun. The correct gating is per device kind, done inside `execute`
 * (`sim-remote` for remote sims, `xcrun` for local sims) — mirroring how
 * `describe` declares its deps per branch.
 *
 * This pins that contract: remote sims are NOT xcrun-gated, local sims still
 * are, and remote sims are gated on the RIGHT binary (sim-remote).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { Registry, TypedEventEmitter } from "@argent/registry";

const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

const resolveAndroidBinaryMock = vi.fn();
vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: (name: "adb" | "emulator") => resolveAndroidBinaryMock(name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

import { createHttpApp } from "../src/http";
import { __resetDepCacheForTests } from "../src/utils/check-deps";
import { nativeDescribeScreenTool } from "../src/tools/native-devtools/native-describe-screen";
import { nativeDevtoolsBlueprint, type NativeDevtoolsApi } from "../src/blueprints/native-devtools";

// Controls which host binaries the real dep-check treats as available: any dep
// in `missing` fails its `command -v` probe, everything else resolves.
function stubProbe(missing: readonly string[]): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      const script = args[1] ?? "";
      const dep = script.replace("command -v ", "").trim();
      if (missing.includes(dep)) cb(new Error(`not found: ${dep}`));
      else cb(null, `/usr/bin/${dep}\n`, "");
    }
  );
  resolveAndroidBinaryMock.mockImplementation(async (name: string) =>
    missing.includes(name) ? null : `/usr/bin/${name}`
  );
}

// Minimal fake NativeDevtools api so `execute` completes without any real
// simctl / sim-remote / socket I/O. `requiresAppRestart: true` makes the
// precheck return `restart_required`, a clean terminal result — the point is
// only that the request reaches execution instead of being 424'd at the gate.
function makeStubApi(): NativeDevtoolsApi {
  return {
    isEnvSetup: () => true,
    socketPath: "/tmp/stub.sock",
    ensureEnvReady: async () => {},
    reverifyEnv: async () => {},
    getInitFailure: () => null,
    isConnected: () => false,
    isAppRunning: async () => false,
    listConnectedBundleIds: () => [],
    requiresAppRestart: async () => true,
    activateNetworkInspection: () => {},
    getNetworkLog: () => [],
    clearNetworkLog: () => {},
    getAppState: async () => {
      throw new Error("unused in this test");
    },
    detectFrontmostBundleId: async () => null,
    queryViewHierarchy: async () => ({}),
  };
}

function makeRegistry(): Registry {
  const registry = new Registry();
  // Reuse the real blueprint's namespace/getURN but swap in a no-I/O factory so
  // service resolution can't hang or shell out — the dep gating we're testing
  // is entirely separate from the service factory.
  registry.registerBlueprint({
    ...nativeDevtoolsBlueprint,
    factory: async () => ({
      api: makeStubApi(),
      dispose: async () => {},
      events: new TypedEventEmitter(),
    }),
  });
  registry.registerTool(nativeDescribeScreenTool);
  return registry;
}

const REMOTE_UDID = "remote:12345678-1234-1234-1234-123456789012";
const LOCAL_UDID = "12345678-1234-1234-1234-123456789012";
// Physical iPhone UDID shape (8-hex ECID, single dash, 16 hex).
const PHYSICAL_UDID = "00008120-000E6D0C0ABBA01E";

describe("native-devtools tools — per-device-kind dependency gating", () => {
  beforeEach(() => {
    __resetDepCacheForTests();
    execFileMock.mockReset();
    resolveAndroidBinaryMock.mockReset();
  });

  it("does NOT block a REMOTE sim on missing xcrun (routes via sim-remote)", async () => {
    stubProbe(["xcrun"]); // xcrun absent, sim-remote present
    const { app } = createHttpApp(makeRegistry());
    const res = await request(app)
      .post("/tools/native-describe-screen")
      .send({ udid: REMOTE_UDID, bundleId: "com.example.app" });
    // Reaches execution instead of the xcrun preflight 424.
    expect(res.status).not.toBe(424);
    expect(res.status).toBe(200);
  });

  it("still gates a LOCAL sim on xcrun (via the in-execute dep check)", async () => {
    stubProbe(["xcrun"]);
    const { app } = createHttpApp(makeRegistry());
    const res = await request(app)
      .post("/tools/native-describe-screen")
      .send({ udid: LOCAL_UDID, bundleId: "com.example.app" });
    expect(res.status).toBe(424);
    expect(res.body.missing).toEqual(["xcrun"]);
  });

  it("gates a REMOTE sim on the RIGHT binary — sim-remote, not xcrun", async () => {
    stubProbe(["xcrun", "sim-remote"]); // both absent
    const { app } = createHttpApp(makeRegistry());
    const res = await request(app)
      .post("/tools/native-describe-screen")
      .send({ udid: REMOTE_UDID, bundleId: "com.example.app" });
    expect(res.status).toBe(424);
    expect(res.body.missing).toEqual(["sim-remote"]);
  });

  it("rejects a PHYSICAL iOS device at the capability gate (path unaffected)", async () => {
    stubProbe([]); // all deps present — must still be rejected before deps
    const { app } = createHttpApp(makeRegistry());
    const res = await request(app)
      .post("/tools/native-describe-screen")
      .send({ udid: PHYSICAL_UDID, bundleId: "com.example.app" });
    expect(res.status).toBe(400);
  });
});
