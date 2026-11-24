/**
 * A finger that a gesture-custom train left down between calls, per device,
 * so a screenshot, describe or await-ui-element can observe a pressed state.
 *
 * Only one touch sequence can be in flight on a device, so any touch Down
 * (gesture-tap, gesture-swipe, pinch, rotate, a new gesture-custom train)
 * lifts a held finger first: `sendCommand` does that through
 * `takeHeldTouch`. A held finger nobody lifts is released after
 * `HELD_TOUCH_TIMEOUT_MS`.
 *
 * This module holds no transport: the holder passes the release, so it stays
 * free of an import cycle with `simulator-client`.
 */

/** A finger is released this long after a train that left it down. */
export const HELD_TOUCH_TIMEOUT_MS = 30_000;

export interface HeldTouch<T = unknown> {
  /** What the holder needs to continue or lift the contact (its last event). */
  contact: T;
  /** Send the Up for this contact. */
  release: () => Promise<unknown>;
}

interface Entry extends HeldTouch {
  timer: ReturnType<typeof setTimeout>;
}

const held = new Map<string, Entry>();

/** Record a finger left down on `deviceId`, replacing (not lifting) any earlier one. */
export function holdTouch<T>(deviceId: string, touch: HeldTouch<T>): void {
  const previous = held.get(deviceId);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    if (held.get(deviceId)?.timer !== timer) return;
    held.delete(deviceId);
    void touch.release().catch(() => {});
  }, HELD_TOUCH_TIMEOUT_MS);
  timer.unref?.();
  held.set(deviceId, { ...(touch as HeldTouch), timer });
}

/** Take over the finger held on `deviceId`, if any: the caller now owns lifting it. */
export function takeHeldTouch<T = unknown>(deviceId: string): HeldTouch<T> | undefined {
  const entry = held.get(deviceId);
  if (!entry) return undefined;
  clearTimeout(entry.timer);
  held.delete(deviceId);
  return { contact: entry.contact as T, release: entry.release };
}
