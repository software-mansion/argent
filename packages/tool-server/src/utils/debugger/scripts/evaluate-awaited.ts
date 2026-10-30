/**
 * Functions `CDPClient.evaluateAwaited` runs inside the app through
 * `Runtime.callFunctionOn`, with `this` bound to the remote object. They ship
 * as `fn.toString()`, so each must be self-contained: no closures over module
 * scope, no imports, nothing the app's runtime (Hermes or V8) cannot execute.
 * Type annotations are fine; `tsc` strips them and emits the body verbatim.
 *
 * None of them throws, and none returns a value the runtime could fail to
 * serialize: a helper that threw would come back as `exceptionDetails`, which
 * the client could not tell from a fault in the inspector. A verdict is passed
 * through `JSON.stringify` here and returned as the parsed copy, so a cyclic,
 * BigInt or too deeply nested value is reported in the verdict instead of
 * failing inside Hermes's own serializer, and the copy is encoded only once,
 * by the protocol.
 */

/** Where a thenable ended up; `state` moves off "pending" from its callbacks. */
export interface SettleBox {
  state: "pending" | "fulfilled" | "rejected";
  value?: unknown;
  error?: unknown;
}

/**
 * What a value is to the caller: its JSON copy (absent for `undefined` and for
 * numbers JSON cannot carry), a type with no JSON form, or the error
 * `JSON.stringify` threw on it.
 */
export type RemoteVerdict =
  { value?: unknown } | { unserializable: string } | { unreadable: string };

/**
 * Attach callbacks to `this` when it is a thenable and return the box they
 * write to; otherwise return `undefined`. `then` is read once, so a getter or
 * Proxy trap on it runs once.
 */
export function watchIfThenable(this: unknown): SettleBox | undefined {
  const self = this as { then?: unknown } | null;
  const box: SettleBox = { state: "pending" };
  const reject = (error: unknown) => {
    box.error = error;
    box.state = "rejected";
  };
  let then: unknown;
  try {
    then = self && self.then;
  } catch (error) {
    reject(error);
    return box;
  }
  if (typeof then !== "function") return undefined;
  const subscribe = then;
  new Promise((resolve, rejectWith) => subscribe.call(self, resolve, rejectWith)).then((value) => {
    box.value = value;
    box.state = "fulfilled";
  }, reject);
  return box;
}

/** The verdict on `this`, a result that is not a thenable. */
export function readValue(this: unknown): RemoteVerdict {
  if (typeof this === "function") return { unserializable: "function" };
  try {
    return JSON.parse(JSON.stringify({ value: this })) as RemoteVerdict;
  } catch (error) {
    try {
      return { unreadable: String(error) };
    } catch {
      return { unreadable: "the value could not be serialized" };
    }
  }
}

/** The verdict on the fulfilled value. */
export function readBoxValue(this: SettleBox): RemoteVerdict {
  const value = this.value;
  if (typeof value === "function") return { unserializable: "function" };
  if (typeof value === "symbol") return { value: String(value) };
  // A bare NaN, Infinity or -0 result also comes back without a value.
  if (typeof value === "number" && (!isFinite(value) || Object.is(value, -0))) return {};
  try {
    return JSON.parse(JSON.stringify({ value })) as RemoteVerdict;
  } catch (error) {
    try {
      return { unreadable: String(error) };
    } catch {
      return { unreadable: "the value could not be serialized" };
    }
  }
}

/**
 * The rejection reason as text: an Error's stack, else `name: message` (what
 * a DOMException or an Error without a stack has), each followed by the
 * reason's other own fields as JSON; else JSON; else `String()`.
 */
export function readBoxError(this: SettleBox): string {
  const error = this.error as
    { stack?: unknown; name?: unknown; message?: unknown } | null | undefined;
  let head: string | undefined;
  try {
    if (error && typeof error.stack === "string" && error.stack) head = error.stack;
  } catch {
    // A throwing `stack` getter; fall through to the other renderings.
  }
  try {
    if (head === undefined && error && typeof error.message === "string") {
      const name = error.name;
      if (typeof name === "string") head = name ? name + ": " + error.message : error.message;
    }
  } catch {
    // Throwing getters; fall through.
  }
  if (head !== undefined) {
    try {
      const fields: Record<string, unknown> = {};
      let any = false;
      for (const key of Object.keys(error as object)) {
        if (key === "stack" || key === "message" || key === "name") continue;
        fields[key] = (error as Record<string, unknown>)[key];
        any = true;
      }
      return any ? head + "\n" + JSON.stringify(fields) : head;
    } catch {
      return head;
    }
  }
  try {
    const json = JSON.stringify(error);
    if (json !== undefined) return json;
  } catch {
    // Cyclic or otherwise unserializable; fall through.
  }
  try {
    // The default "[object Object]" is the point here: anything with a
    // readable rendering was caught by the branches above.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return String(error);
  } catch {
    // A throwing toString; fall through.
  }
  try {
    return Object.prototype.toString.call(error);
  } catch {
    return "a reason that could not be read";
  }
}
