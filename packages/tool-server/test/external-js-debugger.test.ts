import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsRuntimeDebuggerBlueprint } from "../src/blueprints/js-runtime-debugger";
import {
  __resetExternalDeviceCacheForTesting,
  __resetProviderWarningsForTesting,
  makeExternalId,
} from "../src/utils/external-devices";

/**
 * React Native admits one debugger per device and evicts the incumbent
 * (`inspector-proxy/Device.js`: a single `#debuggerConnection`, closed with
 * `NEW_DEBUGGER_OPENED`), so both clients would reconnect in a loop and
 * neither would keep a session.
 *
 * A provider re-serving its one connection publishes the socket instead. These
 * assert that the published socket is the one dialled and that Metro still
 * supplies the session's identity, which keeps the alias, source-map root and
 * tool output the same on both paths.
 */

/**
 * What Metro advertises and what Argent dials for it. `selectTarget` rewrites the host.
 */
const METRO_TARGET_URL = "ws://10.0.2.2:54321/inspector/debug?device=1&page=-1";
const METRO_DIALLED_URL = "ws://localhost:54321/inspector/debug?device=1&page=-1";

/** A provider's socket is dialled verbatim. It named a host, so honour it. */
const PROVIDER_SOCKET_URL = "ws://127.0.0.1:60999/argent-cdp";

const dialled = vi.hoisted(() => ({ urls: [] as string[] }));
const sent = vi.hoisted(() => ({ methods: [] as string[] }));

/**
 * Per-runtime, not per-client. On a session Argent is only a guest on, sending
 * these reaches into the debugger of whoever owns it.
 */
const GLOBAL_STATE_METHODS = [
  "Debugger.setAsyncCallStackDepth",
  "Debugger.setPauseOnExceptions",
  "FuseboxClient.setClientMetadata",
  "Runtime.runIfWaitingForDebugger",
];

vi.mock("../src/utils/debugger/cdp-client", () => ({
  CDPClient: class {
    events = {
      emit: () => {},
      off: () => {},
      on: () => {},
    };

    constructor(public readonly url: string) {
      dialled.urls.push(url);
    }

    addBinding = async () => {};
    connect = async () => {};
    disconnect = async () => {};
    evaluate = async () => ({});
    isConnected = () => true;
    pausedAt = () => undefined;

    send = async (method: string) => {
      sent.methods.push(method);
      return {};
    };
  },
}));

vi.mock("../src/utils/debugger/discovery", () => ({
  discoverMetro: async (port: number) => ({
    port,
    projectRoot: "/Users/me/src/my-app",
    targets: [
      {
        description: "",
        deviceName: "iPhone 16 Pro",
        id: "1",
        reactNative: { capabilities: {}, logicalDeviceId: "logical-1" },
        title: "com.example.app",
        webSocketDebuggerUrl: METRO_TARGET_URL,
      },
    ],
  }),
}));

const ANDROID_SERIAL = "emulator-5554";
/** A serial no descriptor claims, the device argent booted for itself. */
const UNCLAIMED_SERIAL = "emulator-5556";
const METRO_PORT = 54321;
/** A second bundler, not the one the provider published. */
const OTHER_METRO_PORT = 8082;
/** `selectTarget` rewrites the host and port onto the session's own bundler. */
const OTHER_METRO_DIALLED_URL = `ws://localhost:${OTHER_METRO_PORT}/inspector/debug?device=1&page=-1`;
const PROVIDER_ID = "acme-3f2a9c";
const DEVICE_ID = makeExternalId(PROVIDER_ID, ANDROID_SERIAL);

let temporaryDirectory: string;

function publishDescriptor(options: { jsDebugger?: boolean; metroPort?: false } = {}): void {
  const descriptorPath = path.join(temporaryDirectory, "acme.json");

  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({
      devices: [
        {
          capabilities: ["adb", "js-debugger"],
          ...(options.jsDebugger ? { jsDebugger: { webSocketUrl: PROVIDER_SOCKET_URL } } : {}),
          kind: "emulator",
          ...(options.metroPort === false ? {} : { metroPort: METRO_PORT }),
          name: "Pixel 9",
          nativeId: ANDROID_SERIAL,
          platform: "android",
          state: "device",
        },
      ],
      id: PROVIDER_ID,
      name: "Acme IDE",
      schemaVersion: 1,
    })
  );

  process.env.ARGENT_DEVICE_PROVIDERS = descriptorPath;
}

async function instantiate() {
  return jsRuntimeDebuggerBlueprint.factory({}, `${METRO_PORT}:${DEVICE_ID}`);
}

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "argent-js-debugger-"));
  dialled.urls.length = 0;
  sent.methods.length = 0;
  delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
  __resetExternalDeviceCacheForTesting();
  __resetProviderWarningsForTesting();
});

afterEach(() => {
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  fs.rmSync(temporaryDirectory, { force: true, recursive: true });
});

describe("a provider that re-serves its own debugger connection", () => {
  it("is attached to instead of Metro's target", async () => {
    publishDescriptor({ jsDebugger: true });

    const instance = await instantiate();

    expect(dialled.urls).toEqual([PROVIDER_SOCKET_URL]);
    expect(dialled.urls).not.toContain(METRO_DIALLED_URL);

    await instance.dispose();
  });

  it("still takes the session's identity from Metro", async () => {
    publishDescriptor({ jsDebugger: true });

    const instance = await instantiate();

    /**
     * Overriding the socket must not cost the metadata. The alias, the
     * source-map root and every tool's device/app labels come from these.
     */
    expect(instance.api.projectRoot).toBe("/Users/me/src/my-app");
    expect(instance.api.deviceName).toBe("iPhone 16 Pro");
    expect(instance.api.appName).toBe("com.example.app");
    expect(instance.api.logicalDeviceId).toBe("logical-1");
    expect(instance.api.port).toBe(METRO_PORT);

    await instance.dispose();
  });

  it("falls back to Metro's target when no socket is published", async () => {
    publishDescriptor();

    const instance = await instantiate();

    expect(dialled.urls).toEqual([METRO_DIALLED_URL]);

    await instance.dispose();
  });

  it("does not reconfigure global debugger state it does not own", async () => {
    publishDescriptor({ jsDebugger: true });

    const instance = await instantiate();

    for (const method of GLOBAL_STATE_METHODS) {
      expect(sent.methods).not.toContain(method);
    }

    /**
     * What it still needs and may safely have. Enables are idempotent and the
     * binding is additive rather than a change to the runtime's configuration.
     */
    expect(sent.methods).toEqual(
      expect.arrayContaining(["Runtime.enable", "Debugger.enable", "ReactNativeApplication.enable"])
    );

    await instance.dispose();
  });

  it("still configures a session it opened itself", async () => {
    publishDescriptor();

    const instance = await instantiate();

    expect(sent.methods).toEqual(expect.arrayContaining(GLOBAL_STATE_METHODS));

    await instance.dispose();
  });

  it("leaves devices argent booted itself on Metro's target", async () => {
    publishDescriptor({ jsDebugger: true });

    const instance = await jsRuntimeDebuggerBlueprint.factory(
      {},
      `${METRO_PORT}:${UNCLAIMED_SERIAL}`
    );

    expect(dialled.urls).toEqual([METRO_DIALLED_URL]);

    await instance.dispose();
  });

  /**
   * The socket re-serves the runtime on the bundler the provider published. A
   * caller naming another bundler is debugging a different runtime, so taking
   * the socket there would send CDP to one app while reporting the metadata of
   * another. The existing "omit the 'port' parameter" hint cannot help, since
   * it only fires when discovery fails.
   */
  it("leaves an explicitly named second bundler on Metro's target", async () => {
    publishDescriptor({ jsDebugger: true });

    const instance = await jsRuntimeDebuggerBlueprint.factory(
      {},
      `${OTHER_METRO_PORT}:${DEVICE_ID}`
    );

    expect(dialled.urls).toEqual([OTHER_METRO_DIALLED_URL]);

    await instance.dispose();
  });

  /** Naming the published port explicitly is still the provider's bundler. */
  it("still attaches when the caller names the published port itself", async () => {
    publishDescriptor({ jsDebugger: true });

    const instance = await jsRuntimeDebuggerBlueprint.factory({}, `${METRO_PORT}:${DEVICE_ID}`);

    expect(dialled.urls).toEqual([PROVIDER_SOCKET_URL]);

    await instance.dispose();
  });

  /** With no published port there is no bundler for the caller to contradict. */
  it("keeps the socket when the provider published no metro port", async () => {
    publishDescriptor({ jsDebugger: true, metroPort: false });

    const instance = await jsRuntimeDebuggerBlueprint.factory(
      {},
      `${OTHER_METRO_PORT}:${DEVICE_ID}`
    );

    expect(dialled.urls).toEqual([PROVIDER_SOCKET_URL]);

    await instance.dispose();
  });

  /**
   * The eviction this whole path avoids does not care which name the caller
   * used. `adb devices` reports the provider's emulator under its raw serial,
   * so a caller reaching for that spelling must land on the published socket
   * too. Otherwise argent opens the second connection and inspector-proxy
   * closes the provider's.
   */
  it("is attached to under the raw serial the provider claims", async () => {
    publishDescriptor({ jsDebugger: true });

    const instance = await jsRuntimeDebuggerBlueprint.factory(
      {},
      `${METRO_PORT}:${ANDROID_SERIAL}`
    );

    expect(dialled.urls).toEqual([PROVIDER_SOCKET_URL]);

    await instance.dispose();
  });
});
