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
            .map((id) => `4242\t0\tUIKitApplication:${id}[dffa][rb-legacy]\n`)
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
  nativeDevtoolsBlueprint,
  type NativeDevtoolsApi,
} from "../src/blueprints/native-devtools";
import { nativeDevtoolsStatusTool } from "../src/tools/native-devtools/native-devtools-status";
import { nativeDescribeScreenTool } from "../src/tools/native-devtools/native-describe-screen";
import { queryFullHierarchyTree } from "../src/tools/flows/flow-ios-tree";
import { createDescribeTool } from "../src/tools/describe";

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
          advance(5_000);
          continue;
        }
        if (prescribed === "service_stale") {
          // Apply the tool-server restart. The same per-udid socket path is
          // rebound by a new listener; the app process is untouched.
          advance(2_000);
          await instance.dispose();
          advance(3_000);
          instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
          advance(5_000);
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
      // Launched well after the listener bound, and past the connect grace: the
      // reading a genuinely stale service produces.
      advance(60_000);
      world.execAt = Date.now();
      advance(10_000);

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
    try {
      const api = instance.api as NativeDevtoolsApi;
      adviseOnUninjectedApp(api, BUNDLE, "stale_process", INJECTION_FAILED_RECOVERY);

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
    // A bundle that connects has had its relaunch work. A later stale launch of
    // the same app is a fresh problem and gets the remedy again rather than
    // inheriting a verdict from the previous process.
    const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    let socket: net.Socket | undefined;
    try {
      const api = instance.api as NativeDevtoolsApi;
      adviseOnUninjectedApp(api, BUNDLE, "stale_process", INJECTION_FAILED_RECOVERY);

      socket = await connectApp(api, BUNDLE);

      expect(
        adviseOnUninjectedApp(api, BUNDLE, "unregistered", INJECTION_FAILED_RECOVERY).terminal
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
    try {
      const api = instance.api as NativeDevtoolsApi;
      socket = await connectApp(api, "com.example.peer");
      adviseOnUninjectedApp(api, BUNDLE, "stale_process", INJECTION_FAILED_RECOVERY);

      const advice = adviseOnUninjectedApp(api, BUNDLE, "unregistered", INJECTION_FAILED_RECOVERY);

      expect(advice.terminal).toBe(true);
      expect(advice.message).toContain("com.example.peer");
      expect(advice.message).toContain("specific to this app's binary");
      // The app being diagnosed is not evidence about itself.
      expect(advice.message).not.toContain(`(${BUNDLE})`);
    } finally {
      socket?.destroy();
      await instance.dispose();
    }
  });

  it("names the tool-server as still in scope when nothing has connected", async () => {
    const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    try {
      const api = instance.api as NativeDevtoolsApi;
      adviseOnUninjectedApp(api, BUNDLE, "stale_process", INJECTION_FAILED_RECOVERY);

      const advice = adviseOnUninjectedApp(api, BUNDLE, "unregistered", INJECTION_FAILED_RECOVERY);

      expect(advice.terminal).toBe(true);
      expect(advice.message).toContain("No app on this simulator has connected");
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
      advance(10_000);

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
      advance(10_000);

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
});
