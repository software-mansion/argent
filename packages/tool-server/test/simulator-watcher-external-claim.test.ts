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

// The watcher reaches simctl through execSimctl (a detached spawn); route it
// through the same mock so tests script its output alongside execFile's.
vi.mock("../src/utils/simctl-exec", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/simctl-exec")>(
    "../src/utils/simctl-exec"
  );
  return {
    ...actual,
    execSimctl: async (args: readonly string[]) => {
      const result = await execFileMock("xcrun", args);
      if (result instanceof Error) throw result;
      return (result ?? { stdout: "" }).stdout;
    },
  };
});

import type { Registry } from "@argent/registry";
import type { NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import { __resetProviderWarningsForTesting } from "../src/utils/external-devices";
import { firstSimulatorPoll, startSimulatorWatcher } from "../src/utils/simulator-watcher";

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
    isEnvSetup: () => true,
    socketPath: "/tmp/mock.sock",
    ensureEnvReady: async () => {},
    reverifyEnv: async () => {},
    armsEnv: true,
    withdrawEnv: async () => {},
    getInitFailure: () => null,
    isConnected: () => false,
    isAppRunning: async () => false,
    listConnectedBundleIds: () => [],
    appConnectionState: async () => "stale_process",
    activateNetworkInspection: () => {},
    getNetworkLog: () => [],
    clearNetworkLog: () => {},
    getAppState: async () => {
      throw new Error("not implemented");
    },
    detectFrontmostBundleId: async () => null,
    queryViewHierarchy: async () => ({}),
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

  /**
   * An attach can wait out the provider's handshake. The provider owns that
   * simulator's injection, so the first input to Argent's own simulators must
   * not wait for it.
   */
  it("settles the first poll without waiting for a lent simulator to attach", async () => {
    publishDescriptor({ capabilities: ["simctl", "native-devtools"] });
    const api = makeApi();

    const resolveService = vi.fn((urn: string) =>
      urn.endsWith(CLAIMED_UDID) ? new Promise<never>(() => {}) : Promise.resolve(api)
    );

    vi.useFakeTimers();

    try {
      const { stop } = startSimulatorWatcher({
        disposeService: vi.fn(async () => {}),
        resolveService,
      } as unknown as Registry);

      let settled = false;
      void firstSimulatorPoll().then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      stop();

      expect(resolvedUdids(resolveService).sort()).toEqual([CLAIMED_UDID, OWN_UDID].sort());
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The window the handoff exists for. A provider boots a simulator, arms its
   * own injection and publishes the descriptor a moment later. A tick landing
   * in between finds an unclaimed simulator and arms over it, pointing
   * `NATIVE_DEVTOOLS_IOS_CDP_SOCKET` at our socket for the rest of the boot.
   *
   * Once the claim lands the environment is the provider's, whatever it
   * granted. A granted claim then re-resolves into attach mode, where we borrow
   * the provider's agent instead of running our own.
   */
  describe("a claim published after argent had already armed the simulator", () => {
    /**
     * The armed service the watcher is holding and the attaching one it should
     * end up with. `resolveService` hands over the second once the descriptor
     * is on disk, the way the factory would.
     */
    function makeHandoffRegistry(): {
      armed: NativeDevtoolsApi & { withdrawEnv: ReturnType<typeof vi.fn> };
      disposeService: ReturnType<typeof vi.fn>;
      publish: (capabilities: string[]) => void;
      registry: Registry;
      resolveService: ReturnType<typeof vi.fn>;
    } {
      const withdrawEnv = vi.fn(async () => {});
      const armed = { ...makeApi(), withdrawEnv };
      const attaching = { ...makeApi(), armsEnv: false };
      let published = false;

      const disposeService = vi.fn(async () => {});
      const resolveService = vi.fn(async () => (published ? attaching : armed));

      return {
        armed,
        disposeService,
        publish: (capabilities: string[]) => {
          publishDescriptor({ capabilities });
          published = true;
        },
        registry: { resolveService, disposeService } as unknown as Registry,
        resolveService,
      };
    }

    /** Run one more poll without waiting out the real ten seconds. */
    async function nextTick(): Promise<void> {
      await vi.advanceTimersByTimeAsync(10_000);
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("hands the environment back and re-resolves when the claim grants native-devtools", async () => {
      const { armed, disposeService, publish, registry, resolveService } = makeHandoffRegistry();

      const { stop } = startSimulatorWatcher(registry);
      await vi.runOnlyPendingTimersAsync();
      expect(resolvedUdids(resolveService).sort()).toEqual([CLAIMED_UDID, OWN_UDID].sort());

      publish(["simctl", "native-devtools"]);
      await nextTick();
      stop();

      expect(armed.withdrawEnv).toHaveBeenCalledTimes(1);
      expect(disposeService).toHaveBeenCalledWith(`NativeDevtools:${CLAIMED_UDID}`);
      /**
       * Resolved again and it is the attaching service the watcher now holds.
       */
      expect(resolvedUdids(resolveService).filter((udid) => udid === CLAIMED_UDID)).toHaveLength(2);
    });

    it("hands the environment back and lets go when the claim withholds it", async () => {
      const { armed, disposeService, publish, registry, resolveService } = makeHandoffRegistry();

      const { stop } = startSimulatorWatcher(registry);
      await vi.runOnlyPendingTimersAsync();

      publish(["simctl", "ax-service"]);
      await nextTick();
      stop();

      expect(armed.withdrawEnv).toHaveBeenCalledTimes(1);
      expect(disposeService).toHaveBeenCalledWith(`NativeDevtools:${CLAIMED_UDID}`);
      /** Not ours any more, so it is not resolved a second time. */
      expect(resolvedUdids(resolveService).filter((udid) => udid === CLAIMED_UDID)).toHaveLength(1);
    });

    /** Once handed over, later ticks leave the provider alone. */
    it("does not withdraw again on the ticks after the handoff", async () => {
      const { armed, publish, registry } = makeHandoffRegistry();

      const { stop } = startSimulatorWatcher(registry);
      await vi.runOnlyPendingTimersAsync();

      publish(["simctl", "native-devtools"]);
      await nextTick();
      await nextTick();
      await nextTick();
      stop();

      expect(armed.withdrawEnv).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * A provider that accepts and then hangs up, or that stopped listening,
   * fails every attach. The watcher backs off instead of dialling the provider
   * and logging a service error each poll.
   */
  describe("a lent simulator whose attach keeps failing", () => {
    function makeFailingRegistry(): {
      registry: Registry;
      resolveService: ReturnType<typeof vi.fn>;
      succeed: () => void;
    } {
      let failing = true;
      const api = makeApi();
      /**
       * What attach mode hands back: nothing of ours on the device to withdraw.
       */
      const attaching = { ...makeApi(), armsEnv: false };

      const resolveService = vi.fn(async (urn: string) => {
        if (!urn.endsWith(CLAIMED_UDID)) return api;
        if (failing) throw new Error("attach lost");
        return attaching;
      });

      return {
        registry: { disposeService: vi.fn(async () => {}), resolveService } as unknown as Registry,
        resolveService,
        succeed: () => {
          failing = false;
        },
      };
    }

    const claimedAttempts = (resolveService: ReturnType<typeof vi.fn>) =>
      resolvedUdids(resolveService).filter((udid) => udid === CLAIMED_UDID).length;

    beforeEach(() => {
      vi.useFakeTimers();
      publishDescriptor({ capabilities: ["simctl", "native-devtools"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * The polls, counted from the first, at which the watcher tried to attach.
     */
    async function attemptPolls(
      resolveService: ReturnType<typeof vi.fn>,
      polls: number
    ): Promise<number[]> {
      const attempted: number[] = [];
      let seen = 0;

      for (let poll = 0; poll <= polls; poll++) {
        if (poll > 0) await vi.advanceTimersByTimeAsync(10_000);

        const attempts = claimedAttempts(resolveService);
        if (attempts > seen) attempted.push(poll);
        seen = attempts;
      }

      return attempted;
    }

    it("waits longer between attempts after each failure", async () => {
      const { registry, resolveService } = makeFailingRegistry();

      const { ready, stop } = startSimulatorWatcher(registry);
      await ready;
      const attempted = await attemptPolls(resolveService, 10);
      stop();

      /** One, two and four polls sat out. */
      expect(attempted).toEqual([0, 2, 5, 10]);
    });

    it("stops doubling the wait at about five minutes", async () => {
      const { registry, resolveService } = makeFailingRegistry();

      const { ready, stop } = startSimulatorWatcher(registry);
      await ready;
      const attempted = await attemptPolls(resolveService, 98);
      stop();

      /** 1, 2, 4, 8 and 16 polls sat out, then 30 each time instead of 32. */
      expect(attempted).toEqual([0, 2, 5, 10, 19, 36, 67, 98]);
    });

    it("attaches at the next due attempt once the provider serves again", async () => {
      const { registry, resolveService, succeed } = makeFailingRegistry();

      const { ready, stop } = startSimulatorWatcher(registry);
      await ready;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(claimedAttempts(resolveService)).toBe(2);

      succeed();
      await vi.advanceTimersByTimeAsync(30_000);
      /** Attached on poll 5. */
      expect(claimedAttempts(resolveService)).toBe(3);

      await vi.advanceTimersByTimeAsync(20_000);
      stop();

      /** Tracked after that, so not resolved again. */
      expect(claimedAttempts(resolveService)).toBe(3);
    });

    it("keeps retrying argent's own simulator on every poll", async () => {
      const { registry, resolveService } = makeFailingRegistry();
      resolveService.mockImplementation(async () => {
        throw new Error("bind failed");
      });

      const { ready, stop } = startSimulatorWatcher(registry);
      await ready;
      await vi.advanceTimersByTimeAsync(30_000);
      stop();

      expect(resolvedUdids(resolveService).filter((udid) => udid === OWN_UDID)).toHaveLength(4);
    });

    /** A failure while it was ours is not held against the provider. */
    it("attaches on the next poll once a provider claims a simulator argent failed on", async () => {
      fs.rmSync(path.join(temporaryDirectory, "acme.json"));
      const { registry, resolveService, succeed } = makeFailingRegistry();

      const { ready, stop } = startSimulatorWatcher(registry);
      await ready;
      expect(claimedAttempts(resolveService)).toBe(1);

      publishDescriptor({ capabilities: ["simctl", "native-devtools"] });
      succeed();
      await vi.advanceTimersByTimeAsync(10_000);
      stop();

      expect(claimedAttempts(resolveService)).toBe(2);
    });

    /** It is argent's own simulator again, so it is retried on every poll. */
    it("drops the wait once the provider goes away while the simulator stays booted", async () => {
      const { registry, resolveService } = makeFailingRegistry();

      const { ready, stop } = startSimulatorWatcher(registry);
      await ready;
      await vi.advanceTimersByTimeAsync(50_000);
      /** Failed at polls 0, 2 and 5, so the next attempt is due at poll 10. */
      expect(claimedAttempts(resolveService)).toBe(3);

      fs.rmSync(path.join(temporaryDirectory, "acme.json"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(claimedAttempts(resolveService)).toBe(4);

      await vi.advanceTimersByTimeAsync(10_000);
      stop();

      expect(claimedAttempts(resolveService)).toBe(5);
    });

    /** A reboot is a fresh start, so the failures before it no longer count. */
    it("starts the wait over once the simulator shuts down and boots again", async () => {
      const { registry, resolveService } = makeFailingRegistry();
      let claimedBooted = true;

      execFileMock.mockImplementation((cmd: string) => {
        if (cmd !== "xcrun") return { stdout: "", stderr: "" };
        return bootedListResponse(claimedBooted ? [CLAIMED_UDID, OWN_UDID] : [OWN_UDID]);
      });

      const { ready, stop } = startSimulatorWatcher(registry);
      await ready;

      const attempted: number[] = [];
      let seen = claimedAttempts(resolveService);
      if (seen > 0) attempted.push(0);

      for (let poll = 1; poll <= 17; poll++) {
        claimedBooted = poll !== 6;
        await vi.advanceTimersByTimeAsync(10_000);

        const attempts = claimedAttempts(resolveService);
        if (attempts > seen) attempted.push(poll);
        seen = attempts;
      }

      stop();

      /**
       * Failed at 0, 2 and 5, shut down at 6, then one, two and four polls sat
       * out.
       */
      expect(attempted).toEqual([0, 2, 5, 7, 9, 12, 17]);
    });

    it("drops the wait while the provider withholds native-devtools", async () => {
      const { registry, resolveService, succeed } = makeFailingRegistry();

      const { ready, stop } = startSimulatorWatcher(registry);
      await ready;
      await vi.advanceTimersByTimeAsync(50_000);
      expect(claimedAttempts(resolveService)).toBe(3);

      publishDescriptor({ capabilities: ["simctl"] });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(claimedAttempts(resolveService)).toBe(3);

      publishDescriptor({ capabilities: ["simctl", "native-devtools"] });
      succeed();
      await vi.advanceTimersByTimeAsync(10_000);
      stop();

      /** Granted again at poll 7, three polls before the old wait ran out. */
      expect(claimedAttempts(resolveService)).toBe(4);
    });
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
