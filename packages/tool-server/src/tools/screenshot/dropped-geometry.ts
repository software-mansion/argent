/**
 * Notes for geometry the caller asked for that a capture could not apply.
 *
 * `screenshot` takes `scale` and `rotation` on every target, but several
 * backends cannot honour them: Chromium needs the optional `sharp` package,
 * and the Apple TV and Vega captures have no rotation step at all. Without a
 * note the caller gets a full-size, un-rotated PNG that looks like a successful
 * transform, and the only existing signal — a stderr line — is written once per
 * process and never reaches whoever asked.
 */
type DroppedGeometry = "rotation" | "scale";

/** Reserved result key hoisted into the response envelope's `note` by http.ts. */
export const RESULT_NOTE_KEY = "__argentNote";

/**
 * Which of the caller's geometry parameters were requested but not applied.
 *
 * A parameter counts only when the caller actually asked for something the
 * backend then ignored. Two no-ops are deliberately not reported: `rotation:
 * "Portrait"` is the identity rotation, and `scale: 1` is full size — a visual
 * snapshot passes `scale: 1` on every step, and flagging that would attach a
 * note to captures where nothing was lost. The `ARGENT_SCREENSHOT_SCALE`
 * default is likewise never reported, because the caller never asked for it.
 */
export function requestedGeometry(params: {
  rotation?: string | undefined;
  scale?: number | undefined;
}): DroppedGeometry[] {
  const requested: DroppedGeometry[] = [];
  if (params.rotation !== undefined && params.rotation !== "Portrait") requested.push("rotation");
  if (params.scale !== undefined && params.scale > 0 && params.scale < 1) requested.push("scale");
  return requested;
}

/** "scale was" / "scale and rotation were" — subject and verb agree. */
function subject(dropped: DroppedGeometry[]): string {
  return dropped.length === 2 ? "scale and rotation were" : `${dropped[0]!} was`;
}

/**
 * Chromium can do both transforms — it just needs `sharp`, which is optional
 * and not shipped — so the common case is worth telling the caller how to fix.
 * The rarer `png-header-unreadable` reason gets different wording: there,
 * `sharp` IS installed and a requested rotation still ran, so "unmodified
 * capture" and "install sharp" would both be wrong.
 */
export function chromiumDropNote(
  dropped: DroppedGeometry[],
  reason: "sharp-missing" | "png-header-unreadable" = "sharp-missing"
): string | undefined {
  if (dropped.length === 0) return undefined;
  if (reason === "png-header-unreadable") {
    return (
      `${subject(dropped)} not applied — the captured PNG's header could not be read, so the ` +
      `resize could not be sized. A rotation requested on the same call was still applied. ` +
      `\`sharp\` is already installed; retrying the same call will likely lose the scale again.`
    );
  }
  return (
    `${subject(dropped)} not applied — this is the unmodified capture. Chromium image ` +
    `post-processing needs the optional \`sharp\` package: run \`npm install sharp\` in the ` +
    `tool-server's environment and retry, or work with the full-size image.`
  );
}

/**
 * The TV backends have no rotation step. Worded so it does not read as
 * retryable — the same call will always come back the same way. It says
 * "unrotated" rather than "untransformed" because a `scale` on the same call
 * IS applied (server-side); only the rotation is missing.
 */
export function unsupportedDropNote(
  dropped: DroppedGeometry[],
  target: string
): string | undefined {
  if (dropped.length === 0) return undefined;
  return (
    `${subject(dropped)} not applied — ${target} screenshots cannot be transformed that way, ` +
    `so retrying with the same parameter will not change the result. The image is returned ` +
    `unrotated.`
  );
}
