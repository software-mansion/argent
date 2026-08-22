import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { AddressInfo } from "node:net";
import {
  FAILURE_CODES,
  FailureError,
  Registry,
  TypedEventEmitter,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";

vi.mock("@argent/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/telemetry")>();
  return { ...actual, track: vi.fn() };
});

import { track } from "@argent/telemetry";
import {
  jsRuntimeDebuggerBlueprint,
  JS_RUNTIME_DEBUGGER_NAMESPACE,
} from "../../src/blueprints/js-runtime-debugger";
import { chromiumJsRuntimeDebuggerBlueprint } from "../../src/blueprints/chromium-js-runtime-debugger";
import { createDebuggerLogRegistryTool } from "../../src/tools/debugger/debugger-log-registry";
import type { DebuggerNotConnectedResult } from "../../src/tools/debugger/not-connected";
import {
  recordReapedSession,
  takeReapedSession,
  __resetReapedSessionsForTesting,
} from "../../src/utils/reaped-sessions";
import { freePort, startMockMetroCdp } from "./metro-cdp-harness";
import { scopeTempHome } from "../helpers/temp-home";

// The JS-runtime-debugger / network blueprints build a real LogFileWriter,
// whose constructor mkdir -p's os.homedir()/.argent/tmp. Keep that out of the
// developer's real home.
scopeTempHome("argent-log-registry-nc-home-");

// A real file, so which branch of the salvage clause runs is decided here and
// not by whatever the developer's /tmp happens to hold: an absent path takes
// the "has since been reclaimed" arm, and `toContain(path)` passes on both.
const keptDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-kept-"));
const keptLog = path.join(keptDir, "kept.log");
const otherLog = path.join(keptDir, "k.log");
for (const file of [keptLog, otherLog]) fs.writeFileSync(file, "logged");
afterAll(() => fs.rmSync(keptDir, { recursive: true, force: true }));

const mockTrack = vi.mocked(track);
const outcomeCalls = () =>
  mockTrack.mock.calls.filter(([event]) => event === "debugger:tool_outcome");

const INVOCATION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

interface MockServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * Metro that reports a target whose CDP WebSocket is unreachable — the
 * discovery succeeds but the connect fails, which must classify as
 * cdp_unreachable rather than failing the tool.
 */
async function startMetroWithDeadCdp(deadWsPort: number): Promise<MockServer> {
  const server = http.createServer((req, res) => {
    if (req.url === "/status") {
      res.end("packager-status:running");
      return;
    }
    if (req.url === "/json/list") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify([
          {
            id: "page-1",
            title: "React Native (mock)",
            description: "",
            webSocketDebuggerUrl: `ws://127.0.0.1:${deadWsPort}/inspector/debug?device=0&page=1`,
            deviceName: "MockDevice",
            reactNative: { capabilities: { prefersFuseboxFrontend: true } },
          },
        ])
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Metro that is up and lists no debugger targets — a crashed app reads as this. */
async function startMetroWithNoTargets(): Promise<MockServer> {
  const server = http.createServer((req, res) => {
    if (req.url === "/status") {
      res.end("packager-status:running");
      return;
    }
    if (req.url === "/json/list") {
      res.setHeader("Content-Type", "application/json");
      res.end("[]");
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface Setup {
  registry: Registry;
  completed: string[];
  failed: string[];
  invoke: (params: Record<string, unknown>) => Promise<unknown>;
}

function makeSetup(blueprint: ServiceBlueprint): Setup {
  const registry = new Registry();
  registry.registerBlueprint(blueprint);
  registry.registerTool(createDebuggerLogRegistryTool(registry));
  const completed: string[] = [];
  const failed: string[] = [];
  registry.events.on("toolCompleted", (id) => completed.push(id));
  registry.events.on("toolFailed", (id) => failed.push(id));
  return {
    registry,
    completed,
    failed,
    invoke: (params) =>
      registry.invokeTool("debugger-log-registry", params, { toolInvocationId: INVOCATION_ID }),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  mockTrack.mockClear();
  vi.restoreAllMocks();
});

describe("debugger-log-registry not-connected results", () => {
  it("metro_not_running: returns the discriminated shape with NO log file, as a success", async () => {
    const port = await freePort();
    const setup = makeSetup(jsRuntimeDebuggerBlueprint);
    cleanups.push(() => setup.registry.dispose());

    const result = (await setup.invoke({
      port,
      device_id: "mock-device",
    })) as DebuggerNotConnectedResult;

    expect(result.status).toBe("not_connected");
    expect(result.connected).toBe(false);
    expect(result.reason).toBe("metro_not_running");
    expect(result.guidance).toContain("Do not retry in a loop");
    // Nothing was reaped here, and the answer says so. The lead is this tool's
    // own: the shared guidance strings are written for `debugger-status`, whose
    // answers never set `note`, so none of them accounts for one.
    expect(result.guidance).not.toContain("Read this result's note");
    // The reason's own instruction leads; the absence is explained after it.
    expect(result.guidance.startsWith("Metro is not running on this port")).toBe(true);
    expect(result.guidance).toContain("This result has no note");
    // What it says about the world is only what the store can know. Three states
    // reach an empty store — no session ended here, one ended having logged
    // nothing (the record is gated on `captured > 0`), or an earlier read spent
    // it while the file it named is still on disk — and the answer cannot tell
    // them apart, so it states the two conditions and explains none of them
    // away.
    // Scoped by both, since a Metro device holds one session per port: an
    // answer naming the device alone invites a reader to conclude the other
    // port's crash was never recorded.
    expect(result.guidance).toContain(
      "no unread record of a previous session under this device id and port"
    );
    expect(result.guidance).toContain(
      "filed only for a session that ended holding console history"
    );
    expect(result.guidance).toContain("the first read of it spends it");
    // No fabricated LogStats: agents must not be sent to grep a file that
    // does not exist.
    expect("file" in result).toBe(false);
    expect("totalEntries" in result).toBe(false);

    expect(setup.completed).toEqual(["debugger-log-registry"]);
    expect(setup.failed).toEqual([]);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0][1]).toMatchObject({
      tool: "debugger-log-registry",
      outcome: "metro_not_running",
      tool_invocation_id: INVOCATION_ID,
    });
  });

  it("cdp_unreachable: Metro lists a target whose CDP socket is dead", async () => {
    const deadWsPort = await freePort();
    const metro = await startMetroWithDeadCdp(deadWsPort);
    const setup = makeSetup(jsRuntimeDebuggerBlueprint);
    cleanups.push(async () => {
      await setup.registry.dispose();
      await metro.close();
    });

    const result = (await setup.invoke({
      port: metro.port,
      device_id: "mock-device",
    })) as DebuggerNotConnectedResult;

    expect(result.status).toBe("not_connected");
    expect(result.reason).toBe("cdp_unreachable");
    expect(result.guidance).toContain("debugger-connect");
    expect(setup.failed).toEqual([]);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0][1]).toMatchObject({ outcome: "cdp_unreachable" });
  });

  it("no_app_connected: does not send the reader back here for the note this answer reports", async () => {
    // The shared strings are written for `debugger-status`, which has no note
    // field: from there, "read debugger-log-registry's note" is an errand. Read
    // from the tool that runs it, it is a loop — and on the crash that captured
    // nothing, one with no exit: the answer that just said it holds no note
    // would be sending the agent back to itself for one.
    const metro = await startMetroWithNoTargets();
    const setup = makeSetup(jsRuntimeDebuggerBlueprint);
    cleanups.push(async () => {
      await setup.registry.dispose();
      await metro.close();
    });

    const result = (await setup.invoke({
      port: metro.port,
      device_id: "mock-device",
    })) as DebuggerNotConnectedResult;

    expect(result.reason).toBe("no_app_connected");
    expect(result.guidance).not.toContain("debugger-log-registry");
    expect(result.guidance.startsWith("Metro is running but no app is attached")).toBe(true);
    expect(result.guidance).toContain("This result has no note");
    // The recovery this reason exists to give is still all there.
    expect(result.guidance).toContain("launch-app / restart-app");
  });

  it("chromium: scopes the no-note sentence by the device alone, since its answer has no port", async () => {
    // A Chromium session's CDP port lives inside its device id, so the answer
    // omits `port` and the breadcrumb is filed unscoped. Telling that caller
    // nothing was filed "under this device id and port" invites a retry with another
    // port, which this tool ignores — the same answer, twice.
    const registry = new Registry();
    registry.registerBlueprint(chromiumJsRuntimeDebuggerBlueprint);
    registry.registerBlueprint({
      namespace: "ChromiumCdp",
      getURN: (deviceId: string) => `ChromiumCdp:${deviceId}`,
      factory: () => {
        throw new FailureError("no browser is listening on 9222", {
          error_code: FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE,
          failure_stage: "chromium_cdp_connect",
          failure_area: "tool_server",
          error_kind: "network",
        });
      },
    } as unknown as ServiceBlueprint);
    registry.registerTool(createDebuggerLogRegistryTool(registry));
    cleanups.push(() => registry.dispose());

    const result = (await registry.invokeTool(
      "debugger-log-registry",
      { port: 8081, device_id: "chromium-cdp-9222" },
      { toolInvocationId: INVOCATION_ID }
    )) as DebuggerNotConnectedResult;

    expect(result.reason).toBe("cdp_unreachable");
    expect("port" in result).toBe(false);
    expect(result.guidance.startsWith("The app's CDP endpoint could not be reached")).toBe(true);
    expect(result.guidance).toContain("This result has no note");
    expect(result.guidance).toContain("previous session under this device id.");
    expect(result.guidance).not.toContain("device id and port");
    // And it must not send this caller after the note it is itself holding.
    // This IS the call the reference prescribes once a Chromium relaunch has
    // stranded the record under the old port: made because that endpoint is
    // known dead, and answered on the shared string by "make sure the app is
    // running ... then retry once".
    expect(result.guidance).not.toContain("debugger-log-registry's note");
  });

  it("carries the replaced-records clause through to this tool's answer", async () => {
    // The clause rides on the same string as everything else in the note, and
    // `debugger-connect` is the only consumer anything pins it through - but
    // this is the tool the guidance for a crashed app sends the agent to
    // FIRST, so it is the answer that has to carry the loss.
    const port = await freePort();
    const setup = makeSetup(jsRuntimeDebuggerBlueprint);
    cleanups.push(async () => {
      await setup.registry.dispose();
      __resetReapedSessionsForTesting();
    });
    recordReapedSession("js-runtime-debugger", "mock-device", `kept at ${keptLog}`, {
      cause: "runtime-death",
      keptAt: keptLog,
      scope: String(port),
    });
    recordReapedSession("js-runtime-debugger", "mock-device", "the 3 entries went with it", {
      cause: "teardown",
      scope: String(port),
    });

    const result = (await setup.invoke({ port, device_id: "mock-device" })) as Record<
      string,
      string
    >;

    expect(result.note).toContain("An earlier session that answered here");
    expect(result.note).toContain(`Any log file it left is still in ~/.argent/tmp`);
  });

  it("leads the guidance with the note when the answer is carrying one", async () => {
    // These strings are written for `debugger-status`, whose answers carry no
    // note: a reason either points at this tool to fetch one — a crashed
    // Chromium renderer's `cdp_unreachable` does — or mentions none at all.
    // Read from the answer that IS carrying it, both mislead.
    const port = await freePort();
    const setup = makeSetup(jsRuntimeDebuggerBlueprint);
    cleanups.push(async () => {
      await setup.registry.dispose();
      __resetReapedSessionsForTesting();
    });
    recordReapedSession(
      "js-runtime-debugger",
      "mock-device",
      `The log file is kept at ${keptLog}`,
      { cause: "runtime-death", keptAt: keptLog, scope: String(port) }
    );

    const result = (await setup.invoke({ port, device_id: "mock-device" })) as Record<
      string,
      string
    >;

    expect(result.reason).toBe("metro_not_running");
    expect(result.note).toContain(keptLog);
    expect(result.note).not.toContain("has since been reclaimed");
    expect(result.guidance.startsWith("Read this result's note first")).toBe(true);
    // Whatever it precedes has to be true of it: this reason's own guidance
    // says nothing about a note.
    expect(result.guidance).toContain("explains what became of the previous session's console log");
    // And the reason's own guidance is still all there behind it.
    expect(result.guidance).toContain("Do not retry in a loop");
  });

  it("does not tell the second reader that no session ended here", async () => {
    // The first read spends the record; the file it named outlives it. An answer
    // that reads its own empty store as "nothing ended here" contradicts the
    // answer given seconds earlier and sends the agent past a log that is still
    // on disk.
    const port = await freePort();
    const setup = makeSetup(jsRuntimeDebuggerBlueprint);
    cleanups.push(async () => {
      await setup.registry.dispose();
      __resetReapedSessionsForTesting();
    });
    recordReapedSession(
      "js-runtime-debugger",
      "mock-device",
      `The log file is kept at ${otherLog}`,
      {
        cause: "runtime-death",
        keptAt: otherLog,
        scope: String(port),
      }
    );

    const first = (await setup.invoke({ port, device_id: "mock-device" })) as Record<
      string,
      string
    >;
    expect(first.note).toContain(otherLog);

    const second = (await setup.invoke({ port, device_id: "mock-device" })) as Record<
      string,
      string
    >;
    expect(second.note).toBeUndefined();
    expect(second.guidance).toContain("the first read of it spends it");
    // "unread" is the whole hedge: a session DID end here, and this reader is
    // late rather than first.
    expect(second.guidance).toContain("no unread record of a previous session");
  });

  /**
   * A service parked in dispose until it is released in the cleanup below —
   * standing in for the window a real dispose spends in the awaits that follow
   * filing its breadcrumb.
   */
  async function teardownInFlight(deviceId: string) {
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    const slowDisposeBlueprint: ServiceBlueprint<Record<string, never>, string> = {
      namespace: JS_RUNTIME_DEBUGGER_NAMESPACE,
      getURN: (payload) => `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${payload}`,
      factory: async () => ({
        api: {},
        dispose: () => disposeGate,
        events: new TypedEventEmitter<ServiceEvents>(),
      }),
    };
    const setup = makeSetup(slowDisposeBlueprint as ServiceBlueprint);

    const urn = `${JS_RUNTIME_DEBUGGER_NAMESPACE}:8081:${deviceId}`;
    await setup.registry.resolveService(urn);
    const disposing = setup.registry.disposeService(urn);
    cleanups.push(async () => {
      releaseDispose();
      await disposing;
      await setup.registry.dispose();
      __resetReapedSessionsForTesting();
    });
    return setup;
  }

  it("reconnecting: a resolve racing an in-flight teardown maps like debugger-status does", async () => {
    const setup = await teardownInFlight("dev1");

    const result = (await setup.invoke({
      port: 8081,
      device_id: "dev1",
    })) as DebuggerNotConnectedResult;

    expect(result.status).toBe("not_connected");
    expect(result.reason).toBe("reconnecting");
    expect(setup.failed).toEqual([]);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0][1]).toMatchObject({ outcome: "reconnecting" });
  });

  it("reconnecting: leaves the breadcrumb for the retry its own guidance asks for", async () => {
    // The dispose files the breadcrumb before it awaits anything, so this is
    // the answer a read gets while the crashed session is still winding down.
    // Its guidance is "wait a moment and retry once" — spending the note on an
    // answer that says to ask again leaves the asking again with nothing, and
    // nothing else names the file that session kept.
    const setup = await teardownInFlight("dev2");
    recordReapedSession("js-runtime-debugger", "dev2", `The log file is kept at ${keptLog}`, {
      cause: "runtime-death",
      keptAt: keptLog,
      scope: "8081",
    });

    const result = (await setup.invoke({ port: 8081, device_id: "dev2" })) as Record<
      string,
      unknown
    >;

    expect(result.reason).toBe("reconnecting");
    expect(result.note).toBeUndefined();
    // And says so in neither direction: this answer has no note because it kept
    // one back, so a sentence about there being nothing to report would be the
    // opposite of what the line below proves.
    expect(result.guidance).toBe(
      "The debugger connection is being re-established (the previous one was torn down or a " +
        "tab switch is in progress). Wait a moment and retry once."
    );
    expect(takeReapedSession("js-runtime-debugger", "dev2", "8081")?.salvage).toContain(keptLog);
  });

  it("connected path: returns the LogStats superset — guards against an over-broad catch", async () => {
    const metro = await startMockMetroCdp();
    const setup = makeSetup(jsRuntimeDebuggerBlueprint);
    cleanups.push(async () => {
      await setup.registry.dispose();
      await metro.close();
    });

    const result = (await setup.invoke({ port: metro.port, device_id: "mock-device" })) as Record<
      string,
      unknown
    >;

    expect(result.status).toBe("connected");
    expect(result.file).toMatch(new RegExp(`argent-logs-${metro.port}`));
    expect(typeof result.totalEntries).toBe("number");
    expect(Array.isArray(result.clusters)).toBe(true);
    expect(result.deviceName).toBe("MockDevice");
    expect(result.appName).toBe("React Native (mock)");

    expect(setup.completed).toEqual(["debugger-log-registry"]);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0][1]).toMatchObject({
      tool: "debugger-log-registry",
      outcome: "connected",
      tool_invocation_id: INVOCATION_ID,
    });
  });

  it("dead-socket asymmetry: NO gate, NO dispose — stats and the on-disk log file survive", async () => {
    // Deliberate asymmetry with debugger-status: captured logs are readable
    // over a dead socket, and a status-style gate would dispose the node —
    // whose dispose ends the session, minting a new writer over a new path —
    // i.e. reduce exactly the post-crash logs the caller came for to a
    // breadcrumb, while also dropping `file` from the result. This pin makes
    // that regression loud.
    const metro = await startMockMetroCdp();
    const factorySpy = vi.fn(jsRuntimeDebuggerBlueprint.factory);
    const setup = makeSetup({ ...jsRuntimeDebuggerBlueprint, factory: factorySpy });
    cleanups.push(async () => {
      await setup.registry.dispose();
      await metro.close();
    });

    const first = (await setup.invoke({ port: metro.port, device_id: "mock-device" })) as Record<
      string,
      unknown
    >;
    expect(first.status).toBe("connected");
    const logFile = first.file as string;
    expect(fs.existsSync(logFile)).toBe(true);

    // Kill the socket state without any close event dispatching.
    const urn = `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${metro.port}:mock-device`;
    const api = await setup.registry.resolveService<{ cdp: { isConnected: () => boolean } }>(urn);
    vi.spyOn(api.cdp, "isConnected").mockReturnValue(false);

    const second = (await setup.invoke({ port: metro.port, device_id: "mock-device" })) as Record<
      string,
      unknown
    >;
    // Still the connected shape — stats plus the route back to the data.
    expect(second.status).toBe("connected");
    expect(second.file).toBe(logFile);
    expect(fs.existsSync(logFile)).toBe(true);
    // And no dispose happened: the cached node was reused as-is.
    expect(factorySpy).toHaveBeenCalledTimes(1);
  });

  it("does not tell the CLI nothing was captured on an answer that names a kept log", () => {
    // The not_connected line is displayed beside a note that can name a log
    // file with N entries in it, so a completion message asserting there are
    // none contradicts the answer it is summarising.
    const registry = new Registry();
    cleanups.push(() => registry.dispose());
    const completedMsg = createDebuggerLogRegistryTool(registry).interaction!.completedMsg!;

    const params = { port: 8081, device_id: "dev1" };
    expect(
      completedMsg({
        params,
        result: {
          status: "not_connected",
          connected: false,
          reason: "no_app_connected",
          detail: "no app",
          guidance: "reconnect",
          note: "The log file is kept at /tmp/x.log - grep that file for the 3 entries it holds.",
        },
      })
    ).toBe("JavaScript debugger is not connected");
    expect(
      completedMsg({
        params,
        result: {
          status: "connected",
          file: "/tmp/x.log",
          totalEntries: 0,
          byLevel: {},
          fileSizeBytes: 0,
          clusters: [],
          deviceName: "dev",
          appName: "app",
          logicalDeviceId: undefined,
        },
      })
    ).toBe("Read app logs");
  });

  it("unexpected error: rethrows (toolFailed, no outcome event, no structured shape)", async () => {
    const brokenBlueprint: ServiceBlueprint<Record<string, never>, string> = {
      namespace: JS_RUNTIME_DEBUGGER_NAMESPACE,
      getURN: (payload) => `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${payload}`,
      factory: async () => {
        throw new Error("disk on fire");
      },
    };
    const setup = makeSetup(brokenBlueprint as ServiceBlueprint);
    cleanups.push(() => setup.registry.dispose());

    await expect(setup.invoke({ port: 8081, device_id: "dev1" })).rejects.toThrow(/disk on fire/);
    expect(setup.failed).toEqual(["debugger-log-registry"]);
    expect(setup.completed).toEqual([]);
    expect(outcomeCalls()).toHaveLength(0);
  });
});
