import { EventEmitter } from "node:events";

/** On EMFILE Node leaves stdio undefined and reports the error on the next tick. */
export function failedSpawn() {
  const child = Object.assign(new EventEmitter(), { kill: () => false });
  process.nextTick(() =>
    child.emit("error", Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" }))
  );
  return child;
}
