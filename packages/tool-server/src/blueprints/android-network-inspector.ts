import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
  FAILURE_CODES,
  FailureError,
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import { binDir } from "@argent/native-devtools-android";
import { adbReverse, adbShell, removeAdbReverse, runAdb, shellQuote } from "../utils/adb";
import {
  attachNdjsonReader,
  createNdjsonCdpRequester,
  previewJson,
  reportDroppedFrameToStderr,
  type NdjsonCdpRequester,
} from "../utils/ndjson-socket";
import { withKeyedLock } from "../utils/keyed-lock";

export const ANDROID_NETWORK_INSPECTOR_NAMESPACE = "AndroidNetworkInspector";

interface AndroidNetworkInspectorOptions extends Record<string, unknown> {
  device: DeviceInfo;
  packageName: string;
  metroPort: number;
}

export function androidNetworkInspectorRef(
  device: DeviceInfo,
  packageName: string,
  metroPort: number
): { urn: string; options: AndroidNetworkInspectorOptions } {
  return {
    urn: `${ANDROID_NETWORK_INSPECTOR_NAMESPACE}:${device.id}:${packageName}`,
    options: { device, packageName, metroPort },
  };
}

const JAR_NAME = "network-inspector.jar";
const AGENT_LIB_NAME = "libjvmti_network_inspector.so";
const AGENT_ABIS = ["arm64-v8a", "x86_64"] as const;
type AgentAbi = (typeof AGENT_ABIS)[number];
/** adb pushes here, and `run-as` copies into the app, which loads only from its own data. */
const DEVICE_STAGING_DIR = "/data/local/tmp/.argent-inspector";
/** `attach-agent` needs API 26. */
const MIN_SDK = 26;
/** An Android package name: dot-separated Java identifiers, so never a `:` or a quote. */
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
const MAX_RECORDS = 2000;
const MAX_CACHED_BODIES = 64;
/**
 * Bounds the memory one frame can take: the tunnel's port is reachable from
 * every app on the device.
 */
const MAX_FRAME_CHARS = 8 * 1024 * 1024;
const NEW_PROCESS_WAIT_MS = 3_000;
const PROCESS_POLL_INTERVAL_MS = 250;
const ARM_WAIT_MS = 5_000;
const RECHECK_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

export const AGENT_BINARIES_MISSING_REASON = "agent binaries not present in this build";
const AGENT_GONE_REASON =
  "the agent that recorded the request is no longer in the app, as after an emulator snapshot load";
const JS_LAYER_FALLBACK =
  "Use view-network-logs: the JS layer still records the app's JavaScript requests while Metro serves the app.";

export const ANDROID_NATIVE_REQUEST_ID = /^android-\d+$/;

export interface AndroidNetworkNotAttachable {
  status: "not_attachable";
  reason: string;
  fallback: string;
}

export type AndroidNativeRecordState = "pending" | "headers" | "complete" | "failed";

export interface AndroidNativeRecord {
  id: string;
  layer: "android-native";
  layerId: string;
  connection: number;
  rnRequestId?: number;
  state: AndroidNativeRecordState;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    hasPostData?: boolean;
  };
  response?: {
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
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

export interface AndroidNetworkInspectorState {
  armed: boolean;
  process?: { pid: number; startTime: number };
  capture?: string;
  note?: string;
}

export interface AndroidNetworkInspectorApi {
  readonly packageName: string;
  ensureAttached(): Promise<AndroidNetworkNotAttachable | null>;
  attachLaunchedProcess(): Promise<void>;
  state(): AndroidNetworkInspectorState;
  records(metroPort: number): AndroidNativeRecord[];
  record(id: string): AndroidNativeRecord | undefined;
  responseBody(id: string): Promise<AndroidNetworkBody>;
  requestPostData(id: string): Promise<AndroidNetworkBody>;
  clear(): void;
}

/**
 * `view-network-request-details` knows a device and an `android-<n>` id but not
 * the package, and launch-app and restart-app know the package but must not
 * create an inspector nobody asked for, so both look here.
 */
const liveInspectors = new Map<string, Set<AndroidNetworkInspectorApi>>();
let nextRecordNumber = 1;

export function findAndroidNativeRecord(
  deviceId: string,
  id: string
): { inspector: AndroidNetworkInspectorApi; record: AndroidNativeRecord } | undefined {
  for (const inspector of liveInspectors.get(deviceId) ?? []) {
    const record = inspector.record(id);
    if (record) return { inspector, record };
  }
  return undefined;
}

/** Never throws: a launch must not fail because network capture could not follow it. */
export async function attachAndroidNetworkInspectorToLaunch(
  deviceId: string,
  packageName: string
): Promise<void> {
  for (const inspector of liveInspectors.get(deviceId) ?? []) {
    if (inspector.packageName !== packageName) continue;
    await inspector.attachLaunchedProcess().catch((err: unknown) => {
      process.stderr.write(
        `[${ANDROID_NETWORK_INSPECTOR_NAMESPACE}:${deviceId}:${packageName}] attach after launch failed: ${errorMessage(err)}\n`
      );
    });
  }
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

    const deviceId = opts.device.id;
    const inspector = createInspector(deviceId, opts.packageName, opts.metroPort);
    const onDevice = liveInspectors.get(deviceId) ?? new Set<AndroidNetworkInspectorApi>();
    onDevice.add(inspector.api);
    liveInspectors.set(deviceId, onDevice);

    return {
      api: inspector.api,
      dispose: async () => {
        onDevice.delete(inspector.api);
        if (onDevice.size === 0 && liveInspectors.get(deviceId) === onDevice) {
          liveInspectors.delete(deviceId);
        }
        await inspector.dispose();
      },
      events: new TypedEventEmitter<ServiceEvents>(),
    };
  },
};

interface AppProcess {
  pid: number;
  startTime: number;
}

function processKey(proc: AppProcess): string {
  return `${proc.pid}:${proc.startTime}`;
}

interface AgentConnection {
  index: number;
  socket: net.Socket;
  cdp: NdjsonCdpRequester;
  processKey: string | null;
  armed: boolean;
  closed: boolean;
  byLayerId: Map<string, AndroidNativeRecord>;
  resumes?: AgentConnection;
  resumedBy?: AgentConnection;
  agentGone?: boolean;
}

/**
 * The device end of an app's tunnel: stable per package and the same for every
 * tool-server. FNV-1a over the package name, below the device's ephemeral port
 * range.
 */
function devicePortFor(packageName: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < packageName.length; i++) {
    hash ^= packageName.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 20_000 + (hash % 10_000);
}

function createInspector(
  serial: string,
  packageName: string,
  metroPort: number
): { api: AndroidNetworkInspectorApi; dispose: () => Promise<void> } {
  const tag = `${ANDROID_NETWORK_INSPECTOR_NAMESPACE}:${serial}:${packageName}`;
  const log = (line: string): void => {
    process.stderr.write(`[${tag}] ${line}\n`);
  };
  const appDir = `/data/data/${packageName}/.argent-inspector`;
  const devicePort = devicePortFor(packageName);

  let disposed = false;
  let ready = false;
  let agentAbi: AgentAbi | null = null;
  let staged = false;
  let server: net.Server | null = null;
  let listenerPort = 0;
  let reversed = false;
  const attachedProcesses = new Set<string>();
  let attachedProcess: AppProcess | null = null;
  let note: string | undefined;
  let capture: string | undefined;
  let rechecking = false;
  const connections: AgentConnection[] = [];
  const records: AndroidNativeRecord[] = [];
  const byId = new Map<string, { record: AndroidNativeRecord; conn: AgentConnection }>();
  const bodies = new Map<string, Promise<AndroidNetworkBody>>();
  const cleared = new WeakSet<AndroidNativeRecord>();
  const startArrivals = new WeakMap<AndroidNativeRecord, number>();
  const armWaiters = new Set<() => void>();
  const attachLock = new Map<string, Promise<unknown>>();

  const notAttachable = (reason: string): AndroidNetworkNotAttachable => ({
    status: "not_attachable",
    reason,
    fallback: JS_LAYER_FALLBACK,
  });

  async function prepare(): Promise<AndroidNetworkNotAttachable | null> {
    // Once set up, the agent files are on the device: a later call must keep
    // serving the buffer whatever became of this build's copies.
    if (ready) {
      await assertReverse();
      return null;
    }
    const files = agentFiles();
    if (!files) return notAttachable(AGENT_BINARIES_MISSING_REASON);

    if (!agentAbi) {
      const sdk = Number.parseInt(
        (await adbShell(serial, "getprop ro.build.version.sdk", { timeoutMs: 10_000 })).trim(),
        10
      );
      if (!(sdk >= MIN_SDK)) {
        return notAttachable(
          `attach-agent needs Android 8.0 (API ${MIN_SDK}) or later; this device runs API ${Number.isFinite(sdk) ? sdk : "unknown"}`
        );
      }
      try {
        await adbShell(serial, `run-as ${shellQuote(packageName)} id`, { timeoutMs: 10_000 });
      } catch (err) {
        return notAttachable(
          `run-as ${packageName} failed (${adbFailureDetail(err)}); network inspection needs a debuggable build`
        );
      }
      const abi = await resolveAppAbi(serial, packageName);
      if (!isAgentAbi(abi) || !files.lib[abi]) {
        return notAttachable(
          `${packageName} runs as ${abi || "an unknown ABI"}, and this build carries the agent for ${Object.keys(files.lib).join(" and ")} only`
        );
      }
      agentAbi = abi;
    }

    if (!staged) {
      await adbShell(serial, `mkdir -p ${DEVICE_STAGING_DIR}`, { timeoutMs: 10_000 });
      await runAdb(["-s", serial, "push", files.jar, `${DEVICE_STAGING_DIR}/${JAR_NAME}`], {
        timeoutMs: 60_000,
      });
      await runAdb(
        ["-s", serial, "push", files.lib[agentAbi]!, `${DEVICE_STAGING_DIR}/${AGENT_LIB_NAME}`],
        { timeoutMs: 60_000 }
      );
      staged = true;
    }
    if (!server) listenerPort = await listen();
    await assertReverse();
    ready = true;
    return null;
  }

  /**
   * A reboot, a replugged cable or an adb server restart drops every reverse,
   * and a second tool-server that inspected the same app removes this one when
   * it goes away, so every trigger runs this again; for the same ports it is a
   * no-op.
   */
  async function assertReverse(): Promise<void> {
    await adbReverse(serial, devicePort, listenerPort, { timeoutMs: 10_000 });
    reversed = true;
    // A dispose that ran meanwhile removed the reverse before this put it back.
    if (disposed) await removeAdbReverse(serial, devicePort);
  }

  function listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer(serveAgent);
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        srv.off("error", reject);
        srv.on("error", (err) => log(`listener error: ${err.message}`));
        server = srv;
        resolve((srv.address() as net.AddressInfo).port);
      });
    });
  }

  function agentLeft(key: string): boolean {
    return (
      connections.some((c) => c.processKey === key) &&
      !connections.some((c) => !c.closed && c.processKey === key)
    );
  }

  async function attach(proc: AppProcess): Promise<void> {
    const key = processKey(proc);
    // Once per process. The exception is a process that lost its agent: an
    // emulator snapshot load can bring the app back with its pid and start
    // time, but without the agent. A known process whose connections all
    // closed and that does not map the library (copyIntoApp checks) is that
    // case.
    const known = attachedProcesses.has(key);
    if (known && !agentLeft(key)) return;
    attachedProcesses.add(key);
    attachedProcess = proc;

    let copy: "loaded" | "copied";
    try {
      copy = await copyIntoApp(proc.pid);
    } catch (err) {
      // run-as refusing now can mean a non-debuggable build replaced the app,
      // so the gates run again first. The device can also have lost the staged
      // files (another AVD on the same serial, a wiped AVD, a snapshot from
      // before the push), so they are pushed again too.
      attachedProcesses.delete(key);
      ready = false;
      agentAbi = null;
      staged = false;
      note = `copying the agent into ${packageName} failed: ${adbFailureDetail(err)}`;
      log(note);
      return;
    }
    if (copy === "loaded") {
      if (known) return;
      note = `pid ${proc.pid} already has the agent loaded; restart-app gives the app a fresh process`;
      log(`pid ${proc.pid} already has the agent loaded`);
      return;
    }
    if (known) {
      for (const c of connections) if (c.processKey === key) c.agentGone = true;
      failOrphans(null);
      log(`pid ${proc.pid} lost the agent, as after an emulator snapshot load; attaching again`);
    }

    const agentOptions = `jar=${appDir}/${JAR_NAME},port=${devicePort},pkg=${packageName},metroPort=${metroPort}`;
    try {
      const out = await adbShell(
        serial,
        `cmd activity attach-agent ${proc.pid} ${shellQuote(`${appDir}/${AGENT_LIB_NAME}=${agentOptions}`)}`,
        { timeoutMs: 15_000 }
      );
      if (/exception/i.test(out)) throw new Error(out.trim());
      note = `attached to pid ${proc.pid}; waiting for the agent to connect`;
      log(`attached the agent to pid ${proc.pid}`);
    } catch (err) {
      note = `attach-agent failed for pid ${proc.pid}: ${adbFailureDetail(err)}`;
      log(note);
    }
  }

  /**
   * A process that already loaded the agent is neither copied into nor
   * attached again. A process a tool-server attached before it restarted is
   * that case.
   */
  async function copyIntoApp(pid: number): Promise<"loaded" | "copied"> {
    const jar = `${appDir}/${JAR_NAME}`;
    const lib = `${appDir}/${AGENT_LIB_NAME}`;
    const copy = [
      `mkdir -p ${appDir}`,
      // A read-only copy from an earlier attach cannot be overwritten in place.
      `rm -f ${jar} ${lib}`,
      `cp ${DEVICE_STAGING_DIR}/${JAR_NAME} ${jar}`,
      `cp ${DEVICE_STAGING_DIR}/${AGENT_LIB_NAME} ${lib}`,
      // Android 14 and later refuse to load a writable dex file.
      `chmod 444 ${jar}`,
      `chmod 555 ${lib}`,
      "echo copied",
    ].join(" && ");
    const script = `if grep -q ${AGENT_LIB_NAME} /proc/${pid}/maps; then echo loaded; else ${copy}; fi`;
    const out = await adbShell(
      serial,
      `run-as ${shellQuote(packageName)} sh -c ${shellQuote(script)}`,
      { timeoutMs: 15_000 }
    );
    return /\bloaded\b/.test(out) ? "loaded" : "copied";
  }

  function serveAgent(socket: net.Socket): void {
    if (disposed) {
      socket.destroy();
      return;
    }
    const cdp = createNdjsonCdpRequester(socket, { label: tag });
    let conn: AgentConnection | null = null;

    attachNdjsonReader(
      socket,
      {
        onDropped: reportDroppedFrameToStderr(tag),
        onMessage: (raw) => {
          const msg = (raw ?? {}) as { type?: unknown; payload?: unknown };
          const payload = (
            typeof msg.payload === "object" && msg.payload !== null ? msg.payload : {}
          ) as Record<string, unknown>;

          if (conn === null) {
            // The handshake comes first and must name this service's app: the
            // tunnel's port is reachable from every app on the device.
            if (msg.type !== "Control" || payload.packageName !== packageName) {
              log(`rejected an agent connection that opened with ${previewJson(raw)}`);
              socket.destroy();
              return;
            }
            conn = openConnection(socket, cdp);
            void enableNetwork(conn);
            return;
          }

          if (msg.type === "CDP") {
            if (cdp.handleResponse(payload)) return;
            if (typeof payload.method === "string") fold(conn, payload.method, payload.params);
            return;
          }
          if (msg.type === "Status") {
            const event = asString(payload.event);
            log(`status ${event}`);
            if (event.startsWith("interceptor_")) {
              capture =
                event === "interceptor_installed"
                  ? "capture active"
                  : "capture could not start in the app";
            }
          }
        },
      },
      { maxFrameChars: MAX_FRAME_CHARS }
    );

    socket.on("close", () => {
      cdp.close();
      if (conn) connectionClosed(conn);
    });
    socket.on("error", () => {});
  }

  function openConnection(socket: net.Socket, cdp: NdjsonCdpRequester): AgentConnection {
    const key = attachedProcess ? processKey(attachedProcess) : null;
    const conn: AgentConnection = {
      index: connections.length + 1,
      socket,
      cdp,
      processKey: key,
      armed: false,
      closed: false,
      byLayerId: new Map(),
    };
    // A connection that arrives while no connection of the same process is
    // live resumes the last dropped one, and events for that one's ids fold
    // into its records. One that arrives beside a live one resumes nothing, and
    // its ids stay its own.
    if (!connections.some((c) => !c.closed && c.processKey === key)) {
      const dropped = [...connections]
        .reverse()
        .find((c) => c.closed && c.processKey === key && !c.resumedBy && !c.agentGone);
      if (dropped) {
        conn.resumes = dropped;
        dropped.resumedBy = conn;
      }
    }
    connections.push(conn);
    note = "the agent connected; waiting for it to acknowledge Network.enable";
    log(`agent connection ${conn.index}${conn.resumes ? ` resumes ${conn.resumes.index}` : ""}`);
    return conn;
  }

  async function enableNetwork(conn: AgentConnection): Promise<void> {
    try {
      await conn.cdp.request("Network.enable");
    } catch (err) {
      log(`Network.enable on connection ${conn.index} failed: ${errorMessage(err)}`);
      return;
    }
    if (conn.closed) return;
    conn.armed = true;
    note = undefined;
    for (const wake of armWaiters) wake();
  }

  function connectionClosed(conn: AgentConnection): void {
    conn.closed = true;
    conn.armed = false;
    if (disposed) return;
    log(`agent connection ${conn.index} closed`);
    if (!connections.some((c) => !c.closed)) {
      note = "the agent's connection dropped; restart-app gives the app a fresh process";
    }
    void recheckAfterDrop(conn);
  }

  async function recheckAfterDrop(lost: AgentConnection): Promise<void> {
    if (rechecking) return;
    rechecking = true;
    try {
      for (const delay of RECHECK_DELAYS_MS) {
        await sleep(delay);
        if (disposed) return;
        if (connections.some((c) => !c.closed && c.processKey === lost.processKey)) return;
        let current: AppProcess | null;
        try {
          current = await readAppProcess(serial, packageName);
        } catch {
          // adb did not answer, as while its server restarts or the cable is
          // out. That says nothing about the app, so check again later.
          continue;
        }
        if (!current || processKey(current) !== lost.processKey) {
          failOrphans(current ? processKey(current) : null);
          if (!connections.some((c) => !c.closed)) {
            note = `${current ? "the app restarted" : `${packageName} exited`}; launch-app, restart-app or the next native-network-logs call attaches the agent to its new process`;
          }
          return;
        }
        await assertReverse().catch(() => {});
      }
    } finally {
      rechecking = false;
    }
  }

  function fold(conn: AgentConnection, method: string, params: unknown): void {
    if (typeof params !== "object" || params === null) return;
    const p = params as Record<string, unknown>;
    const layerId = typeof p.requestId === "string" ? p.requestId : null;
    if (!layerId) return;

    if (method === "Network.requestWillBeSent") {
      startRecord(conn, layerId, p);
      return;
    }
    const record = findRecord(conn, layerId);
    if (!record) return;
    // A request in flight at a clear lists again once it settles, so polling
    // with clear sees it finish.
    if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      cleared.delete(record);
    }
    switch (method) {
      case "Network.responseReceived": {
        const r = asObject(p.response);
        record.state = "headers";
        record.response = {
          url: asString(r.url) || record.request.url,
          status: typeof r.status === "number" ? r.status : 0,
          statusText: asString(r.statusText),
          headers: headerMap(r.headers),
          mimeType: asString(r.mimeType),
        };
        if (typeof p.type === "string") record.resourceType = p.type;
        return;
      }
      case "Network.loadingFinished":
        record.state = "complete";
        if (typeof p.encodedDataLength === "number") record.encodedDataLength = p.encodedDataLength;
        setDurationFromArrival(record);
        return;
      case "Network.loadingFailed":
        record.state = "failed";
        record.errorText = asString(p.errorText) || "Unknown error";
        setDurationFromArrival(record);
        return;
    }
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
      id: `android-${nextRecordNumber++}`,
      layer: "android-native",
      layerId,
      connection: conn.index,
      ...(Number.isInteger(req.rnRequestId) ? { rnRequestId: req.rnRequestId as number } : {}),
      state: "pending",
      request: {
        url: asString(req.url),
        method: asString(req.method) || "GET",
        headers: headerMap(req.headers),
        ...(req.hasPostData === true ? { hasPostData: true } : {}),
      },
      timing: { startedAt: Math.round(startedAt) },
    };
    // Keyed on the connection, so records of two connections never replace
    // each other.
    conn.byLayerId.set(layerId, record);
    startArrivals.set(record, performance.now());
    records.push(record);
    byId.set(record.id, { record, conn });
    while (records.length > MAX_RECORDS) evict(records.shift()!);
  }

  function findRecord(conn: AgentConnection, layerId: string): AndroidNativeRecord | undefined {
    const own = conn.byLayerId.get(layerId);
    if (own) return own;
    for (let dropped = conn.resumes; dropped; dropped = dropped.resumes) {
      const record = dropped.byLayerId.get(layerId);
      if (record && (record.state === "pending" || record.state === "headers")) return record;
    }
    return undefined;
  }

  function evict(record: AndroidNativeRecord): void {
    const entry = byId.get(record.id);
    if (entry && entry.conn.byLayerId.get(record.layerId) === record) {
      entry.conn.byLayerId.delete(record.layerId);
    }
    byId.delete(record.id);
    bodies.delete(`response:${record.id}`);
    bodies.delete(`post:${record.id}`);
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
        if (record.state !== "pending" && record.state !== "headers") continue;
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
    if (kind === "response" && record.state !== "complete") {
      return Promise.resolve(
        unavailable(
          record.state === "failed"
            ? "the request failed before a response body arrived"
            : "the response has not finished yet"
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

  function failOrphans(liveKey: string | null): void {
    for (const record of records) {
      if (record.state !== "pending" && record.state !== "headers") continue;
      const conn = byId.get(record.id)?.conn;
      if (!conn?.processKey || conn.processKey === liveKey || liveConnectionFor(conn)) continue;
      record.state = "failed";
      record.errorText = "the app process ended before the request finished";
      cleared.delete(record);
    }
  }

  async function ensureAttached(): Promise<AndroidNetworkNotAttachable | null> {
    return withKeyedLock(attachLock, "attach", async () => {
      const blocked = await prepare();
      if (blocked) return blocked;
      const current = await readAppProcess(serial, packageName);
      failOrphans(current ? processKey(current) : null);
      if (!current) {
        if (!connections.some((c) => c.armed && !c.closed)) {
          note = `${packageName} is not running; launch-app or restart-app attaches the agent to its next process`;
        }
        return null;
      }
      await attach(current);
      if (!ready) return prepare();
      return null;
    });
  }

  async function attachLaunchedProcess(): Promise<void> {
    if (!ready || disposed) return;
    await withKeyedLock(attachLock, "attach", async () => {
      await assertReverse();
      const deadline = Date.now() + NEW_PROCESS_WAIT_MS;
      for (;;) {
        const current = await readAppProcess(serial, packageName);
        failOrphans(current ? processKey(current) : null);
        if (current) return attach(current);
        if (Date.now() >= deadline || disposed) return;
        await sleep(PROCESS_POLL_INTERVAL_MS);
      }
    });
    await waitForArmed(ARM_WAIT_MS);
  }

  function waitForArmed(timeoutMs: number): Promise<void> {
    const key = attachedProcess ? processKey(attachedProcess) : null;
    const armedNow = (): boolean =>
      connections.some((c) => c.armed && !c.closed && c.processKey === key);
    if (armedNow()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        armWaiters.delete(check);
        resolve();
      };
      const check = (): void => {
        if (disposed || armedNow()) done();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref();
      armWaiters.add(check);
    });
  }

  const api: AndroidNetworkInspectorApi = {
    packageName,
    ensureAttached,
    attachLaunchedProcess,
    state() {
      const armed = connections.some((c) => c.armed && !c.closed);
      return {
        armed,
        ...(attachedProcess ? { process: { ...attachedProcess } } : {}),
        ...(capture ? { capture } : {}),
        ...(!armed && note ? { note } : {}),
      };
    },
    records: (port) =>
      records.filter((r) => !cleared.has(r) && !isMetroTraffic(r.request.url, port)),
    record: (id) => byId.get(id)?.record,
    responseBody: (id) => fetchBody(id, "response"),
    requestPostData: (id) => fetchBody(id, "post"),
    clear() {
      // Out of the listing only. The listing that cleared named these ids,
      // so they must still read, and a request in flight must keep folding
      // its events. The buffer's own bound evicts them.
      for (const record of records) cleared.add(record);
    },
  };

  return {
    api,
    dispose: async () => {
      disposed = true;
      for (const wake of armWaiters) wake();
      for (const conn of connections) {
        conn.cdp.close();
        conn.socket.destroy();
      }
      server?.close();
      if (reversed) await removeAdbReverse(serial, devicePort);
    },
  };
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

/**
 * The ABI the app's process runs as, which decides which agent can load in
 * it: a 64-bit phone still runs an app 32-bit when its APK ships only 32-bit
 * native libraries. `primaryCpuAbi` is null for an app with no native
 * libraries, which then runs as the device's primary ABI.
 */
async function resolveAppAbi(serial: string, packageName: string): Promise<string> {
  const dump = await adbShell(
    serial,
    `dumpsys package ${shellQuote(packageName)} | grep -m1 primaryCpuAbi; true`,
    { timeoutMs: 15_000 }
  );
  const abi = /primaryCpuAbi=(\S+)/.exec(dump)?.[1];
  if (abi && abi !== "null") return abi;
  return (await adbShell(serial, "getprop ro.product.cpu.abi", { timeoutMs: 10_000 })).trim();
}

/**
 * pidof also lists the app's processes in a work profile or another user, and
 * those cannot load the agent: `run-as` and the copied files are user 0's. The
 * comm field of /proc/<pid>/stat can hold spaces, so the start time is counted
 * from the field after its closing parenthesis.
 */
async function readAppProcess(serial: string, packageName: string): Promise<AppProcess | null> {
  const out = await adbShell(
    serial,
    `for p in $(pidof ${shellQuote(packageName)}); do echo "$p $(sed 's/.*) //' /proc/$p/stat | cut -d' ' -f20) $(grep '^Uid:' /proc/$p/status)"; done`,
    { timeoutMs: 10_000 }
  );
  for (const line of out.split("\n")) {
    const match = /^(\d+) (\d+) Uid:\s+(\d+)/.exec(line.trim());
    // Each Android user has a range of 100000 uids, and user 0's come first.
    if (match && Number(match[3]) < 100_000) {
      return { pid: Number(match[1]), startTime: Number(match[2]) };
    }
  }
  return null;
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

function headerMap(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, v] of Object.entries(asObject(value))) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      headers[name] = String(v);
    }
  }
  return headers;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function adbFailureDetail(err: unknown): string {
  const message = errorMessage(err);
  const marker = " failed: ";
  const at = message.indexOf(marker);
  return (at >= 0 ? message.slice(at + marker.length) : message).trim();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
