import { describe, expect, it } from "vitest";
import {
  classifyDevice,
  macosAppIdFromBundleId,
  parseMacosAppBundleId,
  resolveDevice,
} from "../src/utils/device-info";
import {
  DEVICE_OWNED_NAMESPACES,
  transportNamespacesForPlatform,
} from "../src/tools/simulator/device-services";
import { MACOS_APP_NAMESPACE } from "../src/blueprints/macos-app";
import { macosListenSocket } from "../src/utils/macos-apps";

describe("Mac app device ids", () => {
  it("classify by the macos-app- prefix alone as a macos app, not as an Android serial", () => {
    expect(resolveDevice("macos-app-com.example.app")).toEqual({
      id: "macos-app-com.example.app",
      platform: "macos",
      kind: "app",
    });
    // Also for a tail the parser rejects: the capability gate then refuses it
    // with a macOS message instead of an adb error.
    expect(classifyDevice("macos-app-bad_id")).toBe("macos");
    expect(classifyDevice("com.example.app")).toBe("android");
  });

  it("round-trip a bundle id", () => {
    for (const bundleId of ["com.example.app", "com.Example-App.v2", "9gag.app"]) {
      expect(parseMacosAppBundleId(macosAppIdFromBundleId(bundleId))).toBe(bundleId);
    }
  });

  it.each([
    ["no prefix", "com.example.app"],
    ["empty tail", "macos-app-"],
    ["leading dash", "macos-app--rf"],
    ["leading dot", "macos-app-.hidden"],
    ["underscore", "macos-app-com.example_app"],
    ["slash", "macos-app-com.example/../app"],
    ["quote", "macos-app-com.example'app"],
    ["space", "macos-app-com example"],
    ["chromium id", "chromium-cdp-9222"],
  ])("reject %s", (_label, id) => {
    expect(parseMacosAppBundleId(id)).toBeNull();
  });

  it("name the in-app library channel as the transport, never a simulator-server", () => {
    expect(transportNamespacesForPlatform("macos")).toEqual([MACOS_APP_NAMESPACE]);
    expect(DEVICE_OWNED_NAMESPACES).toContain(MACOS_APP_NAMESPACE);
  });
});

describe("macosListenSocket", () => {
  it("gives a sandboxed app the CONTAINER marker and a plain app a socket under ~/.argent/macos", () => {
    const sandboxed = macosListenSocket("com.example.app", true);
    expect(sandboxed?.env).toBe("CONTAINER");
    expect(sandboxed?.path).toMatch(
      /\/Library\/Containers\/com\.example\.app\/Data\/tmp\/argent-nd\.sock$/
    );
    const plain = macosListenSocket("com.example.app", false);
    expect(plain?.env).toBe(plain?.path);
    expect(plain?.path).toMatch(/\/\.argent\/macos\/com\.example\.app\.sock$/);
  });

  it("falls back to a hashed name, then to none, so the path fits sun_path", () => {
    const long = `com.${"a".repeat(80)}`;
    const hashed = macosListenSocket(long, false);
    if (hashed) {
      expect(hashed.path).toMatch(/\/\.argent\/macos\/[0-9a-f]{16}\.sock$/);
      expect(Buffer.byteLength(hashed.path)).toBeLessThanOrEqual(103);
    }
    // A container path cannot be renamed, so a long one has no socket at all.
    expect(macosListenSocket(long, true)).toBeNull();
  });
});
