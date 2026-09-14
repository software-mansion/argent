import { ServiceState, type DeviceInfo, type Registry } from "@argent/registry";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../blueprints/android-devtools";
import type { RotationPeek } from "./device-orientation";

/** Upper bound on a peek — the helper answers in ~1 ms; anything slower is wrong. */
const PEEK_TIMEOUT_MS = 1_000;

/**
 * A rotation source that asks the android-devtools helper — but ONLY when the
 * helper is already running for this device.
 *
 * The helper reports the rotation in ~1 ms (it is the same `getScreenSize` call
 * `describe` already makes), against ~8 ms for the adb-server probe and ~19 ms
 * for a spawned `adb shell`. It is also exactly as authoritative: measured after
 * each of several rotations it matched `dumpsys` on every sample.
 *
 * What this must never do is *start* the helper: resolving the service installs
 * an APK and runs `am instrument` with a 30 s ready timeout, and `screenshot`
 * fires automatically after most tools. So the service state is checked first
 * and a helper that is not RUNNING means "no answer" — the caller then probes
 * over adb, which gives the same rotation a little later. The answer is the
 * same either way; only the latency differs.
 */
export function androidDevtoolsRotationPeek(registry: Registry, device: DeviceInfo): RotationPeek {
  return async () => {
    if (device.platform !== "android") return null;
    const ref = androidDevtoolsRef(device);
    let state: ServiceState;
    try {
      state = registry.getServiceState(ref.urn);
    } catch {
      // Never created → never started. Do not create it here.
      return null;
    }
    if (state !== ServiceState.RUNNING) return null;
    try {
      const api = (await registry.resolveService(ref.urn, ref.options)) as AndroidDevtoolsApi;
      if (!api.isReady()) return null;
      const size = await Promise.race([
        api.getScreenSize(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), PEEK_TIMEOUT_MS).unref?.()),
      ]);
      return size?.rotation ?? null;
    } catch {
      return null;
    }
  };
}
