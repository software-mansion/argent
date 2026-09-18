/**
 * Advisory for the iOS description paths that report coordinates in the app's
 * upright space while the device's touch space is portrait-native.
 *
 * Background (#609). On a rotated iOS simulator the surfaces disagree:
 *
 *   `describe` via ax-service   portrait-native  — matches where taps land
 *   `describe` via native-devtools  upright      — does NOT match
 *   `native-describe-screen`        upright      — does NOT match
 *   gesture-* input                 portrait-native
 *
 * Measured on a landscape iPad Pro 13-inch: the same button reads
 * `(0.238, 0.342)` from ax-service and `(0.342, 0.762)` from native-devtools,
 * related by `ax.x = 1 - native.y`, `ax.y = native.x` — a 90° rotation.
 *
 * The aspect check only catches the landscape orientations. PortraitUpsideDown
 * keeps a portrait screen frame while its coordinates are 180° off touch space,
 * so no hint fires there; `rotate` still warns when it is the one rotating.
 *
 * These coordinates are deliberately NOT transformed here. The only orientation
 * signal available is the screen's aspect, which gives the axis but not the
 * sense — it cannot separate LandscapeLeft from LandscapeRight, and those differ
 * by 180°. Rotating on a guess would turn a visible mismatch into taps that land
 * somewhere plausible but wrong, which is far harder to notice. Saying so is the
 * honest fix until the orientation itself is on the wire.
 */

interface ScreenFrameLike {
  width: number;
  height: number;
}

/** Is the app reporting a screen wider than it is tall, i.e. a rotated device? */
export function isLandscapeScreenFrame(frame: ScreenFrameLike | undefined): boolean {
  if (!frame) return false;
  return frame.width > frame.height;
}

export const LANDSCAPE_COORDINATE_HINT =
  "Device is rotated: these coordinates are in the app's upright space, not touch space, so tapping them will miss; tap from `describe` with source ax-service.";

/**
 * What `rotate` tells the caller on iOS.
 *
 * It deliberately does not stop at "pass `rotation` to fix the image". Doing
 * only that is the trap the issue reports: the readable capture is then in the
 * app's upright space while `describe` frames and touch input stay in the
 * device's unrotated one, so coordinates read off that image miss.
 */
export const IOS_ROTATED_CAPTURE_NOTE =
  "iOS screenshots stay in the unrotated space; take tap coordinates from `describe`, never from a `rotation`-corrected capture.";

/**
 * The note `rotate` returns on iOS for a given target orientation.
 *
 * Rotating back to Portrait puts capture, touch and the app's own space back in
 * agreement, so there is nothing to warn about there.
 */
export function iosRotateNote(orientation: string): string | undefined {
  return orientation === "Portrait" ? undefined : IOS_ROTATED_CAPTURE_NOTE;
}

/**
 * Combine an existing hint with the landscape advisory.
 *
 * Existing hints stay first: `describe`'s other hints tell the caller the
 * simulator needs rebooting or the app cannot be inspected at all, and those are
 * blocking problems where this advisory would only be noise.
 */
export function withLandscapeHint(
  existing: string | undefined,
  frame: ScreenFrameLike | undefined
): string | undefined {
  if (!isLandscapeScreenFrame(frame)) return existing;
  return existing ? `${existing} ${LANDSCAPE_COORDINATE_HINT}` : LANDSCAPE_COORDINATE_HINT;
}
