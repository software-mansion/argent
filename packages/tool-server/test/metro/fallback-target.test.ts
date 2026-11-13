import { createHash } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { FAILURE_CODES, Registry, getFailureSignal } from "@argent/registry";
import {
  jsRuntimeDebuggerBlueprint,
  type JsRuntimeDebuggerApi,
} from "../../src/blueprints/js-runtime-debugger";
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";
import { createDebuggerStatusTool } from "../../src/tools/debugger/debugger-status";
import type { DebuggerNotConnectedResult } from "../../src/tools/debugger/not-connected";
import { resetDeviceAliases } from "../../src/utils/debugger/device-alias";
import { RESULT_NOTE_KEY as NOTE } from "../../src/tools/screenshot/dropped-geometry";
import { scopeTempHome } from "../helpers/temp-home";

const DEVICE_MISMATCH_GUIDANCE =
  "No target on this Metro is known to run on your device_id. The detail lists what Metro " +
  "has and what to do.";

/**
 * What adb reads (see src/utils/debugger/android-device-name.ts): the names of
 * an Android serial (undefined: adb cannot read it), and whether adb lists
 * another online device.
 */
const androidNames = vi.hoisted(() =>
  vi.fn(async (_serial: string): Promise<string[] | undefined> => undefined)
);
const otherDeviceOnline = vi.hoisted(() =>
  vi.fn(async (_serial: string): Promise<boolean> => false)
);
vi.mock("../../src/utils/debugger/android-device-name", () => ({
  androidDeviceNames: (serial: string) => androidNames(serial),
  otherAndroidDeviceOnline: (serial: string) => otherDeviceOnline(serial),
}));

scopeTempHome("argent-fallback-target-home-");

/**
 * React Native's Apple inspector id: `sha256("apple-<identifierForVendor>-<bundle
 * id>-fusebox")`, first 40 hex digits. A Mac app has no vendor id.
 */
function appleLogicalId(bundleId: string, vendorId = ""): string {
  return createHash("sha256")
    .update(`apple-${vendorId}-${bundleId}-fusebox`)
    .digest("hex")
    .slice(0, 40);
}

interface Device {
  /** Absent on the legacy inspector (RN 0.72, Vega), which lists no `reactNative` block. */
  logicalDeviceId?: string;
  deviceName: string;
  appId: string;
}

const MAC = {
  logicalDeviceId: appleLogicalId("com.example.focus"),
  deviceName: "Unknown",
  appId: "com.example.focus",
} satisfies Device;
const IPHONE = {
  logicalDeviceId: appleLogicalId("com.example.app", "5C1B6E9A-0D2F-4A47-9E3B-7A1D2C3E4F50"),
  deviceName: "iPhone 17 Pro",
  appId: "com.example.app",
} satisfies Device;
const PIXEL = {
  logicalDeviceId: "904f32cb7611d7a43b99a5276e18506a3505b892",
  deviceName: "sdk_gphone64_arm64 - 16 - API 36",
  appId: "com.example.app",
} satisfies Device;

/** A simulator UDID no simulator has. */
const MADE_UP_UDID = "0D3C2B1A-9F8E-4D7C-B6A5-948372615F00";
const SERIAL = "emulator-5582";

/** What Metro lists: one Fusebox page per device. */
let listed: Device[] = [];
let server: http.Server;
let wss: WebSocketServer;
let port: number;
let registry: Registry;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/status") {
      res.setHeader("X-React-Native-Project-Root", "/mock/project");
      res.end("packager-status:running");
      return;
    }
    if (req.url === "/json/list") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          listed.map((d, i) =>
            d.logicalDeviceId
              ? {
                  id: `${d.logicalDeviceId}-1`,
                  title: `${d.appId} (${d.deviceName})`,
                  description: "React Native Bridgeless [C++ connection]",
                  appId: d.appId,
                  type: "node",
                  webSocketDebuggerUrl: `ws://localhost:${port}/inspector/debug?device=${d.logicalDeviceId}&page=1`,
                  deviceName: d.deviceName,
                  reactNative: {
                    logicalDeviceId: d.logicalDeviceId,
                    capabilities: { prefersFuseboxFrontend: true },
                  },
                }
              : {
                  id: `${i}-1`,
                  title: "Hermes React Native",
                  description: d.appId,
                  webSocketDebuggerUrl: `ws://localhost:${port}/inspector/debug?device=${i}&page=1`,
                  deviceName: d.deviceName,
                }
          )
        )
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const { id, method } = JSON.parse(raw.toString()) as { id: number; method: string };
      if (method === "Runtime.evaluate") {
        ws.send(JSON.stringify({ id, result: { result: { type: "string", value: "ok" } } }));
        return;
      }
      ws.send(JSON.stringify({ id, result: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
});

beforeEach(() => {
  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerTool(debuggerConnectTool);
  registry.registerTool(createDebuggerStatusTool(registry));
});

afterEach(async () => {
  await registry.dispose();
  resetDeviceAliases();
  androidNames.mockReset();
  otherDeviceOnline.mockReset();
});

function connect(deviceId: string): Promise<Record<string, unknown>> {
  return registry.invokeTool("debugger-connect", { port, device_id: deviceId });
}

async function refusal(deviceId: string): Promise<Error> {
  const err = await connect(deviceId).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  expect(getFailureSignal(err)).toMatchObject({
    error_code: FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH,
    failure_stage: "debugger_select_target",
  });
  return err as Error;
}

describe("a device_id that matches no target, when Metro lists one device", () => {
  describe("refuses the runtime of a Mac app", () => {
    beforeEach(() => {
      listed = [MAC];
    });

    it("for a simulator UDID, and lists the Mac app", async () => {
      const err = await refusal(MADE_UP_UDID);

      expect(err.message).toContain(
        `No debugger target matches device_id "${MADE_UP_UDID}". Metro on port ${port} lists ` +
          `one device, the Mac app com.example.focus (${MAC.logicalDeviceId}), which runs on ` +
          `this Mac.`
      );
      expect(err.message).toContain('"macos-app-com.example.focus"');
    });

    it("for an Android serial, without asking adb", async () => {
      await refusal(SERIAL);

      expect(androidNames).not.toHaveBeenCalled();
    });

    it("in debugger-status as a device_mismatch", async () => {
      const result = (await registry.invokeTool("debugger-status", {
        port,
        device_id: MADE_UP_UDID,
      })) as DebuggerNotConnectedResult;

      expect(result.status).toBe("not_connected");
      expect(result.reason).toBe("device_mismatch");
      expect(result.detail).toContain("the Mac app com.example.focus");
      // The only logicalDeviceId in the detail is the Mac app's, and the detail says
      // what to do. The guidance gives no fix of its own that could disagree.
      expect(result.detail).toContain("Launch the app on");
      expect(result.guidance).toBe(DEVICE_MISMATCH_GUIDANCE);
    });

    it("but still connects the Mac app's own id, with no note", async () => {
      const api = await registry.resolveService<JsRuntimeDebuggerApi>(
        `JsRuntimeDebugger:${port}:macos-app-com.example.focus`
      );

      expect(api.logicalDeviceId).toBe(MAC.logicalDeviceId);
      expect(api.fallbackNote).toBeUndefined();
    });
  });

  describe("for an Android serial", () => {
    it("refuses a runtime whose device name is not the serial's", async () => {
      listed = [IPHONE];
      androidNames.mockResolvedValue(["sdk_gphone64_arm64 - 16 - API 36", "sdk_gphone64_arm64"]);

      const err = await refusal(SERIAL);

      expect(androidNames).toHaveBeenCalledWith(SERIAL);
      expect(err.message).toContain(
        `Metro on port ${port} lists one device, iPhone 17 Pro (${IPHONE.logicalDeviceId}), ` +
          `and "${SERIAL}" reports the name "sdk_gphone64_arm64 - 16 - API 36".`
      );
    });

    it("connects a runtime with the serial's name, with no note when no other device is online", async () => {
      listed = [PIXEL];
      androidNames.mockResolvedValue(["sdk_gphone64_arm64 - 16 - API 36", "sdk_gphone64_arm64"]);

      const result = await connect(SERIAL);

      expect(result.logicalDeviceId).toBe(PIXEL.logicalDeviceId);
      expect(otherDeviceOnline).toHaveBeenCalledWith(SERIAL);
      expect(result).not.toHaveProperty(NOTE);
    });

    it("names the runtime when another adb device is online", async () => {
      // Emulators built from one system image all report one name.
      listed = [PIXEL];
      androidNames.mockResolvedValue(["sdk_gphone64_arm64 - 16 - API 36", "sdk_gphone64_arm64"]);
      otherDeviceOnline.mockResolvedValue(true);

      const result = await connect(SERIAL);

      expect(result.logicalDeviceId).toBe(PIXEL.logicalDeviceId);
      expect(result[NOTE]).toBe(
        `Argent connected to the only runtime on Metro port ${port}: sdk_gphone64_arm64 - 16 - ` +
          `API 36 (${PIXEL.logicalDeviceId}), app com.example.app. Metro does not list device ` +
          `ids, so this is a guess. If the app does not run on this device_id, launch it ` +
          `there, call stop-all-simulator-servers with devices [this device_id], and connect ` +
          `again.`
      );
    });

    it("connects a Genymotion device, which reports its model alone", async () => {
      listed = [{ ...PIXEL, deviceName: "Google Pixel 3" }];
      androidNames.mockResolvedValue(["Google Pixel 3 - 9 - API 28", "Google Pixel 3"]);

      const result = await connect(SERIAL);

      expect(result.logicalDeviceId).toBe(PIXEL.logicalDeviceId);
    });

    it("connects, with the note, when adb cannot read the serial", async () => {
      listed = [IPHONE];

      const result = await connect(SERIAL);

      expect(result.logicalDeviceId).toBe(IPHONE.logicalDeviceId);
      expect(result[NOTE]).toContain(
        `iPhone 17 Pro (${IPHONE.logicalDeviceId}), app com.example.app`
      );
    });
  });

  it("connects a simulator UDID to a lone iOS app and names it, also in debugger-status", async () => {
    listed = [IPHONE];

    const connected = await connect(MADE_UP_UDID);
    const status = (await registry.invokeTool("debugger-status", {
      port,
      device_id: MADE_UP_UDID,
    })) as Record<string, unknown>;

    expect(connected[NOTE]).toContain(
      `the only runtime on Metro port ${port}: iPhone 17 Pro (${IPHONE.logicalDeviceId})`
    );
    expect(status.status).toBe("connected");
    expect(status[NOTE]).toBe(connected[NOTE]);
    // Only an Android serial has a device name to read.
    expect(androidNames).not.toHaveBeenCalled();
  });

  it("leaves the choice of a device to the detail when Metro lists two or more", async () => {
    listed = [IPHONE, PIXEL];

    const result = (await registry.invokeTool("debugger-status", {
      port,
      device_id: MADE_UP_UDID,
    })) as DebuggerNotConnectedResult;

    expect(result.reason).toBe("device_mismatch");
    expect(result.detail).toContain(`2 devices are connected to Metro on port ${port}`);
    expect(result.detail).toContain("Re-target with the logicalDeviceId in parentheses");
    expect(result.guidance).toBe(DEVICE_MISMATCH_GUIDANCE);
  });

  it("adds no note for a legacy-inspector runtime, which no device_id can ever pick", async () => {
    // A Vega app: RN 0.72's inspector lists no logicalDeviceId.
    listed = [{ deviceName: "kepler-device", appId: "com.example.vega" }];

    const connected = await connect("amazon-a1b2c3d4e5");
    const status = (await registry.invokeTool("debugger-status", {
      port,
      device_id: "amazon-a1b2c3d4e5",
    })) as Record<string, unknown>;

    expect(connected.deviceName).toBe("kepler-device");
    expect(connected).not.toHaveProperty(NOTE);
    expect(status.status).toBe("connected");
    expect(status).not.toHaveProperty(NOTE);
  });

  it("adds no note when the device_id is the runtime's logicalDeviceId", async () => {
    listed = [IPHONE];

    const result = await connect(IPHONE.logicalDeviceId);

    expect(result.logicalDeviceId).toBe(IPHONE.logicalDeviceId);
    expect(result).not.toHaveProperty(NOTE);
  });
});
