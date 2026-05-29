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
} from "@argent/native-devtools-ios";
import { SIMCTL_SPAWN_TIMEOUT_MS } from "./simctl-config";
import { ensureAutomationEnabled, isEntitlementBypassActive } from "./ax-prefs";
import {
  proxyStart as simRemoteProxyStart,
  proxyStop as simRemoteProxyStop,
  setupAxService as simRemoteSetupAxService,
  setupNativeDevtools as simRemoteSetupNativeDevtools,
  setupRunningBundleIds as simRemoteRunningBundleIds,
} from "./sim-remote";

const execFileAsync = promisify(execFile);

export type IosEndpoint =
  | { transport: "unix"; socketPath: string }
  | { transport: "tcp"; port: number };

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
  await Promise.all(
    flags.map((flag) =>
      execFileAsync(
        "xcrun",
        [
          "simctl",
          "spawn",
          udid,
          "defaults",
          "write",
          "com.apple.Accessibility",
          flag,
          "-bool",
          "true",
        ],
        { timeout: SIMCTL_SPAWN_TIMEOUT_MS }
      )
    )
  );
}

async function setupNativeDevtoolsEnvLocal(udid: string, endpoint: IosEndpoint): Promise<void> {
  const bootstrapPath =
    endpoint.transport === "tcp" ? bootstrapDylibPathTcp() : bootstrapDylibPath();

  // Read from launchctl inside the simulator (via simctl spawn) instead of
  // `simctl getenv`. The latter silently truncates values longer than 127 bytes,
  // which corrupts the colon-separated path list and causes stale entries to
  // accumulate on every ensureEnv() cycle.
  const result = await execFileAsync(
    "xcrun",
    ["simctl", "spawn", udid, "launchctl", "getenv", "DYLD_INSERT_LIBRARIES"],
    { encoding: "utf8", timeout: SIMCTL_SPAWN_TIMEOUT_MS }
  ).catch((e) => ({ stdout: (e as NodeJS.ErrnoException & { stdout?: string }).stdout ?? "" }));

  const existing = (result.stdout ?? "").trim();
  const updated = buildDyldInsertLibraries(existing, bootstrapPath);

  if (updated !== existing) {
    await execFileAsync(
      "xcrun",
      ["simctl", "spawn", udid, "launchctl", "setenv", "DYLD_INSERT_LIBRARIES", updated],
      { timeout: SIMCTL_SPAWN_TIMEOUT_MS }
    );
  }

  if (endpoint.transport === "tcp") {
    await execFileAsync(
      "xcrun",
      [
        "simctl",
        "spawn",
        udid,
        "launchctl",
        "setenv",
        "NATIVE_DEVTOOLS_IOS_CDP_PORT",
        String(endpoint.port),
      ],
      { timeout: SIMCTL_SPAWN_TIMEOUT_MS }
    );
  } else {
    await execFileAsync(
      "xcrun",
      [
        "simctl",
        "spawn",
        udid,
        "launchctl",
        "setenv",
        "NATIVE_DEVTOOLS_IOS_CDP_SOCKET",
        endpoint.socketPath,
      ],
      { timeout: SIMCTL_SPAWN_TIMEOUT_MS }
    );
  }

  await ensureAccessibilityEnabled(udid);
}

/**
 * Bare basename of the bootstrap dylib the orchestrator should inject. The
 * dylib lives on the orchestrator side (it's the TCP variant of the local
 * `libArgentInjectionBootstrap.dylib`) and `sim-remote setup native-devtools`
 * resolves it by basename against the orchestrator's own dylib directory —
 * we never need a local copy. Hardcoding the basename avoids a
 * `bootstrapDylibPathTcp()` lookup that would throw on dev machines that
 * don't ship the local TCP variant.
 */
const REMOTE_BOOTSTRAP_DYLIB_BASENAME = "libArgentInjectionBootstrap.dylib";

async function setupNativeDevtoolsEnvRemote(udid: string, endpoint: IosEndpoint): Promise<void> {
  if (endpoint.transport !== "tcp") {
    throw new Error("ios-remote native-devtools requires TCP transport");
  }
  await simRemoteSetupNativeDevtools(udid, {
    libs: [REMOTE_BOOTSTRAP_DYLIB_BASENAME],
    cdpPort: endpoint.port,
  });
}

async function listRunningUIKitApplicationBundleIds(udid: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", "spawn", udid, "launchctl", "list"], {
    encoding: "utf8",
  });

  const bundleIds = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/UIKitApplication:([^\[]+)/);
    if (match) {
      bundleIds.add(match[1].trim());
    }
  }
  return bundleIds;
}

function spawnAxDaemonLocal(udid: string, endpoint: IosEndpoint): ChildProcess {
  const binaryPath =
    endpoint.transport === "tcp" ? axServiceBinaryPathTcp() : axServiceBinaryPath();

  const endpointArgs =
    endpoint.transport === "tcp"
      ? ["--port", String(endpoint.port)]
      : ["--socket", endpoint.socketPath];

  const proc = execFile(
    "xcrun",
    ["simctl", "spawn", udid, binaryPath, ...endpointArgs, "--timeout", "3600"],
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
  // ios-remote: the orchestrator-supplied daemon is started by
  // `sim-remote setup ax-service`. There is no local child process to
  // shepherd — return a no-op ChildProcess stub so the surrounding factory
  // code (exit/error wiring, kill on dispose) still type-checks.
  const noop = new EventEmitter() as unknown as ChildProcess;
  (noop as unknown as { kill: () => boolean }).kill = () => true;
  void simRemoteSetupAxService(udid, { port: endpoint.port, timeoutSecs: 3600 }).catch(
    (err: Error) => {
      // Defer the emit so listeners attached after this call still see it.
      setImmediate(() => noop.emit("error", err));
    }
  );
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

export const remoteIosHost: IosHost = {
  kind: "remote",
  requiresTcp: true,
  setupNativeDevtoolsEnv: setupNativeDevtoolsEnvRemote,
  async listRunningBundleIds(udid) {
    return new Set(await simRemoteRunningBundleIds(udid));
  },
  // sim-remote applies the accessibility defaults at boot via `setup
  // accessibility-defaults`, and the entitlement-bypass plist is managed
  // there too. Mark the service as non-degraded on the assumption sim-remote
  // did the right thing; if not, describe will still surface useful errors.
  async bootstrapAx() {
    return { entitlementBypassActive: true };
  },
  spawnAxDaemon: spawnAxDaemonRemote,
  startProxy: simRemoteProxyStart,
  stopProxy: simRemoteProxyStop,
};

export function pickIosHost(device: DeviceInfo): IosHost {
  return device.platform === "ios-remote" ? remoteIosHost : localIosHost;
}
