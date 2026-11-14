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
 * A simulator runtime's libraries are in its runtime bundle. macOS mounts the
 * iOS 27 runtime under `/private/var/run/com.apple.security.cryptexd/mnt/<volume>/`,
 * so their paths do not start with a prefix above:
 * `.../Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.0.simruntime/...`.
 * App binaries of a simulator are under `.../CoreSimulator/Devices/`, never here.
 */
export const SIMULATOR_RUNTIME_PATH_SEGMENT = "/Library/Developer/CoreSimulator/Profiles/Runtimes/";
