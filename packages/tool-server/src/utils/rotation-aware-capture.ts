import type { SimulatorServerApi } from "../blueprints/simulator-server";
import type { DeviceInfo } from "@argent/registry";
import {
  captureLooksUpright,
  captureRotationForSurface,
  readAndroidSurfaceRotation,
  readPngSize,
  type RotationPeek,
} from "./device-orientation";
import { httpScreenshot } from "./simulator-client";

/**
 * Capture a screenshot that is the right way up on a rotated device.
 *
 * Background (#609): on a rotated Android device the capture came back
 * portrait-framed with the content lying sideways, while `describe` and the
 * gesture tools were already reporting and accepting *upright* coordinates —
 * uiautomator measures against the rotated display. So the screenshot was the
 * one surface out of step, and an agent reading it saw an image whose geometry
 * disagreed with every coordinate it was given.
 *
 * simulator-server already knows how to hand back an upright frame; it just has
 * to be told which rotation to apply. Nothing tracks orientation here — the
 * rotation is queried from the device each time. A cached value could only ever
 * be staler than a ~40 ms probe, and serving a stale orientation is precisely
 * the failure this fixes.
 *
 * The android-devtools helper also reports rotation, ~1 ms against ~8 ms for an
 * adb probe — but resolving that service *installs and starts* it (APK install,
 * `am instrument`, a 30 s ready timeout), and `screenshot` is `alwaysLoad` and
 * fires automatically after more than a dozen tools. So it is consulted only
 * when it is already running (`peek`), and otherwise the rotation is read over
 * adb. Both answer with the same platform value, so the capture comes out
 * upright either way; only the latency depends on whether `describe` ran first.
 *
 * iOS is deliberately untouched. There the whole surface (describe frames,
 * gesture input, capture) is consistently in the portrait-native space, so
 * rotating only the capture would break the agreement rather than restore it.
 */
export async function captureScreenshotUpright(
  api: SimulatorServerApi,
  device: DeviceInfo,
  requestedRotation: string | undefined,
  signal?: AbortSignal,
  scale?: number,
  capture: typeof httpScreenshot = httpScreenshot,
  // Optional cheaper rotation source (the running android-devtools helper).
  // Purely a latency optimisation: with or without it the same rotation is read.
  peek?: RotationPeek
): Promise<{ url: string; path: string }> {
  // An explicit rotation from the caller always wins, and no other platform
  // takes this path, so both cases are byte-identical to the previous behaviour.
  if (requestedRotation !== undefined || device.platform !== "android") {
    return capture(api, requestedRotation, signal, scale);
  }

  const surface = await readAndroidSurfaceRotation(device.id, peek);
  const rotation = captureRotationForSurface(surface);
  // Unrotated, or the rotation could not be read: send no rotation at all, exactly
  // as before. An unreadable rotation must never become a guess.
  if (!rotation) return capture(api, undefined, signal, scale);

  const result = await capture(api, rotation, signal, scale);

  // The mapping from surface rotation to rotation name compensates for a
  // rotation simulator-server itself applies while decoding the video stream. If
  // that layer changes, the compensation quietly becomes a 180° error or a
  // no-op, and no test of our own constant could notice. Checking the delivered
  // image's aspect against the rotation we asked for is the check that would.
  if (!captureLooksUpright(rotation, await readPngSize(result.path))) {
    console.warn(
      `[screenshot] ${device.id}: requested ${rotation} for surface rotation ${surface}, ` +
        `but the capture came back with the opposite aspect. Falling back to an ` +
        `unrotated capture — simulator-server's rotation handling may have changed.`
    );
    return capture(api, undefined, signal, scale);
  }

  return result;
}
