import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { Registry, type ToolCapability } from "@argent/registry";
import {
  assertSupported,
  NotImplementedOnPlatformError,
  UnsupportedOperationError,
} from "../src/utils/capability";
import { dispatchByPlatform } from "../src/utils/cross-platform-tool";
import { resolveDevice } from "../src/utils/device-info";
import { assertMacosAppsEnabled } from "../src/utils/macos-apps";
import { createHttpApp } from "../src/http";
import { createLaunchAppTool } from "../src/tools/launch-app";
import { createRestartAppTool } from "../src/tools/restart-app";
import { openUrlTool } from "../src/tools/open-url";
import { reinstallAppTool } from "../src/tools/reinstall-app";
import { buttonTool } from "../src/tools/button";
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { macosAppBlueprint } from "../src/blueprints/macos-app";
import { useMacosAppsFlag } from "./helpers/macos-apps-flag";

const flag = useMacosAppsFlag();

const MAC = "macos-app-com.example.app";
const FLAG_MESSAGE = "the macos-apps flag is off. Run: argent enable macos-apps";

const MAC_CAPABLE: ToolCapability = { apple: { simulator: true }, macos: { app: true } };
const NOT_MAC_CAPABLE: ToolCapability = { apple: { simulator: true }, chromium: { app: true } };

describe("the macos-apps flag gate", () => {
  it("with the flag off, refuses a Mac id with the flag message, whether or not the tool would support it", () => {
    flag.off();
    const device = resolveDevice(MAC);
    for (const capability of [MAC_CAPABLE, NOT_MAC_CAPABLE]) {
      expect(() => assertSupported("some-tool", capability, device)).toThrow(
        UnsupportedOperationError
      );
      expect(() => assertSupported("some-tool", capability, device)).toThrow(FLAG_MESSAGE);
    }
    expect(() => assertMacosAppsEnabled("boot-device")).toThrow(FLAG_MESSAGE);
  });

  it("with the flag on, admits a tool with a macos block and refuses one without, with a next step where there is one", () => {
    const device = resolveDevice(MAC);
    expect(() => assertSupported("launch-app", MAC_CAPABLE, device)).not.toThrow();
    expect(() => assertSupported("some-tool", NOT_MAC_CAPABLE, device)).toThrow(
      "no macos support declared"
    );
    expect(() => assertSupported("button", NOT_MAC_CAPABLE, device)).toThrow("use keyboard");
    expect(() => assertMacosAppsEnabled("boot-device")).not.toThrow();
  });
});

describe("dispatchByPlatform on a Mac id", () => {
  const ios = { handler: vi.fn(async () => "ios") };
  const android = { handler: vi.fn(async () => "android") };
  const chromium = { handler: vi.fn(async () => "chromium") };
  const macos = { handler: vi.fn(async () => "macos") };

  beforeEach(() => {
    for (const branch of [ios, android, chromium, macos]) branch.handler.mockClear();
  });

  it("runs the macos branch with the tool's services, and only with the flag on", async () => {
    const execute = dispatchByPlatform({
      toolId: "t",
      capability: MAC_CAPABLE,
      ios,
      android,
      chromium,
      macos,
    });
    await expect(execute({ svc: 1 }, { udid: MAC })).resolves.toBe("macos");
    expect(macos.handler).toHaveBeenCalledWith(
      { svc: 1 },
      { udid: MAC },
      resolveDevice(MAC),
      undefined
    );

    // A flow sub-invocation skips the HTTP gate: dispatch checks the flag itself.
    flag.off();
    macos.handler.mockClear();
    await expect(execute({}, { udid: MAC })).rejects.toThrow(FLAG_MESSAGE);
    expect(macos.handler).not.toHaveBeenCalled();
  });

  it("throws NotImplementedOnPlatformError without a macos branch, never the Chromium one", async () => {
    const execute = dispatchByPlatform({
      toolId: "t",
      capability: MAC_CAPABLE,
      ios,
      android,
      chromium,
    });
    const err = await execute({}, { udid: MAC }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotImplementedOnPlatformError);
    expect((err as NotImplementedOnPlatformError).platform).toBe("macos");
    for (const branch of [ios, android, chromium]) expect(branch.handler).not.toHaveBeenCalled();
  });
});

it("the lifecycle tools resolve only the Mac app channel for a Mac id, never a simulator-server or a CDP session", () => {
  const registry = new Registry();
  const channel = { macosApp: { urn: `MacosApp:${MAC}`, options: { device: resolveDevice(MAC) } } };
  const params = { udid: MAC, bundleId: "com.example.app" };
  for (const tool of [createLaunchAppTool(registry), createRestartAppTool(registry)]) {
    expect(tool.services(params)).toEqual(channel);
  }
  expect(openUrlTool.services({ udid: MAC, url: "myapp://x" })).toEqual(channel);
});

describe("over HTTP", () => {
  function app() {
    const registry = new Registry();
    registry.registerBlueprint(macosAppBlueprint);
    registry.registerTool(createLaunchAppTool(registry));
    registry.registerTool(createBootDeviceTool(registry));
    registry.registerTool(reinstallAppTool);
    registry.registerTool(buttonTool);
    return createHttpApp(registry).app;
  }

  it("refuses every Mac call with the flag message while the flag is off", async () => {
    flag.off();
    const http = app();
    for (const [tool, body] of [
      ["launch-app", { udid: MAC, bundleId: "com.example.app" }],
      ["button", { udid: MAC, button: "home" }],
      ["reinstall-app", { udid: MAC, bundleId: "com.example.app", appPath: "/x.app" }],
      ["boot-device", { udid: MAC }],
      ["boot-device", { macosAppPath: "/nowhere/Example.app" }],
    ] as const) {
      const res = await request(http).post(`/tools/${tool}`).send(body);
      expect({ tool, status: res.status }).toEqual({ tool, status: 400 });
      expect(res.body.error).toContain(FLAG_MESSAGE);
    }
  });

  it("with the flag on, names restart-app instead of reinstall-app", async () => {
    const res = await request(app())
      .post("/tools/reinstall-app")
      .send({ udid: MAC, bundleId: "com.example.app", appPath: "/x.app" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not install Mac apps.*restart-app/);
  });

  it("boot-device takes macosAppPath as one more exclusive target and checks the path", async () => {
    const both = await request(app())
      .post("/tools/boot-device")
      .send({ udid: MAC, macosAppPath: "/nowhere/Example.app" });
    expect(both.body.error).toMatch(/Provide exactly one of .*`macosAppPath` \(Mac app\)/);
    const missing = await request(app())
      .post("/tools/boot-device")
      .send({ macosAppPath: `${process.env.HOME}/Missing.app` });
    expect(missing.status).toBe(500);
    expect(missing.body.error_code).toBe("MACOS_APP_PATH_INVALID");
  });
});
