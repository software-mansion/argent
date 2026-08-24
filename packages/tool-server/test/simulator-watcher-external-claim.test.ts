/**
 * The watcher arms devtools injection on every booted simulator it finds, by
 * raw UDID and with no tool call behind it; the one caller that can walk past
 * a gate keyed on the `ext:` id.
 *
 * The e2e device-provider tier runs under a sandbox `$HOME`, which hides the
 * default simulator set from the watcher, so this file is the only coverage.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

import type { Registry } from "@argent/registry";
import type { NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import { __resetProviderWarningsForTesting } from "../src/utils/external-devices";
import { startSimulatorWatcher } from "../src/utils/simulator-watcher";

/** The simulator a provider claims. */
const CLAIMED_UDID = "11111111-1111-1111-1111-111111111111";
/** One argent booted itself, booted alongside it. */
const OWN_UDID = "22222222-2222-2222-2222-222222222222";

/** A pid nothing can be running under, so `kill(0)` fails with ESRCH. */
const DEAD_PID = 0x7fffffff;

let temporaryDirectory: string;

function bootedListResponse(udids: string[]): { stdout: string; stderr: string } {
  return {
    stderr: "",
    stdout: JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-0": udids.map((udid) => ({
          udid,
          state: "Booted",
        })),
      },
    }),
  };
}

/**
 * Publish a descriptor claiming {@linkcode CLAIMED_UDID} and point discovery at
 * it. `test/setup/ignore-device-providers.ts` disables discovery suite-wide and
 * outranks the override, so opting back in means deleting that variable.
 */
function publishDescriptor(options: { capabilities: string[]; pid?: number }): void {
  const descriptorPath = path.join(temporaryDirectory, "acme.json");

  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({
      devices: [
        {
          capabilities: options.capabilities,
          kind: "simulator",
          name: "iPhone 16 Pro",
          nativeId: CLAIMED_UDID,
          platform: "ios",
          state: "Booted",
        },
      ],
      id: "acme-3f2a9c",
      name: "Acme IDE",
      ...(options.pid === undefined ? {} : { pid: options.pid }),
      schemaVersion: 1,
    })
  );

  process.env.ARGENT_DEVICE_PROVIDERS = descriptorPath;
  delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
}

function makeApi(): NativeDevtoolsApi {
  return {
    activateNetworkInspection: () => {},
    appConnectionState: async () => "stale_process",
    clearNetworkLog: () => {},
    detectFrontmostBundleId: async () => null,
    ensureEnvReady: async () => {},
    getAppState: async () => {
      throw new Error("not implemented");
    },
    getInitFailure: () => null,
    getNetworkLog: () => [],
    isAppRunning: async () => false,
    isConnected: () => false,
    isEnvSetup: () => true,
    listConnectedBundleIds: () => [],
    queryViewHierarchy: async () => ({}),
    reverifyEnv: async () => {},
    socketPath: "/tmp/mock.sock",
  };
}

function makeRegistry(): {
  registry: Registry;
  resolveService: ReturnType<typeof vi.fn>;
  disposeService: ReturnType<typeof vi.fn>;
} {
  const api = makeApi();
  const disposeService = vi.fn(async () => {});
  const resolveService = vi.fn(async () => api);

  return {
    disposeService,
    registry: { resolveService, disposeService } as unknown as Registry,
    resolveService,
  };
}

/** The UDIDs the watcher asked the registry to resolve, in call order. */
function resolvedUdids(resolveService: ReturnType<typeof vi.fn>): string[] {
  return resolveService.mock.calls.map(([urn]) => String(urn).split(":")[1]);
}

let stderrWrites: string[];

beforeEach(() => {
  execFileMock.mockReset();
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "argent-watcher-claim-"));
  stderrWrites = [];

  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  });

  __resetProviderWarningsForTesting();

  execFileMock.mockImplementation((cmd: string) => {
    if (cmd === "xcrun") return bootedListResponse([CLAIMED_UDID, OWN_UDID]);
    return { stdout: "", stderr: "" };
  });
});

afterEach(() => {
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  process.env.ARGENT_DISABLE_DEVICE_PROVIDERS = "1";
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("simulator-watcher against a provider's simulator", () => {
  it("never arms injection on a claimed simulator without the grant", async () => {
    publishDescriptor({ capabilities: ["simctl", "ax-service"] });
    const { registry, resolveService } = makeRegistry();

    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    stop();

    expect(resolvedUdids(resolveService)).not.toContain(CLAIMED_UDID);
  });

  it("still takes the simulator argent booted itself, booted alongside it", async () => {
    publishDescriptor({ capabilities: ["simctl"] });
    const { registry, resolveService } = makeRegistry();

    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    stop();

    expect(resolvedUdids(resolveService)).toEqual([OWN_UDID]);
  });

  it("says why it skipped, once, naming the provider", async () => {
    publishDescriptor({ capabilities: ["simctl"] });
    const { registry } = makeRegistry();

    vi.useFakeTimers();
    try {
      const { ready, stop } = startSimulatorWatcher(registry);
      await ready;
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      stop();
    } finally {
      vi.useRealTimers();
    }

    const skipped = stderrWrites.filter((line) => line.includes(CLAIMED_UDID));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatch(/Acme IDE/);
    expect(skipped[0]).toMatch(/native-devtools/);
  });

  it("arms injection when the provider granted native-devtools", async () => {
    publishDescriptor({ capabilities: ["simctl", "native-devtools"] });
    const { registry, resolveService } = makeRegistry();

    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    stop();

    expect(resolvedUdids(resolveService).sort()).toEqual([CLAIMED_UDID, OWN_UDID].sort());
  });

  /** The claim is only as live as the process behind it. */
  it("ignores a claim whose provider process is gone", async () => {
    publishDescriptor({ capabilities: ["simctl"], pid: DEAD_PID });
    const { registry, resolveService } = makeRegistry();

    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    stop();

    expect(resolvedUdids(resolveService).sort()).toEqual([CLAIMED_UDID, OWN_UDID].sort());
  });

  it("honors a claim from a live provider process", async () => {
    publishDescriptor({ capabilities: ["simctl"], pid: process.pid });
    const { registry, resolveService } = makeRegistry();

    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    stop();

    expect(resolvedUdids(resolveService)).toEqual([OWN_UDID]);
  });
});
