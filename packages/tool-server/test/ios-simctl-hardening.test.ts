import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the options object handed to every `execFile` call so we can assert
// the timeout is backed by a SIGKILL. Node's `execFile` `timeout` only sends its
// `killSignal` once and never escalates; with the default SIGTERM a `simctl`
// process blocked on a wedged CoreSimulatorService ignores the signal and the
// await hangs past the deadline — the failure mode that hung a real `describe`
// call for ~24 minutes. These tests pin every describe-path `xcrun simctl`
// invocation to `killSignal: "SIGKILL"` + a finite `timeout` so it can't regress.
type ExecOptions = { timeout?: number; killSignal?: string } | undefined;
const calls: Array<{ cmd: string; args: readonly string[]; options: ExecOptions }> = [];

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const options = (typeof opts === "function" ? undefined : opts) as ExecOptions;
      calls.push({ cmd, args, options });
      // `simctl list devices --json` must parse; everything else can be empty.
      const isListJson = args.includes("list") && args.includes("--json");
      callback(null, { stdout: isListJson ? '{"devices":{}}' : "", stderr: "" });
    },
  };
});

import { ensureAutomationEnabled, isEntitlementBypassActive } from "../src/utils/ax-prefs";
import { listIosSimulators } from "../src/utils/ios-devices";

beforeEach(() => {
  calls.length = 0;
});

function xcrunCalls() {
  return calls.filter((c) => c.cmd === "xcrun" && c.args[0] === "simctl");
}

describe("iOS simctl calls are hard-killed on timeout (SIGKILL, not SIGTERM)", () => {
  it("ensureAutomationEnabled passes killSignal SIGKILL + a finite timeout", async () => {
    await ensureAutomationEnabled("UDID-1");
    const simctl = xcrunCalls();
    expect(simctl.length).toBeGreaterThan(0);
    for (const c of simctl) {
      expect(c.options?.killSignal).toBe("SIGKILL");
      expect(typeof c.options?.timeout).toBe("number");
    }
  });

  it("isEntitlementBypassActive passes killSignal SIGKILL + a finite timeout", async () => {
    await isEntitlementBypassActive("UDID-2");
    const simctl = xcrunCalls();
    expect(simctl.length).toBeGreaterThan(0);
    for (const c of simctl) {
      expect(c.options?.killSignal).toBe("SIGKILL");
      expect(typeof c.options?.timeout).toBe("number");
    }
  });

  it("listIosSimulators (the isTvOsSimulator/describe probe) passes killSignal SIGKILL", async () => {
    await listIosSimulators();
    const simctl = xcrunCalls();
    expect(simctl.length).toBeGreaterThan(0);
    for (const c of simctl) {
      expect(c.options?.killSignal).toBe("SIGKILL");
      expect(typeof c.options?.timeout).toBe("number");
    }
  });
});
