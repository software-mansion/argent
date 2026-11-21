import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  // A fixed HOME: which name fits sun_path depends on its length.
  beforeEach(() => {
    vi.stubEnv("HOME", "/Users/dev");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
    expect(hashed?.env).toBe(hashed?.path);
    expect(hashed?.path).toMatch(/^\/Users\/dev\/\.argent\/macos\/[0-9a-f]{16}\.sock$/);
    expect(Buffer.byteLength(hashed!.path)).toBeLessThanOrEqual(103);
    // A container path cannot be renamed, so a long one has no socket at all.
    expect(macosListenSocket(long, true)).toBeNull();
    // Nor has any app under a home too long for the hashed name.
    vi.stubEnv("HOME", `/Users/${"h".repeat(80)}`);
    expect(macosListenSocket(long, false)).toBeNull();
  });
});

describe("the kind of a Mac app id", () => {
  let home = "";
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-macos-kind-"));
    vi.stubEnv("HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const file = () => path.join(home, ".argent", "macos-apps.json");
  /** As argent writes the record: a new file renamed into place. */
  const record = (content: unknown) => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const tmp = `${file()}.tmp`;
    fs.writeFileSync(tmp, typeof content === "string" ? content : JSON.stringify(content));
    fs.renameSync(tmp, file());
  };
  const kind = (bundleId: string) => resolveDevice(`macos-app-${bundleId}`).kind;

  it("is catalyst only for a bundle id whose last start argent recorded as Mac Catalyst", () => {
    expect(kind("com.example.app")).toBe("app");
    record([
      { bundleId: "com.example.app", catalyst: true },
      { bundleId: "com.example.appkit", catalyst: false },
      { bundleId: "com.example.old" },
    ]);
    expect(resolveDevice("macos-app-com.example.app")).toEqual({
      id: "macos-app-com.example.app",
      platform: "macos",
      kind: "catalyst",
    });
    expect(kind("com.example.appkit")).toBe("app");
    expect(kind("com.example.old")).toBe("app");
    expect(kind("com.example.never")).toBe("app");
    expect(resolveDevice("macos-app-bad_id").kind).toBe("app");

    // The newest start wins: the same bundle id rebuilt as an AppKit app, and back.
    record([{ bundleId: "com.example.app", catalyst: false }]);
    expect(kind("com.example.app")).toBe("app");
    record([{ bundleId: "com.example.app", catalyst: true }]);
    expect(kind("com.example.app")).toBe("catalyst");
  });

  it.each([
    ["a torn file", '[{ "bundleId": "com.example.app", "catalyst": tr'],
    ["no list", { bundleId: "com.example.app", catalyst: true }],
    ["damaged entries", [null, 7, { bundleId: "com.example.app", catalyst: "yes" }]],
  ])("is app for %s", (_label, content) => {
    record([{ bundleId: "com.example.app", catalyst: true }]);
    expect(kind("com.example.app")).toBe("catalyst");
    record(content);
    expect(kind("com.example.app")).toBe("app");
  });

  it("is app once the file is gone", () => {
    record([{ bundleId: "com.example.app", catalyst: true }]);
    expect(kind("com.example.app")).toBe("catalyst");
    fs.rmSync(file());
    expect(kind("com.example.app")).toBe("app");
  });
});
