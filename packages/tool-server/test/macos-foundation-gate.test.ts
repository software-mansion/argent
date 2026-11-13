import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { unsetFlag } from "@argent/configuration-core";
import { Registry, ToolNotFoundError, type ToolCapability } from "@argent/registry";
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
import { menuBarTool } from "../src/tools/menu-bar";
import { macosAppBlueprint } from "../src/blueprints/macos-app";
import { createRegistry } from "../src/utils/setup-registry";
import { directiveCommandHint } from "../src/tools/flows/flow-add-step";
import { runDirective } from "../src/tools/flows/flow-actions";
import { parseFlow, parseRequires } from "../src/tools/flows/flow-utils";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { useMacosAppsFlag } from "./helpers/macos-apps-flag";

const flag = useMacosAppsFlag();

const MAC = "macos-app-com.example.app";
const FLAG_MESSAGE = "the macos-apps flag is off. Run: argent enable macos-apps";
const HOST_MESSAGE = "native Mac apps can only be driven on macOS";

/** For the rest of the test; `useMacosAppsFlag` puts the real platform back after it. */
function onLinux(): void {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
}

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

  it("off macOS, refuses a Mac id with the host message with the flag on, and with the flag message without it", () => {
    onLinux();
    const device = resolveDevice(MAC);
    for (const capability of [MAC_CAPABLE, NOT_MAC_CAPABLE]) {
      expect(() => assertSupported("some-tool", capability, device)).toThrow(HOST_MESSAGE);
    }
    expect(() => assertMacosAppsEnabled("boot-device")).toThrow(HOST_MESSAGE);

    flag.off();
    expect(() => assertSupported("launch-app", MAC_CAPABLE, device)).toThrow(FLAG_MESSAGE);
    expect(() => assertMacosAppsEnabled("boot-device")).toThrow(FLAG_MESSAGE);
  });
});

describe("with no stored macos-apps value", () => {
  beforeEach(() => {
    unsetFlag("macos-apps", "global");
  });

  it("is on: admits a Mac id and a macosAppPath start", () => {
    expect(() => assertSupported("launch-app", MAC_CAPABLE, resolveDevice(MAC))).not.toThrow();
    expect(() => assertMacosAppsEnabled("boot-device")).not.toThrow();
  });

  it("lists the Mac app tools and text, and the production registry dispatches them", async () => {
    const registry = createRegistry();
    const { tools } = (await request(createHttpApp(registry).app).get("/tools")).body as {
      tools: { name: string; description: string }[];
    };
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["menu-bar", "file-panel"]));
    expect(tools.find((t) => t.name === "boot-device")!.description).toContain("macosAppPath");
    // Past the registry's flag gate, which reads a gated tool as not found.
    const err = await registry
      .invokeTool("menu-bar", { udid: MAC, action: "list" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ToolNotFoundError);
  });

  it("off macOS, leaves the Mac app out of the errors and hints an agent reads", async () => {
    const registry = createRegistry();
    const android = resolveDevice("emulator-5554");
    const failure = async (run: () => Promise<unknown>) => String(await run().catch((e) => e));
    // Every text that renders `<flag:macos-apps>` for an agent, outside GET /tools.
    const texts = async () => [
      await failure(() => registry.invokeTool("boot-device", { udid: "x", avdName: "y" })),
      await failure(() =>
        gestureTapTool.execute({}, { udid: android.id, x: 0.5, y: 0.5, button: "right" })
      ),
      (
        await runDirective(
          { registry, device: android },
          { kind: "tap", x: 0.5, y: 0.5, button: "right" }
        )
      ).reason,
      directiveCommandHint("swipe"),
      directiveCommandHint("scroll-to"),
    ];
    const MAC_TEXT = /macosAppPath|Mac app|macOS/;
    for (const text of await texts()) expect(text).toMatch(MAC_TEXT);

    onLinux();
    for (const text of await texts()) expect(text).not.toMatch(MAC_TEXT);
  });

  it("off macOS, an e2e parse error does not name macos, and the parser still accepts it", () => {
    const failure = (run: () => unknown): string => {
      try {
        run();
      } catch (err) {
        return String(err);
      }
      throw new Error("expected a parse error");
    };
    const steps = (step: string) => `steps:\n  - ${step}\n`;
    // Every parse error that lists the platforms.
    const texts = () => [
      failure(() => parseRequires({ platform: "windows" })),
      failure(() => parseRequires({ platform: [] })),
      failure(() => parseFlow(steps("when: { platform: windows }\n    steps:\n      - echo: x"))),
      failure(() => parseFlow(steps("launch: { amdroid: com.example.app }"))),
      failure(() => parseFlow(steps("launch: { android: 5 }"))),
    ];
    const accepted = () => {
      expect(parseRequires({ platform: ["ios", "macos"] }).platform).toEqual(["ios", "macos"]);
      const flow = parseFlow(
        steps('launch: { macos: { app: com.example.app, args: ["-x"] } }') +
          "  - when: { platform: macos }\n    steps:\n      - echo: x\n"
      );
      expect(JSON.stringify(flow.steps)).toContain("macos");
    };
    for (const text of texts()) expect(text).toMatch(/\bmacos\b/);
    accepted();

    onLinux();
    for (const text of texts()) expect(text).not.toMatch(/\bmacos\b/);
    accepted();

    // With the flag off the text was already without `macos`; that holds on a Mac.
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    flag.off();
    for (const text of texts()) expect(text).not.toMatch(/\bmacos\b/);
    accepted();
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

    // And the host.
    flag.on();
    onLinux();
    await expect(execute({}, { udid: MAC })).rejects.toThrow(HOST_MESSAGE);
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
    registry.registerTool(openUrlTool);
    registry.registerTool(menuBarTool);
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

  it("off macOS, refuses every Mac call with the host message, before reading the bundle", async () => {
    onLinux();
    const http = app();
    for (const [tool, body] of [
      ["launch-app", { udid: MAC, bundleId: "com.example.app" }],
      ["open-url", { udid: MAC, url: "myapp://x" }],
      ["boot-device", { udid: MAC }],
      ["boot-device", { macosAppPath: "/nowhere/Example.app" }],
    ] as const) {
      const res = await request(http).post(`/tools/${tool}`).send(body);
      expect({ tool, status: res.status }).toEqual({ tool, status: 400 });
      expect(res.body.error).toContain(HOST_MESSAGE);
    }
  });

  it("lists the Mac app tools and text on macOS only", async () => {
    const listed = async () => {
      const { tools } = (await request(app()).get("/tools")).body as {
        tools: { name: string; description: string; inputSchema: { properties: object } }[];
      };
      const boot = tools.find((t) => t.name === "boot-device")!;
      return {
        menuBar: tools.some((t) => t.name === "menu-bar"),
        macosAppPath: "macosAppPath" in boot.inputSchema.properties,
        text: boot.description.includes("macosAppPath"),
      };
    };
    expect(await listed()).toEqual({ menuBar: true, macosAppPath: true, text: true });
    onLinux();
    expect(await listed()).toEqual({ menuBar: false, macosAppPath: false, text: false });
    const menuBar = await request(app())
      .post("/tools/menu-bar")
      .send({ udid: MAC, action: "list" });
    expect(menuBar.status).toBe(404);
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

describe("Mac app launches", () => {
  it("hand a repeat of a launch in flight with the same options that launch's result", async () => {
    const { api, dispose } = await macosAppBlueprint.factory({}, "macos-app-com.example.repeat");
    // The MCP adapter sends a call again when its attempt times out.
    const first = api.launch({ takeOver: true });
    expect(api.launch({ takeOver: true })).toBe(first);
    const other = api.launch({ takeOver: true, args: ["-x"] });
    expect(other).not.toBe(first);
    await Promise.allSettled([first, other]);
    // Once it is over, the same options start a launch of their own.
    const later = api.launch({ takeOver: true });
    expect(later).not.toBe(first);
    await Promise.allSettled([later]);
    await dispose();
  });
});
