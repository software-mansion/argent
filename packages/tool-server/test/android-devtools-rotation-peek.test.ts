import { describe, it, expect, vi } from "vitest";
import {
  ServiceNotFoundError,
  ServiceState,
  type DeviceInfo,
  type Registry,
} from "@argent/registry";
import { androidDevtoolsRotationPeek } from "../src/utils/android-devtools-rotation-peek";

const ANDROID: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };
const IOS: DeviceInfo = { id: "BC0026C7-AAE0-490E", platform: "ios", kind: "simulator" };

/** A registry that knows one android-devtools service in a given state. */
function fakeRegistry(
  state: ServiceState | "never-created",
  api?: { isReady?: () => boolean; getScreenSize?: () => Promise<unknown> }
) {
  const resolveService = vi.fn(async () => ({
    isReady: () => true,
    getScreenSize: async () => ({ width: 2424, height: 1080, rotation: 1 }),
    ...api,
  }));
  const getServiceState = vi.fn((urn: string) => {
    if (state === "never-created") throw new ServiceNotFoundError(urn);
    return state;
  });
  return { registry: { resolveService, getServiceState } as unknown as Registry, resolveService };
}

describe("androidDevtoolsRotationPeek", () => {
  it("answers from a running, ready helper", async () => {
    const { registry, resolveService } = fakeRegistry(ServiceState.RUNNING);
    expect(await androidDevtoolsRotationPeek(registry, ANDROID)()).toBe(1);
    expect(resolveService).toHaveBeenCalledTimes(1);
  });

  it("never creates the service when it has not been started", async () => {
    // This is the property that makes the peek safe inside `screenshot`:
    // resolving would install an APK and run `am instrument`.
    const { registry, resolveService } = fakeRegistry("never-created");
    expect(await androidDevtoolsRotationPeek(registry, ANDROID)()).toBeNull();
    expect(resolveService).not.toHaveBeenCalled();
  });

  it.each([ServiceState.IDLE, ServiceState.STARTING, ServiceState.TERMINATING, ServiceState.ERROR])(
    "does not resolve a service in state %s",
    async (state) => {
      const { registry, resolveService } = fakeRegistry(state);
      expect(await androidDevtoolsRotationPeek(registry, ANDROID)()).toBeNull();
      expect(resolveService).not.toHaveBeenCalled();
    }
  );

  it("has no answer for a helper that is running but not yet ready", async () => {
    const { registry } = fakeRegistry(ServiceState.RUNNING, { isReady: () => false });
    expect(await androidDevtoolsRotationPeek(registry, ANDROID)()).toBeNull();
  });

  it("has no answer when the helper RPC fails", async () => {
    const { registry } = fakeRegistry(ServiceState.RUNNING, {
      getScreenSize: async () => {
        throw new Error("socket closed");
      },
    });
    expect(await androidDevtoolsRotationPeek(registry, ANDROID)()).toBeNull();
  });

  it("ignores non-Android devices without touching the registry", async () => {
    const { registry, resolveService } = fakeRegistry(ServiceState.RUNNING);
    expect(await androidDevtoolsRotationPeek(registry, IOS)()).toBeNull();
    expect(resolveService).not.toHaveBeenCalled();
  });
});
