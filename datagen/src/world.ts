// Builds a fresh World (device pool + runtime state) for a trajectory.

import type { AppArchetype, DeviceState, InjectionPlan, Platform, World } from "./types.ts";
import type { RNG } from "./rng.ts";

const HEX = "0123456789ABCDEF";

function udid(rng: RNG): string {
  const g = (n: number) =>
    Array.from({ length: n }, () => HEX[rng.int(16)]).join("");
  return `${g(8)}-${g(4)}-${g(4)}-${g(4)}-${g(12)}`;
}

const IOS_NAMES = ["iPhone 16 Pro Max", "iPhone 16 Pro", "iPhone 16", "iPhone 15 Pro"];
const ANDROID_AVDS = ["Pixel_8_API_34", "Pixel_7_API_33", "Medium_Phone_API_35"];
const ANDROID_MODELS = ["sdk_gphone64_arm64", "Pixel 8", "Pixel 7"];

export interface BuildWorldOpts {
  app: AppArchetype;
  platform: Platform;
  rng: RNG;
  inject?: InjectionPlan;
  /** Whether the target device starts already booted (false drives boot tasks). */
  deviceBooted?: boolean;
}

export function buildWorld(opts: BuildWorldOpts): World {
  const { app, platform, rng } = opts;
  const booted = opts.deviceBooted ?? true;
  const devices: DeviceState[] = [];
  let deviceId: string;

  if (platform === "ios") {
    const id = udid(rng);
    deviceId = id;
    devices.push({ platform: "ios", id, name: rng.pick(IOS_NAMES), booted });
    // a second, shut-down simulator as a distractor in list-devices
    devices.push({ platform: "ios", id: udid(rng), name: rng.pick(IOS_NAMES), booted: false });
  } else if (platform === "android") {
    const serial = `emulator-${5554 + rng.int(3) * 2}`;
    deviceId = serial;
    const avd = rng.pick(ANDROID_AVDS);
    devices.push({
      platform: "android",
      id: serial,
      name: rng.pick(ANDROID_MODELS),
      booted,
      avdName: avd,
      sdkLevel: 33 + rng.int(3),
    });
  } else {
    const port = 9222 + rng.int(3);
    const id = `chromium-cdp-${port}`;
    deviceId = id;
    devices.push({ platform: "chromium", id, name: app.name, booted: true, port });
  }

  return {
    app,
    platform,
    devices,
    avds: platform === "android" ? [devices[0]!.avdName!, ...ANDROID_AVDS.filter((a) => a !== devices[0]!.avdName).slice(0, 1)] : ANDROID_AVDS.slice(0, 2),
    deviceId,
    simServerRunning: false,
    metroRunning: false,
    debuggerConnected: false,
    androidReversed: false,
    launchedBundle: null,
    currentScreen: app.entryScreen,
    navStack: [],
    scrolledScreens: new Set<string>(),
    fieldValues: {},
    toggles: {},
    reactProfiling: false,
    nativeProfiling: false,
    flowsOnDisk: {},
    networkLog: [],
    clock: 0,
    inject: opts.inject ?? {},
  };
}
