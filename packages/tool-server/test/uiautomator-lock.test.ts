import { beforeEach, describe, expect, it, vi } from "vitest";

// Both uiautomator dump sites shell out through adbExecOutBinary; record how
// many run at once per serial.
const inFlight = new Map<string, number>();
const peak = new Map<string, number>();
let totalInFlight = 0;
let totalPeak = 0;
vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/adb")>("../src/utils/adb");
  return {
    ...actual,
    adbShell: vi.fn(async () => "Physical size: 1920x1080"),
    getAndroidRuntimeKind: vi.fn(async () => "tv" as const),
    adbExecOutBinary: vi.fn(async (serial: string) => {
      const n = (inFlight.get(serial) ?? 0) + 1;
      inFlight.set(serial, n);
      peak.set(serial, Math.max(peak.get(serial) ?? 0, n));
      totalPeak = Math.max(totalPeak, ++totalInFlight);
      await new Promise((r) => setTimeout(r, 20));
      totalInFlight -= 1;
      inFlight.set(serial, (inFlight.get(serial) ?? 1) - 1);
      return Buffer.from(
        `<?xml version='1.0'?><hierarchy rotation="0"><node class="android.widget.Button" content-desc="Play" text="" bounds="[0,0][100,50]" focusable="true" focused="true" enabled="true" package="com.example.tv" /></hierarchy>`
      );
    }),
  };
});

import { describeAndroid } from "../src/tools/describe/platforms/android";
import { androidTvControlBlueprint } from "../src/blueprints/android-tv-control";

async function tvApi(serial: string) {
  const device = { id: serial, platform: "android" as const, kind: "emulator" as const };
  return (await androidTvControlBlueprint.factory({}, device, { device })).api;
}

describe("uiautomator dumps on one device", () => {
  beforeEach(() => {
    inFlight.clear();
    peak.clear();
    totalInFlight = 0;
    totalPeak = 0;
  });

  it("never overlap across the describe and Android TV dump sites", async () => {
    const api = await tvApi("emulator-5554");

    await Promise.all([
      api.describe(),
      describeAndroid(undefined, "emulator-5554", undefined, true),
      api.describe(),
      describeAndroid(undefined, "emulator-5554", undefined, true),
    ]);

    expect(peak.get("emulator-5554")).toBe(1);
  });

  it("still run in parallel on different devices", async () => {
    const [a, b] = await Promise.all([tvApi("emulator-5554"), tvApi("emulator-5556")]);

    await Promise.all([a.describe(), b.describe()]);

    expect(totalPeak).toBe(2);
  });
});
