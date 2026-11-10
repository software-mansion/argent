import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Registry, type DeviceInfo } from "@argent/registry";

// The native-devtools service starts and stops network capture with CDP
// requests on the app's socket and reads the app's pid from the host. These tests drive the
// real service with a fake app on that socket.

const probe = vi.hoisted(() => ({ launchctlList: "", psOutput: "" }));

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
        callback(null, { stdout: probe.psOutput, stderr: "" });
        return;
      }
      if (argv.includes("launchctl list")) {
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
import { liveIosNetworkCaptures } from "../src/blueprints/ios-network-records";
import { createNativeNetworkLogsTool } from "../src/tools/native-devtools/native-network-logs";
import type { NativeNetworkRecord } from "../src/utils/native-network-record";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import { resolveDevice } from "../src/utils/device-info";
import {
  __resetExternalDeviceCacheForTesting,
  __resetProviderWarningsForTesting,
  makeExternalId,
} from "../src/utils/external-devices";
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

/** Calls `onFrame` with each newline-delimited JSON frame the socket reads. */
function readFrames(sock: net.Socket, onFrame: (frame: Frame) => void): void {
  let buffer = "";
  sock.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) onFrame(JSON.parse(line) as Frame);
  });
}

/**
 * Dials the service's socket as the app does and records every frame it is
 * sent. With `acknowledge`, it answers every CDP request at once; without it,
 * the test answers them. Network.disable is answered at once either way, so a
 * dispose does not wait for it, unless `holdDisable`.
 */
async function connectApp(
  socketPath: string,
  {
    acknowledge = true,
    holdDisable = false,
    bundleId = BUNDLE,
  }: { acknowledge?: boolean; holdDisable?: boolean; bundleId?: string } = {}
): Promise<FakeApp> {
  const received: Frame[] = [];
  const sock = net.createConnection(socketPath);
  await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
  const write = (frame: Frame): void => {
    sock.write(JSON.stringify(frame) + "\n");
  };
  readFrames(sock, (frame) => {
    received.push(frame);
    if (frame.type !== "CDP" || frame.payload.id === undefined) return;
    const answers = frame.payload.method === "Network.disable" ? !holdDisable : acknowledge;
    if (answers) write({ type: "CDP", payload: { id: frame.payload.id, result: {} } });
  });
  const closed = new Promise<void>((resolve) => sock.once("close", () => resolve()));
  write({ type: "Control", payload: { bundleId } });
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
const disableRequests = (app: FakeApp): Frame[] => cdpRequests(app, "Network.disable");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Settles with what `promise` resolved to, or "pending" when it has not within 50 ms. */
const within50ms = <T>(promise: Promise<T>): Promise<T | "pending"> =>
  Promise.race([promise, sleep(50).then(() => "pending" as const)]);

/** The number in an ios- record id, which grows with each record the tool-server issues. */
const numberOf = (id: string): number => Number(id.split("-")[2]);

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

/** Connects the app with capture started for it, and acknowledges its Network.enable. */
async function connectArmedApp(api: NativeDevtoolsApi): Promise<FakeApp> {
  await api.startNetworkCapture(BUNDLE, 8081);
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

    const arming = api.startNetworkCapture(BUNDLE, 8081);
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

    // Armed already: a second start sends nothing.
    await expect(api.startNetworkCapture(BUNDLE, 8081)).resolves.toBe(true);
    expect(enableRequests(app)).toHaveLength(1);
  });

  it("enables capture at the handshake of an app it is on for, also one that never connected before", async () => {
    const api = await startService();
    await expect(api.startNetworkCapture(BUNDLE, 8081)).resolves.toBe(false);
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

  it("keeps an app that does not answer within 5 s connected and unarmed, and asks again at the next start", async () => {
    const api = await startService();
    const app = await connectApp(api.socketPath, { acknowledge: false });
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const arming = api.startNetworkCapture(BUNDLE, 8081);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(arming).resolves.toBe(false);
    vi.useRealTimers();

    expect(api.isConnected(BUNDLE)).toBe(true);
    expect(api.networkRecords(BUNDLE)!.state()).toEqual({
      armed: false,
      note: "the agent did not acknowledge Network.enable within 5 s; network-capture-start asks again",
    });

    const again = api.startNetworkCapture(BUNDLE, 8081);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(2));
    app.reply(enableRequests(app)[1]!.payload.id!);
    await expect(again).resolves.toBe(true);

    // The late reply to the first request is ignored.
    app.reply(enableRequests(app)[0]!.payload.id!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.isConnected(BUNDLE)).toBe(true);
  });

  it("keeps an app that answers Network.enable with an error connected and unarmed, and asks again at the next start", async () => {
    const api = await startService();
    const app = await connectApp(api.socketPath, { acknowledge: false });
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));

    const arming = api.startNetworkCapture(BUNDLE, 8081);
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
      note: `the agent did not enable capture (native-devtools ${BUNDLE}: Network.enable failed: capture unavailable); network-capture-start asks again`,
    });

    const again = api.startNetworkCapture(BUNDLE, 8081);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(2));
    app.reply(enableRequests(app)[1]!.payload.id!, {});
    await expect(again).resolves.toBe(true);
    expect(api.networkRecords(BUNDLE)!.state()).toEqual({ armed: true });
  });

  it("still answers view reads while capture replies and events flow, and drops a reply with an unknown id", async () => {
    const api = await startService();
    const app = await connectApp(api.socketPath);
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));
    await api.startNetworkCapture(BUNDLE, 8081);

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
    await api.startNetworkCapture(BUNDLE, 8081);
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
    await api.startNetworkCapture(BUNDLE, 8081);
    await connectApp(api.socketPath);

    await vi.waitFor(() =>
      expect(api.networkRecords(BUNDLE)?.state()).toEqual({ armed: true, pid: 4711 })
    );
  });

  it("fails open requests as not reconnected when the same process still runs after its connection closed", async () => {
    appRunsAs(4711);
    const api = await startService();
    await api.startNetworkCapture(BUNDLE, 8081);
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

  it("fails open requests as ended when the process is gone after its connection closed", async () => {
    appRunsAs(4711);
    const api = await startService();
    await api.startNetworkCapture(BUNDLE, 8081);
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
    await api.startNetworkCapture(BUNDLE, 8081);
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

  it("drops the app's captures and records from the lookups on dispose", async () => {
    const api = await startService();
    await api.startNetworkCapture(BUNDLE, 8081);
    await connectApp(api.socketPath);
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().armed).toBe(true));
    expect(liveIosNetworkCaptures(UDID)).toEqual([BUNDLE]);

    await instance!.dispose();
    instance = null;
    expect(liveIosNetworkCaptures(UDID)).toEqual([]);
    expect(api.networkRecords(BUNDLE)).toBeUndefined();
  });

  it("settles an enable still waiting for its reply as not armed at once on dispose", async () => {
    const api = await startService();
    const app = await connectApp(api.socketPath, { acknowledge: false });
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));

    const arming = api.startNetworkCapture(BUNDLE, 8081);
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
});

describe("native-devtools network capture stop", () => {
  it("stops capture with a Network.disable CDP request, and no later connection of the app is armed", async () => {
    const api = await startService();
    await api.startNetworkCapture(BUNDLE, 8081);
    const app = await connectApp(api.socketPath, { holdDisable: true });
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().armed).toBe(true));
    expect(liveIosNetworkCaptures(UDID)).toEqual([BUNDLE]);

    const stopping = api.stopNetworkCapture(BUNDLE);
    await vi.waitFor(() => expect(disableRequests(app)).toHaveLength(1));
    expect(disableRequests(app)[0]).toEqual({
      type: "CDP",
      payload: { id: expect.any(Number), method: "Network.disable", params: {} },
    });
    expect(await within50ms(stopping)).toBe("pending");
    app.reply(disableRequests(app)[0]!.payload.id!);
    await expect(stopping).resolves.toEqual({ confirmed: true });

    expect(api.isNetworkCaptureStarted(BUNDLE)).toBe(false);
    expect(api.isNetworkCaptureStopped(BUNDLE)).toBe(true);
    expect(api.networkRecords(BUNDLE)!.state().armed).toBe(false);
    // No profile is warned about an app whose capture is stopped.
    expect(liveIosNetworkCaptures(UDID)).toEqual([]);

    // A relaunch: its handshake is not asked to capture.
    const relaunched = await connectApp(api.socketPath);
    await app.closed;
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));
    await sleep(50);
    expect(enableRequests(relaunched)).toHaveLength(0);
    expect(api.networkRecords(BUNDLE)!.state().armed).toBe(false);
  });

  it("says a stop the app does not acknowledge within 5 s is not confirmed", async () => {
    const api = await startService();
    await api.startNetworkCapture(BUNDLE, 8081);
    const app = await connectApp(api.socketPath, { holdDisable: true });
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().armed).toBe(true));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopping = api.stopNetworkCapture(BUNDLE);
    await vi.waitFor(() => expect(disableRequests(app)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(stopping).resolves.toEqual({
      confirmed: false,
      reason:
        "the app did not acknowledge Network.disable within 5 s; argent records none of its new requests, and its next process starts without capture",
    });
    vi.useRealTimers();
    expect(api.isNetworkCaptureStopped(BUNDLE)).toBe(true);

    // So the dispose after the test has no app to wait for.
    app.close();
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(false));
  });

  it("records no new request of a stopped app, and completes the one in flight at the stop", async () => {
    const api = await startService();
    const app = await connectArmedApp(api);
    for (const frame of requestEvents("open", "https://example.com/open")) app.send(frame);
    await recordOf(api, "https://example.com/open", "pending");

    await expect(api.stopNetworkCapture(BUNDLE)).resolves.toEqual({ confirmed: true });
    for (const frame of [
      ...requestEvents("new", "https://example.com/new"),
      ...finishEvents("open"),
    ]) {
      app.send(frame);
    }

    // Frames are read in order, so the new request was read before the finish.
    await recordOf(api, "https://example.com/open");
    expect(
      api
        .networkRecords(BUNDLE)!
        .records(8081)
        .map((r) => r.request.url)
    ).toEqual(["https://example.com/open"]);
  });

  it("does not arm an app whose Network.enable reply comes after its stop, and sends Network.enable again at the next start", async () => {
    const api = await startService();
    const app = await connectApp(api.socketPath, { acknowledge: false });
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));

    const arming = api.startNetworkCapture(BUNDLE, 8081);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(1));
    await expect(api.stopNetworkCapture(BUNDLE)).resolves.toEqual({ confirmed: true });
    app.reply(enableRequests(app)[0]!.payload.id!);
    await expect(arming).resolves.toBe(false);
    expect(api.networkRecords(BUNDLE)!.state().armed).toBe(false);

    const again = api.startNetworkCapture(BUNDLE, 8081);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(2));
    app.reply(enableRequests(app)[1]!.payload.id!);
    await expect(again).resolves.toBe(true);
  });

  it("sends Network.enable again at a start right after a stop, while the enable the stop met is unanswered", async () => {
    const api = await startService();
    const app = await connectApp(api.socketPath, { acknowledge: false });
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));

    void api.startNetworkCapture(BUNDLE, 8081);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(1));
    await expect(api.stopNetworkCapture(BUNDLE)).resolves.toEqual({ confirmed: true });

    const again = api.startNetworkCapture(BUNDLE, 8081);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(2));
    app.reply(enableRequests(app)[1]!.payload.id!);
    await expect(again).resolves.toBe(true);
    expect(api.networkRecords(BUNDLE)!.state().armed).toBe(true);
  });

  it("arms the app again at a start after a stop, once it acknowledges Network.enable", async () => {
    const api = await startService();
    const app = await connectArmedApp(api);
    await api.stopNetworkCapture(BUNDLE);

    const arming = api.startNetworkCapture(BUNDLE, 8081);
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(2));
    expect(await within50ms(arming)).toBe("pending");
    expect(api.isNetworkCaptureStopped(BUNDLE)).toBe(false);

    app.reply(enableRequests(app)[1]!.payload.id!);
    await expect(arming).resolves.toBe(true);
    expect(api.isNetworkCaptureStarted(BUNDLE)).toBe(true);
    expect(liveIosNetworkCaptures(UDID)).toEqual([BUNDLE]);
    for (const frame of requestEvents("next", "https://example.com/next")) app.send(frame);
    await recordOf(api, "https://example.com/next", "pending");
  });

  it("marks where a start begins before it arms the app, so a request during the arming counts", async () => {
    const api = await startService();
    const app = await connectArmedApp(api);
    for (const frame of [
      ...requestEvents("before", "https://example.com/before"),
      ...finishEvents("before"),
    ]) {
      app.send(frame);
    }
    const before = await recordOf(api, "https://example.com/before");
    await api.stopNetworkCapture(BUNDLE);

    const arming = api.startNetworkCapture(BUNDLE, 8190);
    const mark = api.networkCaptureMark(BUNDLE);
    expect(mark).toEqual({ lastRecord: numberOf(before), metroPort: 8190 });
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(2));
    for (const frame of requestEvents("during", "https://example.com/during")) app.send(frame);
    const during = await recordOf(api, "https://example.com/during", "pending");
    expect(numberOf(during)).toBeGreaterThan(mark!.lastRecord);

    app.reply(enableRequests(app)[1]!.payload.id!);
    await expect(arming).resolves.toBe(true);
  });

  it("says at a launch that capture is stopped for the app until the next start", async () => {
    const api = await startService();
    await connectArmedApp(api);
    await api.stopNetworkCapture(BUNDLE);

    await expect(api.networkCaptureAfterLaunch(BUNDLE)).resolves.toBe(
      `native network capture is stopped for ${BUNDLE} (network-capture-stop); this process runs without it until network-capture-start`
    );
  });

  it("says at a launch that capture is stopped when the stop comes while it waits for the new process to arm", async () => {
    appRunsAs(200);
    const api = await startService();
    await api.startNetworkCapture(BUNDLE, 8081);
    // The launched process connected and has not answered Network.enable.
    const app = await connectApp(api.socketPath, { acknowledge: false });
    await vi.waitFor(() => expect(enableRequests(app)).toHaveLength(1));
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().pid).toBe(200));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const launched = api.networkCaptureAfterLaunch(BUNDLE).finally(() => {
      settled = true;
    });
    // The wait for the process to arm is the only timer on the fake clock.
    for (let i = 0; i < 100 && vi.getTimerCount() === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(vi.getTimerCount()).toBe(1);

    await expect(api.stopNetworkCapture(BUNDLE)).resolves.toEqual({ confirmed: true });
    expect(disableRequests(app)).toHaveLength(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(launched).resolves.toBe(
      `native network capture is stopped for ${BUNDLE} (network-capture-stop); this process runs without it until network-capture-start`
    );
  });

  const STOPPED_NOTE = `native network capture is stopped for ${BUNDLE} (network-capture-stop); this process runs without it until network-capture-start`;

  /** Arms the app as pid 200, then stops its capture with a Network.disable the app does not answer. */
  async function stopUnacknowledged(api: NativeDevtoolsApi): Promise<FakeApp> {
    appRunsAs(200);
    await api.startNetworkCapture(BUNDLE, 8081);
    const app = await connectApp(api.socketPath, { holdDisable: true });
    await vi.waitFor(() =>
      expect(api.networkRecords(BUNDLE)?.state()).toMatchObject({ armed: true, pid: 200 })
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopping = api.stopNetworkCapture(BUNDLE);
    await vi.waitFor(() => expect(disableRequests(app)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(stopping).resolves.toMatchObject({ confirmed: false });
    vi.useRealTimers();
    return app;
  }

  it("says at a launch that the process which did not acknowledge the stop may still capture, and names the app to profiles until its connection closes", async () => {
    const api = await startService();
    const app = await stopUnacknowledged(api);

    await expect(api.networkCaptureAfterLaunch(BUNDLE)).resolves.toBe(
      `native network capture is stopped for ${BUNDLE} (network-capture-stop), but its running process (pid 200) has not acknowledged Network.disable, so it may still intercept its requests; argent records none of them, and restart-app starts a process without capture`
    );
    expect(liveIosNetworkCaptures(UDID)).toEqual([BUNDLE]);
    expect(api.isNetworkCaptureStarted(BUNDLE)).toBe(false);
    // A launch that started a new process before the old connection closed.
    appRunsAs(201);
    await expect(api.networkCaptureAfterLaunch(BUNDLE)).resolves.toBe(STOPPED_NOTE);

    app.close();
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(false));
    await expect(api.networkCaptureAfterLaunch(BUNDLE)).resolves.toBe(STOPPED_NOTE);
    expect(liveIosNetworkCaptures(UDID)).toEqual([]);

    // A relaunch: its handshake is not asked to capture.
    const relaunched = await connectApp(api.socketPath);
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));
    await sleep(50);
    expect(enableRequests(relaunched)).toHaveLength(0);
  });

  it("forgets a stop the process did not acknowledge once the process acknowledges a later Network.disable", async () => {
    const api = await startService();
    const app = await stopUnacknowledged(api);
    expect(liveIosNetworkCaptures(UDID)).toEqual([BUNDLE]);

    const again = api.stopNetworkCapture(BUNDLE);
    await vi.waitFor(() => expect(disableRequests(app)).toHaveLength(2));
    app.reply(disableRequests(app)[1]!.payload.id!);
    await expect(again).resolves.toEqual({ confirmed: true });
    await expect(api.networkCaptureAfterLaunch(BUNDLE)).resolves.toBe(STOPPED_NOTE);
    expect(liveIosNetworkCaptures(UDID)).toEqual([]);

    // So the dispose after the test has no app to wait for.
    app.close();
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(false));
  });
});

describe("native-devtools dispose with network capture", () => {
  it("sends Network.disable to each app it started or stopped before it closes their connections", async () => {
    const api = await startService();
    const connect = (bundleId: string) =>
      connectApp(api.socketPath, { bundleId, acknowledge: false, holdDisable: true });
    const armed = await connect("com.example.armed");
    const unanswered = await connect("com.example.unanswered");
    const stopped = await connect("com.example.stopped");
    const never = await connect("com.example.never");
    await vi.waitFor(() => expect(api.listConnectedBundleIds()).toHaveLength(4));

    const arming = api.startNetworkCapture("com.example.armed", 8081);
    await vi.waitFor(() => expect(enableRequests(armed)).toHaveLength(1));
    armed.reply(enableRequests(armed)[0]!.payload.id!);
    await expect(arming).resolves.toBe(true);
    // Still without its Network.enable reply at the dispose.
    void api.startNetworkCapture("com.example.unanswered", 8081);
    await vi.waitFor(() => expect(enableRequests(unanswered)).toHaveLength(1));
    // Armed, then stopped by a Network.disable it never answers.
    const armingStopped = api.startNetworkCapture("com.example.stopped", 8081);
    await vi.waitFor(() => expect(enableRequests(stopped)).toHaveLength(1));
    stopped.reply(enableRequests(stopped)[0]!.payload.id!);
    await expect(armingStopped).resolves.toBe(true);
    void api.stopNetworkCapture("com.example.stopped");
    await vi.waitFor(() => expect(disableRequests(stopped)).toHaveLength(1));

    const disposing = instance!.dispose();
    instance = null;
    await vi.waitFor(() => {
      expect(disableRequests(armed)).toHaveLength(1);
      expect(disableRequests(unanswered)).toHaveLength(1);
      expect(disableRequests(stopped)).toHaveLength(2);
    });
    // Each connection stays open until its app answers.
    expect(await within50ms(Promise.race([armed.closed, unanswered.closed, stopped.closed]))).toBe(
      "pending"
    );

    for (const app of [armed, unanswered, stopped]) {
      app.reply(disableRequests(app).at(-1)!.payload.id!);
    }
    await disposing;
    await Promise.all([armed.closed, unanswered.closed, stopped.closed, never.closed]);
    expect(never.received.filter((f) => f.type === "CDP")).toEqual([]);
  });

  it("ends a dispose after 1 s when an app does not answer Network.disable", async () => {
    const api = await startService();
    await api.startNetworkCapture(BUNDLE, 8081);
    const app = await connectApp(api.socketPath, { holdDisable: true });
    await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().armed).toBe(true));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let disposed = false;
    const disposing = instance!.dispose().then(() => {
      disposed = true;
    });
    instance = null;
    // vi.waitFor would move the fake clock, so wait for the frame on I/O turns.
    while (disableRequests(app).length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await vi.advanceTimersByTimeAsync(900);
    expect(disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await disposing;
    vi.useRealTimers();
    await app.closed;
  });
});

describe("native-devtools network capture on a lent agent", () => {
  const PROVIDER_ID = "acme-3f2a9c";
  const LENT_UDID = processScopedUdid("-1111-2222-3333-444444444444");
  const LENT_DEVICE_ID = makeExternalId(PROVIDER_ID, LENT_UDID);

  interface LentAgent {
    received: Frame[];
    /** What the provider answers when asked whether capture is on for the app. */
    captureOn: boolean;
    send(frame: Frame): void;
    close(): Promise<void>;
  }

  let dir: string;
  let agent: LentAgent | null = null;

  /**
   * Plays a device provider that lends the app's agent: it publishes the
   * device and serves the socket the service dials, opening with the app's
   * handshake and answering every CDP request.
   */
  async function lendAgent(): Promise<LentAgent> {
    const socketPath = path.join(dir, "agent.sock");
    const sockets: net.Socket[] = [];
    const write = (socket: net.Socket, frame: Frame) => socket.write(JSON.stringify(frame) + "\n");
    const server = net.createServer((socket) => {
      sockets.push(socket);
      readFrames(socket, (frame) => {
        lent.received.push(frame);
        if (frame.type !== "CDP" || frame.payload.id === undefined) return;
        const result =
          frame.payload.method === "NativeDevtoolsIos.getConditions"
            ? { enabled: lent.captureOn }
            : {};
        write(socket, { type: "CDP", payload: { id: frame.payload.id, result } });
      });
      write(socket, { type: "Control", payload: { bundleId: BUNDLE } });
    });
    const lent: LentAgent = {
      received: [],
      captureOn: true,
      send: (frame) => {
        for (const socket of sockets) write(socket, frame);
      },
      close: () =>
        new Promise((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    };
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const descriptorPath = path.join(dir, "acme.json");
    fs.writeFileSync(
      descriptorPath,
      JSON.stringify({
        devices: [
          {
            capabilities: ["native-devtools", "simctl"],
            kind: "simulator",
            name: "iPhone 16 Pro",
            nativeDevtools: { socketPath },
            nativeId: LENT_UDID,
            platform: "ios",
            state: "Booted",
          },
        ],
        id: PROVIDER_ID,
        name: "Acme IDE",
        schemaVersion: 1,
      })
    );
    process.env.ARGENT_DEVICE_PROVIDERS = descriptorPath;
    agent = lent;
    return lent;
  }

  async function startLentService(): Promise<NativeDevtoolsApi> {
    const lentDevice = resolveDevice(LENT_DEVICE_ID);
    instance = await nativeDevtoolsBlueprint.factory({}, lentDevice, { device: lentDevice });
    const api = instance.api as NativeDevtoolsApi;
    await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));
    return api;
  }

  const cdpMethods = (lent: LentAgent) =>
    lent.received.filter((f) => f.type === "CDP").map((f) => f.payload.method);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-lent-"));
    delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
    __resetExternalDeviceCacheForTesting();
    __resetProviderWarningsForTesting();
    __resetDepCacheForTests();
    // The read checks for xcrun first, and Linux CI has none. Nothing runs it.
    __primeDepCacheForTests(["xcrun"]);
  });

  afterEach(async () => {
    await instance?.dispose();
    instance = null;
    await agent?.close();
    agent = null;
    delete process.env.ARGENT_DEVICE_PROVIDERS;
    process.env.ARGENT_DISABLE_DEVICE_PROVIDERS = "1";
    __resetExternalDeviceCacheForTesting();
    __resetDepCacheForTests();
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it("sends no Network.disable at a stop or a dispose, and records none of the app's new requests after the stop", async () => {
    const lent = await lendAgent();
    const api = await startLentService();
    await expect(api.startNetworkCapture(BUNDLE, 8081)).resolves.toBe(true);
    for (const frame of requestEvents("open", "https://example.com/open")) lent.send(frame);
    await recordOf(api, "https://example.com/open", "pending");

    await expect(api.stopNetworkCapture(BUNDLE)).resolves.toEqual({
      confirmed: true,
      reason:
        "the device provider keeps its own capture setting for the app; argent records none of its new requests",
    });
    for (const frame of [
      ...requestEvents("new", "https://example.com/new"),
      ...finishEvents("open"),
    ]) {
      lent.send(frame);
    }
    await recordOf(api, "https://example.com/open");
    expect(
      api
        .networkRecords(BUNDLE)!
        .records(8081)
        .map((r) => r.request.url)
    ).toEqual(["https://example.com/open"]);

    await instance!.dispose();
    instance = null;
    // The provider owns the agent's capture setting, so argent only read it.
    expect(cdpMethods(lent)).toEqual(["NativeDevtoolsIos.getConditions"]);
  });

  it("asks the provider again at each read of a started app whether capture is on", async () => {
    const lent = await lendAgent();
    const api = await startLentService();
    await expect(api.startNetworkCapture(BUNDLE, 8081)).resolves.toBe(true);
    const tool = createNativeNetworkLogsTool(new Registry());
    const read = () =>
      tool.execute(
        { nativeDevtools: api },
        { udid: LENT_DEVICE_ID, bundleId: BUNDLE, limit: 50, clear: false }
      ) as Promise<{ armed: boolean; header: string }>;

    expect(await read()).toMatchObject({ armed: true });
    lent.captureOn = false;
    const off = await read();

    expect(off.armed).toBe(false);
    expect(off.header).toMatch(
      /^ios-native: not armed, 0 requests \(the device provider has capture off for the app; argent does not turn it on/
    );
    expect(cdpMethods(lent)).toEqual([
      "NativeDevtoolsIos.getConditions",
      "NativeDevtoolsIos.getConditions",
      "NativeDevtoolsIos.getConditions",
    ]);
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
