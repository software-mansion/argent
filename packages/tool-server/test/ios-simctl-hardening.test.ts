import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the options object handed to every `execFile` call so we can assert
// the timeout is backed by a SIGKILL. Node's `execFile` `timeout` only sends its
// `killSignal` once and never escalates; with the default SIGTERM a `simctl`
// process blocked on a wedged CoreSimulatorService ignores the signal and the
// await hangs past the deadline — the failure mode that hung a real `describe`
// call for ~24 minutes. These tests pin every *bounded* describe-path `xcrun
// simctl` invocation to `killSignal: "SIGKILL"` + a finite `timeout` so it can't
// regress — across all three describe-path modules (ax-prefs, ios-devices, and
// ios-host via the exported `localIosHost`).
//
// The long-lived ax-service daemon spawn (`spawnAxDaemonLocal` /
// `localIosHost.spawnAxDaemon`) is deliberately NOT asserted here: it runs for
// up to `--timeout 3600` serving RPC, so a 10s exec `timeout` would SIGKILL it
// mid-session. Its hang is bounded elsewhere — `waitForDaemonConnection(…, 10s)`
// in ax-service — not by an exec deadline. So these tests never invoke it.
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

// `setupNativeDevtoolsEnvLocal` resolves the injection dylib path before any
// simctl call, and that resolver hard-requires a macOS host. Stub the three
// bootstrap-path getters so this cross-platform test can reach the simctl
// getenv/setenv spawns it is meant to guard.
vi.mock("@argent/native-devtools-ios", async () => {
  const actual = await vi.importActual<typeof import("@argent/native-devtools-ios")>(
    "@argent/native-devtools-ios"
  );
  return {
    ...actual,
    bootstrapDylibPath: () => "/fake/bootstrap.dylib",
    bootstrapDylibPathTcp: () => "/fake/bootstrap-tcp.dylib",
    bootstrapDylibPathTvos: () => "/fake/bootstrap-tvos.dylib",
  };
});

import { ensureAutomationEnabled, isEntitlementBypassActive } from "../src/utils/ax-prefs";
import { listIosSimulators } from "../src/utils/ios-devices";
import { localIosHost } from "../src/utils/ios-host";

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

  // The ios-host.ts describe-path sites — reached via the exported `localIosHost`
  // rather than the internal functions. This is the block that guards
  // `listRunningUIKitApplicationBundleIds` (the call this fix added a
  // previously-missing timeout+kill to) and the six other ios-host simctl spawns.
  it("localIosHost.bootstrapAx (ensureAutomationEnabled + entitlement probe) passes killSignal SIGKILL", async () => {
    await localIosHost.bootstrapAx("UDID-HOST-1");
    const simctl = xcrunCalls();
    expect(simctl.length).toBeGreaterThan(0);
    for (const c of simctl) {
      expect(c.options?.killSignal).toBe("SIGKILL");
      expect(typeof c.options?.timeout).toBe("number");
    }
  });

  it("localIosHost.listRunningBundleIds (launchctl list) passes killSignal SIGKILL + a finite timeout", async () => {
    await localIosHost.listRunningBundleIds("UDID-HOST-2");
    const simctl = xcrunCalls();
    // Exactly the `simctl spawn … launchctl list` call this fix hardened.
    expect(simctl.some((c) => c.args.includes("launchctl") && c.args.includes("list"))).toBe(true);
    for (const c of simctl) {
      expect(c.options?.killSignal).toBe("SIGKILL");
      expect(typeof c.options?.timeout).toBe("number");
    }
  });

  it("localIosHost.setupNativeDevtoolsEnv (getenv/setenv + ensureAccessibilityEnabled) passes killSignal SIGKILL", async () => {
    await localIosHost.setupNativeDevtoolsEnv("UDID-HOST-3", {
      transport: "unix",
      socketPath: "/tmp/argent-hardening-test.sock",
    });
    const simctl = xcrunCalls();
    // Covers the launchctl getenv/setenv spawns plus the two
    // ensureAccessibilityEnabled `defaults write` spawns.
    expect(simctl.length).toBeGreaterThan(1);
    for (const c of simctl) {
      expect(c.options?.killSignal).toBe("SIGKILL");
      expect(typeof c.options?.timeout).toBe("number");
    }
  });
});
