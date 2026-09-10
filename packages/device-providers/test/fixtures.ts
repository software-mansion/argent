/** Descriptor fixtures shared by the package's tests. */

export const ANDROID_SERIAL = "emulator-5554";
export const IOS_UDID = "1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809";

export function androidDevice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capabilities: ["adb", "simulator-server"],
    kind: "emulator",
    name: "Pixel 8",
    nativeId: ANDROID_SERIAL,
    platform: "android",
    simulatorServer: {
      apiUrl: "http://127.0.0.1:52002",
      streamUrl: "http://127.0.0.1:52002/stream.mjpeg",
    },
    state: "device",
    ...overrides,
  };
}

export function iosDevice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capabilities: ["ax-service", "simctl", "simulator-server"],
    deviceSet: "/tmp/acme/Devices/iOS",
    kind: "simulator",
    name: "iPhone 16 Pro",
    nativeId: IOS_UDID,
    platform: "ios",
    simulatorServer: {
      apiUrl: "http://127.0.0.1:52001",
      streamUrl: "http://127.0.0.1:52001/stream.mjpeg",
      version: "1.20.0",
    },
    state: "Booted",
    ...overrides,
  };
}

export function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    devices: [iosDevice()],
    id: "acme-3f2a9c",
    name: "Acme IDE",
    schemaVersion: 1,
    supportUrl: "https://example.invalid/issues",
    workspace: { name: "my-app", path: "/Users/me/src/my-app" },
    ...overrides,
  };
}

/**
 * Stand-in for the tool-server's `classifyDevice`, which the package takes as a
 * parameter rather than owning. The smallest rule that separates the fixtures.
 */
export function classify(nativeId: string): string {
  return /^[0-9A-F]{8}-[0-9A-F]{4}/i.test(nativeId) ? "ios" : "android";
}
