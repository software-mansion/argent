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

export const SYSTEM_LIBRARY_PATH_PREFIXES: string[] = [
  "/usr/lib/",
  "/System/Library/",
  "/Library/Developer/CoreSimulator/",
];

/**
 * On a physical iPhone, xctrace gives system binaries the path of their symbols
 * in Xcode's per-device cache: `~/Library/Developer/Xcode/iOS DeviceSupport/<device>/Symbols/...`.
 * App binaries never live there.
 */
export const DEVICE_SUPPORT_PATH_SEGMENT = "/Library/Developer/Xcode/iOS DeviceSupport/";
