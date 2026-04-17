export type Platform = "ios" | "android";

/**
 * Classify a device id as an iOS Simulator UDID or an Android adb serial.
 *
 * iOS udids come in two shapes:
 *   - Classic UUID: `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX` (8-4-4-4-12 hex)
 *   - iOS 17+ short form:  `XXXXXXXX-XXXXXXXXXXXXXXXX` (8-16 hex)
 *
 * Everything else — `emulator-5554`, `RF8M123`, `192.168.1.7:5555`, etc. —
 * is treated as an Android adb serial. This is a lossy heuristic but it
 * covers every real-world form we have seen and never misclassifies an iOS
 * UDID as Android.
 */
export function detectPlatform(udid: string): Platform {
  if (/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(udid)) {
    return "ios";
  }
  if (/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$/.test(udid)) {
    return "ios";
  }
  return "android";
}
