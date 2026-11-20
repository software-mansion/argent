import type { DeviceInfo, Registry } from "@argent/registry";
import { axServiceRef, type AXServiceApi } from "../../blueprints/ax-service";

/**
 * Reading back what `keyboard` typed on an iOS simulator (#2030).
 *
 * A simulator-server ack says the server took a key, not that the app got it:
 * a stalled simulator still drops keys, or repeats one whose Up arrived late,
 * and every key was acked. The field is the only witness, so it is read back.
 *
 * The ax-service answers only whether the focused field holds a given text,
 * never the text itself, and `keyboard` inserts at the caret rather than
 * replacing the field. So the check runs only where its answer means
 * something: the field was empty before typing (asked with `""`), and must
 * hold exactly the typed text after. A secure field counts as holding it when
 * it shows as many bullets. Any other case types without a check, as before.
 *
 * A mismatch is a warning, not a failure: the keys may be fine and the app or
 * iOS may have changed the text on purpose (auto-capitalization, a formatter,
 * a length limit). The warning never quotes the text: it may be a secret.
 */

/**
 * The ax-service check waits up to 1 s for the field to hold the text it is
 * asked about, re-reading it, and answers "no" only when that wait runs out.
 * So "yes" comes back fast and "no" after about 1 s. Mutable for tests only.
 */
export const READBACK_TIMING = {
  /** Budget to reach the ax-service; past it, typing goes on unchecked. */
  resolveMs: 1_500,
  /**
   * Budget for the empty-field check before typing. An empty field answers
   * in about 0.1 s; a field that holds text answers only after the daemon's
   * 1 s wait, which would slow every append. Past this budget the field
   * counts as not empty, and typing goes on unchecked.
   */
  precheckMs: 400,
  /**
   * Budget for the check after typing. It must outlast the daemon's 1 s
   * wait, or a field that does not hold the text never answers "no". The
   * daemon's wait also gives an app that applies input late the time it
   * needs.
   */
  checkMs: 3_500,
};

// Return and Tab can submit a form or move focus, so the field read after
// them is not the one typed into.
const FOCUS_MOVING = /[\r\n\t]/;

export interface ReadbackOutcome {
  /** True when the field holds the typed text, false with `warning` when it does not. */
  verified: boolean;
  warning?: string;
}

export const READBACK_MISMATCH_WARNING =
  "After typing, the focused field does not hold the text that was sent. Keys may have been " +
  "dropped or repeated (a stalled simulator does this, and the keys were still acknowledged), " +
  "or the app or iOS changed the text (auto-capitalization, auto-correction, an input formatter, " +
  "a length limit). Read the field before submitting; to retype, clear it first.";

/** Resolves to `undefined` instead of waiting past `ms`, and on any failure. */
async function within<T>(ms: number, run: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // Through `then`, so a synchronous throw is caught as well.
      Promise.resolve()
        .then(run)
        .catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Types with `type` and, where the check means something, reads the field
 * back. Never fails on the check itself: a missing or unreadable ax-service
 * leaves the typing unchecked, with no outcome.
 */
export async function typeWithReadback<T>(
  registry: Registry,
  device: DeviceInfo,
  text: string,
  type: () => Promise<T>
): Promise<{ result: T; readback?: ReadbackOutcome }> {
  if (!text || FOCUS_MOVING.test(text)) return { result: await type() };

  const ax = await within(READBACK_TIMING.resolveMs, async () => {
    const ref = axServiceRef(device);
    const api = await registry.resolveService<AXServiceApi>(ref.urn, ref.options);
    return api.degraded ? undefined : api;
  });
  const before =
    ax && (await within(READBACK_TIMING.precheckMs, () => ax.fill("", { check: true })));
  const checkable = before?.focused === true && before.verified === true && !before.timedOut;

  const result = await type();
  if (!ax || !checkable) return { result };

  const after = await within(READBACK_TIMING.checkMs, () => ax.fill(text, { check: true }));
  if (after?.verified) return { result, readback: { verified: true } };
  // No answer, or focus left the field (the app moved it): nothing to judge.
  if (!after || !after.focused || after.timedOut) return { result };
  return { result, readback: { verified: false, warning: READBACK_MISMATCH_WARNING } };
}
