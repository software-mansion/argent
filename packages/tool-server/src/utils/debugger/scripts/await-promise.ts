/**
 * Run through `Runtime.callFunctionOn` on an evaluation result. Returns the
 * result itself when it is not a thenable. Otherwise stores a box at
 * `globalThis[slot]` that fills in once the thenable settles, and returns
 * `slot`.
 */
export const WATCH_PROMISE_FUNCTION = `function (slot) {
  var self = this;
  var then = self.then;
  if (typeof then !== "function") return self;

  var box = { settled: false, rejected: false, value: undefined };
  globalThis[slot] = box;

  new Promise(function (resolve, reject) {
    then.call(self, resolve, reject);
  }).then(
    function (value) {
      box.settled = true;
      box.value = value;
    },
    function (reason) {
      box.settled = true;
      box.rejected = true;
      box.value = reason;
    }
  );

  return slot;
}`;

/**
 * Returns `slot` while the box at `globalThis[slot]` is pending. Once it has
 * settled, removes the box and returns the value, or throws the rejection
 * reason.
 */
export function takeSettledScript(slot: string): string {
  return `(function (slot) {
  var box = globalThis[slot];
  if (!box) throw new Error("The JS context reloaded while the Promise was pending.");
  if (!box.settled) return slot;

  delete globalThis[slot];
  if (box.rejected) throw box.value;
  return box.value;
})(${JSON.stringify(slot)})`;
}
