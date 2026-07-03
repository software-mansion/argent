import { createServer, type Server } from "node:http";
import { describe, it, expect, afterEach } from "vitest";
import { FAILURE_CODES, getFailureSignal, type FailureCode } from "@argent/registry";

import {
  setActiveProjectRoot,
  clearActiveProjectRoot,
  assertSafeFlowName,
  getFlowPath,
} from "../src/tools/flows/flow-utils";
import type { DeviceInfo, Registry } from "@argent/registry";
import { makeChromiumImpl } from "../src/tools/keyboard/platforms/chromium";
import { chromiumCdpBlueprint } from "../src/blueprints/chromium-cdp";
import { ensureCdpReachable, discoverPrimaryPage } from "../src/chromium-server/cdp-session";
import { readViewport } from "../src/chromium-server/viewport";
import { captureScreenshot } from "../src/chromium-server/screenshot";
import type { CDPClient } from "../src/utils/debugger/cdp-client";
import { injectVegaText, injectVegaNamedKey } from "../src/utils/vega-input";
import {
  readAndroidNativeProfilerMetadata,
  androidNativeProfilerMetadataPath,
} from "../src/utils/android-profiler/session-metadata";
import { profilerStackQueryTool } from "../src/tools/profiler/query/profiler-stack-query";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Telemetry only reads a FailureError's signal when it propagates out of a tool's
 * `execute` (the registry's `toolFailed` event walks the cause chain via
 * `getFailureSignal`). These tests pin the `error_code` of representative
 * newly-classified throw sites — across the flows, keyboard, chromium (blueprint
 * factory + CDP discovery), vega input, and native-profiler (metadata + stack
 * query) areas — so a regression that drops or mis-codes a classification is
 * caught in CI rather than only in a one-off manual run.
 *
 * Each site here is reachable on a real telemetry path (a registered tool's
 * execute, or a helper it calls un-swallowed) and driven with only a bare stub,
 * a local HTTP server, or a temp file — no live device. Families that require a
 * live CDP WebSocket or a booted device (electron boot, tab-open, vega adb/CLI
 * paths) are exercised in the end-to-end suites, not here.
 */

/** Await a promise expected to reject and return the thrown error. */
async function captureError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw, but it resolved");
}

/** Run a synchronous function expected to throw and return the thrown error. */
function captureSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw, but it returned");
}

function expectCode(err: unknown, code: FailureCode): void {
  expect(getFailureSignal(err)?.error_code).toBe(code);
}

const openServers: Server[] = [];

/** Start a local HTTP server on an ephemeral port and return its port. */
function startServer(handler: (path: string, res: import("node:http").ServerResponse) => void) {
  return new Promise<number>((resolve) => {
    const srv = createServer((req, res) => handler(req.url ?? "/", res));
    openServers.push(srv);
    srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port));
  });
}

afterEach(async () => {
  // setActiveProjectRoot mutates module state; reset so cases don't leak.
  clearActiveProjectRoot();
  // Tear down any local servers a case spun up.
  await Promise.all(openServers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe("flow-utils classifications", () => {
  it("classifies a relative project_root as FLOW_PROJECT_ROOT_INVALID", () => {
    expectCode(
      captureSync(() => setActiveProjectRoot("relative/path")),
      FAILURE_CODES.FLOW_PROJECT_ROOT_INVALID
    );
  });

  it("classifies a project_root containing '..' as FLOW_PROJECT_ROOT_INVALID", () => {
    expectCode(
      captureSync(() => setActiveProjectRoot("/a/../b")),
      FAILURE_CODES.FLOW_PROJECT_ROOT_INVALID
    );
  });

  it("classifies path resolution with no active project_root as FLOW_PROJECT_ROOT_REQUIRED", () => {
    // No active root → getFlowPath → getFlowsDir → requireActiveProjectRoot throws.
    expectCode(
      captureSync(() => getFlowPath("valid-name")),
      FAILURE_CODES.FLOW_PROJECT_ROOT_REQUIRED
    );
  });

  it("classifies an unsafe flow name as FLOW_NAME_INVALID", () => {
    expectCode(
      captureSync(() => assertSafeFlowName("bad name!")),
      FAILURE_CODES.FLOW_NAME_INVALID
    );
  });
});

describe("keyboard classifications", () => {
  // The chromium typing path lives in makeChromiumImpl's handler, which resolves
  // the CDP service then validates the key/char before touching it. A stub
  // registry (service resolves to a bare object) reaches the classified throw
  // without a live browser.
  const registry = { resolveService: async () => ({}) } as unknown as Registry;
  const { handler } = makeChromiumImpl(registry);
  const device = {
    id: "chromium-cdp-9222",
    platform: "chromium",
    kind: "app",
  } as unknown as DeviceInfo;

  it("classifies an unknown named key as KEYBOARD_KEY_UNSUPPORTED", async () => {
    expectCode(
      await captureError(handler({}, { udid: device.id, key: "not-a-key" }, device)),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("classifies an unmappable character as KEYBOARD_CHARACTER_UNSUPPORTED", async () => {
    expectCode(
      await captureError(handler({}, { udid: device.id, text: "\u{1F600}" }, device)),
      FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED
    );
  });
});

describe("chromium blueprint factory classifications", () => {
  const device = (id: string) => ({ id, platform: "chromium" as const, kind: "app" as const });

  it("classifies a malformed chromium device id as CHROMIUM_DEVICE_ID_INVALID", async () => {
    // A well-formed id that agrees between options and URN passes the (uncoded)
    // wiring guards, then the port parse fails — exercising the reachable
    // CHROMIUM_DEVICE_ID_INVALID branch.
    expectCode(
      await captureError(
        chromiumCdpBlueprint.factory({}, device("chromium-cdp-bogus"), {
          device: device("chromium-cdp-bogus"),
        })
      ),
      FAILURE_CODES.CHROMIUM_DEVICE_ID_INVALID
    );
  });
});

describe("chromium CDP discovery classifications", () => {
  // These drive the discovery helpers against a local HTTP server standing in
  // for the debug port, exercising the reachable throw sites the way the tools
  // do (ensureCdpReachable / discoverPrimaryPage bubble out of chromium tool
  // execute → toolFailed → getFailureSignal).

  it("classifies a 200 with a non-JSON body as CHROMIUM_CDP_INVALID_RESPONSE", async () => {
    // A non-CDP service squatting the debug port answers 200 but the body can't
    // be parsed — the reached-but-malformed case (regression guard for the
    // res.json() parse that used to escape unclassified to the generic bucket).
    const port = await startServer((_path, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>not a CDP endpoint</html>");
    });
    const err = await captureError(ensureCdpReachable(port));
    expectCode(err, FAILURE_CODES.CHROMIUM_CDP_INVALID_RESPONSE);
    expect(getFailureSignal(err)?.network_failure).toBe("invalid_response");
  });

  it("classifies a non-2xx status as CHROMIUM_CDP_INVALID_RESPONSE", async () => {
    const port = await startServer((_path, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    expectCode(
      await captureError(ensureCdpReachable(port)),
      FAILURE_CODES.CHROMIUM_CDP_INVALID_RESPONSE
    );
  });

  it("classifies a refused connection as CHROMIUM_CDP_UNREACHABLE", async () => {
    // Bind then immediately release a port so the connect is refused.
    const port = await startServer(() => {});
    await new Promise<void>((r) => openServers.splice(0)[0]!.close(() => r()));
    const err = await captureError(ensureCdpReachable(port));
    expectCode(err, FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE);
    expect(getFailureSignal(err)?.network_failure).toBe("connection_refused");
  });

  it("classifies an endpoint with no page targets as CHROMIUM_CDP_NO_PAGE_TARGET", async () => {
    const port = await startServer((path, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // /json/version resolves; /json/list has no page targets.
      if (path.startsWith("/json/version")) {
        res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/x" }));
      } else {
        res.end(JSON.stringify([]));
      }
    });
    expectCode(
      await captureError(discoverPrimaryPage(port)),
      FAILURE_CODES.CHROMIUM_CDP_NO_PAGE_TARGET
    );
  });
});

describe("chromium CDP-command malformed-response classifications", () => {
  // A CDP command that round-trips but returns a payload missing the expected
  // field is classified `error_kind: "unknown"` (a malformed response from a
  // source we don't own), never `network`. These helpers are called
  // un-swallowed from the chromium tools' execute, so the signal reaches
  // telemetry. A stub CDPClient whose `send` resolves to `{}` reaches the
  // classified throw without a live browser. This pins the convention that
  // CHROMIUM_TAB_OPEN_FAILED (Target.createTarget with no targetId) also follows.
  const stubCdp = (payload: unknown) => ({ send: async () => payload }) as unknown as CDPClient;

  it("classifies a viewport read with no value as CHROMIUM_VIEWPORT_READ_FAILED (unknown)", async () => {
    const err = await captureError(readViewport(stubCdp({})));
    expectCode(err, FAILURE_CODES.CHROMIUM_VIEWPORT_READ_FAILED);
    expect(getFailureSignal(err)?.error_kind).toBe("unknown");
  });

  it("classifies a screenshot with no data as CHROMIUM_SCREENSHOT_FAILED (unknown)", async () => {
    const err = await captureError(
      captureScreenshot({ cdp: stubCdp({}), deviceId: "chromium-cdp-9222" })
    );
    expectCode(err, FAILURE_CODES.CHROMIUM_SCREENSHOT_FAILED);
    expect(getFailureSignal(err)?.error_kind).toBe("unknown");
  });
});

describe("vega input classifications", () => {
  // Both validate before any `adb`/inputd I/O, so they throw synchronously on
  // bad input on the real typing path — no device needed to pin the code.
  it("classifies newline-bearing text as VEGA_TEXT_INVALID", async () => {
    expectCode(await captureError(injectVegaText("line1\nline2")), FAILURE_CODES.VEGA_TEXT_INVALID);
  });

  it("classifies an unknown named key as KEYBOARD_KEY_UNSUPPORTED", async () => {
    expectCode(
      await captureError(injectVegaNamedKey("not-a-real-key")),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });
});

describe("native-profiler metadata classifications", () => {
  // readAndroidNativeProfilerMetadata is called un-swallowed on the profiler-load
  // path; a corrupt or structurally-invalid sidecar propagates to telemetry.
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("classifies a corrupt JSON metadata sidecar as PROFILER_NATIVE_METADATA_INVALID", async () => {
    dir = await mkdtemp(join(tmpdir(), "argent-meta-"));
    const pftrace = join(dir, "native-profiler-s1.pftrace");
    await writeFile(androidNativeProfilerMetadataPath(pftrace), "{ not valid json", "utf8");
    expectCode(
      await captureError(readAndroidNativeProfilerMetadata(pftrace)),
      FAILURE_CODES.PROFILER_NATIVE_METADATA_INVALID
    );
  });

  it("classifies a structurally-invalid metadata sidecar as PROFILER_NATIVE_METADATA_INVALID", async () => {
    dir = await mkdtemp(join(tmpdir(), "argent-meta-"));
    const pftrace = join(dir, "native-profiler-s2.pftrace");
    // Valid JSON, wrong shape (empty appProcess) → the validate branch.
    await writeFile(
      androidNativeProfilerMetadataPath(pftrace),
      JSON.stringify({ platform: "android", appProcess: "", wallClockStartMs: null }),
      "utf8"
    );
    expectCode(
      await captureError(readAndroidNativeProfilerMetadata(pftrace)),
      FAILURE_CODES.PROFILER_NATIVE_METADATA_INVALID
    );
  });
});

describe("native-profiler stack-query classifications", () => {
  // The tool's execute has no try/catch, so these codes propagate to telemetry.
  // A bare session stub is enough — the throws fire before any trace I/O.
  const session = (api: object) => ({ session: api }) as never;

  it("classifies a query with no parsed data as PROFILER_DATA_NOT_LOADED", async () => {
    expectCode(
      await captureError(
        profilerStackQueryTool.execute(session({ platform: "ios", parsedData: null }), {
          device_id: "x",
          mode: "thread_breakdown",
          top_n: 15,
        })
      ),
      FAILURE_CODES.PROFILER_DATA_NOT_LOADED
    );
  });

  it("classifies hang_stacks without hang_index as PROFILER_QUERY_REQUIRED_PARAM_MISSING", async () => {
    expectCode(
      await captureError(
        profilerStackQueryTool.execute(
          session({
            platform: "ios",
            parsedData: { cpuSamples: [], uiHangs: [], cpuHotspots: [], memoryLeaks: [] },
          }),
          { device_id: "x", mode: "hang_stacks", top_n: 15 }
        )
      ),
      FAILURE_CODES.PROFILER_QUERY_REQUIRED_PARAM_MISSING
    );
  });
});
