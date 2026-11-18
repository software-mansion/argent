/**
 * When `spawn` fails (EMFILE, ENOMEM, ...), Node hands back a child with no
 * stdio streams and emits `error` on the next tick. execSimctl must reject
 * that call instead of throwing on the missing stream and leaving the `error`
 * event without a listener, which takes the whole process down.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { stdout: null; stderr: null; pid?: number };
    child.stdout = null;
    child.stderr = null;
    process.nextTick(() =>
      child.emit("error", Object.assign(new Error("spawn xcrun EMFILE"), { code: "EMFILE" }))
    );
    return child;
  }),
}));

import { execSimctl } from "../src/utils/simctl-exec";

describe("execSimctl when spawn fails", () => {
  it("rejects with the spawn error instead of throwing on the missing stdio", async () => {
    await expect(execSimctl(["simctl", "help"])).rejects.toThrow(/EMFILE/);
  });
});
