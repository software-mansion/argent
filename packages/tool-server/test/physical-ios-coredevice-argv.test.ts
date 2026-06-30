/**
 * Coverage for the actual pymobiledevice3 command line the CoreDevice backend
 * shells out, plus the iOS-27 host-input gate translation. The rest of the
 * physical-iOS suite mocks the CoreDeviceApi wholesale, so the real argv strings
 * (`developer core-device universal-hid-service drag …`, `… hid button … press`,
 * `… screen-capture screenshot …`) and the `conciseError` 9021 mapping were
 * untested — a pmd3 CLI rename or a typo in those arrays would ship silently.
 *
 * These tests drive `coreDeviceBlueprint.factory` end to end, mocking only the
 * `node:child_process` execFile boundary (so the genuine argv is asserted) and
 * the tunneld HTTP lookup (so no real device/tunnel is needed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DeviceInfo } from "@argent/registry";

// Hoisted so the vi.mock factory below can close over the same mock instance.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

// The flag gate is exercised elsewhere; here it's always on so the factory runs.
vi.mock("@argent/configuration-core", () => ({ isFlagEnabled: () => true }));

// Override only execFile; keep the rest of child_process real so unrelated
// imports in the graph are unaffected. `promisify(execFile)` (run at module
// load) then wraps this mock with the default callback convention.
vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

import { coreDeviceBlueprint } from "../src/blueprints/core-device";

const PHYSICAL_UDID = "00008120-000E6D0C0ABBA01E";
const TUNNEL = { address: "fd11:2233::1", port: 54321 };
const device: DeviceInfo = { id: PHYSICAL_UDID, platform: "ios", kind: "device" };

type CommandResult = { stdout?: string; stderr?: string } | { error: unknown };

/**
 * Build the CoreDevice API with the factory, recording every real interaction
 * command's argv. The setup probes (`version`, `mounter auto-mount`) are
 * answered with success and not recorded; the per-interaction command (anything
 * starting with `developer`) is recorded and answered by `onCommand`.
 */
async function makeApi(onCommand: (file: string, args: string[]) => CommandResult) {
  const calls: Array<{ file: string; args: string[] }> = [];
  execFileMock.mockImplementation((...all: unknown[]) => {
    const cb = all[all.length - 1] as (err: unknown, res?: unknown) => void;
    const file = all[0] as string;
    const args = all[1] as string[];
    const sub = args[0];
    if (sub === "version" || sub === "mounter") {
      cb(null, { stdout: "", stderr: "" });
      return;
    }
    calls.push({ file, args });
    const r = onCommand(file, args);
    if ("error" in r) cb(r.error);
    else cb(null, { stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
  });
  const instance = await coreDeviceBlueprint.factory({}, "ignored" as never, { device });
  return { api: instance.api, calls };
}

beforeEach(() => {
  execFileMock.mockReset();
  // tunneld REST lookup: report this device's RSD endpoint so resolveTunnel
  // succeeds without a real tunnel.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        [PHYSICAL_UDID]: [{ "tunnel-address": TUNNEL.address, "tunnel-port": TUNNEL.port }],
      }),
    }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CoreDevice pmd3 argv (the exact command line, untested elsewhere)", () => {
  const rsd = ["--rsd", TUNNEL.address, String(TUNNEL.port)];

  it("tap → `universal-hid-service drag` with a short held dwell move + RSD endpoint", async () => {
    const { api, calls } = await makeApi(() => ({ stdout: "" }));
    await api.tap(0.5, 0.5);
    expect(calls).toHaveLength(1);
    // 0.5 → 32768; the dwell move nudges y by +96 (away from the edge) so a
    // zero-dwell contact isn't dropped by iOS.
    expect(calls[0]!.args).toEqual([
      "developer",
      "core-device",
      "universal-hid-service",
      "drag",
      "32768",
      "32768",
      "32768",
      "32864",
      "--steps",
      "3",
      "--duration",
      "0.15",
      ...rsd,
    ]);
  });

  it("button → `hid button <name> press` with RSD endpoint", async () => {
    const { api, calls } = await makeApi(() => ({ stdout: "" }));
    await api.button("home");
    expect(calls[0]!.args).toEqual([
      "developer",
      "core-device",
      "hid",
      "button",
      "home",
      "press",
      ...rsd,
    ]);
  });

  it("screenshot → `screen-capture screenshot <tmp .png>` with RSD endpoint", async () => {
    const { api, calls } = await makeApi(() => ({ stdout: "" }));
    const { path } = await api.screenshot();
    const args = calls[0]!.args;
    expect(args.slice(0, 4)).toEqual(["developer", "core-device", "screen-capture", "screenshot"]);
    expect(args[4]).toMatch(/argent-ios-shot-.*\.png$/);
    expect(args.slice(5)).toEqual(rsd);
    // The capture path returned to the caller is the one passed to pmd3.
    expect(path).toBe(args[4]);
  });

  it("swipe → `universal-hid-service drag` from→to with clamped step count + RSD endpoint", async () => {
    const { api, calls } = await makeApi(() => ({ stdout: "" }));
    await api.swipe(0.2, 0.8, 0.6, 0.4, 300);
    expect(calls[0]!.args).toEqual([
      "developer",
      "core-device",
      "universal-hid-service",
      "drag",
      "13107", // toHid(0.2)
      "52428", // toHid(0.8)
      "39321", // toHid(0.6)
      "26214", // toHid(0.4)
      "--steps",
      "19", // round(300/16), capped at 60
      "--duration",
      "0.300",
      ...rsd,
    ]);
  });
});

describe("iOS-27 host-input gate (CoreDeviceError 9021) is translated, screenshot unaffected", () => {
  const gated = Object.assign(new Error("Command failed: pymobiledevice3 … 9021"), {
    stderr: "CoreDeviceError 9021: The operation could not be completed.",
    stdout: "",
    code: 1,
  });

  it("tap surfaces an actionable iOS-27 message instead of the raw 9021 line", async () => {
    const { api } = await makeApi(() => ({ error: gated }));
    const e = (await api.tap(0.5, 0.5).catch((x: unknown) => x)) as Error;
    expect(e.message).toMatch(/requires iOS 27\+/);
    expect(e.message).toMatch(/Only screenshot is supported/i);
    expect(e.message).toContain("CoreDeviceError 9021");
    // Names the attempted interaction so the user knows what was gated.
    expect(e.message).toContain("tap");
    // The raw pmd3 error is preserved as the cause for diagnostics.
    expect((e as Error & { cause?: unknown }).cause).toBe(gated);
  });

  it("button is gated identically", async () => {
    const { api } = await makeApi(() => ({ error: gated }));
    const e = (await api.button("home").catch((x: unknown) => x)) as Error;
    expect(e.message).toMatch(/requires iOS 27\+/);
  });

  it("screenshot still works on the same pre-iOS-27 device (screen-capture is not gated)", async () => {
    // Same device: host input (hid) is rejected with 9021, but screen-capture
    // succeeds — exactly the documented pre-27 behavior.
    const { api } = await makeApi((_file, args) =>
      args[2] === "screen-capture" ? { stdout: "" } : { error: gated }
    );
    await expect(api.tap(0.5, 0.5)).rejects.toThrow(/requires iOS 27\+/);
    const { path } = await api.screenshot();
    expect(path).toMatch(/argent-ios-shot-.*\.png$/);
  });

  it("does NOT mistranslate a non-9021 failure (the mapping is 9021-specific)", async () => {
    const refused = Object.assign(new Error("boom"), {
      stderr: "Connection refused by the device",
      stdout: "",
      code: 1,
    });
    const { api } = await makeApi(() => ({ error: refused }));
    const e = (await api.tap(0.5, 0.5).catch((x: unknown) => x)) as Error;
    expect(e.message).toContain("CoreDevice tap failed:");
    expect(e.message).toContain("Connection refused");
    expect(e.message).not.toMatch(/iOS 27/);
  });

  it("does NOT mistranslate a HID coordinate that merely contains 9021 in the echoed argv", async () => {
    // execFile's error `message` echoes the argv; a coordinate like 29021 must
    // not trip the gate detection (which only inspects stderr/stdout).
    const coordErr = Object.assign(
      new Error("Command failed: pymobiledevice3 developer core-device … 29021"),
      { stderr: "the device handshake failed", stdout: "", code: 1 }
    );
    const { api } = await makeApi(() => ({ error: coordErr }));
    const e = (await api.tap(0.5, 0.5).catch((x: unknown) => x)) as Error;
    expect(e.message).not.toMatch(/iOS 27/);
    expect(e.message).toContain("handshake failed");
  });
});
