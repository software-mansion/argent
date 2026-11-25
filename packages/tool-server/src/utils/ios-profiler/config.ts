export const RN_FRAMEWORK_SIGNATURES: string[] = [
  "RCT",
  "Yoga",
  "Hermes",
  "hermes::",
  "JSI",
  "facebook::",
  "React",
  "jsi::",
  "HermesRuntime",
];

/**
 * Libraries that tools load into the profiled app, by file name, with the tool
 * that owns them. Their frames are that tool's work, not the app's: argent's
 * describe, taps and network capture, and the recorder that Instruments'
 * Allocations instrument injects when it attaches.
 */
export const TOOLING_LIBRARIES: ReadonlyMap<string, ToolingOwner> = new Map([
  ["libNativeDevtoolsIos.dylib", "argent"],
  ["libNativeDevtoolsMacos.dylib", "argent"],
  ["libArgentInjectionBootstrap.dylib", "argent"],
  ["libKeyboardPatch.dylib", "argent"],
  ["liboainject.dylib", "instruments"],
]);

export type ToolingOwner = "argent" | "instruments";

export const SYSTEM_LIBRARY_PATH_PREFIXES: string[] = [
  "/usr/lib/",
  "/System/Library/",
  "/Library/Developer/CoreSimulator/",
];

/**
 * On a physical iPhone, xctrace gives system binaries their symbol path in
 * Xcode's per-device cache; app binaries never live there.
 */
export const DEVICE_SUPPORT_PATH_SEGMENT = "/Library/Developer/Xcode/iOS DeviceSupport/";
