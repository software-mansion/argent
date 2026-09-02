import { AsyncLocalStorage } from "node:async_hooks";

import { FAILURE_CODES, FailureError } from "@argent/registry";

/**
 * One queue per device for the tools that drive its keyboard.
 *
 * `paste` and `keyboard` both write to whatever holds keyboard focus, over
 * several unserialized steps each: a paste fills the clipboard and then sends
 * Cmd+V, and a `keyboard` clear writes 200 key events one at a time (700ms on
 * iOS, 2-90s on Android). Two concurrent calls at one device interleave inside
 * those windows and BOTH report success — measured on a booted simulator with a
 * 250-character field: `{ clear: true }` and, 200ms later, `{ text: "HELLO" }`
 * left `…aaaaaaaaaaLO`, with "HEL" eaten by backspaces still in flight.
 *
 * The map is shared across the tools rather than per tool, because the hazard is
 * the device's single focused field, not any one tool's steps: a paste racing a
 * clear corrupts the value exactly as two clears would. One tool-server is
 * shared by every agent session on the machine, so two sessions driving one
 * device is the documented default rather than an exotic case.
 *
 * A rejection does not stall the queue (`then(task, task)`), and the entry is
 * dropped once it is the tail again, so an idle device holds nothing.
 */
const deviceQueues = new Map<string, Promise<unknown>>();

/**
 * The tools that take this queue. `holdDeviceQueue`'s callers ask it whether a
 * batch of steps will need the queue at all, so the membership lives here rather
 * than being restated per caller.
 */
export const DEVICE_QUEUE_TOOLS: ReadonlySet<string> = new Set(["keyboard", "paste"]);

/**
 * The devices whose queue THIS async call chain already holds, so a call made
 * inside `holdDeviceQueue` runs instead of waiting for a queue it is itself the
 * head of. `AsyncLocalStorage` rather than a plain variable because two
 * sequences can be in flight at once, and each one's nested tool calls must see
 * only its own holds.
 */
const heldByCaller = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * How long a queued call may wait before its own request is stale.
 *
 * The queue makes a second session WAIT instead of interleaving, and a wait is
 * not free: the caller chose its field before it sent the call, and everything
 * ahead of it in the queue may have moved focus since. Measured on Chrome 152 —
 * a `run-sequence` holding the queue while its own steps tapped a different
 * field, and a second session's `keyboard { text: "BBB" }` behind it: the call
 * waited 11.54s, returned `{ typed: "BBB", keys: 3 }`, and put BBB in the
 * SEQUENCE's field while its own stayed empty. A plain success for a write that
 * went somewhere else.
 *
 * So the wait is bounded and the write is not attempted past the bound. 30s is
 * chosen against the queued work that is legitimately slow: 100 characters at
 * the default 50ms cadence is 5s, an iOS clear burst is under 1s, a Chromium
 * clear is two CDP round trips. It is under the 90s an Android clear may take,
 * deliberately — nothing about a field's focus is still trustworthy 90 seconds
 * after the caller looked at it.
 */
export const DEVICE_QUEUE_MAX_WAIT_MS = 30_000;

function deviceBusyError(deviceId: string, waitedMs: number): FailureError {
  return new FailureError(
    `another session held ${deviceId}'s keyboard for ${Math.round(waitedMs / 1000)}s, so nothing ` +
      "was typed, pressed or cleared — this call was NOT sent to the device. `keyboard` and " +
      "`paste` are serialized per device because they both write to whatever holds keyboard " +
      "focus, and the session ahead of this one may have moved that focus while this call " +
      "waited: sending it now would write into ITS field and report success. Tap the field " +
      "again (`gesture-tap`, or `tv-remote` on a TV), then retry. Keep the tap and the write in " +
      "one `run-sequence` so they cannot be separated again.",
    {
      error_code: FAILURE_CODES.KEYBOARD_DEVICE_BUSY,
      failure_stage: "device_queue_wait",
      failure_area: "tool_server",
      error_kind: "timeout",
    }
  );
}

export function serializedPerDevice<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
  if (heldByCaller.getStore()?.has(deviceId) === true) return task();
  const previous = deviceQueues.get(deviceId) ?? Promise.resolve();
  const queuedAt = Date.now();
  // Checked when the turn comes rather than raced against a timer: giving up
  // early would leave the task still chained and still due to run, which is the
  // one outcome that must not happen — the point is that no write lands after
  // the bound, not that the caller hears about it sooner.
  const guarded = async (): Promise<T> => {
    const waited = Date.now() - queuedAt;
    if (waited > DEVICE_QUEUE_MAX_WAIT_MS) throw deviceBusyError(deviceId, waited);
    return task();
  };
  const next = previous.then(guarded, guarded);
  deviceQueues.set(deviceId, next);
  const drop = () => {
    if (deviceQueues.get(deviceId) === next) deviceQueues.delete(deviceId);
  };
  void next.then(drop, drop);
  return next;
}

/**
 * Hold one device's queue across a WHOLE batch of tool calls, not just the
 * queued ones inside it.
 *
 * The queue serializes `keyboard` and `paste`, and nothing else — a
 * `gesture-tap` never waits. So in the `[gesture-tap, keyboard { clear }]` recipe
 * the tap landed immediately while the clear queued behind whatever another
 * session was doing, for up to the 90s Android budget, and ANYTHING that moved
 * focus in that window (another tap, `launch-app`, `button`, `open-url`)
 * redirected the clear. Measured on Chrome 152 with a 20s `keyboard` call held by
 * a second session: the sequence tapped its own `<input>`, the second session
 * tapped a textarea four seconds later, and the clear emptied the TEXTAREA and
 * reported `completed: 2 of 2`, `cleared: true`, `clearVerified: true` — truthful
 * about an element, silent about which.
 *
 * Holding the queue from the first step puts the caller's own focus tap inside
 * the critical section, so the pair replays in the order it was written. The
 * cost is that a batch which uses the keyboard holds the device's keyboard for
 * its whole duration; that is the same trade the queue already makes for one
 * long `keyboard` call, and it is bounded by the batch.
 */
export function holdDeviceQueue<T>(deviceId: string, body: () => Promise<T>): Promise<T> {
  const held = heldByCaller.getStore();
  if (held?.has(deviceId) === true) return body();
  const nested = new Set(held ?? []);
  nested.add(deviceId);
  return serializedPerDevice(deviceId, () => heldByCaller.run(nested, body));
}
