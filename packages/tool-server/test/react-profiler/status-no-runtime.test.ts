import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { Registry } from "@argent/registry";
import { createHttpApp } from "../../src/http";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { reactProfilerSessionBlueprint } from "../../src/blueprints/react-profiler-session";
import { createReactProfilerStatusTool } from "../../src/tools/profiler/react/react-profiler-status";
import { startMockMetroCdp } from "../debugger/metro-cdp-harness";
import { useMacosAppsFlag } from "../helpers/macos-apps-flag";

/**
 * react-profiler-status answers `no_react_runtime` when it cannot reach the
 * runtime. Its note said "Reconnect the debugger and retry", also for a Mac
 * app that was not running, and it dropped the reason, which says to start
 * the app.
 */

useMacosAppsFlag();

const MAC = "macos-app-com.example.focus";
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function statusApp() {
  const registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerBlueprint(reactProfilerSessionBlueprint);
  registry.registerTool(createReactProfilerStatusTool(registry));
  return createHttpApp(registry).app;
}

/** A Metro that answers its status check and lists no runtime. */
async function startEmptyMetro(): Promise<number> {
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

async function status(port: number, deviceId: string) {
  const res = await request(statusApp())
    .post("/tools/react-profiler-status")
    .send({ device_id: deviceId, port });
  expect(res.status).toBe(200);
  return res.body.data as { session_status: string; note: string };
}

describe("react-profiler-status without a React runtime", () => {
  it("gives the reason for a Mac app that Metro does not list among other devices", async () => {
    const metro = await startMockMetroCdp({ logicalDeviceId: "ios-logical-1" });
    closers.push(metro.close);

    const res = await status(metro.port, MAC);

    expect(res.session_status).toBe("no_react_runtime");
    expect(res.note).toContain("No JS runtime of the Mac app com.example.focus");
    expect(res.note).toContain("launch-app");
    expect(res.note).not.toContain("Reconnect the debugger");
    expect(res.note).not.toContain("[JsRuntimeDebugger");
  });

  it("gives the reason for a Mac app when Metro lists no runtime", async () => {
    const port = await startEmptyMetro();

    const res = await status(port, MAC);

    expect(res.session_status).toBe("no_react_runtime");
    expect(res.note).toContain("has no CDP targets");
    expect(res.note).toContain("launch-app");
    expect(res.note).not.toContain("Reconnect the debugger");
  });

  it("gives the reason on the other platforms too", async () => {
    const port = await startEmptyMetro();

    const res = await status(port, "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");

    expect(res.session_status).toBe("no_react_runtime");
    expect(res.note).toContain("has no CDP targets");
  });
});
