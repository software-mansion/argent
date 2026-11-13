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
