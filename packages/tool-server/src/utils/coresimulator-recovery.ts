import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatErrorForAgent } from "./format-error";
import { SIMCTL_KILL_SIGNAL, SIMCTL_SPAWN_TIMEOUT_MS } from "./simctl-config";

const execFileAsync = promisify(execFile);

/**
 * The host-wide CoreSimulator daemon owning per-device HID/touch state. When it
 * goes stale, injected touches are silently dropped while describe / screenshot
 * / launch-app keep working, and only restarting the daemon clears it. Killing it
 * is safe (launchd respawns it) but affects every booted simulator, not just one.
 */
export const CORE_SIMULATOR_SERVICE = "com.apple.CoreSimulator.CoreSimulatorService";

/**
 * `simctl boot` + `bootstatus -b` cold-boot the device and can take tens of
 * seconds to minutes, so the boot steps get a generous ceiling instead of the
 * 10s SIMCTL_SPAWN_TIMEOUT_MS sized for cheap `simctl spawn` calls.
 */
export const BOOT_STEP_TIMEOUT_MS = 240_000;

/** One line of the recovery report: which step ran and how it went. */
export interface RecoveryStep {
  step: string;
  /** True when the command succeeded, or failed in a way that is expected and benign (see `tolerated`). */
  ok: boolean;
  /** Set when the command exited non-zero but the failure was tolerated (e.g. no daemon to kill). */
  tolerated?: boolean;
  /** Error / stderr text when the command did not exit cleanly. */
  detail?: string;
}

/** Minimal exec surface so tests can assert the command sequence without shelling out. */
export type ExecFn = (
  file: string,
  args: string[],
  timeoutMs?: number
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = (file, args, timeoutMs) =>
  execFileAsync(file, args, {
    encoding: "utf8",
    timeout: timeoutMs ?? SIMCTL_SPAWN_TIMEOUT_MS,
    killSignal: SIMCTL_KILL_SIGNAL,
  }) as Promise<{ stdout: string; stderr: string }>;

export interface RecoveryOptions {
  /** Boot `udid` back up after the daemon restart (default true). */
  rebootAfter?: boolean;
  /** Injectable exec, for tests. */
  exec?: ExecFn;
}

/** True when every step succeeded (tolerated failures count as success). */
export function recoverySucceeded(steps: RecoveryStep[]): boolean {
  return steps.every((s) => s.ok);
}

/** Booted-device udids from `simctl list devices booted -j` JSON; [] on malformed input. */
export function parseBootedUdids(stdout: string): string[] {
  try {
    const data = JSON.parse(stdout) as {
      devices?: Record<string, Array<{ udid?: string; state?: string }>>;
    };
    const udids: string[] = [];
    for (const list of Object.values(data.devices ?? {})) {
      for (const dev of list ?? []) {
        if (dev?.udid && (dev.state === undefined || dev.state === "Booted")) udids.push(dev.udid);
      }
    }
    return udids;
  } catch {
    return [];
  }
}

async function listBootedDevices(exec: ExecFn): Promise<string[]> {
  try {
    const { stdout } = await exec("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
    return parseBootedUdids(stdout);
  } catch {
    return [];
  }
}

/**
 * Clear a wedged touch-injection pipeline on a *local* iOS simulator, in order:
 *   1. `simctl list devices booted -j` — snapshot booted sims (if rebootAfter)
 *   2. `simctl shutdown all`           — release every booted sim session
 *   3. `killall CoreSimulatorService`  — drop stale HID state (host-wide)
 *   4. `simctl boot <udid>` + siblings — re-boot the target, then restore the rest
 *   5. `simctl bootstatus <udid> -b`   — wait until the target is booted
 *
 * `killall`/`shutdown` with nothing to act on exit non-zero but leave the intended
 * state, so they are tolerated; sibling re-boots are tolerated too. Only the target
 * is waited on. The caller must first dispose argent's services for every local
 * Apple simulator.
 */
export async function recoverCoreSimulatorInjection(
  udid: string,
  options: RecoveryOptions = {}
): Promise<RecoveryStep[]> {
  const exec = options.exec ?? defaultExec;
  const rebootAfter = options.rebootAfter ?? true;
  const steps: RecoveryStep[] = [];

  const run = async (
    step: string,
    file: string,
    args: string[],
    opts: { tolerateFailure?: boolean; timeoutMs?: number } = {}
  ) => {
    try {
      await exec(file, args, opts.timeoutMs);
      steps.push({ step, ok: true });
    } catch (err) {
      steps.push({
        step,
        ok: opts.tolerateFailure ?? false,
        ...(opts.tolerateFailure ? { tolerated: true } : {}),
        detail: formatErrorForAgent(err),
      });
    }
  };

  const previouslyBooted = rebootAfter ? await listBootedDevices(exec) : [];

  await run("shutdown-all", "xcrun", ["simctl", "shutdown", "all"], { tolerateFailure: true });
  await run("killall-coresimulatorservice", "killall", [CORE_SIMULATOR_SERVICE], {
    tolerateFailure: true,
  });

  if (rebootAfter) {
    await run("boot", "xcrun", ["simctl", "boot", udid], { timeoutMs: BOOT_STEP_TIMEOUT_MS });
    for (const sibling of previouslyBooted) {
      if (sibling === udid) continue;
      await run(`boot:${sibling}`, "xcrun", ["simctl", "boot", sibling], {
        timeoutMs: BOOT_STEP_TIMEOUT_MS,
        tolerateFailure: true,
      });
    }
    await run("bootstatus", "xcrun", ["simctl", "bootstatus", udid, "-b"], {
      timeoutMs: BOOT_STEP_TIMEOUT_MS,
    });
  }

  return steps;
}
