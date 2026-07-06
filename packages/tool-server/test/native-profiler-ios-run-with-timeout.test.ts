import { describe, it, expect, vi } from "vitest";

// Records the options execFile is actually invoked with, so the test can assert
// the wrapper's timeout/maxBuffer guards cannot be silently weakened by a caller.
const rec = vi.hoisted(() => ({
  calls: [] as { options?: { timeout?: number; maxBuffer?: number; encoding?: string } }[],
}));

vi.mock("child_process", () => ({
  // promisify(execFile) calls this callback form: (file, args, options, cb).
  execFile: (_file: string, _args: string[], ...rest: unknown[]) => {
    const options = rest.find((r) => typeof r === "object" && r !== null) as
      | { timeout?: number; maxBuffer?: number; encoding?: string }
      | undefined;
    rec.calls.push({ options });
    const cb = rest.find((r) => typeof r === "function") as
      | ((e: unknown, r: { stdout: string; stderr: string }) => void)
      | undefined;
    cb?.(null, { stdout: "", stderr: "" });
    return undefined;
  },
}));

import {
  execFileAsyncWithTimeout,
  DEFAULT_EXEC_MAX_BUFFER,
  DEFAULT_EXEC_TIMEOUT_MS,
} from "../src/utils/ios-profiler/run-with-timeout";

describe("execFileAsyncWithTimeout: safety guards can't be silently weakened", () => {
  it("applies the timeout and 256 MiB maxBuffer when the caller passes no options", async () => {
    rec.calls.length = 0;
    await execFileAsyncWithTimeout("xctrace", ["version"]);

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].options?.timeout).toBe(DEFAULT_EXEC_TIMEOUT_MS);
    expect(rec.calls[0].options?.maxBuffer).toBe(DEFAULT_EXEC_MAX_BUFFER);
  });

  it("ignores a caller trying to shrink maxBuffer or drop the timeout", async () => {
    rec.calls.length = 0;
    // A caller that passed these would otherwise re-open the ENOBUFS /
    // event-loop-freeze holes the wrapper exists to close.
    await execFileAsyncWithTimeout("xctrace", ["version"], {
      maxBuffer: 1024,
      timeout: 0,
    });

    expect(rec.calls[0].options?.timeout).toBe(DEFAULT_EXEC_TIMEOUT_MS);
    expect(rec.calls[0].options?.maxBuffer).toBe(DEFAULT_EXEC_MAX_BUFFER);
  });

  it("lets a caller RAISE maxBuffer above the guard (floor, not a cap)", async () => {
    rec.calls.length = 0;
    const bigger = 512 * 1024 * 1024;
    await execFileAsyncWithTimeout("xctrace", ["version"], { maxBuffer: bigger });

    expect(rec.calls[0].options?.maxBuffer).toBe(bigger);
  });
});
