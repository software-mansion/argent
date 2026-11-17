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
 * On a physical iPhone, xctrace gives system binaries their symbol path in
 * Xcode's per-device cache; app binaries never live there.
 */
export const DEVICE_SUPPORT_PATH_SEGMENT = "/Library/Developer/Xcode/iOS DeviceSupport/";
