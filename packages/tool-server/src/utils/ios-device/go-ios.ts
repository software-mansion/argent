import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, withFailureSignal } from "@argent/registry";
import { scheduleGroupSigkill, signalGroupThenPid } from "../process-kill";
import { sleep } from "../timing";
import type { IosRelay } from "./relay";

/**
 * go-ios (`ios`) for a relayed phone: install, launch and kill an app, and run
 * the XCUITest runner, through a provider's usbmuxd endpoint.
 *
 * `devicectl` cannot see a phone that is not on this Mac's USB, so a relayed
 * phone is driven with go-ios, which speaks the usbmuxd protocol and reads the
 * endpoint from `USBMUXD_SOCKET_ADDRESS`. iOS 17+ puts app launch, kill and
 * XCTest behind a RemoteXPC tunnel; go-ios builds that tunnel in user space
 * (no root) from one long-lived `ios tunnel start` per phone, and every later
 * command finds it through a loopback "tunnel info" port of our choosing.
 */

const execFileAsync = promisify(execFile);

/** Overrides the `ios` binary looked up on PATH. */
const GO_IOS_ENV = "ARGENT_GO_IOS";

const GO_IOS_TIMEOUT_MS = 30_000;
const TUNNEL_PROBE_TIMEOUT_MS = 5_000;
const GO_IOS_INSTALL_TIMEOUT_MS = 180_000;
const TUNNEL_READY_TIMEOUT_MS = 30_000;
const TUNNEL_READY_POLL_MS = 250;
const GO_IOS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const INSTALL_HINT =
  "Install go-ios (npm i -g go-ios) so `ios` is on PATH, or set ARGENT_GO_IOS to the binary, " +
  "then restart the tool-server: argent server stop && argent server start --detach.";

/** go-ios keeps its pairing identity in the working directory; give it one of its own. */
function goIosHome(): string {
  return path.join(os.homedir(), ".argent", "ios-device-runner", "go-ios");
}

let resolvedBinary: string | undefined;

/**
 * The go-ios binary: `ARGENT_GO_IOS`, else `ios` on PATH. Memoized once found;
 * a miss is not, so installing go-ios takes effect on the next call.
 */
export async function resolveGoIosBinary(): Promise<string> {
  if (resolvedBinary) {
    return resolvedBinary;
  }

  const override = process.env[GO_IOS_ENV]?.trim();
  const candidates = override
    ? [override]
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter((dir) => dir.length > 0)
        .map((dir) => path.join(dir, "ios"));

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
    `go-ios is needed to drive a relayed iPhone and no \`ios\` binary was found` +
      `${override ? ` at ${override}` : " on PATH"}. ${INSTALL_HINT}`,
    {
      error_code: FAILURE_CODES.IOS_RELAY_GO_IOS_MISSING,
      failure_stage: "ios_relay_go_ios_resolve",
      failure_area: "tool_server",
      error_kind: "not_found",
    }
  );
}

/** Test seam. */
export function __resetGoIosBinaryForTests(): void {
  resolvedBinary = undefined;
}

function firstLine(text: string | undefined): string {
  return (text ?? "").trim().split("\n")[0] ?? "";
}

/** go-ios logs JSON lines; the `msg` of the last error line is the readable part. */
export function goIosErrorSummary(output: string): string {
  const lines = output
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]!) as { level?: string; msg?: string; err?: string };

      if (parsed.level?.toLowerCase() === "error" || parsed.level?.toLowerCase() === "fatal") {
        return [parsed.msg, parsed.err].filter(Boolean).join(": ");
      }
    } catch {
      /* not JSON */
    }
  }

  return firstLine(lines[lines.length - 1]);
}

interface TunnelHandle {
  child: ChildProcess;
  infoPort: number;
  ready: Promise<void>;
}

/** One tunnel per phone, keyed by hardware UDID. */
const tunnels = new Map<string, TunnelHandle>();

async function freeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function envFor(relay: IosRelay): NodeJS.ProcessEnv {
  return { ...process.env, USBMUXD_SOCKET_ADDRESS: relay.endpoint };
}

/**
 * Does the tunnel still carry RemoteXPC traffic? The `tunnel start` process
 * can outlive its link to the phone (a relay going down and coming back on
 * the same port does that), and it keeps listing the tunnel while every command fails
 * to reach RSD. A process listing is the cheapest command that uses the link.
 */
async function tunnelHealthy(relay: IosRelay, handle: TunnelHandle): Promise<boolean> {
  try {
    const binary = await resolveGoIosBinary();
    await execFileAsync(
      binary,
      ["ps", "--udid", relay.udid, "--tunnel-info-port", String(handle.infoPort)],
      {
        cwd: goIosHome(),
        env: envFor(relay),
        timeout: TUNNEL_PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: GO_IOS_MAX_OUTPUT_BYTES,
      }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The tunnel for `relay`, started on first use. Resolves once go-ios reports
 * the tunnel negotiated. A tunnel that died, or that no longer reaches the
 * phone, is replaced on the next call.
 */
export async function ensureGoIosTunnel(relay: IosRelay): Promise<TunnelHandle> {
  const existing = tunnels.get(relay.udid);

  if (existing && existing.child.exitCode === null && existing.child.signalCode === null) {
    await existing.ready;

    if (await tunnelHealthy(relay, existing)) {
      return existing;
    }

    stopGoIosTunnel(relay.udid);
  }

  const binary = await resolveGoIosBinary();
  const infoPort = await freeLoopbackPort();
  const home = goIosHome();
  await fsp.mkdir(home, { recursive: true });

  const child = spawn(
    binary,
    [
      "tunnel",
      "start",
      "--userspace",
      "--udid",
      relay.udid,
      "--tunnel-info-port",
      String(infoPort),
    ],
    { cwd: home, env: envFor(relay), stdio: ["ignore", "pipe", "pipe"] }
  );

  let output = "";
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-64 * 1024);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", () => {});
  child.on("exit", () => {
    if (tunnels.get(relay.udid)?.child === child) {
      tunnels.delete(relay.udid);
    }
  });

  const ready = (async () => {
    const expiresAt = Date.now() + TUNNEL_READY_TIMEOUT_MS;

    for (;;) {
      if (output.includes("tunnel negotiated") || output.includes("Tunnel server started")) {
        // The info API answers only once the server is up; the negotiated line follows it.
        if (output.includes("tunnel negotiated")) return;
      }

      if (child.exitCode !== null || child.signalCode !== null) {
        throw tunnelFailure(relay, `go-ios tunnel exited: ${goIosErrorSummary(output)}`);
      }

      if (Date.now() >= expiresAt) {
        killChild(child);
        throw tunnelFailure(
          relay,
          `go-ios did not negotiate a tunnel within ${TUNNEL_READY_TIMEOUT_MS / 1000}s: ` +
            goIosErrorSummary(output)
        );
      }

      await sleep(TUNNEL_READY_POLL_MS);
    }
  })();

  // A rejected tunnel must not become an unhandled rejection before its first awaiter.
  ready.catch(() => {});

  const handle = { child, infoPort, ready };
  tunnels.set(relay.udid, handle);

  try {
    await ready;
  } catch (error) {
    if (tunnels.get(relay.udid) === handle) tunnels.delete(relay.udid);
    throw error;
  }

  return handle;
}

function tunnelFailure(relay: IosRelay, detail: string): FailureError {
  return new FailureError(
    `${detail}. The phone (${relay.udid}) is relayed by ${relay.providerName} at ${relay.endpoint}; ` +
      `check that the relay is still up and the phone is still offered.`,
    {
      error_code: FAILURE_CODES.IOS_RELAY_TUNNEL_FAILED,
      failure_stage: "ios_relay_tunnel",
      failure_area: "tool_server",
      error_kind: "subprocess",
    }
  );
}

function killChild(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  signalGroupThenPid(process.kill.bind(process), pid, "SIGTERM");
  scheduleGroupSigkill(pid, 5_000, { gateOnGroupLiveness: false });
}

/** Stop the tunnel for a phone, if one runs. The runner goes down with it. */
export function stopGoIosTunnel(udid: string): void {
  const handle = tunnels.get(udid);
  if (!handle) return;
  tunnels.delete(udid);
  killChild(handle.child);
}

interface RunGoIosOptions {
  /** Attach the phone's tunnel (iOS 17+ needs it for launch, kill and XCTest). */
  tunnel?: boolean;
  timeoutMs?: number;
  action: string;
}

/**
 * Run one go-ios command against `relay` and return its output. Failures carry
 * go-ios's last error line and the relay's provenance.
 */
export async function runGoIos(
  relay: IosRelay,
  args: string[],
  opts: RunGoIosOptions
): Promise<{ stdout: string; stderr: string }> {
  const binary = await resolveGoIosBinary();
  const argv = [...args, "--udid", relay.udid];

  if (opts.tunnel) {
    const tunnel = await ensureGoIosTunnel(relay);
    argv.push("--tunnel-info-port", String(tunnel.infoPort));
  }

  const home = goIosHome();
  await fsp.mkdir(home, { recursive: true });

  try {
    return await execFileAsync(binary, argv, {
      cwd: home,
      env: envFor(relay),
      timeout: opts.timeoutMs ?? GO_IOS_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: GO_IOS_MAX_OUTPUT_BYTES,
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout ?? "", e.stderr ?? ""].join("\n");

    throw withFailureSignal(
      new FailureError(
        `Failed to ${opts.action} on the relayed iPhone: ${goIosErrorSummary(output) || firstLine(e.message)}. ` +
          `The phone is relayed by ${relay.providerName} at ${relay.endpoint}.`,
        {
          error_code: FAILURE_CODES.IOS_RELAY_COMMAND_FAILED,
          failure_stage: "ios_relay_command",
          failure_area: "tool_server",
          error_kind: "subprocess",
        },
        { cause: error as Error }
      ),
      {
        error_code: FAILURE_CODES.IOS_RELAY_COMMAND_FAILED,
        failure_stage: "ios_relay_command",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "go_ios",
      }
    );
  }
}

/** Bundle ids of the user apps installed on the phone. */
export async function goIosInstalledBundleIds(relay: IosRelay): Promise<Set<string>> {
  const { stdout } = await runGoIos(relay, ["apps"], { action: "list apps" });
  const ids = new Set<string>();

  try {
    for (const app of JSON.parse(stdout) as Array<{ CFBundleIdentifier?: string }>) {
      if (typeof app.CFBundleIdentifier === "string") ids.add(app.CFBundleIdentifier);
    }
  } catch {
    /* an unparseable list reads as empty: the caller installs, which is harmless */
  }

  return ids;
}

export async function goIosInstallApp(relay: IosRelay, installablePath: string): Promise<void> {
  await runGoIos(relay, ["install", `--path=${installablePath}`], {
    action: "install app",
    timeoutMs: GO_IOS_INSTALL_TIMEOUT_MS,
  });
}

/** Missing apps count as success, matching the devicectl path. */
export async function goIosUninstallApp(relay: IosRelay, bundleId: string): Promise<void> {
  try {
    await runGoIos(relay, ["uninstall", bundleId], { action: "uninstall app" });
  } catch (error) {
    if (/not installed|not found|no such/i.test(String((error as Error).message))) return;
    throw error;
  }
}

export async function goIosLaunchApp(
  relay: IosRelay,
  bundleId: string,
  opts: { terminateExisting?: boolean; args?: string[] } = {}
): Promise<void> {
  const args = ["launch", bundleId];
  if (opts.terminateExisting) args.push("--kill-existing");
  for (const arg of opts.args ?? []) args.push(`--arg=${arg}`);
  await runGoIos(relay, args, { action: `launch ${bundleId}`, tunnel: true });
}

export async function goIosKillApp(relay: IosRelay, bundleId: string): Promise<void> {
  await runGoIos(relay, ["kill", bundleId], { action: `kill ${bundleId}`, tunnel: true });
}

/**
 * Start the XCUITest runner from an `.xctestrun` with `ios runxctest`. The
 * child is the session: it ends when the runner does. Output goes to `logFd`.
 */
export async function spawnGoIosXctest(
  relay: IosRelay,
  xctestrunPath: string,
  logFd: number
): Promise<ChildProcess> {
  const binary = await resolveGoIosBinary();
  const tunnel = await ensureGoIosTunnel(relay);
  const home = goIosHome();

  const child = spawn(
    binary,
    [
      "runxctest",
      `--xctestrun-file-path=${xctestrunPath}`,
      "--udid",
      relay.udid,
      "--tunnel-info-port",
      String(tunnel.infoPort),
    ],
    { cwd: home, env: envFor(relay), detached: true, stdio: ["ignore", logFd, logFd] }
  );

  child.unref();

  try {
    await once(child, "spawn");
  } catch (error) {
    throw new FailureError(
      `go-ios could not be started to launch the runner on the relayed iPhone. ${INSTALL_HINT}`,
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
}
