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
export type DroppedGeometry = "rotation" | "scale";

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

function list(dropped: DroppedGeometry[]): string {
  return dropped.length === 2 ? "scale and rotation" : dropped[0]!;
}

/**
 * Chromium can do both transforms — it just needs `sharp`, which is optional
 * and not shipped — so this case is worth telling the caller how to fix.
 */
export function chromiumDropNote(dropped: DroppedGeometry[]): string | undefined {
  if (dropped.length === 0) return undefined;
  return (
    `${list(dropped)} was not applied — this is the unmodified capture. Chromium image ` +
    `post-processing needs the optional \`sharp\` package: run \`npm install sharp\` in the ` +
    `tool-server's environment and retry, or work with the full-size image.`
  );
}

/**
 * The TV backends have no rotation step. Worded so it does not read as
 * retryable — the same call will always come back the same way.
 */
export function unsupportedDropNote(
  dropped: DroppedGeometry[],
  target: string
): string | undefined {
  if (dropped.length === 0) return undefined;
  return (
    `${list(dropped)} was not applied — ${target} screenshots cannot be transformed that way, ` +
    `so retrying with the same parameter will not change the result. The image is the ` +
    `untransformed capture.`
  );
}
