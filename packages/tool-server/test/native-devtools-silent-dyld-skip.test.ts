/**
 * Reproduction for the remedy cycle a dylib dyld silently skips leaves behind.
 *
 * `DYLD_INSERT_LIBRARIES` only proves the bootstrap dylib was handed to the
 * process; it never proves dyld loaded it. dyld skips an inserted library
 * silently when its slice does not match the simulator's platform (the case
 * `setupNativeDevtoolsEnvLocal` already dodges for tvOS — see utils/ios-host.ts),
 * when the dylib is unsigned, or when one of its dependencies is missing.
 * Whenever that happens the app runs, the launchd env is set, the process table
 * shows the injection tokens, and no connection ever arrives.
 *
 * `appConnectionState` reads that process against this service's listener, and
 * the reading alternates with the remedies an agent is handed:
 *
 *   stale_process  → "call restart-app"                    (the process predates the listener)
 *   unregistered   → "restart the tool-server"             (the fresh process post-dates it)
 *   stale_process  → …                                     (the new listener post-dates the process)
 *
 * so obeying each remedy in turn returns the app to a state it has already been
 * in. The test drives the real blueprint and the real tool `execute()`s around
 * that cycle, applying each remedy to the modelled simulator, and asserts the
 * guidance reaches a state whose advice is not one of the two.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as net from "node:net";
import type { DeviceInfo } from "@argent/registry";

const world = vi.hoisted(() => ({
  /** When the app's current process exec'd, on the same clock `Date.now()` reads. */
  execAt: 0,
  /** The environment `ps` renders for that process. */
  env: "",
  /** Bundle ids `launchctl list` reports a UIKitApplication row for. */
  running: [] as string[],
  /** The pid `launchctl list` reports for the current process. A relaunch moves it. */
  pid: 4242,
}));

vi.mock("@argent/native-devtools-ios", () => ({
  bootstrapDylibPath: () => "/fake/dylibs/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTcp: () => "/fake/dylibs/tcp/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTvos: () => "/fake/dylibs/tvos/libArgentInjectionBootstrap.dylib",
  tcpInjectionDylibs: () => [],
  axServiceBinaryPath: () => "/fake/ax-service",
  axServiceBinaryPathTcp: () => "/fake/ax-service-tcp",
}));

// Every tool gates `execute()` behind `ensureDeps(["xcrun"])`, which probes the
// host toolchain. Nothing on the path under test shells out to xcrun itself.
vi.mock("../src/utils/check-deps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/check-deps")>();
  return { ...actual, ensureDeps: vi.fn(async () => {}), ensureDep: vi.fn(async () => {}) };
});

type ExecCb = (err: Error | null, out: { stdout: string; stderr: string }) => void;

/** `ps -o etime` renders `[[dd-]hh:]mm:ss`, dropping leading zero units. */
function etime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const rest = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return hours > 0 ? `${hours}:${rest}` : rest;
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (cmd: string, args: readonly string[], opts: unknown, cb?: ExecCb) => {
      const callback = (typeof opts === "function" ? opts : cb!) as ExecCb;
      const argv = args.join(" ");
      if (/\bps$/.test(cmd)) {
        // Age and launch environment of the one modelled process.
        callback(null, {
          stdout: `${etime(Date.now() - world.execAt)} /Devices/App.app/App ${world.env}\n`,
          stderr: "",
        });
        return;
      }
      if (argv.includes("launchctl list")) {
        callback(null, {
          stdout: world.running
            .map((id) => `${world.pid}\t0\tUIKitApplication:${id}[dffa][rb-legacy]\n`)
            .join(""),
          stderr: "",
        });
        return;
      }
      if (argv.includes("simctl list")) {
        callback(null, { stdout: JSON.stringify({ devices: {} }), stderr: "" });
        return;
      }
      // `launchctl getenv/setenv` and everything else: the env applies cleanly.
      callback(null, { stdout: "", stderr: "" });
    },
  };
});

import {
  adviseOnUninjectedApp,
  buildAppStateMessage,
  INJECTION_FAILED_RECOVERY,
  NATIVE_DEVTOOLS_CONNECT_BUDGET_MS,
  nativeDevtoolsBlueprint,
  type NativeDevtoolsApi,
} from "../src/blueprints/native-devtools";
import { nativeDevtoolsStatusTool } from "../src/tools/native-devtools/native-devtools-status";
import { nativeDescribeScreenTool } from "../src/tools/native-devtools/native-describe-screen";
import { queryFullHierarchyTree } from "../src/tools/flows/flow-ios-tree";
import { createDescribeTool } from "../src/tools/describe";
import { describeIos } from "../src/tools/describe/platforms/ios";

const UDID = "DD1D0000-1111-2222-3333-444444444444";
const SOCKET = "/tmp/argent-nd-DD1D0000.sock";
const BUNDLE = "com.example.silentskip";
const device: DeviceInfo = { id: UDID, platform: "ios", kind: "simulator" };

/** The tokens a silently-skipped dylib leaves in the process table regardless. */
const INJECTED_ENV =
  `NATIVE_DEVTOOLS_IOS_CDP_SOCKET=${SOCKET} ` +
  "DYLD_INSERT_LIBRARIES=/fake/dylibs/libArgentInjectionBootstrap.dylib";

/** How many remedy cycles an agent is modelled as obeying before we give up. */
const REMEDY_CYCLES = 8;

/**
 * Ages a process that never dialed out of the connect budget, so it reads
 * `unregistered` rather than `connecting`. Derived, because these scenarios
 * only reach the terminal diagnosis from the far side of that budget — pinning
 * a literal here would silently park them on `connecting` the next time it
 * moves, and every assertion below would fail somewhere other than the change.
 */
const PAST_CONNECT_BUDGET_MS = NATIVE_DEVTOOLS_CONNECT_BUDGET_MS + 1_000;

type Instance = Awaited<ReturnType<typeof nativeDevtoolsBlueprint.factory>>;

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/**
 * Dial the service's real unix socket and complete the bootstrap handshake, so
 * an app registers through exactly the path the injected dylib uses.
 */
async function connectApp(api: NativeDevtoolsApi, bundleId: string): Promise<net.Socket> {
  const socket = net.connect(api.socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(JSON.stringify({ type: "Control", payload: { bundleId } }) + "\n");
  for (let i = 0; i < 200 && !api.isConnected(bundleId); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!api.isConnected(bundleId)) throw new Error(`handshake for ${bundleId} never registered`);
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  world.execAt = Date.now() - 600_000;
  world.env = INJECTED_ENV;
  world.running = [BUNDLE];
  world.pid = 4242;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("native-devtools — a dylib inserted but silently skipped by dyld", () => {
  it("stops prescribing remedies once they have returned the app to a state it has been in", async () => {
    let instance: Instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    advance(10_000);

    const trace: string[] = [];
    const seen = new Set<string>();
    const prescribedPerCycle: string[] = [];
    let repeatedAt: number | null = null;
    let terminalAt: number | null = null;

    try {
      for (let cycle = 1; cycle <= REMEDY_CYCLES; cycle++) {
        const api = instance.api as NativeDevtoolsApi;
        // Surface 1 — what an agent probes before reaching for a native tool.
        const status = await nativeDevtoolsStatusTool.execute(
          { nativeDevtools: api },
          { udid: UDID, bundleId: BUNDLE }
        );
        // Surface 2 — a native feature tool, routed through the shared precheck.
        const feature = await nativeDescribeScreenTool.execute(
          { nativeDevtools: api },
          { udid: UDID, bundleId: BUNDLE }
        );

        const measured = "status" in status ? status.status : status.state;
        const prescribed = feature.status;
        const key = `${measured}/${prescribed}`;
        prescribedPerCycle.push(prescribed);
        trace.push(
          `cycle ${cycle} | status → ${measured} | feature → ${prescribed}` +
            `${"message" in feature ? `: ${feature.message}` : ""}`
        );
        if (seen.has(key) && repeatedAt === null) repeatedAt = cycle;
        seen.add(key);

        if (prescribed === "restart_required") {
          // Apply restart-app. The relaunch is real — a different process, into
          // the current launchd env — and dyld skips the dylib again, so the new
          // process carries the same tokens and never dials.
          advance(2_000);
          world.execAt = Date.now();
          world.pid += 1;
          advance(PAST_CONNECT_BUDGET_MS);
          continue;
        }
        if (prescribed === "service_stale") {
          // Apply the tool-server restart. The same per-udid socket path is
          // rebound by a new listener; the app process is untouched.
          advance(2_000);
          await instance.dispose();
          advance(3_000);
          instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
          advance(PAST_CONNECT_BUDGET_MS);
          continue;
        }
        terminalAt = cycle;
        break;
      }

      expect(
        repeatedAt,
        `the guidance returned the app to an already-visited state at cycle ${repeatedAt}:\n${trace.join("\n")}`
      ).toBeNull();
      expect(
        terminalAt,
        `no surface ever stopped prescribing restart-app / tool-server restart:\n${trace.join("\n")}`
      ).not.toBeNull();
      // One relaunch prescribed, performed, and then the terminal reading. The
      // tool-server remedy never appears: it is the half of the cycle whose
      // record it discards, so prescribing it once is prescribing it forever.
      expect(prescribedPerCycle, trace.join("\n")).toEqual([
        "restart_required",
        "injection_failed",
      ]);
    } finally {
      await instance.dispose();
    }
  });

  it("keeps the tool-server remedy on a first-contact unregistered app", async () => {
    // The bound is on the SECOND step of the cycle, not on `unregistered`
    // itself: a genuinely stale service is what that state is for, and its
    // remedy is the only one that fixes it.
    const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    try {
      const api = instance.api as NativeDevtoolsApi;
      // Launched well after the listener bound, and past the connect budget: the
      // reading a genuinely stale service produces.
      advance(60_000);
      world.execAt = Date.now();
      advance(PAST_CONNECT_BUDGET_MS);

      await expect(api.appConnectionState(BUNDLE)).resolves.toBe("unregistered");
      const advice = adviseOnUninjectedApp(api, BUNDLE, "unregistered", INJECTION_FAILED_RECOVERY);

      expect(advice).toEqual({
        terminal: false,
        message: buildAppStateMessage(BUNDLE, "unregistered"),
      });
    } finally {
      await instance.dispose();
    }
  });

  it("does not spend the relaunch remedy on repeated reads of the same state", async () => {
    // A single agent turn legitimately reads twice — a `native-devtools-status`
    // probe and the feature tool it was gating. Neither reading is evidence the
    // remedy was tried, so neither may consume it.
    const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    try {
      const api = instance.api as NativeDevtoolsApi;

      for (let i = 0; i < 5; i++) {
        expect(
          adviseOnUninjectedApp(api, BUNDLE, "unregistered", INJECTION_FAILED_RECOVERY).terminal
        ).toBe(false);
      }
      for (let i = 0; i < 5; i++) {
        expect(
          adviseOnUninjectedApp(api, BUNDLE, "stale_process", INJECTION_FAILED_RECOVERY).terminal
        ).toBe(false);
      }
    } finally {
      await instance.dispose();
    }
  });

  it("turns terminal only for the bundle whose relaunch was prescribed", async () => {
    const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    advance(10_000);
    try {
      const api = instance.api as NativeDevtoolsApi;
      // A stale process hands out the relaunch remedy and records its pid.
      await expect(api.appConnectionState(BUNDLE)).resolves.toBe("stale_process");
      adviseOnUninjectedApp(api, BUNDLE, "stale_process", INJECTION_FAILED_RECOVERY);

      // The relaunch: a fresh process (a new pid) that dyld skips exactly as
      // before, so it reads unregistered.
      advance(2_000);
      world.execAt = Date.now();
      world.pid += 1;
      advance(PAST_CONNECT_BUDGET_MS);
      await expect(api.appConnectionState(BUNDLE)).resolves.toBe("unregistered");

      expect(
        adviseOnUninjectedApp(api, BUNDLE, "unregistered", INJECTION_FAILED_RECOVERY).terminal
      ).toBe(true);
      expect(
        adviseOnUninjectedApp(api, "com.example.other", "unregistered", INJECTION_FAILED_RECOVERY)
          .terminal
      ).toBe(false);
    } finally {
      await instance.dispose();
    }
  });

  it("clears the spent remedy when the app connects", async () => {
    // The handshake is what retires a hand-out, and the app that drops its
    // socket afterwards is the case that needs it: the relaunch worked, so the
    // silence that follows is a fresh problem rather than the load failure the
    // terminal diagnosis asserts. Every reading here goes through
    // `appConnectionState` — the pid the verdict compares against is only
    // recorded there, so advising on a bundle this service has never inspected
    // compares one absent pid with another and cannot tell the two apart.
    const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    let socket: net.Socket | undefined;
    advance(10_000);
    try {
      const api = instance.api as NativeDevtoolsApi;
      await expect(api.appConnectionState(BUNDLE)).resolves.toBe("stale_process");
      adviseOnUninjectedApp(api, BUNDLE, "stale_process", INJECTION_FAILED_RECOVERY);

      // The relaunch the remedy asked for, into a fresh pid — and this one does
      // register, which is the remedy converging.
      advance(2_000);
      world.execAt = Date.now();
      world.pid += 1;
      socket = await connectApp(api, BUNDLE);

      // Then it drops the socket and goes silent again, on the same process.
      socket.destroy();
      for (let i = 0; i < 200 && api.isConnected(BUNDLE); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(api.isConnected(BUNDLE)).toBe(false);
      advance(PAST_CONNECT_BUDGET_MS);
      await expect(api.appConnectionState(BUNDLE)).resolves.toBe("unregistered");

      expect(
        adviseOnUninjectedApp(api, BUNDLE, "unregistered", INJECTION_FAILED_RECOVERY).terminal,
        "an app that answered the relaunch must not inherit its verdict"
      ).toBe(false);
    } finally {
      socket?.destroy();
      await instance.dispose();
    }
  });

  it("localises the fault to this app's binary when a peer is connected", async () => {
    // DYLD_INSERT_LIBRARIES is simulator-wide and the listener is one socket, so
    // a connected peer proves the env, the dylib and this service's listener all
    // work — the difference between "re-boot the simulator" and "look at this
    // app's binary".
    const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    let socket: net.Socket | undefined;
    advance(10_000);
    try {
      const api = instance.api as NativeDevtoolsApi;
      socket = await connectApp(api, "com.example.peer");
      await expect(api.appConnectionState(BUNDLE)).resolves.toBe("stale_process");
      adviseOnUninjectedApp(api, BUNDLE, "stale_process", INJECTION_FAILED_RECOVERY);

      // Relaunch into a fresh pid that still never registers.
      advance(2_000);
      world.execAt = Date.now();
      world.pid += 1;
      advance(PAST_CONNECT_BUDGET_MS);
      await expect(api.appConnectionState(BUNDLE)).resolves.toBe("unregistered");

      const advice = adviseOnUninjectedApp(api, BUNDLE, "unregistered", INJECTION_FAILED_RECOVERY);

      expect(advice.terminal).toBe(true);
      expect(advice.message).toContain("com.example.peer");
      expect(advice.message).toContain("specific to this app's binary");
    } finally {
      socket?.destroy();
      await instance.dispose();
    }
  });

  it("names the tool-server as still in scope when nothing is connected", async () => {
    const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    advance(10_000);
    try {
      const api = instance.api as NativeDevtoolsApi;
      await expect(api.appConnectionState(BUNDLE)).resolves.toBe("stale_process");
      adviseOnUninjectedApp(api, BUNDLE, "stale_process", INJECTION_FAILED_RECOVERY);

      advance(2_000);
      world.execAt = Date.now();
      world.pid += 1;
      advance(PAST_CONNECT_BUDGET_MS);
      await expect(api.appConnectionState(BUNDLE)).resolves.toBe("unregistered");

      const advice = adviseOnUninjectedApp(api, BUNDLE, "unregistered", INJECTION_FAILED_RECOVERY);

      expect(advice.terminal).toBe(true);
      expect(advice.message).toContain("No app on this simulator is connected");
      expect(advice.message).toContain("boot-device with force=true");
    } finally {
      await instance.dispose();
    }
  });

  it("gives describe's iOS fallback the terminal diagnosis instead of the tool-server remedy", async () => {
    const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    try {
      const api = instance.api as NativeDevtoolsApi;
      const registry = {
        resolveService: async (urn: string) => {
          if (urn.startsWith("NativeDevtools:")) return api;
          throw new Error("ax-service unavailable in this test");
        },
      } as unknown as Parameters<typeof createDescribeTool>[0];
      const tool = createDescribeTool(registry);
      const params = { udid: UDID, bundleId: BUNDLE };

      advance(10_000);
      const advised = await tool.execute({}, params);
      expect(advised.should_restart).toBe(true);
      expect(advised.hint).toContain("call restart-app then retry");

      // Apply restart-app: a fresh process, skipped by dyld exactly as before.
      world.execAt = Date.now();
      world.pid += 1;
      advance(PAST_CONNECT_BUDGET_MS);

      const terminal = await tool.execute({}, params);
      expect(terminal.should_restart).toBeUndefined();
      expect(terminal.hint).toContain(
        "was told to relaunch, and the process now running is a different one"
      );
      expect(terminal.hint).toContain("dyld skips an inserted library silently");
      // The tool-server remedy is the half of the cycle that discards the record
      // proving the relaunch was already tried, so it must not be prescribed.
      expect(terminal.hint).not.toContain("argent server stop");
    } finally {
      await instance.dispose();
    }
  });

  it("gives the flow hierarchy reader the terminal diagnosis with a flow-level remedy", async () => {
    const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    try {
      const api = instance.api as NativeDevtoolsApi;
      const registry = { resolveService: async () => api } as unknown as Parameters<
        typeof queryFullHierarchyTree
      >[0];

      advance(10_000);
      await expect(queryFullHierarchyTree(registry, device, BUNDLE)).rejects.toThrow(
        /call restart-app then retry/
      );

      world.execAt = Date.now();
      world.pid += 1;
      advance(PAST_CONNECT_BUDGET_MS);

      await expect(queryFullHierarchyTree(registry, device, BUNDLE)).rejects.toThrow(
        /was told to relaunch, and the process now running is a different one/
      );
      await expect(queryFullHierarchyTree(registry, device, BUNDLE)).rejects.toThrow(
        /takes a point directly and reads no tree/
      );
    } finally {
      await instance.dispose();
    }
  });

  it("reports the terminal status from native-devtools-status itself", async () => {
    // The surface the flow-recovery ladder sends an author to, and the only one
    // whose terminal block is its own rather than the shared precheck's. Without
    // it the tool falls through to `state: "unregistered"`, whose message is the
    // tool-server remedy — the half of the cycle this file exists to retire.
    const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    try {
      const api = instance.api as NativeDevtoolsApi;
      advance(10_000);
      await expect(api.appConnectionState(BUNDLE)).resolves.toBe("stale_process");
      adviseOnUninjectedApp(api, BUNDLE, "stale_process", INJECTION_FAILED_RECOVERY);

      advance(2_000);
      world.execAt = Date.now();
      world.pid += 1;
      advance(PAST_CONNECT_BUDGET_MS);

      const result = await nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: UDID, bundleId: BUNDLE }
      );

      expect("status" in result && result.status).toBe("injection_failed");
      expect("state" in result, "the terminal block carries no state to act on").toBe(false);
      expect("message" in result && result.message).toContain(
        "was told to relaunch, and the process now running is a different one"
      );
      expect("message" in result && result.message).not.toContain("argent server stop");
    } finally {
      await instance.dispose();
    }
  });

  it("ends the precheck's terminal message on the uninjected dead-end, not the non-injectable one", async () => {
    // The two tails are one identifier apart at the call site and only one is
    // true here: these tools answer `injection_failed`, they do not throw
    // NATIVE_DEVTOOLS_NOT_INJECTABLE the way a com.apple.* bundle id does.
    const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    try {
      const api = instance.api as NativeDevtoolsApi;
      advance(10_000);
      await expect(api.appConnectionState(BUNDLE)).resolves.toBe("stale_process");
      adviseOnUninjectedApp(api, BUNDLE, "stale_process", INJECTION_FAILED_RECOVERY);

      advance(2_000);
      world.execAt = Date.now();
      world.pid += 1;
      advance(PAST_CONNECT_BUDGET_MS);

      const feature = await nativeDescribeScreenTool.execute(
        { nativeDevtools: api },
        { udid: UDID, bundleId: BUNDLE }
      );

      expect(feature.status).toBe("injection_failed");
      const message = (feature as { message?: string }).message;
      expect(message, "the terminal block carries no message").toBeTypeOf("string");
      // Spelled out rather than compared against INJECTION_FAILED_RECOVERY:
      // composing the expectation from the constant under test passes just as
      // happily when the constant itself is rebuilt from the wrong warning.
      // `endsWith`, not `toContain`, because the swap replaces the tail — a
      // containment check on the diagnosis ahead of it holds either way.
      expect(
        message!.endsWith(
          "Do not fall back to the native-devtools feature tools (native-describe-screen, " +
            "native-find-views, native-full-hierarchy, native-network-logs, native-view-at-point, " +
            "native-user-interactable-view-at-point) — they read the same connection state and " +
            "return the same injection_failed status."
        ),
        "wrong dead-end warning"
      ).toBe(true);
      expect(message).not.toContain("fail with the same non-injectable error");
    } finally {
      await instance.dispose();
    }
  });

  it("does not record the relaunch hand-out for a read whose hint no agent sees", async () => {
    // `describeIos` is also await-ui-element's and await-screen-idle's per-poll
    // tree read, whose non-final hints are dropped. A record written there would
    // let any later process replacement — a crash, a Metro reload, another agent
    // — pass as the relaunch the terminal diagnosis opens by asserting.
    const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    try {
      const api = instance.api as NativeDevtoolsApi;
      const registry = {
        resolveService: async (urn: string) => {
          if (urn.startsWith("NativeDevtools:")) return api;
          throw new Error("ax-service unavailable in this test");
        },
      } as unknown as Parameters<typeof describeIos>[0];

      advance(10_000);
      const polled = await describeIos(registry, device, { bundleId: BUNDLE }, { isTvOs: false });
      expect(polled.hint).toContain("call restart-app then retry");

      // Something other than the agent replaces the process.
      advance(2_000);
      world.execAt = Date.now();
      world.pid += 1;
      advance(PAST_CONNECT_BUDGET_MS);

      await expect(api.appConnectionState(BUNDLE)).resolves.toBe("unregistered");
      expect(
        adviseOnUninjectedApp(api, BUNDLE, "unregistered", INJECTION_FAILED_RECOVERY).terminal,
        "a hint nobody read is not a relaunch anybody was told to perform"
      ).toBe(false);
    } finally {
      await instance.dispose();
    }
  });

  it("does not read one process's whole-second quantisation flip as a relaunch", async () => {
    // `ps -o etime` is whole-second, so a process exec'd 2-3 s after the
    // listener bound sits inside the slop band where the stale/unregistered
    // comparison depends on the sub-second phase. One process observed twice —
    // with no relaunch in between — reads stale_process and then unregistered,
    // and the pid-based record must keep that from reading as a relaunch.
    const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    try {
      const api = instance.api as NativeDevtoolsApi;
      // exec 2.5 s after the listener bound → Δ ∈ (2000, 3000) slop band.
      advance(2_500);
      world.execAt = Date.now();
      // Age to exactly 15 000 ms (r = 0): reads stale_process.
      advance(15_000);
      expect(await api.appConnectionState(BUNDLE)).toBe("stale_process");
      adviseOnUninjectedApp(api, BUNDLE, "stale_process", INJECTION_FAILED_RECOVERY);

      // The same process, 700 ms later (r = 700): the quantised age crosses the
      // band and the identical pid now reads unregistered. No relaunch happened.
      advance(700);
      expect(await api.appConnectionState(BUNDLE)).toBe("unregistered");
      const advice = adviseOnUninjectedApp(api, BUNDLE, "unregistered", INJECTION_FAILED_RECOVERY);

      expect(advice.terminal, "a single un-relaunched process must not read terminal").toBe(false);
    } finally {
      await instance.dispose();
    }
  });
});
