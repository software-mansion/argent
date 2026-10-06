import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

// shellQuote stays real: the commands are asserted as sent.
vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/adb")>("../src/utils/adb");
  return {
    ...actual,
    adbShell: vi.fn(),
    adbShellInput: vi.fn(),
    runAdb: vi.fn(),
    adbReverse: vi.fn(),
    removeAdbReverse: vi.fn(),
  };
});
vi.mock("../src/utils/check-deps", async () => {
  const actual =
    await vi.importActual<typeof import("../src/utils/check-deps")>("../src/utils/check-deps");
  return { ...actual, ensureDeps: vi.fn(async () => {}) };
});

import {
  FAILURE_CODES,
  FailureError,
  Registry,
  ServiceState,
  getFailureSignal,
  type ServiceInstance,
} from "@argent/registry";
import { adbReverse, adbShell, adbShellInput, removeAdbReverse, runAdb } from "../src/utils/adb";
import {
  AGENT_BINARIES_MISSING_REASON,
  ANDROID_NATIVE_REQUEST_ID,
  androidNetworkInspectorBlueprint,
  androidNetworkInspectorRef,
  attachAndroidNetworkInspectorToLaunch,
  findAndroidNativeRecord,
  handshakeProof,
  liveAndroidNetworkCaptureDevices,
  liveAndroidNetworkCaptures,
  openFrame,
  sealFrame,
  sessionKeys,
  type AndroidNetworkInspectorApi,
} from "../src/blueprints/android-network-inspector";
import { createNativeNetworkLogsTool } from "../src/tools/native-devtools/native-network-logs";
import { networkRequestTool } from "../src/tools/network/network-request";
import { DEVICE_OWNED_NAMESPACES, deviceIdOwningUrn } from "../src/tools/simulator/device-services";

const SERIAL = "emulator-5554";
const PKG = "com.example.demo";
const OTHER = "com.example.other";
const DEVICE = { id: SERIAL, platform: "android" as const, kind: "emulator" as const };
const APP_UID = 10212;
const SECRET_SHAPE = /^[0-9a-f]{64}$/;

const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());

function dirFor(packageName = PKG, user = 0): string {
  return `/data/user/${user}/${packageName}/code_cache/.argent-inspector`;
}

interface Proc {
  pid: number;
  startTime: number;
}

/** Dials a port on the host's 127.0.0.1, where the reverse leads. */
function connectTo(port: number, onConnect?: () => void): net.Socket {
  return net.connect(port, "127.0.0.1", onConnect);
}

interface FakeDevice {
  sdk: number;
  machine: string;
  user: number;
  /** What getprop and the kernel say per adb serial; the default is one emulator. */
  identity: Map<string, { serialNo: string; bootId?: string; qemu?: boolean }>;
  runAsError?: string | Error;
  abi: string;
  process: Proc | null;
  /** The app's process for another user, listed by pidof before `process`. */
  profileProcess?: Proc;
  /** `am get-current-user` prints nothing. */
  foregroundUnknown?: boolean;
  processes: Map<string, Proc>;
  commands: string[];
  inputs: string[];
  agentOnAttach: boolean;
  /** What an agent attached by attach-agent uses beyond its process. */
  agentOptions: Partial<AgentOptions>;
  loaded: Set<string>;
  /** Session files by agent directory. */
  files: Map<string, string>;
  devicePort?: number;
  hostPort?: number;
  /** Host ports by device port. */
  reverses: Map<number, number>;
  /** Fails this many first binds with a taken port. */
  takenBinds: number;
  /** Device ports a process on the device listens on: no reverse can bind them. */
  squatted: Set<number>;
  reverseGate?: () => Promise<void>;
  /** Held before a session write lands on the device. */
  sessionWriteGate?: () => Promise<void>;
  /** Held before attach-agent answers. */
  attachGate?: () => Promise<void>;
  /** The next this many process reads fail as adb would. */
  pidofFailures: number;
  adbDown?: boolean;
  stagingLost?: boolean;
  attachError?: string;
  onAttach?: () => void;
}

let device: FakeDevice;
const relays: Array<() => void> = [];
let binRoot: string;
let savedBinDir: string | undefined;
const instances: Array<ServiceInstance<AndroidNetworkInspectorApi>> = [];
const registries: Registry[] = [];
const agents: FakeAgent[] = [];
/** Bumped as each test ends, so an agent that connects later is not the next test's. */
let testGeneration = 0;

function proc(): Proc {
  return device.process!;
}

function hmac(secret: string, message: string): string {
  return createHmac("sha256", Buffer.from(secret, "ascii")).update(message, "utf8").digest("hex");
}

function session(dir = dirFor()): { v: number; port: number; secret: string } {
  return JSON.parse(device.files.get(dir)!) as { v: number; port: number; secret: string };
}

/**
 * The agent's side of sealed frames, written apart from the tool-server's:
 * keys from node's own HKDF, then AES-256-GCM with a per-direction counter.
 */
function agentSideKeys(
  agentNonce: string,
  serverNonce: string,
  secret: string
): { agent: Buffer; server: Buffer } {
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync("sha256", secret, agentNonce + serverNonce, info, 32));
  return {
    agent: derive("argent-nwi agent to server"),
    server: derive("argent-nwi server to agent"),
  };
}

function counterIv(counter: number): Buffer {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(BigInt(counter), 4);
  return iv;
}

/** Base64 of AES-256-GCM over `text`, the tag appended. */
function sealText(key: Buffer, counter: number, text: string): string {
  const cipher = createCipheriv("aes-256-gcm", key, counterIv(counter));
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]).toString(
    "base64"
  );
}

function sealLine(key: Buffer, counter: number, frame: unknown): string {
  return `${JSON.stringify({ type: "Sealed", payload: sealText(key, counter, JSON.stringify(frame)) })}\n`;
}

function openLine(
  key: Buffer,
  counter: number,
  line: string
): { type: string; payload: Record<string, unknown> } | null {
  try {
    const frame = JSON.parse(line) as { type?: unknown; payload?: unknown };
    if (frame.type !== "Sealed" || typeof frame.payload !== "string") return null;
    const sealed = Buffer.from(frame.payload, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, counterIv(counter));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plaintext = Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - 16)),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as {
      type: string;
      payload: Record<string, unknown>;
    };
  } catch {
    return null;
  }
}

interface AgentOptions {
  packageName: string;
  /** The secret the agent read from its session file. */
  secret: string;
  /** What it proves with; a wrong one stands for a client without the session. */
  proofSecret?: string;
  pid: number;
  startTime: number;
  instance: string;
  lastSeq: number;
  /** null: an agent of the earlier protocol, whose first frame has no hello. */
  hello: number | null;
  inFlight: string[];
  dropped: number;
  capture: Record<string, unknown> | undefined;
  /** Events the agent buffered while disconnected, flushed before the enable reply. */
  beforeEnable?: (agent: FakeAgent) => void;
  /** Frames sent in the same socket write as the enable reply, right after it. */
  withEnableReply?: (agent: FakeAgent) => unknown[];
  /** Requests the agent holds without a reply until `answer` sends it. */
  unanswered?: string[];
}

class FakeAgent {
  readonly requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  /** Every frame from the tool-server after the handshake, as `Control` or the CDP method. */
  readonly received: string[] = [];
  readonly controls: Array<Record<string, unknown>> = [];
  readonly responseBodies = new Map<string, Record<string, unknown>>();
  readonly postData = new Map<string, Record<string, unknown>>();
  onRequest?: (method: string) => void;
  serverProofOk?: boolean;
  /** Set when a frame from the tool-server did not open, which closes the connection. */
  unopened?: string;
  /** Set once both proofs went through; each direction counts its frames from 0. */
  private keys: { agent: Buffer; server: Buffer } | null = null;
  private sent = 0;
  private read = 0;
  private readonly nonce = randomBytes(16).toString("hex");

  private constructor(
    readonly socket: net.Socket,
    readonly options: AgentOptions
  ) {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) this.receive(line);
      }
    });
    socket.on("error", () => {});
  }

  get instance(): string {
    return this.options.instance;
  }

  /** The agent's id for its `seq`th request. */
  rid(seq: number): string {
    return `${this.options.instance}-${seq}`;
  }

  static connect(
    port: number,
    options: Partial<AgentOptions> & { secret: string }
  ): Promise<FakeAgent> {
    const full: AgentOptions = {
      packageName: PKG,
      pid: device.process?.pid ?? 4722,
      startTime: device.process?.startTime ?? 91_000,
      instance: randomBytes(4).toString("hex"),
      lastSeq: 0,
      hello: 2,
      inFlight: [],
      dropped: 0,
      capture: { state: "active" },
      ...options,
    };
    const born = testGeneration;
    return new Promise((resolve, reject) => {
      const socket = connectTo(port, () => {
        if (born !== testGeneration) {
          socket.destroy();
          reject(new Error("the test that started this agent ended"));
          return;
        }
        const agent = new FakeAgent(socket, full);
        agents.push(agent);
        agent.send({
          type: "Control",
          payload:
            full.hello === null
              ? { packageName: full.packageName }
              : { hello: full.hello, packageName: full.packageName, nonce: agent.nonce },
        });
        resolve(agent);
      });
      socket.once("error", reject);
    });
  }

  /** As the agent does: reads the session next to the jar and dials its port through the reverse. */
  static fromSession(
    dir: string,
    process: Proc,
    options: Partial<AgentOptions> = {}
  ): Promise<FakeAgent | null> {
    const line = device.files.get(dir);
    if (!line) return Promise.resolve(null);
    const { port, secret } = JSON.parse(line) as { port: number; secret: string };
    const hostPort = device.reverses.get(port);
    if (hostPort === undefined) return Promise.resolve(null);
    return FakeAgent.connect(hostPort, {
      ...device.agentOptions,
      secret,
      pid: process.pid,
      startTime: process.startTime,
      ...options,
    });
  }

  private receive(line: string): void {
    if (this.socket.destroyed) return;
    if (!this.keys) {
      this.authenticate(JSON.parse(line) as { payload: Record<string, unknown> });
      return;
    }
    const frame = openLine(this.keys.server, this.read, line);
    if (!frame) {
      this.unopened = line;
      this.socket.destroy();
      return;
    }
    this.read++;
    this.handle(frame);
  }

  private authenticate({ payload }: { payload: Record<string, unknown> }): void {
    const serverNonce = String(payload.nonce);
    this.serverProofOk =
      payload.proof === hmac(this.options.secret, `argent-server\n${this.nonce}\n${serverNonce}`);
    if (!this.serverProofOk) {
      this.socket.destroy();
      return;
    }
    const { pid, startTime, instance, lastSeq } = this.options;
    this.send({
      type: "Control",
      payload: {
        proof: hmac(
          this.options.proofSecret ?? this.options.secret,
          `argent-agent\n${this.nonce}\n${serverNonce}\n${pid}\n${startTime}\n${instance}\n${lastSeq}`
        ),
        pid,
        startTime,
        instance,
        lastSeq,
      },
    });
    this.keys = agentSideKeys(this.nonce, serverNonce, this.options.secret);
  }

  private handle(frame: { type: string; payload: Record<string, unknown> }): void {
    const payload = frame.payload;
    if (frame.type === "Control") {
      this.received.push("Control");
      this.controls.push(payload);
      return;
    }
    const { id, method, params } = payload as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    this.received.push(method);
    this.requests.push({ id, method, params });
    this.onRequest?.(method);
    if (this.options.unanswered?.includes(method)) return;
    this.reply(id, method, params);
  }

  /** Sends the reply to a request held by `unanswered`. */
  answer(method: string): void {
    const request = this.requests.find((r) => r.method === method)!;
    this.reply(request.id, request.method, request.params);
  }

  private reply(id: number, method: string, params: Record<string, unknown>): void {
    const requestId = String(params?.requestId ?? "");
    let result: Record<string, unknown> = {};
    if (method === "Network.enable") {
      this.options.beforeEnable?.(this);
      result = {
        inFlight: this.options.inFlight,
        dropped: this.options.dropped,
        ...(this.options.capture ? { capture: this.options.capture } : {}),
      };
      const extra = this.options.withEnableReply?.(this);
      if (extra) {
        this.sendTogether([{ type: "CDP", payload: { id, result } }, ...extra]);
        return;
      }
    } else if (method === "Network.getResponseBody") {
      result = this.responseBodies.get(requestId) ?? {
        bodyAvailable: false,
        body: "",
        base64Encoded: false,
        wasTruncated: false,
      };
    } else if (method === "Network.getRequestPostData") {
      result = this.postData.get(requestId) ?? {
        bodyAvailable: false,
        postData: "",
        base64Encoded: false,
        wasTruncated: false,
      };
    }
    this.send({ type: "CDP", payload: { id, result } });
  }

  /** Sealed once the handshake is through, as every frame after the proof is. */
  send(frame: unknown): void {
    this.sendTogether([frame]);
  }

  /** Several frames in one socket write. */
  sendTogether(frames: unknown[]): void {
    this.socket.write(
      frames
        .map((frame) =>
          this.keys ? sealLine(this.keys.agent, this.sent++, frame) : `${JSON.stringify(frame)}\n`
        )
        .join("")
    );
  }

  event(method: string, params: Record<string, unknown>): void {
    this.send({ type: "CDP", payload: { method, params } });
  }

  /** A request's first event only, so it stays in flight. */
  started(requestId: string, url: string, method = "GET"): void {
    this.event("Network.requestWillBeSent", {
      requestId,
      request: { url, method, headers: {} },
      timestamp: 1000,
      wallTime: 1000,
    });
  }

  request(
    requestId: string,
    url: string,
    options: { method?: string; rnRequestId?: number; hasPostData?: boolean } = {}
  ): void {
    this.event("Network.requestWillBeSent", {
      requestId,
      loaderId: requestId,
      request: {
        url,
        method: options.method ?? "GET",
        headers: { "x-app": "probe", "Authorization": "Bearer secret-token" },
        ...(options.rnRequestId !== undefined ? { rnRequestId: options.rnRequestId } : {}),
        ...(options.hasPostData ? { hasPostData: true } : {}),
      },
      timestamp: 1000,
      wallTime: 1000,
    });
    this.event("Network.responseReceived", {
      requestId,
      timestamp: 1000.1,
      type: "XHR",
      response: {
        url,
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "application/json" },
        mimeType: "application/json",
      },
    });
    this.event("Network.dataReceived", { requestId, timestamp: 1000.12, dataLength: 11 });
    this.event("Network.loadingFinished", {
      requestId,
      timestamp: 1000.143,
      encodedDataLength: 11,
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.destroyed) return resolve();
      this.socket.once("close", () => resolve());
      this.socket.end();
    });
  }

  closed(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.destroyed) return resolve();
      this.socket.once("close", () => resolve());
    });
  }
}

function adbFailure(command: string, detail: string): FailureError {
  return new FailureError(`adb -s ${SERIAL} shell ${command} failed: ${detail}`, {
    error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
    failure_stage: "android_adb_command",
    failure_area: "tool_server",
    error_kind: "subprocess",
  });
}

function attachCommands(): string[] {
  return device.commands.filter((c) => c.startsWith("cmd activity attach-agent"));
}

function attachScripts(): string[] {
  return device.commands.filter((c) => c.includes(" sh -c ") && c.includes("mkdir -p"));
}

async function createInspector(
  metroPort = 8081,
  packageName = PKG,
  deviceInfo: { id: string; platform: "android"; kind: "emulator" | "device" } = DEVICE
): Promise<AndroidNetworkInspectorApi> {
  const ref = androidNetworkInspectorRef(deviceInfo, packageName, metroPort);
  const instance = await androidNetworkInspectorBlueprint.factory(
    {},
    ref.urn.slice(ref.urn.indexOf(":") + 1),
    ref.options
  );
  instances.push(instance);
  return instance.api;
}

async function armedInspector(metroPort = 8081): Promise<AndroidNetworkInspectorApi> {
  const api = await createInspector(metroPort);
  expect(await api.ensureAttached(metroPort)).toBeNull();
  await vi.waitFor(() => expect(api.state().armed).toBe(true));
  return api;
}

function toolRegistry(): Registry {
  const registry = new Registry();
  registry.registerBlueprint(androidNetworkInspectorBlueprint);
  registry.registerTool(createNativeNetworkLogsTool(registry));
  registries.push(registry);
  return registry;
}

function writeAgentBinaries(root: string): void {
  const dir = path.join(root, "network-inspector");
  for (const file of [
    "network-inspector.jar",
    "x86_64/libjvmti_network_inspector.so",
    "arm64-v8a/libjvmti_network_inspector.so",
  ]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), file);
  }
}

function pidofReads(): number {
  return device.commands.filter((c) => c.includes("for p in $(pidof")).length;
}

/** A gate that holds its first caller only. */
function holdOnce(): { gate: () => Promise<void>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let used = false;
  return {
    gate: () => {
      if (used) return Promise.resolve();
      used = true;
      return held;
    },
    release: () => release(),
  };
}

/**
 * A raw TCP client of the host's listener, as an app on an emulator reaches
 * the host's 127.0.0.1 through 10.0.2.2: it sends a hello, answers the first
 * line with `proof`, and collects every line until the tool-server closes it.
 */
function rawClient(port: number, proof: Record<string, unknown>): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const socket = net.connect(port, "127.0.0.1");
    let buf = "";
    socket.on("error", () => {});
    socket.on("close", () => resolve(lines));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (lines.length === 1) {
          socket.write(`${JSON.stringify({ type: "Control", payload: proof })}\n`);
        }
      }
    });
    socket.write(
      `${JSON.stringify({ type: "Control", payload: { hello: 2, packageName: PKG, nonce: "1".repeat(32) } })}\n`
    );
  });
}

interface Relay {
  port: number;
  /** Every line that reached the tool-server, injected ones included. */
  toServer: string[];
  /** Every line that reached the agent. */
  toAgent: string[];
  /** Writes a line of the relay's own to the tool-server. */
  inject(line: string): void;
}

/**
 * A process on the device between the agent and the tool-server, as one that
 * bound the device port while the reverse was down would be. It passes each
 * line on, or the lines `edit` makes of it.
 */
function startRelay(
  target: number,
  edit: {
    toServer?: (line: string, index: number) => string[];
    toAgent?: (line: string, index: number) => string[];
  } = {}
): Promise<Relay> {
  const relay: Relay = { port: 0, toServer: [], toAgent: [], inject: () => {} };
  const sockets = new Set<net.Socket>();
  const pipe = (
    from: net.Socket,
    to: net.Socket,
    seen: string[],
    map?: (line: string, index: number) => string[]
  ): void => {
    sockets.add(from);
    let buf = "";
    let index = 0;
    from.setEncoding("utf8");
    from.on("error", () => {});
    from.on("close", () => to.destroy());
    from.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        for (const out of map ? map(line, index) : [line]) {
          seen.push(out);
          to.write(`${out}\n`);
        }
        index++;
      }
    });
  };
  const server = net.createServer((agentSide) => {
    const serverSide = connectTo(target);
    relay.inject = (line) => {
      relay.toServer.push(line);
      serverSide.write(`${line}\n`);
    };
    pipe(agentSide, serverSide, relay.toServer, edit.toServer);
    pipe(serverSide, agentSide, relay.toAgent, edit.toAgent);
  });
  relays.push(() => {
    server.close();
    for (const socket of sockets) socket.destroy();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      relay.port = (server.address() as net.AddressInfo).port;
      resolve(relay);
    });
  });
}

const SEALED_LINE = /^\{"type":"Sealed","payload":"[A-Za-z0-9+/]+={0,2}"\}$/;

/** The sealed line with one bit of its ciphertext flipped at `offset`. */
function flipByte(line: string, offset: number): string {
  const sealed = Buffer.from((JSON.parse(line) as { payload: string }).payload, "base64");
  sealed[offset]! ^= 0x01;
  return JSON.stringify({ type: "Sealed", payload: sealed.toString("base64") });
}

function stderrText(): string {
  return vi
    .mocked(process.stderr.write)
    .mock.calls.map((call) => String(call[0]))
    .join("");
}

beforeEach(() => {
  vi.clearAllMocks();
  device = {
    sdk: 35,
    machine: "aarch64",
    user: 0,
    identity: new Map(),
    abi: "arm64-v8a",
    process: { pid: 4722, startTime: 91_000 },
    processes: new Map(),
    commands: [],
    inputs: [],
    agentOnAttach: true,
    agentOptions: {},
    loaded: new Set(),
    files: new Map(),
    reverses: new Map(),
    takenBinds: 0,
    squatted: new Set(),
    pidofFailures: 0,
  };
  binRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-android-network-"));
  writeAgentBinaries(binRoot);
  savedBinDir = process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR;
  process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR = binRoot;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  const processOf = (packageName: string): Proc | null =>
    packageName === PKG ? device.process : (device.processes.get(packageName) ?? null);

  vi.mocked(adbShell).mockImplementation(async (serial, command) => {
    device.commands.push(command);
    if (device.adbDown) throw adbFailure(command, "device offline");
    if (command.startsWith('echo "sdk=')) {
      const id = device.identity.get(serial) ?? {
        serialNo: "EMULATOR36X1X9X0",
        bootId: "boot-a",
        qemu: true,
      };
      // Answers the lines the command asks for, as the device's shell would.
      const values: Record<string, string> = {
        sdk: String(device.sdk),
        machine: device.machine,
        serialno: id.serialNo,
        boot: id.bootId ?? "boot-a",
        qemu: id.qemu ? "11" : "",
        user: String(device.user),
      };
      return [...command.matchAll(/echo "(\w+)=/g)]
        .map(([, key]) => `${key}=${values[key!] ?? ""}`)
        .join("\n");
    }
    if (/^run-as '[^']+'( --user \d+)? id$/.test(command)) {
      if (device.runAsError instanceof Error) throw device.runAsError;
      if (device.runAsError) throw adbFailure(command, device.runAsError);
      return `uid=${device.user * 100_000 + APP_UID}(u0_a212) gid=${APP_UID}(u0_a212)\n`;
    }
    if (command.startsWith("dumpsys package")) return `    primaryCpuAbi=${device.abi}\n`;
    if (command === "getprop ro.product.cpu.abi") return "x86_64\n";
    if (command.includes("for p in $(pidof")) {
      if (device.pidofFailures > 0) {
        device.pidofFailures--;
        throw adbFailure(command, "error: closed");
      }
      const packageName = /pidof '([^']+)'/.exec(command)![1]!;
      const foreground = command.includes('echo "user=$(am get-current-user 2>/dev/null)"')
        ? [`user=${device.foregroundUnknown ? "" : device.user}`]
        : [];
      const lines = device.profileProcess
        ? [
            `${device.profileProcess.pid} ${device.profileProcess.startTime} Uid:\t${(device.user === 10 ? 0 : 10) * 100_000 + APP_UID}\t0`,
          ]
        : [];
      const p = processOf(packageName);
      if (p) lines.push(`${p.pid} ${p.startTime} Uid:\t${device.user * 100_000 + APP_UID}\t0`);
      return [...foreground, ...lines].map((line) => `${line}\n`).join("");
    }
    if (command.startsWith("cmd activity attach-agent")) {
      await device.attachGate?.();
      if (device.attachError) throw adbFailure(command, device.attachError);
      const match =
        /^cmd activity attach-agent (\d+) '(.+)\/libjvmti_network_inspector\.so=.*,pkg=([^,']+)'$/.exec(
          command
        )!;
      const pid = Number(match[1]);
      const target = [device.process, ...device.processes.values()].find((p) => p?.pid === pid);
      if (target) device.loaded.add(`${target.pid}:${target.startTime}`);
      device.onAttach?.();
      if (device.agentOnAttach && target) {
        // The agent dials on its own; a listener already gone refuses it.
        FakeAgent.fromSession(match[2]!, target, { packageName: match[3]! }).catch(() => {});
      }
    }
    return "";
  });
  vi.mocked(adbShellInput).mockImplementation(async (_serial, command, input) => {
    device.commands.push(command);
    device.inputs.push(input);
    if (device.adbDown) throw adbFailure(command, "device offline");
    if (command.includes("IFS= read -r s")) {
      const dir = /rm -rf ([^\s;]+)/.exec(command)![1]!;
      // The script compares the secret alone, which is all its stdin holds.
      const given = input.trim();
      expect(given).toMatch(SECRET_SHAPE);
      if (device.files.get(dir)?.includes(`"secret":"${given}"`)) device.files.delete(dir);
      return "";
    }
    if (device.runAsError instanceof Error) throw device.runAsError;
    if (device.runAsError) throw adbFailure(command, device.runAsError);
    const dir = /mkdir -p (\S+) &&/.exec(command)![1]!;
    await device.sessionWriteGate?.();
    device.files.set(dir, input.trim());
    const maps = /\/proc\/(\d+)\/maps/.exec(command);
    // A session-only write.
    if (!maps) return "";
    const pid = Number(maps[1]);
    const target = [device.process, ...device.processes.values()].find((p) => p?.pid === pid);
    if (target && device.loaded.has(`${target.pid}:${target.startTime}`)) return "loaded\n";
    if (device.stagingLost) {
      throw adbFailure(
        command,
        "cp: bad '/data/local/tmp/.argent-inspector/network-inspector.jar': No such file or directory"
      );
    }
    return "copied\n";
  });
  vi.mocked(runAdb).mockImplementation(async (args) => {
    device.commands.push(args.join(" "));
    if (args[2] === "push") device.stagingLost = false;
    return { stdout: "", stderr: "" };
  });
  vi.mocked(adbReverse).mockImplementation(async (_serial, devicePort, hostPort, options) => {
    await device.reverseGate?.();
    if (device.adbDown) throw adbFailure("reverse", "device offline");
    const command = `reverse ${options?.noRebind ? "--no-rebind " : ""}tcp:${devicePort} tcp:${hostPort}`;
    device.commands.push(command);
    const taken = device.squatted.has(devicePort);
    if (
      taken ||
      (options?.noRebind && (device.takenBinds > 0 || device.reverses.has(devicePort)))
    ) {
      if (!taken) device.takenBinds--;
      throw new FailureError(
        `adb -s ${SERIAL} ${command} failed: adb: error: cannot bind listener: Address already in use`,
        {
          error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
          failure_stage: "android_adb_command",
          failure_area: "tool_server",
          error_kind: "subprocess",
        }
      );
    }
    device.devicePort = devicePort;
    device.hostPort = hostPort;
    device.reverses.set(devicePort, hostPort);
  });
  vi.mocked(removeAdbReverse).mockImplementation(async (_serial, devicePort) => {
    device.commands.push(`reverse --remove tcp:${devicePort}`);
    device.reverses.delete(devicePort);
  });
});

afterEach(async () => {
  testGeneration++;
  vi.useRealTimers();
  for (const stop of relays.splice(0)) stop();
  await Promise.all(agents.splice(0).map((a) => a.close()));
  await Promise.all(instances.splice(0).map((i) => i.dispose()));
  await Promise.all(registries.splice(0).map((r) => r.dispose()));
  if (savedBinDir === undefined) delete process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR;
  else process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR = savedBinDir;
  fs.rmSync(binRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("the agent handshake", () => {
  it("writes a session with a fresh secret, proves it both ways, then sends the Metro port and Network.enable", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;

    expect(attachCommands()).toEqual([
      `cmd activity attach-agent 4722 '${dirFor()}/libjvmti_network_inspector.so=jar=${dirFor()}/network-inspector.jar,pkg=${PKG}'`,
    ]);
    const written = session();
    expect(written).toEqual({ v: 2, port: device.devicePort, secret: expect.any(String) });
    expect(written.secret).toMatch(SECRET_SHAPE);
    expect(agent.serverProofOk).toBe(true);
    expect(agent.received.slice(0, 2)).toEqual(["Control", "Network.enable"]);
    expect(agent.controls[0]).toEqual({ metroPort: 8081 });
    expect(api.state()).toMatchObject({
      armed: true,
      process: { pid: 4722, startTime: 91_000 },
      capture: { state: "active" },
    });

    // The secret reaches the device on stdin only: no command line, no log.
    expect(device.inputs).toContain(`${JSON.stringify(written)}\n`);
    for (const command of device.commands) expect(command).not.toContain(written.secret);
    for (const call of vi.mocked(runAdb).mock.calls) {
      expect(call[0].join(" ")).not.toContain(written.secret);
    }
    expect(stderrText()).not.toContain(written.secret);
  });

  it("gives every inspector its own secret", async () => {
    await armedInspector();
    const first = session().secret;
    await instances.pop()!.dispose();
    device.loaded.clear();
    await armedInspector();
    expect(session().secret).not.toBe(first);
  });

  it("closes a client whose proof does not verify, and nothing it sends becomes a record", async () => {
    device.agentOnAttach = false;
    const api = await createInspector();
    expect(await api.ensureAttached(8081)).toBeNull();

    const impostor = await FakeAgent.connect(device.hostPort!, {
      secret: session().secret,
      proofSecret: "0".repeat(64),
    });
    const closed = impostor.closed();
    // It got as far as sending its proof.
    await vi.waitFor(() => expect(impostor.serverProofOk).toBe(true));
    impostor.started(impostor.rid(1), "https://api.example.com/login?note=IGNORE-PREVIOUS");
    const outcome = await Promise.race([
      closed.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("still open"), 2_000)),
    ]);

    expect(outcome).toBe("closed");
    expect(impostor.received).toEqual([]);
    expect(api.records(8081)).toEqual([]);
    expect(api.state().armed).toBe(false);
  });

  it("closes a connection that sends anything but its proof after the hello", async () => {
    device.agentOnAttach = false;
    const api = await createInspector();
    expect(await api.ensureAttached(8081)).toBeNull();

    const early = connectTo(device.hostPort!);
    early.on("error", () => {});
    early.resume();
    const closed = new Promise<void>((resolve) => early.once("close", () => resolve()));
    early.write(
      `${JSON.stringify({ type: "Control", payload: { hello: 2, packageName: PKG, nonce: "1".repeat(32) } })}\n` +
        `${JSON.stringify({ type: "CDP", payload: { method: "Network.requestWillBeSent", params: { requestId: "00000000-1", request: { url: "https://example.com/forged", method: "GET", headers: {} } } } })}\n`
    );
    await closed;

    expect(api.records(8081)).toEqual([]);
    expect(api.state().armed).toBe(false);
  });

  it("is refused by an agent whose session holds another secret", async () => {
    device.agentOnAttach = false;
    const api = await createInspector();
    expect(await api.ensureAttached(8081)).toBeNull();

    const stale = await FakeAgent.connect(device.hostPort!, { secret: "a".repeat(64) });
    await stale.closed();

    expect(stale.serverProofOk).toBe(false);
    expect(api.state().armed).toBe(false);
  });

  it("closes a connection that has not authenticated within 5 s", async () => {
    device.agentOnAttach = false;
    const api = await createInspector();
    expect(await api.ensureAttached(8081)).toBeNull();

    const stalled = connectTo(device.hostPort!);
    stalled.on("error", () => {});
    // Reads, so the tool-server's close reaches it as an end.
    stalled.resume();
    const closed = new Promise<void>((resolve) => stalled.once("close", () => resolve()));
    stalled.write(
      `${JSON.stringify({ type: "Control", payload: { hello: 2, packageName: PKG, nonce: "1".repeat(32) } })}\n`
    );
    const started = performance.now();
    const outcome = await Promise.race([
      closed.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("still open"), 7_000)),
    ]);

    expect(outcome).toBe("closed");
    expect(performance.now() - started).toBeGreaterThanOrEqual(4_500);
    expect(api.state().armed).toBe(false);
  }, 10_000);

  it("keeps room for the agent while connections that never authenticate pile up", async () => {
    device.agentOnAttach = false;
    const api = await createInspector();
    expect(await api.ensureAttached(8081)).toBeNull();

    const stalled = await Promise.all(
      Array.from(
        { length: 40 },
        () =>
          new Promise<net.Socket>((resolve) => {
            const socket = connectTo(device.hostPort!, () => resolve(socket));
            socket.on("error", () => {});
            socket.resume();
          })
      )
    );
    const firstClosed = new Promise<void>((resolve) =>
      stalled[0]!.destroyed ? resolve() : stalled[0]!.once("close", () => resolve())
    );

    await FakeAgent.fromSession(dirFor(), proc());
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
    await firstClosed;
    for (const socket of stalled) socket.destroy();
  });

  it("rejects a hello that names another package and stays unarmed", async () => {
    device.agentOnAttach = false;
    const api = await createInspector();
    expect(await api.ensureAttached(8081)).toBeNull();

    const impostor = await FakeAgent.connect(device.hostPort!, {
      secret: session().secret,
      packageName: "com.other.app",
    });
    await impostor.closed();
    expect(impostor.received).toEqual([]);
    expect(api.state().armed).toBe(false);
  });

  it("closes a peer that opens without a hello and only logs it: an unauthenticated peer sets no note", async () => {
    device.agentOnAttach = false;
    const api = await createInspector();
    expect(await api.ensureAttached(8081)).toBeNull();
    const before = api.state();

    const earlier = await FakeAgent.connect(device.hostPort!, { secret: "", hello: null });
    await earlier.closed();

    expect(api.state()).toEqual(before);
    expect(stderrText()).toContain("it speaks an earlier protocol");
  });

  it("closes an unauthenticated connection past the handshake's frame size, and keeps serving", async () => {
    device.agentOnAttach = false;
    const api = await createInspector();
    expect(await api.ensureAttached(8081)).toBeNull();

    const hostile = connectTo(device.hostPort!);
    hostile.on("error", () => {});
    const closed = new Promise<void>((resolve) => hostile.once("close", () => resolve()));
    hostile.write(`${"[".repeat(1_000_000)}${"]".repeat(1_000_000)}\n`);
    await closed;

    await FakeAgent.fromSession(dirFor(), proc());
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
  });

  it("closes an authenticated connection whose frame never ends before its buffer outgrows the tool-server", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    const closed = agent.closed();
    const chunk = "A".repeat(1024 * 1024);
    const limit = 32 * 1024 * 1024;
    let sent = 0;
    const pump = (): void => {
      while (!agent.socket.destroyed && sent < limit) {
        sent += chunk.length;
        if (!agent.socket.write(chunk)) {
          agent.socket.once("drain", pump);
          return;
        }
      }
    };
    pump();
    await closed;
    expect(sent).toBeLessThan(limit);
    await vi.waitFor(() => expect(api.state().armed).toBe(false));
  });

  it("sends the Metro port again when a call passes another one", async () => {
    const api = await armedInspector(8081);
    const agent = agents[0]!;
    expect(await api.ensureAttached(8081)).toBeNull();
    expect(await api.ensureAttached(8190)).toBeNull();
    await vi.waitFor(() =>
      expect(agent.controls).toEqual([{ metroPort: 8081 }, { metroPort: 8190 }])
    );

    await agent.close();
    const next = (await FakeAgent.fromSession(dirFor(), proc(), { instance: agent.instance }))!;
    await vi.waitFor(() => expect(next.controls).toEqual([{ metroPort: 8190 }]));
  });
});

/** Computed apart from this code, with javax.crypto. */
const KAT = {
  secret: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  agentNonce: "00112233445566778899aabbccddeeff",
  serverNonce: "ffeeddccbbaa99887766554433221100",
  pid: 4722,
  startTime: 91_000,
  instance: "1a2b3c4d",
  lastSeq: 7,
  serverProof: "a94b4168f1f58ddf7eca3f0d86c42c3c90bd0b5e853f4d8e097353d31e253f37",
  agentProof: "c0908d7c5d923ae9d0aef025c0df0671aae87d0b516d2382f626ec394006faf2",
  kAgent: "9d65168c7a487ec1b9c0d331d8093a1700c84ca9716f226a3f21ae04a173e62a",
  kServer: "abca226a8c2233e9f2a0ada63fd780fbe23e185e3a5eb2921a2ba3ed314997ec",
  frames: [
    {
      key: "server",
      counter: 0,
      plaintext: '{"type":"Control","payload":{"metroPort":8081}}',
      payload:
        "PWBjkadiQsWW/qJaIHJghSZ6bBugtmpO09GPo21Hs80Ugs1hV7ST3HyZt0xH7L4s6M6ziE8Zk+rV2Aq/EZYJ",
    },
    {
      key: "server",
      counter: 1,
      plaintext: '{"type":"CDP","payload":{"id":1,"method":"Network.enable","params":{}}}',
      payload:
        "7jwJxPqwzYN8s2FkVdiA1TW0KaxEnzf6Y+I8Af2oRyBPvvX+Q10AclwCZttSHU+7igAZBVjiiDMlibYOP021oGCiq+sF/xt/6RUeREdW36w5SlJ780if",
    },
    {
      key: "agent",
      counter: 0,
      plaintext:
        '{"type":"CDP","payload":{"id":1,"result":{"inFlight":[],"dropped":0,"capture":{"state":"active"}}}}',
      payload:
        "a/tf1Vy3jxE8TTucLZzEnb+Zrl1EjlIPQ00cVDVJI4wzmonm4SGAfrHhTNuFm4aUwdYOmKRwM3j3nuE7dhSzvPAT5Q0908dyxyVORRORZP6JuFd0dmO8vWsCtttsSvf2bGgvuURRbLh5UhJNbf70OC1JsA==",
    },
    {
      key: "agent",
      counter: 0x01020304050607,
      plaintext:
        '{"type":"Status","payload":{"event":"capture","state":"waiting","detail":"café"}}',
      payload:
        "CyFq7ogZ8k1MSTH9Y37qojGv4lSEMDyf37AGVJkBPJQh+k7BWZXtTFiEFTC3Oqu92207KE9X2F/biQOFcZ8MyoBrdEPjm4ot8RloRrrUS7UXm489FyTKKOlNhXAD71SDmFk=",
    },
  ],
} as const;

describe("sealed frames", () => {
  it("derives the keys and proofs and seals the frames exactly as the known-answer vector says", () => {
    const keys = sessionKeys(KAT.agentNonce, KAT.serverNonce, KAT.secret);
    expect(keys.agent.toString("hex")).toBe(KAT.kAgent);
    expect(keys.server.toString("hex")).toBe(KAT.kServer);
    // RFC 5869 as node's own HKDF implements it gives the same keys.
    expect(agentSideKeys(KAT.agentNonce, KAT.serverNonce, KAT.secret)).toEqual(keys);
    expect(handshakeProof(KAT.secret, ["argent-server", KAT.agentNonce, KAT.serverNonce])).toBe(
      KAT.serverProof
    );
    expect(
      handshakeProof(KAT.secret, [
        "argent-agent",
        KAT.agentNonce,
        KAT.serverNonce,
        KAT.pid,
        KAT.startTime,
        KAT.instance,
        KAT.lastSeq,
      ])
    ).toBe(KAT.agentProof);

    for (const { key, counter, plaintext, payload } of KAT.frames) {
      const frame = JSON.parse(plaintext) as unknown;
      expect(JSON.stringify(frame)).toBe(plaintext);
      expect(sealFrame(keys[key], counter, frame)).toBe(payload);
      expect(openFrame(keys[key], counter, { type: "Sealed", payload })).toEqual(frame);
      expect(openFrame(keys[key], counter + 1, { type: "Sealed", payload })).toBe(
        `its sealed frame ${counter + 1} did not verify`
      );
    }
    // Each direction has its own key.
    const { counter, payload } = KAT.frames[0];
    expect(openFrame(keys.agent, counter, { type: "Sealed", payload })).toBe(
      "its sealed frame 0 did not verify"
    );
  });

  it("opens nothing but a sealed frame in canonical base64 that holds one frame", () => {
    const key = sessionKeys(KAT.agentNonce, KAT.serverNonce, KAT.secret).agent;
    const sealed = (text: string): { type: string; payload: string } => ({
      type: "Sealed",
      payload: sealText(key, 0, text),
    });
    expect(openFrame(key, 0, { type: "CDP", payload: { method: "Network.enable" } })).toBe(
      "it sent a frame that is not sealed"
    );
    expect(openFrame(key, 0, { type: "Sealed", payload: { nested: true } })).toBe(
      "it sent a frame that is not sealed"
    );
    expect(openFrame(key, 0, sealed('{"type":"CDP","payload":'))).toBe(
      "its sealed frame 0 holds no JSON"
    );
    for (const inner of [
      { type: "Sealed", payload: {} },
      { type: "CDP", payload: "text" },
      { type: "CDP", payload: [] },
      { payload: {} },
      [],
    ]) {
      expect(openFrame(key, 0, sealed(JSON.stringify(inner)))).toBe(
        "its sealed frame 0 holds no frame"
      );
    }
    const valid = sealed('{"type":"Status","payload":{}}');
    expect(openFrame(key, 0, valid)).toEqual({ type: "Status", payload: {} });
    // The same bytes in another spelling, and a payload too short for its tag.
    const unpadded = valid.payload.replace(/=+$/, "");
    expect(unpadded).not.toBe(valid.payload);
    expect(openFrame(key, 0, { type: "Sealed", payload: unpadded })).toBe(
      "its sealed frame 0 is not base64"
    );
    expect(openFrame(key, 0, { type: "Sealed", payload: "AAAA" })).toBe(
      "its sealed frame 0 is not base64"
    );
  });

  it("closes a relayed connection once a plaintext frame follows the handshake, and folds nothing from it", async () => {
    device.agentOnAttach = false;
    const api = await createInspector();
    expect(await api.ensureAttached(8081)).toBeNull();
    const injected = JSON.stringify({
      type: "CDP",
      payload: {
        method: "Network.requestWillBeSent",
        params: {
          requestId: "0badc0de-1",
          request: { url: "https://example.com/injected", method: "GET", headers: {} },
          wallTime: 1000,
        },
      },
    });
    const relay = await startRelay(device.hostPort!, {
      // Sent right after the tool-server's first sealed frame: the connection is authenticated.
      toAgent: (line, index) => {
        if (index === 1) relay.inject(injected);
        return [line];
      },
    });

    const agent = await FakeAgent.connect(relay.port, {
      secret: session().secret,
      instance: "0badc0de",
    });
    await agent.closed();

    expect(relay.toAgent[1]).toMatch(SEALED_LINE);
    expect(relay.toServer).toContain(injected);
    expect(api.records(0)).toEqual([]);
    expect(api.state().armed).toBe(false);
    expect(stderrText().match(/agent connection 1 closed: .*/g)).toEqual([
      "agent connection 1 closed: it sent a frame that is not sealed",
    ]);
    expect(api.state().note ?? "").not.toMatch(/seal/);
  });

  it("closes the connection when a relay flips one bit of a sealed frame, and folds nothing from it", async () => {
    device.agentOnAttach = false;
    const api = await createInspector();
    expect(await api.ensureAttached(8081)).toBeNull();
    const url = "https://example.com/account";
    // Inside the URL, so the frame would still parse without the tag check.
    const offset = JSON.stringify({
      type: "CDP",
      payload: {
        method: "Network.requestWillBeSent",
        params: { requestId: "00000000-1", request: { url } },
      },
    }).indexOf("account");
    // Lines 0 and 1 are the hello and the proof, 2 the Network.enable reply.
    const relay = await startRelay(device.hostPort!, {
      toServer: (line, index) => [index === 3 ? flipByte(line, offset) : line],
    });
    const agent = await FakeAgent.connect(relay.port, { secret: session().secret });
    await vi.waitFor(() => expect(api.state().armed).toBe(true));

    agent.started(agent.rid(1), url);
    await agent.closed();

    expect(relay.toServer).toHaveLength(4);
    expect(api.records(0)).toEqual([]);
    expect(api.state().armed).toBe(false);
    expect(stderrText()).toContain("agent connection 1 closed: its sealed frame 1 did not verify");
  });

  it("closes the connection when a relay replays a sealed frame", async () => {
    device.agentOnAttach = false;
    const api = await createInspector();
    expect(await api.ensureAttached(8081)).toBeNull();
    const relay = await startRelay(device.hostPort!, {
      toServer: (line, index) => (index === 3 ? [line, line] : [line]),
    });
    const agent = await FakeAgent.connect(relay.port, { secret: session().secret });
    await vi.waitFor(() => expect(api.state().armed).toBe(true));

    agent.started(agent.rid(1), "https://example.com/transfer", "POST");
    await agent.closed();

    expect(relay.toServer[4]).toBe(relay.toServer[3]);
    expect(api.records(0).map((r) => r.request.url)).toEqual(["https://example.com/transfer"]);
    expect(api.state().armed).toBe(false);
    expect(stderrText()).toContain("agent connection 1 closed: its sealed frame 2 did not verify");
  });

  it.each([
    ["pid", { pid: 4723 }],
    ["startTime", { startTime: 91_001 }],
    ["instance", { instance: "ffffffff" }],
    ["lastSeq", { lastSeq: 900 }],
  ])(
    "refuses a proof frame whose %s was changed in transit",
    async (_field, change: Record<string, unknown>) => {
      device.agentOnAttach = false;
      const api = await createInspector();
      expect(await api.ensureAttached(8081)).toBeNull();
      const relay = await startRelay(device.hostPort!, {
        toServer: (line, index) => {
          if (index !== 1) return [line];
          const frame = JSON.parse(line) as { type: string; payload: Record<string, unknown> };
          return [JSON.stringify({ ...frame, payload: { ...frame.payload, ...change } })];
        },
      });

      const agent = await FakeAgent.connect(relay.port, {
        secret: session().secret,
        instance: "1a2b3c4d",
        lastSeq: 3,
      });
      await agent.closed();

      expect(agent.serverProofOk).toBe(true);
      expect(relay.toServer[1]).toContain(JSON.stringify(change).slice(1, -1));
      expect(agent.received).toEqual([]);
      expect(relay.toAgent).toHaveLength(1);
      expect(api.state().armed).toBe(false);
      expect(stderrText()).toContain(
        "closed an agent connection: its proof of the session secret did not verify"
      );
    }
  );

  it("carries a whole session sealed both ways: records, bodies, a redirect hop, a Metro port update and Network.disable", async () => {
    device.agentOnAttach = false;
    const api = await createInspector();
    expect(await api.ensureAttached(8081)).toBeNull();
    const relay = await startRelay(device.hostPort!);
    const agent = await FakeAgent.connect(relay.port, { secret: session().secret });
    await vi.waitFor(() => expect(api.state().armed).toBe(true));

    const transfer = agent.rid(1);
    agent.responseBodies.set(transfer, {
      bodyAvailable: true,
      body: '{"balance":12}',
      base64Encoded: false,
      wasTruncated: false,
    });
    agent.postData.set(transfer, {
      bodyAvailable: true,
      postData: '{"amount":5}',
      base64Encoded: false,
      wasTruncated: false,
    });
    agent.request(transfer, "https://bank.example.com/transfer", {
      method: "POST",
      hasPostData: true,
    });
    const hop = agent.rid(2);
    agent.started(hop, "http://localhost:9090/redirect");
    agent.event("Network.requestWillBeSent", {
      requestId: hop,
      request: { url: "http://localhost:9090/json", method: "GET", headers: {} },
      redirectResponse: {
        url: "http://localhost:9090/redirect",
        status: 302,
        statusText: "Found",
        headers: { Location: "/json" },
        mimeType: "",
      },
    });
    agent.event("Network.responseReceived", {
      requestId: hop,
      type: "XHR",
      response: {
        url: "http://localhost:9090/json",
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "application/json",
      },
    });
    agent.event("Network.loadingFinished", { requestId: hop, encodedDataLength: 2 });
    await vi.waitFor(() =>
      expect(api.records(8081).map((r) => r.state)).toEqual(["complete", "complete"])
    );

    const [paid, redirected] = api.records(8081);
    expect(paid).toMatchObject({
      request: { url: "https://bank.example.com/transfer", method: "POST", hasPostData: true },
      response: { status: 200 },
    });
    expect(redirected).toMatchObject({
      request: { url: "http://localhost:9090/redirect" },
      redirects: [{ url: "http://localhost:9090/redirect", status: 302 }],
      response: { url: "http://localhost:9090/json", status: 200 },
    });
    expect(await api.responseBody(paid!.id)).toMatchObject({
      available: true,
      body: '{"balance":12}',
    });
    expect(await api.requestPostData(paid!.id)).toMatchObject({
      available: true,
      body: '{"amount":5}',
    });
    expect(await api.ensureAttached(8190)).toBeNull();
    await vi.waitFor(() =>
      expect(agent.controls).toEqual([{ metroPort: 8081 }, { metroPort: 8190 }])
    );

    const closed = agent.closed();
    await instances.pop()!.dispose();
    await closed;

    expect(agent.received).toEqual([
      "Control",
      "Network.enable",
      "Network.getResponseBody",
      "Network.getRequestPostData",
      "Control",
      "Network.disable",
    ]);
    expect(agent.unopened).toBeUndefined();
    // The hello, the proof and the tool-server's answer to the hello are the only plaintext.
    expect(relay.toServer.length).toBeGreaterThan(10);
    for (const line of relay.toServer.slice(2)) expect(line).toMatch(SEALED_LINE);
    expect(relay.toAgent).toHaveLength(7);
    for (const line of relay.toAgent.slice(1)) expect(line).toMatch(SEALED_LINE);
    const wire = [...relay.toServer, ...relay.toAgent].join("\n");
    for (const text of ["bank.example.com", "balance", "amount", "metroPort", "Network."]) {
      expect(wire).not.toContain(text);
    }
  });
});

describe("the tunnel's host end", () => {
  it("runs the whole handshake over TCP on the host's 127.0.0.1, reversed from the device port", async () => {
    const servers: net.Server[] = [];
    const listen = net.Server.prototype.listen;
    vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (
      this: net.Server,
      ...args: unknown[]
    ) {
      servers.push(this);
      return (listen as (...a: unknown[]) => net.Server).apply(this, args);
    });
    const api = await armedInspector();
    const agent = agents[0]!;

    const { devicePort, hostPort } = device;
    expect(device.commands).toContain(`reverse --no-rebind tcp:${devicePort} tcp:${hostPort}`);
    expect(servers.map((server) => server.address())).toEqual([
      expect.objectContaining({ address: "127.0.0.1", port: hostPort }),
    ]);
    expect(agent.socket.remotePort).toBe(hostPort);
    expect(agent.serverProofOk).toBe(true);
    expect(agent.received.slice(0, 2)).toEqual(["Control", "Network.enable"]);
    expect(api.state()).toMatchObject({ armed: true, process: { pid: 4722, startTime: 91_000 } });
  });

  it("gives a raw TCP client that sends a hello nothing it can use, and closes it once its proof fails", async () => {
    device.agentOnAttach = false;
    const api = await createInspector();
    expect(await api.ensureAttached(8081)).toBeNull();
    const { secret } = session();

    const lines = await rawClient(device.hostPort!, {
      proof: "0".repeat(64),
      pid: 4722,
      startTime: 91_000,
      instance: "0badc0de",
      lastSeq: 0,
    });

    // The tool-server's nonce and its proof only: an HMAC that does not give the secret away.
    expect(lines).toHaveLength(1);
    const first = JSON.parse(lines[0]!) as { type: string; payload: Record<string, unknown> };
    expect(first.type).toBe("Control");
    expect(Object.keys(first.payload).sort()).toEqual(["nonce", "proof"]);
    expect(lines[0]).not.toContain(secret);
    expect(api.state().armed).toBe(false);
    expect(api.records(0)).toEqual([]);
    expect(stderrText()).toContain(
      "closed an agent connection: its proof of the session secret did not verify"
    );
  });
});

describe("AndroidNetworkInspector against a fake agent socket", () => {
  it("folds the events into records with per-start ids", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;

    agent.request(agent.rid(1), "https://httpbin.org/anything/a", { rnRequestId: 7 });
    agent.request(agent.rid(2), "https://httpbin.org/anything/b", {
      method: "POST",
      hasPostData: true,
    });
    await vi.waitFor(() =>
      expect(api.records(8081).map((r) => r.state)).toEqual(["complete", "complete"])
    );

    const [first, second] = api.records(8081);
    expect(first).toMatchObject({
      layer: "android-native",
      layerId: agent.rid(1),
      connection: 1,
      rnRequestId: 7,
      request: { url: "https://httpbin.org/anything/a", method: "GET" },
      response: {
        url: "https://httpbin.org/anything/a",
        status: 200,
        mimeType: "application/json",
      },
      resourceType: "XHR",
      encodedDataLength: 11,
      timing: { startedAt: 1_000_000, durationMs: expect.any(Number) },
    });
    expect(first!.request.headers).toEqual({
      "x-app": "probe",
      "Authorization": "Bearer secret-token",
    });
    expect(second).toMatchObject({
      layerId: agent.rid(2),
      request: { method: "POST", hasPostData: true },
    });
    expect(second!.rnRequestId).toBeUndefined();

    // android-<tag>-<n>: one tag per tool-server start.
    for (const record of [first!, second!]) expect(record.id).toMatch(ANDROID_NATIVE_REQUEST_ID);
    const tag = (id: string): string => id.split("-")[1]!;
    expect(tag(first!.id)).toBe(tag(second!.id));
    expect(ANDROID_NATIVE_REQUEST_ID.test("android-12")).toBe(false);

    // Device-independent: the id alone finds the record.
    expect(findAndroidNativeRecord(first!.id)).toEqual({ inspector: api, record: first });
    expect(findAndroidNativeRecord("android-0000-999999")).toBeUndefined();
  });

  it("folds a redirect hop into its record, with the wire headers, the hops and the final URL", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    const id = agent.rid(1);
    agent.event("Network.requestWillBeSent", {
      requestId: id,
      request: { url: "http://localhost:9090/redirect", method: "GET", headers: { "x-app": "1" } },
      wallTime: 1000,
    });
    agent.event("Network.requestWillBeSentExtraInfo", {
      requestId: id,
      headers: { "Cookie": "sid=abc123", "User-Agent": "okhttp/4.9.2", "x-app": "1" },
    });
    await vi.waitFor(() =>
      expect(api.records(8081)[0]?.request.wireHeaders).toMatchObject({ Cookie: "sid=abc123" })
    );
    agent.event("Network.requestWillBeSent", {
      requestId: id,
      request: { url: "http://localhost:9090/json", method: "GET", headers: { "x-app": "1" } },
      redirectResponse: {
        url: "http://localhost:9090/redirect",
        status: 302,
        statusText: "Found",
        headers: { Location: "/json" },
        mimeType: "",
      },
    });
    await vi.waitFor(() => expect(api.records(8081)[0]?.redirects).toHaveLength(1));
    // The previous hop's wire headers do not stand in for the next hop's.
    expect(api.records(8081)[0]!.request.wireHeaders).toBeUndefined();
    agent.event("Network.requestWillBeSentExtraInfo", {
      requestId: id,
      headers: { "Cookie": "sid=abc123", "User-Agent": "okhttp/4.9.2", "Host": "localhost:9090" },
    });
    agent.event("Network.responseReceived", {
      requestId: id,
      type: "XHR",
      response: {
        url: "http://localhost:9090/json",
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "application/json" },
        mimeType: "application/json",
        fromCache: true,
      },
    });
    agent.event("Network.loadingFinished", { requestId: id, encodedDataLength: 12 });
    await vi.waitFor(() => expect(api.records(8081)[0]?.state).toBe("complete"));

    const records = api.records(8081);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      request: {
        url: "http://localhost:9090/redirect",
        headers: { "x-app": "1" },
        wireHeaders: {
          "Cookie": "sid=abc123",
          "User-Agent": "okhttp/4.9.2",
          "Host": "localhost:9090",
        },
      },
      redirects: [
        {
          url: "http://localhost:9090/redirect",
          method: "GET",
          status: 302,
          statusText: "Found",
          headers: { Location: "/json" },
          // What went on the wire for that hop.
          requestHeaders: { "Cookie": "sid=abc123", "User-Agent": "okhttp/4.9.2", "x-app": "1" },
        },
      ],
      response: { url: "http://localhost:9090/json", status: 200, fromCache: true },
    });
  });

  it("leaves a redirect hop without request headers when the agent reported none for it", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    const id = agent.rid(1);
    agent.started(id, "http://localhost:9090/redirect");
    agent.event("Network.requestWillBeSent", {
      requestId: id,
      request: { url: "http://localhost:9090/json", method: "GET", headers: {} },
      redirectResponse: { url: "", status: 301, statusText: "", headers: {}, mimeType: "" },
    });
    await vi.waitFor(() => expect(api.records(8081)[0]?.redirects).toHaveLength(1));
    expect(api.records(8081)[0]!.redirects![0]).not.toHaveProperty("requestHeaders");
  });

  it("applies the Network.enable reply before the frames that follow it in the same chunk", async () => {
    device.agentOptions = {
      capture: { state: "waiting" },
      withEnableReply: (agent) => [
        {
          type: "CDP",
          payload: {
            method: "Network.requestWillBeSent",
            params: {
              requestId: agent.rid(1),
              request: { url: "https://example.com/live", method: "GET", headers: {} },
              wallTime: 1000,
            },
          },
        },
        { type: "Status", payload: { event: "capture", state: "active" } },
      ],
    };
    const api = await armedInspector();
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));

    // The reply's in-flight list predates the request, and its capture state the status.
    expect(api.records(8081)[0]).toMatchObject({ state: "pending" });
    expect(api.records(8081)[0]).not.toHaveProperty("errorText");
    expect(api.state().capture).toEqual({ state: "active" });
  });

  it("reports the capture state of the live connection only", async () => {
    device.agentOptions = {
      capture: { state: "waiting", detail: "the app has not loaded OkHttp yet" },
    };
    const api = await armedInspector();
    const agent = agents[0]!;
    expect(api.state().capture).toEqual({
      state: "waiting",
      detail: "the app has not loaded OkHttp yet",
    });

    agent.send({ type: "Status", payload: { event: "an_event_of_another_kind" } });
    agent.send({ type: "Status", payload: { event: "capture", state: "active" } });
    await vi.waitFor(() => expect(api.state().capture).toEqual({ state: "active" }));
    agent.send({
      type: "Status",
      payload: { event: "capture", state: "unavailable", detail: "no OkHttp in this process" },
    });
    await vi.waitFor(() =>
      expect(api.state().capture).toEqual({
        state: "unavailable",
        detail: "no OkHttp in this process",
      })
    );

    await agent.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));
    expect(api.state()).not.toHaveProperty("process");
    expect(api.state()).not.toHaveProperty("capture");
  });

  it("fetches a body and post data once per record, through the CDP writer", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    const id = agent.rid(1);
    agent.responseBodies.set(id, {
      bodyAvailable: true,
      body: Buffer.from('{"ok":true}').toString("base64"),
      base64Encoded: true,
      wasTruncated: false,
    });
    agent.postData.set(id, {
      bodyAvailable: true,
      postData: '{"via":"xhr"}',
      base64Encoded: false,
      wasTruncated: false,
    });
    agent.request(id, "https://httpbin.org/anything/b", { method: "POST", hasPostData: true });
    await vi.waitFor(() => expect(api.records(8081)[0]?.state).toBe("complete"));
    const record = api.records(8081)[0]!.id;

    const body = await api.responseBody(record);
    expect(body).toMatchObject({ available: true, base64Encoded: true, truncated: false });
    expect(Buffer.from(body.body, "base64").toString()).toBe('{"ok":true}');
    expect(await api.requestPostData(record)).toMatchObject({
      available: true,
      body: '{"via":"xhr"}',
      base64Encoded: false,
    });

    await api.responseBody(record);
    await api.requestPostData(record);
    const asked = agent.requests.map((r) => `${r.method} ${String(r.params?.requestId ?? "")}`);
    expect(asked).toEqual([
      "Network.enable ",
      `Network.getResponseBody ${id}`,
      `Network.getRequestPostData ${id}`,
    ]);
  });

  it("does not cache a missing post-data answer for a pending request", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    const id = agent.rid(1);
    agent.event("Network.requestWillBeSent", {
      requestId: id,
      request: {
        url: "https://example.com/upload",
        method: "POST",
        headers: {},
        hasPostData: true,
      },
      timestamp: 1000,
      wallTime: 1000,
    });
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));
    const record = api.records(8081)[0]!.id;

    expect(await api.requestPostData(record)).toMatchObject({
      available: false,
      reason: "no request body was returned yet; this answer is not cached, so read it again later",
    });

    agent.postData.set(id, {
      bodyAvailable: true,
      postData: "payload",
      base64Encoded: false,
      wasTruncated: false,
    });
    agent.event("Network.responseReceived", {
      requestId: id,
      type: "Other",
      response: {
        url: "https://example.com/upload",
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "text/plain",
      },
    });
    agent.event("Network.loadingFinished", { requestId: id, encodedDataLength: 2 });
    await vi.waitFor(() => expect(api.records(8081)[0]?.state).toBe("complete"));

    expect(await api.requestPostData(record)).toMatchObject({ available: true, body: "payload" });
    await api.requestPostData(record);
    expect(agent.requests.filter((r) => r.method === "Network.getRequestPostData")).toHaveLength(2);
  });

  it("bounds record memory by size, evicting the oldest, and caps an absurd value", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    const big = (prefix: string): Record<string, string> =>
      Object.fromEntries([0, 1, 2].map((i) => [`${prefix}-${i}`, "v".repeat(70_000)]));
    const sent = 70;
    for (let i = 1; i <= sent; i++) {
      agent.event("Network.requestWillBeSent", {
        requestId: agent.rid(i),
        request: { url: `https://example.com/${i}`, method: "GET", headers: big("req") },
        wallTime: 1000,
      });
      agent.event("Network.requestWillBeSentExtraInfo", {
        requestId: agent.rid(i),
        headers: big("wire"),
      });
      agent.event("Network.responseReceived", {
        requestId: agent.rid(i),
        response: { url: "", status: 200, statusText: "OK", headers: big("res"), mimeType: "" },
      });
    }
    agent.event("Network.requestWillBeSent", {
      requestId: agent.rid(sent + 1),
      request: {
        url: `https://example.com/${"x".repeat(100_000)}`,
        method: "GET",
        headers: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`h${i}`, "1"])),
      },
      wallTime: 1000,
    });
    await vi.waitFor(
      () =>
        expect(api.records(0).at(-1)?.request.url.startsWith("https://example.com/xxx")).toBe(true),
      { timeout: 10_000 }
    );

    const kept = api.records(0);
    const chars = (map: Record<string, string> | undefined): number =>
      Object.entries(map ?? {}).reduce((n, [k, v]) => n + k.length + v.length, 0);
    const total = kept.reduce(
      (n, r) =>
        n +
        r.request.url.length +
        chars(r.request.headers) +
        chars(r.request.wireHeaders) +
        chars(r.response?.headers),
      0
    );
    expect(kept.length).toBeLessThan(sent + 1);
    expect(kept[0]!.request.url).not.toBe("https://example.com/1");
    expect(total).toBeLessThanOrEqual(32 * 1024 * 1024);
    // Every value is capped, and a value past the cap says how much was left out.
    expect(kept[0]!.request.headers["req-0"]).toBe(`${"v".repeat(65_536)}…[4464 more chars]`);

    const absurd = kept.at(-1)!;
    expect(absurd.request.url.length).toBeLessThan(65_600);
    expect(absurd.request.url).toMatch(/…\[\d+ more chars\]$/);
    expect(Object.keys(absurd.request.headers)).toHaveLength(257);
    expect(absurd.request.headers["(not kept)"]).toBe("44 more headers");
  }, 20_000);
});

describe("the gates before an attach", () => {
  it("returns not_attachable, naming the JS layer, when the build is not debuggable", async () => {
    device.runAsError = `run-as: package not debuggable: ${PKG}`;
    const api = await createInspector();

    expect(await api.ensureAttached(8081)).toEqual({
      status: "not_attachable",
      reason: expect.stringContaining(`package not debuggable: ${PKG}`),
      fallback: expect.stringContaining("view-network-logs"),
    });
    expect(device.commands.some((c) => c.includes(" push "))).toBe(false);
    expect(attachCommands()).toEqual([]);
  });

  it("returns not_attachable for a system package run-as cannot reach", async () => {
    device.runAsError = `run-as: package not an application: ${PKG}`;
    const api = await createInspector();
    expect(await api.ensureAttached(8081)).toMatchObject({
      status: "not_attachable",
      reason: expect.stringContaining("system package"),
    });
  });

  it("fails naming the package, user and device for an unknown package, rather than blaming the build", async () => {
    device.runAsError = `run-as: unknown package: ${PKG}`;
    const api = await createInspector();

    const err = await api.ensureAttached(8081).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(FailureError);
    expect((err as Error).message).toContain(
      `${PKG} is not installed for Android user 0 on ${SERIAL}`
    );
    expect((err as Error).message).not.toContain("debuggable");
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.ANDROID_NETWORK_INSPECTOR_UNKNOWN_PACKAGE
    );
  });

  it.each([
    `run-as: couldn't stat /data/user/10/${PKG}: No such file or directory`,
    "run-as: couldn't stat /data/user/10: No such file or directory",
  ])(
    "fails as an app not installed for the Android user, naming it, when run-as says %s",
    async (detail) => {
      device.user = 10;
      device.runAsError = detail;
      const api = await createInspector();

      const err = await api.ensureAttached(8081).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.ANDROID_NETWORK_INSPECTOR_UNKNOWN_PACKAGE
      );
      expect((err as Error).message).toContain(
        `${PKG} is not installed for Android user 10 on ${SERIAL}`
      );
      expect((err as Error).message).not.toContain("try again");
    }
  );

  it("fails with adb's own detail when run-as times out, and a later call can still attach", async () => {
    device.runAsError = new FailureError(
      `adb -s ${SERIAL} shell run-as '${PKG}' id failed: Command failed: adb (killed=true signal=SIGKILL)`,
      {
        error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
        failure_stage: "android_adb_command",
        failure_area: "tool_server",
        error_kind: "timeout",
      }
    );
    const api = await createInspector();

    const err = await api.ensureAttached(8081).then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as Error).message).toContain("killed=true signal=SIGKILL");
    expect((err as Error).message).toContain("says nothing about the build");
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.ANDROID_NETWORK_INSPECTOR_RUN_AS_FAILED,
      error_kind: "timeout",
    });

    device.runAsError = undefined;
    expect(await api.ensureAttached(8081)).toBeNull();
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
  });

  it("returns not_attachable once a non-debuggable build replaced an attached app", async () => {
    const api = await armedInspector();
    device.runAsError = `run-as: package not debuggable: ${PKG}`;
    device.process = { pid: 5100, startTime: 99_000 };

    expect(await api.ensureAttached(8081)).toMatchObject({
      status: "not_attachable",
      reason: expect.stringContaining("package not debuggable"),
    });
    expect(attachCommands()).toHaveLength(1);
  });

  it("returns not_attachable below Android 8.0", async () => {
    device.sdk = 25;
    const api = await createInspector();

    expect(await api.ensureAttached(8081)).toMatchObject({
      status: "not_attachable",
      reason: expect.stringContaining("API 25"),
    });
    expect(device.commands).toHaveLength(1);
    expect(device.commands[0]).toMatch(/^echo "sdk=/);
  });

  it("returns not_attachable for an arm app under ARM translation on an x86_64 device", async () => {
    device.machine = "x86_64";
    device.abi = "arm64-v8a";
    const api = await createInspector();

    expect(await api.ensureAttached(8081)).toMatchObject({
      status: "not_attachable",
      reason: expect.stringContaining("under ARM translation on this x86_64 device"),
    });
    expect(device.commands.some((c) => c.includes(" push "))).toBe(false);
  });

  it("attaches an x86_64 app on an x86_64 device", async () => {
    device.machine = "x86_64";
    device.abi = "x86_64";
    await armedInspector();
  });

  it("returns the missing-binaries result, without throwing or touching the device, when bin/network-inspector/ is absent", async () => {
    fs.rmSync(path.join(binRoot, "network-inspector"), { recursive: true, force: true });
    const api = await createInspector();

    await expect(api.ensureAttached(8081)).resolves.toEqual({
      status: "not_attachable",
      reason: AGENT_BINARIES_MISSING_REASON,
      fallback: expect.stringContaining("view-network-logs"),
    });
    expect(device.commands).toEqual([]);
  });

  it("falls back to the device ABI when the app has no native libraries, and refuses an ABI it ships no agent for", async () => {
    device.abi = "null";
    await armedInspector();
    expect(device.commands).toContain("getprop ro.product.cpu.abi");
    expect(device.commands.some((c) => c.includes("/x86_64/libjvmti_network_inspector.so"))).toBe(
      true
    );

    device.abi = "armeabi-v7a";
    const api32 = await createInspector(8081, OTHER);
    expect(await api32.ensureAttached(8081)).toMatchObject({
      status: "not_attachable",
      reason: expect.stringContaining("runs as armeabi-v7a"),
    });
  });

  it("attaches to the current user's process, with run-as --user and that user's files", async () => {
    device.user = 10;
    device.profileProcess = { pid: 4100, startTime: 80_000 };
    const api = await armedInspector();

    expect(device.commands).toContain(`run-as '${PKG}' --user 10 id`);
    expect(attachScripts()[0]).toMatch(new RegExp(`^run-as '${PKG}' --user 10 sh -c `));
    expect(attachScripts()[0]).toContain(`mkdir -p ${dirFor(PKG, 10)}`);
    expect(attachCommands()).toEqual([
      `cmd activity attach-agent 4722 '${dirFor(PKG, 10)}/libjvmti_network_inspector.so=jar=${dirFor(PKG, 10)}/network-inspector.jar,pkg=${PKG}'`,
    ]);
    expect(api.state().process).toEqual({ pid: 4722, startTime: 91_000 });
    expect(device.commands.some((c) => c.includes("/proc/4100/"))).toBe(false);
  });

  it("attaches to the app's user 0 process when pidof lists a work profile copy first", async () => {
    device.profileProcess = { pid: 4100, startTime: 80_000 };
    const api = await armedInspector();

    expect(attachCommands()).toHaveLength(1);
    expect(attachCommands()[0]).toContain("attach-agent 4722 ");
    expect(api.state().process).toEqual({ pid: 4722, startTime: 91_000 });
    expect(device.commands.some((c) => c.includes("/proc/4100/"))).toBe(false);
    expect(device.commands.some((c) => c.includes("--user"))).toBe(false);
  });
});

describe("a switch of the foreground Android user", () => {
  const USER_10_PROCESS = { pid: 5300, startTime: 120_000 };

  /** `am switch-user 10`: user 0's process keeps running, and user 10 runs its own. */
  function switchToUser10(): void {
    device.user = 10;
    device.profileProcess = { ...proc() };
    device.process = { ...USER_10_PROCESS };
  }

  it.each([
    ["a native-network-logs call", (api: AndroidNetworkInspectorApi) => api.ensureAttached(8081)],
    ["a launch", () => attachAndroidNetworkInspectorToLaunch(SERIAL, PKG)],
  ])(
    "is followed by %s: user 10's process, run-as --user 10 and user 10's files, and dispose removes both users' sessions",
    async (_, trigger) => {
      const api = await armedInspector();
      const { secret } = session();
      switchToUser10();
      const before = device.commands.length;

      await trigger(api);

      expect(attachCommands()).toEqual([
        `cmd activity attach-agent 4722 '${dirFor()}/libjvmti_network_inspector.so=jar=${dirFor()}/network-inspector.jar,pkg=${PKG}'`,
        `cmd activity attach-agent 5300 '${dirFor(PKG, 10)}/libjvmti_network_inspector.so=jar=${dirFor(PKG, 10)}/network-inspector.jar,pkg=${PKG}'`,
      ]);
      const after = device.commands.slice(before);
      expect(after).toContain(`run-as '${PKG}' --user 10 id`);
      expect(attachScripts().at(-1)).toMatch(new RegExp(`^run-as '${PKG}' --user 10 sh -c `));
      expect(attachScripts().at(-1)).toContain(`mkdir -p ${dirFor(PKG, 10)}`);
      // The user is read in the same adb round trip as the processes, never on its own.
      const userReads = after.filter((c) => c.includes("am get-current-user"));
      expect(userReads.length).toBeGreaterThan(0);
      expect(after.filter((c) => c.includes("for p in $(pidof"))).toEqual(userReads);
      await vi.waitFor(() => expect(api.state().process).toEqual(USER_10_PROCESS));
      expect(session(dirFor(PKG, 10))).toEqual({ v: 2, port: device.devicePort, secret });
      expect(session().secret).toBe(secret);

      await instances.pop()!.dispose();

      expect(device.files.has(dirFor())).toBe(false);
      expect(device.files.has(dirFor(PKG, 10))).toBe(false);
      const removals = device.commands.filter((c) => c.includes("IFS= read -r s"));
      expect(removals.map((c) => c.slice(0, c.indexOf(" sh -c ")))).toEqual(
        expect.arrayContaining([`run-as '${PKG}'`, `run-as '${PKG}' --user 10`])
      );
      expect(removals).toHaveLength(2);
    }
  );

  it("says the app is not installed for the user now in the foreground, and keeps listing what it captured", async () => {
    const api = await armedInspector();
    agents[0]!.request(agents[0]!.rid(1), "https://example.com/before-the-switch");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));
    switchToUser10();
    device.process = null;
    device.runAsError = `run-as: couldn't stat /data/user/10/${PKG}: No such file or directory`;

    expect(await api.ensureAttached(8081)).toEqual({
      status: "ok",
      note: expect.stringContaining(`${PKG} is not installed for Android user 10 on ${SERIAL}`),
    });
    expect(await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG)).toContain(
      `${PKG} is not installed for Android user 10 on ${SERIAL}`
    );
    expect(attachCommands()).toHaveLength(1);
    expect(api.records(8081).map((r) => r.request.url)).toEqual([
      "https://example.com/before-the-switch",
    ]);
    expect(device.files.has(dirFor(PKG, 10))).toBe(false);
  });

  it("says user 10 is in the foreground once user 0's process ended, and the next call attaches to user 10's", async () => {
    const api = await armedInspector();
    switchToUser10();
    // `am force-stop --user 0`.
    device.profileProcess = undefined;
    await agents[0]!.close();

    await vi.waitFor(
      () =>
        expect(api.state().note).toBe(
          `Android user 10 is in the foreground now; launch-app, restart-app or the next native-network-logs call attaches the agent to that user's process of ${PKG}`
        ),
      { timeout: 3_000 }
    );
    expect(attachCommands()).toHaveLength(1);

    expect(await api.ensureAttached(8081)).toBeNull();
    expect(attachCommands()[1]).toContain(`attach-agent 5300 '${dirFor(PKG, 10)}/`);
    await vi.waitFor(() =>
      expect(api.state()).toMatchObject({ armed: true, process: USER_10_PROCESS })
    );
  });

  it("stays on its user when the device does not say which user is in the foreground", async () => {
    device.user = 10;
    const api = await armedInspector();
    device.foregroundUnknown = true;
    const before = device.commands.length;

    device.process = { pid: 5400, startTime: 130_000 };
    expect(await api.ensureAttached(8081)).toBeNull();

    expect(device.commands.slice(before)).not.toContain(`run-as '${PKG}' id`);
    expect(attachCommands()[1]).toContain(`attach-agent 5400 '${dirFor(PKG, 10)}/`);
  });
});

describe("device identity", () => {
  it("keys one inspector for an ext: id and its adb serial, and a scoped stop matches either", async () => {
    const ext = `ext:acme-1:${SERIAL}`;
    const viaExt = androidNetworkInspectorRef({ ...DEVICE, id: ext }, PKG, 8081);
    const viaSerial = androidNetworkInspectorRef(DEVICE, PKG, 8190);
    expect(viaExt.urn).toBe(viaSerial.urn);
    expect(viaExt.urn).toBe(`AndroidNetworkInspector:${SERIAL}:${PKG}`);
    expect(deviceIdOwningUrn(viaExt.urn, DEVICE_OWNED_NAMESPACES, [ext])).toBe(ext);
    expect(deviceIdOwningUrn(viaExt.urn, DEVICE_OWNED_NAMESPACES, [SERIAL])).toBe(SERIAL);
    expect(
      deviceIdOwningUrn(viaExt.urn, DEVICE_OWNED_NAMESPACES, ["ext:acme-1:emulator-5556"])
    ).toBeUndefined();

    await createInspector(8081, PKG, { ...DEVICE, id: ext });
    expect(await instances[0]!.api.ensureAttached(8081)).toBeNull();
    // adb is driven with the serial behind the ext: id.
    expect(vi.mocked(adbShell).mock.calls.every((call) => call[0] === SERIAL)).toBe(true);
    await vi.waitFor(() => expect(liveAndroidNetworkCaptures(SERIAL)).toEqual([PKG]));
    expect(liveAndroidNetworkCaptures(ext)).toEqual([PKG]);
    // Looked up by app, the device is named by its adb serial.
    expect(liveAndroidNetworkCaptureDevices(PKG)).toEqual([SERIAL]);
    expect(liveAndroidNetworkCaptureDevices(OTHER)).toEqual([]);
  });

  it("refuses a second adb serial of the same device for the same app, naming the serial in use", async () => {
    device.identity.set("R58M123", { serialNo: "R58M123", bootId: "boot-phone" });
    device.identity.set("192.168.1.5:5555", { serialNo: "R58M123", bootId: "boot-phone" });
    const usb = { id: "R58M123", platform: "android" as const, kind: "device" as const };
    const wifi = { id: "192.168.1.5:5555", platform: "android" as const, kind: "device" as const };
    expect(await (await createInspector(8081, PKG, usb)).ensureAttached(8081)).toBeNull();

    const err = await (await createInspector(8081, PKG, wifi)).ensureAttached(8081).then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as Error).message).toContain("already inspected through adb serial R58M123");
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.ANDROID_NETWORK_INSPECTOR_DEVICE_IN_USE
    );

    // Another app on the same device is not refused.
    device.processes.set(OTHER, { pid: 6100, startTime: 70_000 });
    expect(await (await createInspector(8081, OTHER, wifi)).ensureAttached(8081)).toBeNull();
  });

  it("still refuses a second serial of a phone that rebooted in between, keyed by ro.serialno alone", async () => {
    device.identity.set("R58M123", { serialNo: "R58M123", bootId: "boot-before" });
    device.identity.set("192.168.1.5:5555", { serialNo: "R58M123", bootId: "boot-after" });
    const usb = { id: "R58M123", platform: "android" as const, kind: "device" as const };
    const wifi = { id: "192.168.1.5:5555", platform: "android" as const, kind: "device" as const };
    expect(await (await createInspector(8081, PKG, usb)).ensureAttached(8081)).toBeNull();

    const err = await (await createInspector(8081, PKG, wifi)).ensureAttached(8081).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.ANDROID_NETWORK_INSPECTOR_DEVICE_IN_USE
    );
    const facts = device.commands.find((c) => c.startsWith('echo "sdk='))!;
    expect(facts).not.toContain("boot_id");
  });

  it("does not compare emulators, which share one ro.serialno and, resumed from one snapshot, one boot id", async () => {
    const same = { serialNo: "EMULATOR36X1X9X0", bootId: "boot-a", qemu: true };
    device.identity.set("emulator-5554", same);
    device.identity.set("emulator-5558", same);
    // An emulator reached over TCP says so through its qemu properties.
    device.identity.set("127.0.0.1:5565", same);
    expect(await (await createInspector()).ensureAttached(8081)).toBeNull();
    for (const id of ["emulator-5558", "127.0.0.1:5565"]) {
      const other = await createInspector(8081, PKG, { id, platform: "android", kind: "emulator" });
      expect(await other.ensureAttached(8081)).toBeNull();
    }
    const facts = device.commands.find((c) => c.startsWith('echo "sdk='))!;
    expect(facts).toContain("getprop ro.kernel.qemu");
    expect(facts).toContain("getprop ro.boot.qemu");
  });
});

describe("attaching and the app's lifecycle", () => {
  it("keeps serving an attached agent after bin/network-inspector/ goes away", async () => {
    const api = await armedInspector();
    agents[0]!.request(agents[0]!.rid(1), "https://example.com/kept");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));

    fs.rmSync(path.join(binRoot, "network-inspector"), { recursive: true, force: true });

    expect(await api.ensureAttached(8081)).toBeNull();
    expect(api.records(8081).map((r) => r.request.url)).toEqual(["https://example.com/kept"]);
  });

  it("pushes the agent for the app's ABI, binds a random free device port, and takes everything back on dispose", async () => {
    device.abi = "x86_64";
    const api = await armedInspector();
    const pushes = device.commands.filter((c) => c.startsWith("-s"));
    expect(pushes).toEqual([
      `-s ${SERIAL} push ${path.join(binRoot, "network-inspector", "network-inspector.jar")} /data/local/tmp/.argent-inspector/network-inspector.jar`,
      `-s ${SERIAL} push ${path.join(binRoot, "network-inspector", "x86_64", "libjvmti_network_inspector.so")} /data/local/tmp/.argent-inspector/libjvmti_network_inspector.so`,
    ]);
    const { devicePort, hostPort } = device;
    expect(device.commands).toContain(`reverse --no-rebind tcp:${devicePort} tcp:${hostPort}`);
    expect(devicePort).toBeGreaterThanOrEqual(20_000);
    expect(devicePort).toBeLessThan(30_000);
    expect(api.state().armed).toBe(true);
    const agent = agents[0]!;
    const { secret } = session();

    await instances.pop()!.dispose();

    // Network.disable before the socket closes, then the session and the reverse go.
    expect(agent.received).toContain("Network.disable");
    await agent.closed();
    expect(device.files.has(dirFor())).toBe(false);
    expect(device.inputs.at(-1)).toBe(`${secret}\n`);
    expect(device.commands).toContain(`reverse --remove tcp:${devicePort}`);
    await expect(FakeAgent.connect(hostPort!, { secret: "" })).rejects.toThrow(/ECONNREFUSED/);
  });

  it("binds another device port when the first ones are taken", async () => {
    device.takenBinds = 2;
    await armedInspector();
    const binds = device.commands.filter((c) => c.startsWith("reverse --no-rebind"));
    expect(binds).toHaveLength(3);
    expect(session().port).toBe(device.devicePort);
  });

  it("removes the session at dispose only while the file still holds its secret", async () => {
    await armedInspector();
    const other = JSON.stringify({ v: 2, port: 21_000, secret: "f".repeat(64) });
    device.files.set(dirFor(), other);

    await instances.pop()!.dispose();

    expect(device.files.get(dirFor())).toBe(other);
  });

  it("hands the agent already in the app to a later inspector through a new session", async () => {
    await armedInspector();
    const first = session();
    await instances.pop()!.dispose();
    expect(device.files.has(dirFor())).toBe(false);

    const api = await createInspector();
    expect(await api.ensureAttached(8081)).toBeNull();
    expect(attachCommands()).toHaveLength(1);
    // True whether the loaded agent is this Argent's (it connects) or an
    // earlier one's (it dials a port of its own and never does).
    expect(api.state().note).toBe(
      "pid 4722 already has the agent loaded, and it should connect within a few seconds; if it does not, that agent is from an earlier Argent, and restart-app gives the app a process with the current one"
    );
    const next = session();
    expect(next.secret).not.toBe(first.secret);

    // An agent still holding the first session cannot take the new one's connection.
    const stale = await FakeAgent.connect(device.reverses.get(next.port)!, {
      secret: first.secret,
    });
    await stale.closed();
    expect(api.state().armed).toBe(false);

    await FakeAgent.fromSession(dirFor(), proc());
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
  });

  it("writes the session but does not attach into a process that already has the agent loaded", async () => {
    device.loaded.add("4722:91000");
    device.agentOnAttach = false;
    const api = await createInspector();

    expect(await api.ensureAttached(8081)).toBeNull();
    expect(attachCommands()).toEqual([]);
    expect(attachScripts()[0]).toContain(
      "if grep -q libjvmti_network_inspector.so /proc/4722/maps; then echo loaded;"
    );
    expect(session().secret).toMatch(SECRET_SHAPE);

    await FakeAgent.fromSession(dirFor(), proc());
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
  });

  it("writes the session owner-only, then copies the agent under code_cache and chmods it, before the attach", async () => {
    await armedInspector();
    const copyAt = device.commands.findIndex((c) => c.startsWith(`run-as '${PKG}' sh -c`));
    const attachAt = device.commands.findIndex((c) => c.startsWith("cmd activity attach-agent"));
    expect(copyAt).toBeGreaterThanOrEqual(0);
    expect(copyAt).toBeLessThan(attachAt);

    const copy = device.commands[copyAt]!;
    const dir = dirFor();
    expect(dir).toBe(`/data/user/0/${PKG}/code_cache/.argent-inspector`);
    const steps = [
      "umask 077",
      `mkdir -p ${dir}`,
      `cat > ${dir}/session.tmp`,
      `mv -f ${dir}/session.tmp ${dir}/session`,
      `grep -q libjvmti_network_inspector.so /proc/4722/maps`,
      `cp /data/local/tmp/.argent-inspector/network-inspector.jar ${dir}/network-inspector.jar`,
      `cp /data/local/tmp/.argent-inspector/libjvmti_network_inspector.so ${dir}/libjvmti_network_inspector.so`,
      `chmod 444 ${dir}/network-inspector.jar`,
      `chmod 555 ${dir}/libjvmti_network_inspector.so`,
    ].map((step) => copy.indexOf(step));
    expect(steps.every((at) => at >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  it("attaches once per (pid, start time): the same process never twice, a reused pid with a new start time again", async () => {
    const api = await armedInspector();
    expect(await api.ensureAttached(8081)).toBeNull();
    expect(await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG)).toContain(
      `native network capture is attached to ${PKG} (pid 4722)`
    );
    expect(attachCommands()).toHaveLength(1);

    device.process = { pid: 4722, startTime: 95_000 };
    await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG);
    expect(attachCommands()).toHaveLength(2);
    expect(attachCommands()[1]).toContain("attach-agent 4722 ");

    await api.ensureAttached(8081);
    await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG);
    expect(attachCommands()).toHaveLength(2);
  });

  it("does not attach from a launch until native-network-logs set capture up", async () => {
    await createInspector();
    expect(await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG)).toBeUndefined();
    expect(device.commands).toEqual([]);
    expect(liveAndroidNetworkCaptures(SERIAL)).toEqual([]);
  });

  it("waits for the agent of the launched process, and says capture is attached", async () => {
    await armedInspector();
    device.process = { pid: 5300, startTime: 130_000 };
    await agents[0]!.close();

    const note = await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG);

    expect(note).toBe(
      `native network capture is attached to ${PKG} (pid 5300); native-network-logs with stop: true ends it`
    );
  });

  it("does not wait for an agent when the launched process never appeared", async () => {
    await armedInspector();
    await agents[0]!.close();
    device.process = null;

    const started = performance.now();
    const note = await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG);

    expect(performance.now() - started).toBeLessThan(4_500);
    expect(note).toContain("no process of it appeared within 3 s");
    expect(attachCommands()).toHaveLength(1);
  });

  it("does not wait for an agent when the copy into the launched process failed", async () => {
    await armedInspector();
    await agents[0]!.close();
    device.process = { pid: 5310, startTime: 131_000 };
    device.stagingLost = true;

    const started = performance.now();
    const note = await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG);

    expect(performance.now() - started).toBeLessThan(1_500);
    expect(note).toContain(`could not follow this launch: copying the agent into ${PKG} failed`);
    expect(attachCommands()).toHaveLength(1);
  }, 10_000);

  it("stops waiting once the launched process exits", async () => {
    await armedInspector();
    await agents[0]!.close();
    device.agentOnAttach = false;
    device.process = { pid: 5320, startTime: 132_000 };
    device.onAttach = () => {
      device.process = null;
    };

    const started = performance.now();
    const note = await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG);

    expect(performance.now() - started).toBeLessThan(2_000);
    expect(note).toContain("the agent has not connected yet");
    expect(attachCommands()).toHaveLength(2);
  });

  it("forgets a pid whose attach-agent failed, says so, and the next call attaches it", async () => {
    const api = await armedInspector();
    await agents[0]!.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));
    device.process = { pid: 5600, startTime: 160_000 };
    device.attachError =
      "Exception occurred while executing 'attach-agent':\njava.lang.IllegalArgumentException: Unknown process: 5600\n\tat com.android.server.am.ActivityManagerService.attachAgent(ActivityManagerService.java:18801)";

    expect(await api.ensureAttached(8081)).toBeNull();
    expect(api.state().note).toBe(
      "attach-agent failed for pid 5600 (Unknown process: 5600); the next native-network-logs call or launch tries again"
    );

    device.attachError = undefined;
    expect(await api.ensureAttached(8081)).toBeNull();
    expect(attachCommands().filter((c) => c.includes("attach-agent 5600 "))).toHaveLength(2);
    await vi.waitFor(() =>
      expect(api.state()).toMatchObject({ armed: true, process: { pid: 5600 } })
    );
  });

  it("puts its reverse back when a reboot dropped it, so the agent in the next process connects", async () => {
    const api = await armedInspector();
    device.reverses.clear();
    device.process = { pid: 5200, startTime: 120_000 };
    await agents[0]!.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    expect(await api.ensureAttached(8081)).toBeNull();

    expect(device.reverses.get(device.devicePort!)).toEqual(device.hostPort);
    expect(attachCommands()).toHaveLength(2);
    await vi.waitFor(() =>
      expect(api.state()).toMatchObject({ armed: true, process: { pid: 5200 } })
    );
  });

  it("puts its reverse back before restart-app attaches, as when another tool-server removed it", async () => {
    const api = await armedInspector();
    device.reverses.clear();
    device.process = { pid: 5300, startTime: 130_000 };
    await agents[0]!.close();

    await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG);

    expect(api.state()).toMatchObject({ armed: true, process: { pid: 5300 } });
  });

  it("pushes the agent files again once the device lost them, and the next call attaches", async () => {
    const api = await armedInspector();
    device.stagingLost = true;
    device.process = { pid: 5400, startTime: 140_000 };
    await agents[0]!.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    expect(await api.ensureAttached(8081)).toBeNull();
    expect(api.state().note).toContain("No such file or directory");
    expect(await api.ensureAttached(8081)).toBeNull();

    expect(device.commands.filter((c) => c.includes(" push "))).toHaveLength(4);
    expect(attachCommands()).toHaveLength(2);
    await vi.waitFor(() =>
      expect(api.state()).toMatchObject({ armed: true, process: { pid: 5400 } })
    );
  });

  it("lists the records in memory with a note when adb does not answer", async () => {
    const api = await armedInspector();
    agents[0]!.request(agents[0]!.rid(1), "https://example.com/kept");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));
    device.adbDown = true;

    const listed = (await nativeNetworkLogsTool.execute!(
      { androidNetwork: api },
      { udid: SERIAL, bundleId: PKG, limit: 50, clear: false }
    )) as { status: string; total: number; header: string };

    expect(listed).toMatchObject({ status: "ok", total: 1 });
    expect(listed.header).toContain("adb did not answer (device offline)");
  });

  it("fails while adb does not answer before capture was ever set up", async () => {
    device.adbDown = true;
    const api = await createInspector();
    await expect(api.ensureAttached(8081)).rejects.toThrow(/device offline/);
  });

  it("gives each of two concurrent listings its own note that adb did not answer", async () => {
    const api = await armedInspector();
    device.adbDown = true;
    device.reverseGate = () => new Promise((resolve) => setTimeout(resolve, 20));
    const list = (): Promise<{ header: string }> =>
      nativeNetworkLogsTool.execute!(
        { androidNetwork: api },
        { udid: SERIAL, bundleId: PKG, limit: 50, clear: false }
      ) as Promise<{ header: string }>;

    const [first, second] = await Promise.all([list(), list()]);

    expect(first.header).toContain("adb did not answer (device offline)");
    expect(second.header).toContain("adb did not answer (device offline)");
    // A later call that reaches the device says nothing about adb.
    device.adbDown = false;
    expect((await list()).header).not.toContain("adb");
  });

  it("does not turn capture on when its first call fails: no launch attaches and nothing reports it live", async () => {
    device.pidofFailures = 1;
    const api = await createInspector();

    await expect(api.ensureAttached(8081)).rejects.toThrow(/error: closed/);

    expect(liveAndroidNetworkCaptures(SERIAL)).toEqual([]);
    expect(await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG)).toBeUndefined();
    expect(attachCommands()).toEqual([]);
    // The next call that goes through turns it on.
    expect(await api.ensureAttached(8081)).toBeNull();
    expect(liveAndroidNetworkCaptures(SERIAL)).toEqual([PKG]);
  });

  it("keeps the stopped note when it is stopped while attach-agent runs", async () => {
    device.agentOnAttach = false;
    const hold = holdOnce();
    device.attachGate = hold.gate;
    const api = await createInspector();
    const instance = instances.pop()!;
    const call = api.ensureAttached(8081);
    await vi.waitFor(() => expect(attachCommands()).toHaveLength(1));

    await instance.dispose();
    hold.release();

    expect(await call).toBeNull();
    expect(api.state()).toEqual({ armed: false, note: "native network capture was stopped" });
  });

  it("reads as stopped, not armed, from the start of a stop, before the agent answers Network.disable", async () => {
    device.agentOptions = { unanswered: ["Network.disable"] };
    const hold = holdOnce();
    const api = await armedInspector();
    expect(api.state()).toMatchObject({ armed: true, capture: { state: "active" } });
    const instance = instances.pop()!;
    let held = false;
    device.reverseGate = () => {
      held = true;
      return hold.gate();
    };
    // A listing on its way when the stop comes reads the state after it.
    const listing = api.ensureAttached(8081);
    await vi.waitFor(() => expect(held).toBe(true));

    const stopping = instance.dispose();
    await vi.waitFor(() => expect(agents[0]!.received).toContain("Network.disable"));
    hold.release();

    expect(await listing).toBeNull();
    expect(api.state()).toEqual({ armed: false, note: "native network capture was stopped" });
    await stopping;
    expect(api.state()).toEqual({ armed: false, note: "native network capture was stopped" });
  });

  it("removes its session when it is stopped while a copy that then fails is on its way", async () => {
    const hold = holdOnce();
    device.sessionWriteGate = hold.gate;
    const api = await createInspector();
    const instance = instances.pop()!;
    const call = api.ensureAttached(8081);
    await vi.waitFor(() => expect(attachScripts()).toHaveLength(1));
    device.stagingLost = true;

    // Its own removal looks before the session lands, and finds nothing.
    await instance.dispose();
    hold.release();

    expect(await call).toBeNull();
    expect(device.files.has(dirFor())).toBe(false);
    expect(attachCommands()).toEqual([]);
  });

  it("moves its tunnel to another device port once a process on the device took its port, and the session follows", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    const taken = device.devicePort!;
    // An adb server restart dropped the reverse, and an app bound the port meanwhile.
    device.reverses.clear();
    device.squatted.add(taken);
    await first.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    const listed = (await nativeNetworkLogsTool.execute!(
      { androidNetwork: api },
      { udid: SERIAL, bundleId: PKG, limit: 50, clear: false }
    )) as { header: string };

    const moved = device.devicePort!;
    expect(moved).not.toBe(taken);
    expect(device.commands).toContain(`reverse tcp:${taken} tcp:${device.hostPort}`);
    expect(device.reverses.get(moved)).toEqual(device.hostPort);
    expect(session().port).toBe(moved);
    expect(listed.header).not.toContain("adb");
    // The agent reads the session before its next connection, so it dials the new port.
    await FakeAgent.fromSession(dirFor(), proc(), { instance: first.instance, lastSeq: 0 });
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
    expect(attachCommands()).toHaveLength(1);

    await instances.pop()!.dispose();
    expect(device.files.has(dirFor())).toBe(false);
    expect(device.reverses.has(moved)).toBe(false);
  });

  it("never leaves the session naming a port it gave up while a session write was on its way", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    const taken = device.devicePort!;
    // The recheck after the drop runs once, when the test says, and never again to heal.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await first.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    // The next call writes the session again for the process its agent left; that write is held.
    const hold = holdOnce();
    device.sessionWriteGate = hold.gate;
    const call = api.ensureAttached(8081);
    await vi.waitFor(() => expect(attachScripts()).toHaveLength(2));
    // Meanwhile the port is taken, and the recheck after the drop finds that.
    device.reverses.clear();
    device.squatted.add(taken);
    const reads = pidofReads();
    await vi.advanceTimersByTimeAsync(500);
    // The device mocks never wait on I/O: one turn lets the recheck go as far as it can.
    await new Promise((resolve) => setImmediate(resolve));
    expect(pidofReads()).toBe(reads + 1);
    hold.release();

    expect(await call).toBeNull();
    // Not vi.waitFor: under fake timers it would run the recheck again, which heals.
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
    expect(device.devicePort).not.toBe(taken);
    expect(session().port).toBe(device.devicePort);
    expect(device.reverses.get(device.devicePort!)).toEqual(device.hostPort);
  });

  it("leaves nothing behind when disposed during its first call, and touches nothing of a newer inspector", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let blockNext = true;
    device.reverseGate = async () => {
      if (!blockNext) return;
      blockNext = false;
      await gate;
    };
    const old = await createInspector();
    const oldInstance = instances.pop()!;
    const first = old.ensureAttached(8081);
    await vi.waitFor(() => expect(vi.mocked(adbReverse)).toHaveBeenCalledTimes(1));
    const [, oldDevicePort, oldHostPort] = vi.mocked(adbReverse).mock.calls[0]!;
    await oldInstance.dispose();

    const api = await armedInspector();
    const newer = {
      port: device.devicePort!,
      hostPort: device.hostPort!,
      secret: session().secret,
    };
    release();

    expect(await first).toBeNull();
    expect(device.reverses.has(oldDevicePort)).toBe(false);
    expect(device.reverses.get(newer.port)).toEqual(newer.hostPort);
    expect(session().secret).toBe(newer.secret);
    expect(attachCommands()).toHaveLength(1);
    expect(api.state().armed).toBe(true);
    await expect(FakeAgent.connect(oldHostPort, { secret: "" })).rejects.toThrow(/ECONNREFUSED/);
    expect(vi.mocked(removeAdbReverse).mock.calls.every(([, port]) => port === oldDevicePort)).toBe(
      true
    );
  });

  it("fails a request still in flight once its process is gone, and keeps it in flight while the process lives", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    agent.started(agent.rid(1), "https://example.com/delay/10");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));

    await agent.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));
    expect(await api.ensureAttached(8081)).toBeNull();
    expect(api.records(8081)[0]?.state).toBe("pending");

    device.process = { pid: 5500, startTime: 150_000 };
    await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG);

    expect(api.records(8081)[0]).toMatchObject({
      state: "failed",
      errorText: "the app process ended before the request finished",
    });
    expect(await api.responseBody(api.records(8081)[0]!.id)).toMatchObject({
      available: false,
      reason: expect.stringContaining("failed"),
    });
  });

  it("reads an adb failure after a dropped connection as adb being away, not as the app exiting, and puts the reverse back", async () => {
    const api = await armedInspector();
    device.reverses.clear();
    device.adbDown = true;
    const before = device.commands.length;
    await agents[0]!.close();
    await vi.waitFor(
      () =>
        expect(device.commands.slice(before).some((c) => c.includes("for p in $(pidof"))).toBe(
          true
        ),
      { timeout: 3_000 }
    );
    device.adbDown = false;

    await vi.waitFor(
      () => expect(device.reverses.get(device.devicePort!)).toEqual(device.hostPort),
      {
        timeout: 3_000,
      }
    );
    expect(api.state().note).not.toContain("exited");

    await FakeAgent.fromSession(dirFor(), proc());
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
    expect(attachCommands()).toHaveLength(1);
  });
});

describe("reconnections", () => {
  it("resumes the same agent's dropped connection: requests in flight finish and old bodies read through it", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    first.request(first.rid(1), "https://example.com/one");
    first.started(first.rid(2), "https://example.com/slow");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(2));

    await first.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    const again = (await FakeAgent.fromSession(dirFor(), proc(), {
      instance: first.instance,
      lastSeq: 2,
      inFlight: [first.rid(2)],
    }))!;
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
    again.event("Network.loadingFinished", { requestId: first.rid(2) });
    again.request(first.rid(3), "https://example.com/three");

    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(3));
    const [one, slow, three] = api.records(8081);
    expect(one).toMatchObject({ layerId: first.rid(1), connection: 1, state: "complete" });
    expect(slow).toMatchObject({ layerId: first.rid(2), connection: 1, state: "complete" });
    expect(slow!.timing.durationMs).toBeGreaterThanOrEqual(0);
    expect(three).toMatchObject({ layerId: first.rid(3), connection: 2 });
    expect(attachCommands()).toHaveLength(1);

    again.responseBodies.set(first.rid(1), {
      bodyAvailable: true,
      body: "one",
      base64Encoded: false,
      wasTruncated: false,
    });
    expect(await api.responseBody(one!.id)).toMatchObject({ available: true, body: "one" });
  });

  it("fails what the resumed agent no longer has in flight, and lets its later events still settle it", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    for (const seq of [1, 2, 3]) first.started(first.rid(seq), `https://example.com/${seq}`);
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(3));
    await first.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    // Buffered while disconnected: request 1 finished. Request 2 is still in flight.
    await FakeAgent.fromSession(dirFor(), proc(), {
      instance: first.instance,
      lastSeq: 3,
      inFlight: [first.rid(2)],
      beforeEnable: (agent) =>
        agent.event("Network.loadingFinished", { requestId: first.rid(1), encodedDataLength: 3 }),
    });
    await vi.waitFor(() => expect(api.state().armed).toBe(true));

    const [done, inFlight, lost] = api.records(8081);
    expect(done).toMatchObject({ state: "complete", encodedDataLength: 3 });
    expect(inFlight!.state).toBe("pending");
    expect(lost).toMatchObject({
      state: "failed",
      errorText: "the agent lost this request's final events while it was disconnected",
    });

    agents.at(-1)!.event("Network.loadingFailed", {
      requestId: first.rid(3),
      errorText: "net::ERR_CONNECTION_RESET",
    });
    await vi.waitFor(() =>
      expect(api.records(8081)[2]).toMatchObject({
        state: "failed",
        errorText: "net::ERR_CONNECTION_RESET",
      })
    );
  });

  it("does not resume an agent that reports fewer requests than were seen, as after a snapshot load", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    first.request(first.rid(1), "https://example.com/old", { method: "POST", hasPostData: true });
    first.started(first.rid(2), "https://example.com/in-flight");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(2));
    const [old, inFlight] = api.records(8081);
    await first.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    const restored = (await FakeAgent.fromSession(dirFor(), proc(), {
      instance: first.instance,
      lastSeq: 0,
      inFlight: [],
    }))!;
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
    restored.responseBodies.set(first.rid(1), {
      bodyAvailable: true,
      body: "another request",
      base64Encoded: false,
    });

    expect(inFlight).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("snapshot load"),
    });
    for (const body of [await api.responseBody(old!.id), await api.requestPostData(old!.id)]) {
      expect(body).toMatchObject({
        available: false,
        reason: expect.stringContaining("snapshot load"),
      });
    }
    expect(restored.requests.map((r) => r.method)).toEqual(["Network.enable"]);
  });

  it("never resumes a connection of another attach", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    first.request(first.rid(1), "https://example.com/old");
    first.started(first.rid(2), "https://example.com/in-flight");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(2));
    await first.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    const other = (await FakeAgent.fromSession(dirFor(), proc(), { lastSeq: 9 }))!;
    expect(other.instance).not.toBe(first.instance);
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
    other.responseBodies.set(first.rid(1), {
      bodyAvailable: true,
      body: "x",
      base64Encoded: false,
    });

    expect(api.records(8081)[1]).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("no longer in the app"),
    });
    expect(await api.responseBody(api.records(8081)[0]!.id)).toMatchObject({ available: false });
    expect(other.requests.map((r) => r.method)).toEqual(["Network.enable"]);
  });

  it("attaches again to a known process that lost its agent, as a restored emulator snapshot leaves it", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    agent.started(agent.rid(1), "https://example.com/in-flight");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));

    await agent.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));
    expect(await api.ensureAttached(8081)).toBeNull();
    expect(attachCommands()).toHaveLength(1);
    expect(api.state().note).toContain("dropped");
    expect(api.records(8081)[0]?.state).toBe("pending");

    device.loaded.clear();
    expect(await api.ensureAttached(8081)).toBeNull();

    expect(attachCommands()).toHaveLength(2);
    expect(attachCommands()[1]).toContain("attach-agent 4722 ");
    await vi.waitFor(() =>
      expect(api.state()).toMatchObject({ armed: true, process: { pid: 4722 } })
    );
    expect(api.records(8081)[0]?.state).toBe("failed");
  });

  it("stops resuming once the resumed connection reports a dropped connection's id again", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    first.request(first.rid(1), "https://example.com/kept");
    first.request(first.rid(2), "https://example.com/reused");
    first.started(first.rid(3), "https://example.com/in-flight");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(3));
    const [kept, reused, inFlight] = api.records(8081);
    await first.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    const next = (await FakeAgent.fromSession(dirFor(), proc(), {
      instance: first.instance,
      lastSeq: 3,
      inFlight: [first.rid(3)],
    }))!;
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
    for (const [requestId, body] of [
      [first.rid(1), "kept"],
      [first.rid(2), "another request"],
    ] as const) {
      next.responseBodies.set(requestId, {
        bodyAvailable: true,
        body,
        base64Encoded: false,
        wasTruncated: false,
      });
    }
    expect(await api.responseBody(kept!.id)).toMatchObject({ body: "kept" });

    next.request(first.rid(2), "https://example.com/new");
    await vi.waitFor(() => {
      const all = api.records(8081);
      expect(all).toHaveLength(4);
      expect(all[3]!.state).toBe("complete");
    });

    expect(await api.responseBody(reused!.id)).toMatchObject({
      available: false,
      reason: expect.stringContaining("snapshot load"),
    });
    expect(inFlight!.state).toBe("failed");
    expect(inFlight!.errorText).toContain("snapshot load");
    expect(api.records(8081)[3]).toMatchObject({ request: { url: "https://example.com/new" } });
    expect(await api.responseBody(api.records(8081)[3]!.id)).toMatchObject({
      available: true,
      body: "another request",
    });
    expect(attachCommands()).toHaveLength(1);
  });

  it("drops a body reply that arrives after the resumed connection reported the record's id again", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    first.request(first.rid(1), "https://example.com/old");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));
    const old = api.records(8081)[0]!;
    await first.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    const next = (await FakeAgent.fromSession(dirFor(), proc(), {
      instance: first.instance,
      lastSeq: 1,
    }))!;
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
    next.responseBodies.set(first.rid(1), {
      bodyAvailable: true,
      body: "another request",
      base64Encoded: false,
      wasTruncated: false,
    });
    next.onRequest = (method) => {
      if (method === "Network.getResponseBody")
        next.request(first.rid(1), "https://example.com/new");
    };

    expect(await api.responseBody(old.id)).toMatchObject({
      available: false,
      reason: expect.stringContaining("snapshot load"),
    });
  });

  it("closes an agent's earlier connection that is still open when the same attach connects again", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    first.started(first.rid(1), "https://example.com/in-flight");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));

    const second = (await FakeAgent.fromSession(dirFor(), proc(), {
      instance: first.instance,
      lastSeq: 1,
      inFlight: [first.rid(1)],
    }))!;
    await first.closed();
    await vi.waitFor(() => expect(second.received).toContain("Network.enable"));
    second.event("Network.loadingFailed", { requestId: first.rid(1), errorText: "canceled" });

    await vi.waitFor(() =>
      expect(api.records(8081)[0]).toMatchObject({ state: "failed", errorText: "canceled" })
    );
  });

  it("keeps the same id from two live connections apart: two records, each fetched from its own connection", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    const second = (await FakeAgent.fromSession(dirFor(), proc()))!;
    await vi.waitFor(() => expect(second.received).toContain("Network.enable"));

    const shared = "00000000-1";
    first.request(shared, "https://example.com/from-first");
    second.request(shared, "https://example.com/from-second");
    await vi.waitFor(() =>
      expect(api.records(8081).map((r) => r.state)).toEqual(["complete", "complete"])
    );

    const records = api.records(8081);
    expect(records.map((r) => [r.layerId, r.connection]).sort()).toEqual([
      [shared, 1],
      [shared, 2],
    ]);
    expect(new Set(records.map((r) => r.id)).size).toBe(2);

    first.responseBodies.set(shared, { bodyAvailable: true, body: "first", base64Encoded: false });
    second.responseBodies.set(shared, {
      bodyAvailable: true,
      body: "second",
      base64Encoded: false,
    });
    const byUrl = new Map(records.map((r) => [r.request.url, r.id]));
    expect((await api.responseBody(byUrl.get("https://example.com/from-first")!)).body).toBe(
      "first"
    );
    expect((await api.responseBody(byUrl.get("https://example.com/from-second")!)).body).toBe(
      "second"
    );
  });
});

describe("after a drop, with the clock under test control", () => {
  it("fails open requests as lost when no reconnection comes within the recheck window, and a later one still settles them", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    first.started(first.rid(1), "https://example.com/slow");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await first.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.records(8081)[0]!.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.records(8081)[0]).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("did not reconnect"),
    });
    vi.useRealTimers();

    await FakeAgent.fromSession(dirFor(), proc(), {
      instance: first.instance,
      lastSeq: 1,
      beforeEnable: (agent) =>
        agent.event("Network.loadingFinished", { requestId: first.rid(1), encodedDataLength: 5 }),
    });
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
    expect(api.records(8081)[0]).toMatchObject({ state: "complete", encodedDataLength: 5 });
    expect(api.records(8081)[0]!.errorText).toBeUndefined();
  });

  it("restarts a process's recheck when its connection drops again during it", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    first.started(first.rid(1), "https://example.com/slow");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await first.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));
    await vi.advanceTimersByTimeAsync(9_000);

    const second = (await FakeAgent.fromSession(dirFor(), proc(), {
      instance: first.instance,
      lastSeq: 1,
      inFlight: [first.rid(1)],
    }))!;
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
    await second.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    // The first drop's window would have ended at 15.5 s.
    await vi.advanceTimersByTimeAsync(7_000);
    expect(api.records(8081)[0]!.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(16_000);
    expect(api.records(8081)[0]).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("did not reconnect"),
    });
  });

  it("rechecks each process on its own: a drop of the next process still puts its reverse back", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    first.started(first.rid(1), "https://example.com/first");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await first.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    device.process = { pid: 5700, startTime: 170_000 };
    const next = (await FakeAgent.fromSession(dirFor(), proc()))!;
    await vi.waitFor(() =>
      expect(api.state()).toMatchObject({ armed: true, process: { pid: 5700 } })
    );
    next.started(next.rid(1), "https://example.com/next");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(2));
    await next.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));
    device.reverses.clear();

    await vi.advanceTimersByTimeAsync(20_000);

    const [ofFirst, ofNext] = api.records(8081);
    expect(ofFirst).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("process ended"),
    });
    expect(ofNext).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("did not reconnect"),
    });
    expect(device.reverses.get(device.devicePort!)).toEqual(device.hostPort);
  });
});

describe("a slow Network.enable reply, with the clock under test control", () => {
  /** An inspector whose agent connected and holds its enable reply. */
  async function enablePending(): Promise<{ api: AndroidNetworkInspectorApi; agent: FakeAgent }> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    device.agentOptions = { unanswered: ["Network.enable"] };
    const api = await createInspector();
    expect(await api.ensureAttached(8081)).toBeNull();
    await vi.waitFor(() => expect(agents[0]?.received).toContain("Network.enable"));
    return { api, agent: agents[0]! };
  }

  it("arms a connection whose enable reply comes after 10 s, as when the agent flushes a large buffer first", async () => {
    const { api, agent } = await enablePending();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.state().armed).toBe(false);
    agent.answer("Network.enable");

    await vi.waitFor(() =>
      expect(api.state()).toMatchObject({ armed: true, capture: { state: "active" } })
    );
  });

  it("closes a connection whose enable reply never comes, and the agent's next connection arms", async () => {
    const { api, agent } = await enablePending();

    await vi.advanceTimersByTimeAsync(59_000);
    expect(agent.socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(agent.socket.destroyed).toBe(true));
    expect(api.state().armed).toBe(false);
    expect(stderrText()).toContain(
      "agent connection 1 closed: it did not answer Network.enable within 60 s"
    );

    const next = (await FakeAgent.fromSession(dirFor(), proc(), {
      instance: agent.instance,
      unanswered: [],
    }))!;
    await vi.waitFor(() =>
      expect(api.state()).toMatchObject({ armed: true, process: { pid: 4722 } })
    );
    expect(next.received.slice(0, 2)).toEqual(["Control", "Network.enable"]);
  });
});

describe("timing and filtering", () => {
  it("does not list an agent event for the Metro port of the device as traffic", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    agent.request(agent.rid(1), "http://localhost:8081/symbolicate", { method: "POST" });
    agent.request(agent.rid(2), "http://10.0.2.2:8081/status");
    agent.request(agent.rid(3), "https://example.com/api");
    agent.request(agent.rid(4), "http://localhost:3000/mock-api");
    await vi.waitFor(() => expect(api.records(0)).toHaveLength(4));

    expect(api.records(8081).map((r) => r.request.url)).toEqual([
      "https://example.com/api",
      "http://localhost:3000/mock-api",
    ]);
  });

  it("times a failed request by the arrival of its events", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    agent.started(agent.rid(1), "https://example.com/aborted");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    agent.event("Network.loadingFailed", {
      requestId: agent.rid(1),
      errorText: "net::ERR_CONNECTION_RESET",
    });
    await vi.waitFor(() => expect(api.records(8081)[0]?.state).toBe("failed"));

    const failed = api.records(8081)[0]!;
    expect(failed.errorText).toBe("net::ERR_CONNECTION_RESET");
    expect(failed.timing.durationMs).toBeGreaterThanOrEqual(250);
    expect(failed.timing.durationMs).toBeLessThan(5_000);
    expect(await api.responseBody(failed.id)).toMatchObject({
      available: false,
      reason: "the request failed before a response arrived",
    });
  });

  it("keeps the response of a request that fails after its headers, and asks the agent for no body", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    const id = agent.rid(1);
    agent.started(id, "https://example.com/stream");
    agent.event("Network.responseReceived", {
      requestId: id,
      type: "Other",
      response: {
        url: "https://example.com/stream",
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "text/event-stream" },
        mimeType: "text/event-stream",
      },
    });
    await vi.waitFor(() => expect(api.records(8081)[0]?.state).toBe("headers"));
    const record = api.records(8081)[0]!.id;
    expect(await api.responseBody(record)).toMatchObject({
      available: false,
      reason: "the response has not finished yet",
    });

    agent.event("Network.loadingFailed", {
      requestId: id,
      errorText: "stream was reset: CANCEL",
      canceled: true,
    });
    await vi.waitFor(() => expect(api.records(8081)[0]?.state).toBe("failed"));

    expect(api.records(8081)[0]).toMatchObject({
      errorText: "stream was reset: CANCEL",
      response: { status: 200, mimeType: "text/event-stream" },
    });
    expect(await api.responseBody(record)).toMatchObject({
      available: false,
      reason: "the response failed before its body finished",
    });
    expect(agent.requests.map((r) => r.method)).toEqual(["Network.enable"]);
  });

  it("times a finished request by the arrival of its events", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    const id = agent.rid(1);
    agent.started(id, "https://example.com/drip");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    agent.event("Network.responseReceived", {
      requestId: id,
      type: "Other",
      response: {
        url: "https://example.com/drip",
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "application/octet-stream",
      },
    });
    agent.event("Network.loadingFinished", { requestId: id, encodedDataLength: 4 });
    await vi.waitFor(() => expect(api.records(8081)[0]?.state).toBe("complete"));

    const finished = api.records(8081)[0]!;
    expect(finished.timing.durationMs).toBeGreaterThanOrEqual(250);
    expect(finished.timing.durationMs).toBeLessThan(5_000);
  });
});

describe("the tools on the Android native layer", () => {
  it("native-network-logs lists the buffer with the armed state, the pid and the capture state in its header", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    agent.request(agent.rid(1), "https://example.com/a", { rnRequestId: 3 });
    agent.request(agent.rid(2), "http://localhost:8081/status");
    await vi.waitFor(() => expect(api.records(0)).toHaveLength(2));

    const result = await nativeNetworkLogsTool.execute!(
      { androidNetwork: api },
      { udid: SERIAL, bundleId: PKG, limit: 50, clear: false }
    );

    expect(result).toEqual({
      status: "ok",
      header: "android-native: armed, 1 request (pid 4722; capture active)",
      armed: true,
      capture: "active",
      count: 1,
      total: 1,
      requests: [
        {
          id: api.records(8081)[0]!.id,
          method: "GET",
          url: "https://example.com/a",
          state: "complete",
          status: 200,
          mimeType: "application/json",
          durationMs: expect.any(Number),
          rnRequestId: 3,
        },
      ],
    });
  });

  it("native-network-logs shows a waiting or unavailable capture in its header", async () => {
    device.agentOptions = {
      capture: { state: "unavailable", detail: "no OkHttp in this process" },
    };
    const api = await armedInspector();
    const result = (await nativeNetworkLogsTool.execute!(
      { androidNetwork: api },
      { udid: SERIAL, bundleId: PKG, limit: 50, clear: false }
    )) as { header: string; capture: string };
    expect(result.capture).toBe("unavailable");
    expect(result.header).toBe(
      "android-native: armed, 0 requests (pid 4722; capture unavailable: no OkHttp in this process; use view-network-logs)"
    );
  });

  it("native-network-logs says why an unarmed layer is empty, and passes not_attachable through", async () => {
    device.process = null;
    const api = await createInspector();
    const empty = await nativeNetworkLogsTool.execute!(
      { androidNetwork: api },
      { udid: SERIAL, bundleId: PKG, limit: 50, clear: false }
    );
    expect(empty).toMatchObject({ status: "ok", armed: false, count: 0, total: 0 });
    expect((empty as { header: string }).header).toBe(
      `android-native: not armed, 0 requests (${PKG} is not running; launch-app or restart-app attaches the agent to its next process)`
    );

    device.runAsError = "run-as: package not debuggable: com.example.release";
    const blocked = await nativeNetworkLogsTool.execute!(
      { androidNetwork: await createInspector(8081, "com.example.release") },
      { udid: SERIAL, bundleId: "com.example.release", limit: 50, clear: false }
    );
    expect(blocked).toMatchObject({ status: "not_attachable" });
  });

  it("native-network-logs with clear hides what it listed and what it did not return past limit, its ids still read, and a request in flight lists again once it finishes", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    agent.responseBodies.set(agent.rid(2), {
      bodyAvailable: true,
      body: "done",
      base64Encoded: false,
      wasTruncated: false,
    });
    agent.request(agent.rid(1), "https://example.com/older");
    agent.request(agent.rid(2), "https://example.com/done");
    agent.started(agent.rid(3), "https://example.com/slow");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(3));

    const listed = (await nativeNetworkLogsTool.execute!(
      { androidNetwork: api },
      { udid: SERIAL, bundleId: PKG, limit: 2, clear: true }
    )) as { requests: Array<{ id: string; state: string }>; total: number };
    const [done, slow] = listed.requests;
    expect(listed.total).toBe(3);
    expect([done!.state, slow!.state]).toEqual(["complete", "pending"]);
    expect(api.records(8081)).toEqual([]);

    expect(
      await networkRequestTool.execute!(
        {},
        { device_id: SERIAL, requestId: done!.id, includeBody: true }
      )
    ).toMatchObject({ requestId: done!.id, state: "complete", response: { body: "done" } });

    agent.event("Network.responseReceived", {
      requestId: agent.rid(3),
      type: "Other",
      response: {
        url: "https://example.com/slow",
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "text/plain",
      },
    });
    agent.event("Network.loadingFinished", { requestId: agent.rid(3), encodedDataLength: 4 });
    await vi.waitFor(() =>
      expect(api.records(8081).map((r) => [r.id, r.state])).toEqual([[slow!.id, "complete"]])
    );
  });

  it("native-network-logs routes Android through the inspector service, keyed by the device whatever its spelling", async () => {
    const registry = toolRegistry();
    await registry.invokeTool("native-network-logs", {
      udid: `ext:acme-1:${SERIAL}`,
      bundleId: PKG,
    });
    await registry.invokeTool("native-network-logs", { udid: SERIAL, bundleId: PKG, port: 8190 });

    const urns = [...registry.getSnapshot().services.keys()];
    expect(urns).toEqual([`AndroidNetworkInspector:${SERIAL}:${PKG}`]);
    expect(attachCommands()).toHaveLength(1);
  });

  it("native-network-logs with stop ends native capture for that app only", async () => {
    device.processes.set(OTHER, { pid: 6100, startTime: 70_000 });
    const registry = toolRegistry();
    for (const bundleId of [PKG, OTHER]) {
      await registry.invokeTool("native-network-logs", { udid: SERIAL, bundleId });
    }
    const urn = `AndroidNetworkInspector:${SERIAL}:${PKG}`;
    const otherUrn = `AndroidNetworkInspector:${SERIAL}:${OTHER}`;
    const api = await registry.resolveService<AndroidNetworkInspectorApi>(urn);
    const otherApi = await registry.resolveService<AndroidNetworkInspectorApi>(otherUrn);
    await vi.waitFor(() =>
      expect([api.state().armed, otherApi.state().armed]).toEqual([true, true])
    );
    const agent = agents.find((a) => a.options.packageName === PKG && a.options.pid === 4722)!;
    agent.request(agent.rid(1), "https://example.com/a");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));
    const id = api.records(8081)[0]!.id;
    const port = session().port;

    const result = await registry.invokeTool("native-network-logs", {
      udid: SERIAL,
      bundleId: PKG,
      stop: true,
    });

    expect(result).toEqual({
      status: "ok",
      stopped: true,
      message: expect.stringContaining(
        `native network capture stopped for ${PKG}; the agent stays loaded in pid 4722`
      ),
    });
    expect(agent.received).toContain("Network.disable");
    expect(registry.getServiceState(urn)).toBe(ServiceState.IDLE);
    expect(device.files.has(dirFor())).toBe(false);
    expect(device.reverses.has(port)).toBe(false);
    expect(findAndroidNativeRecord(id)).toBeUndefined();
    expect(liveAndroidNetworkCaptures(SERIAL)).toEqual([OTHER]);
    expect(await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG)).toBeUndefined();

    // The other app keeps its capture, its session and its tunnel.
    expect(registry.getServiceState(otherUrn)).toBe(ServiceState.RUNNING);
    expect(otherApi.state().armed).toBe(true);
    expect(device.reverses.has(session(dirFor(OTHER)).port)).toBe(true);
  });

  it("native-network-logs with stop creates no inspector for an app without capture", async () => {
    const registry = toolRegistry();
    expect(
      await registry.invokeTool("native-network-logs", { udid: SERIAL, bundleId: PKG, stop: true })
    ).toEqual({
      status: "ok",
      stopped: false,
      message: `native network capture was not on for ${PKG} on ${SERIAL}`,
    });
    expect(registry.getSnapshot().services.size).toBe(0);
    expect(device.commands).toEqual([]);
  });

  it("native-network-logs rejects stop on iOS, where capture cannot be turned off", async () => {
    const registry = toolRegistry();
    const err = await registry
      .invokeTool("native-network-logs", {
        udid: "12345678-1234-1234-1234-123456789ABC",
        bundleId: "com.example.ios",
        stop: true,
      })
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.NATIVE_NETWORK_LOGS_STOP_UNSUPPORTED
    );
    expect((err as Error).message).toContain("stop applies to Android only");
    expect(registry.getSnapshot().services.size).toBe(0);
  });

  it("routes an android- id in view-network-request-details to the body from the fake socket, and an unknown id to not found", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    const id = agent.rid(1);
    agent.responseBodies.set(id, {
      bodyAvailable: true,
      body: Buffer.from('{"ok":true}').toString("base64"),
      base64Encoded: true,
      wasTruncated: false,
    });
    agent.postData.set(id, {
      bodyAvailable: true,
      postData: '{"via":"fetch"}',
      base64Encoded: false,
      wasTruncated: false,
    });
    agent.request(id, "https://httpbin.org/anything/d", { method: "POST", hasPostData: true });
    await vi.waitFor(() => expect(api.records(8081)[0]?.state).toBe("complete"));
    const requestId = api.records(8081)[0]!.id;
    const params = { device_id: SERIAL, requestId, includeBody: true };

    expect(networkRequestTool.services!(params)).toEqual({});
    const details = await networkRequestTool.execute!({}, params);

    expect(details).toMatchObject({
      requestId,
      state: "complete",
      durationMs: expect.any(Number),
      request: {
        url: "https://httpbin.org/anything/d",
        method: "POST",
        headers: { "x-app": "probe", "Authorization": "[REDACTED]" },
        postData: '{"via":"fetch"}',
      },
      response: { status: 200, mimeType: "application/json", body: '{"ok":true}' },
    });

    expect(
      await networkRequestTool.execute!({}, { ...params, requestId: "android-0000-999999" })
    ).toBe(
      "Request android-0000-999999 not found. Use native-network-logs to list the requests the Android native layer recorded."
    );
  });

  it("view-network-request-details decodes a native body by its Content-Encoding, and reads one that does not decode as it came", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    const json = '{"decoded":true}';
    const codings: Array<[string, Buffer]> = [
      ["gzip", zlib.gzipSync(json)],
      ["br", zlib.brotliCompressSync(json)],
    ];
    if (typeof zlib.zstdCompressSync === "function") {
      codings.push(["zstd", zlib.zstdCompressSync(json)]);
    }
    for (const coding of codings.map(([name]) => name)) codings.push([coding, Buffer.from(json)]);
    for (const [i, [coding, bytes]] of codings.entries()) {
      const requestId = agent.rid(i + 1);
      const url = `https://example.com/${i}-${coding}`;
      agent.responseBodies.set(requestId, {
        bodyAvailable: true,
        body: bytes.toString("base64"),
        base64Encoded: true,
        wasTruncated: false,
      });
      agent.started(requestId, url);
      agent.event("Network.responseReceived", {
        requestId,
        type: "XHR",
        response: {
          url,
          status: 200,
          statusText: "OK",
          headers: { "content-encoding": coding, "content-type": "application/json" },
          mimeType: "application/json",
        },
      });
      agent.event("Network.loadingFinished", { requestId, encodedDataLength: bytes.length });
    }
    await vi.waitFor(() =>
      expect(api.records(8081).map((r) => r.state)).toEqual(codings.map(() => "complete"))
    );

    for (const record of api.records(8081)) {
      expect(
        await networkRequestTool.execute!(
          {},
          { device_id: SERIAL, requestId: record.id, includeBody: true }
        )
      ).toMatchObject({ response: { body: json } });
    }
  });

  it("view-network-request-details caps a native body that decodes to more than 16 MiB, without blocking", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    const id = agent.rid(1);
    const bomb = zlib.brotliCompressSync(Buffer.alloc(64 * 1024 * 1024, 0x41));
    expect(bomb.length).toBeLessThan(1024);
    agent.responseBodies.set(id, {
      bodyAvailable: true,
      body: bomb.toString("base64"),
      base64Encoded: true,
      wasTruncated: false,
    });
    agent.started(id, "https://example.com/bomb");
    agent.event("Network.responseReceived", {
      requestId: id,
      type: "XHR",
      response: {
        url: "https://example.com/bomb",
        status: 200,
        statusText: "OK",
        headers: { "content-encoding": "br", "content-type": "application/json" },
        mimeType: "application/json",
      },
    });
    agent.event("Network.loadingFinished", { requestId: id, encodedDataLength: bomb.length });
    await vi.waitFor(() => expect(api.records(8081)[0]?.state).toBe("complete"));

    const started = performance.now();
    const details = (await networkRequestTool.execute!(
      {},
      { device_id: SERIAL, requestId: api.records(8081)[0]!.id, includeBody: true }
    )) as { response: { body: string } };
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(details.response.body).toContain("decodes to more than 16 MiB");
  });
});
