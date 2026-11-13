import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as net from "node:net";
import { Registry } from "@argent/registry";

// native-network-logs on a local iOS simulator, end to end on the host side:
// the real native-devtools service, a fake app on its socket feeding Network.*
// events, and the tool reading the records back.

type ExecCb = (err: Error | null, out: { stdout: string; stderr: string }) => void;
const sim = vi.hoisted(() => ({
  /** What `launchctl list` prints inside the simulator. */
  launchctlList: "",
  /** What `ps` prints for the app's process. */
  psOutput: "",
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (cmd: string, args: readonly string[], opts: unknown, cb?: ExecCb) => {
      const callback = (typeof opts === "function" ? opts : cb!) as ExecCb;
      const argv = args.join(" ");
      if (/\bps$/.test(cmd)) {
        callback(null, { stdout: sim.psOutput, stderr: "" });
        return;
      }
      if (argv.includes("launchctl list")) {
        callback(null, { stdout: sim.launchctlList, stderr: "" });
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

vi.mock("@argent/native-devtools-ios", () => ({
  bootstrapDylibPath: () => "/fake/dylibs/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTcp: () => "/fake/dylibs/tcp/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTvos: () => "/fake/dylibs/tvos/libArgentInjectionBootstrap.dylib",
  tcpInjectionDylibs: () => [],
  axServiceBinaryPath: () => "/fake/ax-service",
  axServiceBinaryPathTcp: () => "/fake/ax-service-tcp",
}));

import { nativeDevtoolsBlueprint, type NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import { createNativeNetworkLogsTool } from "../src/tools/native-devtools/native-network-logs";
import { resolveDevice } from "../src/utils/device-info";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import { processScopedUdid } from "./helpers/process-scoped-udid";

const UDID = processScopedUdid("-2C4E-4F60-8A1B-3D5E7F9A0B12");
const BUNDLE = "com.example.networktest";
const PID = 4242;
const IOS_ID = /^ios-[0-9a-f]{4}-\d+$/;
const PROCESS_ENDED = "the app process ended before the request finished";
const NOT_RECONNECTED =
  "the agent did not reconnect after its connection dropped, so this request's final events never arrived";

const tool = createNativeNetworkLogsTool(new Registry());

/** One `launchctl list` row in the real `<pid>\t<status>\t<label>` shape. */
function runningRow(pid: number): string {
  return `${pid}\t0\tUIKitApplication:${BUNDLE}[a1b2][rb-legacy]\n`;
}

interface FakeApp {
  send(frame: unknown): void;
  close(): void;
}

/**
 * Dials the service as the app's in-app agent does, acknowledging each CDP
 * request. With `enableError`, it answers Network.enable with that error instead.
 */
function connectApp(
  socketPath: string,
  { enableError }: { enableError?: string } = {}
): Promise<FakeApp> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const sock = net.createConnection(socketPath, () => {
      sock.write(JSON.stringify({ type: "Control", payload: { bundleId: BUNDLE } }) + "\n");
      resolve({
        send: (frame) => sock.write(JSON.stringify(frame) + "\n"),
        close: () => sock.destroy(),
      });
    });
    sock.once("error", reject);
    sock.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        const frame = JSON.parse(line) as {
          type?: string;
          payload?: { id?: number; method?: string };
        };
        if (frame.type === "CDP" && frame.payload?.id !== undefined) {
          const { id, method } = frame.payload;
          const reply =
            enableError !== undefined && method === "Network.enable"
              ? { id, error: { message: enableError } }
              : { id, result: {} };
          sock.write(JSON.stringify({ type: "CDP", payload: reply }) + "\n");
        }
      }
    });
  });
}

/**
 * The app connecting with capture already on for it, as after a launch: its
 * connection is armed at the handshake, so nothing before it was missed.
 * Resolves once that connection is armed and the host has read `pid`, the
 * process `launchctl list` names (`null` when it names none).
 */
async function launchApp(api: NativeDevtoolsApi, pid: number | null = PID): Promise<FakeApp> {
  await api.activateNetworkInspection(BUNDLE);
  const app = await connectApp(api.socketPath);
  await vi.waitFor(() => {
    const state = api.networkRecords(BUNDLE)?.state();
    expect(state?.armed).toBe(true);
    expect(state?.pid).toBe(pid ?? undefined);
  });
  return app;
}

const cdp = (method: string, params: Record<string, unknown>) => ({
  type: "CDP",
  payload: { method, params },
});

function startRequest(app: FakeApp, requestId: string, url: string, method = "GET"): void {
  app.send(
    cdp("Network.requestWillBeSent", {
      requestId,
      wallTime: 1_700_000_000.25,
      request: { url, method, headers: {} },
    })
  );
}

function respond(app: FakeApp, requestId: string, url: string, status = 200): void {
  app.send(
    cdp("Network.responseReceived", {
      requestId,
      type: "XHR",
      response: { url, status, headers: {}, mimeType: "text/plain" },
    })
  );
}

function finish(app: FakeApp, requestId: string, durationMs: number): void {
  app.send(
    cdp("Network.loadingFinished", {
      requestId,
      encodedDataLength: 128,
      nativeDevtoolsDurationMs: durationMs,
    })
  );
}

function completeRequest(
  app: FakeApp,
  requestId: string,
  url: string,
  { method = "GET", durationMs = 42 }: { method?: string; durationMs?: number } = {}
): void {
  startRequest(app, requestId, url, method);
  respond(app, requestId, url);
  finish(app, requestId, durationMs);
}

/** Waits until the service holds `count` records, the last of them in `state`. */
async function recorded(api: NativeDevtoolsApi, count: number, state = "complete") {
  await vi.waitFor(() => {
    // Port 1 is never a request's, so this sees every record still listed.
    const records = api.networkRecords(BUNDLE)?.records(1) ?? [];
    expect(records).toHaveLength(count);
    expect(records.at(-1)?.state).toBe(state);
  });
}

async function withService(run: (api: NativeDevtoolsApi) => Promise<void>): Promise<void> {
  const device = resolveDevice(UDID);
  const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
  try {
    await run(instance.api as NativeDevtoolsApi);
  } finally {
    await instance.dispose();
  }
}

interface Listing {
  status: string;
  header: string;
  armed: boolean;
  count: number;
  total: number;
  requests: Array<Record<string, unknown>>;
}

async function list(
  api: NativeDevtoolsApi,
  params: { port?: number; limit?: number; clear?: boolean } = {}
): Promise<Listing> {
  return (await tool.execute(
    { nativeDevtools: api },
    { udid: UDID, bundleId: BUNDLE, limit: 50, clear: false, ...params }
  )) as unknown as Listing;
}

const urls = (listing: Listing) => listing.requests.map((line) => line.url);

let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetDepCacheForTests();
  __primeDepCacheForTests(["xcrun"]);
  sim.launchctlList = runningRow(PID);
  sim.psOutput = `00:02 /Devices/${UDID}/NetworkTest.app/NetworkTest HOME=/tmp\n`;
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderr.mockRestore();
});

describe("native-network-logs lists an iOS app's native requests", () => {
  it("lists each request with its id, method, URL, state, status, MIME type and duration", async () => {
    await withService(async (api) => {
      const app = await launchApp(api);
      completeRequest(app, "r1", "https://api.example.com/items", { durationMs: 42 });
      completeRequest(app, "r2", "https://api.example.com/items/7", {
        method: "POST",
        durationMs: 17,
      });
      await recorded(api, 2);

      const listing = await list(api);

      expect(listing).toEqual({
        status: "ok",
        header: `ios-native: armed, 2 requests (pid ${PID})`,
        armed: true,
        count: 2,
        total: 2,
        requests: [
          {
            id: expect.stringMatching(IOS_ID),
            method: "GET",
            url: "https://api.example.com/items",
            state: "complete",
            status: 200,
            mimeType: "text/plain",
            durationMs: 42,
          },
          {
            id: expect.stringMatching(IOS_ID),
            method: "POST",
            url: "https://api.example.com/items/7",
            state: "complete",
            status: 200,
            mimeType: "text/plain",
            durationMs: 17,
          },
        ],
      });
      expect(listing.requests[0]!.id).not.toBe(listing.requests[1]!.id);
      app.close();
    });
  });

  it("leaves the pid out of the header when the host could not read one", async () => {
    sim.launchctlList = "";
    await withService(async (api) => {
      const app = await launchApp(api, null);
      completeRequest(app, "r1", "https://api.example.com/a");
      await recorded(api, 1);

      const listing = await list(api);

      expect(listing.header).toBe("ios-native: armed, 1 request");
      app.close();
    });
  });

  it("says in the header why capture is not armed when the agent refuses Network.enable", async () => {
    await withService(async (api) => {
      await api.activateNetworkInspection(BUNDLE);
      const app = await connectApp(api.socketPath, { enableError: "capture unavailable" });
      await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.state().pid).toBe(PID));

      const listing = await list(api);

      expect(listing.armed).toBe(false);
      expect(listing.header).toBe(
        `ios-native: not armed, 0 requests (pid ${PID}; the agent did not enable capture ` +
          `(native-devtools ${BUNDLE}: Network.enable failed: capture unavailable); the next call asks again)`
      );
      app.close();
    });
  });

  it("lists a request in flight as pending, then with its response as headers", async () => {
    await withService(async (api) => {
      const app = await launchApp(api);
      startRequest(app, "r1", "https://api.example.com/slow");
      await recorded(api, 1, "pending");

      const pending = await list(api);
      expect(pending.requests).toEqual([
        {
          id: expect.stringMatching(IOS_ID),
          method: "GET",
          url: "https://api.example.com/slow",
          state: "pending",
        },
      ]);

      respond(app, "r1", "https://api.example.com/slow");
      await recorded(api, 1, "headers");

      const headers = await list(api);
      expect(headers.requests).toEqual([
        {
          id: pending.requests[0]!.id,
          method: "GET",
          url: "https://api.example.com/slow",
          state: "headers",
          status: 200,
          mimeType: "text/plain",
        },
      ]);
      app.close();
    });
  });

  it("leaves out Metro's own traffic on the given port and keeps it on another", async () => {
    await withService(async (api) => {
      const app = await launchApp(api);
      completeRequest(app, "bundle", "http://localhost:8081/index.bundle?platform=ios&dev=true");
      completeRequest(app, "api", "https://api.example.com/items");
      await recorded(api, 2);

      const onMetroPort = await list(api, { port: 8081 });
      expect(urls(onMetroPort)).toEqual(["https://api.example.com/items"]);
      expect(onMetroPort.total).toBe(1);

      // Omitted, the port is this device's, 8081.
      expect(urls(await list(api))).toEqual(["https://api.example.com/items"]);

      const onOtherPort = await list(api, { port: 8082 });
      expect(urls(onOtherPort)).toEqual([
        "http://localhost:8081/index.bundle?platform=ios&dev=true",
        "https://api.example.com/items",
      ]);
      expect(onOtherPort.total).toBe(2);
      app.close();
    });
  });

  it("returns the newest requests up to limit, oldest first", async () => {
    await withService(async (api) => {
      const app = await launchApp(api);
      for (const n of [1, 2, 3, 4]) completeRequest(app, `r${n}`, `https://api.example.com/${n}`);
      await recorded(api, 4);

      const listing = await list(api, { limit: 2 });

      expect(urls(listing)).toEqual(["https://api.example.com/3", "https://api.example.com/4"]);
      expect(listing).toMatchObject({ count: 2, total: 4 });
      expect(listing.header).toBe(`ios-native: armed, 4 requests (pid ${PID})`);
      app.close();
    });
  });

  it("returns no requests but the whole total for limit 0", async () => {
    await withService(async (api) => {
      const app = await launchApp(api);
      for (const n of [1, 2, 3]) completeRequest(app, `r${n}`, `https://api.example.com/${n}`);
      await recorded(api, 3);

      const listing = await list(api, { limit: 0 });

      expect(listing).toMatchObject({
        status: "ok",
        armed: true,
        count: 0,
        total: 3,
        requests: [],
      });
      expect(listing.header).toBe(`ios-native: armed, 3 requests (pid ${PID})`);
      app.close();
    });
  });

  it("returns the requests with clear, then none on the next listing", async () => {
    await withService(async (api) => {
      const app = await launchApp(api);
      completeRequest(app, "r1", "https://api.example.com/1");
      completeRequest(app, "r2", "https://api.example.com/2");
      await recorded(api, 2);

      const cleared = await list(api, { clear: true });
      expect(cleared.count).toBe(2);

      const next = await list(api);
      expect(next).toMatchObject({ count: 0, total: 0, requests: [] });
      expect(next.header).toBe(`ios-native: armed, 0 requests (pid ${PID})`);

      // What the app sends after the clear is listed again.
      completeRequest(app, "r3", "https://api.example.com/3");
      await recorded(api, 1);
      expect(urls(await list(api))).toEqual(["https://api.example.com/3"]);
      app.close();
    });
  });

  it("keeps the requests of the app's earlier process when it relaunches", async () => {
    await withService(async (api) => {
      const first = await launchApp(api);
      completeRequest(first, "r1", "https://api.example.com/before");
      await recorded(api, 1);
      const before = await list(api);
      first.close();
      await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(false));

      sim.launchctlList = runningRow(PID + 1);
      const second = await launchApp(api, PID + 1);
      // The new process numbers its requests from the start again.
      completeRequest(second, "r1", "https://api.example.com/after");
      await recorded(api, 2);

      const after = await list(api);

      expect(urls(after)).toEqual([
        "https://api.example.com/before",
        "https://api.example.com/after",
      ]);
      expect(after.requests[0]!.id).toBe(before.requests[0]!.id);
      expect(after.requests[1]!.id).not.toBe(before.requests[0]!.id);
      expect(after.header).toBe(`ios-native: armed, 2 requests (pid ${PID + 1})`);
      second.close();
    });
  });

  it("fails a request left open by a process a newer connection replaced", async () => {
    await withService(async (api) => {
      const first = await launchApp(api);
      completeRequest(first, "r1", "https://api.example.com/done");
      startRequest(first, "r2", "https://api.example.com/open");
      await recorded(api, 2, "pending");

      // A fast relaunch: the new process dials before the old socket closed.
      // The host cannot read the new process, so only the newer connection
      // says the old one ended.
      sim.launchctlList = runningRow(PID + 1);
      sim.psOutput = "";
      const second = await launchApp(api, null);
      await recorded(api, 2, "failed");

      const listing = await list(api);

      expect(listing.requests).toEqual([
        expect.objectContaining({ url: "https://api.example.com/done", state: "complete" }),
        {
          id: expect.stringMatching(IOS_ID),
          method: "GET",
          url: "https://api.example.com/open",
          state: "failed",
          errorText: PROCESS_ENDED,
        },
      ]);
      first.close();
      second.close();
    });
  });

  it("does not blame the process for a request open on a connection that dropped while it ran", async () => {
    await withService(async (api) => {
      const first = await launchApp(api);
      startRequest(first, "r1", "https://api.example.com/open");
      await recorded(api, 1, "pending");

      // The same process is still running when its connection drops.
      first.close();
      await recorded(api, 1, "failed");
      const second = await launchApp(api);

      const listing = await list(api);

      expect(listing.requests).toEqual([
        expect.objectContaining({ state: "failed", errorText: NOT_RECONNECTED }),
      ]);
      second.close();
    });
  });
});

describe("native-network-logs limit", () => {
  const schema = tool.zodSchema!;
  const inputs = [
    ["iOS", { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", bundleId: BUNDLE }],
    ["Android", { udid: "emulator-5554", bundleId: BUNDLE }],
  ] as const;

  it.each(inputs)("refuses a negative limit on %s input", (_platform, input) => {
    expect(schema.safeParse({ ...input, limit: -1 }).success).toBe(false);
  });

  it.each(inputs)("refuses a fractional limit on %s input", (_platform, input) => {
    expect(schema.safeParse({ ...input, limit: 1.5 }).success).toBe(false);
  });

  it.each(inputs)("accepts limit 0 on %s input", (_platform, input) => {
    expect(schema.safeParse({ ...input, limit: 0 })).toMatchObject({
      success: true,
      data: { limit: 0 },
    });
  });

  it.each(inputs)("defaults limit to 50 on %s input", (_platform, input) => {
    expect(schema.safeParse(input)).toMatchObject({ success: true, data: { limit: 50 } });
  });
});
