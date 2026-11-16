import { afterEach, describe, expect, it, vi } from "vitest";
import * as net from "node:net";
import type { DeviceInfo } from "@argent/registry";

// The native-devtools service arms network capture with a CDP request on the
// app's socket and reads the app's pid from the host. These tests drive the
// real service with a fake app on that socket.

const probe = vi.hoisted(() => ({
  launchctlList: "",
  psOutput: "",
  launchctlCalls: 0,
  /** While set, `ps` answers only once it resolves, as a slow read of a process does. */
  psHeld: null as Promise<void> | null,
  /** `launchctl list` fails, as on a simulator that stopped answering. */
  launchctlFails: false,
}));

vi.mock("@argent/native-devtools-ios", () => ({
  bootstrapDylibPath: () => "/fake/dylibs/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTcp: () => "/fake/dylibs/tcp/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTvos: () => "/fake/dylibs/tvos/libArgentInjectionBootstrap.dylib",
  tcpInjectionDylibs: () => [],
  axServiceBinaryPath: () => "/fake/ax-service",
  axServiceBinaryPathTcp: () => "/fake/ax-service-tcp",
}));

type ExecCb = (err: Error | null, out: { stdout: string; stderr: string }) => void;

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (cmd: string, args: readonly string[], opts: unknown, cb?: ExecCb) => {
      const callback = (typeof opts === "function" ? opts : cb!) as ExecCb;
      const argv = args.join(" ");
      if (/\bps$/.test(cmd)) {
        const answer = () => callback(null, { stdout: probe.psOutput, stderr: "" });
        if (probe.psHeld) void probe.psHeld.then(answer);
        else answer();
        return;
      }
      if (argv.includes("launchctl list")) {
        probe.launchctlCalls++;
        if (probe.launchctlFails) {
          callback(new Error("Invalid device: the simulator did not answer"), {
            stdout: "",
            stderr: "",
          });
          return;
        }
        callback(null, { stdout: probe.launchctlList, stderr: "" });
        return;
      }
      if (argv.includes("simctl list")) {
        callback(null, { stdout: JSON.stringify({ devices: {} }), stderr: "" });
        return;
      }
      callback(null, { stdout: "", stderr: "" });
    },
  };
});

import { nativeDevtoolsBlueprint, type NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import {
  liveIosNetworkCaptureDevices,
  liveIosNetworkCaptures,
} from "../src/blueprints/ios-network-records";
import type { NativeNetworkRecord } from "../src/utils/native-network-record";
import { processScopedUdid } from "./helpers/process-scoped-udid";

const UDID = processScopedUdid("-9999-8888-7777-666666666666");
const BUNDLE = "com.example.app";
const device: DeviceInfo = { id: UDID, platform: "ios", kind: "simulator" };

/** The app runs as `pid`, as `launchctl list` and `ps` report it. */
function appRunsAs(pid: number): void {
  probe.launchctlList = `${pid}\t0\tUIKitApplication:${BUNDLE}[dffa][rb-legacy]\n`;
  probe.psOutput = `00:05 /Devices/${UDID}/Example.app/Example NATIVE_DEVTOOLS_IOS_CDP_SOCKET=/tmp/x\n`;
}

function appGone(): void {
  probe.launchctlList = "";
  probe.psOutput = "";
  probe.psHeld = null;
  probe.launchctlFails = false;
}

interface Frame {
  type: string;
  payload: {
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { message: string };
    bundleId?: string;
  };
}

interface FakeApp {
  received: Frame[];
  send(frame: Frame): void;
  /** Answers the CDP request with this id. */
  reply(id: number, result?: unknown): void;
  close(): void;
  closed: Promise<void>;
}

/**
 * Dials the service's socket as the app does and records every frame it is
 * sent. With `acknowledge`, it answers every CDP request at once.
 */
async function connectApp(
  socketPath: string,
  { acknowledge = true }: { acknowledge?: boolean } = {}
): Promise<FakeApp> {
  const received: Frame[] = [];
  let buffer = "";
  const sock = net.createConnection(socketPath);
  await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
  const write = (frame: Frame): void => {
    sock.write(JSON.stringify(frame) + "\n");
  };
  sock.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      const frame = JSON.parse(line) as Frame;
      received.push(frame);
      if (acknowledge && frame.type === "CDP" && frame.payload.id !== undefined) {
        write({ type: "CDP", payload: { id: frame.payload.id, result: {} } });
      }
    }
  });
  const closed = new Promise<void>((resolve) => sock.once("close", () => resolve()));
  write({ type: "Control", payload: { bundleId: BUNDLE } });
  return {
    received,
    send: write,
    reply: (id, result = {}) => write({ type: "CDP", payload: { id, result } }),
    close: () => sock.destroy(),
    closed,
  };
}

const cdpRequests = (app: FakeApp, method: string): Frame[] =>
  app.received.filter((f) => f.type === "CDP" && f.payload.method === method);

const enableRequests = (app: FakeApp): Frame[] => cdpRequests(app, "Network.enable");

/** `request` adds to or replaces the fields of the request the app reports. */
function requestEvents(
  requestId: string,
  url: string,
  request: Record<string, unknown> = {}
): Frame[] {
  return [
    {
      type: "CDP",
      payload: {
        method: "Network.requestWillBeSent",
        params: {
          requestId,
          wallTime: 1_700_000_000,
          request: { url, method: "GET", headers: {}, ...request },
        },
      },
    },
  ];
}

function finishEvents(requestId: string): Frame[] {
  return [
    {
      type: "CDP",
      payload: {
        method: "Network.responseReceived",
        params: {
          requestId,
          type: "XHR",
          response: { url: "", status: 200, headers: {}, mimeType: "text/plain" },
        },
      },
    },
    {
      type: "CDP",
      payload: {
        method: "Network.loadingFinished",
        params: { requestId, encodedDataLength: 2, nativeDevtoolsDurationMs: 12 },
      },
    },
  ];
}

let instance: Awaited<ReturnType<typeof nativeDevtoolsBlueprint.factory>> | null = null;

async function startService(): Promise<NativeDevtoolsApi> {
  instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
  return instance.api as NativeDevtoolsApi;
}

/** Connects the app with capture on for it, and acknowledges its Network.enable. */
async function connectArmedApp(api: NativeDevtoolsApi): Promise<FakeApp> {
  await api.activateNetworkInspection(BUNDLE);
  const app = await connectApp(api.socketPath, { acknowledge: false });
  await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(1));
  app.reply(enableRequests(app)[0]!.payload.id!);
  await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().armed).toBe(true));
  return app;
}

/** Waits for the listed record of `url` to reach `state`, and returns its id. */
function recordOf(
  api: NativeDevtoolsApi,
  url: string,
  state: NativeNetworkRecord["state"] = "complete"
): Promise<string> {
  return vi.waitFor(() => {
    const record = api
      .networkRecords(BUNDLE)
      ?.records(8081)
      .find((r) => r.request.url === url);
    expect(record?.state).toBe(state);
    return record!.id;
  });
}

const responseBodyReads = (app: FakeApp): Frame[] => cdpRequests(app, "Network.getResponseBody");
const postDataReads = (app: FakeApp): Frame[] => cdpRequests(app, "Network.getRequestPostData");

const textBody = (body: string) => ({
  available: true,
  body,
  base64Encoded: false,
  truncated: false,
});

const noBody = (reason: string) => ({
  available: false,
  body: "",
  base64Encoded: false,
  truncated: false,
  reason,
});

const PROCESS_GONE = "the app process that made the request is gone";

afterEach(async () => {
  vi.useRealTimers();
  await instance?.dispose();
  instance = null;
  appGone();
});

describe("native-devtools network capture", () => {
  it("asks the app to enable capture with a CDP request, and is armed only on the reply", async () => {
    appRunsAs(4711);
    const api = await startService();
    const app = await connectApp(api.socketPath, { acknowledge: false });
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));

    const arming = api.activateNetworkInspection(BUNDLE);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(1));
    const [request] = enableRequests(app);
    expect(request!.payload.id).toEqual(expect.any(Number));
    expect(api.networkRecords(BUNDLE)!.state()).toMatchObject({
      armed: false,
      note: "waiting for the agent to acknowledge Network.enable",
    });

    app.reply(request!.payload.id!);
    await expect(arming).resolves.toBe(true);
    expect(api.networkRecords(BUNDLE)!.state()).toMatchObject({ armed: true });
    expect(api.networkRecords(BUNDLE)!.state().note).toBeUndefined();

    // Armed already: a second call sends nothing.
    await expect(api.activateNetworkInspection(BUNDLE)).resolves.toBe(true);
    expect(enableRequests(app)).toHaveLength(1);
  });

  it("enables capture at the handshake of an app it is on for, also one that never connected before", async () => {
    const api = await startService();
    await expect(api.activateNetworkInspection(BUNDLE)).resolves.toBe(false);
    // No process of the app carries capture yet, so no profile is warned about it.
    expect(liveIosNetworkCaptures(UDID)).toEqual([]);

    const app = await connectApp(api.socketPath);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(1));
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().armed).toBe(true));
    expect(liveIosNetworkCaptures(UDID)).toEqual([BUNDLE]);
  });

  it("sends nothing at the handshake of an app capture is not on for", async () => {
    const api = await startService();
    const app = await connectApp(api.socketPath);
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(enableRequests(app)).toHaveLength(0);
    expect(liveIosNetworkCaptures(UDID)).toEqual([]);
  });

  it("keeps an app that does not answer within 5 s connected and unarmed, and asks again on the next call", async () => {
    const api = await startService();
    const app = await connectApp(api.socketPath, { acknowledge: false });
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const arming = api.activateNetworkInspection(BUNDLE);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(arming).resolves.toBe(false);
    vi.useRealTimers();

    expect(api.isConnected(BUNDLE)).toBe(true);
    expect(api.networkRecords(BUNDLE)!.state()).toEqual({
      armed: false,
      note: "the agent did not acknowledge Network.enable within 5 s; the next call asks again",
    });

    const again = api.activateNetworkInspection(BUNDLE);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(2));
    app.reply(enableRequests(app)[1]!.payload.id!);
    await expect(again).resolves.toBe(true);

    // The late reply to the first request is ignored.
    app.reply(enableRequests(app)[0]!.payload.id!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.isConnected(BUNDLE)).toBe(true);
  });

  it("sends one Network.enable for calls that overlap while it waits for the reply, and settles them together", async () => {
    const api = await startService();
    const app = await connectApp(api.socketPath, { acknowledge: false });
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = api.activateNetworkInspection(BUNDLE);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(1_500);
    let secondSettled = false;
    const second = api.activateNetworkInspection(BUNDLE).finally(() => (secondSettled = true));
    // 5 s after the first call, when its reply timeout ends.
    await vi.advanceTimersByTimeAsync(3_500);
    await expect(first).resolves.toBe(false);
    expect(secondSettled).toBe(true);
    await expect(second).resolves.toBe(false);
    vi.useRealTimers();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(enableRequests(app)).toHaveLength(1);
  });

  it("keeps an app that answers Network.enable with an error connected and unarmed, and asks again on the next call", async () => {
    const api = await startService();
    const app = await connectApp(api.socketPath, { acknowledge: false });
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));

    const arming = api.activateNetworkInspection(BUNDLE);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(1));
    app.send({
      type: "CDP",
      payload: {
        id: enableRequests(app)[0]!.payload.id,
        error: { message: "capture unavailable" },
      },
    });
    await expect(arming).resolves.toBe(false);

    expect(api.isConnected(BUNDLE)).toBe(true);
    expect(api.networkRecords(BUNDLE)!.state()).toEqual({
      armed: false,
      note: `the agent did not enable capture (native-devtools ${BUNDLE}: Network.enable failed: capture unavailable); the next call asks again`,
    });

    const again = api.activateNetworkInspection(BUNDLE);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(2));
    app.reply(enableRequests(app)[1]!.payload.id!, {});
    await expect(again).resolves.toBe(true);
    expect(api.networkRecords(BUNDLE)!.state()).toEqual({ armed: true });
  });

  it("still answers view reads while capture replies and events flow, and drops a reply with an unknown id", async () => {
    const api = await startService();
    const app = await connectApp(api.socketPath);
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));
    await api.activateNetworkInspection(BUNDLE);

    const read = api.queryViewHierarchy(BUNDLE, "ViewHierarchy.describeScreen");
    await vi.waitFor(() => expect(app.received.some((f) => f.type === "ViewInspector")).toBe(true));
    const viewRequest = app.received.find((f) => f.type === "ViewInspector")!;
    // A capture reply with the same id as the view request, and one nobody asked for.
    app.reply(viewRequest.payload.id!, { unexpected: true });
    app.reply(9_999);
    for (const frame of requestEvents("r-1", "https://example.com/a")) app.send(frame);
    app.send({
      type: "ViewInspector",
      payload: { id: viewRequest.payload.id, result: { elements: ["ok"] } },
    });

    await expect(read).resolves.toEqual({ elements: ["ok"] });
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)!.records(8081)).toHaveLength(1));
  });

  it("keeps the history across a second handshake of the same app, which supersedes the first", async () => {
    appRunsAs(100);
    const api = await startService();
    await api.activateNetworkInspection(BUNDLE);
    const first = await connectApp(api.socketPath);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().armed).toBe(true));
    for (const frame of [
      ...requestEvents("done", "https://example.com/done"),
      ...finishEvents("done"),
      ...requestEvents("open", "https://example.com/open"),
    ]) {
      first.send(frame);
    }
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)!.records(8081)).toHaveLength(2));

    appRunsAs(200);
    const second = await connectApp(api.socketPath);
    await first.closed;
    await vi.waitFor(() =>
      expect(api.networkRecords(BUNDLE)?.state()).toMatchObject({ armed: true, pid: 200 })
    );
    for (const frame of requestEvents("next", "https://example.com/next")) second.send(frame);

    await vi.waitFor(() => {
      const records = api.networkRecords(BUNDLE)!.records(8081);
      expect(records.map((r) => [r.request.url, r.state, r.errorText])).toEqual([
        ["https://example.com/done", "complete", undefined],
        ["https://example.com/open", "failed", "the app process ended before the request finished"],
        ["https://example.com/next", "pending", undefined],
      ]);
    });
  });

  it("reads the pid of the connected process from the host", async () => {
    appRunsAs(4711);
    const api = await startService();
    await api.activateNetworkInspection(BUNDLE);
    await connectApp(api.socketPath);

    await vi.waitFor(() =>
      expect(api.networkRecords(BUNDLE)?.state()).toEqual({ armed: true, pid: 4711 })
    );
  });

  it("fails open requests as not reconnected when the same process still runs after its connection closed", async () => {
    appRunsAs(4711);
    const api = await startService();
    await api.activateNetworkInspection(BUNDLE);
    const app = await connectApp(api.socketPath);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().pid).toBe(4711));
    for (const frame of requestEvents("open", "https://example.com/slow")) app.send(frame);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)!.records(8081)).toHaveLength(1));

    app.close();
    await vi.waitFor(() =>
      expect(api.networkRecords(BUNDLE)!.records(8081)[0]).toMatchObject({
        state: "failed",
        errorText:
          "the agent did not reconnect after its connection dropped, so this request's final events never arrived",
      })
    );
    expect(api.isConnected(BUNDLE)).toBe(false);
    expect(api.networkRecords(BUNDLE)!.state()).toEqual({
      armed: false,
      note: "the app is not connected; its next process is armed when it connects",
    });
  });

  it("fails open requests as not reconnected when the host cannot list the running apps after the connection closed", async () => {
    appRunsAs(4711);
    const api = await startService();
    await api.activateNetworkInspection(BUNDLE);
    const app = await connectApp(api.socketPath);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().pid).toBe(4711));
    for (const frame of requestEvents("open", "https://example.com/slow")) app.send(frame);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)!.records(8081)).toHaveLength(1));

    // As when the simulator shuts down under an open request.
    probe.launchctlFails = true;
    app.close();
    await vi.waitFor(() =>
      expect(api.networkRecords(BUNDLE)!.records(8081)[0]).toMatchObject({
        state: "failed",
        errorText:
          "the agent did not reconnect after its connection dropped, so this request's final events never arrived",
      })
    );
  });

  it("fails open requests as ended when the process is gone after its connection closed", async () => {
    appRunsAs(4711);
    const api = await startService();
    await api.activateNetworkInspection(BUNDLE);
    const app = await connectApp(api.socketPath);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().pid).toBe(4711));
    for (const frame of requestEvents("open", "https://example.com/slow")) app.send(frame);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)!.records(8081)).toHaveLength(1));

    appGone();
    app.close();
    await vi.waitFor(() =>
      expect(api.networkRecords(BUNDLE)!.records(8081)[0]).toMatchObject({
        state: "failed",
        errorText: "the app process ended before the request finished",
      })
    );
  });

  it("fails open requests as ended when another process of the app runs after its connection closed", async () => {
    appRunsAs(4711);
    const api = await startService();
    await api.activateNetworkInspection(BUNDLE);
    const app = await connectApp(api.socketPath);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().pid).toBe(4711));
    for (const frame of requestEvents("open", "https://example.com/slow")) app.send(frame);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)!.records(8081)).toHaveLength(1));

    // A relaunch whose new process has not connected yet: only the pids tell it apart.
    appRunsAs(4712);
    app.close();
    await vi.waitFor(() =>
      expect(api.networkRecords(BUNDLE)!.records(8081)[0]).toMatchObject({
        state: "failed",
        errorText: "the app process ended before the request finished",
      })
    );
    expect(api.isConnected(BUNDLE)).toBe(false);
  });

  it("probes the host at a connection close only when the store holds a record of that connection", async () => {
    appRunsAs(4711);
    const api = await startService();
    await api.activateNetworkInspection(BUNDLE);
    const first = await connectApp(api.socketPath);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().pid).toBe(4711));
    const probesBefore = probe.launchctlCalls;

    // No request came in on this connection, so its close probes nothing.
    first.close();
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(false));

    const second = await connectApp(api.socketPath);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().pid).toBe(4711));
    for (const frame of requestEvents("open", "https://example.com/slow")) second.send(frame);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)!.records(8081)).toHaveLength(1));
    second.close();
    await vi.waitFor(() =>
      expect(api.networkRecords(BUNDLE)!.records(8081)[0]?.state).toBe("failed")
    );

    // One probe read the second process's pid, and one checked its close.
    expect(probe.launchctlCalls - probesBefore).toBe(2);
  });

  it("fails only the replaced connection's open requests, not one the new process started while the host was checking", async () => {
    appRunsAs(100);
    const api = await startService();
    await api.activateNetworkInspection(BUNDLE);
    const first = await connectApp(api.socketPath);
    await vi.waitFor(() =>
      expect(api.networkRecords(BUNDLE)?.state()).toEqual({ armed: true, pid: 100 })
    );
    for (const frame of requestEvents("old", "https://example.com/old")) first.send(frame);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)!.records(8081)).toHaveLength(1));

    // The host check of the replaced connection answers only once released.
    let releasePs!: () => void;
    probe.psHeld = new Promise((resolve) => (releasePs = resolve));
    appRunsAs(200);
    const second = await connectApp(api.socketPath);
    await first.closed;
    for (const frame of requestEvents("new", "https://example.com/new-launch")) second.send(frame);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)!.records(8081)).toHaveLength(2));
    probe.psHeld = null;
    releasePs();

    const listed = () =>
      api
        .networkRecords(BUNDLE)!
        .records(8081)
        .map((r) => [r.request.url, r.state, r.errorText]);
    await vi.waitFor(() =>
      expect(listed()).toEqual([
        ["https://example.com/old", "failed", "the app process ended before the request finished"],
        ["https://example.com/new-launch", "pending", undefined],
      ])
    );
    await vi.waitFor(() =>
      expect(api.networkRecords(BUNDLE)?.state()).toEqual({ armed: true, pid: 200 })
    );
    for (const frame of finishEvents("new")) second.send(frame);
    await vi.waitFor(() =>
      expect(listed()).toEqual([
        ["https://example.com/old", "failed", "the app process ended before the request finished"],
        ["https://example.com/new-launch", "complete", undefined],
      ])
    );
    second.close();
  });

  it("drops the app's captures and records from the lookups on dispose", async () => {
    const api = await startService();
    await api.activateNetworkInspection(BUNDLE);
    await connectApp(api.socketPath);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().armed).toBe(true));
    expect(liveIosNetworkCaptures(UDID)).toEqual([BUNDLE]);

    await instance!.dispose();
    instance = null;
    expect(liveIosNetworkCaptures(UDID)).toEqual([]);
    expect(api.networkRecords(BUNDLE)).toBeUndefined();
  });

  it("keeps a disposed service out of the lookups even when a call and a handshake reach it after the dispose", async () => {
    const api = await startService();
    // A process that dialed just before the dispose and sends its handshake after it.
    const sock = net.createConnection(api.socketPath);
    await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
    let closed = false;
    sock.once("close", () => (closed = true));
    // Long enough for the service to take the connection before the dispose.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await instance!.dispose();
    instance = null;

    await api.activateNetworkInspection(BUNDLE);
    sock.write(JSON.stringify({ type: "Control", payload: { bundleId: BUNDLE } }) + "\n");
    await vi.waitFor(() => expect(api.isConnected(BUNDLE) || closed).toBe(true));

    expect(liveIosNetworkCaptures(UDID)).toEqual([]);
    expect(liveIosNetworkCaptureDevices(BUNDLE)).toEqual([]);
    sock.destroy();
  });

  it("settles an enable still waiting for its reply as not armed at once on dispose", async () => {
    const api = await startService();
    const app = await connectApp(api.socketPath, { acknowledge: false });
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));

    const arming = api.activateNetworkInspection(BUNDLE);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(1));
    await instance!.dispose();
    instance = null;

    // Well inside the 5 s the agent has to answer, so the reply timeout cannot settle it.
    const outcome = await Promise.race([
      arming,
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
    ]);
    expect(outcome).toBe(false);
  });

  it("settles an enable still waiting for its reply as not armed at once when the app's connection closes", async () => {
    const api = await startService();
    const app = await connectApp(api.socketPath, { acknowledge: false });
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));

    const arming = api.activateNetworkInspection(BUNDLE);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(1));
    app.close();

    // Well inside the 5 s the agent has to answer, so the reply timeout cannot settle it.
    const outcome = await Promise.race([
      arming,
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
    ]);
    expect(outcome).toBe(false);
  });

  it("settles an enable still waiting for its reply as not armed at once when a new connection of the app replaces it", async () => {
    const api = await startService();
    const first = await connectApp(api.socketPath, { acknowledge: false });
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));

    const arming = api.activateNetworkInspection(BUNDLE);
    await vi.waitFor(() => expect(enableRequests(first)).toHaveLength(1));
    // A relaunch: the new process dials while the old one's enable is unanswered.
    const second = await connectApp(api.socketPath);

    // Well inside the 5 s the agent has to answer, so the reply timeout cannot settle it.
    const outcome = await Promise.race([
      arming,
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
    ]);
    expect(outcome).toBe(false);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().armed).toBe(true));
    second.close();
  });
});

describe("native-devtools body reads", () => {
  it("reads a response body with Network.getResponseBody for the request id the app reported", async () => {
    const api = await startService();
    const app = await connectArmedApp(api);
    for (const frame of [
      ...requestEvents("layer-7", "https://example.com/json"),
      ...finishEvents("layer-7"),
    ]) {
      app.send(frame);
    }
    const id = await recordOf(api, "https://example.com/json");

    const reading = api.networkRecords(BUNDLE)!.responseBody(id);
    await vi.waitFor(() => expect(responseBodyReads(app)).toHaveLength(1));
    const [request] = responseBodyReads(app);
    expect(request).toEqual({
      type: "CDP",
      payload: {
        id: expect.any(Number),
        method: "Network.getResponseBody",
        params: { requestId: "layer-7" },
      },
    });

    app.reply(request!.payload.id!, {
      body: '{"ok":true}',
      base64Encoded: false,
      wasTruncated: false,
    });
    await expect(reading).resolves.toEqual(textBody('{"ok":true}'));
  });

  it("answers a request body the app is still sending after 5 s, asks the app once, and serves its late reply", async () => {
    const api = await startService();
    const app = await connectArmedApp(api);
    for (const frame of requestEvents("upload", "https://example.com/upload", {
      method: "POST",
      hasPostData: true,
    })) {
      app.send(frame);
    }
    const id = await recordOf(api, "https://example.com/upload", "pending");
    const records = api.networkRecords(BUNDLE)!;

    // Only the timers are fake, and only around the two 5 s waits: the socket
    // I/O stays real, as in the Network.enable timeout test, so the frames
    // still cross the socket while the waits are skipped instead of slept.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = records.requestPostData(id);
    await vi.waitFor(() => expect(postDataReads(app)).toHaveLength(1));
    const [request] = postDataReads(app);
    expect(request!.payload).toMatchObject({
      method: "Network.getRequestPostData",
      params: { requestId: "upload" },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const stillSending = noBody("the app is still sending this request body; read it again later");
    await expect(first).resolves.toEqual(stillSending);

    const second = records.requestPostData(id);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(second).resolves.toEqual(stillSending);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(postDataReads(app)).toHaveLength(1);

    // The app answers the first read once it has the whole body. Frames are
    // read in order, so once the request sent after the reply is listed, the
    // reply was read before the next body read.
    app.reply(request!.payload.id!, { postData: "name=demo", base64Encoded: false });
    for (const frame of requestEvents("after", "https://example.com/after")) app.send(frame);
    await recordOf(api, "https://example.com/after", "pending");
    await expect(records.requestPostData(id)).resolves.toEqual(textBody("name=demo"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(postDataReads(app)).toHaveLength(1);
  });

  it("still answers a view read whose reply arrives between two body replies", async () => {
    const api = await startService();
    const app = await connectArmedApp(api);
    for (const frame of [
      ...requestEvents("upload", "https://example.com/upload", {
        method: "POST",
        hasPostData: true,
      }),
      ...finishEvents("upload"),
    ]) {
      app.send(frame);
    }
    const id = await recordOf(api, "https://example.com/upload");
    const records = api.networkRecords(BUNDLE)!;

    // As a details call reads them: the request body, then the response body.
    const postData = records.requestPostData(id);
    const responseBody = records.responseBody(id);
    const view = api.queryViewHierarchy(BUNDLE, "ViewHierarchy.describeScreen");
    await vi.waitFor(() => {
      expect(postDataReads(app)).toHaveLength(1);
      expect(app.received.some((f) => f.type === "ViewInspector")).toBe(true);
    });
    const viewRequest = app.received.find((f) => f.type === "ViewInspector")!;

    app.reply(postDataReads(app)[0]!.payload.id!, { postData: "name=demo", base64Encoded: false });
    await vi.waitFor(() => expect(responseBodyReads(app)).toHaveLength(1));
    app.send({
      type: "ViewInspector",
      payload: { id: viewRequest.payload.id, result: { elements: ["ok"] } },
    });
    app.reply(responseBodyReads(app)[0]!.payload.id!, {
      body: '{"ok":true}',
      base64Encoded: false,
      wasTruncated: false,
    });

    await expect(postData).resolves.toEqual(textBody("name=demo"));
    await expect(view).resolves.toEqual({ elements: ["ok"] });
    await expect(responseBody).resolves.toEqual(textBody('{"ok":true}'));
  });

  it("answers a body never read as gone once the app process ended, and still serves a body read before, after a relaunch too", async () => {
    appRunsAs(4711);
    const api = await startService();
    const app = await connectArmedApp(api);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)!.state().pid).toBe(4711));
    // Every request finished: the host still checks the process after the close.
    for (const frame of [
      ...requestEvents("read", "https://example.com/read"),
      ...finishEvents("read"),
      ...requestEvents("unread", "https://example.com/unread"),
      ...finishEvents("unread"),
    ]) {
      app.send(frame);
    }
    const read = await recordOf(api, "https://example.com/read");
    const unread = await recordOf(api, "https://example.com/unread");
    const records = api.networkRecords(BUNDLE)!;

    const reading = records.responseBody(read);
    await vi.waitFor(() => expect(responseBodyReads(app)).toHaveLength(1));
    app.reply(responseBodyReads(app)[0]!.payload.id!, {
      body: "kept",
      base64Encoded: false,
      wasTruncated: false,
    });
    await expect(reading).resolves.toEqual(textBody("kept"));

    appGone();
    app.close();
    // Until the host check after the close ends, the read says the connection closed.
    await vi.waitFor(async () =>
      expect(await records.responseBody(unread)).toEqual(noBody(PROCESS_GONE))
    );
    await expect(records.responseBody(read)).resolves.toEqual(textBody("kept"));

    // The relaunched app is not asked for the bodies of the process before it.
    appRunsAs(4712);
    const relaunched = await connectApp(api.socketPath, { acknowledge: false });
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));
    await expect(records.responseBody(unread)).resolves.toEqual(noBody(PROCESS_GONE));
    await expect(records.responseBody(read)).resolves.toEqual(textBody("kept"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(responseBodyReads(relaunched)).toHaveLength(0);
  });

  it("answers a body never read as not read before the close while the same process still runs, and as gone once a new process connects", async () => {
    appRunsAs(4711);
    const api = await startService();
    const app = await connectArmedApp(api);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)!.state().pid).toBe(4711));
    for (const frame of [
      ...requestEvents("unread", "https://example.com/unread"),
      ...finishEvents("unread"),
      ...requestEvents("open", "https://example.com/open"),
    ]) {
      app.send(frame);
    }
    const unread = await recordOf(api, "https://example.com/unread");
    const open = await recordOf(api, "https://example.com/open", "pending");
    const records = api.networkRecords(BUNDLE)!;

    app.close();
    // The host check after the close is done once it failed the open request.
    await vi.waitFor(() =>
      expect(records.record(open)?.errorText).toBe(
        "the agent did not reconnect after its connection dropped, so this request's final events never arrived"
      )
    );
    await expect(records.responseBody(unread)).resolves.toEqual(
      noBody("the agent's connection closed before this body was read")
    );

    appRunsAs(4712);
    const next = await connectApp(api.socketPath, { acknowledge: false });
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));
    await expect(records.responseBody(unread)).resolves.toEqual(noBody(PROCESS_GONE));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(responseBodyReads(next)).toHaveLength(0);
  });

  it("answers a body never read as gone after a newer process connected and closed with no request and no read", async () => {
    appRunsAs(4711);
    const api = await startService();
    const app = await connectArmedApp(api);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)!.state().pid).toBe(4711));
    for (const frame of [
      ...requestEvents("unread", "https://example.com/unread"),
      ...finishEvents("unread"),
      ...requestEvents("open", "https://example.com/open"),
    ]) {
      app.send(frame);
    }
    const unread = await recordOf(api, "https://example.com/unread");
    const open = await recordOf(api, "https://example.com/open", "pending");
    const records = api.networkRecords(BUNDLE)!;

    // The host still lists the same process after the close.
    app.close();
    await vi.waitFor(() => expect(records.record(open)?.state).toBe("failed"));

    // A newer process connects, makes no request, and closes before any read.
    appRunsAs(4712);
    const next = await connectArmedApp(api);
    await vi.waitFor(() => expect(records.state().pid).toBe(4712));
    next.close();
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(false));

    await expect(records.responseBody(unread)).resolves.toEqual(noBody(PROCESS_GONE));
  });

  it("never sends a body read queued on a connection that a relaunch replaced to the new process", async () => {
    const api = await startService();
    const app = await connectArmedApp(api);
    for (const frame of [
      ...requestEvents("a", "https://example.com/a"),
      ...finishEvents("a"),
      ...requestEvents("b", "https://example.com/b"),
      ...finishEvents("b"),
    ]) {
      app.send(frame);
    }
    const a = await recordOf(api, "https://example.com/a");
    const b = await recordOf(api, "https://example.com/b");
    const records = api.networkRecords(BUNDLE)!;

    // b waits its turn behind a, and the relaunched app connects before a is answered.
    const reads = Promise.all([records.responseBody(a), records.responseBody(b)]);
    await vi.waitFor(() => expect(responseBodyReads(app)).toHaveLength(1));
    const relaunched = await connectApp(api.socketPath, { acknowledge: false });
    await app.closed;

    await expect(reads).resolves.toEqual([noBody(PROCESS_GONE), noBody(PROCESS_GONE)]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(responseBodyReads(relaunched)).toHaveLength(0);
    expect(responseBodyReads(app)).toHaveLength(1);
  });

  it("sends one body read at a time per app connection, the next once the app answered the first", async () => {
    const api = await startService();
    const app = await connectArmedApp(api);
    for (const frame of [
      ...requestEvents("a", "https://example.com/a"),
      ...finishEvents("a"),
      ...requestEvents("b", "https://example.com/b"),
      ...finishEvents("b"),
    ]) {
      app.send(frame);
    }
    const a = await recordOf(api, "https://example.com/a");
    const b = await recordOf(api, "https://example.com/b");
    const records = api.networkRecords(BUNDLE)!;

    const reads = Promise.all([records.responseBody(a), records.responseBody(b)]);
    await vi.waitFor(() => expect(responseBodyReads(app)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(responseBodyReads(app).map((f) => f.payload.params)).toEqual([{ requestId: "a" }]);

    app.reply(responseBodyReads(app)[0]!.payload.id!, {
      body: "first",
      base64Encoded: false,
      wasTruncated: false,
    });
    await vi.waitFor(() => expect(responseBodyReads(app)).toHaveLength(2));
    expect(responseBodyReads(app)[1]!.payload.params).toEqual({ requestId: "b" });
    app.reply(responseBodyReads(app)[1]!.payload.id!, {
      body: "second",
      base64Encoded: false,
      wasTruncated: false,
    });

    await expect(reads).resolves.toEqual([textBody("first"), textBody("second")]);
  });
});
