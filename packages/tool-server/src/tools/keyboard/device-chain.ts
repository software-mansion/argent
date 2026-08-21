/**
 * One in-flight `keyboard` run per device, chained.
 *
 * Nothing else serializes tool calls against a device — the registry hands
 * concurrent calls the same session and every transport writes immediately — and
 * each backend's run holds state ACROSS awaits that a second call lands inside:
 *
 *   - iOS holds a modifier down across the whole chord (see `pressKeyCode`), so
 *     `{ text: "w" }` arriving 15ms behind a `{ clear: true }` reached the guest
 *     as Cmd+W (an app `UIKeyCommand` or a system shortcut): the character was
 *     never typed while the call still reported it as typed. Shift had the same
 *     window before `clear` existed, where the worst outcome was a mis-cased
 *     character; Command is the modifier that makes it destructive.
 *   - Android's modern clear issues the select-all (`input keycombination`) and
 *     the delete (`input keyevent`) as two separate adb invocations, leaving the
 *     field fully SELECTED in between, and its text goes out as a third. A
 *     character arriving in that window replaces the whole selection.
 *   - Chromium runs the clear and then the typing loop as many separate CDP
 *     round trips.
 *
 * On iOS the intruding keystroke is swallowed by the modifier; on Android and
 * Chromium it is typed OVER a full selection, which destroys the value. Measured
 * on this branch before the chain covered them, both with `{ clear, text }` and
 * every call returning 200 with its own text as `typed`:
 *
 *   - Android API 36, `AAAA` against `BBBB` at 10/20/30/50ms — 4 of 4 corrupt,
 *     `ABABABAB`, `AABABBB`, `AAABABBB`, `AAAABBBB`, where a serial outcome is
 *     `AAAA` or `BBBB`;
 *   - Chromium, the same pair at 0ms — `ABABABAB`, both calls reporting
 *     `cleared: true` and their own four characters.
 *
 * It needs only ONE caller overlapping two calls, not two agents.
 *
 * Chaining, not rejecting: overlapping calls are a legitimate thing for a caller
 * to do, they just cannot interleave. Each device's chain is dropped once it
 * drains, so this holds no state for an idle device.
 */
const typeChains = new Map<string, Promise<void>>();

export function serializePerDevice<T>(deviceId: string, run: () => Promise<T>): Promise<T> {
  const previous = typeChains.get(deviceId) ?? Promise.resolve();
  const result = previous.then(run);
  // What gets STORED is a tail that never rejects, so a call that threw neither
  // blocks the queue behind it nor leaves an unhandled rejection on a promise
  // nobody awaits. The caller still gets `result`, rejection and all.
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  typeChains.set(deviceId, tail);
  void tail.then(() => {
    // Only drop the slot when nothing queued behind this call, so a waiter is
    // never handed a drained chain and allowed to overtake the run in flight.
    if (typeChains.get(deviceId) === tail) typeChains.delete(deviceId);
  });
  return result;
}

/**
 * The key a device's chain is filed under: the caller's own device string,
 * case-folded.
 *
 * Case-folded, because `device.id` is the caller's own string verbatim
 * (`resolveDevice` classifies an iOS UDID by shape and never canonicalises it),
 * while the state this serializes lives at the DEVICE and is shared by every
 * spelling. Measured on an iPhone 17 Pro simulator, 7/7: a `{ text: "w" }`
 * addressed in lowercase ran INSIDE the Left GUI hold of a `{ clear: true }`
 * addressed in uppercase, and the `w` never reached the field while the call
 * reported it as typed — the exact corruption this chain exists to prevent. No
 * two distinct devices can collide under case-folding: an adb serial and a
 * chromium id are already lower-case, and a UDID is hex.
 */
export const deviceChainKey = (deviceId: string): string => deviceId.toLowerCase();
