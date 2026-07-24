import { describe, expect, it } from "vitest";
import {
  BOOT_STEP_TIMEOUT_MS,
  CORE_SIMULATOR_SERVICE,
  parseBootedUdids,
  recoverCoreSimulatorInjection,
  recoverySucceeded,
  type ExecFn,
} from "../../src/utils/coresimulator-recovery";
import { SIMCTL_SPAWN_TIMEOUT_MS } from "../../src/utils/simctl-config";

// A recording exec that captures the exact (file, args, timeout) sequence and
// can be told to fail specific commands — so the recovery order, timeouts and
// failure-tolerance are asserted without shelling out to a real simulator.
function recordingExec(shouldFail?: (file: string, args: string[]) => boolean): {
  calls: Array<[string, string[]]>;
  timeouts: Array<number | undefined>;
  exec: ExecFn;
} {
  const calls: Array<[string, string[]]> = [];
  const timeouts: Array<number | undefined> = [];
  const exec: ExecFn = async (file, args, timeoutMs) => {
    calls.push([file, args]);
    timeouts.push(timeoutMs);
    if (shouldFail?.(file, args)) {
      throw new Error("No matching processes belonging to you were found");
    }
    return { stdout: "", stderr: "" };
  };
  return { calls, timeouts, exec };
}

describe("recoverCoreSimulatorInjection", () => {
  it("snapshots booted devices, then shutdown all → killall → boot → bootstatus, in order", async () => {
    const { calls, exec } = recordingExec();
    const steps = await recoverCoreSimulatorInjection("UDID-1", { exec });

    expect(calls).toEqual([
      ["xcrun", ["simctl", "list", "devices", "booted", "-j"]],
      ["xcrun", ["simctl", "shutdown", "all"]],
      ["killall", [CORE_SIMULATOR_SERVICE]],
      ["xcrun", ["simctl", "boot", "UDID-1"]],
      ["xcrun", ["simctl", "bootstatus", "UDID-1", "-b"]],
    ]);
    expect(steps.map((s) => s.step)).toEqual([
      "shutdown-all",
      "killall-coresimulatorservice",
      "boot",
      "bootstatus",
    ]);
    expect(recoverySucceeded(steps)).toBe(true);
  });

  it("restores every previously-booted simulator (target first), waiting only on the target", async () => {
    const booted = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-0": [
          { udid: "UDID-1", state: "Booted" },
          { udid: "SIB-1", state: "Booted" },
        ],
      },
    };
    const calls: Array<[string, string[]]> = [];
    const exec: ExecFn = async (file, args) => {
      calls.push([file, args]);
      if (args.includes("list")) return { stdout: JSON.stringify(booted), stderr: "" };
      return { stdout: "", stderr: "" };
    };

    const steps = await recoverCoreSimulatorInjection("UDID-1", { exec });

    expect(calls).toEqual([
      ["xcrun", ["simctl", "list", "devices", "booted", "-j"]],
      ["xcrun", ["simctl", "shutdown", "all"]],
      ["killall", [CORE_SIMULATOR_SERVICE]],
      ["xcrun", ["simctl", "boot", "UDID-1"]],
      ["xcrun", ["simctl", "boot", "SIB-1"]],
      ["xcrun", ["simctl", "bootstatus", "UDID-1", "-b"]],
    ]);
    expect(steps.map((s) => s.step)).toEqual([
      "shutdown-all",
      "killall-coresimulatorservice",
      "boot",
      "boot:SIB-1",
      "bootstatus",
    ]);
    expect(recoverySucceeded(steps)).toBe(true);
  });

  it("tolerates a sibling failing to restart without failing the whole recovery", async () => {
    const booted = {
      devices: {
        rt: [
          { udid: "UDID-1", state: "Booted" },
          { udid: "SIB-1", state: "Booted" },
        ],
      },
    };
    const exec: ExecFn = async (_file, args) => {
      if (args.includes("list")) return { stdout: JSON.stringify(booted), stderr: "" };
      if (args.includes("boot") && args.includes("SIB-1")) {
        throw new Error("Unable to boot device in current state: Booted");
      }
      return { stdout: "", stderr: "" };
    };

    const steps = await recoverCoreSimulatorInjection("UDID-1", { exec });

    const sibling = steps.find((s) => s.step === "boot:SIB-1");
    expect(sibling?.ok).toBe(true);
    expect(sibling?.tolerated).toBe(true);
    expect(recoverySucceeded(steps)).toBe(true);
  });

  it("gives the boot steps a boot-scale timeout, not the 10s simctl-spawn ceiling", async () => {
    // The target cold-boots after the kill; `bootstatus -b` can block for
    // minutes, so the 10s ceiling would kill it mid-boot.
    const { calls, timeouts, exec } = recordingExec();
    await recoverCoreSimulatorInjection("UDID-1", { exec });

    const bootIdx = calls.findIndex(([, args]) => args.includes("boot"));
    const statusIdx = calls.findIndex(([, args]) => args.includes("bootstatus"));
    expect(timeouts[bootIdx]).toBe(BOOT_STEP_TIMEOUT_MS);
    expect(timeouts[statusIdx]).toBe(BOOT_STEP_TIMEOUT_MS);
    expect(BOOT_STEP_TIMEOUT_MS).toBeGreaterThan(SIMCTL_SPAWN_TIMEOUT_MS);
  });

  it("leaves the device shut down when rebootAfter is false", async () => {
    const { calls, exec } = recordingExec();
    const steps = await recoverCoreSimulatorInjection("UDID-2", { rebootAfter: false, exec });

    expect(calls).toEqual([
      ["xcrun", ["simctl", "shutdown", "all"]],
      ["killall", [CORE_SIMULATOR_SERVICE]],
    ]);
    expect(steps.map((s) => s.step)).toEqual(["shutdown-all", "killall-coresimulatorservice"]);
  });

  it("tolerates killall exiting non-zero when no daemon is running", async () => {
    const { exec } = recordingExec((file) => file === "killall");
    const steps = await recoverCoreSimulatorInjection("UDID-3", { rebootAfter: false, exec });

    const killall = steps.find((s) => s.step === "killall-coresimulatorservice");
    expect(killall).toBeDefined();
    expect(killall?.ok).toBe(true);
    expect(killall?.tolerated).toBe(true);
    expect(killall?.detail).toMatch(/no matching processes/i);
    expect(recoverySucceeded(steps)).toBe(true); // tolerated failures still count as success
  });

  it("records a hard failure on boot (not tolerated) but still runs bootstatus for the report", async () => {
    // Make only the *target* boot fail (not the bootstatus that follows).
    const { exec } = recordingExec(
      (_file, args) => args.includes("boot") && args.includes("UDID-4")
    );
    const steps = await recoverCoreSimulatorInjection("UDID-4", { exec });

    const boot = steps.find((s) => s.step === "boot");
    expect(boot?.ok).toBe(false);
    expect(boot?.tolerated).toBeUndefined();
    expect(steps.some((s) => s.step === "bootstatus")).toBe(true);
    expect(recoverySucceeded(steps)).toBe(false); // a hard failure means NOT recovered
  });
});

describe("parseBootedUdids", () => {
  it("collects booted udids across runtimes", () => {
    const json = JSON.stringify({
      devices: {
        rtA: [{ udid: "A", state: "Booted" }],
        rtB: [{ udid: "B", state: "Booted" }],
      },
    });
    expect(parseBootedUdids(json).sort()).toEqual(["A", "B"]);
  });

  it("returns an empty list for malformed or empty input rather than throwing", () => {
    expect(parseBootedUdids("not json")).toEqual([]);
    expect(parseBootedUdids("{}")).toEqual([]);
    expect(parseBootedUdids(JSON.stringify({ devices: {} }))).toEqual([]);
  });
});
