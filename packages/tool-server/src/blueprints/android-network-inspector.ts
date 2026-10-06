import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
  FAILURE_CODES,
  FailureError,
  TypedEventEmitter,
  getFailureSignal,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import { binDir } from "@argent/native-devtools-android";
import {
  adbReverse,
  adbShell,
  adbShellInput,
  removeAdbReverse,
  runAdb,
  shellQuote,
} from "../utils/adb";
import {
  attachNdjsonReader,
  createNdjsonCdpRequester,
  previewJson,
  reportDroppedFrameToStderr,
  writeNdjsonFrame,
  type NdjsonCdpRequester,
} from "../utils/ndjson-socket";
import { withKeyedLock } from "../utils/keyed-lock";
import { canonicalDeviceId } from "../utils/debugger/device-alias";
import { externalNativeId } from "../utils/external-devices";
import {
  AGENT_ABIS,
  AGENT_LIB_NAME,
  DEVICE_STAGING_DIR,
  JAR_NAME,
  agentDirFor,
  attachScript,
  classifyRunAsFailure,
  processKey,
  processOfUser,
  readAppProcesses,
  readDeviceFacts,
  removeSessionScript,
  resolveAppAbi,
  runAsCommand,
  sessionScript,
  type AgentAbi,
  type AppProcess,
  type AppProcesses,
} from "./android-network-inspector-device";

export const ANDROID_NETWORK_INSPECTOR_NAMESPACE = "AndroidNetworkInspector";

interface AndroidNetworkInspectorOptions extends Record<string, unknown> {
  device: DeviceInfo;
  packageName: string;
  metroPort: number;
}

/**
 * One device, whichever id names it: an `ext:` id and the adb serial behind
 * it, or a Metro logicalDeviceId and the id it was connected with, all key the
 * same inspector.
 */
function deviceKeyOf(deviceId: string): string {
  return externalNativeId(canonicalDeviceId(deviceId) ?? deviceId);
}

/**
 * The URN has no Metro port: one app on one device has one inspector, and each
 * call hands it the port it should use.
 */
export function androidNetworkInspectorRef(
  device: DeviceInfo,
  packageName: string,
  metroPort: number
): { urn: string; options: AndroidNetworkInspectorOptions } {
  return {
    urn: `${ANDROID_NETWORK_INSPECTOR_NAMESPACE}:${deviceKeyOf(device.id)}:${packageName}`,
    options: { device, packageName, metroPort },
  };
}

/** `attach-agent` needs API 26. */
const MIN_SDK = 26;
/** An Android package name: dot-separated Java identifiers, so never a `:` or a quote. */
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
const PROTOCOL_VERSION = 2;

/** Record memory is bounded by count and by size, whichever binds first. */
const MAX_RECORDS = 2000;
const RECORD_CHARS_BUDGET = 32 * 1024 * 1024;
/** One URL, header value or text field; longer ones keep their start. */
const MAX_VALUE_CHARS = 64 * 1024;
const MAX_HEADERS = 256;
const MAX_HEADER_MAP_CHARS = 256 * 1024;
const MAX_REDIRECTS = 32;
const MAX_LAYER_ID_CHARS = 200;
const MAX_CACHED_BODIES = 64;

/** An authenticated agent's sealed frames: a body can be several MiB of base64. */
const MAX_FRAME_CHARS = 8 * 1024 * 1024;
/** The handshake frames are a few hundred bytes; the port is reachable from every app on the device. */
const HANDSHAKE_FRAME_CHARS = 4 * 1024;
const MAX_PENDING_HANDSHAKES = 32;
const AUTH_TIMEOUT_MS = 5_000;
/** After the handshake, every frame either way is `{"type":"Sealed","payload":"<base64>"}`. */
const SEALED = "Sealed";
const GCM_TAG_BYTES = 16;

const DEVICE_PORT_MIN = 20_000;
const DEVICE_PORT_SPAN = 10_000;
const DEVICE_PORT_ATTEMPTS = 8;

const NEW_PROCESS_WAIT_MS = 3_000;
const PROCESS_POLL_INTERVAL_MS = 250;
const ARM_WAIT_MS = 5_000;
const ARM_PROCESS_CHECK_MS = 500;
const RECHECK_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];
/** The agent flushes what it buffered while disconnected, up to 8 MiB, before it replies. */
const ENABLE_TIMEOUT_MS = 60_000;
const DISABLE_TIMEOUT_MS = 1_000;
const SESSION_REMOVE_TIMEOUT_MS = 5_000;

export const AGENT_BINARIES_MISSING_REASON = "agent binaries not present in this build";
const AGENT_GONE_REASON =
  "the agent that recorded the request is no longer in the app, as after an emulator snapshot load";
const LOST_WHILE_DISCONNECTED =
  "the agent lost this request's final events while it was disconnected";
const NOT_RECONNECTED =
  "the agent did not reconnect after its connection dropped, so this request's final events never arrived";
const PROCESS_ENDED = "the app process ended before the request finished";
const JS_LAYER_FALLBACK =
  "Use view-network-logs: the JS layer still records the app's JavaScript requests while Metro serves the app.";

/**
 * A tag per tool-server start, so an id from before a restart never names
 * another request.
 */
const RUN_TAG = randomBytes(2).toString("hex");

export const ANDROID_NATIVE_REQUEST_ID = /^android-[0-9a-f]{4}-\d+$/;

export interface AndroidNetworkNotAttachable {
  status: "not_attachable";
  reason: string;
  fallback: string;
}

export type AndroidNativeRecordState = "pending" | "headers" | "complete" | "failed";

/** One hop before the final response: what was asked, and what came back. */
export interface AndroidNativeRedirect {
  /** The URL that answered with the redirect. */
  url: string;
  method: string;
  status: number;
  statusText: string;
  /** The redirect response's headers. */
  headers: Record<string, string>;
  /** As this hop's request went on the wire, when the agent reported them. */
  requestHeaders?: Record<string, string>;
}

export interface AndroidNativeRecord {
  id: string;
  layer: "android-native";
  layerId: string;
  connection: number;
  rnRequestId?: number;
  state: AndroidNativeRecordState;
  request: {
    /** The URL the app requested. */
    url: string;
    method: string;
    /** As the app set them. */
    headers: Record<string, string>;
    /** As they went on the wire for the latest hop, when the agent reported them. */
    wireHeaders?: Record<string, string>;
    hasPostData?: boolean;
  };
  /** The hops before the final response, oldest first. */
  redirects?: AndroidNativeRedirect[];
  response?: {
    /** The final URL, after any redirects. */
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
    fromCache?: boolean;
  };
  timing: { startedAt: number; durationMs?: number };
  resourceType?: string;
  encodedDataLength?: number;
  errorText?: string;
}

export interface AndroidNetworkBody {
  available: boolean;
  body: string;
  base64Encoded: boolean;
  truncated: boolean;
  reason?: string;
}

export type AndroidCaptureState = "active" | "waiting" | "unavailable";

export interface AndroidNetworkInspectorState {
  armed: boolean;
  /** The process of the live connection; absent once that connection is gone. */
  process?: { pid: number; startTime: number };
  /** What the live connection's agent reports; absent once that connection is gone. */
  capture?: { state: AndroidCaptureState; detail?: string };
  /** Events the agent dropped from its buffer while it was disconnected. */
  droppedEvents?: number;
  note?: string;
}

/**
 * A call that did not reach the device after capture was set up: what was
 * captured is still listed, and `note` says why the device was not reached.
 */
export interface AndroidNetworkCallNote {
  status: "ok";
  note: string;
}

export interface AndroidNetworkInspectorApi {
  readonly packageName: string;
  /**
   * Sets capture up and attaches the agent to the running app; `metroPort` is
   * the caller's. A note about this call alone comes back with it, never
   * through `state()`, which concurrent calls share.
   */
  ensureAttached(
    metroPort: number
  ): Promise<AndroidNetworkNotAttachable | AndroidNetworkCallNote | null>;
  state(): AndroidNetworkInspectorState;
  records(metroPort: number): AndroidNativeRecord[];
  record(id: string): AndroidNativeRecord | undefined;
  responseBody(id: string): Promise<AndroidNetworkBody>;
  requestPostData(id: string): Promise<AndroidNetworkBody>;
  clear(): void;
}

interface InspectorHandle {
  readonly api: AndroidNetworkInspectorApi;
  readonly serial: string;
  readonly packageName: string;
  /** Set once the device's identity was read; see `DeviceFacts.hardwareKey`. */
  hardwareKey: string | null;
  /** Capture is live from a successful native-network-logs call until stop, stop-all or exit. */
  isLive(): boolean;
  attachLaunch(): Promise<string | undefined>;
}

/**
 * Every inspector, by device key. `view-network-request-details` knows only an
 * `android-…` id, and launch-app and restart-app know the package but must not
 * create an inspector nobody asked for, so both look here.
 */
const liveInspectors = new Map<string, Set<InspectorHandle>>();
let nextRecordNumber = 1;

function allHandles(): InspectorHandle[] {
  return [...liveInspectors.values()].flatMap((set) => [...set]);
}

/** Ids are unique per tool-server, so the device that recorded one does not matter. */
export function findAndroidNativeRecord(
  id: string
): { inspector: AndroidNetworkInspectorApi; record: AndroidNativeRecord } | undefined {
  for (const handle of allHandles()) {
    const record = handle.api.record(id);
    if (record) return { inspector: handle.api, record };
  }
  return undefined;
}

/** Package names with live native network capture on the device. */
export function liveAndroidNetworkCaptures(deviceId: string): string[] {
  return [...(liveInspectors.get(deviceKeyOf(deviceId)) ?? [])]
    .filter((handle) => handle.isLive())
    .map((handle) => handle.packageName)
    .sort();
}

/** Adb serials of the devices with live native network capture for the app. */
export function liveAndroidNetworkCaptureDevices(packageName: string): string[] {
  const serials = allHandles()
    .filter((handle) => handle.packageName === packageName && handle.isLive())
    .map((handle) => handle.serial);
  return [...new Set(serials)].sort();
}

/**
 * Attaches the agent to the app's new process while native capture is live
 * for it, and returns a one-line note for the launch's output then; undefined
 * when capture is not live. Never throws: a launch must not fail because
 * network capture could not follow it.
 */
export async function attachAndroidNetworkInspectorToLaunch(
  deviceId: string,
  packageName: string
): Promise<string | undefined> {
  try {
    for (const handle of liveInspectors.get(deviceKeyOf(deviceId)) ?? []) {
      if (handle.packageName !== packageName || !handle.isLive()) continue;
      return await handle.attachLaunch();
    }
  } catch (err) {
    process.stderr.write(
      `[${ANDROID_NETWORK_INSPECTOR_NAMESPACE}:${deviceId}:${packageName}] attach after launch failed: ${errorMessage(err)}\n`
    );
  }
  return undefined;
}

export const androidNetworkInspectorBlueprint: ServiceBlueprint<
  AndroidNetworkInspectorApi,
  string
> = {
  namespace: ANDROID_NETWORK_INSPECTOR_NAMESPACE,

  getURN(payload: string) {
    return `${ANDROID_NETWORK_INSPECTOR_NAMESPACE}:${payload}`;
  },

  async factory(_deps, _payload, options) {
    const opts = options as AndroidNetworkInspectorOptions | undefined;
    if (
      !opts?.device ||
      typeof opts.packageName !== "string" ||
      !PACKAGE_NAME.test(opts.packageName)
    ) {
      throw new FailureError(
        `${ANDROID_NETWORK_INSPECTOR_NAMESPACE}.factory needs { device, packageName } with an Android package name; ` +
          `use androidNetworkInspectorRef(device, packageName, metroPort).`,
        {
          error_code: FAILURE_CODES.ANDROID_NETWORK_INSPECTOR_FACTORY_OPTIONS_INVALID,
          failure_stage: "android_network_inspector_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    if (opts.device.platform !== "android") {
      throw new FailureError(
        `${ANDROID_NETWORK_INSPECTOR_NAMESPACE} is Android-only; '${opts.device.id}' classifies as ${opts.device.platform}.`,
        {
          error_code: FAILURE_CODES.ANDROID_NETWORK_INSPECTOR_WRONG_PLATFORM,
          failure_stage: "android_network_inspector_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    const serial = deviceKeyOf(opts.device.id);
    const inspector = createInspector(serial, opts.packageName, opts.metroPort);
    const onDevice = liveInspectors.get(serial) ?? new Set<InspectorHandle>();
    onDevice.add(inspector.handle);
    liveInspectors.set(serial, onDevice);

    return {
      api: inspector.handle.api,
      dispose: async () => {
        onDevice.delete(inspector.handle);
        if (onDevice.size === 0 && liveInspectors.get(serial) === onDevice) {
          liveInspectors.delete(serial);
        }
        await inspector.dispose();
      },
      events: new TypedEventEmitter<ServiceEvents>(),
    };
  },
};

interface AgentConnection {
  index: number;
  socket: net.Socket;
  cdp: NdjsonCdpRequester;
  /** Seals and writes one frame; false when the socket can no longer take it. */
  send: (frame: unknown) => boolean;
  /** From the handshake: the process the agent runs in. */
  pid: number;
  startTime: number;
  processKey: string;
  /** From the handshake: one value per attach, the prefix of the agent's request ids. */
  instance: string;
  /** The highest request sequence number this connection reported. */
  maxSeq: number;
  armed: boolean;
  closed: boolean;
  capture?: { state: AndroidCaptureState; detail?: string };
  droppedEvents: number;
  byLayerId: Map<string, AndroidNativeRecord>;
  resumes?: AgentConnection;
  resumedBy?: AgentConnection;
  agentGone?: boolean;
}

interface Handshake {
  pid: number;
  startTime: number;
  instance: string;
  lastSeq: number;
}

type AttachOutcome = "known" | "loaded" | "attached" | "copy_failed" | "attach_failed";

type LaunchOutcome =
  | { kind: AttachOutcome; proc: AppProcess }
  | { kind: "no_process" }
  | { kind: "blocked"; reason: string };

/** Thrown out of a step that found the inspector disposed while it waited. */
class InspectorStopped extends Error {
  constructor() {
    super("native network capture was stopped");
  }
}

function createInspector(
  serial: string,
  packageName: string,
  initialMetroPort: number
): { handle: InspectorHandle; dispose: () => Promise<void> } {
  const tag = `${ANDROID_NETWORK_INSPECTOR_NAMESPACE}:${serial}:${packageName}`;
  const log = (line: string): void => {
    process.stderr.write(`[${tag}] ${line}\n`);
  };
  /** Proves each side of a connection to the other. Lives in memory and in the app's session file only. */
  const secret = randomBytes(32).toString("hex");
  let metroPort = initialMetroPort;

  let disposed = false;
  let live = false;
  let ready = false;
  let gates: { abi: AgentAbi } | null = null;
  /**
   * The Android user whose copy of the app is inspected: read with the gates,
   * then the foreground user of every process read, once run-as reaches its copy.
   */
  let appUser = 0;
  let staged = false;
  let server: net.Server | null = null;
  /** The listener's port on the host's 127.0.0.1, for the reverse; set once it listens. */
  let hostPort = 0;
  let devicePort = 0;
  let reversed = false;
  /**
   * Where session files were written, by Android user, so dispose takes back
   * each one: after a user switch, the earlier user's too.
   */
  const sessions = new Map<number, string>();
  /** The device port the last session write that went through names. */
  let sessionPort = 0;
  const attachedProcesses = new Set<string>();
  let note: string | undefined;
  const pendingSockets = new Set<net.Socket>();
  const connections: AgentConnection[] = [];
  const records: AndroidNativeRecord[] = [];
  let recordChars = 0;
  const recordSizes = new WeakMap<AndroidNativeRecord, number>();
  const byId = new Map<string, { record: AndroidNativeRecord; conn: AgentConnection }>();
  const bodies = new Map<string, Promise<AndroidNetworkBody>>();
  const cleared = new WeakSet<AndroidNativeRecord>();
  /** Failed only because their final events did not arrive; a later event still settles them. */
  const lostOnly = new WeakSet<AndroidNativeRecord>();
  /** The URL and method of each record's latest hop. */
  const hops = new WeakMap<AndroidNativeRecord, { url: string; method: string }>();
  const startArrivals = new WeakMap<AndroidNativeRecord, number>();
  const armWaiters = new Set<() => void>();
  /** One attach at a time: native-network-logs calls and launches. */
  const attachLock = new Map<string, Promise<unknown>>();
  /**
   * The device port and the session that names it change only under this
   * lock, so a session write on its way never lands after a port change and
   * leaves the session naming a port this inspector gave up.
   */
  const tunnelLock = new Map<string, Promise<unknown>>();
  /** One recheck per process; a drop while one runs restarts its delays. */
  const rechecks = new Map<string, { restart: boolean }>();

  const user = (): number => appUser;
  const checkpoint = (): void => {
    if (disposed) throw new InspectorStopped();
  };

  const notAttachable = (reason: string): AndroidNetworkNotAttachable => ({
    status: "not_attachable",
    reason,
    fallback: JS_LAYER_FALLBACK,
  });

  function sessionLine(port: number): string {
    return `${JSON.stringify({ v: PROTOCOL_VERSION, port, secret })}\n`;
  }

  function setMetroPort(port: number): void {
    if (port === metroPort) return;
    metroPort = port;
    for (const conn of connections) if (!conn.closed) sendMetroPort(conn);
  }

  function sendMetroPort(conn: AgentConnection): void {
    conn.send({ type: "Control", payload: { metroPort } });
  }

  function resetGates(): void {
    ready = false;
    gates = null;
    staged = false;
  }

  async function prepare(): Promise<AndroidNetworkNotAttachable | null> {
    // Once set up, the agent files are on the device: a later call must keep
    // serving the buffer whatever became of this build's copies.
    if (ready) {
      await assertReverse();
      return null;
    }
    const files = agentFiles();
    if (!files) return notAttachable(AGENT_BINARIES_MISSING_REASON);

    if (!gates) {
      const facts = await readDeviceFacts(serial);
      checkpoint();
      if (facts.sdk === null || facts.sdk < MIN_SDK) {
        return notAttachable(
          `attach-agent needs Android 8.0 (API ${MIN_SDK}) or later; this device runs API ${facts.sdk ?? "unknown"}`
        );
      }
      claimHardware(facts.hardwareKey);
      appUser = facts.user;
      // Until the gates pass nothing of this app is captured here, so another
      // connection to the device may inspect it.
      let abi: AgentAbi | AndroidNetworkNotAttachable;
      try {
        abi = await runGates(files, facts.kernelAbi);
      } catch (err) {
        handle.hardwareKey = null;
        throw err;
      }
      if (typeof abi !== "string") {
        handle.hardwareKey = null;
        return abi;
      }
      gates = { abi };
    }

    if (!staged) {
      await adbShell(serial, `mkdir -p ${DEVICE_STAGING_DIR}`, { timeoutMs: 10_000 });
      checkpoint();
      await runAdb(["-s", serial, "push", files.jar, `${DEVICE_STAGING_DIR}/${JAR_NAME}`], {
        timeoutMs: 60_000,
      });
      checkpoint();
      await runAdb(
        ["-s", serial, "push", files.lib[gates.abi]!, `${DEVICE_STAGING_DIR}/${AGENT_LIB_NAME}`],
        { timeoutMs: 60_000 }
      );
      checkpoint();
      staged = true;
    }
    if (!server) await listen();
    await assertReverse();
    ready = true;
    return null;
  }

  /** The app's own gates: `run-as` and the ABI. Returns the ABI to push when they pass. */
  async function runGates(
    files: { lib: Partial<Record<AgentAbi, string>> },
    kernelAbi: AgentAbi | null
  ): Promise<AgentAbi | AndroidNetworkNotAttachable> {
    const blocked = await checkRunAs(appUser);
    checkpoint();
    if (blocked) return blocked;
    const abi = await resolveAppAbi(serial, packageName);
    checkpoint();
    if (kernelAbi === "x86_64" && abi.startsWith("arm")) {
      return notAttachable(
        `${packageName} runs as ${abi} under ARM translation on this x86_64 device, and the agent cannot load into a translated process`
      );
    }
    if (!isAgentAbi(abi) || !files.lib[abi]) {
      return notAttachable(
        `${packageName} runs as ${abi || "an unknown ABI"}, and this build carries the agent for ${Object.keys(files.lib).join(" and ")} only`
      );
    }
    return abi;
  }

  /**
   * One inspector per app per device: two adb connections to one device (USB
   * and wireless) would each write the app's session file, and the agent
   * connects to whichever wrote last.
   */
  function claimHardware(hardwareKey: string | null): void {
    if (hardwareKey) {
      const other = allHandles().find(
        (h) =>
          h !== handle &&
          h.packageName === packageName &&
          h.serial !== serial &&
          h.hardwareKey === hardwareKey
      );
      if (other) {
        throw new FailureError(
          `${packageName} on this device is already inspected through adb serial ${other.serial}, and ${serial} is another connection to the same device. ` +
            `Use ${other.serial}, or end that capture first with native-network-logs and stop: true on ${other.serial}.`,
          {
            error_code: FAILURE_CODES.ANDROID_NETWORK_INSPECTOR_DEVICE_IN_USE,
            failure_stage: "android_network_inspector_device_identity",
            failure_area: "tool_server",
            error_kind: "validation",
          }
        );
      }
    }
    handle.hardwareKey = hardwareKey;
  }

  /**
   * `run-as` is how every file reaches the app, and its refusal says why. Only
   * "not debuggable" and "not an application" are about the build; any other
   * failure names its real cause.
   */
  async function checkRunAs(forUser: number): Promise<AndroidNetworkNotAttachable | null> {
    try {
      await adbShell(serial, runAsCommand(packageName, forUser, "id"), { timeoutMs: 10_000 });
      return null;
    } catch (err) {
      const detail = adbFailureDetail(err);
      switch (classifyRunAsFailure(detail)) {
        case "not_debuggable":
          return notAttachable(
            `${packageName} is not a debuggable build (${detail}); native network capture needs one`
          );
        case "not_application":
          return notAttachable(
            `${packageName} is a system package rather than an app (${detail}), so run-as cannot reach it`
          );
        case "unknown_package":
          throw new FailureError(
            `${packageName} is not installed for Android user ${forUser} on ${serial} (${detail}). Check the package name, or install the app for that user.`,
            {
              error_code: FAILURE_CODES.ANDROID_NETWORK_INSPECTOR_UNKNOWN_PACKAGE,
              failure_stage: "android_network_inspector_run_as",
              failure_area: "tool_server",
              error_kind: "not_found",
            }
          );
        default:
          throw new FailureError(
            `run-as ${packageName} failed on ${serial}: ${detail}. This says nothing about the build; try again once the device answers.`,
            {
              error_code: FAILURE_CODES.ANDROID_NETWORK_INSPECTOR_RUN_AS_FAILED,
              failure_stage: "android_network_inspector_run_as",
              failure_area: "tool_server",
              error_kind:
                getFailureSignal(err)?.error_kind === "timeout" ? "timeout" : "subprocess",
            },
            { cause: err instanceof Error ? err : new Error(String(err)) }
          );
      }
    }
  }

  /**
   * After a switch of the foreground Android user, inspects that user's copy
   * of the app from then on: its process, its run-as and its files. Its run-as
   * gate runs first, so an app that user does not have says so. The earlier
   * user's session stays until dispose, which takes back every user's.
   */
  async function followUser(
    foreground: number | null
  ): Promise<AndroidNetworkNotAttachable | null> {
    if (foreground === null || foreground === appUser) return null;
    const blocked = await checkRunAs(foreground);
    checkpoint();
    if (blocked) return blocked;
    log(
      `Android user ${foreground} is in the foreground now; inspecting its copy of ${packageName}`
    );
    appUser = foreground;
    return null;
  }

  /** Every running process of the app, of any Android user. */
  function runningKeys(read: AppProcesses): Set<string> {
    return new Set(read.processes.map(processKey));
  }

  /**
   * The first bind picks a random device port and refuses one that is already
   * taken, so two inspectors never share a port. A reboot, a replugged cable or
   * an adb server restart drops every reverse, so every trigger asserts it
   * again; for the same ports that is a no-op. A process on the device that
   * took the port meanwhile would get the agent's next connection, so the
   * tunnel moves to a new port and the session follows it: the agent reads the
   * session before every connection.
   */
  async function assertReverse(): Promise<void> {
    await withKeyedLock(tunnelLock, "tunnel", async () => {
      checkpoint();
      if (devicePort !== 0) {
        try {
          await adbReverse(serial, devicePort, hostPort, { timeoutMs: 10_000 });
          reversed = true;
        } catch (err) {
          if (!isPortTaken(err)) throw err;
          log(`device port ${devicePort} is taken on the device now; moving to another port`);
          reversed = false;
          devicePort = 0;
        }
        // A dispose that ran meanwhile removed the reverse before this put it back.
        if (disposed) {
          if (reversed) await removeAdbReverse(serial, devicePort);
          throw new InspectorStopped();
        }
      }
      if (devicePort === 0) await bindDevicePort();
      if (sessions.size > 0 && sessionPort !== devicePort) await runSessionScript(sessionScript);
    });
  }

  async function bindDevicePort(): Promise<void> {
    for (let attempt = 0; attempt < DEVICE_PORT_ATTEMPTS; attempt++) {
      const port = DEVICE_PORT_MIN + randomInt(DEVICE_PORT_SPAN);
      try {
        await adbReverse(serial, port, hostPort, { timeoutMs: 10_000, noRebind: true });
      } catch (err) {
        if (!isPortTaken(err)) throw err;
        log(`device port ${port} is taken; trying another`);
        checkpoint();
        continue;
      }
      devicePort = port;
      reversed = true;
      if (disposed) {
        await removeAdbReverse(serial, port);
        throw new InspectorStopped();
      }
      return;
    }
    throw new FailureError(
      `no free device port for the network inspector's tunnel on ${serial} after ${DEVICE_PORT_ATTEMPTS} tries between ${DEVICE_PORT_MIN} and ${DEVICE_PORT_MIN + DEVICE_PORT_SPAN - 1}`,
      {
        error_code: FAILURE_CODES.ANDROID_NETWORK_INSPECTOR_NO_DEVICE_PORT,
        failure_stage: "android_network_inspector_reverse",
        failure_area: "tool_server",
        error_kind: "network",
      }
    );
  }

  /**
   * The listener the reverse leads to. Apps on an emulator reach it too,
   * through 10.0.2.2, which is safe: only a peer that proves the session
   * secret is served, and every frame after the handshake is sealed.
   */
  function listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer(serveAgent);
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        srv.off("error", reject);
        srv.on("error", (err) => log(`listener error: ${err.message}`));
        if (disposed) {
          srv.close();
          reject(new InspectorStopped());
          return;
        }
        server = srv;
        hostPort = (srv.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  function agentLeft(key: string): boolean {
    return (
      connections.some((c) => c.processKey === key) &&
      !connections.some((c) => !c.closed && c.processKey === key)
    );
  }

  async function attach(proc: AppProcess): Promise<AttachOutcome> {
    const key = processKey(proc);
    // Once per process: attach-agent runs in the app asynchronously, so a
    // second attach before the first loaded would load the agent twice. The
    // exception is a process that lost its agent: an emulator snapshot load
    // can bring the app back with its pid and start time, but without the
    // agent. A known process whose connections all closed and that does not
    // map the library (the attach script checks) is that case.
    const known = attachedProcesses.has(key);
    if (known && !agentLeft(key)) return "known";
    checkpoint();
    attachedProcesses.add(key);

    let copy: "loaded" | "copied";
    try {
      copy = await copyIntoApp(proc.pid);
    } catch (err) {
      attachedProcesses.delete(key);
      if (err instanceof InspectorStopped) throw err;
      // run-as refusing now can mean a non-debuggable build replaced the app,
      // so the gates run again first. The device can also have lost the staged
      // files (another AVD on the same serial, a wiped AVD, a snapshot from
      // before the push), so they are pushed again too.
      resetGates();
      note = `copying the agent into ${packageName} failed: ${adbFailureDetail(err)}`;
      log(note);
      return "copy_failed";
    }
    if (copy === "loaded") {
      if (known) return "known";
      // An agent from an earlier Argent dials a port of its own and never
      // reads the session, so this has to hold for that one too.
      note = `pid ${proc.pid} already has the agent loaded, and it should connect within a few seconds; if it does not, that agent is from an earlier Argent, and restart-app gives the app a process with the current one`;
      log(`pid ${proc.pid} already has the agent loaded`);
      return "loaded";
    }
    if (known) {
      for (const c of connections) {
        if (c.processKey === key && !c.agentGone) failResumedChain(c);
      }
      log(`pid ${proc.pid} lost the agent, as after an emulator snapshot load; attaching again`);
    }

    checkpoint();
    const dir = agentDirFor(packageName, user());
    const agentOptions = `jar=${dir}/${JAR_NAME},pkg=${packageName}`;
    try {
      const out = await adbShell(
        serial,
        `cmd activity attach-agent ${proc.pid} ${shellQuote(`${dir}/${AGENT_LIB_NAME}=${agentOptions}`)}`,
        { timeoutMs: 15_000 }
      );
      if (/exception/i.test(out)) throw new Error(out.trim());
    } catch (err) {
      // Forgotten, so the next trigger tries this process again: attach-agent
      // also fails for a process that is still starting.
      attachedProcesses.delete(key);
      // A stop that came meanwhile keeps its own note.
      checkpoint();
      note = `attach-agent failed for pid ${proc.pid} (${firstLine(adbFailureDetail(err))}); the next native-network-logs call or launch tries again`;
      log(note);
      return "attach_failed";
    }
    checkpoint();
    note = `attached to pid ${proc.pid}; waiting for the agent to connect`;
    log(`attached the agent to pid ${proc.pid}`);
    return "attached";
  }

  /**
   * Writes this inspector's session for the app on every attach attempt, so
   * an agent an earlier tool-server attached connects to this one. A process
   * that already loaded the agent is neither copied into nor attached again.
   */
  async function copyIntoApp(pid: number): Promise<"loaded" | "copied"> {
    const out = await withKeyedLock(tunnelLock, "tunnel", () =>
      runSessionScript((dir) => attachScript(dir, pid))
    );
    return /\bloaded\b/.test(out) ? "loaded" : "copied";
  }

  /**
   * Runs `script` as the app with the session line on its stdin, which keeps
   * the secret out of every command line. The caller holds the tunnel lock, so
   * the line names the device port the tunnel holds when it lands.
   */
  async function runSessionScript(script: (dir: string) => string): Promise<string> {
    const forUser = user();
    const dir = agentDirFor(packageName, forUser);
    sessions.set(forUser, dir);
    const port = devicePort;
    let out = "";
    try {
      out = await adbShellInput(
        serial,
        runAsCommand(packageName, forUser, `sh -c ${shellQuote(script(dir))}`),
        sessionLine(port),
        { timeoutMs: 15_000 }
      );
    } catch (err) {
      // The script can fail after it wrote the session, as when the copy fails.
      if (!disposed) throw err;
    }
    if (disposed) {
      // The dispose that ran meanwhile may have looked before this wrote.
      await removeSessions();
      throw new InspectorStopped();
    }
    sessionPort = port;
    return out;
  }

  /** Best-effort, per user: only while the app's session file still holds this inspector's secret. */
  async function removeSessions(): Promise<void> {
    await Promise.all(
      [...sessions].map(async ([forUser, dir]) => {
        try {
          await adbShellInput(
            serial,
            runAsCommand(packageName, forUser, `sh -c ${shellQuote(removeSessionScript(dir))}`),
            `${secret}\n`,
            { timeoutMs: SESSION_REMOVE_TIMEOUT_MS }
          );
        } catch (err) {
          log(
            `could not remove the agent's session file for Android user ${forUser}: ${firstLine(adbFailureDetail(err))}`
          );
        }
      })
    );
  }

  function serveAgent(socket: net.Socket): void {
    socket.on("error", () => {});
    if (disposed) {
      socket.destroy();
      return;
    }
    // A flood of connections that never authenticate pushes out the oldest
    // of them, so it cannot keep the agent's own connection out.
    if (pendingSockets.size >= MAX_PENDING_HANDSHAKES) {
      const oldest = pendingSockets.values().next().value;
      if (oldest) {
        pendingSockets.delete(oldest);
        oldest.destroy();
      }
    }
    pendingSockets.add(socket);
    let phase: "hello" | "proof" | "ready" | "closed" = "hello";
    let agentNonce = "";
    let serverNonce = "";
    let conn: AgentConnection | null = null;
    /** Set once both proofs verified; each direction counts its frames from 0. */
    let keys: SessionKeys | null = null;
    let sentFrames = 0;
    let readFrames = 0;
    const send = (frame: unknown): boolean =>
      keys !== null &&
      writeNdjsonFrame(socket, {
        type: SEALED,
        payload: sealFrame(keys.server, sentFrames++, frame),
      });
    const cdp = createNdjsonCdpRequester(socket, { label: tag, send });
    const reportDropped = reportDroppedFrameToStderr(tag);

    // Logged once, never as a note: any app on the device can reach the port.
    const refuse = (why: string): void => {
      if (phase === "closed") return;
      phase = "closed";
      if (conn) connectionClosed(conn, why);
      else log(`closed an agent connection: ${why}`);
      socket.destroy();
    };
    const authTimer = setTimeout(
      () => refuse(`it did not authenticate within ${AUTH_TIMEOUT_MS} ms`),
      AUTH_TIMEOUT_MS
    );
    authTimer.unref();

    attachNdjsonReader(
      socket,
      {
        onDropped: (info) => {
          if (phase === "ready") {
            refuse(`it sent a frame that could not be read (${info.bytes} bytes): ${info.preview}`);
          } else if (phase !== "closed") {
            reportDropped(info);
          }
        },
        onMessage: (raw) => {
          if (phase === "closed") return;
          let msg = (raw ?? {}) as { type?: unknown; payload?: unknown };
          if (phase === "ready") {
            const opened = openFrame(keys!.agent, readFrames, raw);
            if (typeof opened === "string") {
              refuse(opened);
              return;
            }
            readFrames++;
            msg = opened;
          }
          const payload = asObject(msg.payload);

          if (phase === "hello") {
            // The port is reachable from every app on the device, so nothing
            // is read from a connection before it proves the session secret.
            if (msg.type !== "Control" || payload.packageName !== packageName) {
              refuse(`it opened with ${previewJson(raw)}`);
              return;
            }
            // Any app can open this way, so it is only logged; the note about
            // an agent that never connects covers an earlier agent.
            if (payload.hello === undefined) {
              refuse("it speaks an earlier protocol");
              return;
            }
            if (payload.hello !== PROTOCOL_VERSION || !isHex(payload.nonce, 32)) {
              refuse(`it opened with ${previewJson(raw)}`);
              return;
            }
            agentNonce = payload.nonce;
            serverNonce = randomBytes(16).toString("hex");
            writeNdjsonFrame(socket, {
              type: "Control",
              payload: {
                nonce: serverNonce,
                proof: handshakeProof(secret, ["argent-server", agentNonce, serverNonce]),
              },
            });
            phase = "proof";
            return;
          }

          if (phase === "proof") {
            const handshake = msg.type === "Control" ? readHandshake(payload) : null;
            if (!handshake) {
              refuse(
                msg.type === "Control"
                  ? "its proof frame lacks the process or request counters"
                  : "its proof of the session secret did not verify"
              );
              return;
            }
            // The proof covers the fields that come with it.
            const expected = handshakeProof(secret, [
              "argent-agent",
              agentNonce,
              serverNonce,
              handshake.pid,
              handshake.startTime,
              handshake.instance,
              handshake.lastSeq,
            ]);
            if (!proofMatches(payload.proof, expected)) {
              refuse("its proof of the session secret did not verify");
              return;
            }
            clearTimeout(authTimer);
            pendingSockets.delete(socket);
            if (disposed) {
              refuse("capture was stopped");
              return;
            }
            keys = sessionKeys(agentNonce, serverNonce, secret);
            phase = "ready";
            conn = openConnection(socket, cdp, send, handshake);
            sendMetroPort(conn);
            enableNetwork(conn);
            return;
          }

          if (!conn) return;
          if (msg.type === "CDP") {
            if (cdp.handleResponse(payload)) return;
            if (typeof payload.method === "string") fold(conn, payload.method, payload.params);
            return;
          }
          if (msg.type === "Status") onStatus(conn, payload);
        },
      },
      { maxFrameChars: () => (phase === "ready" ? MAX_FRAME_CHARS : HANDSHAKE_FRAME_CHARS) }
    );

    socket.on("close", () => {
      clearTimeout(authTimer);
      pendingSockets.delete(socket);
      phase = "closed";
      cdp.close();
      if (conn) connectionClosed(conn);
    });
  }

  function openConnection(
    socket: net.Socket,
    cdp: NdjsonCdpRequester,
    send: (frame: unknown) => boolean,
    handshake: Handshake
  ): AgentConnection {
    const key = `${handshake.pid}:${handshake.startTime}`;
    // An agent keeps one connection. One of its earlier connections that is
    // still open here is one it gave up on, so it closes now and can be
    // resumed.
    for (const c of connections) {
      if (c.closed || c.instance !== handshake.instance) continue;
      c.closed = true;
      c.armed = false;
      c.cdp.close();
      c.socket.destroy();
    }

    const conn: AgentConnection = {
      index: connections.length + 1,
      socket,
      cdp,
      send,
      pid: handshake.pid,
      startTime: handshake.startTime,
      processKey: key,
      instance: handshake.instance,
      maxSeq: 0,
      armed: false,
      closed: false,
      droppedEvents: 0,
      byLayerId: new Map(),
    };

    // The same attach resumes its last dropped connection, and events for
    // that one's ids fold into its records. An agent that reports fewer
    // requests than were already seen from it went back in time, as after an
    // emulator snapshot load: its ids name other requests now.
    const dropped = [...connections]
      .reverse()
      .find((c) => c.closed && c.instance === handshake.instance && !c.resumedBy && !c.agentGone);
    if (dropped) {
      const seen = chainMaxSeq(dropped);
      if (handshake.lastSeq >= seen) {
        conn.resumes = dropped;
        dropped.resumedBy = conn;
      } else {
        failResumedChain(dropped);
        log(
          `agent connection ${conn.index} reports request ${handshake.lastSeq} as its latest, but ${seen} was already seen; it does not resume ${dropped.index}`
        );
      }
    }
    // Another attach in the same process replaced the agent those
    // connections came from.
    for (const c of connections) {
      if (
        c.closed &&
        c.processKey === key &&
        c.instance !== handshake.instance &&
        !c.resumedBy &&
        !c.agentGone
      ) {
        failResumedChain(c);
      }
    }

    connections.push(conn);
    note = "the agent connected; waiting for it to acknowledge Network.enable";
    log(
      `agent connection ${conn.index} from pid ${conn.pid}${conn.resumes ? ` resumes ${conn.resumes.index}` : ""}`
    );
    return conn;
  }

  function chainMaxSeq(conn: AgentConnection): number {
    let max = 0;
    for (let c: AgentConnection | undefined = conn; c; c = c.resumes) max = Math.max(max, c.maxSeq);
    return max;
  }

  /**
   * The reply is applied as its frame is read, before the frames after it in
   * the same chunk: those are newer than the reply's in-flight list and
   * capture state. A connection with no reply in time is closed rather than
   * left unarmed; the agent connects again and enables anew.
   */
  function enableNetwork(conn: AgentConnection): void {
    conn.cdp
      .request(
        "Network.enable",
        {},
        { timeoutMs: ENABLE_TIMEOUT_MS, onResult: (result) => onEnabled(conn, result) }
      )
      .catch((err: unknown) => {
        if (conn.closed || disposed) {
          log(`Network.enable on connection ${conn.index} failed: ${errorMessage(err)}`);
          return;
        }
        if (getFailureSignal(err)?.error_kind === "timeout") {
          connectionClosed(
            conn,
            `it did not answer Network.enable within ${ENABLE_TIMEOUT_MS / 1000} s`
          );
          conn.socket.destroy();
          return;
        }
        log(`Network.enable on connection ${conn.index} failed: ${errorMessage(err)}`);
        note = `the agent did not enable capture: ${errorMessage(err)}`;
      });
  }

  function onEnabled(conn: AgentConnection, result: unknown): void {
    if (conn.closed || disposed) return;
    const r = asObject(result);
    const capture = parseCapture(r.capture);
    if (capture) conn.capture = capture;
    if (typeof r.dropped === "number" && r.dropped > 0) {
      conn.droppedEvents = Math.floor(r.dropped);
      log(`the agent dropped ${conn.droppedEvents} events while it was disconnected`);
    }
    // Every flushed event arrived before this reply, so a request of this
    // chain that is neither settled nor in flight lost its final events.
    if (Array.isArray(r.inFlight)) {
      const inFlight = new Set(r.inFlight.filter((id): id is string => typeof id === "string"));
      for (let c: AgentConnection | undefined = conn; c; c = c.resumes) {
        for (const record of c.byLayerId.values()) {
          if (inFlight.has(record.layerId)) revive(record);
          else if (isOpen(record)) markLost(record, LOST_WHILE_DISCONNECTED);
        }
      }
    }
    conn.armed = true;
    note = undefined;
    for (const wake of armWaiters) wake();
  }

  function onStatus(conn: AgentConnection, payload: Record<string, unknown>): void {
    const event = asString(payload.event);
    if (event === "capture") {
      const capture = parseCapture(payload);
      if (capture) {
        conn.capture = capture;
        log(`capture ${capture.state}${capture.detail ? `: ${capture.detail}` : ""}`);
      }
      return;
    }
    log(`status ${capString(event, 200)}`);
  }

  function connectionClosed(conn: AgentConnection, why?: string): void {
    if (conn.closed) return;
    conn.closed = true;
    conn.armed = false;
    conn.cdp.close();
    if (disposed) return;
    log(`agent connection ${conn.index} closed${why ? `: ${why}` : ""}`);
    if (!connections.some((c) => !c.closed)) {
      note = "the agent's connection dropped; it reconnects by itself while the app runs";
    }
    const running = rechecks.get(conn.processKey);
    if (running) {
      running.restart = true;
      return;
    }
    void recheckAfterDrop(conn.processKey);
  }

  /**
   * After a drop, checks on the process until its agent reconnects: a process
   * that ended fails its open requests, and a live one gets its reverse back,
   * which an adb restart drops. A window that ends without a reconnection
   * fails the open requests as lost; a later reconnection can still settle
   * them.
   */
  async function recheckAfterDrop(key: string): Promise<void> {
    const recheck = { restart: false };
    rechecks.set(key, recheck);
    const reconnected = (): boolean => connections.some((c) => !c.closed && c.processKey === key);
    try {
      let step = 0;
      while (step < RECHECK_DELAYS_MS.length) {
        await sleep(RECHECK_DELAYS_MS[step]!);
        if (disposed) return;
        if (recheck.restart) {
          recheck.restart = false;
          step = 0;
          continue;
        }
        if (reconnected()) return;
        step++;
        let read: AppProcesses;
        try {
          read = await readAppProcesses(serial, packageName);
        } catch {
          // adb did not answer, as while its server restarts or the cable is
          // out. That says nothing about the app, so check again later.
          continue;
        }
        if (disposed) return;
        // The dropped process can be another Android user's, still running
        // after a user switch.
        const running = runningKeys(read);
        if (!running.has(key)) {
          failOrphans(running);
          if (!connections.some((c) => !c.closed)) note = afterExitNote(read);
          return;
        }
        await assertReverse().catch(() => {});
      }
      if (disposed || recheck.restart || reconnected()) return;
      for (const c of connections) {
        if (c.processKey !== key || !c.closed || c.agentGone || liveConnectionFor(c)) continue;
        for (const record of c.byLayerId.values()) {
          if (isOpen(record)) markLost(record, NOT_RECONNECTED);
        }
      }
    } finally {
      if (rechecks.get(key) === recheck) rechecks.delete(key);
      // A drop that came in after the last check still gets its own recheck.
      if (recheck.restart && !disposed && !reconnected()) void recheckAfterDrop(key);
    }
  }

  /** What the next trigger finds once the process of a dropped connection ended. */
  function afterExitNote(read: AppProcesses): string {
    const trigger =
      "launch-app, restart-app or the next native-network-logs call attaches the agent";
    const foreground = read.user ?? appUser;
    if (!processOfUser(read, foreground)) {
      return `${packageName} exited; ${trigger} to its new process`;
    }
    return foreground === appUser
      ? `the app restarted; ${trigger} to its new process`
      : `Android user ${foreground} is in the foreground now; ${trigger} to that user's process of ${packageName}`;
  }

  function fold(conn: AgentConnection, method: string, params: unknown): void {
    if (typeof params !== "object" || params === null) return;
    const p = params as Record<string, unknown>;
    const layerId = typeof p.requestId === "string" ? p.requestId : null;
    if (!layerId || layerId.length > MAX_LAYER_ID_CHARS) return;
    noteSeq(conn, layerId);

    if (method === "Network.requestWillBeSent") {
      if (p.redirectResponse !== undefined && p.redirectResponse !== null) {
        const record = findRecord(conn, layerId);
        if (record) addHop(record, p);
        return;
      }
      startRecord(conn, layerId, p);
      return;
    }
    const record = findRecord(conn, layerId);
    if (!record) return;
    switch (method) {
      case "Network.requestWillBeSentExtraInfo":
        revive(record);
        record.request.wireHeaders = headerMap(p.headers);
        break;
      case "Network.dataReceived":
        revive(record);
        return;
      case "Network.responseReceived": {
        revive(record);
        const r = asObject(p.response);
        record.state = "headers";
        record.response = {
          url: capString(asString(r.url)) || hops.get(record)?.url || record.request.url,
          status: typeof r.status === "number" ? r.status : 0,
          statusText: capString(asString(r.statusText)),
          headers: headerMap(r.headers),
          mimeType: capString(asString(r.mimeType)),
          ...(r.fromCache === true ? { fromCache: true } : {}),
        };
        if (typeof p.type === "string") record.resourceType = capString(p.type, 100);
        break;
      }
      case "Network.loadingFinished":
        revive(record);
        // A request in flight at a clear lists again once it settles, so
        // polling with clear sees it finish.
        cleared.delete(record);
        record.state = "complete";
        if (typeof p.encodedDataLength === "number") record.encodedDataLength = p.encodedDataLength;
        setDurationFromArrival(record);
        break;
      case "Network.loadingFailed":
        revive(record);
        cleared.delete(record);
        record.state = "failed";
        record.errorText = capString(asString(p.errorText)) || "Unknown error";
        setDurationFromArrival(record);
        break;
      default:
        return;
    }
    resize(record);
  }

  /** The agent's ids are `<instance>-<seq>`. */
  function noteSeq(conn: AgentConnection, layerId: string): void {
    const match = /^([0-9a-f]{8})-(\d+)$/.exec(layerId);
    if (match && match[1] === conn.instance) conn.maxSeq = Math.max(conn.maxSeq, Number(match[2]));
  }

  /** A record failed only for lost events takes the state the agent reports after all. */
  function revive(record: AndroidNativeRecord): void {
    if (!lostOnly.has(record)) return;
    lostOnly.delete(record);
    record.state = record.response ? "headers" : "pending";
    delete record.errorText;
  }

  /**
   * A follow-up hop (a redirect, an auth retry) of a request already recorded:
   * the previous hop goes into `redirects`, and the record keeps the URL the
   * app requested.
   */
  function addHop(record: AndroidNativeRecord, p: Record<string, unknown>): void {
    revive(record);
    const previous = hops.get(record) ?? { url: record.request.url, method: record.request.method };
    const response = asObject(p.redirectResponse);
    const next = asObject(p.request);
    const redirects = (record.redirects ??= []);
    const sent = record.request.wireHeaders;
    if (redirects.length < MAX_REDIRECTS) {
      redirects.push({
        url: capString(asString(response.url)) || previous.url,
        method: previous.method,
        status: typeof response.status === "number" ? response.status : 0,
        statusText: capString(asString(response.statusText)),
        headers: headerMap(response.headers),
        ...(sent ? { requestHeaders: sent } : {}),
      });
    }
    hops.set(record, {
      url: capString(asString(next.url)) || previous.url,
      method: capString(asString(next.method), 100) || previous.method,
    });
    // The hop's wire headers went with it; the next hop's come when the agent reports them.
    delete record.request.wireHeaders;
    resize(record);
  }

  /** Durations run from the arrival of a request's first event to its last. */
  function setDurationFromArrival(record: AndroidNativeRecord): void {
    const arrived = startArrivals.get(record);
    if (arrived !== undefined) record.timing.durationMs = Math.round(performance.now() - arrived);
  }

  function startRecord(conn: AgentConnection, layerId: string, p: Record<string, unknown>): void {
    // A resumed connection that reports an id already used on the chain it
    // resumes stops resuming, and the chain's requests in flight fail.
    for (let dropped = conn.resumes; dropped; dropped = dropped.resumes) {
      if (!dropped.byLayerId.has(layerId)) continue;
      const resumed = conn.resumes!;
      conn.resumes = undefined;
      resumed.resumedBy = undefined;
      failResumedChain(resumed);
      log(
        `agent connection ${conn.index} reported ${layerId} again; it no longer resumes ${resumed.index}`
      );
      break;
    }
    const req = asObject(p.request);
    const startedAt =
      typeof p.wallTime === "number"
        ? p.wallTime * 1000
        : typeof p.timestamp === "number"
          ? p.timestamp * 1000
          : Date.now();
    const record: AndroidNativeRecord = {
      id: `android-${RUN_TAG}-${nextRecordNumber++}`,
      layer: "android-native",
      layerId,
      connection: conn.index,
      ...(Number.isInteger(req.rnRequestId) ? { rnRequestId: req.rnRequestId as number } : {}),
      state: "pending",
      request: {
        url: capString(asString(req.url)),
        method: capString(asString(req.method), 100) || "GET",
        headers: headerMap(req.headers),
        ...(req.hasPostData === true ? { hasPostData: true } : {}),
      },
      timing: { startedAt: Math.round(startedAt) },
    };
    // Keyed on the connection, so records of two connections never replace
    // each other.
    conn.byLayerId.set(layerId, record);
    hops.set(record, { url: record.request.url, method: record.request.method });
    startArrivals.set(record, performance.now());
    records.push(record);
    byId.set(record.id, { record, conn });
    resize(record);
  }

  function findRecord(conn: AgentConnection, layerId: string): AndroidNativeRecord | undefined {
    const own = conn.byLayerId.get(layerId);
    if (own) return own;
    for (let dropped = conn.resumes; dropped; dropped = dropped.resumes) {
      const record = dropped.byLayerId.get(layerId);
      if (record && (isOpen(record) || lostOnly.has(record))) return record;
    }
    return undefined;
  }

  /** Re-measures a record after it grew, and evicts the oldest past either bound. */
  function resize(record: AndroidNativeRecord): void {
    if (!byId.has(record.id)) return;
    const size = recordSize(record);
    recordChars += size - (recordSizes.get(record) ?? 0);
    recordSizes.set(record, size);
    while (
      records.length > MAX_RECORDS ||
      (records.length > 1 && recordChars > RECORD_CHARS_BUDGET)
    ) {
      evict(records.shift()!);
    }
  }

  function evict(record: AndroidNativeRecord): void {
    const entry = byId.get(record.id);
    if (entry && entry.conn.byLayerId.get(record.layerId) === record) {
      entry.conn.byLayerId.delete(record.layerId);
    }
    byId.delete(record.id);
    recordChars -= recordSizes.get(record) ?? 0;
    recordSizes.delete(record);
    bodies.delete(`response:${record.id}`);
    bodies.delete(`post:${record.id}`);
  }

  function markLost(record: AndroidNativeRecord, reason: string): void {
    record.state = "failed";
    record.errorText = reason;
    lostOnly.add(record);
    cleared.delete(record);
    resize(record);
  }

  function liveConnectionFor(conn: AgentConnection): AgentConnection | null {
    for (let c: AgentConnection | undefined = conn; c; c = c.resumedBy) {
      if (!c.closed) return c;
    }
    return null;
  }

  function failResumedChain(dropped: AgentConnection): void {
    for (let c: AgentConnection | undefined = dropped; c; c = c.resumes) {
      c.agentGone = true;
      for (const record of c.byLayerId.values()) {
        if (!isOpen(record) && !lostOnly.has(record)) continue;
        lostOnly.delete(record);
        record.state = "failed";
        record.errorText = AGENT_GONE_REASON;
        cleared.delete(record);
      }
    }
  }

  function agentGoneFor(conn: AgentConnection): boolean {
    let last = conn;
    while (last.resumedBy) last = last.resumedBy;
    return last.agentGone === true;
  }

  function fetchBody(id: string, kind: "response" | "post"): Promise<AndroidNetworkBody> {
    const entry = byId.get(id);
    if (!entry) return Promise.resolve(unavailable("no such request"));
    const { record } = entry;
    if (kind === "post" && !record.request.hasPostData) {
      return Promise.resolve(unavailable("the request has no body"));
    }
    // A request can also fail after its headers arrived, as when the body
    // breaks off or the app stops reading it.
    if (kind === "response" && record.state !== "complete") {
      return Promise.resolve(
        unavailable(
          record.state !== "failed"
            ? "the response has not finished yet"
            : record.response
              ? "the response failed before its body finished"
              : "the request failed before a response arrived"
        )
      );
    }
    const cacheKey = `${kind}:${id}`;
    const cached = bodies.get(cacheKey);
    if (cached) return cached;

    const conn = liveConnectionFor(entry.conn);
    if (!conn) {
      return Promise.resolve(
        unavailable(
          agentGoneFor(entry.conn)
            ? AGENT_GONE_REASON
            : "the app process that made the request is gone"
        )
      );
    }
    // A "no body" answer for a pending request is not cached.
    const sending = kind === "post" && record.state === "pending";
    const fetched = conn.cdp
      .request(kind === "response" ? "Network.getResponseBody" : "Network.getRequestPostData", {
        requestId: record.layerId,
      })
      .then((result) => {
        // Before this reply, the connection reported the record's id as one of
        // its own requests (see startRecord): the reply is about that request.
        if (liveConnectionFor(entry.conn) !== conn) return unavailable(AGENT_GONE_REASON);
        const body = toBody(result, kind);
        return sending && !body.available
          ? unavailable(
              "no request body was returned yet; this answer is not cached, so read it again later"
            )
          : body;
      });
    bodies.set(cacheKey, fetched);
    while (bodies.size > MAX_CACHED_BODIES) bodies.delete(bodies.keys().next().value!);
    const forget = (): void => {
      if (bodies.get(cacheKey) === fetched) bodies.delete(cacheKey);
    };
    fetched.then((body) => {
      if (sending && !body.available) forget();
    }, forget);
    return fetched;
  }

  /** Open requests of a process that no longer runs, which no connection carries on. */
  function failOrphans(running: ReadonlySet<string>): void {
    for (const record of records) {
      if (!isOpen(record) && !lostOnly.has(record)) continue;
      const conn = byId.get(record.id)?.conn;
      if (!conn || running.has(conn.processKey) || liveConnectionFor(conn)) continue;
      lostOnly.delete(record);
      record.state = "failed";
      record.errorText = PROCESS_ENDED;
      cleared.delete(record);
    }
  }

  function armedConnection(): AgentConnection | undefined {
    for (let i = connections.length - 1; i >= 0; i--) {
      const c = connections[i]!;
      if (c.armed && !c.closed) return c;
    }
    return undefined;
  }

  function armedFor(key: string): boolean {
    return connections.some((c) => c.armed && !c.closed && c.processKey === key);
  }

  async function ensureAttached(
    port: number
  ): Promise<AndroidNetworkNotAttachable | AndroidNetworkCallNote | null> {
    setMetroPort(port);
    return withKeyedLock(attachLock, "attach", async () => {
      if (disposed) return null;
      const hadCapture = live;
      try {
        const blocked = await prepare();
        if (blocked) return blocked;
        const read = await readAppProcesses(serial, packageName);
        checkpoint();
        const switched = await followUser(read.user);
        if (switched) return switched;
        const current = processOfUser(read, user());
        failOrphans(runningKeys(read));
        if (!current) {
          if (!armedConnection()) {
            note = `${packageName} is not running; launch-app or restart-app attaches the agent to its next process`;
          }
        } else {
          await attach(current);
          if (!ready) {
            const again = await prepare();
            if (again) return again;
          }
        }
        // Live from the first call that went through, so a launch attaches
        // and the profilers warn only once capture really is on.
        live = true;
        return null;
      } catch (err) {
        if (err instanceof InspectorStopped) return null;
        // What was captured is still here: list it, and say why the device
        // was not reached.
        if (!hadCapture) throw err;
        const callNote = isOwnFailure(err)
          ? `${errorMessage(err)} Listing the requests captured so far.`
          : `adb did not answer (${firstLine(adbFailureDetail(err))}); listing the requests captured so far`;
        log(callNote);
        return { status: "ok", note: callNote };
      }
    });
  }

  async function attachLaunch(): Promise<string | undefined> {
    if (!live || disposed) return undefined;
    let outcome: LaunchOutcome;
    try {
      outcome = await withKeyedLock(attachLock, "attach", async (): Promise<LaunchOutcome> => {
        checkpoint();
        const blocked = await prepare();
        if (blocked) return { kind: "blocked", reason: blocked.reason };
        const deadline = Date.now() + NEW_PROCESS_WAIT_MS;
        for (;;) {
          const read = await readAppProcesses(serial, packageName);
          checkpoint();
          const switched = await followUser(read.user);
          if (switched) return { kind: "blocked", reason: switched.reason };
          const current = processOfUser(read, user());
          failOrphans(runningKeys(read));
          if (current) return { kind: await attach(current), proc: current };
          if (Date.now() >= deadline) return { kind: "no_process" };
          await sleep(PROCESS_POLL_INTERVAL_MS);
          checkpoint();
        }
      });
    } catch (err) {
      if (err instanceof InspectorStopped || disposed) return undefined;
      return `native network capture could not follow this launch of ${packageName}: ${firstLine(isOwnFailure(err) ? errorMessage(err) : adbFailureDetail(err))}`;
    }
    // Only an attach that went through for this process has an agent to wait for.
    if (outcome.kind === "attached") await waitForArmed(processKey(outcome.proc), ARM_WAIT_MS);
    if (disposed) return undefined;
    return launchNote(outcome);
  }

  function launchNote(outcome: LaunchOutcome): string {
    switch (outcome.kind) {
      case "blocked":
        return `native network capture cannot follow ${packageName}: ${outcome.reason}`;
      case "no_process":
        return `native network capture is on for ${packageName}, but no process of it appeared within ${NEW_PROCESS_WAIT_MS / 1000} s; the next native-network-logs call attaches the agent`;
      case "copy_failed":
      case "attach_failed":
        return `native network capture could not follow this launch: ${note ?? "the attach failed"}`;
      default: {
        const { pid } = outcome.proc;
        return armedFor(processKey(outcome.proc))
          ? `native network capture is attached to ${packageName} (pid ${pid}); native-network-logs with stop: true ends it`
          : `native network capture is attaching to ${packageName} (pid ${pid}), and the agent has not connected yet; native-network-logs shows when it is armed`;
      }
    }
  }

  /** Until the process's agent is armed, the timeout, or the process exits. */
  async function waitForArmed(key: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!disposed && !armedFor(key)) {
      const left = deadline - Date.now();
      if (left <= 0) return;
      const woken = await nextArmEvent(Math.min(ARM_PROCESS_CHECK_MS, left));
      if (woken || disposed || armedFor(key)) continue;
      try {
        const read = await readAppProcesses(serial, packageName);
        if (!runningKeys(read).has(key)) return;
      } catch {
        // adb did not answer; keep waiting until the timeout.
      }
    }
  }

  function nextArmEvent(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (woken: boolean): void => {
        clearTimeout(timer);
        armWaiters.delete(wake);
        resolve(woken);
      };
      const wake = (): void => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      timer.unref();
      armWaiters.add(wake);
    });
  }

  const api: AndroidNetworkInspectorApi = {
    packageName,
    ensureAttached,
    state() {
      const conn = armedConnection();
      return {
        armed: Boolean(conn),
        ...(conn ? { process: { pid: conn.pid, startTime: conn.startTime } } : {}),
        ...(conn?.capture ? { capture: { ...conn.capture } } : {}),
        ...(conn && conn.droppedEvents > 0 ? { droppedEvents: conn.droppedEvents } : {}),
        ...(!conn && note ? { note } : {}),
      };
    },
    records: (port) =>
      records.filter((r) => !cleared.has(r) && !isMetroTraffic(r.request.url, port)),
    record: (id) => byId.get(id)?.record,
    responseBody: (id) => fetchBody(id, "response"),
    requestPostData: (id) => fetchBody(id, "post"),
    clear() {
      // Hides every record from the listing, also the ones the clearing call
      // did not return because of its limit. Their ids still read, and a
      // request in flight keeps folding its events and lists again once it
      // settles. The buffer's own bounds evict them.
      for (const record of records) cleared.add(record);
    },
  };

  const handle: InspectorHandle = {
    api,
    serial,
    packageName,
    hardwareKey: null,
    isLive: () => live && !disposed,
    attachLaunch,
  };

  return {
    handle,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      live = false;
      note = "native network capture was stopped";
      // A listing during the stop reads it as stopped, not armed.
      for (const conn of connections) conn.armed = false;
      for (const wake of armWaiters) wake();
      for (const socket of pendingSockets) socket.destroy();
      // The agent stops capturing and drops its buffer, then finds no session
      // and stops connecting.
      await Promise.all(
        connections
          .filter((c) => !c.closed)
          .map((c) =>
            c.cdp
              .request("Network.disable", {}, { timeoutMs: DISABLE_TIMEOUT_MS })
              .catch(() => undefined)
          )
      );
      for (const conn of connections) {
        conn.cdp.close();
        conn.socket.destroy();
      }
      server?.close();
      await Promise.all([
        reversed ? removeAdbReverse(serial, devicePort) : Promise.resolve(),
        removeSessions(),
      ]);
    },
  };
}

function readHandshake(payload: Record<string, unknown>): Handshake | null {
  const { pid, startTime, instance, lastSeq } = payload;
  if (!isCount(pid) || pid === 0 || !isCount(startTime) || !isCount(lastSeq)) return null;
  if (!isHex(instance, 8)) return null;
  return { pid, startTime, instance, lastSeq };
}

function proofMatches(proof: unknown, expected: string): boolean {
  if (!isHex(proof, 64)) return false;
  return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(expected, "hex"));
}

/** Hex HMAC-SHA256 keyed with the secret's ASCII bytes, over the parts joined by `\n`. */
export function handshakeProof(secret: string, parts: ReadonlyArray<string | number>): string {
  return createHmac("sha256", Buffer.from(secret, "ascii"))
    .update(parts.join("\n"), "utf8")
    .digest("hex");
}

interface SessionKeys {
  /** Seals the agent's frames. */
  agent: Buffer;
  /** Seals the tool-server's frames. */
  server: Buffer;
}

/**
 * HKDF-SHA256 (RFC 5869) with one 32-byte output block per direction: the
 * salt is the ASCII of both nonces, the input key the ASCII of the secret.
 */
export function sessionKeys(agentNonce: string, serverNonce: string, secret: string): SessionKeys {
  const prk = createHmac("sha256", Buffer.from(agentNonce + serverNonce, "ascii"))
    .update(Buffer.from(secret, "ascii"))
    .digest();
  const expand = (info: string): Buffer =>
    createHmac("sha256", prk)
      .update(Buffer.concat([Buffer.from(info, "ascii"), Buffer.of(1)]))
      .digest();
  return {
    agent: expand("argent-nwi agent to server"),
    server: expand("argent-nwi server to agent"),
  };
}

/** 4 zero bytes, then the frame's counter as 8 bytes big-endian. */
function frameIv(counter: number): Buffer {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(BigInt(counter), 4);
  return iv;
}

/** A sealed frame's payload: the frame's JSON under AES-256-GCM, tag appended, in base64. */
export function sealFrame(key: Buffer, counter: number, frame: unknown): string {
  const cipher = createCipheriv("aes-256-gcm", key, frameIv(counter), {
    authTagLength: GCM_TAG_BYTES,
  });
  return Buffer.concat([
    cipher.update(JSON.stringify(frame), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}

/**
 * The frame sealed in `sealed` under `key` and `counter`, or why there is
 * none: it is not a sealed frame, it does not verify, or it holds no frame.
 */
export function openFrame(
  key: Buffer,
  counter: number,
  sealed: unknown
): { type: string; payload: Record<string, unknown> } | string {
  const { type, payload } = asObject(sealed);
  if (type !== SEALED || typeof payload !== "string") return "it sent a frame that is not sealed";
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length < GCM_TAG_BYTES || bytes.toString("base64") !== payload) {
    return `its sealed frame ${counter} is not base64`;
  }
  let plaintext: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, frameIv(counter), {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAuthTag(bytes.subarray(bytes.length - GCM_TAG_BYTES));
    plaintext = Buffer.concat([
      decipher.update(bytes.subarray(0, bytes.length - GCM_TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return `its sealed frame ${counter} did not verify`;
  }
  let inner: unknown;
  try {
    inner = JSON.parse(plaintext);
  } catch {
    return `its sealed frame ${counter} holds no JSON`;
  }
  const frame = asObject(inner);
  if (
    typeof frame.type !== "string" ||
    frame.type === SEALED ||
    typeof frame.payload !== "object" ||
    frame.payload === null ||
    Array.isArray(frame.payload)
  ) {
    return `its sealed frame ${counter} holds no frame`;
  }
  return { type: frame.type, payload: frame.payload as Record<string, unknown> };
}

/** adb's answer when a process on the device already listens on the device port. */
function isPortTaken(err: unknown): boolean {
  return /cannot (?:re)?bind/i.test(errorMessage(err));
}

function isHex(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length === length && /^[0-9a-f]+$/.test(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOpen(record: AndroidNativeRecord): boolean {
  return record.state === "pending" || record.state === "headers";
}

function parseCapture(value: unknown): { state: AndroidCaptureState; detail?: string } | undefined {
  const o = asObject(value);
  if (o.state !== "active" && o.state !== "waiting" && o.state !== "unavailable") return undefined;
  const detail = capString(asString(o.detail), 500);
  return detail ? { state: o.state, detail } : { state: o.state };
}

function agentFiles(): { jar: string; lib: Partial<Record<AgentAbi, string>> } | null {
  const dir = path.join(binDir(), "network-inspector");
  const jar = path.join(dir, JAR_NAME);
  if (!fs.existsSync(jar)) return null;
  const lib: Partial<Record<AgentAbi, string>> = {};
  for (const abi of AGENT_ABIS) {
    const file = path.join(dir, abi, AGENT_LIB_NAME);
    if (fs.existsSync(file)) lib[abi] = file;
  }
  return Object.keys(lib).length > 0 ? { jar, lib } : null;
}

function isAgentAbi(abi: string): abi is AgentAbi {
  return (AGENT_ABIS as readonly string[]).includes(abi);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2", "[::1]"]);

/**
 * Metro's own traffic on `metroPort`: the bundle, HMR, symbolication, the
 * inspector socket. Keyed on the caller's port.
 */
function isMetroTraffic(url: string, metroPort: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(parsed.hostname) && Number(parsed.port) === metroPort;
}

function toBody(result: unknown, kind: "response" | "post"): AndroidNetworkBody {
  const r = asObject(result);
  const text = kind === "response" ? r.body : r.postData;
  if (r.bodyAvailable === false || typeof text !== "string") {
    return unavailable(
      kind === "response"
        ? "the agent holds no body for this response"
        : "the agent holds no body for this request"
    );
  }
  return {
    available: true,
    body: text,
    base64Encoded: r.base64Encoded === true,
    truncated: r.wasTruncated === true,
  };
}

function unavailable(reason: string): AndroidNetworkBody {
  return { available: false, body: "", base64Encoded: false, truncated: false, reason };
}

/** Keeps the start of an absurdly long value and says how much was left out. */
function capString(value: string, max = MAX_VALUE_CHARS): string {
  return value.length > max ? `${value.slice(0, max)}…[${value.length - max} more chars]` : value;
}

/**
 * A header map with every value capped, bounded in count and in total size.
 * The headers left out are counted in an entry that says so.
 */
function headerMap(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  let kept = 0;
  let chars = 0;
  let left = 0;
  for (const [name, v] of Object.entries(asObject(value))) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
    const key = capString(name, 1024);
    const text = capString(String(v));
    if (kept >= MAX_HEADERS || chars + key.length + text.length > MAX_HEADER_MAP_CHARS) {
      left++;
      continue;
    }
    headers[key] = text;
    kept++;
    chars += key.length + text.length;
  }
  if (left > 0) headers["(not kept)"] = `${left} more headers`;
  return headers;
}

function mapChars(map: Record<string, string> | undefined): number {
  let chars = 0;
  for (const [name, value] of Object.entries(map ?? {})) chars += name.length + value.length;
  return chars;
}

/** What a record holds in strings, which is what its memory scales with. */
function recordSize(record: AndroidNativeRecord): number {
  let chars =
    record.request.url.length +
    record.request.method.length +
    mapChars(record.request.headers) +
    mapChars(record.request.wireHeaders) +
    (record.errorText?.length ?? 0) +
    256;
  if (record.response) {
    chars +=
      record.response.url.length +
      record.response.statusText.length +
      record.response.mimeType.length +
      mapChars(record.response.headers);
  }
  for (const hop of record.redirects ?? []) {
    chars +=
      hop.url.length + hop.statusText.length + mapChars(hop.headers) + mapChars(hop.requestHeaders);
  }
  return chars;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The inspector's own failures, whose messages stand on their own. */
function isOwnFailure(err: unknown): boolean {
  const code = getFailureSignal(err)?.error_code;
  return (
    code === FAILURE_CODES.ANDROID_NETWORK_INSPECTOR_UNKNOWN_PACKAGE ||
    code === FAILURE_CODES.ANDROID_NETWORK_INSPECTOR_RUN_AS_FAILED ||
    code === FAILURE_CODES.ANDROID_NETWORK_INSPECTOR_DEVICE_IN_USE ||
    code === FAILURE_CODES.ANDROID_NETWORK_INSPECTOR_NO_DEVICE_PORT
  );
}

function adbFailureDetail(err: unknown): string {
  const message = errorMessage(err);
  const marker = " failed: ";
  const at = message.indexOf(marker);
  return (at >= 0 ? message.slice(at + marker.length) : message).trim();
}

/**
 * The line of a multi-line failure that says what went wrong: for an
 * exception dump, its message (`Unknown process: 4722`).
 */
function firstLine(detail: string): string {
  const lines = detail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const thrown = lines
    .map((line) => /^[\w.$]+(?:Exception|Error): (.+)$/.exec(line)?.[1])
    .find(Boolean);
  return capString(thrown ?? lines[0] ?? detail, 300);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
