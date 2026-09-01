import { AsyncLocalStorage } from "node:async_hooks";

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

export function serializedPerDevice<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
  if (heldByCaller.getStore()?.has(deviceId) === true) return task();
  const previous = deviceQueues.get(deviceId) ?? Promise.resolve();
  const next = previous.then(task, task);
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
