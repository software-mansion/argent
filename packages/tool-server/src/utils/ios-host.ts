import { execFile, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { DeviceInfo } from "@argent/registry";
import {
  axServiceBinaryPath,
  axServiceBinaryPathTcp,
  bootstrapDylibPath,
  bootstrapDylibPathTcp,
  bootstrapDylibPathTvos,
  tcpInjectionDylibs,
} from "@argent/native-devtools-ios";
import { SIMCTL_KILL_SIGNAL, SIMCTL_SPAWN_TIMEOUT_MS } from "./simctl-config";
import {
  cachedDeviceSetForUdid,
  deviceSetForUdid,
  simctlArgsForUdid,
  simctlPrefix,
} from "./ios-device-sets";
import { isTvOsSimulator } from "./ios-devices";
import { ensureAutomationEnabled, isEntitlementBypassActive } from "./ax-prefs";
import {
  proxyStart as simRemoteProxyStart,
  proxyStop as simRemoteProxyStop,
  simctlSpawn as simRemoteSpawn,
  injectDylib as simRemoteInjectDylib,
  setSimulatorEnv as simRemoteSetSimulatorEnv,
} from "./sim-remote";

const execFileAsync = promisify(execFile);

export type IosEndpoint =
  | { transport: "unix"; socketPath: string }
  // `port` is optional: omit (or set undefined) to request an ephemeral OS-assigned
  // port. The listening side writes the realized port back here, so by the time
  // an endpoint flows into the `host.*` functions below it always has `port` set.
  | { transport: "tcp"; port?: number };

/**
 * Strategy that absorbs the local-vs-remote dichotomy out of the iOS
 * blueprints (ax-service, native-devtools). Each iOS service factory threads
 * its setup/teardown through one of these implementations and reads as a
 * linear pipeline instead of an `if (isRemote)` ladder.
 */
export interface IosHost {
  readonly kind: "local" | "remote";
  /** When true, the host can only carry TCP traffic (sim-remote tunnel can't bridge unix sockets). */
  readonly requiresTcp: boolean;

  // ── native-devtools steps ──
  setupNativeDevtoolsEnv(udid: string, endpoint: IosEndpoint): Promise<void>;
  listRunningBundleIds(udid: string): Promise<Set<string>>;

  // ── ax-service steps ──
  /** Local probes via `defaults read`; remote assumes the orchestrator handled it. */
  bootstrapAx(udid: string): Promise<{ entitlementBypassActive: boolean }>;
  /**
   * Local: real `xcrun simctl spawn` process for the ax-service daemon.
   * Remote: fire-and-forget orchestrator setup; returns an `EventEmitter` stub
   * so the surrounding factory's exit/error wiring and `kill()` on dispose
   * still work.
   */
  spawnAxDaemon(udid: string, endpoint: IosEndpoint): ChildProcess;

  // ── reverse tunnel (no-op on local) ──
  startProxy(udid: string, port: number): Promise<void>;
  stopProxy(udid: string, port: number): Promise<void>;
}

/** Current bootstrap filename; `libInjectionBootstrap.dylib` is legacy (pre-rename) and still stripped when merging env. */
const ARGENT_BOOTSTRAP_DYLIB_BASENAMES = new Set([
  "libArgentInjectionBootstrap.dylib",
  "libInjectionBootstrap.dylib",
]);

function splitDyldInsertLibraries(value: string): string[] {
  return value
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Strips Argent bootstrap dylibs (by basename, including the legacy pre-rename name)
 * and entries that don't exist on disk (truncated artifacts from the simctl getenv
 * 127-byte bug, stale paths from old installs, etc.).
 * Entries starting with '@' (loader-path references) are always preserved.
 * Third-party dylibs present on disk (e.g. SimCam) are kept verbatim.
 */
function shouldPreserveDyldInsertLibrariesEntry(entry: string, bootstrapPath: string): boolean {
  if (entry === bootstrapPath) {
    return false;
  }
  if (ARGENT_BOOTSTRAP_DYLIB_BASENAMES.has(path.basename(entry))) {
    return false;
  }
  if (entry.startsWith("@")) {
    return true;
  }
  return fs.existsSync(entry);
}

export function buildDyldInsertLibraries(currentValue: string, bootstrapPath: string): string {
  const preserved = splitDyldInsertLibraries(currentValue).filter((entry) =>
    shouldPreserveDyldInsertLibrariesEntry(entry, bootstrapPath)
  );
  return [...preserved, bootstrapPath].join(":");
}

async function ensureAccessibilityEnabled(udid: string): Promise<void> {
  // iOS 26+ requires AccessibilityEnabled and ApplicationAccessibilityEnabled to be set
  // in the simulator's defaults for SwiftUI to populate the accessibility tree.
  // Without these flags, all UIAccessibility APIs return nil/0 for SwiftUI views.
  const flags = ["AccessibilityEnabled", "ApplicationAccessibilityEnabled"];
  const prefix = simctlPrefix(await deviceSetForUdid(udid));
  await Promise.all(
    flags.map((flag) =>
      execFileAsync(
        "xcrun",
        [
          ...prefix,
          "spawn",
          udid,
          "defaults",
          "write",
          "com.apple.Accessibility",
          flag,
          "-bool",
          "true",
        ],
        { timeout: SIMCTL_SPAWN_TIMEOUT_MS, killSignal: SIMCTL_KILL_SIGNAL }
      )
    )
  );
}

async function setupNativeDevtoolsEnvLocal(udid: string, endpoint: IosEndpoint): Promise<void> {
  // Pick the dylib slice that matches the simulator's target platform. tvOS
  // simulators require a TVOSSIMULATOR-platform dylib — injecting the default
  // IOSSIMULATOR slice causes dyld to silently skip the library and native
  // injection never connects. (Remote sims are iOS-only, so this probe is
  // local-path only.)
  const bootstrapPath = (await isTvOsSimulator(udid))
    ? bootstrapDylibPathTvos()
    : endpoint.transport === "tcp"
      ? bootstrapDylibPathTcp()
      : bootstrapDylibPath();

  const prefix = simctlPrefix(await deviceSetForUdid(udid));

  // Read from launchctl inside the simulator (via simctl spawn) instead of
  // `simctl getenv`. The latter silently truncates values longer than 127 bytes,
  // which corrupts the colon-separated path list and causes stale entries to
  // accumulate on every ensureEnv() cycle.
  const result = await execFileAsync(
    "xcrun",
    [...prefix, "spawn", udid, "launchctl", "getenv", "DYLD_INSERT_LIBRARIES"],
    { encoding: "utf8", timeout: SIMCTL_SPAWN_TIMEOUT_MS, killSignal: SIMCTL_KILL_SIGNAL }
  ).catch((e) => ({ stdout: (e as NodeJS.ErrnoException & { stdout?: string }).stdout ?? "" }));

  const existing = (result.stdout ?? "").trim();
  const updated = buildDyldInsertLibraries(existing, bootstrapPath);

  if (updated !== existing) {
    await execFileAsync(
      "xcrun",
      [...prefix, "spawn", udid, "launchctl", "setenv", "DYLD_INSERT_LIBRARIES", updated],
      { timeout: SIMCTL_SPAWN_TIMEOUT_MS, killSignal: SIMCTL_KILL_SIGNAL }
    );
  }

  if (endpoint.transport === "tcp") {
    if (endpoint.port === undefined) {
      throw new Error("native-devtools TCP endpoint reached host setup before its port was bound");
    }
    await execFileAsync(
      "xcrun",
      [
        ...prefix,
        "spawn",
        udid,
        "launchctl",
        "setenv",
        "NATIVE_DEVTOOLS_IOS_CDP_PORT",
        String(endpoint.port),
      ],
      { timeout: SIMCTL_SPAWN_TIMEOUT_MS, killSignal: SIMCTL_KILL_SIGNAL }
    );
  } else {
    await execFileAsync(
      "xcrun",
      [
        ...prefix,
        "spawn",
        udid,
        "launchctl",
        "setenv",
        "NATIVE_DEVTOOLS_IOS_CDP_SOCKET",
        endpoint.socketPath,
      ],
      { timeout: SIMCTL_SPAWN_TIMEOUT_MS, killSignal: SIMCTL_KILL_SIGNAL }
    );
  }

  await ensureAccessibilityEnabled(udid);
}

async function setupNativeDevtoolsEnvRemote(udid: string, endpoint: IosEndpoint): Promise<void> {
  if (endpoint.transport !== "tcp") {
    throw new Error("ios-remote native-devtools requires TCP transport");
  }
  if (endpoint.port === undefined) {
    throw new Error("native-devtools TCP endpoint reached host setup before its port was bound");
  }
  // Upload the TCP dylibs to the orchestrator (the bootstrap is inserted into
  // DYLD_INSERT_LIBRARIES; siblings are co-located so the bootstrap can
  // @loader_path-resolve them), then point the dylib at our reverse-tunneled
  // CDP port. Stage the non-inserted siblings first so every referenced file
  // exists before the bootstrap is inserted.
  const dylibs = [...tcpInjectionDylibs()].sort((a, b) => Number(a.insert) - Number(b.insert));
  for (const { path: filePath, insert } of dylibs) {
    await simRemoteInjectDylib(udid, { filePath, insert });
  }
  await simRemoteSetSimulatorEnv(udid, "NATIVE_DEVTOOLS_IOS_CDP_PORT", String(endpoint.port));
}

/** Parse `launchctl list` output for `UIKitApplication:<bundle-id>` matches. */
function parseUIKitApplicationBundleIds(stdout: string): Set<string> {
  const bundleIds = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/UIKitApplication:([^[]+)/);
    if (match) {
      bundleIds.add(match[1].trim());
    }
  }
  return bundleIds;
}

async function listRunningUIKitApplicationBundleIds(udid: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync(
    "xcrun",
    await simctlArgsForUdid(udid, ["spawn", udid, "launchctl", "list"]),
    {
      encoding: "utf8",
      timeout: SIMCTL_SPAWN_TIMEOUT_MS,
      killSignal: SIMCTL_KILL_SIGNAL,
    }
  );
  return parseUIKitApplicationBundleIds(stdout);
}

function spawnAxDaemonLocal(udid: string, endpoint: IosEndpoint): ChildProcess {
  const binaryPath =
    endpoint.transport === "tcp" ? axServiceBinaryPathTcp() : axServiceBinaryPath();

  if (endpoint.transport === "tcp" && endpoint.port === undefined) {
    throw new Error("ax-service TCP endpoint reached spawn before its port was bound");
  }
  const endpointArgs =
    endpoint.transport === "tcp"
      ? ["--port", String(endpoint.port)]
      : ["--socket", endpoint.socketPath];

  // Synchronous by contract (returns the ChildProcess), so use the cached
  // device-set verdict — `bootstrapAx` has always resolved it by this point.
  const proc = execFile(
    "xcrun",
    [
      ...simctlPrefix(cachedDeviceSetForUdid(udid)),
      "spawn",
      udid,
      binaryPath,
      ...endpointArgs,
      "--timeout",
      "3600",
    ],
    { encoding: "utf8" }
  ) as ChildProcess;

  // Defense-in-depth: a missing udid here would crash the process —
  // throwing inside an async listener bypasses promise rejection and
  // bubbles up as `uncaughtException`, which the tool-server treats as
  // fatal. Tag with "?" instead of dereferencing.
  const udidTag = typeof udid === "string" && udid.length > 0 ? udid.slice(0, 8) : "?";
  proc.stderr?.on("data", (data: string) => {
    process.stderr.write(`[ax-service ${udidTag}] ${data}`);
  });

  return proc;
}

function spawnAxDaemonRemote(udid: string, endpoint: IosEndpoint): ChildProcess {
  if (endpoint.transport !== "tcp") {
    throw new Error("ios-remote ax-service requires TCP transport");
  }
  if (endpoint.port === undefined) {
    throw new Error("ax-service TCP endpoint reached spawn before its port was bound");
  }
  // ios-remote: upload the TCP-built ax-service binary and `simctl spawn` it
  // detached on the orchestrator. There is no local child process to shepherd —
  // return a no-op ChildProcess stub so the surrounding factory code (exit/error
  // wiring, kill on dispose) still type-checks. The remote daemon self-exits
  // after `--timeout`, so the unreachable `kill()` is acceptable.
  const noop = new EventEmitter() as unknown as ChildProcess;
  (noop as unknown as { kill: () => boolean }).kill = () => true;
  void simRemoteSpawn(udid, {
    binPath: axServiceBinaryPathTcp(),
    args: ["--port", String(endpoint.port), "--timeout", "3600"],
    detach: true,
  }).catch((err: Error) => {
    // Defer the emit so listeners attached after this call still see it.
    setImmediate(() => noop.emit("error", err));
  });
  return noop;
}

export const localIosHost: IosHost = {
  kind: "local",
  requiresTcp: false,
  setupNativeDevtoolsEnv: setupNativeDevtoolsEnvLocal,
  listRunningBundleIds: listRunningUIKitApplicationBundleIds,
  async bootstrapAx(udid) {
    await ensureAutomationEnabled(udid);
    return { entitlementBypassActive: await isEntitlementBypassActive(udid) };
  },
  spawnAxDaemon: spawnAxDaemonLocal,
  async startProxy() {},
  async stopProxy() {},
};

/** Accessibility `defaults` keys (all `-bool true`) that describe-driven tools need. */
const ACCESSIBILITY_DEFAULT_FLAGS = [
  "AutomationEnabled",
  "AccessibilityEnabled",
  "ApplicationAccessibilityEnabled",
];

export const remoteIosHost: IosHost = {
  kind: "remote",
  requiresTcp: true,
  setupNativeDevtoolsEnv: setupNativeDevtoolsEnvRemote,
  async listRunningBundleIds(udid) {
    const { stdout } = await simRemoteSpawn(udid, { args: ["launchctl", "list"] });
    return parseUIKitApplicationBundleIds(stdout);
  },
  // Apply the accessibility defaults the tool-server needs (the local host does
  // this via `defaults write`; here we run the same writes through the remote
  // generic spawn). The entitlement-bypass plist is assumed active on cloud
  // sims; if it isn't, describe will still surface a useful error.
  async bootstrapAx(udid) {
    for (const flag of ACCESSIBILITY_DEFAULT_FLAGS) {
      await simRemoteSpawn(udid, {
        args: ["defaults", "write", "com.apple.Accessibility", flag, "-bool", "true"],
      });
    }
    return { entitlementBypassActive: true };
  },
  spawnAxDaemon: spawnAxDaemonRemote,
  startProxy: simRemoteProxyStart,
  stopProxy: simRemoteProxyStop,
};

export function pickIosHost(device: DeviceInfo): IosHost {
  return device.platform === "ios-remote" ? remoteIosHost : localIosHost;
}
