/**
 * Functions `CDPClient.evaluateAwaited` runs inside the app through
 * `Runtime.callFunctionOn`, with `this` bound to the remote object. They ship
 * as `fn.toString()`, so each must be self-contained: no closures over module
 * scope, no imports, nothing the app's runtime (Hermes or V8) cannot execute.
 * Type annotations are fine; `tsc` strips them and emits the body verbatim.
 *
 * None of them throws: a helper that threw would come back as
 * `exceptionDetails`, which the client could not tell from a fault in the
 * inspector. Anything that can fail is caught and reported in the return
 * value instead.
 */

/** Where a thenable ended up; `state` moves off "pending" from its callbacks. */
export interface SettleBox {
  state: "pending" | "fulfilled" | "rejected";
  value?: unknown;
  error?: unknown;
}

/**
 * What a remote value is to the caller: its JSON form, a thenable still to be
 * watched, or something with no JSON form (`unserializable` names its type).
 */
export type RemoteVerdict = { value: unknown } | { pending: true } | { unserializable: string };

/** `{ pending: true }` when `this` is a thenable, else its verdict. */
export function readIfNotThenable(this: unknown): RemoteVerdict {
  const self = this as { then?: unknown } | null;
  try {
    if (self && typeof self.then === "function") return { pending: true };
  } catch {
    // A throwing `then` getter: treat it as a thenable and let the Promise
    // machinery report the error as a rejection.
    return { pending: true };
  }
  // A function sent by value reaches the client as `null` or nothing at all.
  if (typeof self === "function") return { unserializable: "function" };
  return { value: typeof self === "symbol" ? String(self) : self };
}

/** Attach callbacks to the thenable `this` and return the box they write to. */
export function watchThenable(this: unknown): SettleBox {
  const box: SettleBox = { state: "pending" };
  const reject = (error: unknown) => {
    box.error = error;
    box.state = "rejected";
  };
  try {
    Promise.resolve(this).then((value) => {
      box.value = value;
      box.state = "fulfilled";
    }, reject);
  } catch (error) {
    // A Promise whose own `then` throws synchronously.
    reject(error);
  }
  return box;
}

/** The fulfilled value's verdict. */
export function readBoxValue(this: SettleBox): RemoteVerdict {
  const value = this.value;
  if (typeof value === "function") return { unserializable: "function" };
  return { value: typeof value === "symbol" ? String(value) : value };
}

/**
 * The rejection reason as text: an Error's stack, else `name: message` (what
 * a DOMException or an Error without a stack has), else JSON, else `String()`.
 */
export function readBoxError(this: SettleBox): string {
  const error = this.error as
    { stack?: unknown; name?: unknown; message?: unknown } | null | undefined;
  try {
    if (error && typeof error.stack === "string" && error.stack) return error.stack;
  } catch {
    // A throwing `stack` getter; fall through to the other renderings.
  }
  try {
    if (error && typeof error.message === "string") {
      const name = typeof error.name === "string" && error.name ? error.name : "Error";
      return name + ": " + error.message;
    }
  } catch {
    // Throwing getters; fall through.
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
    return Object.prototype.toString.call(error);
  }
}
