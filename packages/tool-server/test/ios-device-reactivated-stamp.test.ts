import { beforeEach, describe, expect, it, vi } from "vitest";
import { Registry, type DeviceInfo } from "@argent/registry";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { gestureSwipeTool } from "../src/tools/gesture-swipe";
import { gestureCustomTool } from "../src/tools/gesture-custom";
import { makeIosDeviceImpl } from "../src/tools/keyboard/platforms/ios-device";
import {
  clearCurrentIosDeviceApp,
  setCurrentIosDeviceApp,
} from "../src/utils/ios-device/app-session";

// The runner stamps a reply `reactivated: true` when it had to re-front a
// backgrounded target to run the command. These tests pin that the stamp
// reaches the TOOL results (gesture-tap/swipe/custom/keyboard), so an agent
// learns the action changed the foreground screen as a side effect. The stamp
// can ride either leg of a gesture: the viewport read is the one that fronts
// the app, so the gesture reply that follows is typically unstamped.

// Physical-iOS UDID shape (8 hex, dash, 16 hex); see utils/device-info.ts.
const UDID = "00008110-000978540290401E";
const BUNDLE_ID = "com.example.app";
const DEVICE: DeviceInfo = { id: UDID, platform: "ios", kind: "device" };

const VIEWPORT = { x: 0, y: 0, width: 390, height: 844 };

function runnerServices(options: { viewportReactivated?: boolean; gestureReactivated?: boolean }) {
  const run = vi.fn(async (req: Record<string, unknown>) =>
    req.command === "viewport"
      ? { ...VIEWPORT, ...(options.viewportReactivated ? { reactivated: true } : {}) }
      : { message: "ok", ...(options.gestureReactivated ? { reactivated: true } : {}) }
  );
  return { run, services: { iosDeviceRunner: { udid: UDID, run } } as never };
}

beforeEach(() => {
  clearCurrentIosDeviceApp(UDID);
  setCurrentIosDeviceApp(UDID, BUNDLE_ID);
});

describe("gesture-tap surfaces the re-front stamp", () => {
  it("from the viewport leg (the read that fronts the app)", async () => {
    const { services } = runnerServices({ viewportReactivated: true });
    const result = await gestureTapTool.execute(services, { udid: UDID, x: 0.5, y: 0.5 });
    expect(result.reactivated).toBe(true);
  });

  it("from the gesture leg", async () => {
    const { services } = runnerServices({ gestureReactivated: true });
    const result = await gestureTapTool.execute(services, { udid: UDID, x: 0.5, y: 0.5 });
    expect(result.reactivated).toBe(true);
  });

  it("omits the field entirely when nothing re-fronted", async () => {
    const { services } = runnerServices({});
    const result = await gestureTapTool.execute(services, { udid: UDID, x: 0.5, y: 0.5 });
    expect("reactivated" in result).toBe(false);
  });
});

describe("gesture-swipe surfaces the re-front stamp", () => {
  it("sets it when a leg re-fronted, omits it otherwise", async () => {
    const stamped = await gestureSwipeTool.execute(
      runnerServices({ viewportReactivated: true }).services,
      { udid: UDID, fromX: 0.5, fromY: 0.7, toX: 0.5, toY: 0.3 }
    );
    expect(stamped.reactivated).toBe(true);

    const clean = await gestureSwipeTool.execute(runnerServices({}).services, {
      udid: UDID,
      fromX: 0.5,
      fromY: 0.7,
      toX: 0.5,
      toY: 0.3,
    });
    expect("reactivated" in clean).toBe(false);
  });
});

describe("gesture-custom surfaces the re-front stamp", () => {
  it("sets it when a leg re-fronted, omits it otherwise", async () => {
    const events = [
      { type: "Down" as const, x: 0.5, y: 0.5 },
      { type: "Up" as const, x: 0.5, y: 0.5, delayMs: 800 },
    ];

    const stamped = await gestureCustomTool.execute(
      runnerServices({ gestureReactivated: true }).services,
      { udid: UDID, events }
    );
    expect(stamped).toEqual({ events: 2, reactivated: true });

    const clean = await gestureCustomTool.execute(runnerServices({}).services, {
      udid: UDID,
      events,
    });
    expect(clean).toEqual({ events: 2 });
  });
});

describe("keyboard (ios-device) surfaces the re-front stamp", () => {
  function keyboardRegistry(options: { reactivated: boolean }): Registry {
    const api = {
      udid: UDID,
      run: vi.fn(async () => ({
        message: "ok",
        ...(options.reactivated ? { reactivated: true } : {}),
      })),
    };
    return { resolveService: vi.fn(async () => api) } as unknown as Registry;
  }

  it("sets it when typing re-fronted the app", async () => {
    const impl = makeIosDeviceImpl(keyboardRegistry({ reactivated: true }));
    const result = await impl.handler({}, { udid: UDID, text: "hello" }, DEVICE);
    expect(result).toEqual({ typed: "hello", keys: 5, reactivated: true });
  });

  it("omits it when the app was already foreground", async () => {
    const impl = makeIosDeviceImpl(keyboardRegistry({ reactivated: false }));
    const result = await impl.handler({}, { udid: UDID, key: "enter" }, DEVICE);
    expect(result).toEqual({ typed: "enter", keys: 1 });
  });
});
