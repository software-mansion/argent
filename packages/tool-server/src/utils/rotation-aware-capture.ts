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
import { isIosSimulator } from "./device-info";
import { readUiOrientation, unknownOrientationNote } from "./ios-ui-orientation";
import { uprightCaptureRotation } from "./ui-orientation";

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
 * On an iOS simulator the capture, the frames and the touches are all in the
 * screen's portrait-native space, so a landscape UI lies sideways in each.
 * Agents work in the upright space there too: `describe` turns its frames and
 * `sendCommand` turns touches back (`utils/ios-ui-orientation.ts`), and the
 * capture is turned here by the interface orientation the ax-service reports.
 * That orientation follows the app, not the device, so a portrait-only app on
 * a rotated device is captured unturned, the way it is drawn.
 *
 * The result carries a `note` when an iOS simulator's orientation could not be
 * read, and the capture went out unturned.
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
): Promise<{ url: string; path: string; note?: string }> {
  // An explicit rotation from the caller always wins.
  if (requestedRotation !== undefined) return capture(api, requestedRotation, signal, scale);
  if (isIosSimulator(device)) return captureIosUpright(api, device, signal, scale, capture);
  if (device.platform !== "android") return capture(api, undefined, signal, scale);

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

async function captureIosUpright(
  api: SimulatorServerApi,
  device: DeviceInfo,
  signal: AbortSignal | undefined,
  scale: number | undefined,
  capture: typeof httpScreenshot
): Promise<{ url: string; path: string; note?: string }> {
  const read = await readUiOrientation(device.id);
  if (read.orientation === undefined) {
    const result = await capture(api, undefined, signal, scale);
    return read.unknownReason === undefined
      ? result
      : { ...result, note: unknownOrientationNote(read, "this screenshot is in") };
  }
  const rotation = uprightCaptureRotation(read.orientation);
  if (!rotation) return capture(api, undefined, signal, scale);
  const result = await capture(api, rotation, signal, scale);
  // As on Android: a capture that comes back with the wrong aspect means the
  // naming between UIKit and simulator-server has moved, and the image would
  // disagree with every frame describe hands out. Say so rather than hide it.
  if (!captureLooksUpright(rotation, await readPngSize(result.path))) {
    console.warn(
      `[screenshot] ${device.id}: requested ${rotation} for interface orientation ` +
        `${read.orientation}, but the capture came back with the opposite aspect. ` +
        `simulator-server's rotation handling may have changed.`
    );
  }
  return result;
}
