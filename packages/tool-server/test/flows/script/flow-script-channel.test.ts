/**
 * The two ways the execute request never reaches the runner: a channel that
 * closed before the write landed, and a `send` that throws. Neither is
 * reachable with a real child — Node reads the message in while the child is
 * still bootstrapping, before any code the runner could run — so the fault is
 * put on the send itself. Everything else about the child stays real.
 */
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FlowScriptExecutor,
  type FlowScriptResult,
} from "../../../src/tools/flows/script/flow-script-executor";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";

const fault: { mode: "callback" | "throw" | null } = { mode: null };

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    fork: ((...args: Parameters<typeof actual.fork>) => {
      const child = actual.fork(...args);
      const mode = fault.mode;
      if (mode === null) return child;
      child.send = ((_message: unknown, callback?: (err: Error | null) => void) => {
        if (mode === "throw") throw new Error("the channel is closed");
        setImmediate(() => callback?.(new Error("the channel is closed")));
        return true;
      }) as ChildProcess["send"];
      return child;
    }) as typeof actual.fork,
  };
});

const workspaces: ScriptWorkspace[] = [];

afterEach(() => {
  fault.mode = null;
  while (workspaces.length) workspaces.pop()!.cleanup();
});

async function run(): Promise<{ result: FlowScriptResult; ranMark: string }> {
  const ws = createScriptWorkspace("chan");
  workspaces.push(ws);
  const ranMark = ws.resolve("ran.txt");
  const script = ws.write(
    "script.mjs",
    `import fs from "node:fs";
     fs.writeFileSync(${JSON.stringify(ranMark)}, "ran");
     output.ok = true;`
  );
  const result = await new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000 }).execute({
    scriptPath: script,
    projectRoot: ws.dir,
    timeoutMs: 20_000,
  });
  return { result, ranMark };
}

describe("flow script executor — a request that never reaches the runner", () => {
  it.each([
    ["a channel that closed", "callback" as const, "closed its channel before the request arrived"],
    ["a send that threw", "throw" as const, "could not be given its request"],
  ])(
    "names %s, and stops the child rather than waiting it out",
    async (_label, mode, expected) => {
      fault.mode = mode;
      const { result, ranMark } = await run();

      expect(result.failure?.kind).toBe("protocol");
      expect(result.failure?.message).toContain(expected);
      expect(result.failure?.message).toContain("the channel is closed");
      // The runner waits for a request that will never come, so nothing but the
      // stop these paths ask for ends the step before its 20s time limit.
      expect(result.durationMs).toBeLessThan(10_000);
      // And the script itself never ran: the runner imports it only on a request.
      expect(fs.existsSync(ranMark)).toBe(false);
    },
    30_000
  );
});
