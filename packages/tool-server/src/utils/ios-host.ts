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
import { PS_BIN } from "./vega-process";
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
  // Omit `port` for an ephemeral OS-assigned one; the listening side writes the
  // realized port back here before the endpoint reaches any `host.*` function.
  | { transport: "tcp"; port?: number };

/**
 * Keeps the local-vs-remote split out of the iOS blueprints (ax-service,
 * native-devtools): each threads its setup/teardown through one implementation
 * instead of an `if (isRemote)` ladder.
 */
export interface IosHost {
  readonly kind: "local" | "remote";
  /** When true, the host can only carry TCP traffic (sim-remote tunnel can't bridge unix sockets). */
  readonly requiresTcp: boolean;

  // native-devtools steps
  setupNativeDevtoolsEnv(udid: string, endpoint: IosEndpoint): Promise<void>;
  listRunningBundleIds(udid: string): Promise<Set<string>>;
  /**
   * Whether `bundleId` is running and, where this host can reach the process,
   * how it was launched. Lets callers tell an app that predates injection —
   * which a relaunch fixes — from one already launched with it.
   */
  inspectRunningApp(udid: string, bundleId: string): Promise<RunningAppInspection>;

  // ax-service steps
  /** Local probes via `defaults read`; remote assumes the orchestrator handled it. */
  bootstrapAx(udid: string): Promise<{ entitlementBypassActive: boolean }>;
  /**
   * Local: real `xcrun simctl spawn` process for the ax-service daemon.
   * Remote: fire-and-forget orchestrator setup; returns an `EventEmitter` stub
   * so the surrounding factory's exit/error wiring and `kill()` on dispose
   * still work.
   */
  spawnAxDaemon(udid: string, endpoint: IosEndpoint): ChildProcess;

  // Reverse tunnel; no-op on local.
  startProxy(udid: string, port: number): Promise<void>;
  stopProxy(udid: string, port: number): Promise<void>;
}

/** `libInjectionBootstrap.dylib` is the legacy pre-rename name, still stripped when merging env. */
const ARGENT_BOOTSTRAP_DYLIB_BASENAMES = new Set([
  "libArgentInjectionBootstrap.dylib",
  "libInjectionBootstrap.dylib",
]);

/** How the process currently backing a bundle id was launched. */
export interface RunningAppProcess {
  pid: number;
  /** Time since exec. `ps -o etime` has whole-second resolution. */
  ageMs: number;
  /**
   * The launch environment as `ps` renders it: space-joined `KEY=VALUE` tokens
   * appended to the argv. Callers pick tokens out of the blob rather than
   * parsing it into pairs — a value containing a space is indistinguishable
   * from the next token, and nothing we look for holds one.
   */
  env: string;
}

export interface RunningAppInspection {
  running: boolean;
  /**
   * Null when there is no process to inspect: the app is not running, or this
   * host cannot reach its app processes (ios-remote runs them on the
   * orchestrator, out of reach of the local process table).
   */
  process: RunningAppProcess | null;
}

/**
 * Whether a process was launched with a given devtools endpoint's injection in
 * place: the Argent bootstrap dylib inserted, pointed at that exact endpoint.
 *
 * A process carrying a *different* endpoint (an ephemeral TCP port from an
 * earlier tool-server run) is not injected for this one; relaunching it into
 * the current launchd env re-points it.
 */
export function processCarriesInjection(env: string, endpoint: IosEndpoint): boolean {
  const inserted = [...ARGENT_BOOTSTRAP_DYLIB_BASENAMES].some((name) => env.includes(name));
  if (!inserted) return false;
  const expected =
    endpoint.transport === "tcp"
      ? `NATIVE_DEVTOOLS_IOS_CDP_PORT=${endpoint.port}`
      : `NATIVE_DEVTOOLS_IOS_CDP_SOCKET=${endpoint.socketPath}`;
  return env.split(/\s+/).includes(expected);
}

/**
 * Separate from the simctl budget: the single-pid `ps` probe reads the local
 * process table with no simulator round-trip, and it is advisory — a slow
 * answer is worth less than a fast "no evidence".
 */
const PS_PROBE_TIMEOUT_MS = 5_000;

/** Parse `ps -o etime` (`[[dd-]hh:]mm:ss`) into seconds. */
export function parsePsElapsedSeconds(etime: string): number | null {
  const match = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
  );
}

function splitDyldInsertLibraries(value: string): string[] {
  return value
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Drops Argent bootstrap dylibs (by basename, including the legacy pre-rename
 * one) and entries absent from disk — truncated artifacts of the `simctl getenv`
 * 127-byte bug, stale paths from old installs. Entries starting with '@'
 * (loader-path references) are preserved regardless.
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
  // iOS 26+ needs both flags in the simulator's defaults for SwiftUI to populate
  // the accessibility tree; without them UIAccessibility returns nil/0 for
  // SwiftUI views.
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
  // tvOS simulators require a TVOSSIMULATOR-platform dylib — dyld silently skips
  // the IOSSIMULATOR slice and native injection never connects.
  const bootstrapPath = (await isTvOsSimulator(udid))
    ? bootstrapDylibPathTvos()
    : endpoint.transport === "tcp"
      ? bootstrapDylibPathTcp()
      : bootstrapDylibPath();

  const prefix = simctlPrefix(await deviceSetForUdid(udid));

  // Read launchctl inside the simulator rather than `simctl getenv`: the latter
  // silently truncates past 127 bytes, corrupting the colon-separated path list
  // and accumulating stale entries on every pass.
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
  // Only the bootstrap is inserted into DYLD_INSERT_LIBRARIES; its siblings must
  // already sit beside it for @loader_path to resolve them, so stage those first.
  // The CDP port it is pointed at lives on the host, via the reverse tunnel.
  const dylibs = [...tcpInjectionDylibs()].sort((a, b) => Number(a.insert) - Number(b.insert));
  for (const { path: filePath, insert } of dylibs) {
    await simRemoteInjectDylib(udid, { filePath, insert });
  }
  await simRemoteSetSimulatorEnv(udid, "NATIVE_DEVTOOLS_IOS_CDP_PORT", String(endpoint.port));
}

/**
 * Parse `launchctl list` rows (`<pid>\t<status>\t<label>`) into
 * `UIKitApplication:<bundle-id>` → pid.
 *
 * A null pid means the column did not parse, not that the job has no process:
 * launchd prints `-` for a registered job that is not running, but measured on
 * iOS 18.6 a `UIKitApplication` row is removed outright when the app exits.
 * Callers treat a null pid as no evidence.
 */
function parseUIKitApplicationJobs(stdout: string): Map<string, number | null> {
  const jobs = new Map<string, number | null>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/UIKitApplication:([^[]+)/);
    if (!match) continue;
    const pid = line.match(/^(\d+)\s/);
    jobs.set(match[1].trim(), pid ? Number(pid[1]) : null);
  }
  return jobs;
}

/** Parse `launchctl list` output for `UIKitApplication:<bundle-id>` matches. */
function parseUIKitApplicationBundleIds(stdout: string): Set<string> {
  return new Set(parseUIKitApplicationJobs(stdout).keys());
}

async function listRunningApps(udid: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "xcrun",
    await simctlArgsForUdid(udid, ["spawn", udid, "launchctl", "list"]),
    {
      encoding: "utf8",
      timeout: SIMCTL_SPAWN_TIMEOUT_MS,
      killSignal: SIMCTL_KILL_SIGNAL,
    }
  );
  return stdout;
}

async function listRunningUIKitApplicationBundleIds(udid: string): Promise<Set<string>> {
  return parseUIKitApplicationBundleIds(await listRunningApps(udid));
}

/**
 * Age and launch environment from the host process table: simulator apps are
 * ordinary host processes owned by the same user, so BSD `ps e` renders the
 * environment they were exec'd with, including the `DYLD_INSERT_LIBRARIES` and
 * endpoint variables that decide whether Argent's dylib loaded. Null when the
 * process is gone or the output doesn't parse; callers read that as "no
 * evidence", never as "not injected".
 *
 * A SIP-protected binary would break that: `ps` suppresses its environment
 * while still printing a well-formed argv, which reads as uninjected rather
 * than unknown. Every pid reaching here comes from a simulator's `launchctl
 * list`, and simulator apps are not SIP-protected — measured on iOS 18.6,
 * third-party and `com.apple.*` bundles alike render their full environment.
 */
async function readProcessLaunchState(pid: number): Promise<RunningAppProcess | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(PS_BIN, ["eww", "-p", String(pid), "-o", "etime=,command="], {
      encoding: "utf8",
      timeout: PS_PROBE_TIMEOUT_MS,
      // Matches the other `ps` probes (vega-process.ts): an environment can run
      // to `kern.argmax` (1 MiB), exactly Node's default cap, so the default
      // would ENOBUFS on a maximal one.
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (err) {
    // Logged, not thrown, like the sibling probe in vega-process.ts: a broken
    // probe (bad `ps` flags, a host without it) degrades *every* app to
    // "indeterminate", indistinguishable from a genuinely uninspectable one. A
    // process that simply exited also lands here, so this is a note.
    process.stderr.write(`[ios-host] ps probe failed for pid ${pid}: ${String(err)}\n`);
    return null;
  }
  const trimmed = stdout.trim();
  const boundary = trimmed.search(/\s/);
  if (boundary === -1) return null;
  const ageSeconds = parsePsElapsedSeconds(trimmed.slice(0, boundary));
  if (ageSeconds === null) return null;
  return { pid, ageMs: ageSeconds * 1000, env: trimmed.slice(boundary + 1) };
}

async function inspectRunningAppLocal(
  udid: string,
  bundleId: string
): Promise<RunningAppInspection> {
  const jobs = parseUIKitApplicationJobs(await listRunningApps(udid));
  if (!jobs.has(bundleId)) return { running: false, process: null };
  const pid = jobs.get(bundleId) ?? null;
  const process = pid === null ? null : await readProcessLaunchState(pid);
  if (process !== null) return { running: true, process };
  // No process behind a job the table had just listed. `{running: true, process:
  // null}` is what `appConnectionState` maps to `indeterminate`, the one
  // unconnected state whose remedy escalates to restarting the tool-server — but
  // an app that exited between the two reads produces exactly this, and its
  // truth is `not_running`, which only needs a launch. Re-read the table: gone
  // means it exited, still listed means the probe itself is what failed.
  const stillListed = parseUIKitApplicationJobs(await listRunningApps(udid)).has(bundleId);
  return { running: stillListed, process: null };
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

  // Precomputed defensively: dereferencing a missing udid inside the stderr
  // listener would throw outside any promise, and the tool-server exits on
  // `uncaughtException`.
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
  // The binary is uploaded and spawned detached on the orchestrator, so there is
  // no local child to shepherd — the stub keeps the surrounding factory's
  // exit/error wiring and `kill()` on dispose type-checking. The remote daemon
  // self-exits after `--timeout`, so the unreachable `kill()` is acceptable.
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
  inspectRunningApp: inspectRunningAppLocal,
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
  // App processes live on the orchestrator, out of reach of the local process
  // table, so only running-ness is answerable; the null process keeps callers on
  // their no-evidence path.
  async inspectRunningApp(udid, bundleId) {
    const { stdout } = await simRemoteSpawn(udid, { args: ["launchctl", "list"] });
    return { running: parseUIKitApplicationJobs(stdout).has(bundleId), process: null };
  },
  // The same accessibility `defaults write`s the local host performs, routed
  // through the remote generic spawn. The entitlement-bypass plist is assumed
  // active on cloud sims.
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
