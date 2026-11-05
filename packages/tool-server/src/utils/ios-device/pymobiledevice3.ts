import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, withFailureSignal } from "@argent/registry";
import type { IosRelay } from "./relay";
import type { IosRelayDriver } from "./relay-driver";

/**
 * pymobiledevice3 as the driver for a relayed iPhone: the same five calls
 * go-ios answers, through a Python tool with a wider feature set.
 *
 * Differences from go-ios that shape this module: every command builds its
 * own iOS 17+ tunnel (`PYMOBILEDEVICE3_DEFAULT_FALLBACK=userspace`), so there
 * is no tunnel process to keep and no link to probe, at the price of a few
 * seconds per command; and the runner is launched by bundle id with an
 * environment (`developer dvt xcuitest --env`), so the port is pinned without
 * copying the xctestrun.
 */

const execFileAsync = promisify(execFile);

/** Overrides the `pymobiledevice3` binary looked up on PATH. */
const PYMOBILEDEVICE3_ENV = "ARGENT_PYMOBILEDEVICE3";

const PYMOBILEDEVICE3_TIMEOUT_MS = 60_000;
const PYMOBILEDEVICE3_INSTALL_TIMEOUT_MS = 180_000;
const PYMOBILEDEVICE3_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const INSTALL_HINT =
  "Install pymobiledevice3 (python3 -m pip install pymobiledevice3) so it is on PATH, or set " +
  "ARGENT_PYMOBILEDEVICE3 to the binary, then restart the tool-server: " +
  "argent server stop && argent server start --detach.";

let resolvedBinary: string | undefined;

/** The pymobiledevice3 binary: `ARGENT_PYMOBILEDEVICE3`, else on PATH. Memoized once found. */
export async function resolvePymobiledevice3Binary(): Promise<string> {
  if (resolvedBinary) {
    return resolvedBinary;
  }

  const override = process.env[PYMOBILEDEVICE3_ENV]?.trim();
  const candidates = override
    ? [override]
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter((dir) => dir.length > 0)
        .map((dir) => path.join(dir, "pymobiledevice3"));

  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      resolvedBinary = candidate;
      return candidate;
    } catch {
      /* next */
    }
  }

  throw new FailureError(
    `pymobiledevice3 is selected to drive relayed iPhones and no binary was found` +
      `${override ? ` at ${override}` : " on PATH"}. ${INSTALL_HINT}`,
    {
      error_code: FAILURE_CODES.IOS_RELAY_DRIVER_MISSING,
      failure_stage: "ios_relay_pymobiledevice3_resolve",
      failure_area: "tool_server",
      error_kind: "not_found",
    }
  );
}

/** Test seam. */
export function __resetPymobiledevice3BinaryForTests(): void {
  resolvedBinary = undefined;
}

function envFor(relay: IosRelay): NodeJS.ProcessEnv {
  return {
    ...process.env,
    USBMUXD_SOCKET_ADDRESS: relay.endpoint,
    // Developer services on iOS 17+ need a tunnel; let every command build one in user space.
    PYMOBILEDEVICE3_DEFAULT_FALLBACK: "userspace",
  };
}

/**
 * pymobiledevice3 logs one line per event, `... LEVEL message`; the last ERROR
 * line is the readable part. Exported for the test.
 */
export function pymobiledevice3ErrorSummary(output: string): string {
  const lines = output
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = /\bERROR\b\s+(.*)$/.exec(lines[i]!);
    if (match) return match[1]!.trim();
  }

  return (lines[lines.length - 1] ?? "").trim();
}

async function run(
  relay: IosRelay,
  args: string[],
  opts: { action: string; timeoutMs?: number }
): Promise<{ stdout: string; stderr: string }> {
  const binary = await resolvePymobiledevice3Binary();

  try {
    return await execFileAsync(binary, [...args, "--udid", relay.udid], {
      env: envFor(relay),
      timeout: opts.timeoutMs ?? PYMOBILEDEVICE3_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: PYMOBILEDEVICE3_MAX_OUTPUT_BYTES,
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout ?? "", e.stderr ?? ""].join("\n");
    const signal = {
      error_code: FAILURE_CODES.IOS_RELAY_COMMAND_FAILED,
      failure_stage: "ios_relay_command",
      failure_area: "tool_server",
      error_kind: "subprocess",
    } as const;

    throw withFailureSignal(
      new FailureError(
        `Failed to ${opts.action} on the relayed iPhone: ` +
          `${pymobiledevice3ErrorSummary(output) || (e.message ?? "").split("\n")[0]}. ` +
          `The phone is relayed by ${relay.providerName} at ${relay.endpoint}.`,
        signal,
        { cause: error as Error }
      ),
      { ...signal, failure_command: "pymobiledevice3" }
    );
  }
}

/** `apps list` prints a JSON object keyed by bundle id. Exported for the test. */
export function bundleIdsFromAppsList(stdout: string): Set<string> {
  try {
    const parsed = JSON.parse(stdout) as unknown;

    if (Array.isArray(parsed)) {
      return new Set(
        parsed
          .map((app) => (app as { CFBundleIdentifier?: unknown }).CFBundleIdentifier)
          .filter((id): id is string => typeof id === "string")
      );
    }

    if (typeof parsed === "object" && parsed !== null) {
      return new Set(Object.keys(parsed));
    }
  } catch {
    /* an unparseable list reads as empty: the caller installs, which is harmless */
  }

  return new Set();
}

export const pymobiledevice3Driver: IosRelayDriver = {
  name: "pymobiledevice3",

  async installedBundleIds(relay) {
    const { stdout } = await run(relay, ["apps", "list", "--type", "User"], {
      action: "list apps",
    });
    return bundleIdsFromAppsList(stdout);
  },

  async installApp(relay, installablePath) {
    await run(relay, ["apps", "install", installablePath], {
      action: "install app",
      timeoutMs: PYMOBILEDEVICE3_INSTALL_TIMEOUT_MS,
    });
  },

  async uninstallApp(relay, bundleId) {
    try {
      await run(relay, ["apps", "uninstall", bundleId], { action: "uninstall app" });
    } catch (error) {
      if (/not installed|not found|no such/i.test(String((error as Error).message))) return;
      throw error;
    }
  },

  async launchApp(relay, bundleId, opts) {
    // `launch` takes the whole command line as one argument. A plain launch
    // only foregrounds a running app, which would drop the arguments, so the
    // caller asks to terminate first when it passes any.
    const command = [bundleId, ...(opts.args ?? [])].join(" ");
    await run(
      relay,
      [
        "developer",
        "dvt",
        "launch",
        command,
        opts.terminateExisting ? "--kill-existing" : "--no-kill-existing",
      ],
      { action: `launch ${bundleId}` }
    );
  },

  async launchRunner(relay, opts) {
    const binary = await resolvePymobiledevice3Binary();
    const child = spawn(
      binary,
      [
        "developer",
        "dvt",
        "xcuitest",
        opts.runnerBundleId,
        "--env",
        `ARGENT_RUNNER_PORT=${opts.port}`,
        "--udid",
        relay.udid,
      ],
      { env: envFor(relay), detached: true, stdio: ["ignore", opts.logFd, opts.logFd] }
    );

    child.unref();

    try {
      await once(child, "spawn");
    } catch (error) {
      throw new FailureError(
        `pymobiledevice3 could not be started to launch the runner on the relayed iPhone. ${INSTALL_HINT}`,
        {
          error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY,
          failure_stage: "ios_device_runner_spawn",
          failure_area: "tool_server",
          error_kind: "subprocess",
        },
        { cause: error as Error }
      );
    }

    child.on("error", () => {});

    return child;
  },

  isRunnerProcessLine(line, udid) {
    return (
      line.includes("pymobiledevice3") &&
      line.includes("xcuitest") &&
      line.includes("ARGENT_RUNNER_PORT=") &&
      line.includes(`--udid ${udid}`)
    );
  },
};
