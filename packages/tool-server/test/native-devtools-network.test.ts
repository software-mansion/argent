import { afterEach, describe, expect, it, vi } from "vitest";
import * as net from "node:net";
import type { DeviceInfo } from "@argent/registry";

// The native-devtools service arms network capture with a CDP request on the
// app's socket and reads the app's pid from the host. These tests drive the
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

const enableRequests = (app: FakeApp): Frame[] =>
  app.received.filter((f) => f.type === "CDP" && f.payload.method === "Network.enable");

function requestEvents(requestId: string, url: string): Frame[] {
  return [
    {
      type: "CDP",
      payload: {
        method: "Network.requestWillBeSent",
        params: {
          requestId,
          wallTime: 1_700_000_000,
          request: { url, method: "GET", headers: {} },
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
});
