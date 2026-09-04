import { describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { getDescribeTapPoint } from "../src/tools/describe/contract";
import {
  captureSnapshot,
  dragBetween,
  getViewport,
  pressButton,
  pressKeyboardDelete,
  pressKeyboardReturn,
  tapAt,
  toPoints,
  typeText,
  type RunnerViewport,
} from "../src/utils/ios-device/runner-commands";
import { RunnerCommandError } from "../src/utils/ios-device/runner-client";
import type { IosDeviceRunnerApi } from "../src/blueprints/ios-device-runner";

const APP_FRAME: RunnerViewport = { x: 0, y: 0, width: 390, height: 844 };

describe("toPoints (physical iOS 0-1 contract)", () => {
  it("inverts describe's Application-frame normalization", () => {
    const frame = {
      x: 16 / APP_FRAME.width,
      y: 760 / APP_FRAME.height,
      width: 358 / APP_FRAME.width,
      height: 52 / APP_FRAME.height,
    };
    const centre = getDescribeTapPoint(frame);
    const point = toPoints(APP_FRAME, centre.x, centre.y);
    expect(point.x).toBeCloseTo(16 + 358 / 2, 6);
    expect(point.y).toBeCloseTo(760 + 52 / 2, 6);
  });

  it("keeps a non-zero Application origin (offset is applied once, in Swift)", () => {
    const inset: RunnerViewport = { x: 0, y: 20, width: 390, height: 824 };
    const point = toPoints(inset, 0.5, 0.5);
    expect(point).toEqual({ x: 195, y: 20 + 412 });
  });
});

describe("pressButton wire shape", () => {
  it("is not sent as a read-only command: a press is a mutation", async () => {
    const run = vi.fn().mockResolvedValue({});
    const api: IosDeviceRunnerApi = { udid: "00008110-000978540290401E", run };

    await pressButton(api, "home");

    // Read-only would let the client retry a press after a lost reply, pressing
    // twice. Presses recover through the journal instead.
    expect(run.mock.calls[0][1]?.readOnly).toBeUndefined();
  });
});

describe("dragBetween wire shape", () => {
  it("sends holdMs, durationMs and settle only when given", async () => {
    const run = vi.fn().mockResolvedValue({});
    const api: IosDeviceRunnerApi = { udid: "00008110-000978540290401E", run };

    await dragBetween(api, "com.example.app", { x: 1, y: 2 }, { x: 3, y: 4 });
    expect(run.mock.calls[0][0]).toMatchObject({
      command: "drag",
      appBundleId: "com.example.app",
      fromX: 1,
      fromY: 2,
      toX: 3,
      toY: 4,
    });
    for (const key of ["holdMs", "durationMs", "settle"]) {
      expect(run.mock.calls[0][0]).not.toHaveProperty(key);
    }

    await dragBetween(
      api,
      "com.example.app",
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { holdMs: 800, durationMs: 500, settle: true }
    );
    expect(run.mock.calls[1][0]).toMatchObject({ holdMs: 800, durationMs: 500, settle: true });
  });
});

describe("captureSnapshot single-flight", () => {
  it("coalesces identical concurrent requests onto one runner command", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => (release = resolve));
    const run = vi.fn().mockImplementation(() => gate);
    const api: IosDeviceRunnerApi = { udid: "00008110-000978540290401E", run };

    const first = captureSnapshot(api, "com.example.app");
    const second = captureSnapshot(api, "com.example.app");
    release({ nodes: [], quality: null });

    expect(await first).toEqual({ nodes: [], quality: null });
    expect(await second).toEqual({ nodes: [], quality: null });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps different bundle ids and sequential calls separate", async () => {
    const run = vi.fn().mockResolvedValue({ nodes: [], quality: null });
    const api: IosDeviceRunnerApi = { udid: "00008110-000978540290401E", run };

    await Promise.all([
      captureSnapshot(api, "com.example.app"),
      captureSnapshot(api, "com.example.other"),
    ]);
    await captureSnapshot(api, "com.example.app");

    expect(run).toHaveBeenCalledTimes(3);
  });
});

describe("captureSnapshot on a backgrounded target", () => {
  it("maps APP_BACKGROUNDED to the actionable observation error", async () => {
    const run = vi.fn().mockRejectedValue(
      new RunnerCommandError("app 'com.example.app' is running in the background", {
        code: "APP_BACKGROUNDED",
      })
    );
    const api: IosDeviceRunnerApi = { udid: "00008110-000978540290401E", run };

    const error = await captureSnapshot(api, "com.example.app").catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(
      "The app under automation (com.example.app) is backgrounded; the screen is showing " +
        "something else. Use screenshot for the current screen, launch-app to bring the " +
        "app back, or launch-app com.apple.springboard to describe the home screen and " +
        "system UI."
    );
    const signal = getFailureSignal(error);
    expect(signal?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    expect(signal?.failure_stage).toBe("ios_device_snapshot_backgrounded");
  });

  it("passes every other runner failure through untouched", async () => {
    const original = new RunnerCommandError("app 'com.example.app' is not running", {
      code: "APP_NOT_AVAILABLE",
    });
    const run = vi.fn().mockRejectedValue(original);
    const api: IosDeviceRunnerApi = { udid: "00008110-000978540290401E", run };

    const error = await captureSnapshot(api, "com.example.app").catch((caught: unknown) => caught);

    expect(error).toBe(original);
  });
});

describe("mutating replies surface the runner's reactivated stamp", () => {
  const api = (data: unknown): IosDeviceRunnerApi => ({
    udid: "00008110-000978540290401E",
    run: vi.fn().mockResolvedValue(data),
  });
  const point = { x: 100, y: 200 };

  it("tapAt, dragBetween, typeText, pressKeyboardReturn and pressKeyboardDelete read it off the reply", async () => {
    const stamped = { message: "ok", reactivated: true };
    expect(await tapAt(api(stamped), "com.example.app", point)).toEqual({ reactivated: true });
    expect(await dragBetween(api(stamped), "com.example.app", point, { x: 1, y: 2 })).toEqual({
      reactivated: true,
    });
    expect(await typeText(api(stamped), "com.example.app", "hi")).toEqual({ reactivated: true });
    expect(await pressKeyboardReturn(api(stamped), "com.example.app")).toEqual({
      reactivated: true,
    });
    expect(await pressKeyboardDelete(api(stamped), "com.example.app")).toEqual({
      reactivated: true,
    });
  });

  it("reports false unless the stamp is literally true", async () => {
    expect(await tapAt(api({ message: "ok" }), "com.example.app", point)).toEqual({
      reactivated: false,
    });
    // A truthy non-boolean from a drifting runner build must not count: the
    // unwrap is a strict === true, not a truthiness check.
    expect(await tapAt(api({ message: "ok", reactivated: 1 }), "com.example.app", point)).toEqual({
      reactivated: false,
    });
  });
});

describe("getViewport", () => {
  it("reads the runner on every call (no stale keyboard/rotation cache)", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ x: 0, y: 0, width: 390, height: 844 })
      .mockResolvedValueOnce({ x: 0, y: 0, width: 844, height: 390 });
    const api: IosDeviceRunnerApi = { udid: "00008110-000978540290401E", run };

    const first = await getViewport(api, "com.example.app");
    const second = await getViewport(api, "com.example.app");

    expect(run).toHaveBeenCalledTimes(2);
    expect(first).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    expect(second).toEqual({ x: 0, y: 0, width: 844, height: 390 });
  });

  it("surfaces the re-front stamp when the viewport read fronted the app", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ x: 0, y: 0, width: 390, height: 844, reactivated: true });
    const api: IosDeviceRunnerApi = { udid: "00008110-000978540290401E", run };

    const viewport = await getViewport(api, "com.example.app");

    expect(viewport).toEqual({ x: 0, y: 0, width: 390, height: 844, reactivated: true });
  });

  it("stamps the viewport-unavailable rejection with a failure signal", async () => {
    const run = vi.fn().mockResolvedValue({ x: 0, y: 0, width: 0, height: 0 });
    const api: IosDeviceRunnerApi = { udid: "00008110-000978540290401E", run };

    const error = await getViewport(api, "com.example.app").catch((caught: unknown) => caught);

    expect((error as Error).message).toContain("Bring the app to the foreground");
    // Telemetry classification (T44): a degenerate viewport is a per-request
    // rejection, not an unclassified infra fault.
    const signal = getFailureSignal(error);
    expect(signal?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    expect(signal?.failure_stage).toBe("ios_device_viewport");
  });
});
