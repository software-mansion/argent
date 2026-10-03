import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import type { ServiceInstance } from "@argent/registry";
import { adbReverse, adbShell, removeAdbReverse, runAdb } from "../src/utils/adb";
import {
  AGENT_BINARIES_MISSING_REASON,
  androidNetworkInspectorBlueprint,
  androidNetworkInspectorRef,
  attachAndroidNetworkInspectorToLaunch,
  type AndroidNetworkInspectorApi,
} from "../src/blueprints/android-network-inspector";
import { nativeNetworkLogsTool } from "../src/tools/native-devtools/native-network-logs";
import { networkRequestTool } from "../src/tools/network/network-request";

const SERIAL = "emulator-5554";
const PKG = "com.example.demo";
const DEVICE = { id: SERIAL, platform: "android" as const, kind: "emulator" as const };

interface FakeDevice {
  sdk: number;
  runAsError?: string;
  abi: string;
  process: { pid: number; startTime: number } | null;
  profileProcess?: { pid: number; startTime: number };
  commands: string[];
  agentOnAttach: boolean;
  loaded: Set<string>;
  devicePort?: number;
  hostPort?: number;
  reverses: Map<number, number>;
  adbDown?: boolean;
  stagingLost?: boolean;
}

let device: FakeDevice;
let binRoot: string;
let savedBinDir: string | undefined;
const instances: Array<ServiceInstance<AndroidNetworkInspectorApi>> = [];
const agents: FakeAgent[] = [];

class FakeAgent {
  readonly requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  readonly responseBodies = new Map<string, Record<string, unknown>>();
  readonly postData = new Map<string, Record<string, unknown>>();
  onRequest?: (method: string) => void;

  private constructor(readonly socket: net.Socket) {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) this.answer(JSON.parse(line) as { payload: Record<string, unknown> });
      }
    });
    socket.on("error", () => {});
  }

  static connect(port: number, packageName = PKG): Promise<FakeAgent> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        const agent = new FakeAgent(socket);
        agents.push(agent);
        agent.send({ type: "Control", payload: { packageName } });
        resolve(agent);
      });
      socket.once("error", reject);
    });
  }

  static dial(devicePort: number): Promise<FakeAgent | null> {
    const hostPort = device.reverses.get(devicePort);
    return hostPort === undefined ? Promise.resolve(null) : FakeAgent.connect(hostPort);
  }

  private answer(frame: { payload: Record<string, unknown> }): void {
    const { id, method, params } = frame.payload as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    this.requests.push({ id, method, params });
    this.onRequest?.(method);
    const requestId = String(params?.requestId ?? "");
    let result: Record<string, unknown> = {};
    if (method === "Network.getResponseBody") {
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

  send(frame: unknown): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  event(method: string, params: Record<string, unknown>): void {
    this.send({ type: "CDP", payload: { method, params } });
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
}

function attachCommands(): string[] {
  return device.commands.filter((c) => c.startsWith("cmd activity attach-agent"));
}

async function createInspector(
  metroPort = 8081,
  packageName = PKG
): Promise<AndroidNetworkInspectorApi> {
  const ref = androidNetworkInspectorRef(DEVICE, packageName, metroPort);
  const instance = await androidNetworkInspectorBlueprint.factory(
    {},
    `${SERIAL}:${packageName}`,
    ref.options
  );
  instances.push(instance);
  return instance.api;
}

async function armedInspector(): Promise<AndroidNetworkInspectorApi> {
  const api = await createInspector();
  expect(await api.ensureAttached()).toBeNull();
  await vi.waitFor(() => expect(api.state().armed).toBe(true));
  return api;
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

beforeEach(() => {
  device = {
    sdk: 35,
    abi: "arm64-v8a",
    process: { pid: 4722, startTime: 91_000 },
    commands: [],
    agentOnAttach: true,
    loaded: new Set(),
    reverses: new Map(),
  };
  binRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-android-network-"));
  writeAgentBinaries(binRoot);
  savedBinDir = process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR;
  process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR = binRoot;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  vi.mocked(adbShell).mockImplementation(async (_serial, command) => {
    device.commands.push(command);
    if (device.adbDown) throw new Error(`adb -s ${SERIAL} shell ${command} failed: device offline`);
    if (command === "getprop ro.build.version.sdk") return `${device.sdk}\n`;
    if (command.startsWith("run-as ") && device.runAsError) {
      throw new Error(`adb -s ${SERIAL} shell ${command} failed: ${device.runAsError}`);
    }
    if (/^run-as '[^']+' id$/.test(command)) return "uid=10212(u0_a212) gid=10212(u0_a212)\n";
    if (command.startsWith("dumpsys package")) return `    primaryCpuAbi=${device.abi}\n`;
    if (command === "getprop ro.product.cpu.abi") return "x86_64\n";
    if (command.startsWith("for p in $(pidof")) {
      const lines = device.profileProcess
        ? [`${device.profileProcess.pid} ${device.profileProcess.startTime} Uid:\t1010212\t1010212`]
        : [];
      if (device.process) {
        lines.push(`${device.process.pid} ${device.process.startTime} Uid:\t10212\t10212`);
      }
      return lines.map((line) => `${line}\n`).join("");
    }
    if (command.startsWith(`run-as '`) && command.includes(" sh -c ")) {
      const proc = device.process;
      if (proc && device.loaded.has(`${proc.pid}:${proc.startTime}`)) return "loaded\n";
      if (device.stagingLost) {
        throw new Error(
          `adb -s ${SERIAL} shell ${command} failed: cp: bad '/data/local/tmp/.argent-inspector/network-inspector.jar': No such file or directory`
        );
      }
      return "copied\n";
    }
    if (command.startsWith("cmd activity attach-agent")) {
      if (device.process) device.loaded.add(`${device.process.pid}:${device.process.startTime}`);
      if (device.agentOnAttach) void FakeAgent.dial(Number(/,port=(\d+),/.exec(command)?.[1]));
    }
    return "";
  });
  vi.mocked(runAdb).mockImplementation(async (args) => {
    device.commands.push(args.join(" "));
    if (args[2] === "push") device.stagingLost = false;
    return { stdout: "", stderr: "" };
  });
  vi.mocked(adbReverse).mockImplementation(async (_serial, devicePort, hostPort) => {
    if (device.adbDown) throw new Error(`adb -s ${SERIAL} reverse failed: device offline`);
    device.commands.push(`reverse tcp:${devicePort} tcp:${hostPort}`);
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
  await Promise.all(agents.splice(0).map((a) => a.close()));
  await Promise.all(instances.splice(0).map((i) => i.dispose()));
  if (savedBinDir === undefined) delete process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR;
  else process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR = savedBinDir;
  fs.rmSync(binRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("AndroidNetworkInspector against a fake agent socket", () => {
  it("validates the handshake, arms on Network.enable, keeps the Status and folds the events", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;

    expect(agent.requests[0]?.method).toBe("Network.enable");
    expect(attachCommands()).toHaveLength(1);
    expect(attachCommands()[0]).toBe(
      `cmd activity attach-agent 4722 '/data/data/${PKG}/.argent-inspector/libjvmti_network_inspector.so=jar=/data/data/${PKG}/.argent-inspector/network-inspector.jar,port=${device.devicePort},pkg=${PKG},metroPort=8081'`
    );

    agent.send({
      type: "Status",
      payload: {
        event: "interceptor_installed",
        detail: "ready",
      },
    });
    agent.request("req-1", "https://httpbin.org/anything/a", { rnRequestId: 7 });
    agent.request("req-2", "https://httpbin.org/anything/b", {
      method: "POST",
      hasPostData: true,
    });

    await vi.waitFor(() =>
      expect(api.records(8081).map((r) => r.state)).toEqual(["complete", "complete"])
    );
    expect(api.state().capture).toBe("capture active");
    agent.send({ type: "Status", payload: { event: "interceptor_failed", detail: "error" } });
    await vi.waitFor(() => expect(api.state().capture).toBe("capture could not start in the app"));

    const [first, second] = api.records(8081);
    expect(first).toMatchObject({
      layer: "android-native",
      layerId: "req-1",
      connection: 1,
      rnRequestId: 7,
      request: { url: "https://httpbin.org/anything/a", method: "GET" },
      response: { status: 200, mimeType: "application/json" },
      resourceType: "XHR",
      encodedDataLength: 11,
      timing: { startedAt: 1_000_000, durationMs: expect.any(Number) },
    });
    expect(first!.request.headers).toEqual({
      "x-app": "probe",
      "Authorization": "Bearer secret-token",
    });
    expect(first!.id).toMatch(/^android-\d+$/);
    expect(second).toMatchObject({
      layerId: "req-2",
      request: { method: "POST", hasPostData: true },
    });
    expect(second!.rnRequestId).toBeUndefined();
  });

  it("fetches a body and post data once per record, through the CDP writer", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    agent.responseBodies.set("req-1", {
      bodyAvailable: true,
      body: Buffer.from('{"ok":true}').toString("base64"),
      base64Encoded: true,
      wasTruncated: false,
    });
    agent.postData.set("req-1", {
      bodyAvailable: true,
      postData: '{"via":"xhr"}',
      base64Encoded: false,
      wasTruncated: false,
    });
    agent.request("req-1", "https://httpbin.org/anything/b", {
      method: "POST",
      hasPostData: true,
    });
    await vi.waitFor(() => expect(api.records(8081)[0]?.state).toBe("complete"));
    const id = api.records(8081)[0]!.id;

    const body = await api.responseBody(id);
    expect(body).toMatchObject({ available: true, base64Encoded: true, truncated: false });
    expect(Buffer.from(body.body, "base64").toString()).toBe('{"ok":true}');
    expect(await api.requestPostData(id)).toMatchObject({
      available: true,
      body: '{"via":"xhr"}',
      base64Encoded: false,
    });

    await api.responseBody(id);
    await api.requestPostData(id);
    const asked = agent.requests.map((r) => `${r.method} ${String(r.params?.requestId ?? "")}`);
    expect(asked).toEqual([
      "Network.enable ",
      "Network.getResponseBody req-1",
      "Network.getRequestPostData req-1",
    ]);
  });

  it("does not cache a missing post-data answer for a pending request", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    agent.event("Network.requestWillBeSent", {
      requestId: "req-1",
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
    const id = api.records(8081)[0]!.id;

    expect(await api.requestPostData(id)).toMatchObject({
      available: false,
      reason: "no request body was returned yet; this answer is not cached, so read it again later",
    });

    agent.postData.set("req-1", {
      bodyAvailable: true,
      postData: "payload",
      base64Encoded: false,
      wasTruncated: false,
    });
    agent.event("Network.responseReceived", {
      requestId: "req-1",
      timestamp: 1000.4,
      type: "Other",
      response: {
        url: "https://example.com/upload",
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "text/plain",
      },
    });
    agent.event("Network.loadingFinished", {
      requestId: "req-1",
      timestamp: 1000.5,
      encodedDataLength: 2,
    });
    await vi.waitFor(() => expect(api.records(8081)[0]?.state).toBe("complete"));

    expect(await api.requestPostData(id)).toMatchObject({ available: true, body: "payload" });
    await api.requestPostData(id);
    expect(agent.requests.filter((r) => r.method === "Network.getRequestPostData")).toHaveLength(2);
  });

  it("rejects a handshake that names another package and stays unarmed", async () => {
    device.agentOnAttach = false;
    const api = await createInspector();
    expect(await api.ensureAttached()).toBeNull();

    const impostor = await FakeAgent.connect(device.hostPort!, "com.other.app");
    await new Promise<void>((resolve) => impostor.socket.once("close", () => resolve()));
    expect(impostor.requests).toEqual([]);
    expect(api.state().armed).toBe(false);
  });

  it("rejects an opening frame nested too deep to print, and keeps serving", async () => {
    device.agentOnAttach = false;
    const api = await createInspector();
    expect(await api.ensureAttached()).toBeNull();

    // JSON.stringify throws a RangeError at this depth on Node 20 to 24, and a
    // throw here takes the whole tool-server down.
    const hostile = net.connect(device.hostPort!, "127.0.0.1");
    hostile.on("error", () => {});
    const closed = new Promise<void>((resolve) => hostile.once("close", () => resolve()));
    hostile.write(`${"[".repeat(1_000_000)}${"]".repeat(1_000_000)}\n`);
    await closed;

    await FakeAgent.connect(device.hostPort!);
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
  });

  it("closes a connection whose frame never ends before its buffer outgrows the tool-server, and keeps serving", async () => {
    device.agentOnAttach = false;
    const api = await createInspector();
    expect(await api.ensureAttached()).toBeNull();

    const hostile = net.connect(device.hostPort!, "127.0.0.1");
    hostile.on("error", () => {});
    const closed = new Promise<void>((resolve) => hostile.once("close", () => resolve()));
    const chunk = "A".repeat(1024 * 1024);
    const limit = 32 * 1024 * 1024;
    let sent = 0;
    const pump = (): void => {
      while (!hostile.destroyed && sent < limit) {
        sent += chunk.length;
        if (!hostile.write(chunk)) {
          hostile.once("drain", pump);
          return;
        }
      }
      if (!hostile.destroyed) hostile.end();
    };
    hostile.once("connect", pump);
    await closed;
    expect(sent).toBeLessThan(limit);

    await FakeAgent.connect(device.hostPort!);
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
  });

  it("returns not_attachable, naming the JS layer, when run-as fails", async () => {
    device.runAsError = `run-as: package not debuggable: ${PKG}`;
    const api = await createInspector();

    const result = await api.ensureAttached();

    expect(result).toEqual({
      status: "not_attachable",
      reason: expect.stringContaining(`package not debuggable: ${PKG}`),
      fallback: expect.stringContaining("view-network-logs"),
    });
    expect(device.commands.some((c) => c.startsWith("push"))).toBe(false);
    expect(attachCommands()).toEqual([]);
  });

  it("returns not_attachable once a non-debuggable build replaced an attached app", async () => {
    const api = await armedInspector();
    device.runAsError = `run-as: package not debuggable: ${PKG}`;
    device.process = { pid: 5100, startTime: 99_000 };

    expect(await api.ensureAttached()).toMatchObject({
      status: "not_attachable",
      reason: expect.stringContaining("package not debuggable"),
    });
    expect(attachCommands()).toHaveLength(1);
  });

  it("returns not_attachable below Android 8.0", async () => {
    device.sdk = 25;
    const api = await createInspector();

    expect(await api.ensureAttached()).toMatchObject({
      status: "not_attachable",
      reason: expect.stringContaining("API 25"),
    });
    expect(device.commands).toEqual(["getprop ro.build.version.sdk"]);
  });

  it("returns the missing-binaries result, without throwing or touching the device, when bin/network-inspector/ is absent", async () => {
    fs.rmSync(path.join(binRoot, "network-inspector"), { recursive: true, force: true });
    const api = await createInspector();

    await expect(api.ensureAttached()).resolves.toEqual({
      status: "not_attachable",
      reason: AGENT_BINARIES_MISSING_REASON,
      fallback: expect.stringContaining("view-network-logs"),
    });
    expect(device.commands).toEqual([]);
  });

  it("keeps serving an attached agent after bin/network-inspector/ goes away", async () => {
    const api = await armedInspector();
    agents[0]!.request("req-1", "https://example.com/kept");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));

    fs.rmSync(path.join(binRoot, "network-inspector"), { recursive: true, force: true });

    expect(await api.ensureAttached()).toBeNull();
    expect(api.records(8081).map((r) => r.request.url)).toEqual(["https://example.com/kept"]);
  });

  it("pushes the agent for the app's ABI and removes its reverse on dispose", async () => {
    device.abi = "x86_64";
    const api = await armedInspector();
    const pushes = device.commands.filter((c) => c.startsWith("-s"));
    expect(pushes).toEqual([
      `-s ${SERIAL} push ${path.join(binRoot, "network-inspector", "network-inspector.jar")} /data/local/tmp/.argent-inspector/network-inspector.jar`,
      `-s ${SERIAL} push ${path.join(binRoot, "network-inspector", "x86_64", "libjvmti_network_inspector.so")} /data/local/tmp/.argent-inspector/libjvmti_network_inspector.so`,
    ]);
    const { devicePort, hostPort } = device;
    expect(device.commands).toContain(`reverse tcp:${devicePort} tcp:${hostPort}`);
    expect(devicePort).toBeGreaterThanOrEqual(20_000);
    expect(devicePort).toBeLessThan(30_000);
    expect(api.state().armed).toBe(true);

    await instances.pop()!.dispose();

    expect(device.commands.at(-1)).toBe(`reverse --remove tcp:${devicePort}`);
    await expect(FakeAgent.connect(hostPort!)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("gives a later service the same device port and does not attach again", async () => {
    await armedInspector();
    const firstDevicePort = device.devicePort;
    const firstHostPort = device.hostPort;
    await instances.pop()!.dispose();

    const api = await createInspector();
    expect(await api.ensureAttached()).toBeNull();
    expect(attachCommands()).toHaveLength(1);
    expect(api.state().note).toContain("already has the agent loaded");
    expect(device.devicePort).toBe(firstDevicePort);
    expect(device.hostPort).not.toBe(firstHostPort);

    await FakeAgent.connect(device.hostPort!);
    await vi.waitFor(() => expect(api.state().armed).toBe(true));

    await createInspector(8081, "com.example.other").then((other) => other.ensureAttached());
    expect(device.devicePort).not.toBe(firstDevicePort);
  });

  it("does not attach into a process that already has the agent loaded", async () => {
    device.loaded.add("4722:91000");
    device.agentOnAttach = false;
    const api = await createInspector();

    expect(await api.ensureAttached()).toBeNull();
    expect(attachCommands()).toEqual([]);
    const check = device.commands.find((c) => c.startsWith(`run-as '${PKG}' sh -c`))!;
    expect(check).toContain(
      "if grep -q libjvmti_network_inspector.so /proc/4722/maps; then echo loaded;"
    );

    await FakeAgent.connect(device.hostPort!);
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
  });

  it("falls back to the device ABI when the app has no native libraries, and refuses an ABI it ships no agent for", async () => {
    device.abi = "null";
    await armedInspector();
    expect(device.commands).toContain("getprop ro.product.cpu.abi");
    expect(device.commands.some((c) => c.includes("/x86_64/libjvmti_network_inspector.so"))).toBe(
      true
    );

    device.abi = "armeabi-v7a";
    const api32 = await createInspector();
    expect(await api32.ensureAttached()).toMatchObject({
      status: "not_attachable",
      reason: expect.stringContaining("runs as armeabi-v7a"),
    });
  });

  it("attaches once per (pid, start time): the same process never twice, a reused pid with a new start time again", async () => {
    const api = await armedInspector();
    expect(await api.ensureAttached()).toBeNull();
    await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG);
    expect(attachCommands()).toHaveLength(1);

    device.process = { pid: 4722, startTime: 95_000 };
    await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG);
    expect(attachCommands()).toHaveLength(2);
    expect(attachCommands()[1]).toContain("attach-agent 4722 ");

    await api.ensureAttached();
    await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG);
    expect(attachCommands()).toHaveLength(2);
  });

  it("does not attach from a launch until native-network-logs set the service up", async () => {
    await createInspector();
    await attachAndroidNetworkInspectorToLaunch(SERIAL, PKG);
    expect(device.commands).toEqual([]);
  });

  it("copies into the app, then chmods the jar 444 and the .so 555, before the attach", async () => {
    await armedInspector();
    const copyAt = device.commands.findIndex((c) => c.startsWith(`run-as '${PKG}' sh -c`));
    const attachAt = device.commands.findIndex((c) => c.startsWith("cmd activity attach-agent"));
    expect(copyAt).toBeGreaterThanOrEqual(0);
    expect(copyAt).toBeLessThan(attachAt);

    const copy = device.commands[copyAt]!;
    const dir = `/data/data/${PKG}/.argent-inspector`;
    const steps = [
      `cp /data/local/tmp/.argent-inspector/network-inspector.jar ${dir}/network-inspector.jar`,
      `cp /data/local/tmp/.argent-inspector/libjvmti_network_inspector.so ${dir}/libjvmti_network_inspector.so`,
      `chmod 444 ${dir}/network-inspector.jar`,
      `chmod 555 ${dir}/libjvmti_network_inspector.so`,
    ].map((step) => copy.indexOf(step));
    expect(steps.every((at) => at >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  it("keeps the buffer and in-flight records across a dropped connection without attaching again", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    first.request("req-1", "https://example.com/one");
    first.event("Network.requestWillBeSent", {
      requestId: "req-2",
      request: { url: "https://example.com/slow", method: "GET", headers: {} },
      timestamp: 1000,
      wallTime: 1000,
    });
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(2));

    await first.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    const again = await FakeAgent.connect(device.hostPort!);
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
    again.event("Network.loadingFinished", { requestId: "req-2", timestamp: 1000.5 });
    again.request("req-3", "https://example.com/three");

    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(3));
    const [one, slow, three] = api.records(8081);
    expect(one).toMatchObject({ layerId: "req-1", connection: 1, state: "complete" });
    expect(slow).toMatchObject({ layerId: "req-2", connection: 1, state: "complete" });
    expect(slow!.timing.durationMs).toBeGreaterThanOrEqual(0);
    expect(three).toMatchObject({ layerId: "req-3", connection: 2 });
    expect(attachCommands()).toHaveLength(1);

    again.responseBodies.set("req-1", {
      bodyAvailable: true,
      body: "one",
      base64Encoded: false,
      wasTruncated: false,
    });
    expect(await api.responseBody(one!.id)).toMatchObject({ available: true, body: "one" });
  });

  it("puts its reverse back when a reboot dropped it, so the agent in the next process connects", async () => {
    const api = await armedInspector();
    device.reverses.clear();
    device.process = { pid: 5200, startTime: 120_000 };
    await agents[0]!.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    expect(await api.ensureAttached()).toBeNull();

    expect(device.reverses.get(device.devicePort!)).toBe(device.hostPort);
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

    expect(await api.ensureAttached()).toBeNull();
    expect(api.state().note).toContain("No such file or directory");
    expect(await api.ensureAttached()).toBeNull();

    expect(device.commands.filter((c) => c.includes(" push "))).toHaveLength(4);
    expect(attachCommands()).toHaveLength(2);
    await vi.waitFor(() =>
      expect(api.state()).toMatchObject({ armed: true, process: { pid: 5400 } })
    );
  });

  it("fails a request still in flight once its process is gone, and keeps it in flight while the process lives", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    agent.event("Network.requestWillBeSent", {
      requestId: "req-1",
      request: { url: "https://example.com/delay/10", method: "GET", headers: {} },
      timestamp: 1000,
      wallTime: 1000,
    });
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));

    await agent.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));
    expect(await api.ensureAttached()).toBeNull();
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

  it("attaches again to a known process that lost its agent, as a restored emulator snapshot leaves it", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    agent.event("Network.requestWillBeSent", {
      requestId: "req-1",
      request: { url: "https://example.com/in-flight", method: "GET", headers: {} },
      timestamp: 1000,
      wallTime: 1000,
    });
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));

    await agent.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));
    expect(await api.ensureAttached()).toBeNull();
    expect(attachCommands()).toHaveLength(1);
    expect(api.state().note).toContain("dropped");
    expect(api.records(8081)[0]?.state).toBe("pending");

    device.loaded.clear();
    expect(await api.ensureAttached()).toBeNull();

    expect(attachCommands()).toHaveLength(2);
    expect(attachCommands()[1]).toContain("attach-agent 4722 ");
    await vi.waitFor(() =>
      expect(api.state()).toMatchObject({ armed: true, process: { pid: 4722 } })
    );
    expect(api.records(8081)[0]?.state).toBe("failed");
  });

  it("reads no old body through the agent attached again after a snapshot load", async () => {
    const api = await armedInspector();
    const lost = agents[0]!;
    lost.request("req-1", "https://example.com/old", { method: "POST", hasPostData: true });
    await vi.waitFor(() => expect(api.records(8081)[0]?.state).toBe("complete"));
    const old = api.records(8081)[0]!;
    await lost.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    device.loaded.clear();
    expect(await api.ensureAttached()).toBeNull();
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
    const fresh = agents.at(-1)!;
    expect(fresh).not.toBe(lost);

    for (const body of [await api.responseBody(old.id), await api.requestPostData(old.id)]) {
      expect(body).toMatchObject({
        available: false,
        reason: expect.stringContaining("snapshot load"),
      });
    }
    expect(fresh.requests.map((r) => r.method)).toEqual(["Network.enable"]);
  });

  it("stops resuming once the resumed connection reports a dropped connection's id again", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    first.request("req-1", "https://example.com/kept");
    first.request("req-2", "https://example.com/reused");
    first.event("Network.requestWillBeSent", {
      requestId: "req-3",
      request: { url: "https://example.com/in-flight", method: "GET", headers: {} },
      timestamp: 1000,
      wallTime: 1000,
    });
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(3));
    const [kept, reused, inFlight] = api.records(8081);
    await first.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    const next = await FakeAgent.connect(device.hostPort!);
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
    for (const [requestId, body] of [
      ["req-1", "kept"],
      ["req-2", "another request"],
    ] as const) {
      next.responseBodies.set(requestId, {
        bodyAvailable: true,
        body,
        base64Encoded: false,
        wasTruncated: false,
      });
    }
    expect(await api.responseBody(kept!.id)).toMatchObject({ body: "kept" });

    next.request("req-2", "https://example.com/new");
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
    expect(api.records(8081)[3]).toMatchObject({
      request: { url: "https://example.com/new" },
    });
    expect(await api.responseBody(api.records(8081)[3]!.id)).toMatchObject({
      available: true,
      body: "another request",
    });
    expect(attachCommands()).toHaveLength(1);
  });

  it("drops a body reply that arrives after the resumed connection reported the record's id again", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    first.request("req-1", "https://example.com/old");
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));
    const old = api.records(8081)[0]!;
    await first.close();
    await vi.waitFor(() => expect(api.state().armed).toBe(false));

    const next = await FakeAgent.connect(device.hostPort!);
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
    next.responseBodies.set("req-1", {
      bodyAvailable: true,
      body: "another request",
      base64Encoded: false,
      wasTruncated: false,
    });
    next.onRequest = (method) => {
      if (method === "Network.getResponseBody") {
        next.request("req-1", "https://example.com/new");
      }
    };

    expect(await api.responseBody(old.id)).toMatchObject({
      available: false,
      reason: expect.stringContaining("snapshot load"),
    });
  });

  it("attaches to the app's user 0 process when pidof lists a work profile copy first", async () => {
    device.profileProcess = { pid: 4100, startTime: 80_000 };
    const api = await armedInspector();

    expect(attachCommands()).toHaveLength(1);
    expect(attachCommands()[0]).toContain("attach-agent 4722 ");
    expect(api.state().process).toEqual({ pid: 4722, startTime: 91_000 });
    expect(device.commands.some((c) => c.includes("/proc/4100/"))).toBe(false);
  });

  it("reads an adb failure after a dropped connection as adb being away, not as the app exiting, and puts the reverse back", async () => {
    const api = await armedInspector();
    device.reverses.clear();
    device.adbDown = true;
    const before = device.commands.length;
    await agents[0]!.close();
    await vi.waitFor(
      () =>
        expect(device.commands.slice(before).some((c) => c.startsWith("for p in $(pidof"))).toBe(
          true
        ),
      { timeout: 3_000 }
    );
    device.adbDown = false;

    await vi.waitFor(() => expect(device.reverses.get(device.devicePort!)).toBe(device.hostPort), {
      timeout: 3_000,
    });
    expect(api.state().note).not.toContain("exited");

    await FakeAgent.dial(device.devicePort!);
    await vi.waitFor(() => expect(api.state().armed).toBe(true));
    expect(attachCommands()).toHaveLength(1);
  });

  it("keeps the same id from two live connections apart: two records, each fetched from its own connection", async () => {
    const api = await armedInspector();
    const first = agents[0]!;
    const second = await FakeAgent.connect(device.hostPort!);
    await vi.waitFor(() =>
      expect(second.requests.map((r) => r.method)).toEqual(["Network.enable"])
    );

    first.request("req-1", "https://example.com/from-first");
    second.request("req-1", "https://example.com/from-second");
    await vi.waitFor(() =>
      expect(api.records(8081).map((r) => r.state)).toEqual(["complete", "complete"])
    );

    const records = api.records(8081);
    expect(records.map((r) => [r.layerId, r.connection])).toEqual([
      ["req-1", 1],
      ["req-1", 2],
    ]);
    expect(new Set(records.map((r) => r.id)).size).toBe(2);
    expect(records.map((r) => r.request.url).sort()).toEqual([
      "https://example.com/from-first",
      "https://example.com/from-second",
    ]);

    first.responseBodies.set("req-1", {
      bodyAvailable: true,
      body: "first",
      base64Encoded: false,
    });
    second.responseBodies.set("req-1", {
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

  it("does not list an agent event for the Metro port of the device as traffic", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    agent.request("req-1", "http://localhost:8081/symbolicate", { method: "POST" });
    agent.request("req-2", "http://10.0.2.2:8081/status");
    agent.request("req-3", "https://example.com/api");
    agent.request("req-4", "http://localhost:3000/mock-api");
    await vi.waitFor(() => expect(api.records(0)).toHaveLength(4));

    expect(api.records(8081).map((r) => r.request.url)).toEqual([
      "https://example.com/api",
      "http://localhost:3000/mock-api",
    ]);
  });

  it("times a failed request by the arrival of its events", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    agent.event("Network.requestWillBeSent", {
      requestId: "req-1",
      request: { url: "https://example.com/aborted", method: "GET", headers: {} },
      timestamp: 1000,
      wallTime: 1000,
    });
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    agent.event("Network.loadingFailed", {
      requestId: "req-1",
      timestamp: 1000.06,
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
    agent.event("Network.requestWillBeSent", {
      requestId: "req-1",
      request: { url: "https://example.com/stream", method: "GET", headers: {} },
      timestamp: 1000,
      wallTime: 1000,
    });
    agent.event("Network.responseReceived", {
      requestId: "req-1",
      timestamp: 1000.1,
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
    const id = api.records(8081)[0]!.id;
    expect(await api.responseBody(id)).toMatchObject({
      available: false,
      reason: "the response has not finished yet",
    });

    agent.event("Network.loadingFailed", {
      requestId: "req-1",
      timestamp: 1000.5,
      errorText: "stream was reset: CANCEL",
      canceled: true,
    });
    await vi.waitFor(() => expect(api.records(8081)[0]?.state).toBe("failed"));

    expect(api.records(8081)[0]).toMatchObject({
      errorText: "stream was reset: CANCEL",
      response: { status: 200, mimeType: "text/event-stream" },
    });
    expect(await api.responseBody(id)).toMatchObject({
      available: false,
      reason: "the response failed before its body finished",
    });
    expect(agent.requests.map((r) => r.method)).toEqual(["Network.enable"]);
  });

  it("times a finished request by the arrival of its events", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    agent.event("Network.requestWillBeSent", {
      requestId: "req-1",
      request: { url: "https://example.com/drip", method: "GET", headers: {} },
      timestamp: 1000,
      wallTime: 1000,
    });
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    agent.event("Network.responseReceived", {
      requestId: "req-1",
      timestamp: 1000.1,
      type: "Other",
      response: {
        url: "https://example.com/drip",
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "application/octet-stream",
      },
    });
    agent.event("Network.loadingFinished", {
      requestId: "req-1",
      timestamp: 1000.16,
      encodedDataLength: 4,
    });
    await vi.waitFor(() => expect(api.records(8081)[0]?.state).toBe("complete"));

    const finished = api.records(8081)[0]!;
    expect(finished.timing.durationMs).toBeGreaterThanOrEqual(250);
    expect(finished.timing.durationMs).toBeLessThan(5_000);
  });
});

describe("the tools on the Android native layer", () => {
  it("native-network-logs lists the buffer with the armed state in its header", async () => {
    const api = await armedInspector();
    agents[0]!.send({
      type: "Status",
      payload: { event: "interceptor_installed", detail: "ready" },
    });
    agents[0]!.request("req-1", "https://example.com/a", { rnRequestId: 3 });
    agents[0]!.request("req-2", "http://localhost:8081/status");
    await vi.waitFor(() => expect(api.records(0)).toHaveLength(2));

    const result = await nativeNetworkLogsTool.execute!(
      { androidNetwork: api },
      { udid: SERIAL, bundleId: PKG, limit: 50, clear: false }
    );

    expect(result).toEqual({
      status: "ok",
      header: "android-native: armed, 1 request (pid 4722; capture active)",
      armed: true,
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

  it("native-network-logs with clear hides what it listed, its ids still read, and a request in flight lists again once it finishes", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    agent.responseBodies.set("req-1", {
      bodyAvailable: true,
      body: "done",
      base64Encoded: false,
      wasTruncated: false,
    });
    agent.request("req-1", "https://example.com/done");
    agent.event("Network.requestWillBeSent", {
      requestId: "req-2",
      request: { url: "https://example.com/slow", method: "GET", headers: {} },
      timestamp: 1000,
      wallTime: 1000,
    });
    await vi.waitFor(() => expect(api.records(8081)).toHaveLength(2));

    const listed = (await nativeNetworkLogsTool.execute!(
      { androidNetwork: api },
      { udid: SERIAL, bundleId: PKG, limit: 50, clear: true }
    )) as { requests: Array<{ id: string; state: string }> };
    const [done, slow] = listed.requests;
    expect([done!.state, slow!.state]).toEqual(["complete", "pending"]);
    expect(api.records(8081)).toEqual([]);

    expect(
      await networkRequestTool.execute!(
        {},
        { device_id: SERIAL, requestId: done!.id, includeBody: true }
      )
    ).toMatchObject({ requestId: done!.id, state: "complete", response: { body: "done" } });

    agent.event("Network.responseReceived", {
      requestId: "req-2",
      timestamp: 1000.2,
      type: "Other",
      response: {
        url: "https://example.com/slow",
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "text/plain",
      },
    });
    agent.event("Network.loadingFinished", {
      requestId: "req-2",
      timestamp: 1000.25,
      encodedDataLength: 4,
    });
    await vi.waitFor(() =>
      expect(api.records(8081).map((r) => [r.id, r.state])).toEqual([[slow!.id, "complete"]])
    );
  });

  it("routes an android-N id in view-network-request-details to the body from the fake socket, and an unknown id to not found", async () => {
    const api = await armedInspector();
    const agent = agents[0]!;
    agent.responseBodies.set("req-1", {
      bodyAvailable: true,
      body: Buffer.from('{"ok":true}').toString("base64"),
      base64Encoded: true,
      wasTruncated: false,
    });
    agent.postData.set("req-1", {
      bodyAvailable: true,
      postData: '{"via":"fetch"}',
      base64Encoded: false,
      wasTruncated: false,
    });
    agent.request("req-1", "https://httpbin.org/anything/d", {
      method: "POST",
      hasPostData: true,
    });
    await vi.waitFor(() => expect(api.records(8081)[0]?.state).toBe("complete"));
    const id = api.records(8081)[0]!.id;
    const params = { device_id: SERIAL, requestId: id, includeBody: true };

    expect(networkRequestTool.services!(params)).toEqual({});
    const details = await networkRequestTool.execute!({}, params);

    expect(details).toMatchObject({
      requestId: id,
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

    expect(await networkRequestTool.execute!({}, { ...params, requestId: "android-999999" })).toBe(
      "Request android-999999 not found. Use native-network-logs to list the requests the Android native layer recorded."
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
      const requestId = `req-${i + 1}`;
      const url = `https://example.com/${i}-${coding}`;
      agent.responseBodies.set(requestId, {
        bodyAvailable: true,
        body: bytes.toString("base64"),
        base64Encoded: true,
        wasTruncated: false,
      });
      agent.event("Network.requestWillBeSent", {
        requestId,
        request: { url, method: "GET", headers: {} },
        timestamp: 1000,
        wallTime: 1000,
      });
      agent.event("Network.responseReceived", {
        requestId,
        timestamp: 1000.1,
        type: "XHR",
        response: {
          url,
          status: 200,
          statusText: "OK",
          headers: { "content-encoding": coding, "content-type": "application/json" },
          mimeType: "application/json",
        },
      });
      agent.event("Network.loadingFinished", {
        requestId,
        timestamp: 1000.2,
        encodedDataLength: bytes.length,
      });
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
    const bomb = zlib.brotliCompressSync(Buffer.alloc(64 * 1024 * 1024, 0x41));
    expect(bomb.length).toBeLessThan(1024);
    agent.responseBodies.set("req-1", {
      bodyAvailable: true,
      body: bomb.toString("base64"),
      base64Encoded: true,
      wasTruncated: false,
    });
    agent.event("Network.requestWillBeSent", {
      requestId: "req-1",
      request: { url: "https://example.com/bomb", method: "GET", headers: {} },
      timestamp: 1000,
      wallTime: 1000,
    });
    agent.event("Network.responseReceived", {
      requestId: "req-1",
      timestamp: 1000.1,
      type: "XHR",
      response: {
        url: "https://example.com/bomb",
        status: 200,
        statusText: "OK",
        headers: { "content-encoding": "br", "content-type": "application/json" },
        mimeType: "application/json",
      },
    });
    agent.event("Network.loadingFinished", {
      requestId: "req-1",
      timestamp: 1000.2,
      encodedDataLength: bomb.length,
    });
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
